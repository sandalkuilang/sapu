// argus-live-start.mjs — the bring-up blocks of the journey lane's live instance (spec §8 `up` steps 3-7):
// ports, the worktree, HOME and the instance environment, setup, starting an entry and waiting for its
// health, and the store phase with its checks. `up` and `up --fresh` (argus-live-instance.mjs) run them in
// order; nothing here touches the browser side.
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { expand, secretEnv } from "./argus-live-config.mjs";
import { portHolder } from "./argus-live-egress.mjs";
import { loopbackAliases, normHost, ownerEnvFiles, readOwner, scopeChecker } from "./argus-live-endpoints.mjs";
import { runIdOk } from "./argus-live-lock.mjs";
import { killGroup, MAX_HOPS, msLeft, readFrom, redact, resolveLink, run, runAsync, sleep, startTime, tail, within } from "./argus-live-proc.mjs";
import { liveRoot, ownDir, repoName } from "./argus-live-run.mjs";
import { findMain, protectedDatabases } from "./sapu-contract.mjs";

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

/**
 * One GET of a health `url` (no redirect followed) → `{status, address}` (`address`: the peer it
 * answered from, an IPv4-mapped IPv6 address as IPv4), or null when nothing answered within `timeoutMs`.
 */
function healthAnswer(url, timeoutMs) {
  return new Promise((done) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      return done(null);
    }
    const req = (u.protocol === "https:" ? https : http).get(u, { agent: false, timeout: timeoutMs }, (res) => {
      const address = String(res.socket.remoteAddress || "").replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/, "$1") || null;
      res.resume();
      done({ status: res.statusCode, address });
    });
    req.on("timeout", () => {
      req.destroy();
      done(null);
    });
    req.on("error", () => done(null));
  });
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
export async function waitHealth(entry, started, { timeoutS, aliveAfterMs = 5000, worktree, env, secrets = {}, runner = runAsync, egress = async () => {}, upstream = null }) {
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
      const res = await healthAnswer(entry.health.url, Math.min(2000, left));
      ok = Boolean(res && res.status >= 200 && res.status < 300);
      // The address the run's listener answered on: the proxy connects a loopback name there, never by a lookup.
      if (ok && upstream && res.address) {
        const u = new URL(entry.health.url);
        if (normHost(u.hostname) === "loopback") upstream[u.port || (u.protocol === "https:" ? "443" : "80")] = res.address;
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
 * primary guards). The store must not be a database `guard.postgres`/`guard.databases` protects. `store_check` (shell,
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
 * a port or database `guard.postgres`/`guard.databases` protects (in a URL, `jdbc:` URL, libpq DSN, a bare port number,
 * or a bare name under a variable that names a database), nor may a libpq or MySQL-family value leave
 * its host or port to the client's default (the instance names both). Refusals name the key, never a
 * value.
 */
export async function checkStore({ config, env, worktree, main, contract, secrets = {}, deadline, timeoutS = 120, composeServices = [], runner = runAsync, lookup = null }) {
  const guard = (contract && contract.guard) || {};
  const pg = protectedDatabases(guard);
  if (pg.databases.includes(config.store)) throw new Error(`refused: the store "${config.store}" is a database guard.postgres/databases protects`);
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
