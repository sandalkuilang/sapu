// argus-live-instance.mjs — the journey lane's live instance (spec §8): one isolated copy of the
// repo's app per cycle, which never touches the owner's servers, services or data.
//
// This module brings it up: ports, the worktree, HOME and environment, setup, the store phase, start
// and health, and `up`, `up --fresh`, `renew` and `status`. Its parts, each importing only the ones
// before it: argus-live-proc.mjs (processes) → -lock.mjs (lock, live log) → -endpoints.mjs (endpoint
// comparison) → -docker.mjs (Compose, the runtime gate) and -egress.mjs (the egress check) → -run.mjs
// (run.json, teardown) → this module.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import dns from "node:dns";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { expand, expandConfig, LIVE_FILE, loadLive, portNames, secretEnv } from "./argus-live-config.mjs";
import { checkCompose, checkDockerRuntime, daemonNow, dockerEnv, FOLLOWER, gateOf, startEventsFollower } from "./argus-live-docker.mjs";
import { checkEgress, egressAllowed, portHolder } from "./argus-live-egress.mjs";
import { hostOf, loopbackAliases, ownerEnvFiles, readOwner, resolvesToLoopback, scopeChecker } from "./argus-live-endpoints.mjs";
import { iso, readLock, renew, runIdOk, takeLock } from "./argus-live-lock.mjs";
import { killGroup, MAX_HOPS, membersOf, msLeft, processTable, readFrom, redact, resolveLink, run, runAsync, runPids, sameGroup, sameStart, sleep, startTime, stopRecordedGroups, tail, within } from "./argus-live-proc.mjs";
import { down, guarded, logsDir, readRun, recover, replayStop, repoName, startReaper, writeRunFiles } from "./argus-live-run.mjs";
import { findMain, loadContract } from "./sapu-contract.mjs";

/** True when something accepts a TCP connection at host:port (a timeout counts as yes). */
function accepts(host, port) {
  return new Promise((done) => {
    const c = net.connect({ host, port });
    const end = (v) => {
      c.destroy();
      done(v);
    };
    c.setTimeout(500, () => end(true));
    c.once("connect", () => end(true));
    c.once("error", () => end(false));
  });
}

/**
 * A port is free when nothing answers on it at 127.0.0.1 or ::1 (a listener on the wildcard or on
 * ::1 only would not stop a bind on 127.0.0.1 everywhere) and a listen on 127.0.0.1 succeeds and is
 * closed again.
 */
export async function portFree(port) {
  if ((await accepts("127.0.0.1", port)) || (await accepts("::1", port))) return false;
  return new Promise((done) => {
    const s = net.createServer();
    s.once("error", () => done(false));
    s.listen({ port, host: "127.0.0.1", exclusive: true }, () => s.close(() => done(true)));
  });
}

/**
 * `{<name>: port}` for every name and every fixed port. A name takes a free port from `range`
 * outside `reserved` and the ports already handed out, scanning from a random point so two runs
 * rarely race for the same port. A fixed port is used as written; one in `reserved` or taken is
 * refused, naming its holder. `probe` (default portFree) is a test seam.
 */
export async function allocatePorts(names, { range, reserved = [], fixed = {}, probe = portFree, runner = run }) {
  const out = {};
  const owner = {};
  for (const [name, n] of Object.entries(fixed)) {
    if (Object.hasOwn(owner, n)) throw new Error(`refused: port ${n} is fixed for both ${owner[n]} and ${name}`);
    owner[n] = name;
  }
  const wanted = names.filter((n) => !Object.hasOwn(fixed, n));
  if (wanted.length && !Array.isArray(range)) throw new Error(`refused: port_range is required for {port:${wanted[0]}}`);
  const [lo, hi] = range ?? [0, -1];
  for (const [name, n] of Object.entries(fixed)) {
    if (reserved.includes(n)) throw new Error(`refused: port ${n} (${name}) is one of reserved_ports`);
    if (!(await probe(n))) throw new Error(`refused: port ${n} (${name}) is taken by ${portHolder(n, { runner })}`);
    out[name] = n;
  }
  const size = hi - lo + 1;
  const from = Math.floor(Math.random() * size);
  let i = 0;
  for (const name of names) {
    if (Object.hasOwn(out, name)) continue;
    const used = new Set(Object.values(out));
    for (; i < size; i++) {
      const port = lo + ((from + i) % size);
      if (reserved.includes(port) || used.has(port) || !(await probe(port))) continue;
      out[name] = port;
      i++;
      break;
    }
    if (!Object.hasOwn(out, name)) throw new Error(`refused: no free port in ${lo}-${hi} for ${name}`);
  }
  return out;
}

/** Refuses a path that is a symlink, not a directory, or not the current user's. */
function ownDir(dir) {
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink()) throw new Error(`refused: ${dir} is a symlink; remove it`);
  if (!st.isDirectory()) throw new Error(`refused: ${dir} is not a directory`);
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw new Error(`refused: ${dir} belongs to another user`);
  if ((st.mode & 0o777) !== 0o700) fs.chmodSync(dir, 0o700);
}

/**
 * `$TMPDIR/sapu-live`, private to this user (0700, never a symlink), holding every run's worktree and
 * HOME outside the repo. Refused when it would lie inside the repo, before and after it exists.
 */
function liveRoot(realMain) {
  let tmp;
  try {
    tmp = fs.realpathSync.native(os.tmpdir());
  } catch (e) {
    throw new Error(`refused: TMPDIR ${os.tmpdir()} does not exist or cannot be read (${e.code || e.message})`);
  }
  const root = path.join(tmp, "sapu-live");
  const inRepo = (p) => new Error(`refused: ${p} would lie inside the repo (TMPDIR points into it)`);
  if (within(realMain, root)) throw inRepo(root);
  try {
    fs.mkdirSync(root, { mode: 0o700 });
  } catch (e) {
    if (!e || e.code !== "EEXIST") throw e;
  }
  ownDir(root);
  const real = fs.realpathSync.native(root);
  if (within(realMain, real)) throw inRepo(real);
  return real;
}

/**
 * A linked worktree of HEAD at `$TMPDIR/sapu-live/<repo>-<runId>`, outside the repo, so no lookup that
 * walks up the directory tree finds the repo's own `.env`. Returns its real path (the form the guard
 * compares).
 */
export function makeWorktree(main, runId, { runner = run } = {}) {
  runIdOk(runId);
  const realMain = fs.realpathSync.native(main);
  const wt = path.join(liveRoot(realMain), `${repoName(realMain)}-${runId}`);
  const r = runner(["git", "-C", main, "worktree", "add", "--detach", wt, "HEAD"]);
  if (r.error || r.status !== 0) throw new Error(`failed: git worktree add ${wt}: ${((r.error && r.error.message) || r.stderr || "").trim()}`);
  const real = fs.realpathSync.native(wt);
  if (within(realMain, real)) {
    runner(["git", "-C", main, "worktree", "remove", "--force", wt]);
    throw new Error(`refused: the worktree ${real} lies inside the repo`);
  }
  return real;
}

/**
 * The run's own empty HOME, `$TMPDIR/sapu-live/<repo>-<runId>.home` (mode 0700), beside the worktree
 * and outside the repo, so a setup may link into it (a managed Python, a package store). Refused
 * when it is a symlink, another user's, or not empty.
 */
export function makeHome(main, runId) {
  runIdOk(runId);
  const realMain = fs.realpathSync.native(main);
  const home = path.join(liveRoot(realMain), `${repoName(realMain)}-${runId}.home`);
  try {
    fs.mkdirSync(home, { mode: 0o700 });
  } catch (e) {
    if (!e || e.code !== "EEXIST") throw e;
  }
  ownDir(home);
  if (fs.readdirSync(home).length) throw new Error(`refused: ${home} is not empty`);
  return fs.realpathSync.native(home);
}

/** What every command inherits from the session: nothing that names an account or a credential. */
const BASE_ENV = ["PATH", "USER", "SHELL", "TMPDIR", "LANG"];
/** What decides which Compose files Compose reads: with `compose_files`, the run's alone. */
const COMPOSE_FILE_VARS = ["COMPOSE_FILE", "COMPOSE_PATH_SEPARATOR"];

/** Variables the run sets itself (or, DOCKER_CONTEXT, keeps unset): `env`, `pass_env` and a start entry's env may not name them. */
const RUN_ENV = ["HOME", "COMPOSE_PROJECT_NAME", "DOCKER_CONFIG", "DOCKER_HOST", "DOCKER_CONTEXT"];

/**
 * The only environment any command of the instance gets: `PATH, USER, SHELL, TMPDIR, LANG, LC_*`
 * (when set), the `pass_env` names (when set), every `env` entry expanded, `COMPOSE_PROJECT_NAME =
 * argus-<runId>`, `HOME` = the run's home, and `docker` (dockerEnv's DOCKER_CONFIG and DOCKER_HOST).
 * No owner home, so no tool picks up the owner's cloud, Git or registry credentials. `env` and
 * `pass_env` may not name RUN_ENV. With `compose_files`, COMPOSE_FILE = those files joined with ":"
 * (and COMPOSE_PATH_SEPARATOR = ":", whatever a tracked .env says), so the instance's own Compose
 * commands read exactly the files checkCompose checked (not a tracked
 * `compose.override.yaml` beside them); `env`, `pass_env` and a start entry's env may not then set
 * COMPOSE_FILE or COMPOSE_PATH_SEPARATOR.
 */
export function instanceEnv({ config, ports, secrets, runId, home, docker = {} }) {
  runIdOk(runId);
  const listed = Array.isArray(config.compose_files) && config.compose_files.length ? config.compose_files : null;
  if (listed) {
    const why = "when compose_files is set (the run sets COMPOSE_FILE from it)";
    for (const k of COMPOSE_FILE_VARS) {
      if (k in (config.env ?? {})) throw new Error(`refused: env may not set ${k} ${why}`);
      if ((config.pass_env ?? []).includes(k)) throw new Error(`refused: pass_env may not name ${k} ${why}`);
      for (const e of config.start ?? []) if (e.env && k in e.env) throw new Error(`refused: start entry ${e.name} may not set ${k} ${why}`);
    }
  }
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && (BASE_ENV.includes(k) || k.startsWith("LC_"))) env[k] = v;
  for (const k of config.pass_env ?? []) {
    if (RUN_ENV.includes(k)) throw new Error(`refused: pass_env may not name ${k}`);
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  for (const [k, v] of Object.entries(config.env ?? {})) {
    if (RUN_ENV.includes(k)) throw new Error(`refused: env may not set ${k}`);
    env[k] = expand(v, { ports, secrets });
  }
  env.COMPOSE_PROJECT_NAME = `argus-${runId}`.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  env.HOME = home;
  for (const k of ["DOCKER_CONFIG", "DOCKER_HOST"]) if (typeof docker[k] === "string") env[k] = docker[k];
  if (listed) {
    // The separator too: a tracked .env naming another one would otherwise split the list elsewhere.
    env.COMPOSE_FILE = listed.join(":");
    env.COMPOSE_PATH_SEPARATOR = ":";
  }
  return env;
}

/**
 * Throws `refused: <link> points into the main checkout` for any symlink in the worktree (its `.git`
 * aside) whose target lies in <MAIN> or holds it (an ancestor, `/`): the instance would write there
 * (a dependency directory linked from the owner's checkout). Targets are followed through every
 * link, broken ones included; symlinked directories inside the worktree are not walked.
 */
export function refuseLinksIntoMain(worktree, main) {
  const realMain = fs.realpathSync.native(main);
  const stack = [worktree];
  while (stack.length) {
    const dir = stack.pop();
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (dir === worktree && d.name === ".git") continue;
      const p = path.join(dir, d.name);
      if (d.isSymbolicLink()) {
        const target = resolveLink(path.resolve(dir, fs.readlinkSync(p)));
        if (target === null) throw new Error(`refused: ${p} could not be resolved (a link loop, or more than ${MAX_HOPS} links)`);
        if (within(realMain, target) || within(target, realMain)) throw new Error(`refused: ${p} points into the main checkout`);
      } else if (d.isDirectory()) stack.push(p);
    }
  }
}

/**
 * Runs each `setup` argv in the worktree under `env`, without a shell, each in its own process group
 * (recorded in `groups` as `setup[<i>]` before it is awaited, with its secrets masked, so `down` kills
 * a daemon it leaves behind), its output appended to `log`; each step is bounded by the time left
 * before `deadline` (the lock's, epoch seconds), and a timed-out or failed step's whole group is
 * killed. Then refuses a symlink into <MAIN>. Throws `failed: setup <argv> exited <code>: <its
 * output's last lines>` or `failed: setup <argv> timed out`, every non-empty `secrets` value masked.
 */
export async function runSetup(worktree, config, env, { main = findMain(worktree), runner = runAsync, secrets = {}, deadline, log = `${worktree}.setup.log`, groups = [] } = {}) {
  msLeft(deadline, "runSetup");
  if (!main) throw new Error(`failed: no main checkout found for ${worktree}`);
  for (const [i, argv] of (config.setup ?? []).entries()) {
    const shown = redact(argv.join(" "), secrets);
    const left = msLeft(deadline, "runSetup");
    if (left <= 0) throw new Error(`failed: setup ${shown} timed out (the cycle's deadline passed)`);
    const fd = fs.openSync(log, "a", 0o600);
    const from = fs.fstatSync(fd).size;
    let pgid;
    let record = null;
    let r;
    try {
      r = await runner(argv, {
        cwd: worktree,
        env,
        stdio: ["ignore", fd, fd],
        timeoutMs: left,
        onStart: (p) => {
          pgid = p;
          record = { name: `setup[${i}]`, pgid: p, started: startTime(p), cmdline: shown };
          groups.push(record);
        },
      });
    } finally {
      fs.closeSync(fd);
      if (record && r && r.exited) record.exited = true; // its leader is gone, a daemon it left is not
    }
    const out = () => tail(redact(readFrom(log, from), secrets));
    if (r.timedOut) {
      killGroup(pgid);
      throw new Error(`failed: setup ${shown} timed out (the cycle's deadline): ${out()}`);
    }
    if (r.error) throw new Error(`failed: setup ${shown}: ${redact(r.error.message, secrets)}`);
    if (r.status !== 0) {
      killGroup(pgid);
      throw new Error(`failed: setup ${shown} exited ${r.status ?? r.signal}: ${out()}`);
    }
  }
  refuseLinksIntoMain(worktree, main);
}

/** True when something answers at `url` (any HTTP response, or a connection that never replies). */
async function answers(url) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1000), redirect: "manual" });
    return true;
  } catch (e) {
    return Boolean(e && e.name === "TimeoutError");
  }
}

/** A shell field's command run once: `/bin/sh -c`, its own group killed afterwards, bounded by `timeoutMs`. */
function shellOnce(cmd, { cwd, env, secrets = {}, timeoutMs, capture = false, runner = runAsync }) {
  return runner(["/bin/sh", "-c", cmd], { cwd, env: { ...env, ...secretEnv(cmd, secrets) }, timeoutMs, capture, killAfter: true });
}

/** How long a health `cmd` may take before start (it must fail fast: nothing runs yet). */
const PRECHECK_MS = 5000;

/**
 * Starts one expanded `start` entry: `/bin/sh -c <cmd>` in the worktree, detached into its own process
 * group (recorded in `groups`), under `env` plus the entry's own env and the secrets its command
 * references, logged to `<logs>/<name>.log`. Refused when its health already answers before it runs
 * (a `url` that responds, a `cmd` that exits 0: something else serves there) and when its env names
 * HOME or COMPOSE_PROJECT_NAME. An entry with `stop` gets its stop record in `stops` as soon as it
 * started ({name, cmd, cwd, env}: replayed exactly by `down`; `cmd` holds variable references, never a
 * secret value). Returns {name, pid, pgid, log, cmdline, t0, exit} (`exit` = {code, signal} once it
 * exits).
 */
export async function startEntry(entry, { worktree, env, logs, secrets = {}, groups = [], stops = [], runner = runAsync }) {
  for (const k of Object.keys(entry.env ?? {})) if (RUN_ENV.includes(k)) throw new Error(`refused: start entry ${entry.name} may not set ${k}`);
  const health = entry.health || {};
  if (health.url && (await answers(health.url))) throw new Error(`refused: something already serves ${health.url} (${entry.name})`);
  if (health.cmd) {
    const r = await shellOnce(health.cmd, { cwd: worktree, env: { ...env, ...(entry.env ?? {}) }, secrets, timeoutMs: PRECHECK_MS, runner });
    if (!r.error && !r.timedOut && r.status === 0) throw new Error(`refused: the health cmd of ${entry.name} already succeeds before it started (something else serves there)`);
  }
  fs.mkdirSync(logs, { recursive: true, mode: 0o700 });
  const log = path.join(logs, `${entry.name}.log`);
  const fd = fs.openSync(log, "a", 0o600);
  let child;
  try {
    child = spawn("/bin/sh", ["-c", entry.cmd], { cwd: worktree, env: { ...env, ...(entry.env ?? {}), ...secretEnv(entry.cmd, secrets) }, detached: true, stdio: ["ignore", fd, fd] });
  } finally {
    fs.closeSync(fd);
  }
  const started = { name: entry.name, pid: undefined, pgid: undefined, log, cmdline: `/bin/sh -c ${entry.cmd}`, t0: Date.now(), exit: null };
  let record = null;
  child.once("exit", (code, signal) => {
    started.exit = { code, signal };
    if (record) record.exited = true; // from now on, a process holding its pid is not ours
  });
  await new Promise((ok, fail) => {
    child.once("spawn", ok);
    child.once("error", (e) => fail(new Error(`failed: ${entry.name} could not start: ${e.message}`)));
  });
  started.pid = started.pgid = child.pid;
  record = { name: entry.name, pgid: child.pid, started: startTime(child.pid), cmdline: started.cmdline };
  if (started.exit) record.exited = true;
  // The stop first: a `down` sealing run.json between the two writes then still replays it. The group
  // is pushed even when the stop's write is refused (the push lands in memory before the save throws),
  // so the failing `up`'s teardown, which reads the in-memory record, still stops the process.
  try {
    if (entry.stop) stops.push({ name: entry.name, cmd: entry.stop, cwd: worktree, env: { ...env, ...(entry.env ?? {}) } });
  } finally {
    groups.push(record);
  }
  return started;
}

/**
 * Waits until `entry` is healthy: `{url}` answering 2xx, `{cmd}` exiting 0 (run like the entry, its
 * group killed after each try), or, without health, the process alive after `aliveAfterMs`. A process
 * that exits before then fails it (checked again after a health that answered), unless it exited 0
 * and the entry has `stop` (a detached starter). `timeoutS` bounds the wait. `egress` (a one-sample
 * checkEgress, from `up`) runs between tries, so a connection made while the app starts is seen too.
 */
export async function waitHealth(entry, started, { timeoutS, aliveAfterMs = 5000, worktree, env, secrets = {}, runner = runAsync, egress = async () => {} }) {
  const until = Date.now() + timeoutS * 1000;
  const exited = () => {
    const x = started.exit;
    if (!x) return null;
    if (x.code === 0 && entry.stop) return null;
    return new Error(`failed: ${entry.name} exited (code ${x.code ?? x.signal}) before its health passed; log ${started.log}: ${tail(redact(readFrom(started.log, 0), secrets))}`);
  };
  const timeout = () => new Error(`failed: ${entry.name} was not healthy within ${timeoutS} s; log ${started.log}`);
  if (!entry.health) {
    while (Date.now() < started.t0 + aliveAfterMs) {
      const x = exited();
      if (x) throw x;
      if (started.exit && entry.stop) return;
      await egress();
      await sleep(50);
    }
    const x = exited();
    if (x) throw x;
    return;
  }
  for (;;) {
    const left = until - Date.now();
    let x = exited();
    if (x) throw x;
    if (left <= 0) throw timeout();
    let ok = false;
    if (entry.health.url) {
      try {
        const res = await fetch(entry.health.url, { signal: AbortSignal.timeout(Math.min(2000, left)), redirect: "manual" });
        ok = res.status >= 200 && res.status < 300;
      } catch {
        ok = false;
      }
    } else {
      const r = await shellOnce(entry.health.cmd, { cwd: worktree, env: { ...env, ...(entry.env ?? {}) }, secrets, timeoutMs: Math.min(30_000, left), runner });
      ok = !r.error && !r.timedOut && r.status === 0;
    }
    // A health that answered says nothing when our own process is gone: something else answered.
    x = exited();
    if (x) throw x;
    if (ok) return;
    if (Date.now() >= until) throw timeout();
    await egress();
    await sleep(250);
  }
}

/**
 * The store checks of `up` steps 6 and 7 (defence in depth: `store_check` and the egress check are the
 * primary guards). The store must not be a database `guard.postgres` protects. `store_check` (shell,
 * worktree, bounded by `timeoutS`) must print `store` under the instance env and under the env of
 * every `start` entry that sets its own. No value in those envs may reach what the repo's env files
 * name (`.env`, `.env.local`, the contract's `guard.envFiles`; read here, never printed):
 * - a non-http service on the same host:port, whatever its database (no opt-in: the instance reaches
 *   such services only through its own); an endpoint with no host or no port never matches (but a
 *   libpq or MySQL-family value with no host is the local server: LOCAL_BY_DEFAULT), and a
 *   single-label host among `composeServices` (the worktree's own Compose project) is exempt;
 * - an http(s) URL equal up to its query, or on the same loopback endpoint, unless its origin is in
 *   `allow_origins`;
 * - a file or socket path equal to one they name, or any path inside <MAIN> (the instance's relative
 *   paths resolve in the worktree, the owner's in <MAIN>; `sqlite:///x` is read both ways, filePaths).
 * `X_HOST` + `X_PORT` count as one endpoint, and a bare `*PORT` as a loopback one; with `lookup` (up's
 * dns lookup), a host name that resolves only to loopback counts as loopback on both sides (loopbackAliases).
 * Nor may a value name
 * a port or database `guard.postgres` protects (in a URL, `jdbc:` URL, libpq DSN, a bare port number,
 * or a bare name under a variable that names a database), nor may a libpq or MySQL-family value leave
 * its host or port to the client's default (the instance names both). Refusals name the key, never a
 * value.
 */
export async function checkStore({ config, env, worktree, main, contract, secrets = {}, deadline, timeoutS = 120, composeServices = [], runner = runAsync, lookup = null }) {
  const guard = (contract && contract.guard) || {};
  const pg = guard.postgres || { ports: [], databases: [] };
  if (pg.databases.includes(config.store)) throw new Error(`refused: the store "${config.store}" is a database guard.postgres protects`);
  const scopes = [{ label: "env", where: "", env, own: env }];
  for (const e of config.start ?? []) if (e.env && Object.keys(e.env).length) scopes.push({ label: `start.${e.name}.env`, where: ` under the env of start entry ${e.name}`, env: { ...env, ...e.env }, own: e.env });
  for (const scope of scopes) {
    const left = Math.min(timeoutS * 1000, msLeft(deadline, "checkStore"));
    const r = await shellOnce(config.store_check, { cwd: worktree, env: scope.env, secrets, timeoutMs: Math.max(0, left), capture: true, runner });
    if (r.timedOut) throw new Error(`failed: store_check timed out${scope.where}`);
    if (r.error || r.status !== 0) throw new Error(`failed: store_check${scope.where} ${r.error ? redact(r.error.message, secrets) : `exited ${r.status ?? r.signal}`}`);
    const got = r.stdout.trim();
    if (got !== config.store) throw new Error(`refused: store_check printed "${redact(got.slice(0, 80), secrets)}"${scope.where}, not the store "${config.store}"`);
  }
  const alias = lookup ? await loopbackAliases([...scopes.map((x) => x.env), ...ownerEnvFiles(main, contract).map((f) => f.vars)], lookup) : (h) => h;
  const check = scopeChecker(readOwner(main, contract, alias), { worktree, allowOrigins: config.allow_origins, composeServices, alias });
  for (const scope of scopes) check(scope.label, scope.env, { own: scope.own });
}

/** Runs one config command (`reset`) through the shell in the worktree, logged, bounded by `deadline`. */
async function runStep(name, cmd, { worktree, env, logs, deadline, secrets = {}, groups = [], runner = runAsync }) {
  const left = msLeft(deadline, name);
  if (left <= 0) throw new Error(`failed: ${name} timed out (the cycle's deadline passed)`);
  fs.mkdirSync(logs, { recursive: true, mode: 0o700 });
  const log = path.join(logs, `${name}.log`);
  const fd = fs.openSync(log, "a", 0o600);
  const from = fs.fstatSync(fd).size;
  let r;
  let record = null;
  try {
    r = await runner(["/bin/sh", "-c", cmd], {
      cwd: worktree,
      env: { ...env, ...secretEnv(cmd, secrets) },
      stdio: ["ignore", fd, fd],
      timeoutMs: left,
      onStart: (p) => {
        record = { name, pgid: p, started: startTime(p), cmdline: `/bin/sh -c ${cmd}` };
        groups.push(record);
      },
    });
  } finally {
    fs.closeSync(fd);
    if (record && r && r.exited) record.exited = true;
  }
  if (r.timedOut) throw new Error(`failed: ${name} timed out (the cycle's deadline)`);
  if (r.error) throw new Error(`failed: ${name}: ${redact(r.error.message, secrets)}`);
  if (r.status !== 0) throw new Error(`failed: ${name} exited ${r.status ?? r.signal}: ${tail(redact(readFrom(log, from), secrets))}`);
}

async function startHealthy(entry, ctx) {
  await waitHealth(entry, await startEntry(entry, ctx), ctx);
}

/**
 * `up` step 6: the `phase: "store"` entries (started and healthy, one by one), `checkStore`, and only
 * then `reset`. `ctx` = {config (expanded), env, worktree, main, contract, secrets, logs, groups,
 * timeoutS, deadline}; every started group lands in `ctx.groups` as it starts.
 */
export async function bringUpStore(ctx) {
  for (const e of ctx.config.start.filter((x) => x.phase === "store")) await startHealthy(e, ctx);
  await checkStore(ctx);
  await runStep("reset", ctx.config.reset, ctx);
}

/** `up` step 7: every other entry (started and healthy, one by one), then `checkStore` again. */
export async function bringUpRest(ctx) {
  for (const e of ctx.config.start.filter((x) => x.phase !== "store")) await startHealthy(e, ctx);
  await checkStore(ctx);
}

// ---------------------------------------------------------------------------------------------------
// up, up --fresh, renew, status (spec §8 `up` steps 1-8 and 11, `up --fresh`, `renew`). Steps 9 (the
// filtering proxy) and 10 (proving logins) arrive with the browser driver.

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
function runContext({ main, runId, x, env, worktree, home, ports, secrets, contract, groups, stops, deadline, composeServices, composePorts = [], runner, lookup }) {
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
    egress: () => egress(1),
    fullEgress: () => egress(5, expectListen),
  };
}

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

/** After a refusal or failure: `down` from the in-memory run, its report logged; the original error is what counts. */
async function tearDown(main, state, { secrets, runner, log }) {
  try {
    const { report } = await down(main, { runId: state.runId, record: state, secrets, runner });
    for (const l of report) log(`down: ${l}`);
  } catch (e) {
    log(`down: ${e.message}`);
  }
}

/**
 * `argus-live.mjs up` (spec §8, steps 1-8 and 11): 1 the lock (and recovery of stale runs, then run.json
 * and the reaper at once); 2 refusals (config errors, an unset `${NAME}`, a base_url or role base_url
 * host that does not resolve to loopback only, `~/.playwright/cli.config.json`, neither lsof nor ss, no
 * process identity (start times), a `services` variable the instance env does not set);
 * 3 the environment (ports, HOME, the run's Docker client, `since` and the events follower); 4 the worktree and setup; 5 the Compose
 * check; 6 the store phase, checkStore and reset; 7 the other entries and checkStore again; 8 the egress
 * check and the Docker runtime gate; 11 the instance id. Any refusal or failure after the lock → `down`
 * (an end line) and the error rethrown, tagged with its `step`. Ports are allocated at step 3: every
 * command's environment names them. `say` gets one line per step; `runner`, `lookup` and `ownerHome`
 * are test seams. Returns the run's summary (summaryOf).
 */
export async function up(main, { fresh = false, runner = run, lookup = defaultLookup, ownerHome = os.homedir(), say = () => {} } = {}) {
  if (fresh) return upFresh(main, { runner, lookup, say });
  const { config, errors, secrets, digest } = loadLive(main);
  const max = config && config.limits && config.limits.max_cycle_minutes;
  if (!Number.isInteger(max)) throw atStep(new Error(`refused: .argus/live.json: ${errors.join("; ") || "limits.max_cycle_minutes is missing"}`), "1 lock");
  let lock;
  try {
    lock = takeLock(main, { maxCycleMinutes: max });
  } catch (e) {
    throw atStep(e, "1 lock");
  }
  const runId = lock.runId;
  const log = runLog(main, runId, "up.log", secrets, say);
  const state = { runId, instanceId: null, worktree: null, home: null, ports: {}, internal: {}, origins: [], baseUrl: null, env: null, since: null, events: null, digest, composeServices: [], composePorts: [] };
  // Only the first write creates run.json: a later one finding it gone means a `down` removed it.
  let created = false;
  const save = () => {
    writeRunFiles(main, state, { runner, secrets, create: !created });
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
    save();
    state.reaper = startReaper(main, runId);
    log(`step 1 lock: cycle ${runId} until ${iso(lock.deadline)}${lock.staleRuns.length ? `; recovered ${lock.staleRuns.map((l) => l.runId).join(", ")}` : ""}`);

    step = "2 refusals";
    if (errors.length) throw new Error(`refused: .argus/live.json: ${errors.join("; ")}`);
    const contract = contractOf(main);
    const { names, fixed } = portNames(config);
    try {
      expandConfig(config, { ports: Object.fromEntries(names.map((n) => [n, 1])), secrets });
    } catch (e) {
      const m = /^unset (\S+)$/.exec(e.message);
      if (m) throw new Error(`refused: \${${m[1]}} is unset (${config.env_file ?? "no env_file"} gives it no value)`);
      throw e;
    }
    const urls = [["base_url", config.base_url], ...Object.entries(config.roles ?? {}).filter(([, r]) => r && r.base_url).map(([n, r]) => [`roles.${n}.base_url`, r.base_url])];
    for (const [where, url] of urls) {
      const host = hostOf(url);
      if (!host || !(await resolvesToLoopback(host, lookup))) throw new Error(`refused: ${where} names ${host ?? "no host"}, which does not resolve to loopback only (the instance serves this machine alone)`);
    }
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
    // Every backing service the app reads must have its address in the instance env, or the app falls back to its default (the owner's).
    for (const [n, svc] of Object.entries(config.services ?? {})) {
      const k = svc && svc.env;
      const set = (Object.hasOwn(config.env ?? {}, k) && config.env[k] !== "") || ((config.pass_env ?? []).includes(k) && Boolean(process.env[k]));
      if (!set) throw new Error(`refused: services.${n}.env names ${k}, which the instance env does not set (set it in env, to the instance's own ${n})`);
    }
    log("step 2 refusals: none");

    step = "3 environment";
    const ports = await allocatePorts(names, { range: config.port_range, reserved: config.reserved_ports ?? [], fixed, runner });
    state.ports = ports;
    const x = expandConfig(config, { ports: { ...ports }, secrets });
    state.origins = originsOf(x, ports);
    state.baseUrl = x.base_url;
    state.home = makeHome(main, runId);
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
    await runSetup(state.worktree, x, state.env, { main, secrets, deadline: lock.deadline, groups: state.groups });
    log(`step 4 worktree: ${state.worktree}; setup ${(x.setup ?? []).length} command(s)`);

    step = "5 Compose";
    const compose = checkCompose({ worktree: state.worktree, env: state.env, ports, main, config: x, contract, secrets, runner });
    state.composeServices = compose.services;
    state.composePorts = compose.published;
    save();
    log(`step 5 Compose: ${state.composeServices.length ? `services ${state.composeServices.join(", ")}` : "no Compose file"}`);

    const ctx = runContext({ main, runId, x, env: state.env, worktree: state.worktree, home: state.home, ports, secrets, contract, groups: state.groups, stops: state.stops, deadline: lock.deadline, composeServices: state.composeServices, composePorts: state.composePorts, runner, lookup });
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

/** The running cycle's lock and run.json (they must name the same run), its config and secrets; refused otherwise. */
function current(main) {
  const lock = readLock(main);
  if (!lock) throw new Error("refused: no journey cycle is running");
  if (lock.deadline * 1000 <= Date.now()) throw new Error(`refused: the deadline of cycle ${lock.runId} passed at ${iso(lock.deadline)}; run down`);
  const rec = readRun(main);
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
 * `up --fresh` (between repro runs, spec §8): keeps the lock, worktree, ports, HOME and reaper; stops
 * every `start` entry (its stop replayed, its group stopped; setup groups and the events follower stay), then the store phase,
 * checkStore, reset, the other entries, checkStore, the egress check and the runtime gate again, and a
 * new instance id. Any refusal or failure → `down`, and the error rethrown.
 */
export async function upFresh(main, { runner = run, lookup = defaultLookup, say = () => {} } = {}) {
  const { lock, rec, config, secrets } = current(main);
  const runId = lock.runId;
  const log = runLog(main, runId, "up.log", secrets, say);
  const state = { ...rec };
  const save = () => writeRunFiles(main, state, { runner, secrets, create: false });
  // Setup groups (a daemon a setup left) and the events follower live as long as the run.
  const kept = (rec.groups ?? []).filter((g) => g && (/^setup\[\d+\]$/.test(g.name) || g.name === FOLLOWER));
  state.groups = recordingArray(save, rec.groups ?? []);
  state.stops = recordingArray(save, rec.stops ?? []);
  let step = "fresh: stop";
  try {
    const note = (l) => log(`fresh: ${l}`);
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
    state.instanceId = null;
    save();
    log("fresh: every start entry stopped");
    const contract = contractOf(main);
    const x = expandConfig(config, { ports: { ...rec.ports }, secrets });
    const ctx = runContext({ main, runId, x, env: rec.env, worktree: rec.worktree, home: rec.home, ports: rec.ports, secrets, contract, groups: state.groups, stops: state.stops, deadline: lock.deadline, composeServices: rec.composeServices ?? [], composePorts: rec.composePorts ?? [], runner, lookup });
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

/** `status --json`: the running cycle's summary (summaryOf); every field empty when none runs. */
export function statusJson(main) {
  const lock = readLock(main);
  if (!lock) return { runId: null, instanceId: null, deadline: null, baseUrl: null, origins: [], ports: {}, worktree: null };
  const rec = readRun(main);
  return summaryOf(lock, rec && rec.runId === lock.runId ? rec : {});
}

/** `status`: the run id, deadline, instance, worktree, ports and each recorded group's state, as lines. */
export async function status(main, { runner = run } = {}) {
  const lock = readLock(main);
  if (!lock) return ["no journey cycle is running"];
  const out = [`cycle ${lock.runId} until ${iso(lock.deadline)}`];
  const rec = readRun(main);
  if (!rec || rec.runId !== lock.runId) return [...out, "run.json does not name this cycle (it is starting, or it failed)"];
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
  return out;
}
