// argus-live-instance.mjs — the journey lane's live instance (spec §8): one isolated copy of the
// repo's app per cycle, which never touches the owner's servers, services or data.
//
// This module runs it: `up` (steps 1-11), `up --fresh`, `up --map`, `renew` and `status`; the bring-up blocks (ports,
// the worktree, HOME and environment, setup, start and health, the store phase) live in
// argus-live-start.mjs. The lane's modules, each importing only modules named before it (the leaves below
// import none, and any module may import them): argus-live-proc.mjs (processes) → -config.mjs (the
// configuration) → -lock.mjs (lock, live log) → -endpoints.mjs (endpoint comparison) → -docker.mjs (Compose,
// the runtime gate), -egress.mjs (the egress check) and -cli.mjs (the browser CLI's calls and sessions) →
// -run.mjs (run.json, teardown) → -browser.mjs, -proxy.mjs, -hooks.mjs, -start.mjs, -map.mjs, -drift.mjs,
// -seed.mjs (seeds from issues and docs) and -ledger.mjs (the secret ledger) → -slots.mjs (after -browser.mjs),
// -perf.mjs (after -map.mjs) and -scrub.mjs (after -ledger.mjs) → -return.mjs → -login.mjs → -session.mjs →
// -steps.mjs → -pw.mjs → this module, -codegen.mjs (the smoke suite's generator) and -redtest.mjs →
// -repro.mjs → -minimize.mjs (minimize, the RED test) → -smoke.mjs (the lane's smoke pass) → -suite.mjs
// (membership) → -propose.mjs (proposals) → -heal.mjs and -ci.mjs → -report.mjs → argus-live.mjs.
// Leaves: -fence.mjs, -targets.mjs, -origin.mjs, -classes.mjs, -layout.mjs, -a11y.mjs (the in-page checks). `pw` never imports this module, and -start.mjs
// never imports -browser.mjs (tests/argus-live-findings.test.ts pins both, and this order).
import { randomBytes } from "node:crypto";
import dns from "node:dns";
import { isIP } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureCli, findChrome, slotDir } from "./argus-live-browser.mjs";
import { closeSessions, sessionAlive } from "./argus-live-cli.mjs";
import { proveLogins } from "./argus-live-login.mjs";
import { startProxy } from "./argus-live-proxy.mjs";
import { DEFAULT_CALLS } from "./argus-live-pw.mjs";
import { readSlotState, retireAll } from "./argus-live-slots.mjs";
import { expandConfig, LIVE_FILE, loadLive, portNames } from "./argus-live-config.mjs";
import { checkCompose, checkDockerRuntime, daemonNow, dockerEnv, FOLLOWER, gateOf, startEventsFollower } from "./argus-live-docker.mjs";
import { checkEgress, egressAllowed } from "./argus-live-egress.mjs";
import { hostOf, resolvesToLoopback } from "./argus-live-endpoints.mjs";
import { dropLedgers } from "./argus-live-ledger.mjs";
import { iso, readLock, renew, takeLock } from "./argus-live-lock.mjs";
import { membersOf, processTable, redact, run, runAsync, runPids, sameGroup, sameStart, startTime, stopRecordedGroups, tempBeside } from "./argus-live-proc.mjs";
import { browserHome, down, guarded, logsDir, readRun, recover, replayStop, startReaper, updateRun, worktreeHeadFile, writeRunFiles } from "./argus-live-run.mjs";
import { drainSessions } from "./argus-live-session.mjs";
import { allocatePorts, bringUpRest, bringUpStore, instanceEnv, makeHome, makeWorktree, runSetup } from "./argus-live-start.mjs";
import { loadContract, protectedDatabases } from "./sapu-contract.mjs";
import { compileRules } from "./sapu-guard.mjs";

// ---------------------------------------------------------------------------------------------------
// up, up --fresh, renew, status (spec §8 `up` steps 1-11, `up --fresh`, `renew`).

const defaultLookup = (h) => dns.promises.lookup(h, { all: true });

/** `e` (an Error) tagged with the `up` step it failed in, for the CLI's report. */
const atStep = (e, step) => Object.assign(e instanceof Error ? e : new Error(String(e)), { step });

/**
 * An array whose `push` also runs `save`: `up` hands its groups and stop records to startEntry, runSetup
 * and runStep, which push each one as it starts, so run.json holds it at once (a session that dies
 * mid-`up` leaves a record for the reaper and for recovery). The records are the objects those
 * functions keep (`exited` is set on them later), never copies.
 */
function recordingArray(save, items = []) {
  const a = [...items];
  a.push = (...xs) => {
    const n = Array.prototype.push.apply(a, xs);
    save();
    return n;
  };
  return a;
}

/** The run's origins (spec §8): those of `base_url` and each role's, and of every port of the run on their hosts. */
function originsOf(x, ports) {
  const out = new Set();
  for (const u of [x.base_url, ...Object.values(x.roles ?? {}).map((r) => r && r.base_url)]) {
    let url;
    try {
      url = new URL(u);
    } catch {
      continue;
    }
    out.add(url.origin);
    for (const p of Object.values(ports)) {
      const v = new URL(url.origin);
      v.port = String(p);
      out.add(v.origin);
    }
  }
  return [...out];
}

/** The repo's sapu contract, or null without one; an invalid one is refused. */
function contractOf(main) {
  const c = loadContract(main);
  if (c.contract) return c.contract;
  if (c.missing) return null;
  throw new Error(`refused: ${c.error}`);
}

/**
 * The context steps 6-8 share (bringUpStore, bringUpRest, the egress checks): `egress` is the one-sample
 * check waitHealth runs between tries, `fullEgress` step 8's five samples, which also expect a listener
 * on base_url's port when it is one of the run's and no Compose service publishes it (`composePorts`).
 */
function runContext({ main, runId, x, env, worktree, home, ports, secrets, contract, groups, stops, deadline, composeServices, composePorts = [], runner, lookup, upstream = null }) {
  const allowed = egressAllowed({ config: x, env, ports });
  let port = NaN;
  try {
    port = Number(new URL(x.base_url).port);
  } catch {
    port = NaN;
  }
  // A port a Compose service publishes is served by the Docker daemon, not by a process of the run.
  const expectListen = Object.values(ports).includes(port) && !composePorts.includes(port) ? [port] : [];
  const egress = (samples, listen = []) => checkEgress({ pids: runPids(groups, runner), allowed, runner, lookup, samples, expectListen: listen, runDirs: [worktree, home], main, contract });
  return {
    config: x,
    env,
    worktree,
    main,
    contract,
    secrets,
    logs: logsDir(main, runId),
    groups,
    stops,
    timeoutS: (x.limits && x.limits.live_health_timeout_s) || 120,
    deadline,
    composeServices,
    lookup,
    upstream,
    egress: () => egress(1),
    fullEgress: () => egress(5, expectListen),
  };
}

/**
 * The keys of run.json `up` and `up --fresh` write (spec §8 step 11's table): every other key has its own
 * writer — `reaper` (startReaper), `internal` (startProxy, step 9), `sessions` (openSession, the logins,
 * `up --fresh`'s closes), `slots` (slot, submit, retireAll), `loginFailed` (login), `closing` (down) — and
 * is kept as it stands, as is a key this version does not know. `mode` is `up --map`'s alone (upMap).
 */
const UP_KEYS = ["runId", "instanceId", "worktree", "worktreeHead", "home", "ports", "upstream", "origins", "baseUrl", "env", "since", "events", "digest", "composeServices", "composePorts", "groups", "stops", "browser", "allowOrigins"];

/** `state`'s UP_KEYS (those it holds): what `up` and `up --fresh` write of it. */
const upOwned = (state) => Object.fromEntries(UP_KEYS.filter((k) => Object.hasOwn(state, k)).map((k) => [k, state[k]]));

/** A logger for one run: each line (secret values masked) to `say` and to `<logs>/<file>`. */
function runLog(main, runId, file, secrets, say) {
  return (line) => {
    const l = redact(line, secrets);
    say(l);
    try {
      const logs = logsDir(main, runId);
      fs.mkdirSync(logs, { recursive: true, mode: 0o700 });
      fs.appendFileSync(path.join(logs, file), `${l}\n`, { mode: 0o600 });
    } catch {
      // the line still went to `say`
    }
  };
}

/**
 * The commit `worktree` was built at (`git rev-parse HEAD` in it), also kept in worktreeHeadFile (0600), which
 * `down` leaves, with the run's `mode` (`map` for `up --map`: scrub tells a map run by it after `down`) → the
 * sha (decision 20: `map-check --merge` stamps it, after `down` too).
 */
function recordWorktreeHead(main, runId, worktree, runner, mode = "explore") {
  const r = runner(["git", "-C", worktree, "rev-parse", "HEAD"]);
  const head = r.status === 0 ? String(r.stdout).trim() : "";
  if (!/^[0-9a-f]{40,64}$/.test(head)) throw new Error(`failed: the worktree's commit cannot be read: ${String(r.stderr || (r.error && r.error.message) || "").trim().slice(0, 200)}`);
  const file = worktreeHeadFile(main, runId);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.renameSync(tempBeside(file, `${JSON.stringify({ worktreeHead: head, mode })}\n`, 0o600), file);
  return head;
}

/**
 * After a refusal or failure: `down` from the in-memory run — run.json's keys as they stand (the sessions
 * and slots other writers recorded meanwhile) under `state`'s own (the groups and stops this process
 * started, even one whose save was refused), each session drained into the secret ledger before it
 * closes — its report logged; the original error is what counts.
 */
async function tearDown(main, state, { secrets, runner, log }) {
  let onDisk = null;
  try {
    onDisk = readRun(main);
  } catch {
    onDisk = null;
  }
  const record = { ...(onDisk && onDisk.runId === state.runId ? onDisk : {}), ...state };
  try {
    const { report } = await down(main, { runId: state.runId, record, secrets, runner, drain: (records, o) => drainSessions(main, state.runId, records, { ...o, runner }) });
    for (const l of report) log(`down: ${l}`);
  } catch (e) {
    log(`down: ${e.message}`);
  }
}

/** A user's password or TOTP secret as live.json may hold it: exactly one `${NAME}`. */
const SECRET_REF = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;

/** loadLive's errors as one refusal: a file that is missing or no JSON in its own words, else after the file's name, once. */
const fileRefusal = (config, errors) => (config ? `refused: ${LIVE_FILE}: ${errors.map((e) => e.replace(/^\.argus\/live\.json:? /, "")).join("; ")}` : `refused: ${errors[0]}`);

/** Whether the guard keeps every agent out of `file` under `contract` (null: no contract, the floor alone): its base name, in any case. */
export const guardsEnvFile = (contract, file) => compileRules(contract).envFiles.has(path.basename(file).toLowerCase());

/**
 * The configuration checks `up` makes before it touches anything, in step 2's words and order, shared with
 * `argus-live.mjs check` (init's verification of a draft): `loadLive`'s errors as one line; every `${NAME}`
 * the env file leaves unset (none when the env file itself is at fault); each `base_url` or
 * `roles.<r>.base_url` whose host name does not resolve to loopback only (a literal address is the
 * schema's); each `services.<n>.env` neither `env` nor a set `pass_env` name gives the instance; a `store`
 * the contract protects; a user's `password` or `totp_secret` that is not exactly one `${NAME}`; an
 * `env_file` git tracks; given `contract` (the repo's, or null without one, which is said), an `env_file`
 * whose base name its `guard.envFiles` (with the guard's floor) does not hold. A file with
 * schema errors is still checked for the rest, so `check` names every fault at once; a throw the schema
 * errors already explain is left out. Reads files and resolves hosts, nothing else: no lock, no process,
 * no write, no value in a problem. `loaded` (loadLive's answer) lets `up` check the file it already read;
 * `lookup` is a test seam. Returns {config, secrets, digest, problems}.
 */
export async function configProblems(main, { lookup = defaultLookup, loaded = loadLive(main), contract } = {}) {
  const { config, errors, secrets, digest } = loaded;
  const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  // The file itself missing or unparsable: that one line (its own words name the file).
  if (!isObj(config)) return { config, secrets, digest, problems: errors.length ? [fileRefusal(config, errors)] : [] };
  const problems = errors.length ? [fileRefusal(config, errors)] : [];
  // An env file that cannot be read leaves every name unset, and one outside the repo is none of the repo's: the schema line says it once.
  const envFile = typeof config.env_file === "string" ? config.env_file : null;
  const envBad = errors.some((e) => e.startsWith("env_file "));
  // Every unset ${NAME}, once each, in the order expandConfig meets them.
  const { names } = portNames(config);
  const filled = { ...secrets };
  const unset = [];
  for (;;) {
    try {
      expandConfig(config, { ports: Object.fromEntries(names.map((n) => [n, 1])), secrets: filled });
      break;
    } catch (e) {
      const m = /^unset (\S+)$/.exec(e.message);
      if (!m || unset.includes(m[1])) {
        if (!m && !errors.length) problems.push(e.message);
        break;
      }
      unset.push(m[1]);
      filled[m[1]] = "x";
    }
  }
  if (!envBad) for (const n of unset) problems.push(`refused: \${${n}} is unset (${envFile ? `${envFile} gives it no value` : "there is no env_file to give it a value"})`);
  const roles = isObj(config.roles) ? Object.entries(config.roles) : [];
  const urls = [...(typeof config.base_url === "string" ? [["base_url", config.base_url]] : []), ...roles.filter(([, r]) => isObj(r) && typeof r.base_url === "string").map(([n, r]) => [`roles.${n}.base_url`, r.base_url])];
  for (const [where, url] of urls) {
    const host = hostOf(url);
    if (host && isIP(host)) continue; // a literal address: the schema judges it (validateLive), with no lookup
    if (!host || !(await resolvesToLoopback(host, lookup))) problems.push(`refused: ${where} names ${host ?? "no host"}, which does not resolve to loopback only (the instance serves this machine alone)`);
  }
  // Every backing service the app reads must have its address in the instance env, or the app falls back to its default (the owner's).
  const env = isObj(config.env) ? config.env : {};
  const passEnv = Array.isArray(config.pass_env) ? config.pass_env : [];
  for (const [n, svc] of isObj(config.services) ? Object.entries(config.services) : []) {
    const k = isObj(svc) ? svc.env : undefined;
    const set = (Object.hasOwn(env, k) && env[k] !== "") || (passEnv.includes(k) && Boolean(process.env[k]));
    if (!set) problems.push(`refused: services.${n}.env names ${k}, which the instance env does not set (set it in env, to the instance's own ${n})`);
  }
  // The store is never a database the contract protects (checkStore says it again at step 6, once the store services run).
  if (contract && typeof config.store === "string" && protectedDatabases(contract.guard ?? {}).databases.includes(config.store)) problems.push(`refused: the store "${config.store}" is a database guard.postgres/databases protects`);
  // A password or TOTP secret written in the file would be committed with it: only a ${NAME} the env file gives.
  for (const [r, role] of roles) {
    if (!isObj(role) || !Array.isArray(role.users)) continue;
    role.users.forEach((u, i) => {
      for (const k of ["password", "totp_secret"]) if (isObj(u) && typeof u[k] === "string" && !SECRET_REF.test(u[k])) problems.push(`refused: roles.${r}.users[${i}].${k} must be a \${NAME} reference (its value goes in the env file), never a literal`);
    });
  }
  if (envFile && !errors.some((e) => e.startsWith("env_file must be a path inside the repo"))) {
    // A file name, never a glob, in any letter case (a case-insensitive file system holds .argus/LIVE.env as the same file).
    if (run(["git", "-C", main, "ls-files", "--error-unmatch", "--", `:(literal,icase)${envFile}`]).status === 0) problems.push(`refused: env_file ${envFile} is tracked by git, so its values would be committed (git rm --cached it, and ignore it)`);
    // Untracked but not ignored: the next `git add -A` commits it. --no-index: a glob in the path never matches a tracked file.
    else if (run(["git", "-C", main, "check-ignore", "--no-index", "-q", "--", envFile]).status === 1) problems.push(`refused: env_file ${envFile} is not ignored by git, so it could be committed (add it to .gitignore)`);
    if (contract === null) problems.push(`refused: there is no sapu contract, so the guard keeps no agent out of env_file ${envFile} (/sapu:init writes it, with the file in guard.envFiles)`);
    else if (contract !== undefined && !guardsEnvFile(contract, envFile)) problems.push(`refused: env_file ${envFile} is not in the contract's guard.envFiles (/sapu:init adds it)`);
  }
  return { config, secrets, digest, problems };
}

/**
 * `argus-live.mjs up` (spec §8, steps 1-11): 1 the lock (and recovery of stale runs, every earlier
 * run's secret ledger removed (dropLedgers), then run.json and the reaper at once); 2 refusals (configProblems' first:
 * config errors, an unset `${NAME}`, a base_url or role base_url host that does not resolve to loopback only, a
 * `services` variable the instance env does not set; then `~/.playwright/cli.config.json`, neither lsof nor ss, no
 * process identity (start times), the pinned CLI
 * not installable (ensureCli), no Chrome-family browser) and run.json `browser: {js, channel}`;
 * 3 the environment (ports, HOME and its `browser/` HOME for the CLI, the run's Docker client, `since` and the events follower); 4 the worktree (run.json
 * `worktreeHead`, its commit, kept beside the run's records too: recordWorktreeHead) and setup; 5 the Compose
 * check; 6 the store phase, checkStore and reset; 7 the other entries and checkStore again; 8 the egress
 * check and the Docker runtime gate; 9 the proxy (run.json `allowOrigins`, its internal group and
 * `internal.proxy`); 10 one proving login per configured account (proveLogins); 11 the instance id. Any
 * refusal or failure after the lock → `down` (an end line) and the error rethrown, tagged with its
 * `step`. Ports are allocated at step 3: every command's environment names them. `say` gets one line per
 * step (and per proven account); `runner`, `lookup`, `ownerHome` and `findChrome` are test seams.
 * Returns the run's summary (summaryOf).
 */
export async function up(main, { fresh = false, runner = run, lookup = defaultLookup, ownerHome = os.homedir(), findChrome: locateChrome = findChrome, say = () => {} } = {}) {
  if (fresh) return upFresh(main, { runner, lookup, say });
  const { config, errors, secrets, digest } = loadLive(main);
  const max = config && config.limits && config.limits.max_cycle_minutes;
  if (!Number.isInteger(max)) throw atStep(new Error(errors.length ? fileRefusal(config, errors) : "refused: .argus/live.json: limits.max_cycle_minutes is missing"), "1 lock");
  let lock;
  try {
    lock = takeLock(main, { maxCycleMinutes: max });
  } catch (e) {
    throw atStep(e, "1 lock");
  }
  const runId = lock.runId;
  const log = runLog(main, runId, "up.log", secrets, say);
  const state = { runId, instanceId: null, worktree: null, home: null, ports: {}, upstream: {}, origins: [], baseUrl: null, env: null, since: null, events: null, digest, composeServices: [], composePorts: [] };
  // Only the first write creates run.json: a later one finding it gone means a `down` removed it. Each
  // writes up's own keys only (upOwned), merged over the record as it stands.
  let created = false;
  const save = () => {
    writeRunFiles(main, upOwned(state), { runner, secrets, create: !created });
    created = true;
  };
  state.groups = recordingArray(save);
  state.stops = recordingArray(save);
  let step = "1 lock";
  try {
    if (lock.staleRuns.length) {
      const r = await recover(main, { secrets, runner });
      for (const l of r.report) log(`recovery: ${l}`);
    }
    // Every earlier run's secret ledger goes now: kept by its down for scrub, until this cycle began.
    dropLedgers(main, { keep: runId });
    save();
    state.reaper = startReaper(main, runId);
    log(`step 1 lock: cycle ${runId} until ${iso(lock.deadline)}${lock.staleRuns.length ? `; recovered ${lock.staleRuns.map((l) => l.runId).join(", ")}` : ""}`);

    step = "2 refusals";
    // The configuration's own faults first, in check's words (one function): the first one refuses.
    const contract = contractOf(main);
    const { problems } = await configProblems(main, { lookup, loaded: { config, errors, secrets, digest }, contract });
    if (problems.length) throw new Error(problems[0]);
    const { names, fixed } = portNames(config);
    const pw = path.join(ownerHome, ".playwright", "cli.config.json");
    if (fs.existsSync(pw)) throw new Error(`refused: ${pw} exists; the browser CLI would merge it underneath the run's own config (move it aside)`);
    const missing = (argv) => {
      const r = runner(argv);
      return Boolean(r.error && r.error.code === "ENOENT");
    };
    if (missing(["lsof", "-v"]) && missing(["ss", "-V"])) throw new Error("refused: neither lsof nor ss is available");
    // Every kill of a teardown asks a process's identity (pid and start time) first: without one, down would be blind.
    let table = null;
    try {
      table = processTable(runner);
    } catch {
      table = null;
    }
    const me = startTime(process.pid, runner);
    const listed = table && table.find((p) => p.pid === process.pid);
    if (!me || !listed || !sameStart(me, listed.started)) throw new Error("refused: process identity is unavailable here (no start time from ps -o lstart=): down could not tell the run's processes from others'");
    // The browser side: the pinned CLI first, so the install command a missing browser is told names a CLI that exists.
    const cli = ensureCli({ runner, realMain: fs.realpathSync.native(main), secrets });
    const chrome = locateChrome();
    if (!chrome) throw new Error(`refused: no Chrome-family browser (Google Chrome or Microsoft Edge) is installed; install Google Chrome, or run: node ${cli.js} install-browser chrome`);
    state.browser = { js: cli.js, channel: chrome.channel };
    save();
    log("step 2 refusals: none");

    step = "3 environment";
    const ports = await allocatePorts(names, { range: config.port_range, reserved: config.reserved_ports ?? [], fixed, runner });
    state.ports = ports;
    const x = expandConfig(config, { ports: { ...ports }, secrets });
    state.origins = originsOf(x, ports);
    state.baseUrl = x.base_url;
    state.home = makeHome(main, runId);
    // The browser CLI's own HOME (cliEnv): its profiles, caches and temp files stay apart from what setup writes.
    const cliHome = browserHome(state);
    fs.mkdirSync(cliHome, { mode: 0o700 });
    const docker = dockerEnv({ home: state.home, runner });
    state.env = instanceEnv({ config, ports, secrets, runId, home: state.home, docker });
    // The daemon's clock through the run's own client (its context checked by dockerEnv just now);
    // nothing of the run has touched Docker before this step. With a daemon, the events follower starts
    // here: the runtime gate reads every event since, not only the daemon's last ones.
    const clock = daemonNow({ env: state.env, runner });
    state.since = clock ?? Date.now();
    if (clock !== null) state.events = (await startEventsFollower({ env: state.env, since: state.since, logs: logsDir(main, runId), cwd: state.home, groups: state.groups })).file;
    save();
    log(`step 3 environment: ports ${Object.entries(ports).map(([k, v]) => `${k}=${v}`).join(" ") || "none"}; HOME ${state.home}${state.events ? "; docker events followed" : ""}`);

    step = "4 worktree";
    state.worktree = makeWorktree(main, runId, { runner });
    save();
    state.worktreeHead = recordWorktreeHead(main, runId, state.worktree, runner);
    save();
    await runSetup(state.worktree, x, state.env, { main, secrets, deadline: lock.deadline, groups: state.groups });
    log(`step 4 worktree: ${state.worktree}; setup ${(x.setup ?? []).length} command(s)`);

    step = "5 Compose";
    const compose = checkCompose({ worktree: state.worktree, env: state.env, ports, main, config: x, contract, secrets, runner });
    state.composeServices = compose.services;
    state.composePorts = compose.published;
    save();
    log(`step 5 Compose: ${state.composeServices.length ? `services ${state.composeServices.join(", ")}` : "no Compose file"}`);

    const ctx = runContext({ main, runId, x, env: state.env, worktree: state.worktree, home: state.home, ports, secrets, contract, groups: state.groups, stops: state.stops, deadline: lock.deadline, composeServices: state.composeServices, composePorts: state.composePorts, runner, lookup, upstream: state.upstream });
    step = "6 store";
    await bringUpStore(ctx);
    log(`step 6 store: ${x.start.filter((e) => e.phase === "store").map((e) => e.name).join(", ") || "no store entry"} healthy; store_check printed ${x.store}; reset done`);
    step = "7 start";
    await bringUpRest(ctx);
    log(`step 7 start: ${x.start.filter((e) => e.phase !== "store").map((e) => e.name).join(", ") || "no other entry"} healthy; store_check printed ${x.store}`);
    step = "8 egress";
    await ctx.fullEgress();
    checkDockerRuntime({ ...gateOf(state, state.groups), main, runner });
    log("step 8 egress: the run's processes reach only what the run allows; the Docker runtime gate passed");

    step = "9 proxy";
    // Recorded before the proxy starts: it reads its allowed origins from run.json once, at start.
    state.allowOrigins = x.allow_origins ?? [];
    save();
    // startProxy records its group and writes run.json `internal.proxy`, the port's one writer.
    const proxy = await startProxy(main, runId, { groups: state.groups });
    log(`step 9 proxy: 127.0.0.1:${proxy.port}`);

    step = "10 logins";
    const proven = await proveLogins(main, runId, { live: x, secrets, origins: state.origins, allowOrigins: state.allowOrigins, js: cli.js, home: cliHome, proxyPort: proxy.port, chrome, env: state.env, worktree: state.worktree, runner, say: log });
    log(`step 10 logins: ${proven} account(s) proven`);

    step = "11 run files";
    state.instanceId = randomBytes(8).toString("hex");
    save();
    log(`step 11 run files: instance ${state.instanceId}; base_url ${x.base_url}; reaper ${state.reaper}`);
    return summaryOf(lock, state);
  } catch (e) {
    log(`step ${step}: ${e.message}`);
    await tearDown(main, state, { secrets, runner, log });
    throw atStep(e, step);
  }
}

/**
 * `argus-live.mjs up --map` (decision 20): `up`'s step 1 (the lock and its start line, recovery of stale runs,
 * every earlier run's secret ledger removed, run.json, the reaper) and step 4's worktree at HEAD with its
 * commit (`worktreeHead`), nothing else — no setup, store, app, proxy, HOME or logins. run.json holds `mode:
 * "map"`, `instanceId: null` and no group. Any failure after the lock → `down`, and the error rethrown, tagged
 * with its step. Returns {runId, mode: "map", deadline, worktree}.
 */
export async function upMap(main, { runner = run, say = () => {} } = {}) {
  const { config, errors, secrets } = loadLive(main);
  const max = config && config.limits && config.limits.max_cycle_minutes;
  if (!Number.isInteger(max)) throw atStep(new Error(errors.length ? fileRefusal(config, errors) : "refused: .argus/live.json: limits.max_cycle_minutes is missing"), "1 lock");
  let lock;
  try {
    lock = takeLock(main, { maxCycleMinutes: max });
  } catch (e) {
    throw atStep(e, "1 lock");
  }
  const runId = lock.runId;
  const log = runLog(main, runId, "up.log", secrets, say);
  const state = { runId, mode: "map", instanceId: null, worktree: null, worktreeHead: null, groups: [], stops: [] };
  let created = false;
  const save = () => {
    writeRunFiles(main, state, { runner, secrets, create: !created });
    created = true;
  };
  let step = "1 lock";
  try {
    if (lock.staleRuns.length) {
      const r = await recover(main, { secrets, runner });
      for (const l of r.report) log(`recovery: ${l}`);
    }
    dropLedgers(main, { keep: runId });
    save();
    const reaper = startReaper(main, runId);
    log(`step 1 lock: cycle ${runId} until ${iso(lock.deadline)} (map mode)${lock.staleRuns.length ? `; recovered ${lock.staleRuns.map((l) => l.runId).join(", ")}` : ""}`);
    step = "4 worktree";
    state.worktree = makeWorktree(main, runId, { runner });
    save();
    state.worktreeHead = recordWorktreeHead(main, runId, state.worktree, runner, "map");
    save();
    log(`step 4 worktree: ${state.worktree} at ${state.worktreeHead}; map mode: no setup, store, app, proxy or logins; reaper ${reaper}`);
    return { runId, mode: "map", deadline: lock.deadline, worktree: state.worktree };
  } catch (e) {
    log(`step ${step}: ${e.message}`);
    await tearDown(main, state, { secrets, runner, log });
    throw atStep(e, step);
  }
}

/** The running cycle's lock and run.json (they must name the same run), its config and secrets; refused otherwise (a map run too). */
function current(main) {
  const lock = readLock(main);
  if (!lock) throw new Error("refused: no journey cycle is running");
  if (lock.deadline * 1000 <= Date.now()) throw new Error(`refused: the deadline of cycle ${lock.runId} passed at ${iso(lock.deadline)}; run down`);
  const rec = readRun(main);
  if (rec && rec.runId === lock.runId && rec.mode === "map") throw new Error(`refused: cycle ${lock.runId} is a map run (up --map); run down`);
  if (!rec || rec.runId !== lock.runId || typeof rec.worktree !== "string" || !rec.env) throw new Error(`refused: run.json does not hold the instance of cycle ${lock.runId} (it is still starting, or it failed)`);
  if (rec.closing) throw new Error(`refused: cycle ${lock.runId} is being torn down`);
  // An instance id is set only once `up` (or `up --fresh`) finished every step: anything less was never checked whole.
  if (!rec.instanceId) throw new Error(`refused: cycle ${lock.runId}'s up did not finish; run down`);
  const { config, errors, secrets, digest } = loadLive(main);
  // The run was checked against the files as they were at `up`: a change is checked only by a new `up`.
  const was = rec.digest || {};
  const changed = was.live !== digest.live ? LIVE_FILE : was.env_file !== digest.env_file ? (config && config.env_file) || "the env_file" : null;
  if (changed) throw new Error(`refused: ${changed} changed since up; run down and up again`);
  if (errors.length) throw new Error(`refused: .argus/live.json: ${errors.join("; ")}`);
  return { lock, rec, config, secrets };
}

/**
 * `up --fresh` (between repro runs, spec §8): keeps the lock, worktree, ports, HOME and reaper; retires
 * every slot's token and clears the instance id first (from then on `pw` refuses every call but
 * `submit`), stops every `start` entry (its stop replayed, its group stopped; setup groups, the events
 * follower and the proxy stay), drains every CLI session but the proving logins' (an explorer's or the
 * repro runner's) into the secret ledger and closes it, then the store phase, checkStore,
 * reset, the other entries, checkStore, the egress check and the runtime gate again, and a new instance
 * id. It writes only up's keys of run.json (UP_KEYS). Any refusal or failure → `down`, and the error
 * rethrown.
 */
export async function upFresh(main, { runner = run, lookup = defaultLookup, say = () => {} } = {}) {
  const { lock, rec, config, secrets } = current(main);
  const runId = lock.runId;
  const log = runLog(main, runId, "up.log", secrets, say);
  const state = upOwned(rec);
  const save = () => writeRunFiles(main, upOwned(state), { runner, secrets, create: false });
  // Setup groups (a daemon a setup left), the events follower and the run's own helpers (`internal`:
  // the proxy) live as long as the run.
  const kept = (rec.groups ?? []).filter((g) => g && (/^setup\[\d+\]$/.test(g.name) || g.name === FOLLOWER || g.internal));
  state.groups = recordingArray(save, rec.groups ?? []);
  state.stops = recordingArray(save, rec.stops ?? []);
  let step = "fresh: stop";
  try {
    const note = (l) => log(`fresh: ${l}`);
    // The explorers belong to the instance being reset: their tokens retire before anything closes, so
    // no call of theirs reopens a session once it is closed.
    retireAll(main, runId);
    state.instanceId = null;
    save();
    for (const s of [...(rec.stops ?? [])].reverse()) {
      await guarded(`stop ${s && s.name}`, note, () => replayStop(s, { secrets, asyncRunner: runAsync, timeoutMs: 120_000, logs: logsDir(main, runId), note }));
    }
    const old = (rec.groups ?? []).filter((g) => !kept.includes(g));
    await stopRecordedGroups(old, { runner, secrets, graceMs: 10_000, note });
    // A group the stop could not end stays in the record, so `down` tries again; it is reported.
    const table = processTable(runner);
    const alive = old.filter((g) => {
      const now = membersOf(table, g.pgid, secrets);
      return now.length > 0 && sameGroup(g, now);
    });
    for (const g of alive) note(`${g.name} (pgid ${g.pgid}) still runs after the stop; kept in the record for down`);
    state.groups = recordingArray(save, [...kept, ...alive]);
    state.stops = recordingArray(save);
    // The explorers' and the repro runner's sessions (every slot but `up`) are closed, as run.json holds
    // them now (one a call opened before its token retired included). The proving logins' sessions (slot
    // `up`) were closed by up itself; any left stay for down.
    const explorers = ((readRun(main) ?? {}).sessions ?? []).filter((x) => x && x.slot !== "up");
    await drainSessions(main, runId, explorers, { js: rec.browser?.js ?? null, runner });
    await closeSessions(explorers, { js: rec.browser?.js ?? null, runner, note });
    // Only those now gone leave the record (one still running stays for down); re-read under the
    // run's claim, so a session recorded meanwhile is kept, and never written back from this snapshot.
    const closed = new Set(explorers.filter((x) => !sessionAlive(x, runner)).map((x) => x.name));
    for (const x of explorers.filter((y) => !closed.has(y.name))) note(`CLI session ${x.name} still runs after its close; kept in the record for down`);
    updateRun(main, runId, (prev) => (prev ? { ...prev, sessions: (prev.sessions ?? []).filter((x) => !x || !closed.has(x.name)) } : undefined), { create: false });
    save();
    log("fresh: every start entry stopped");
    const contract = contractOf(main);
    const x = expandConfig(config, { ports: { ...rec.ports }, secrets });
    const ctx = runContext({ main, runId, x, env: rec.env, worktree: rec.worktree, home: rec.home, ports: rec.ports, secrets, contract, groups: state.groups, stops: state.stops, deadline: lock.deadline, composeServices: rec.composeServices ?? [], composePorts: rec.composePorts ?? [], runner, lookup, upstream: (state.upstream = { ...(rec.upstream ?? {}) }) });
    step = "fresh: store";
    await bringUpStore(ctx);
    step = "fresh: start";
    await bringUpRest(ctx);
    step = "fresh: egress";
    await ctx.fullEgress();
    checkDockerRuntime({ ...gateOf(rec, state.groups), main, runner });
    state.instanceId = randomBytes(8).toString("hex");
    save();
    log(`fresh: instance ${state.instanceId}; store reset, every entry healthy, egress and the Docker runtime gate passed`);
    return summaryOf(lock, state);
  } catch (e) {
    log(`${step}: ${e.message}`);
    await tearDown(main, state, { secrets, runner, log });
    throw atStep(e, step);
  }
}

/**
 * The CLI's `renew` (spec §8 `renew`): moves the lock's deadline (renew; `cap reached` ends the cycle
 * and is rethrown as it is), then repeats the egress check and the Docker runtime gate over the run as
 * run.json records it; a refusal → `down`, and the error rethrown. Returns {runId, deadline}.
 */
export async function renewRun(main, { runner = run, lookup = defaultLookup, say = () => {} } = {}) {
  const { lock, rec, config, secrets } = current(main);
  const runId = lock.runId;
  const log = runLog(main, runId, "renew.log", secrets, say);
  const deadline = renew(main, { runId, maxCycleMinutes: config.limits.max_cycle_minutes });
  try {
    const x = expandConfig(config, { ports: { ...rec.ports }, secrets });
    const ctx = runContext({ main, runId, x, env: rec.env, worktree: rec.worktree, home: rec.home, ports: rec.ports, secrets, contract: contractOf(main), groups: rec.groups ?? [], stops: [], deadline, composeServices: rec.composeServices ?? [], composePorts: rec.composePorts ?? [], runner, lookup });
    await ctx.fullEgress();
    checkDockerRuntime({ ...gateOf(rec, rec.groups), main, runner });
    log(`renew: cycle ${runId} until ${iso(deadline)}; egress and the Docker runtime gate passed`);
    return { runId, deadline };
  } catch (e) {
    log(`renew: ${e.message}`);
    try {
      const { report } = await down(main, { runId, secrets, runner });
      for (const l of report) log(`down: ${l}`);
    } catch (d) {
      log(`down: ${d.message}`);
    }
    throw e;
  }
}

/**
 * What the orchestrator reads of a run, never run.json itself, and free of secrets: {runId, instanceId,
 * deadline (epoch seconds), baseUrl, origins, ports, worktree}. `up` and `up --fresh` return it (the CLI
 * prints it as their last line) and `status --json` repeats it.
 */
function summaryOf(lock, rec) {
  return { runId: lock.runId, instanceId: rec.instanceId ?? null, deadline: lock.deadline, baseUrl: rec.baseUrl ?? null, origins: rec.origins ?? [], ports: rec.ports ?? {}, worktree: rec.worktree ?? null };
}

/**
 * Each minted slot of run.json `rec` → `{"<n>": {journey, generation, calls, max, submitted, retired}}`:
 * the calls from its state.json, `max` the budget (`limits.explorer_pw_calls`), `retired` when it holds no
 * live token (`tokenHash: null`: submitted, or retired by `up --fresh`).
 */
function slotStates(main, runId, rec) {
  const { config } = loadLive(main);
  const max = (config && config.limits && config.limits.explorer_pw_calls) || DEFAULT_CALLS;
  const out = {};
  for (const [n, s] of Object.entries(rec.slots ?? {})) {
    if (!s || !/^[1-9][0-9]?$/.test(n)) continue;
    const { calls } = readSlotState(slotDir(main, runId, Number(n)));
    out[n] = { journey: s.journey, generation: s.generation, calls, max, submitted: Boolean(s.submitted), retired: !s.tokenHash };
  }
  return out;
}

/**
 * `status --json`: the running cycle's summary (summaryOf), its `mode` (`map` for an `up --map` run, else
 * `live`) and `slots`, each slot's state (slotStates: what the orchestrator reads of its explorers); every
 * field empty when none runs.
 */
export function statusJson(main) {
  const lock = readLock(main);
  if (!lock) return { runId: null, instanceId: null, deadline: null, baseUrl: null, origins: [], ports: {}, worktree: null, mode: null, slots: {} };
  const rec = readRun(main);
  const mine = rec && rec.runId === lock.runId ? rec : {};
  // A lock past its deadline is one the next up takes over (and recovers): its cycle is not running.
  const stale = lock.deadline <= Math.floor(Date.now() / 1000) ? { stale: true } : {};
  return { ...summaryOf(lock, mine), mode: mine.mode === "map" ? "map" : "live", slots: slotStates(main, lock.runId, mine), ...stale };
}

/**
 * `status`: the run id, deadline (` (stale: up recovers it)` once it has passed), `mode: map` for a map run, instance, worktree, ports, each recorded group's state, each slot
 * (`slot <n>: journey <id> generation <g> calls <c>/<max>[ submitted][ retired]`, slotStates) and the
 * number of recorded CLI sessions, as lines.
 */
export async function status(main, { runner = run } = {}) {
  const lock = readLock(main);
  if (!lock) return ["no journey cycle is running"];
  const out = [`cycle ${lock.runId} until ${iso(lock.deadline)}${lock.deadline <= Math.floor(Date.now() / 1000) ? " (stale: up recovers it)" : ""}`];
  const rec = readRun(main);
  if (!rec || rec.runId !== lock.runId) return [...out, "run.json does not name this cycle (it is starting, or it failed)"];
  if (rec.mode === "map") out.push("mode: map");
  out.push(`instance ${rec.instanceId ?? "(not ready)"}`, `worktree ${rec.worktree ?? "(not made yet)"}`, `ports ${Object.entries(rec.ports ?? {}).map(([k, v]) => `${k}=${v}`).join(" ") || "none"}`);
  let table = null;
  try {
    table = processTable(runner);
  } catch (e) {
    out.push(e.message);
  }
  for (const g of rec.groups ?? []) {
    const now = table ? membersOf(table, g.pgid, {}) : [];
    const state = !table ? "unknown" : !now.length ? "gone" : sameGroup(g, now) ? "running" : "gone (its pid is another process's)";
    out.push(`${g.name} (pgid ${g.pgid}): ${state}`);
  }
  for (const [n, s] of Object.entries(slotStates(main, lock.runId, rec))) {
    out.push(`slot ${n}: ${s.journey === null ? "map" : `journey ${s.journey}`} generation ${s.generation} calls ${s.calls}/${s.max}${s.submitted ? " submitted" : ""}${s.retired ? " retired" : ""}`);
  }
  out.push(`sessions: ${(rec.sessions ?? []).length}`);
  return out;
}
