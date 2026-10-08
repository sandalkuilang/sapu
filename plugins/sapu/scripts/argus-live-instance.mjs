// argus-live-instance.mjs — the journey lane's live instance (spec §8): one isolated copy of the
// repo's app per cycle, which never touches the owner's servers, services or data.
//
// The lock and the live log. `<MAIN>/.argus/live/lock.json` holds {runId, start, deadline} (epoch
// seconds); a lock whose deadline has not passed refuses every other cycle, one past it is handed to
// recovery. `<MAIN>/.git/sapu-live.log` is read by sapu-merge.sh's live_overlap, so its lines are
// exactly `<run> start <epoch> deadline <epoch>`, `<run> deadline <epoch>` and `<run> end <epoch>`.
// Every path is resolved from <MAIN> (findMain in sapu-contract.mjs), never from the cwd.
//
// The rule that keeps concurrent `up`s, `renew`s and `down`s from losing a lock: a new lock is created
// only where none exists (link(2) fails on an existing file), and a lock naming run <R> is replaced or
// removed only by the holder of `.argus/live/claim-<R>.json` (also created by link(2), so exactly one
// process holds it), after re-reading the lock under the claim. A takeover replaces the stale lock with
// rename(2), so `lock.json` never goes missing in between, and keeps its claim: that file is the stale
// run's record for recovery, and it makes every later taker of the same stale run back off.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import dns from "node:dns";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expand, expandConfig, LIVE_FILE, loadLive, MAX_CYCLE_MINUTES, parseEnvFile, portNames, secretEnv } from "./argus-live-config.mjs";
import { findMain, loadContract } from "./sapu-contract.mjs";

/** `<yyyymmddhhmmss>-<8 hex>` (UTC): unique per run, and safe on a log line and in a file name. */
export const RUN_ID = /^\d{14}-[0-9a-f]{8}$/;
/** Grace beyond `limits.max_cycle_minutes`, in the first deadline and in the renewal cap alike. */
const GRACE_S = 15 * 60;
/** Every epoch the lock holds or computes lies in the years 2000-2099. */
const EPOCH_MIN = 946684800;
const EPOCH_MAX = 4102444800;

const liveDir = (main) => path.join(main, ".argus", "live");
const lockPath = (main) => path.join(liveDir(main), "lock.json");
const claimPath = (main, runId) => path.join(liveDir(main), `claim-${runId}.json`);
const liveLog = (main) => path.join(main, ".git", "sapu-live.log");
const iso = (s) => new Date(s * 1000).toISOString();
const isEpoch = (s) => Number.isInteger(s) && s >= EPOCH_MIN && s < EPOCH_MAX;

function seconds(ms) {
  const s = typeof ms === "number" && Number.isFinite(ms) ? Math.floor(ms / 1000) : NaN;
  if (!isEpoch(s)) throw new Error(`refused: the time ${ms} is outside the years 2000-2099`);
  return s;
}

function minutes(maxCycleMinutes) {
  if (!Number.isInteger(maxCycleMinutes) || maxCycleMinutes < 1 || maxCycleMinutes > MAX_CYCLE_MINUTES) {
    throw new Error(`refused: limits.max_cycle_minutes must be an integer from 1 to ${MAX_CYCLE_MINUTES}`);
  }
  return maxCycleMinutes;
}

function runIdOk(runId) {
  if (typeof runId !== "string" || !RUN_ID.test(runId)) throw new Error(`not a run id: ${JSON.stringify(runId)}`);
}

function appendLive(main, runId, rest) {
  runIdOk(runId);
  fs.appendFileSync(liveLog(main), `${runId} ${rest}\n`);
}

/** Write `data` to a temp file beside `file` (created with `mode`, when given); returns the temp path. */
function tempBeside(file, data, mode) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  fs.writeFileSync(tmp, data, mode === undefined ? undefined : { mode });
  return tmp;
}

/** Take the claim on run `runId`'s lock: true, or false when another process holds it. */
function claim(main, runId, record) {
  const file = claimPath(main, runId);
  const tmp = tempBeside(file, `${JSON.stringify({ ...record, pid: process.pid })}\n`);
  try {
    fs.linkSync(tmp, file);
    return true;
  } catch (e) {
    if (e && e.code === "EEXIST") return false;
    throw e;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

const alive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};

/**
 * A claim older than this (by mtime) was interrupted even when its pid is alive: every change made under
 * a claim takes milliseconds, and the pid may since belong to another program.
 */
const CLAIM_STALE_MS = 30_000;

/**
 * The refusal for a claim another process holds on a lock that still names `runId`. `retry` is set when
 * its holder is alive and the claim fresh: it will be gone in a moment.
 */
function claimBusy(main, runId) {
  const file = claimPath(main, runId);
  let pid;
  try {
    pid = JSON.parse(fs.readFileSync(file, "utf8")).pid;
  } catch {
    pid = undefined;
  }
  let age = 0;
  try {
    age = Date.now() - fs.statSync(file).mtimeMs;
  } catch {
    // gone meanwhile: its holder finished
  }
  const remove = `remove ${file} once no journey cycle is running`;
  if (alive(pid) && age > CLAIM_STALE_MS) return new Error(`refused: a change to cycle ${runId}'s lock was interrupted (its claim is ${Math.round(age / 1000)} s old; process ${pid} may be another program by now); ${remove}`);
  if (alive(pid)) return Object.assign(new Error(`refused: cycle ${runId}'s lock is being changed by process ${pid}; try again`), { retry: true });
  return new Error(`refused: a change to cycle ${runId}'s lock was interrupted (process ${pid ?? "unknown"} is gone); ${remove}`);
}

const heldBy = (l) => new Error(`refused: cycle ${l.runId} holds the lock until ${iso(l.deadline)}`);

/** The lock, or null when there is none. Throws `refused: …` on a lock that cannot be read: it is never guessed at. */
export function readLock(main) {
  const file = lockPath(main);
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") return null;
    throw new Error(`refused: cannot read ${file}: ${e.message}`);
  }
  let l;
  try {
    l = JSON.parse(raw);
  } catch {
    l = null;
  }
  if (!l || typeof l.runId !== "string" || !RUN_ID.test(l.runId) || !isEpoch(l.start) || !isEpoch(l.deadline) || l.deadline <= l.start) {
    throw new Error(`refused: ${file} is not a lock {runId, start, deadline}; remove it once no journey cycle is running`);
  }
  return { runId: l.runId, start: l.start, deadline: l.deadline };
}

/**
 * Take the lock for a new run and append its start line to the live log.
 * Returns {runId, start, deadline, staleRuns} and, when it took over a lock past its deadline, `stale`
 * (that lock; also kept in `claim-<stale run>.json`). `staleRuns` = staleRecords: every run awaiting
 * `recover`, the taken-over one included. Throws `refused: cycle <run> holds the
 * lock until <iso>` while another run's deadline has not passed. `pause(step)` is a test seam: it runs
 * at "exists", "stale" and "claimed", where another process could act.
 */
export function takeLock(main, { maxCycleMinutes, now = Date.now(), pause = () => {} }) {
  const max = minutes(maxCycleMinutes);
  const start = seconds(now);
  const runId = `${new Date(now).toISOString().slice(0, 19).replace(/\D/g, "")}-${randomBytes(4).toString("hex")}`;
  const lock = { runId, start, deadline: start + max * 60 + GRACE_S };
  fs.mkdirSync(liveDir(main), { recursive: true });
  const file = lockPath(main);
  // A lock is only ever created whole: written beside, then linked or renamed into place.
  const tmp = tempBeside(file, `${JSON.stringify(lock)}\n`);
  let stale;
  try {
    for (let tries = 0; ; tries++) {
      if (tries >= 5) throw new Error(`refused: ${file} kept changing; try again`);
      try {
        fs.linkSync(tmp, file);
        break;
      } catch (e) {
        if (!e || e.code !== "EEXIST") throw e;
      }
      pause("exists");
      const held = readLock(main);
      if (!held) continue;
      if (held.deadline > start) throw heldBy(held);
      pause("stale");
      if (!claim(main, held.runId, { lock: held, by: runId })) {
        const cur = readLock(main);
        if (!cur || cur.runId !== held.runId) continue;
        throw claimBusy(main, held.runId);
      }
      pause("claimed");
      let cur;
      try {
        cur = readLock(main);
      } catch (e) {
        fs.rmSync(claimPath(main, held.runId), { force: true });
        throw e;
      }
      if (!cur || cur.runId !== held.runId) {
        // The stale run's lock was removed (its own `down`) under our claim: nothing left to recover.
        fs.rmSync(claimPath(main, held.runId), { force: true });
        continue;
      }
      fs.renameSync(tmp, file);
      stale = held;
      break;
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  try {
    appendLive(main, runId, `start ${lock.start} deadline ${lock.deadline}`);
  } catch (e) {
    // Ours and fresh, so no other process may have replaced it; a taken-over run's claim stays as its record.
    fs.rmSync(file, { force: true });
    throw new Error(`refused: cannot append to ${liveLog(main)}: ${e.message}`);
  }
  const staleRuns = staleRecords(main);
  return stale ? { ...lock, stale, staleRuns } : { ...lock, staleRuns };
}

/**
 * Every run awaiting recovery: each `claim-<R>.json` holding the lock {runId, start, deadline} of run R
 * (a takeover keeps it as R's record, even one whose live-log append failed and was rolled back) while
 * the current lock names another run. `recover` deletes each only after it replayed that run.
 */
export function staleRecords(main) {
  const cur = readLock(main);
  let names;
  try {
    names = fs.readdirSync(liveDir(main));
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    const m = n.match(/^claim-(\d{14}-[0-9a-f]{8})\.json$/);
    if (!m) continue;
    let l;
    try {
      l = JSON.parse(fs.readFileSync(path.join(liveDir(main), n), "utf8")).lock;
    } catch {
      continue; // gone meanwhile, or not a takeover's record
    }
    if (!l || l.runId !== m[1] || !isEpoch(l.start) || !isEpoch(l.deadline) || (cur && cur.runId === l.runId)) continue;
    out.push({ runId: l.runId, start: l.start, deadline: l.deadline });
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * Move run `runId`'s deadline by `maxCycleMinutes`, never past start + 3 × it + the 15 min grace;
 * append the new deadline to the live log, then rewrite the lock. Returns the new deadline. Throws
 * `cap reached` when it cannot move, `refused: …` when the lock names another run, its deadline
 * passed, or it changed meanwhile. `pause("claimed")` is a test seam.
 */
export function renew(main, { runId, maxCycleMinutes, now = Date.now(), pause = () => {} }) {
  runIdOk(runId);
  const max = minutes(maxCycleMinutes);
  const at = seconds(now);
  const lock = readLock(main);
  if (!lock) throw new Error("no lock: no journey cycle is running");
  if (lock.runId !== runId) throw new Error(`refused: the lock names cycle ${lock.runId}, not ${runId}`);
  if (at >= lock.deadline) throw new Error(`refused: the deadline of cycle ${runId} passed at ${iso(lock.deadline)}`);
  const next = Math.min(lock.deadline + max * 60, lock.start + 3 * max * 60 + GRACE_S);
  if (next <= lock.deadline) throw new Error(`cap reached: cycle ${runId} ends at ${iso(lock.deadline)} (start + 3 × max_cycle_minutes + 15 min)`);
  if (!claim(main, runId, { renew: next })) throw claimBusy(main, runId);
  try {
    pause("claimed");
    const cur = readLock(main);
    if (!cur || cur.runId !== runId || cur.deadline !== lock.deadline) {
      throw new Error(`refused: the lock changed while renewing cycle ${runId} (it now names ${cur ? `cycle ${cur.runId}` : "no cycle"})`);
    }
    // The log first: a log that runs longer than the lock only marks a gate live=1 needlessly.
    appendLive(main, runId, `deadline ${next}`);
    const file = lockPath(main);
    fs.renameSync(tempBeside(file, `${JSON.stringify({ ...lock, deadline: next })}\n`), file);
  } finally {
    fs.rmSync(claimPath(main, runId), { force: true });
  }
  return next;
}

/** Append `<runId> end <now>` to the live log (a failed `up`, a `down`). */
export function appendEnd(main, runId, now = Date.now()) {
  appendLive(main, runId, `end ${seconds(now)}`);
}

/**
 * The one runner every external command goes through, so tests can substitute it:
 * `argv` without a shell → {status, stdout, stderr, error} (spawnSync's).
 */
export function run(argv, opts = {}) {
  return spawnSync(argv[0], argv.slice(1), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024, ...opts });
}

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

/** Who listens on `port`: `<command> (pid <n>)`, from `lsof`, else `ss`; `unknown` when neither tells. */
export function portHolder(port, { runner = run } = {}) {
  const fmt = (pairs) => [...new Set(pairs.map(([c, p]) => `${c} (pid ${p})`))].join(", ");
  const l = runner(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"]);
  if (!l.error && l.status === 0 && l.stdout) {
    const pairs = [];
    let pid;
    for (const line of l.stdout.split("\n")) {
      if (line.startsWith("p")) pid = line.slice(1);
      else if (line.startsWith("c") && pid) pairs.push([line.slice(1), pid]);
    }
    if (pairs.length) return fmt(pairs);
  }
  const s = runner(["ss", "-ltnpH", `sport = :${port}`]);
  if (!s.error && s.status === 0 && s.stdout) {
    const pairs = [...s.stdout.matchAll(/\("([^"]+)",pid=(\d+)/g)].map((m) => [m[1], m[2]]);
    if (pairs.length) return fmt(pairs);
  }
  return "unknown";
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

/** `p` is `root` or lies under it (both already real paths). */
const within = (root, p) => {
  const r = path.relative(root, p);
  return r === "" || (r !== ".." && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r));
};

/** Symlinks followed while resolving one path before giving up (Linux's MAXSYMLINKS). */
const MAX_HOPS = 40;

/**
 * The real path `p` leads to, following every symlink on the way even when the end is missing (a
 * broken link, or a chain through one): the real path of the nearest existing ancestor plus the
 * missing rest. Null when it takes more than MAX_HOPS links (a loop): the caller fails closed.
 */
function resolveLink(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    // missing, or too many links: walked by hand below
  }
  let hops = 0;
  let cur = path.parse(path.resolve(p)).root;
  const pending = path.resolve(p).split(path.sep).filter(Boolean);
  while (pending.length) {
    const name = pending.shift();
    if (name === ".") continue;
    if (name === "..") {
      cur = path.dirname(cur);
      continue;
    }
    const next = path.join(cur, name);
    let st;
    try {
      st = fs.lstatSync(next);
    } catch {
      return path.join(next, ...pending);
    }
    if (!st.isSymbolicLink()) {
      cur = next;
      continue;
    }
    if (++hops > MAX_HOPS) return null;
    const target = fs.readlinkSync(next);
    if (path.isAbsolute(target)) cur = path.parse(target).root;
    pending.unshift(...target.split(path.sep).filter(Boolean));
  }
  return cur;
}

const repoName = (realMain) => path.basename(realMain).replace(/[^A-Za-z0-9._-]/g, "-");

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
 * The run's Docker client (spec §8 step 3), so no docker command of the instance reads the owner's
 * credentials or reaches anything but this machine's daemon: DOCKER_CONFIG = `<home>/.docker`, holding
 * only links to the owner's CLI plugins (`<their DOCKER_CONFIG or ~/.docker>/cli-plugins/docker-*`) and
 * a config.json without auths, credsStore or currentContext (only `cliPluginsExtraDirs` carried over);
 * DOCKER_HOST = the local unix socket of the owner's current context (`docker context inspect`).
 * Refused when that context is anything but a local unix socket. Without docker on PATH, only
 * DOCKER_CONFIG. `ownerEnv` is the session's environment, in which the context is looked up.
 */
export function dockerEnv({ home, runner = run, ownerEnv = process.env }) {
  const dir = path.join(home, ".docker");
  const plugins = path.join(dir, "cli-plugins");
  fs.mkdirSync(plugins, { recursive: true, mode: 0o700 });
  const ownerCfg = ownerEnv.DOCKER_CONFIG || path.join(ownerEnv.HOME || os.homedir(), ".docker");
  let names = [];
  try {
    names = fs.readdirSync(path.join(ownerCfg, "cli-plugins"));
  } catch {
    // no plugins of the owner's own
  }
  for (const name of names) if (/^docker-[A-Za-z0-9._-]+$/.test(name)) fs.symlinkSync(path.join(ownerCfg, "cli-plugins", name), path.join(plugins, name));
  let extra;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(ownerCfg, "config.json"), "utf8"));
    if (Array.isArray(j.cliPluginsExtraDirs)) extra = j.cliPluginsExtraDirs.filter((d) => typeof d === "string");
  } catch {
    // no config of the owner's own
  }
  fs.writeFileSync(path.join(dir, "config.json"), `${JSON.stringify(extra ? { cliPluginsExtraDirs: extra } : {})}\n`, { mode: 0o600 });
  const out = { DOCKER_CONFIG: dir };
  const r = runner(["docker", "context", "inspect"], { env: ownerEnv, timeout: 30_000 });
  if (r.error && r.error.code === "ENOENT") return out;
  if (r.error || r.status !== 0) throw new Error(`refused: docker context inspect failed: ${tail((r.error && r.error.message) || r.stderr)}`);
  let ctx;
  try {
    ctx = JSON.parse(r.stdout)[0];
  } catch {
    ctx = null;
  }
  const host = ctx && ctx.Endpoints && ctx.Endpoints.docker && ctx.Endpoints.docker.Host;
  const m = typeof host === "string" && host.match(/^unix:\/\/(\/.+)$/);
  if (!m) {
    const scheme = typeof host === "string" ? host.split(":")[0] : "no host";
    throw new Error(`refused: the docker context ${(ctx && ctx.Name) || "in use"} is not a local unix socket (${scheme}); the instance uses only this machine's daemon`);
  }
  out.DOCKER_HOST = `unix://${m[1]}`;
  return out;
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

/** `text` with every non-empty secret value replaced by `***` (longest first). */
export function redact(text, secrets = {}) {
  const values = [...new Set(Object.values(secrets).filter((v) => typeof v === "string" && v !== ""))].sort((a, b) => b.length - a.length);
  return values.reduce((t, v) => t.split(v).join("***"), String(text ?? ""));
}

/** The last lines of a command's output, for an error message. */
const tail = (text) => (text || "").trim().split("\n").slice(-5).join(" | ").slice(-500);

/** What `file` gained from byte `from` on (at most its last 64 KiB). */
function readFrom(file, from) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(from, size - 64 * 1024);
    const buf = Buffer.alloc(Math.max(0, size - start));
    fs.readSync(fd, buf, 0, buf.length, start);
    return buf.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

/** SIGKILL (or `signal`) to every process of group `pgid`; a group already gone is fine. */
export function killGroup(pgid, signal = "SIGKILL") {
  if (!Number.isInteger(pgid) || pgid <= 1) return;
  try {
    process.kill(-pgid, signal);
  } catch {
    // gone already
  }
}

/** How long `capture` waits for stdout to close after the process exited (a background child may hold it). */
const DRAIN_MS = 200;

/**
 * The async runner: `argv` without a shell, detached into its own process group (pgid = pid, handed
 * to `onStart` before anything is awaited). On `timeoutMs` the whole group gets SIGKILL; with
 * `killAfter`, so does whatever the group left running once it exits. With `capture`, stdout is
 * collected (up to 1 MiB) until it closes or `DRAIN_MS` after the exit → {status, signal, timedOut,
 * error, stdout}.
 */
export function runAsync(argv, { cwd, env, timeoutMs, stdio = ["ignore", "ignore", "ignore"], capture = false, killAfter = false, onStart = () => {} } = {}) {
  return new Promise((done) => {
    let finished = false;
    let timedOut = false;
    let timer;
    let stdout = "";
    let child;
    const finish = (r) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (killAfter && child && child.pid) killGroup(child.pid);
      done({ timedOut, stdout, ...r });
    };
    try {
      child = spawn(argv[0], argv.slice(1), { cwd, env, detached: true, stdio: capture ? [stdio[0], "pipe", stdio[2]] : stdio });
    } catch (e) {
      finish({ error: e });
      return;
    }
    child.once("error", (e) => finish({ error: e }));
    if (capture) child.stdout.on("data", (d) => stdout.length < 1 << 20 && (stdout += d));
    if (!child.pid) return;
    onStart(child.pid);
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        killGroup(child.pid);
      }, Math.max(0, timeoutMs));
    }
    child.once("exit", (status, signal) => {
      if (!capture) return finish({ status, signal });
      const drained = () => finish({ status, signal });
      if (child.stdout.closed || child.stdout.readableEnded) return drained();
      child.stdout.once("close", drained);
      setTimeout(drained, DRAIN_MS);
    });
  });
}

/** `deadline` (epoch seconds) as milliseconds left; refuses a missing one. */
function msLeft(deadline, what) {
  if (!Number.isInteger(deadline)) throw new Error(`failed: ${what} needs the lock's deadline (epoch seconds)`);
  return deadline * 1000 - Date.now();
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
      if (record) record.exited = true; // the step returned: its leader is gone, a daemon it left is not
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  groups.push(record);
  if (entry.stop) stops.push({ name: entry.name, cmd: entry.stop, cwd: worktree, env: { ...env, ...(entry.env ?? {}) } });
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

/** Default ports, so `redis://localhost` and `redis://127.0.0.1:6379` name the same service. */
const DEFAULT_PORTS = { postgresql: 5432, mysql: 3306, mariadb: 3306, redis: 6379, rediss: 6379, mongodb: 27017, amqp: 5672, amqps: 5671, http: 80, https: 443, smtp: 25, smtps: 465, memcached: 11211, nats: 4222 };
const HTTP = new Set(["http", "https"]);
const decodeSafe = (x) => {
  try {
    return decodeURIComponent(x);
  } catch {
    return x;
  }
};
/**
 * A host as compared: canonical (WHATWG URL: lower case, IPv4 and IPv6 in one form), no trailing dot,
 * every loopback address one name (`127.0.0.0/8`, `::1`, `::ffff:127.x`, `localhost`, unspecified).
 * An empty host stays empty: it names no endpoint.
 */
function normHost(h) {
  let x = decodeSafe(String(h)).trim().replace(/^\[(.*)\]$/, "$1").replace(/\.+$/, "");
  if (!x) return "";
  try {
    x = new URL(`http://${net.isIP(x) === 6 ? `[${x}]` : x}/`).hostname.replace(/^\[(.*)\]$/, "$1");
  } catch {
    x = x.toLowerCase();
  }
  const loop = x === "localhost" || x.endsWith(".localhost") || /^127\./.test(x) || x === "0.0.0.0" || x === "::" || x === "::1" || /^::ffff:(7f[0-9a-f]{2}:|127\.)/.test(x);
  return loop ? "loopback" : x;
}

/**
 * The paths a file or socket value may name (`sqlite:…`, `jdbc:sqlite:…`, `file:…`, `unix:…`,
 * `<scheme>+unix:…`, or a bare `/…`, `./…`, `../…` path), or null. `sqlite:///x` has two readings —
 * SQLAlchemy's, `x` relative (the third slash ends the empty host), and others', `/x` absolute — and
 * both are returned, so a check refuses when either hits. `file://<host>/p` is `/p` (RFC 8089).
 */
function filePaths(raw) {
  const v = String(raw).trim().replace(/^jdbc:/i, "");
  const m = v.match(/^([a-z][a-z0-9+.-]*):(.*)$/i);
  if (m && (/^sqlite/i.test(m[1]) || /\+unix$/i.test(m[1]) || /^(file|unix)$/i.test(m[1]))) {
    const rest = m[2].replace(/[?#].*$/, "");
    let out;
    if (!rest.startsWith("//")) out = [rest];
    else if (/^sqlite/i.test(m[1])) {
      const after = rest.slice(2).replace(/^[^/]*\/?/, "");
      out = after.startsWith("/") ? [after] : [after, `/${after}`];
    } else if (/^file$/i.test(m[1])) out = [rest.slice(2).replace(/^[^/]*/, "")];
    else out = [rest.slice(2)];
    out = out.map(decodeSafe).filter((p) => p && p !== "/");
    return out.length ? out : null;
  }
  return /^(\/|\.\.?\/)/.test(v) && !v.includes(":") ? [v] : null;
}

/**
 * Schemes whose client reads a missing host as the local server (libpq: its default socket; MySQL:
 * localhost), so an empty host, or a libpq socket directory, is a loopback endpoint on the default port.
 */
const LOCAL_BY_DEFAULT = new Set(["postgresql", "mysql", "mariadb"]);

/**
 * A connection string as a service: {scheme, hosts: [{host, port}], full, ports, databases}, or null.
 * Understands URLs (`jdbc:` stripped; a `+driver` suffix dropped; `postgres` = `postgresql`, `mysql2` =
 * `mysql`) and libpq DSNs (`host=… port=… dbname=…`). Hosts are normalised (`normHost`; an empty one
 * is loopback for LOCAL_BY_DEFAULT schemes), default ports filled in, the path percent-decoded; user,
 * password and the rest of the query are not part of the service.
 */
function service(raw) {
  const v = String(raw).trim().replace(/^jdbc:/i, "");
  const url = v.match(/^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(\?[^#]*)?/i);
  let scheme;
  let hosts;
  let databases = [];
  let extraPorts = [];
  if (url) {
    scheme = url[1].toLowerCase().replace(/\+.*$/, "").replace(/^postgres$/, "postgresql").replace(/^mysql2$/, "mysql");
    hosts = url[2].slice(url[2].lastIndexOf("@") + 1).split(",").map((h) => {
      const m = h.match(/^\[([^\]]*)\](?::(\d+))?$/) || h.match(/^([^:]*)(?::(\d+))?$/) || [null, h, undefined];
      return { host: m[1], port: m[2] ? Number(m[2]) : undefined };
    });
    const segment = url[3].split("/").filter(Boolean)[0];
    if (segment) databases.push(decodeSafe(segment));
    const q = new URLSearchParams((url[4] || "").slice(1));
    for (const k of ["dbname", "database"]) if (q.get(k)) databases.push(q.get(k));
    if (q.get("port")) extraPorts = q.get("port").split(",").map(Number);
    const qHosts = (q.get("host") || "").split(",").filter(Boolean);
    // With no host before the path, the query's host and port are the endpoint (libpq's `?host=/socket/dir`).
    if (hosts.every((h) => !h.host)) hosts = (qHosts.length ? qHosts : [""]).map((h, i) => ({ host: h, port: hosts[i]?.port ?? hosts[0].port ?? extraPorts[i] ?? extraPorts[0] }));
    else hosts.push(...qHosts.map((h) => ({ host: h, port: undefined })));
  } else if (/^[a-z_]+\s*=/i.test(v) && /\b(host|hostaddr|port|dbname)\s*=/i.test(v)) {
    const kv = {};
    for (const [, k, q1, bare] of v.matchAll(/([a-z_]+)\s*=\s*(?:'((?:[^'\\]|\\.)*)'|(\S*))/gi)) kv[k.toLowerCase()] = q1 !== undefined ? q1.replace(/\\(.)/g, "$1") : bare;
    scheme = "postgresql";
    const ports = String(kv.port ?? "").split(",");
    hosts = String(kv.host ?? kv.hostaddr ?? "").split(",").map((h, i) => ({ host: h, port: ports[i] ? Number(ports[i]) : ports[0] ? Number(ports[0]) : undefined }));
    if (kv.dbname) databases = [kv.dbname];
  } else return null;
  const bare = (h) => decodeSafe(String(h ?? "")).trim();
  const localByDefault = LOCAL_BY_DEFAULT.has(scheme);
  // A client left to its defaults: no host (the local server), or no port (the default one).
  const hostless = localByDefault && hosts.some((h) => !bare(h.host));
  const portless = localByDefault && hosts.some((h) => h.port === undefined);
  hosts = hosts.map((h) => ({ host: localByDefault && (!bare(h.host) || bare(h.host).startsWith("/")) ? "loopback" : normHost(h.host), port: h.port ?? DEFAULT_PORTS[scheme] }));
  const path = url ? decodeSafe(url[3]).replace(/\/+$/, "") : databases[0] ? `/${databases[0]}` : "";
  return {
    scheme,
    hosts,
    full: `${scheme}://${hosts.map((h) => `${h.host}:${h.port ?? ""}`).sort().join(",")}${path}`,
    ports: [...hosts.map((h) => h.port).filter((p) => p !== undefined), ...extraPorts],
    databases,
    hostless,
    portless,
    dbPath: path,
  };
}

/**
 * `svc` (from service) with each host passed through `alias` (a name that resolves only to loopback
 * becomes `loopback`), its `full` form rebuilt to match; `svc` itself when nothing changed.
 */
function aliased(svc, alias) {
  if (!svc || !svc.hosts.some((h) => alias(h.host) !== h.host)) return svc;
  const hosts = svc.hosts.map((h) => ({ ...h, host: alias(h.host) }));
  return { ...svc, hosts, full: `${svc.scheme}://${hosts.map((h) => `${h.host}:${h.port ?? ""}`).sort().join(",")}${svc.dbPath}` };
}

/** Every host name (not an address, not loopback) the values of `vars` name, as normHost writes it. */
function hostNames(vars) {
  const out = new Set(splitEndpoints(vars).map((s) => s.host));
  for (const v of Object.values(vars)) {
    if (v === null || v === undefined || filePaths(v)) continue;
    const svc = service(v);
    if (svc) svc.hosts.forEach((h) => out.add(h.host));
  }
  return [...out].filter((h) => h && h !== "loopback" && !net.isIP(h) && /[a-z]/i.test(h));
}

/** The variables of each env file of the owner's (`.env`, `.env.local`, `guard.envFiles`) that exists: [{file, vars}]. */
function ownerEnvFiles(main, contract) {
  const guard = (contract && contract.guard) || {};
  const out = [];
  for (const f of [".env", ".env.local", ...(guard.envFiles ?? [])]) {
    try {
      out.push({ file: f, vars: parseEnvFile(fs.readFileSync(path.join(main, f), "utf8")) });
    } catch {
      // not there
    }
  }
  return out;
}

/** `host:port` for each host that has both (an endpoint without either never matches), minus `exempt`. */
const endpointsOf = (hosts, exempt = () => false) => hosts.filter((h) => h.host && h.port !== undefined && !exempt(h.host)).map((h) => `${h.host}:${h.port}`);

/**
 * Endpoints given as separate variables sharing a prefix: `X_HOST` + `X_PORT`, `PGHOST` + `PGPORT`
 * (libpq's default 5432 when PGPORT is unset); with `barePorts`, also a `*PORT` with no host beside it
 * (a loopback endpoint) → [{key, host, port}].
 */
function splitEndpoints(vars, { barePorts = false } = {}) {
  const out = [];
  const portOf = (raw) => (/^\d+$/.test(String(raw ?? "").trim()) ? Number(String(raw).trim()) : undefined);
  for (const [key, raw] of Object.entries(vars)) {
    const m = key.match(/^(.*?)(_?)HOST$/i);
    if (!m || !m[1]) continue;
    const host = String(raw).trim();
    if (!host || /[/=\s]/.test(host.replace(/,/g, ""))) continue;
    const port = portOf(vars[`${m[1]}${m[2]}PORT`] ?? vars[`${m[1]}${m[2] ? "" : "_"}PORT`]) ?? (/^PG$/i.test(m[1]) ? 5432 : undefined);
    if (port === undefined) continue;
    for (const h of host.split(",")) out.push({ key, host: normHost(h), port });
  }
  if (barePorts) {
    for (const [key, raw] of Object.entries(vars)) {
      const m = key.match(/^(.*?)(_?)PORT$/i);
      const port = portOf(raw);
      if (!m || port === undefined) continue;
      const hasHost = [`${m[1]}${m[2]}HOST`, `${m[1]}HOST`, `${m[1]}_HOST`].some((k) => k !== key && k in vars);
      if (!hasHost) out.push({ key, host: "loopback", port });
    }
  }
  return out;
}

/** Client variables of libpq and MySQL that take their host from another variable, or else from the local server. */
const CLIENT_DEFAULTS = [
  { host: ["PGHOST", "PGHOSTADDR"], keys: ["PGDATABASE", "PGUSER", "PGPASSWORD", "PGPORT"] },
  { host: ["MYSQL_HOST"], keys: ["MYSQL_PWD", "MYSQL_TCP_PORT"] },
];

/** Variable names that hold a database name (`PGDATABASE`, `*_DB`, `*DATABASE*`, `*_DB_NAME`, `*_DBNAME`). */
const NAMES_DATABASE = /(^PGDATABASE$|DATABASE|_DB$|_DB_NAME$|_DBNAME$)/i;

/**
 * Names and addresses by which a container reaches the Docker host, so the owner's services on it:
 * Docker Desktop's and Podman's host names, Compose's `host-gateway`, the gateway of a Docker bridge
 * network (`172.16-31.0.1`) and Docker Desktop's host network (`192.168.65.0/24`). A heuristic: a
 * custom bridge subnet escapes it (spec §8, known limits).
 */
function dockerHost(h) {
  const x = normHost(h);
  return /^(host|gateway)\.docker\.internal$|^docker\.for\.(mac|win)\.(localhost|host\.internal)$|^host\.containers\.internal$|^host\.lima\.internal$|^host-gateway$/.test(x) || /^172\.(1[6-9]|2\d|3[01])\.0\.1$/.test(x) || /^192\.168\.65\.\d+$/.test(x);
}

/**
 * What the repo's env files name (`.env`, `.env.local`, the contract's `guard.envFiles`; read here,
 * never printed): service endpoints, full http(s) URLs, and the real paths of files and sockets.
 */
function readOwner(main, contract, alias = (h) => h) {
  const guard = (contract && contract.guard) || {};
  const o = { realMain: fs.realpathSync.native(main), files: [".env", ".env.local", ...(guard.envFiles ?? [])], endpoints: new Set(), full: new Set(), paths: new Set(), pg: guard.postgres || { ports: [], databases: [] } };
  for (const { vars } of ownerEnvFiles(main, contract)) {
    for (const v of Object.values(vars)) {
      const files = filePaths(v);
      if (files) {
        for (const file of files) o.paths.add(resolveLink(path.resolve(o.realMain, file)));
        continue;
      }
      const svc = aliased(service(v), alias);
      if (!svc) continue;
      endpointsOf(svc.hosts).forEach((e) => o.endpoints.add(e));
      o.full.add(svc.full);
    }
    for (const s of splitEndpoints(vars)) o.endpoints.add(`${alias(s.host)}:${s.port}`);
  }
  return o;
}

/**
 * The comparison of `up` step 6 for one scope of values (refusals name `<label>.<key>`, never a value):
 * `vars` is every variable in effect, `own` the ones this scope sets (defaults to `vars`). In a
 * `container` scope (a Compose service's environment, command or entrypoint), loopback is the
 * container's own and paths are the container's, so neither is compared; a host that is the Docker
 * host (dockerHost) is refused unless on one of `runPorts`.
 */
function scopeChecker(o, { worktree, allowOrigins = [], composeServices = [], runPorts = [], alias = (h) => h }) {
  const allowed = new Set();
  for (const x of allowOrigins) {
    try {
      allowed.add(new URL(x).origin);
    } catch {
      // validateLive refuses a bad origin
    }
  }
  const own = new Set(composeServices.map((x) => String(x).toLowerCase()));
  const exempt = (host) => !host.includes(".") && !host.includes(":") && host !== "loopback" && own.has(host);
  const reaches = `points at a service the repo's env files name (${o.files.join(", ")}); it would reach the owner's service`;
  const ports = new Set(runPorts.map(Number));
  const toHost = (key, h) => new Error(`refused: ${key} reaches the Docker host (${h}) on a port that is not the run's; the container would reach the owner's services`);
  return (label, vars, { own: mine = vars, container = false } = {}) => {
    for (const s0 of splitEndpoints(vars, { barePorts: !container })) {
      if (!(s0.key in mine)) continue;
      const s = { ...s0, host: alias(s0.host) };
      const key = `${label}.${s.key}`;
      if (container) {
        if (s.host === "loopback") continue;
        if (dockerHost(s.host) && !ports.has(s.port)) throw toHost(key, s.host);
      }
      if (endpointsOf([s], exempt).some((e) => o.endpoints.has(e))) throw new Error(`refused: ${key} ${reaches}`);
      if (!container && o.pg.ports.includes(s.port)) throw new Error(`refused: ${key} names port ${s.port}, which guard.postgres protects`);
    }
    for (const [k, raw] of Object.entries(mine)) {
      if (raw === null || raw === undefined) continue;
      const key = `${label}.${k}`;
      const v = String(raw).trim();
      if (container && dockerHost(v)) throw toHost(key, normHost(v));
      if (/^\d+$/.test(v)) {
        if (!container && o.pg.ports.includes(Number(v))) throw new Error(`refused: ${key} names port ${v}, which guard.postgres protects`);
        continue;
      }
      if (!container && NAMES_DATABASE.test(k) && o.pg.databases.includes(v)) throw new Error(`refused: ${key} names database ${v}, which guard.postgres protects`);
      const files = filePaths(v);
      if (files) {
        if (container) continue;
        for (const file of files) {
          const real = resolveLink(path.resolve(worktree, file));
          if (real === null || within(o.realMain, real)) throw new Error(`refused: ${key} points into the main checkout`);
          if (o.paths.has(real)) throw new Error(`refused: ${key} points at a file or socket the repo's env files name (${o.files.join(", ")})`);
        }
        continue;
      }
      const svc = aliased(service(v), alias);
      if (!svc) continue;
      const hosts = container ? svc.hosts.filter((h) => h.host !== "loopback") : svc.hosts;
      if (container) for (const h of hosts) if (dockerHost(h.host) && !ports.has(h.port)) throw toHost(key, h.host);
      if (HTTP.has(svc.scheme)) {
        let origin = null;
        try {
          origin = new URL(v).origin;
        } catch {
          origin = null;
        }
        const loopback = svc.hosts.length > 0 && svc.hosts.every((h) => h.host === "loopback");
        const same = container ? hosts.length > 0 && o.full.has(svc.full) : o.full.has(svc.full) || (loopback && endpointsOf(svc.hosts).some((e) => o.endpoints.has(e)));
        if (same && !allowed.has(origin)) throw new Error(`refused: ${key} ${reaches} (list its origin in allow_origins if it is meant to)`);
      } else if (endpointsOf(hosts, exempt).some((e) => o.endpoints.has(e))) throw new Error(`refused: ${key} ${reaches}`);
      if (container) continue;
      const port = svc.ports.find((p) => o.pg.ports.includes(p));
      if (port !== undefined) throw new Error(`refused: ${key} names port ${port}, which guard.postgres protects`);
      const db = svc.databases.find((d) => o.pg.databases.includes(d));
      if (db !== undefined) throw new Error(`refused: ${key} names database ${db}, which guard.postgres protects`);
      if (svc.hostless) throw new Error(`refused: ${key} leaves its host to the client's default (the local server); name its host and port`);
      if (svc.portless) throw new Error(`refused: ${key} leaves its port to the client's default; name it`);
    }
    // 3: a libpq or MySQL client variable with no host beside it (`PGDATABASE` without `PGHOST`).
    if (!container) {
      for (const g of CLIENT_DEFAULTS) {
        if (g.host.some((h) => String(vars[h] ?? "").trim())) continue;
        const k = g.keys.find((x) => x in mine);
        if (k) throw new Error(`refused: ${label}.${k} leaves its host to the client's default (the local server); set ${g.host[0]} too`);
      }
    }
  };
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

/**
 * Host names in `varsList` that `lookup` (all addresses) resolves to loopback only, as an alias
 * function (name → `loopback`): `db.localtest.me` must not slip past the loopback comparison. A name
 * that does not resolve, or reaches any other address, stays a name.
 */
async function loopbackAliases(varsList, lookup) {
  const names = [...new Set(varsList.flatMap(hostNames))];
  const loop = new Set();
  await Promise.all(
    names.map(async (h) => {
      try {
        const addrs = await lookup(h);
        if (Array.isArray(addrs) && addrs.length && addrs.every((a) => normHost(a.address) === "loopback")) loop.add(h);
      } catch {
        // unresolved: a name compared as a name
      }
    }),
  );
  return (h) => (loop.has(h) ? "loopback" : h);
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
    if (record) record.exited = true;
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

/** The files `docker compose` reads by itself in a project directory, in the order it prefers them. */
const COMPOSE_FILES = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];
/** A Compose file's name: `compose*.y*ml` or `docker-compose*.y*ml` (not `composer.yaml`). */
const COMPOSE_NAME = /^(docker-)?compose([._-][^/]*)?\.ya?ml$/i;
/** Compose's global flags that make a command read other files, or act on another project, than the check saw. */
const COMPOSE_ESCAPES = new Set(["-p", "--project-name", "-f", "--file", "--project-directory", "--env-file"]);
/** Compose's global flags that take a value (the next word, unless written `--flag=value`). */
const COMPOSE_VALUED = new Set([...COMPOSE_ESCAPES, "--profile", "--ansi", "--parallel", "--progress"]);
/** Capabilities a service may add: none of them reaches beyond its own container. */
const CAPS_OK = new Set(["NET_BIND_SERVICE", "CHOWN", "SETUID", "SETGID", "DAC_OVERRIDE", "FOWNER"]);
/** Socket names of a container runtime or a datastore, wherever they lie. */
const SOCKET_NAME = /^((docker|containerd|podman|containerd-shim[^/]*)\.sock|\.s\.PGSQL\.\d+|mysql[^/]*\.sock|mysqld[^/]*\.sock|redis[^/]*\.sock|mongodb-\d+\.sock|memcached[^/]*\.sock)$/i;

/**
 * Where container runtimes and local datastores keep their sockets: a bind mount of one, or of a
 * directory holding one, hands the container the owner's daemon or data.
 */
function knownSockets(env = {}) {
  const home = process.env.HOME || os.homedir();
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const list = [
    "/var/run/docker.sock", "/run/docker.sock", "/var/run/containerd/containerd.sock", "/run/containerd/containerd.sock",
    "/var/run/podman/podman.sock", "/run/podman/podman.sock", `/run/user/${uid}/docker.sock`, `/run/user/${uid}/podman/podman.sock`,
    `${home}/.docker/run/docker.sock`, `${home}/.docker/desktop/docker.sock`, `${home}/.colima/default/docker.sock`, `${home}/.rd/docker.sock`, `${home}/.orbstack/run/docker.sock`,
    "/tmp/.s.PGSQL.5432", "/var/run/postgresql/.s.PGSQL.5432", "/run/postgresql/.s.PGSQL.5432", "/tmp/mysql.sock", "/var/run/mysqld/mysqld.sock", "/run/mysqld/mysqld.sock",
    "/var/run/redis/redis.sock", "/run/redis/redis.sock", "/var/run/redis/redis-server.sock", "/run/redis/redis-server.sock",
  ];
  const m = String(env.DOCKER_HOST || "").match(/^unix:\/\/(\/.+)$/);
  if (m) list.push(m[1]);
  return [...new Set(list.flatMap((s) => [s, resolveLink(s)]).filter(Boolean))];
}

/** Where Docker Desktop and other runtimes keep their sockets: any `*.sock` under one is the runtime's. */
function dockerRunDirs() {
  const home = process.env.HOME || os.homedir();
  const dirs = [`${home}/.docker/run`, `${home}/.docker/desktop`, `${home}/Library/Containers/com.docker.docker/Data`, `${home}/.colima`, `${home}/.rd`, `${home}/.orbstack/run`, "/var/run/docker", "/run/docker", "/var/run/containerd", "/run/containerd", "/var/run/podman", "/run/podman"];
  return [...new Set(dirs.flatMap((d) => [d, resolveLink(d)]).filter(Boolean))];
}

/**
 * Why a host path a container would get (a bind mount, a local volume's device) is refused, or null:
 * it lies inside <MAIN> (outside the `exempt` directories: linked worktrees, which are not the main
 * checkout) or holds it, or (outside the worktree `root`) it is a container runtime or datastore socket
 * or a directory holding one.
 */
function hostPathRefusal(source, { worktree, root, realMain, sockets, exempt = [] }) {
  const raw = path.resolve(worktree, String(source));
  const real = resolveLink(raw);
  const inMain = real !== null && within(realMain, real) && !exempt.some((d) => within(d, real));
  if (real === null || inMain || within(real, realMain)) return "a path inside the main checkout (or one holding it)";
  if (within(root, real)) return null; // the run's own
  const runDirs = dockerRunDirs();
  const runtime = (p) => SOCKET_NAME.test(path.basename(p)) || sockets.some((s) => within(p, s)) || runDirs.some((d) => within(p, d) || (within(d, p) && p.endsWith(".sock")));
  if ([raw, real].some(runtime)) return "a container runtime or datastore socket, or a directory holding one";
  return null;
}

/** A shell command's simple commands as word lists: enough to find a flag, not a parser. */
const shellWords = (cmd) =>
  String(cmd)
    .split(/&&|\|\||[;&|\n()]/)
    .map((s) => s.trim().split(/\s+/).filter(Boolean));

/** Every command of the config, as [where, words[][]]: argv lists are one command each, shell fields split. */
function commandsOf(config) {
  const out = [];
  (config.setup ?? []).forEach((argv, i) => out.push([`setup[${i}]`, [argv.map(String)]]));
  for (const k of ["facts", "mail"]) if (config[k] && Array.isArray(config[k].argv)) out.push([`${k}.argv`, [config[k].argv.map(String)]]);
  for (const [n, t] of Object.entries(config.triggers ?? {})) if (t && Array.isArray(t.argv)) out.push([`triggers.${n}.argv`, [t.argv.map(String)]]);
  for (const k of ["store_check", "reset"]) if (typeof config[k] === "string") out.push([k, shellWords(config[k])]);
  for (const e of config.start ?? []) {
    for (const [k, v] of [["cmd", e.cmd], ["stop", e.stop], ["health.cmd", e.health && e.health.cmd]]) if (typeof v === "string") out.push([`start.${e.name}.${k}`, shellWords(v)]);
  }
  for (const [r, role] of Object.entries(config.roles ?? {})) if (role && role.login && typeof role.login.command === "string") out.push([`roles.${r}.login.command`, shellWords(role.login.command)]);
  return out;
}

/**
 * Why one simple command (`raw` words) would run Docker past the check, or null: it sets or unsets a
 * COMPOSE_* or DOCKER_* variable; it runs `docker` other than `docker compose`; or its `docker compose`
 * / `docker-compose` passes COMPOSE_ESCAPES, or a variable, before the subcommand. Quotes and
 * backslashes are dropped first, as the shell would.
 */
function dockerEscape(raw) {
  const words = raw.map((w) => w.replace(/['"\\]/g, ""));
  const base = (w) => w.split("/").pop();
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const set = w.match(/^((?:COMPOSE|DOCKER)_[A-Za-z0-9_]*)=/);
    if (set) return `sets ${set[1]}`;
    if (w === "unset") {
      const v = words.slice(i + 1).find((x) => /^(COMPOSE|DOCKER)_/.test(x));
      if (v) return `unsets ${v}`;
    }
    let j;
    if (base(w) === "docker-compose") j = i + 1;
    else if (base(w) === "docker" && i + 1 < words.length) {
      if (words[i + 1] !== "compose") return `runs docker ${words[i + 1]}; only docker compose runs under the check`;
      j = i + 2;
    } else continue;
    for (; j < words.length; j++) {
      if (/[$`]/.test(raw[j])) return "passes a variable where docker compose reads its flags";
      const t = words[j];
      if (!t.startsWith("-")) break;
      const flag = /^-[pf]./.test(t) ? t.slice(0, 2) : t.split("=")[0];
      if (COMPOSE_ESCAPES.has(flag)) return `passes ${flag} to docker compose`;
      if (COMPOSE_VALUED.has(flag) && !t.includes("=")) j++;
    }
  }
  return null;
}

/** Every file the worktree tracks (`git ls-files`), as paths from its root. */
function gitFiles(worktree, runner) {
  const r = runner(["git", "-C", worktree, "ls-files", "-z"]);
  if (r.error || r.status !== 0) throw new Error(`failed: git ls-files in ${worktree}: ${tail((r.error && r.error.message) || r.stderr)}`);
  return r.stdout.split("\0").filter(Boolean);
}

/** Every Compose file in the worktree: tracked at any depth, and the default names at its root. */
function composeFiles(worktree, runner) {
  const tracked = gitFiles(worktree, runner).filter((f) => COMPOSE_NAME.test(path.posix.basename(f)));
  const root = COMPOSE_FILES.filter((f) => fs.existsSync(path.join(worktree, f)));
  return [...new Set([...tracked, ...root])];
}

/** A directory's Compose files in the order Compose merges them: default names, then overrides, then the rest. */
const composeOrder = (a, b) => {
  const rank = (f) => (COMPOSE_FILES.includes(f) ? COMPOSE_FILES.indexOf(f) : /^(docker-)?compose\.override\./i.test(f) ? 10 : 20);
  return rank(a) - rank(b) || a.localeCompare(b);
};

/**
 * `up` step 5's Compose check (spec §8 step 5).
 * 1. No command of `config` may set or unset a COMPOSE_* or DOCKER_* variable, run `docker` other than
 *    `docker compose`, or pass Compose a project, file, project directory or env file of its own (or a
 *    variable where its flags go): the check would not see what it runs.
 * 2. The Compose files checked: `config.compose_files` when set (each tracked; merged in their order
 *    from the worktree's root), else the COMPOSE_FILE the instance env (or a tracked `.env`) sets (read
 *    as Compose reads it, at the root), else every Compose file — tracked at any depth, or a default
 *    name at the root — one `config` per directory, a refusal then saying to list `compose_files`
 *    (fail closed; files used only by commands or scripts are left to the runtime gate). None may name
 *    a path inside <MAIN> (an `env_file`, `extends` or `include` read from the owner's checkout).
 * 3. `docker compose [-f <file>…] --profile * config --format json` runs in each such directory under
 *    the instance env, and every project must share nothing with the owner's
 *    stack: named COMPOSE_PROJECT_NAME; no `container_name`; only this run's ports published (never a
 *    random one); no `network_mode` host, bridge or `container:`; no `pid`/`ipc`/`cgroup` host or
 *    `container:`, no `uts`/`userns_mode` host; no `volumes_from` a container; not privileged, no
 *    devices, no capability outside CAPS_OK; no bind mount or local volume device inside <MAIN> (or
 *    holding it) or at a runtime or datastore socket (or a directory holding one); no secret, config or
 *    build context read from <MAIN>; no `extra_hosts` to the Docker host; no network or volume external
 *    or named outside the project; and each service's environment, command and entrypoint pass
 *    checkStore's comparison (as a container: its loopback is its own, the Docker host is refused off
 *    the run's ports).
 * Docker missing or failing is a refusal. Returns {services, published}: the service names of every
 * project (checkStore's `composeServices`) and the host ports they publish (all of them the run's: a
 * listener there is the Docker daemon's, not a process of the run); both [] without a Compose file.
 */
export function checkCompose({ worktree, env, ports = {}, main, config = {}, contract = null, secrets = {}, runner = run }) {
  for (const [where, commands] of commandsOf(config)) {
    for (const words of commands) {
      const why = dockerEscape(words);
      if (why) throw new Error(`refused: ${where} ${why}; the check sees only the Compose files and project the env gives (COMPOSE_FILE, COMPOSE_PROFILES; COMPOSE_PROJECT_NAME, DOCKER_CONFIG and DOCKER_HOST are the run's)`);
    }
  }
  const realMain = fs.realpathSync.native(main);
  let dotenv = {};
  try {
    dotenv = parseEnvFile(fs.readFileSync(path.join(worktree, ".env"), "utf8"));
  } catch {
    // no .env tracked
  }
  let scan;
  let runs;
  let hint = "";
  const listed = Array.isArray(config.compose_files) && config.compose_files.length ? config.compose_files : null;
  const composeFile = env.COMPOSE_FILE || dotenv.COMPOSE_FILE;
  if (listed) {
    const tracked = new Set(gitFiles(worktree, runner));
    for (const f of listed) if (!tracked.has(f)) throw new Error(`refused: compose_files names ${f}, which the worktree does not track`);
    scan = listed;
    runs = [{ what: `${listed[0]} (compose_files) is in the worktree`, cwd: worktree, args: listed.flatMap((f) => ["-f", f]) }];
  } else if (composeFile) {
    scan = String(composeFile).split(env.COMPOSE_PATH_SEPARATOR || dotenv.COMPOSE_PATH_SEPARATOR || ":").filter(Boolean);
    for (const f of scan) {
      const real = resolveLink(path.resolve(worktree, f));
      if (real === null || within(realMain, real)) throw new Error(`refused: COMPOSE_FILE names ${f}, inside the main checkout`);
    }
    runs = [{ what: env.COMPOSE_FILE ? "env names COMPOSE_FILE" : "the worktree's .env names COMPOSE_FILE", cwd: worktree, args: [] }];
  } else {
    scan = composeFiles(worktree, runner);
    const byDir = new Map();
    for (const f of scan) {
      const d = path.posix.dirname(f);
      byDir.set(d, [...(byDir.get(d) ?? []), path.posix.basename(f)]);
    }
    runs = [...byDir].map(([d, names]) => {
      const sorted = [...names].sort(composeOrder);
      return { what: `${path.posix.join(d, sorted[0])} is in the worktree`, cwd: path.join(worktree, d), args: sorted.flatMap((n) => ["-f", n]) };
    });
    hint = "; list the files the instance uses in compose_files to check only those";
  }
  if (!runs.length) return { services: [], published: [] };
  try {
    return composeProjects({ worktree, env, ports, main, realMain, config, contract, secrets, runner, scan, runs });
  } catch (e) {
    throw hint && /^refused: /.test(e.message) ? new Error(e.message + hint) : e;
  }
}

/** The forms of <MAIN> a file may spell, and the characters that may follow one where a path ends. */
const MAIN_END = /^($|[/\s"'`,\]}):#)])/;

/** True when `text` (a Compose file in `dir`) names a path inside <MAIN>: spelled out anywhere (a `${VAR:-<path>}` default too), or reached by a path. */
function namesMain(text, dir, main, realMain) {
  for (const m of new Set([path.resolve(main), realMain])) {
    for (let i = text.indexOf(m); i >= 0; i = text.indexOf(m, i + 1)) if (MAIN_END.test(text.slice(i + m.length, i + m.length + 1))) return true;
  }
  for (const m of text.matchAll(/(?<![A-Za-z0-9_.~/])((?:\/|\.\.?\/)[^\s"',\]}#]*)/g)) {
    if (/^\/\//.test(m[1])) continue; // the rest of a URL
    const real = resolveLink(path.resolve(dir, m[1]));
    if (real === null || within(realMain, real)) return true;
  }
  return false;
}

/** checkCompose's steps 2 and 3 over the chosen files: `scan` (paths from the root) and `runs` ({what, cwd, args}). */
function composeProjects({ worktree, env, ports, main, realMain, config, contract, secrets, runner, scan, runs }) {
  for (const f of scan) {
    const file = path.resolve(worktree, f);
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue; // Compose reports a missing file itself
    }
    if (namesMain(text, path.dirname(file), main, realMain)) throw new Error(`refused: ${f} names a path inside the main checkout (Compose would read the owner's file)`);
  }
  const project = env.COMPOSE_PROJECT_NAME;
  const runPorts = new Set(Object.values(ports).map(Number));
  const sockets = knownSockets(env);
  const at = { worktree, root: fs.realpathSync.native(worktree), realMain, sockets };
  const projects = runs.map(({ what, cwd, args }) => {
    const why = `refused: ${what}, but docker compose config could not read it`;
    const r = runner(["docker", "compose", ...args, "--profile", "*", "config", "--format", "json"], { cwd, env, timeout: 60_000 });
    if (r.error || r.status !== 0) throw new Error(`${why}: ${tail(redact((r.error && r.error.message) || r.stderr || `exit ${r.status}`, secrets))}`);
    let c;
    try {
      c = JSON.parse(r.stdout);
    } catch {
      c = null;
    }
    if (!c || typeof c !== "object" || Array.isArray(c)) throw new Error(`${why}: its output is not JSON`);
    if (c.name !== project) throw new Error(`refused: the Compose project is named ${c.name}, not ${project} (COMPOSE_PROJECT_NAME)`);
    return { c, cwd };
  });
  const services = [...new Set(projects.flatMap(({ c }) => Object.keys(c.services ?? {})))];
  const published = new Set();
  const check = scopeChecker(readOwner(main, contract), { worktree, allowOrigins: config.allow_origins, composeServices: services, runPorts: [...runPorts] });
  for (const { c, cwd } of projects) {
    const local = { ...at, worktree: cwd };
    for (const [name, s] of Object.entries(c.services ?? {})) {
      const svc = `refused: Compose service ${name}`;
      if (s.container_name) throw new Error(`${svc} sets container_name (a fixed name collides with, or takes over, the owner's container)`);
      const mode = String(s.network_mode ?? "");
      if (mode === "host" || mode === "bridge" || mode.startsWith("container:")) throw new Error(`${svc} sets network_mode ${mode} (it would share a network the run does not own)`);
      for (const k of ["pid", "ipc", "cgroup", "uts", "userns_mode"]) {
        const v = String(s[k] ?? "");
        if (v === "host" || (["pid", "ipc", "cgroup"].includes(k) && v.startsWith("container:"))) throw new Error(`${svc} sets ${k} ${v} (it would share a namespace the run does not own)`);
      }
      for (const v of s.volumes_from ?? []) if (String(v).startsWith("container:")) throw new Error(`${svc} sets volumes_from ${v} (another container's data)`);
      if (s.privileged) throw new Error(`${svc} is privileged (it could reach the host)`);
      for (const o of s.security_opt ?? []) {
        if (/^(seccomp|apparmor)[:=]unconfined$|^label[:=]disable$|^systempaths=unconfined$/i.test(String(o).replace(/\s+/g, ""))) throw new Error(`${svc} sets security_opt ${o} (it would lift the container's confinement)`);
      }
      if (Array.isArray(s.devices) && s.devices.length) throw new Error(`${svc} maps host devices`);
      for (const cap of s.cap_add ?? []) {
        const n = String(cap).toUpperCase().replace(/^CAP_/, "");
        if (!CAPS_OK.has(n)) throw new Error(`${svc} adds capability ${n} (allowed: ${[...CAPS_OK].join(", ")})`);
      }
      for (const p of s.ports ?? []) {
        if (p.published === undefined || p.published === null || p.published === "") throw new Error(`${svc} publishes container port ${p.target} on a random host port; publish one of this run's ports ({port:<name>})`);
        const m = String(p.published).match(/^(\d+)(?:-(\d+))?$/);
        if (!m) throw new Error(`${svc} publishes host port ${p.published}, which is not one of this run's ports`);
        for (let n = Number(m[1]); n <= Number(m[2] ?? m[1]); n++) {
          if (!runPorts.has(n)) throw new Error(`${svc} publishes host port ${n}, which is not one of this run's ports`);
          published.add(n);
        }
      }
      for (const v of s.volumes ?? []) {
        const no = v.type === "bind" && v.source ? hostPathRefusal(v.source, local) : null;
        if (no) throw new Error(`${svc} bind-mounts ${no}`);
      }
      const ctxs = s.build ? [s.build.context, ...Object.values(s.build.additional_contexts ?? {})] : [];
      for (const x of ctxs) {
        if (typeof x !== "string" || /^[a-z][a-z0-9+.-]*:/i.test(x)) continue; // a URL, git or another image
        const real = resolveLink(path.resolve(cwd, x));
        if (real === null || within(realMain, real)) throw new Error(`${svc} builds from a path inside the main checkout`);
      }
      for (const e of s.extra_hosts ?? []) {
        const [h, ip] = String(e).split(/=|:(?=[^:]*$)/);
        if (ip && (ip.trim() === "host-gateway" || dockerHost(ip))) throw new Error(`${svc} maps ${h} to the Docker host (${ip.trim()})`);
      }
      check(`compose.${name}.environment`, Object.fromEntries(Object.entries(s.environment ?? {}).filter(([, v]) => v !== null && v !== undefined)), { container: true });
      for (const k of ["command", "entrypoint"]) {
        const words = (Array.isArray(s[k]) ? s[k] : []).map(String);
        // Each word, and what follows its first "=" (`--db=<url>`), under the word's index.
        check(`compose.${name}.${k}`, { ...words }, { container: true });
        check(`compose.${name}.${k}`, Object.fromEntries(words.map((w, i) => [i, w.slice(w.indexOf("=") + 1)]).filter(([i, v]) => v !== words[i])), { container: true });
      }
    }
    for (const [kind, all] of [["network", c.networks], ["volume", c.volumes]]) {
      for (const [name, x] of Object.entries(all ?? {})) {
        if (x && x.external) throw new Error(`refused: Compose ${kind} ${name} is external (the project would use one it does not own)`);
        if (x && x.name && !x.name.startsWith(`${project}_`)) throw new Error(`refused: Compose ${kind} ${name} is named ${x.name}, outside the project ${project}`);
        const opts = (x && x.driver_opts) || {};
        if (opts.device && (/\bbind\b/.test(String(opts.o ?? "")) || opts.type === "none")) {
          const no = hostPathRefusal(opts.device, local);
          if (no) throw new Error(`refused: Compose volume ${name} binds ${no}`);
        }
      }
    }
    for (const [kind, all] of [["secret", c.secrets], ["config", c.configs]]) {
      for (const [name, x] of Object.entries(all ?? {})) {
        if (!x || !x.file) continue;
        const real = resolveLink(path.resolve(cwd, x.file));
        if (real === null || within(realMain, real)) throw new Error(`refused: Compose ${kind} ${name} reads a file inside the main checkout`);
      }
    }
  }
  return { services, published: [...published].sort((a, b) => a - b) };
}

/**
 * The daemon's clock now, epoch ms (`docker info`), or null without docker or a running daemon. `up`
 * records it when it starts, as the runtime gate's `since`, so the two clocks never differ.
 */
export function daemonNow({ env, runner = run }) {
  const r = runner(["docker", "info", "--format", "{{json .SystemTime}}"], { env, timeout: 30_000 });
  if (r.error || r.status !== 0) return null;
  let t;
  try {
    t = Date.parse(JSON.parse(r.stdout));
  } catch {
    t = NaN;
  }
  return Number.isFinite(t) ? t : null;
}

/** Container actions on an object the run does not own that the gate refuses (an exec, a stop, a removal, a `docker cp`…). */
const CONTAINER_ACTIONS = new Set(["create", "start", "restart", "kill", "stop", "die", "destroy", "pause", "unpause", "update", "rename", "exec_create", "exec_start", "archive-path", "extract-to-dir"]);

/** The command line a container's healthcheck execs, as `docker events` spells it, or null. */
function healthcheckCmd(c) {
  const t = c && c.Config && c.Config.Healthcheck && c.Config.Healthcheck.Test;
  if (!Array.isArray(t) || t.length < 2) return null;
  if (t[0] === "CMD-SHELL") return `/bin/sh -c ${t.slice(1).join(" ")}`;
  return t[0] === "CMD" ? t.slice(1).join(" ") : null;
}

/** The label Compose puts on every container, volume and network of a project. */
const PROJECT_LABEL = "com.docker.compose.project";

/** The event types the gate judges. */
const EVENT_FILTERS = ["--filter", "type=container", "--filter", "type=volume", "--filter", "type=network"];
/** The name of the events follower's group in run.json. */
const FOLLOWER = "docker-events";

/**
 * Starts the run's events follower (spec §8 step 3): `docker events --since <since - skewMs> --format
 * {{json .}}` for containers, volumes and networks, under the run's env (its Docker client), detached
 * into its own process group recorded in `groups` (so every teardown stops it like any group), its output
 * appended to `<logs>/docker-events.jsonl` (mode 0600). `docker events --since` alone replays only the
 * daemon's last events, so over a long cycle only a follower sees them all. Returns {file, record}.
 */
export async function startEventsFollower({ env, since, logs, cwd, groups = [], skewMs = 1000 }) {
  fs.mkdirSync(logs, { recursive: true, mode: 0o700 });
  const file = path.join(logs, "docker-events.jsonl");
  const args = ["events", "--since", ((since - skewMs) / 1000).toFixed(3), "--format", "{{json .}}", ...EVENT_FILTERS];
  const out = fs.openSync(file, "a", 0o600);
  const err = fs.openSync(path.join(logs, "docker-events.log"), "a", 0o600);
  let child;
  try {
    child = spawn("docker", args, { cwd, env, detached: true, stdio: ["ignore", out, err] });
  } finally {
    fs.closeSync(out);
    fs.closeSync(err);
  }
  await new Promise((ok, fail) => {
    child.once("spawn", ok);
    child.once("error", (e) => fail(new Error(`failed: docker events could not start: ${e.message}`)));
  });
  const record = { name: FOLLOWER, pgid: child.pid, started: startTime(child.pid), cmdline: ["docker", ...args].join(" ") };
  child.once("exit", () => {
    record.exited = true; // from now on, a process holding its pid is not ours
  });
  child.unref();
  groups.push(record);
  return { file, record };
}

/** The follower's events as lines of JSON, and the time of the last one (epoch ms) or null; a torn last line is skipped. */
function followedEvents(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    throw new Error(`refused: the docker events follower's file ${file} cannot be read (${e.code || e.message}); the Docker runtime gate cannot see the whole cycle`);
  }
  const events = [];
  let last = null;
  for (const line of text.split("\n")) {
    let e;
    try {
      e = line.trim() ? JSON.parse(line) : null;
    } catch {
      e = null;
    }
    if (!e || typeof e !== "object") continue;
    events.push(e);
    const t = Number.isFinite(e.timeNano) ? e.timeNano / 1e6 : Number.isFinite(e.time) ? e.time * 1000 : NaN;
    if (Number.isFinite(t)) last = last === null ? t : Math.max(last, t);
  }
  return { events, last };
}

/** The real paths of the repo's linked worktrees (`git worktree list`), <MAIN> itself aside; [] when git cannot tell. */
function linkedWorktrees(main, realMain, runner) {
  const r = runner(["git", "-C", main, "worktree", "list", "--porcelain"]);
  if (r.error || r.status !== 0) return [];
  return String(r.stdout)
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => resolveLink(l.slice("worktree ".length)))
    .filter((p) => p && p !== realMain);
}

/**
 * The Docker runtime gate (spec §8 step 8, and at `renew` and `down`): what the static Compose checks
 * cannot see (a script such as `npm run docker:up`) is seen by what it left on the daemon. `since` is the
 * daemon's clock at `up` (epoch ms; `skewMs` earlier, for its whole-second volume times). The rule:
 * - The run's own objects (labelled `com.docker.compose.project=<COMPOSE_PROJECT_NAME>`; a volume may
 *   instead be a new anonymous one): a container of the run may mount only the run's volumes, join only
 *   the run's networks (or none), bind-mount nothing hostPathRefusal refuses, run unprivileged, and
 *   publish only the run's `ports` (never a random one, nor all with `-P`; asked and bound alike).
 * - An object that existed before `since` and is not the run's (the owner's state) may not be touched:
 *   a container of it started during the cycle, or any action on it in the daemon's events
 *   (CONTAINER_ACTIONS: an exec — other than its own healthcheck —, kill, stop, die, removal, a copy in
 *   or out…; the removal of a volume or network).
 * - An object created during the cycle that is not the run's (a sapu sweep's gate, beside the cycle) is
 *   refused only when it touches the owner's state: a container that mounts a volume that existed before
 *   `since`, joins a network that did (the default bridge and none aside), bind-mounts the main checkout
 *   (a linked worktree inside it is not the main checkout) or a container runtime or datastore socket, or
 *   is privileged; a volume whose device binds such a path. What it does to itself is its own.
 * The events: what the follower (`eventsFile`, startEventsFollower) wrote, however long ago, then a
 * catch-up from the last event it saw (`docker events --since <last> --until <daemon now>`); without a
 * follower, the window from `since`. A `follower` group (its run.json record) that no longer runs leaves
 * the gate blind: refused. Runs docker under `env` (the instance's: its DOCKER_HOST). No docker, or no
 * daemon running, means nothing was created through it. Throws `refused: …` naming the object.
 */
export function checkDockerRuntime({ since, env, main, worktree, ports = {}, runner = run, skewMs = 1000, eventsFile = null, follower = null }) {
  const project = env.COMPOSE_PROJECT_NAME;
  const docker = (args) => runner(["docker", ...args], { env, timeout: 60_000 });
  const failed = (args, r) => new Error(`refused: docker ${args.join(" ")} failed: ${tail((r.error && r.error.message) || r.stderr || `exit ${r.status}`)}`);
  const list = (args) => {
    const r = docker(args);
    if (r.error || r.status !== 0) throw failed(args, r);
    return r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  };
  const inspect = (args, ids) => {
    if (!ids.length) return [];
    const r = docker([...args, ...ids]);
    let j;
    try {
      j = JSON.parse(r.stdout); // an object removed meanwhile makes it exit 1 with the others listed
    } catch {
      j = null;
    }
    if (!Array.isArray(j)) throw failed(args, r);
    return j;
  };
  const ps = ["ps", "-aq", "--no-trunc"];
  const first = docker(ps);
  if (first.error && first.error.code === "ENOENT") return;
  if (!first.error && first.status !== 0 && /cannot connect to the docker daemon|is the docker daemon running/i.test(first.stderr || "")) return;
  if (first.error || first.status !== 0) throw failed(ps, first);
  if (follower) {
    let now;
    try {
      now = membersOf(processTable(runner), follower.pgid, {});
    } catch (e) {
      throw new Error(`refused: the docker events follower cannot be checked (${e.message}); the Docker runtime gate cannot see the whole cycle`);
    }
    if (!now.length || !sameGroup(follower, now)) throw new Error(`refused: the docker events follower (process group ${follower.pgid}) no longer runs; the Docker runtime gate cannot see the whole cycle`);
  }
  const recent = (t) => {
    const ms = Date.parse(t);
    return Number.isFinite(ms) && ms >= since - skewMs;
  };
  const ours = (labels) => Boolean(labels) && labels[PROJECT_LABEL] === project;
  const volumes = inspect(["volume", "inspect"], list(["volume", "ls", "-q"]));
  const networks = inspect(["network", "inspect"], list(["network", "ls", "-q", "--no-trunc"]));
  const volumeByName = new Map(volumes.map((v) => [v.Name, v]));
  const networkByName = new Map(networks.map((n) => [n.Name, n]));
  const volumeOk = (v) => ours(v.Labels) || (Boolean(v.Labels) && "com.docker.volume.anonymous" in v.Labels && recent(v.CreatedAt));
  const runVolumes = new Set(volumes.filter(volumeOk).map((v) => v.Name));
  const runNetworks = new Set(networks.filter((n) => ours(n.Labels)).map((n) => n.Name));
  const realMain = fs.realpathSync.native(main);
  const at = { worktree, root: fs.realpathSync.native(worktree), realMain, sockets: knownSockets(env) };
  let ownerAt = null;
  const forOthers = () => ownerAt ?? (ownerAt = { ...at, exempt: linkedWorktrees(main, realMain, runner) });
  const runPorts = new Set(Object.values(ports).map(Number));
  const containers = inspect(["inspect", "--type", "container"], first.stdout.split("\n").map((s) => s.trim()).filter(Boolean));
  for (const c of containers) {
    const created = recent(c.Created);
    if (!created && !recent(c.State && c.State.StartedAt)) continue;
    const name = String(c.Name || c.Id).replace(/^\//, "");
    const host = c.HostConfig || {};
    if (!ours(c.Config && c.Config.Labels)) {
      if (!created) throw new Error(`refused: container ${name} existed before the cycle, is not the run's, and was started during it`);
      const why = `refused: container ${name}, created during the cycle outside the run's Compose project ${project},`;
      if (host.Privileged) throw new Error(`${why} is privileged`);
      for (const m of c.Mounts ?? []) {
        const v = m.Type === "volume" ? volumeByName.get(m.Name) : null;
        if (m.Type === "volume" && (!v || !recent(v.CreatedAt))) throw new Error(`${why} mounts volume ${m.Name}, which existed before the cycle`);
        const no = m.Type === "bind" ? hostPathRefusal(m.Source, forOthers()) : null;
        if (no) throw new Error(`${why} bind-mounts ${no}`);
      }
      for (const n of Object.keys((c.NetworkSettings && c.NetworkSettings.Networks) || {})) {
        if (n === "bridge" || n === "none") continue;
        const net = networkByName.get(n);
        if (!net || !recent(net.Created)) throw new Error(`${why} joins network ${n}, which existed before the cycle`);
      }
      continue;
    }
    if (host.Privileged) throw new Error(`refused: container ${name} is privileged`);
    if (host.PublishAllPorts) throw new Error(`refused: container ${name} publishes every exposed port on a random host port (-P)`);
    // What was asked (PortBindings) and what the daemon bound (NetworkSettings.Ports; null = exposed, not published).
    const bindings = [host.PortBindings, c.NetworkSettings && c.NetworkSettings.Ports].flatMap((x) => Object.entries(x || {}));
    for (const [target, binds] of bindings) {
      for (const b of binds || []) {
        const p = String((b && b.HostPort) || "");
        if (!p) throw new Error(`refused: container ${name} publishes container port ${target} on a random host port`);
        const m = p.match(/^(\d+)(?:-(\d+))?$/);
        for (let n = Number(m ? m[1] : NaN); m && n <= Number(m[2] ?? m[1]); n++) if (!runPorts.has(n)) throw new Error(`refused: container ${name} publishes host port ${n}, which is not one of this run's ports`);
        if (!m) throw new Error(`refused: container ${name} publishes host port ${p}, which is not one of this run's ports`);
      }
    }
    for (const m of c.Mounts ?? []) {
      if (m.Type === "volume" && !runVolumes.has(m.Name)) throw new Error(`refused: container ${name} mounts volume ${m.Name}, which is not the run's`);
      const no = m.Type === "bind" ? hostPathRefusal(m.Source, at) : null;
      if (no) throw new Error(`refused: container ${name} bind-mounts ${no}`);
    }
    for (const n of Object.keys((c.NetworkSettings && c.NetworkSettings.Networks) || {})) {
      if (n !== "none" && !runNetworks.has(n)) throw new Error(`refused: container ${name} joins network ${n}, which is not the run's`);
    }
  }
  for (const v of volumes) {
    if (!recent(v.CreatedAt) || volumeOk(v)) continue;
    const o = v.Options || {};
    const no = o.device && (/\bbind\b/.test(String(o.o ?? "")) || o.type === "none") ? hostPathRefusal(o.device, forOthers()) : null;
    if (no) throw new Error(`refused: volume ${v.Name}, created during the cycle outside the run's Compose project ${project}, binds ${no}`);
  }
  const followed = eventsFile ? followedEvents(eventsFile) : { events: [], last: null };
  const from = Math.max(since - skewMs, followed.last === null ? -Infinity : followed.last - skewMs);
  const now = daemonNow({ env, runner }) ?? Date.now();
  const evArgs = ["events", "--since", (from / 1000).toFixed(3), "--until", (now / 1000).toFixed(3), "--format", "{{json .}}", ...EVENT_FILTERS];
  const er = docker(evArgs);
  if (er.error || er.status !== 0) throw failed(evArgs, er);
  const events = [...followed.events];
  for (const line of er.stdout.split("\n")) {
    try {
      if (line.trim()) events.push(JSON.parse(line));
    } catch {
      // not an event
    }
  }
  const byId = new Map(containers.map((c) => [c.Id, c]));
  // New during the cycle: created in the window (its create event), or listed with a recent creation time.
  const createdNow = new Set([...events.filter((e) => e.Action === "create").map((e) => e.Actor && e.Actor.ID), ...containers.filter((c) => recent(c.Created)).map((c) => c.Id)]);
  for (const e of events) {
    const id = (e.Actor && e.Actor.ID) || "";
    const a = (e.Actor && e.Actor.Attributes) || {};
    const action = String(e.Action || "");
    const verb = action.split(":")[0].trim();
    if (e.Type === "container") {
      if (!CONTAINER_ACTIONS.has(verb) || a[PROJECT_LABEL] === project || createdNow.has(id)) continue;
      if (verb.startsWith("exec_") && action.slice(action.indexOf(":") + 1).trim() === healthcheckCmd(byId.get(id))) continue;
      throw new Error(`refused: during the cycle, docker ${verb} hit container ${a.name || id}, which existed before it and is not of the run's Compose project ${project}`);
    }
    if (verb !== "destroy") continue;
    const name = e.Type === "network" ? a.name || id : id;
    if (String(name).startsWith(`${project}_`) || createdNow.has(id)) continue;
    throw new Error(`refused: during the cycle, docker destroy hit ${e.Type} ${name}, which existed before it and is not the run's`);
  }
}

/**
 * The endpoints the run may connect to, as `host:port` (hosts as normHost writes them, names not
 * resolved): this run's `ports` on loopback; every non-loopback endpoint `env` and each start entry's
 * env name (a URL or DSN, `X_HOST` + `X_PORT`), and each non-loopback `allow_origins` origin — a
 * loopback endpoint is allowed only on the run's own ports, since the owner's dev servers listen there
 * too; and every endpoint, loopback included, named by a variable `pass_env` passes from the owner's
 * session (an `HTTPS_PROXY`), which the owner has chosen to share.
 */
export function egressAllowed({ config = {}, env = {}, ports = {} }) {
  const out = new Set(Object.values(ports).map((p) => `loopback:${p}`));
  const named = (vars) => {
    const list = splitEndpoints(vars).map((s) => `${s.host}:${s.port}`);
    for (const raw of Object.values(vars)) {
      if (raw === null || raw === undefined || filePaths(raw)) continue;
      const svc = service(raw);
      if (svc) list.push(...endpointsOf(svc.hosts));
    }
    return list;
  };
  const remote = (e) => !e.startsWith("loopback:");
  for (const vars of [env, ...(config.start ?? []).map((e) => e.env ?? {})]) named(vars).filter(remote).forEach((e) => out.add(e));
  for (const o of config.allow_origins ?? []) {
    try {
      const u = new URL(o);
      const e = `${normHost(u.hostname)}:${u.port || DEFAULT_PORTS[u.protocol.slice(0, -1)]}`;
      if (remote(e)) out.add(e);
    } catch {
      // validateLive refuses a bad origin
    }
  }
  const passed = Object.fromEntries((config.pass_env ?? []).filter((k) => env[k] !== undefined).map((k) => [k, env[k]]));
  named(passed).forEach((e) => out.add(e));
  return [...out];
}

/** `addr` (`host:port`, `[v6]:port`) split at its last colon. */
const splitAddr = (addr) => {
  const i = String(addr).lastIndexOf(":");
  return [addr.slice(0, i), addr.slice(i + 1)];
};

/** `host:port` as the egress check compares it: normHost's form, a zone dropped, an IPv4-mapped IPv6 address read as IPv4. */
function endpointKey(host, port) {
  let h = String(host).replace(/^\[(.*)\]$/, "$1").replace(/%.*$/, "");
  const dotted = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (dotted) h = dotted[1];
  h = normHost(h);
  const hex = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const [a, b] = [parseInt(hex[1], 16), parseInt(hex[2], 16)];
    h = `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
  }
  return `${h}:${port}`;
}

/** lsof's verdict: exit 0, or exit 1 (nothing found, or a pid gone) with nothing but warnings on stderr. */
function lsofOk(r) {
  if (r.status === 0) return true;
  if (r.status !== 1) return false;
  return String(r.stderr || "").split("\n").every((l) => !l.trim() || /^lsof: WARNING/.test(l.trim()));
}

/** `lsof -F pcnT` output → [{pid, command, local, remote, listen}]. */
function parseLsof(out) {
  const conns = [];
  let pid;
  let command;
  let cur = null;
  for (const line of out.split("\n")) {
    const [tag, val] = [line[0], line.slice(1)];
    if (tag === "p") pid = Number(val);
    else if (tag === "c") command = val;
    else if (tag === "f") cur = null;
    else if (tag === "n") {
      const [local, remote] = val.split("->");
      cur = { pid, command, local, remote, listen: false };
      conns.push(cur);
    } else if (tag === "T" && cur && val === "ST=LISTEN") cur.listen = true;
  }
  return conns;
}

/** `ss -tanpH` output → the sockets of `want` pids, as parseLsof's. */
function parseSs(out, want) {
  const conns = [];
  for (const line of out.split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f.length < 5) continue;
    const [state, , , local, peer] = f;
    const listen = state === "LISTEN";
    for (const [, command, pid] of line.matchAll(/\("([^"]*)",pid=(\d+)/g)) {
      if (want.has(Number(pid))) conns.push({ pid: Number(pid), command, local, remote: listen || /:\*$/.test(peer) ? undefined : peer, listen });
    }
  }
  return conns;
}

/** The TCP sockets of `pids`: `lsof`, else `ss`; neither → refused. */
function tcpSockets(pids, runner) {
  const l = runner(["lsof", "-nP", "-a", "-iTCP", "-p", pids.join(","), "-FpcnT"]);
  if (!l.error) {
    if (!lsofOk(l)) throw new Error(`failed: lsof exited ${l.status ?? l.signal}: ${tail(l.stderr)}`);
    return parseLsof(l.stdout || "");
  }
  if (l.error.code !== "ENOENT") throw new Error(`failed: lsof: ${l.error.message}`);
  const s = runner(["ss", "-tanpH"]);
  if (s.error && s.error.code === "ENOENT") throw new Error("refused: neither lsof nor ss is available");
  if (s.error || s.status !== 0) throw new Error(`failed: ss: ${(s.error && s.error.message) || `exited ${s.status}: ${tail(s.stderr)}`}`);
  return parseSs(s.stdout || "", new Set(pids));
}

/**
 * `lsof -nP -U -F pcdn` over every process → the unix-socket peers of `want` pids, as [{pid, command,
 * path}]. macOS's lsof names a connected client only by its peer's address (`->0x…`), so the path comes
 * from the socket whose own address (`d`) that is.
 */
function parseLsofUnix(out, want, extra = new Map()) {
  const recs = [];
  let pid;
  let command;
  let cur = null;
  for (const line of out.split("\n")) {
    const [tag, val] = [line[0], line.slice(1)];
    if (tag === "p") pid = Number(val);
    else if (tag === "c") command = val;
    else if (tag === "f") recs.push((cur = { pid, command }));
    else if (tag === "d" && cur) cur.addr = val;
    else if (tag === "n" && cur) cur.name = val.replace(/ type=\S+$/, "");
  }
  const byAddr = new Map(extra);
  for (const r of recs) if (r.addr && r.name && r.name.startsWith("/")) byAddr.set(sockAddr(r.addr), r.name);
  const out2 = [];
  for (const r of recs) {
    if (!want.has(r.pid) || !r.name || !r.name.startsWith("->")) continue;
    const p = byAddr.get(sockAddr(r.name.slice(2)));
    if (p) out2.push({ pid: r.pid, command: r.command, path: p });
  }
  return out2;
}

/** A kernel socket address as lsof (`0x…`) and netstat (bare hex) print it, in one form. */
const sockAddr = (a) => String(a).toLowerCase().replace(/^0x/, "").replace(/^0+(?=.)/, "");

/**
 * `netstat -an -f unix` (macOS, BSD) → {address: path} for every bound socket, every user's: lsof sees
 * only the sockets of processes it may inspect, so a server another user runs is named here. Its
 * Address column is the address lsof prints (checked against lsof on macOS). On macOS a netstat that
 * fails is `failed: …` (another user's server would go unseen); elsewhere, where `-f unix` is not
 * netstat's, it maps nothing.
 */
function netstatUnix(runner) {
  const r = runner(["netstat", "-an", "-f", "unix"]);
  const map = new Map();
  if (r.error || r.status !== 0) {
    if (process.platform !== "darwin") return map;
    throw new Error(`failed: netstat -an -f unix ${r.error ? r.error.message : `exited ${r.status}: ${tail(r.stderr)}`}`);
  }
  for (const line of String(r.stdout || "").split("\n")) {
    const m = line.trim().match(/^([0-9a-f]+)\s+\S+\s+\d+\s+\d+\s+[0-9a-f]+\s+[0-9a-f]+\s+[0-9a-f]+\s+[0-9a-f]+\s+(\/.*)$/i);
    if (m) map.set(sockAddr(m[1]), m[2]);
  }
  return map;
}

/**
 * `ss -xapH` → the unix-socket peers of `want` pids: a client's peer inode is the server socket's own
 * inode, whose line names the path. Abstract names (`@…`) are not paths.
 */
function parseSsUnix(out, want) {
  const lines = [];
  for (const line of out.split("\n")) {
    const m = line.trim().replace(/^u_(str|dgr|seq)\s+/, "").match(/^(\S+)\s+\d+\s+\d+\s+(\S+)\s+(\d+)\s+(\S+)\s+(\d+)(.*)$/);
    if (m) lines.push({ local: m[2], ino: m[3], peerIno: m[5], users: [...m[6].matchAll(/\("([^"]*)",pid=(\d+)/g)].map((u) => ({ command: u[1], pid: Number(u[2]) })) });
  }
  const byIno = new Map(lines.filter((l) => l.local.startsWith("/")).map((l) => [l.ino, l.local]));
  const out2 = [];
  for (const l of lines) {
    const p = byIno.get(l.peerIno);
    if (!p) continue;
    for (const u of l.users) if (want.has(u.pid)) out2.push({ pid: u.pid, command: u.command, path: p });
  }
  return out2;
}

/** The unix-socket peers of `pids` (ss on Linux, lsof elsewhere, the other as a fallback); neither → refused. */
function unixPeers(pids, runner) {
  const want = new Set(pids);
  for (const tool of process.platform === "linux" ? ["ss", "lsof"] : ["lsof", "ss"]) {
    const r = tool === "lsof" ? runner(["lsof", "-nP", "-U", "-Fpcdn"]) : runner(["ss", "-xapH"]);
    if (r.error && r.error.code === "ENOENT") continue;
    if (r.error) throw new Error(`failed: ${tool}: ${r.error.message}`);
    if (tool === "lsof") {
      if (!lsofOk(r)) throw new Error(`failed: lsof exited ${r.status ?? r.signal}: ${tail(r.stderr)}`);
      return parseLsofUnix(r.stdout || "", want, netstatUnix(runner));
    }
    if (r.status !== 0) throw new Error(`failed: ss exited ${r.status}: ${tail(r.stderr)}`);
    return parseSsUnix(r.stdout || "", want);
  }
  throw new Error("refused: neither lsof nor ss is available");
}

/** Where local datastores keep their sockets by default. */
const DATASTORE_SOCKET_DIRS = ["/var/run/postgresql", "/run/postgresql", "/var/run/mysqld", "/run/mysqld", "/var/run/redis", "/run/redis"];

/** The directories the owner's env files name for sockets: a unix URL's or socket path's directory, a libpq socket directory. */
function ownerSocketDirs(main, contract) {
  const dirs = new Set();
  if (!main) return dirs;
  const realMain = fs.realpathSync.native(main);
  const guard = (contract && contract.guard) || {};
  for (const f of [".env", ".env.local", ...(guard.envFiles ?? [])]) {
    let text;
    try {
      text = fs.readFileSync(path.join(main, f), "utf8");
    } catch {
      continue;
    }
    for (const [k, raw] of Object.entries(parseEnvFile(text))) {
      const v = raw.trim();
      const sock = /^([a-z][a-z0-9+.-]*\+)?unix:/i.test(v) || SOCKET_NAME.test(path.basename(v.replace(/[?#].*$/, "")));
      for (const p of filePaths(v) ?? []) {
        if (sock) dirs.add(resolveLink(path.dirname(path.resolve(realMain, p))));
        else if (/HOST|SOCK/i.test(k) && p.startsWith("/")) dirs.add(resolveLink(p));
      }
      const q = v.match(/[?&]host=([^&#]+)/);
      if (q && decodeSafe(q[1]).startsWith("/")) dirs.add(resolveLink(decodeSafe(q[1])));
    }
  }
  dirs.delete(null);
  return dirs;
}

const DATASTORE_SOCKET = /^(\.s\.PGSQL\.\d+|mysql[^/]*\.sock|mysqld[^/]*\.sock|redis[^/]*\.sock|mongodb-\d+\.sock|memcached[^/]*\.sock)$/i;

/**
 * `up` step 8 (and every `renew` and `up --fresh`): sampled `samples` times, `intervalMs` apart, the
 * connections of `pids`, every process of the run's recorded groups whose identity is not someone else's
 * (runPids):
 * - TCP may reach only `allowed` (egressAllowed's endpoints; a host name stands for every address
 *   `lookup` gives it) or another listener of those processes on loopback; a connection they accepted
 *   (its local port is one they listen on) is inbound, not egress;
 * - a unix socket outside `runDirs` may not be a datastore's: a PostgreSQL, MySQL, Redis, MongoDB or
 *   memcached socket name, a socket in a datastore's default directory or in a directory the owner's env
 *   files name for a socket, or any socket inside <MAIN> (`main`; its env files read through `contract`).
 * On the first sample, when `expectListen` names ports, at least one must show as a listener of those
 * processes, or the listing is not trusted (and with no process to list at all, it is not either). Throws `refused: <process> (<pid>) connects to <host:port>`
 * or `… connects to the socket <path>`; neither lsof nor ss → `refused: neither lsof nor ss is
 * available`; an lsof that exits 1 with an error → `failed: …`. Known limits (spec §8): a process that
 * left its group or lives in a container is not listed, and a connection between two samples is not seen.
 */
export async function checkEgress({ pids, allowed = [], runner = run, lookup = (h) => dns.promises.lookup(h, { all: true }), samples = 5, intervalMs = 500, expectListen = [], runDirs = [], main, contract }) {
  const want = [...new Set((pids ?? []).filter((p) => Number.isInteger(p) && p > 0))];
  if (!want.length) {
    // Nothing to list passes everything: only right while no listener is expected.
    if (expectListen.length) throw new Error(`failed: no process of the run is left to list, yet one should serve port ${expectListen.join(", ")}; the listing cannot be trusted`);
    return;
  }
  const ok = new Set();
  for (const a of allowed) {
    const [h, p] = splitAddr(a);
    ok.add(endpointKey(h, p));
    if (h === "loopback" || net.isIP(h.replace(/^\[(.*)\]$/, "$1"))) continue;
    try {
      for (const r of await lookup(h)) ok.add(endpointKey(r.address, p));
    } catch {
      // a name that does not resolve here allows nothing more
    }
  }
  const own = runDirs.map((d) => resolveLink(d)).filter(Boolean);
  const realMain = main ? fs.realpathSync.native(main) : null;
  const dirs = new Set([...DATASTORE_SOCKET_DIRS.map(resolveLink).filter(Boolean), ...ownerSocketDirs(main, contract)]);
  const datastore = (p) => DATASTORE_SOCKET.test(path.basename(p)) || dirs.has(path.dirname(p)) || (realMain !== null && within(realMain, p));
  for (let i = 0; i < samples; i++) {
    if (i) await sleep(intervalMs);
    const sockets = tcpSockets(want, runner);
    const listening = new Set(sockets.filter((s) => s.listen).map((s) => splitAddr(s.local)[1]));
    if (i === 0 && expectListen.length && !expectListen.some((p) => listening.has(String(p)))) {
      throw new Error(`failed: the socket listing shows no listener of the run on ${expectListen.join(", ")}; it cannot be trusted`);
    }
    for (const s of sockets) {
      if (s.listen || !s.remote || listening.has(splitAddr(s.local)[1])) continue;
      const [h, p] = splitAddr(s.remote);
      const key = endpointKey(h, p);
      if (ok.has(key) || (key.startsWith("loopback:") && listening.has(p))) continue;
      throw new Error(`refused: ${s.command} (${s.pid}) connects to ${s.remote}`);
    }
    for (const u of unixPeers(want, runner)) {
      const real = resolveLink(u.path) ?? u.path;
      if (own.some((d) => within(d, real))) continue;
      if (datastore(real)) throw new Error(`refused: ${u.command} (${u.pid}) connects to the socket ${u.path}`);
    }
  }
}

// ---------------------------------------------------------------------------------------------------
// Run files, reaper, down and recovery (spec §8 steps 1 and 11, `down`). `run.json` is the record every
// teardown works from: the groups to kill, the stops to replay, the worktree to remove. The guard reads
// its `worktree` (sapu-guard.mjs liveWorktree).

const runPath = (main) => path.join(liveDir(main), "run.json");

/** Where a run logs: `<MAIN>/.argus/live/<runId>/logs` (kept by `down`, for the owner). */
export function logsDir(main, runId) {
  runIdOk(runId);
  return path.join(liveDir(main), runId, "logs");
}

/** The CLI the reaper runs (`argus-live.mjs reap <runId>`). */
const CLI = fileURLToPath(new URL("./argus-live.mjs", import.meta.url));

/** `ps -o lstart` as macOS and Linux print it under LC_ALL=C (`Thu Oct  8 22:35:29 2026`), spaces collapsed. */
const LSTART = /^([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d\d:\d\d:\d\d\s+\d{4})/;
const C_LOCALE = () => ({ ...process.env, LC_ALL: "C" });

/**
 * Field 22 of a `/proc/<pid>/stat` line (starttime: clock ticks since boot, fixed for the process's life,
 * so no drift), or null. The command name (field 2) is in parentheses and may hold spaces and
 * parentheses itself: the fields are counted from the last `)`.
 */
export function procStartTicks(text) {
  const t = String(text);
  const i = t.lastIndexOf(")");
  if (i < 0) return null;
  const f = t.slice(i + 1).trim().split(/\s+/); // f[0] is field 3
  return /^\d+$/.test(f[19] ?? "") ? f[19] : null;
}

/** On Linux, `ticks:<starttime>` from /proc (preferred: monotonic, unlike lstart, derived from a drifting boot time); else undefined. */
function procStart(pid) {
  if (process.platform !== "linux") return undefined;
  try {
    const t = procStartTicks(fs.readFileSync(`/proc/${pid}/stat`, "utf8"));
    return t ? `ticks:${t}` : undefined;
  } catch {
    return undefined;
  }
}

/**
 * When process `pid` started — on Linux its boot ticks from /proc, else `ps -o lstart=` — or undefined
 * when it is gone or neither tells. With its pid, a process's identity: it survives exec and a changed
 * title, and a reused pid has another start time.
 */
function startTime(pid, runner = run) {
  const ticks = procStart(pid);
  if (ticks) return ticks;
  const r = runner(["ps", "-o", "lstart=", "-p", String(pid)], { env: C_LOCALE() });
  const m = !r.error && r.status === 0 && String(r.stdout).trim().match(LSTART);
  return m ? m[1].replace(/\s+/g, " ") : undefined;
}

/** Every process as {pid, pgid, started, command} (`ps -A -ww -o pid= -o pgid= -o lstart= -o command=`, the same on macOS and Linux; on Linux `started` is the boot ticks from /proc where it can be read, as startTime gives them). */
function processTable(runner) {
  const r = runner(["ps", "-A", "-ww", "-o", "pid=", "-o", "pgid=", "-o", "lstart=", "-o", "command="], { env: C_LOCALE() });
  if (r.error || r.status !== 0) throw new Error(`failed: ps could not list processes: ${(r.error && r.error.message) || tail(r.stderr)}`);
  const out = [];
  for (const line of r.stdout.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    const t = m && m[3].match(LSTART);
    if (t) out.push({ pid: Number(m[1]), pgid: Number(m[2]), started: procStart(Number(m[1])) ?? t[1].replace(/\s+/g, " "), command: m[3].slice(t[0].length).trim() });
  }
  return out;
}

/**
 * True when two recorded start times name the same process start: boot ticks (`ticks:<n>`) only when
 * equal; `ps -o lstart` times when equal or at most 1 s apart (lstart is derived from a boot time that
 * drifts). A reused pid starts far later.
 */
function sameStart(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (String(a).startsWith("ticks:") || String(b).startsWith("ticks:")) return false;
  const [x, y] = [Date.parse(a), Date.parse(b)];
  return Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) <= 1000;
}

/** The processes of group `pgid` in `table`, as recorded: {pid, started, cmdline} (secret values masked). */
const membersOf = (table, pgid, secrets) => table.filter((p) => p.pgid === pgid).map((p) => ({ pid: p.pid, started: p.started, cmdline: redact(p.command, secrets) }));

/** run.json, or null when there is none. Throws `refused: …` on one that cannot be read: it is never guessed at. */
function readRun(main) {
  let raw;
  try {
    raw = fs.readFileSync(runPath(main), "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") return null;
    throw new Error(`refused: cannot read ${runPath(main)}: ${e.message}`);
  }
  let rec;
  try {
    rec = JSON.parse(raw);
  } catch {
    rec = null;
  }
  if (!rec || typeof rec !== "object" || typeof rec.runId !== "string" || !RUN_ID.test(rec.runId)) throw new Error(`refused: ${runPath(main)} is not a run record`);
  return rec;
}

/** Writes run.json whole (beside, then renamed into place), mode 0600: its stop records carry the run's env. Only updateRun calls it. */
function putRun(main, rec) {
  const file = runPath(main);
  fs.mkdirSync(liveDir(main), { recursive: true });
  fs.renameSync(tempBeside(file, `${JSON.stringify(rec, null, 2)}\n`, 0o600), file);
}

/** Blocks this thread for `ms` (updateRun is synchronous: its callers push records from synchronous code). */
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const noLock = (runId) => new Error(`refused: the lock no longer names cycle ${runId}; run.json not written`);

/**
 * The one writer path for run.json: under `claim-<runId>.json` (the lock rule's claim, so a write never
 * interleaves with a `down` removing the lock), re-reads the lock and run.json, runs `fn(prev)` (prev =
 * run.json when it names the run, else null) and writes what it returns: an object is written whole,
 * `null` removes run.json, `undefined` leaves it. Returns the record as it stands after. Throws, writing
 * nothing, when the lock no longer names `runId` (a `down` finished: a write now would leave an orphan
 * run.json), when the record is `closing` (a `down` sealed it: what it did not read it would not kill)
 * unless `sealed` (the teardown's own writes), when run.json is gone and `create` is false (a `down`
 * removed it), and when another process holds the claim past `waitMs` (claimBusy).
 */
export function updateRun(main, runId, fn, { waitMs = 2000, sealed = false, create = true } = {}) {
  runIdOk(runId);
  const end = Date.now() + waitMs;
  for (;;) {
    const l = readLock(main);
    if (!l || l.runId !== runId) throw noLock(runId);
    if (claim(main, runId, { run: runId })) break;
    const busy = claimBusy(main, runId);
    if (!busy.retry || Date.now() >= end) throw busy;
    sleepSync(50);
  }
  try {
    const cur = readLock(main);
    if (!cur || cur.runId !== runId) throw noLock(runId);
    let prev;
    try {
      prev = readRun(main);
    } catch {
      prev = null; // an unreadable record is replaced whole
    }
    if (prev && prev.runId !== runId) prev = null;
    if (prev && prev.closing && !sealed) throw new Error(`refused: cycle ${runId} is being torn down; run.json not written`);
    if (!prev && !create && !sealed) throw new Error(`refused: run.json of cycle ${runId} is gone (a down removed it); not written again`);
    const next = fn(prev);
    if (next === undefined) return prev;
    if (next === null) {
      fs.rmSync(runPath(main), { force: true });
      return null;
    }
    putRun(main, next);
    return next;
  } finally {
    fs.rmSync(claimPath(main, runId), { force: true });
  }
}

/**
 * Each recorded group as `ps` shows it now (`table`, from processTable): `members` = [{pid, started,
 * cmdline}] of every process in it, `cmdline` = its leader's (a field for reports: identity is the pid
 * and start time). A group whose leader is not the process recorded — it exited (`exited`, set by
 * startEntry, runSetup and runStep) or started at another time — while a process holds its pid is left
 * as recorded: that process is someone else's.
 */
function refreshGroups(groups, table, secrets) {
  return groups.map((g) => {
    if (!table || !g) return { ...g };
    const now = membersOf(table, g.pgid, secrets);
    const leader = now.find((p) => p.pid === g.pgid);
    if (!now.length || (leader && (g.exited || (g.started && !sameStart(leader.started, g.started))))) return { ...g };
    return { ...g, started: g.started ?? (leader && leader.started), cmdline: leader ? leader.cmdline : g.cmdline, members: now };
  });
}

/**
 * True when group `g` still runs what was recorded (`now`: its processes, membersOf): its own leader,
 * same pid and start time, or a member with a recorded pid and start time (a setup's daemon, its leader
 * gone). Command lines do not count: they change on exec and with a process title. Every kill of
 * `down` and `recover` asks this first.
 */
function sameGroup(g, now) {
  const leader = now.find((p) => p.pid === g.pgid);
  if (leader && !g.exited && sameStart(leader.started, g.started)) return true;
  return now.some((p) => (g.members ?? []).some((m) => m && m.pid === p.pid && sameStart(m.started, p.started)));
}

/**
 * Writes `<MAIN>/.argus/live/run.json` whole from `state` (its keys and their writers: spec §8 step 11),
 * through updateRun. The `reaper` pid of an earlier write is kept unless `state` names one. `worktree` is
 * the absolute path the guard reads (null until it exists). Groups go through refreshGroups —
 * `/bin/sh -c <one command>` execs that command, so what ps shows is what `down` and recovery can match;
 * without ps they stay as recorded. `create: false` (every write of `up` after its first) refuses to
 * write a run.json a `down` removed.
 */
export function writeRunFiles(main, state, { runner = run, secrets = {}, create = true } = {}) {
  runIdOk(state.runId);
  const wt = state.worktree ?? null;
  if (wt !== null && (typeof wt !== "string" || !path.isAbsolute(wt))) throw new Error("failed: run.json needs the worktree's absolute path");
  let table = null;
  try {
    table = processTable(runner);
  } catch {
    table = null; // the command lines stay as recorded: `down` and recovery then kill fewer groups, never more
  }
  const groups = refreshGroups(state.groups ?? [], table, secrets);
  updateRun(
    main,
    state.runId,
    (prev) => {
      const reaper = state.reaper !== undefined ? state.reaper : prev ? prev.reaper : undefined;
      return { ...state, worktree: wt, ports: state.ports ?? {}, internal: state.internal ?? {}, origins: state.origins ?? [], groups, stops: state.stops ?? [], sessions: state.sessions ?? [], ...(reaper === undefined ? {} : { reaper }) };
    },
    { create },
  );
}

/**
 * Starts the run's reaper: `argus-live.mjs reap <runId>`, detached, in <MAIN>; its pid goes into
 * run.json as `reaper` (when run.json names the run). Returns the pid.
 */
export function startReaper(main, runId, { script = CLI } = {}) {
  runIdOk(runId);
  readRun(main); // an unreadable run.json is refused before anything starts
  const child = spawn(process.execPath, [script, "reap", runId], { cwd: main, detached: true, stdio: "ignore" });
  child.on("error", () => {});
  if (!child.pid) throw new Error("failed: the reaper could not start");
  child.unref();
  try {
    updateRun(main, runId, (prev) => (prev ? { ...prev, reaper: child.pid } : undefined));
  } catch (e) {
    // Unrecorded, no `down` would stop it: it goes now (it is still asleep, so SIGTERM ends it).
    try {
      process.kill(child.pid, "SIGTERM");
    } catch {
      // gone already
    }
    throw e;
  }
  return child.pid;
}

/** The reaper of `runId`, signalled only while its pid still runs `argus-live.mjs reap <runId>` (and is not this process). */
function stopReaper(pid, runId, runner, note) {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return;
  const r = runner(["ps", "-ww", "-o", "command=", "-p", String(pid)]);
  if (r.error || r.status !== 0) return; // gone
  const cmd = String(r.stdout).trim();
  if (!cmd.endsWith(` reap ${runId}`) || !cmd.includes("argus-live.mjs")) {
    note(`the reaper's pid ${pid} now runs something else; not signalled`);
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // gone meanwhile
  }
}

/** Replays one stop record exactly: `/bin/sh -c <cmd>` in its cwd under its env, plus the secrets its cmd references. */
async function replayStop(s, { secrets, asyncRunner, timeoutMs, logs, note }) {
  const where = `stop ${s && s.name}`;
  if (!s || typeof s.cmd !== "string" || typeof s.cwd !== "string" || !s.env || typeof s.env !== "object") {
    note(`${where}: not a stop record {cmd, cwd, env}; not run`);
    return;
  }
  fs.mkdirSync(logs, { recursive: true, mode: 0o700 });
  const log = path.join(logs, `stop.${String(s.name).replace(/[^A-Za-z0-9_.-]/g, "-")}.log`);
  const fd = fs.openSync(log, "a", 0o600);
  const from = fs.fstatSync(fd).size;
  let r;
  try {
    r = await asyncRunner(["/bin/sh", "-c", s.cmd], { cwd: s.cwd, env: { ...s.env, ...secretEnv(s.cmd, secrets) }, stdio: ["ignore", fd, fd], timeoutMs, killAfter: true });
  } finally {
    fs.closeSync(fd);
  }
  if (r.timedOut) note(`${where} timed out after ${Math.round(timeoutMs / 1000)} s; its group was killed`);
  else if (r.error) note(`${where}: ${r.error.message}`);
  else if (r.status !== 0) note(`${where} exited ${r.status ?? r.signal}: ${tail(readFrom(log, from))}`);
}

/** SIGTERM to every group in `pgids`, SIGKILL to those still there after `graceMs`; returns the ones killed hard. */
async function stopGroups(pgids, graceMs) {
  const live = () =>
    pgids.filter((g) => {
      try {
        process.kill(-g, 0);
        return true;
      } catch {
        return false;
      }
    });
  for (const g of pgids) killGroup(g, "SIGTERM");
  const end = Date.now() + graceMs;
  while (live().length && Date.now() < end) await sleep(100);
  const left = live();
  for (const g of left) killGroup(g, "SIGKILL");
  return left;
}

/**
 * Stops every recorded group that still runs what was recorded (sameGroup); the others are noted and
 * left alone. With `refresh` (an in-memory record from this process, whose exits it tracked), the
 * groups are first read as ps shows them now (refreshGroups).
 */
async function stopRecordedGroups(groups, { runner, secrets, graceMs, refresh = false, note }) {
  let list = (groups ?? []).filter((g) => g && Number.isInteger(g.pgid) && g.pgid > 1 && g.pgid !== process.pid);
  if (!list.length) return;
  let table;
  try {
    table = processTable(runner);
  } catch (e) {
    note(`${e.message}; no process group killed`);
    return;
  }
  if (refresh) list = refreshGroups(list, table, secrets);
  const kill = [];
  for (const g of list) {
    const now = membersOf(table, g.pgid, secrets);
    if (!now.length) continue;
    if (sameGroup(g, now)) kill.push(g.pgid);
    else note(`process group ${g.pgid} (${g.name}): what runs in it is not what was recorded; not killed`);
  }
  const hard = await stopGroups([...new Set(kill)], graceMs);
  if (hard.length) note(`process groups ${hard.join(", ")} outlived SIGTERM for ${Math.round(graceMs / 1000)} s: killed`);
}

/** `$TMPDIR/sapu-live` (real path) when it exists as this user's own directory, else null; never creates it. */
function existingLiveRoot(note) {
  let root;
  try {
    root = path.join(fs.realpathSync.native(os.tmpdir()), "sapu-live");
  } catch {
    return null;
  }
  return privateDir(root, note) ? root : null;
}

/** True when `dir` is a directory of this user's (not a symlink); a refusal is noted. */
function privateDir(dir, note) {
  let st;
  try {
    st = fs.lstatSync(dir);
  } catch {
    return false;
  }
  if (st.isSymbolicLink() || !st.isDirectory() || (typeof process.getuid === "function" && st.uid !== process.getuid())) {
    note(`refused: ${dir} is not this user's own directory; nothing removed there`);
    return false;
  }
  return true;
}

/** Gives the owner write and search access to every directory under `p` (symlinks not followed), so it can be removed: a module cache is often read-only. */
function makeWritable(p) {
  const stack = [p];
  while (stack.length) {
    const d = stack.pop();
    let st;
    try {
      st = fs.lstatSync(d);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    if ((st.mode & 0o700) !== 0o700) fs.chmodSync(d, (st.mode & 0o7777) | 0o700);
    for (const n of fs.readdirSync(d)) stack.push(path.join(d, n));
  }
}

/** Removes `p` (made writable first); a failure is noted as a leftover, never thrown. Returns true when `p` is gone. */
function removeTree(p, note) {
  try {
    makeWritable(p);
    fs.rmSync(p, { recursive: true, force: true });
    return true;
  } catch (e) {
    note(`${p} could not be removed (${e.code || e.message}); remove it by hand`);
    return false;
  }
}

/**
 * Removes git's record (`.git/worktrees/<id>`) of the worktree `wt` whose directory is already gone,
 * that record alone: `git worktree prune` would also drop every other missing worktree of the repo.
 */
function forgetWorktree(main, wt, note) {
  const admin = path.join(main, ".git", "worktrees");
  let ids;
  try {
    ids = fs.readdirSync(admin);
  } catch {
    return;
  }
  for (const id of ids) {
    let gitdir;
    try {
      gitdir = fs.readFileSync(path.join(admin, id, "gitdir"), "utf8").trim();
    } catch {
      continue;
    }
    if (gitdir !== path.join(wt, ".git")) continue;
    try {
      fs.rmSync(path.join(admin, id), { recursive: true, force: true });
    } catch (e) {
      note(`git's record of ${wt} (${path.join(admin, id)}) could not be removed (${e.code || e.message})`);
    }
  }
}

/**
 * Removes run `runId`'s worktree, HOME and setup log — only its own: `<sapu-live>/<repo>-<runId>` (and
 * `.home`, `.setup.log` beside it), where <sapu-live> is `$TMPDIR/sapu-live` or the one run.json's
 * `worktree` lies in, each this user's own directory. Any other recorded worktree is left as it is.
 * Read-only trees are made writable first; what still cannot be removed is noted, never thrown.
 */
function removeRunDirs(main, runId, recorded, { runner, note }) {
  const realMain = fs.realpathSync.native(main);
  const name = `${repoName(realMain)}-${runId}`;
  const roots = new Set();
  const cur = existingLiveRoot(note);
  if (cur) roots.add(cur);
  if (typeof recorded === "string" && recorded) {
    const parent = path.dirname(recorded);
    const own = path.basename(recorded) === name && path.basename(parent) === "sapu-live" && path.isAbsolute(recorded) && !within(realMain, recorded);
    if (own && privateDir(parent, note)) roots.add(parent);
    else if (!own) note(`run.json names the worktree ${recorded}, which is not the run's own (<TMPDIR>/sapu-live/${name}): left as it is`);
  }
  for (const root of roots) {
    const wt = path.join(root, name);
    let st = null;
    try {
      st = fs.lstatSync(wt);
    } catch {
      st = null;
    }
    if (st && st.isDirectory()) {
      let r;
      try {
        makeWritable(wt);
        r = runner(["git", "-C", main, "worktree", "remove", "--force", wt]);
      } catch (e) {
        r = { error: e };
      }
      if (r.error || r.status !== 0) {
        // Not a worktree git knows any more, or one it will not remove: the directory is the run's own.
        note(`git worktree remove ${wt} failed (${tail((r.error && r.error.message) || r.stderr)}); removing the directory`);
        if (removeTree(wt, note)) runner(["git", "-C", main, "worktree", "prune"]);
      }
    } else if (st) note(`refused: ${wt} is not a directory; left as it is`);
    else forgetWorktree(main, wt, note);
    for (const p of [`${wt}.home`, `${wt}.setup.log`]) {
      let there = true;
      try {
        fs.lstatSync(p);
      } catch {
        there = false;
      }
      if (there) removeTree(p, note);
    }
  }
}

/**
 * Removes the lock while it names `runId`, under `claim-<runId>.json` (the lock rule), and runs
 * `removed` (the end line) under that same claim, so a second `down` finds the lock gone and adds no
 * second end. A busy claim is waited on up to `waitMs`, then refused. Returns true when it removed it.
 */
async function releaseLock(main, runId, waitMs, removed = () => {}) {
  const end = Date.now() + waitMs;
  for (;;) {
    const l = readLock(main);
    if (!l || l.runId !== runId) return false;
    if (claim(main, runId, { down: runId })) {
      try {
        const cur = readLock(main);
        if (!cur || cur.runId !== runId) return false;
        fs.rmSync(lockPath(main), { force: true });
        removed();
        return true;
      } finally {
        fs.rmSync(claimPath(main, runId), { force: true });
      }
    }
    const busy = claimBusy(main, runId);
    if (!busy.retry || Date.now() >= end) throw busy;
    await sleep(100);
  }
}

/** Runs one teardown step; an error is noted and the teardown goes on. */
async function guarded(what, note, fn) {
  try {
    await fn();
  } catch (e) {
    note(`${what}: ${e.message}`);
  }
}

/**
 * Seals run.json (`closing`) under the run's claim before a `down` reads it: from then on no writer adds
 * a group or stop record the teardown would not read (updateRun refuses them). Nothing to seal when the
 * lock no longer names the run (no writer can succeed then either) or run.json does not name it; a claim
 * still busy after `waitMs` is noted.
 */
function sealRun(main, runId, waitMs, note) {
  try {
    updateRun(main, runId, (prev) => (prev ? { ...prev, closing: true } : undefined), { waitMs, sealed: true });
  } catch (e) {
    if (!e.message.startsWith("refused: the lock no longer names")) note(`sealing run.json: ${e.message}`);
  }
}

/**
 * Removes run.json while it names `runId`: under the run's claim while the lock names the run; directly
 * once it does not (no writer can succeed then), or when the claim stays busy (the record is sealed, so
 * its holder cannot write it).
 */
function removeRun(main, runId, waitMs) {
  try {
    updateRun(main, runId, (prev) => (prev ? null : undefined), { waitMs, sealed: true });
    return;
  } catch {
    // the lock no longer names the run, or its claim stayed busy
  }
  const onDisk = readRun(main);
  if (onDisk && onDisk.runId === runId) fs.rmSync(runPath(main), { force: true });
}

/**
 * One recorded stop, as the teardown's mode allows: `down` replays it unless its cwd is gone; recovery
 * (a stale run, so a record this process did not keep) also journals, never runs, one whose env does not
 * name COMPOSE_PROJECT_NAME=argus-<run>.
 */
async function replayRecorded(s, t) {
  if (t.mode === "recover") {
    if (!s || typeof s.cwd !== "string" || !fs.existsSync(s.cwd)) return t.note(`stop ${s && s.name}: its cwd ${s && s.cwd} is gone; journalled, not run`);
    if (!s.env || s.env.COMPOSE_PROJECT_NAME !== `argus-${t.runId}`) return t.note(`stop ${s.name}: its env does not name COMPOSE_PROJECT_NAME=argus-${t.runId}; journalled, not run`);
  } else if (s && typeof s.cwd === "string" && !fs.existsSync(s.cwd)) return t.note(`stop ${s.name}: its cwd ${s.cwd} is gone; not run`);
  await replayStop(s, { secrets: t.secrets, asyncRunner: t.asyncRunner, timeoutMs: t.stopTimeoutMs, logs: logsDir(t.main, t.runId), note: t.note });
}

/**
 * The teardown's steps in spec §8's order, shared by `down` and recovery: one list, so a step added
 * (phase 3: the proxy, then the CLI sessions by name, after the process groups) is one entry. Each runs
 * guarded: a failure is noted and the next step runs. `t` = {main, runId, rec, mode: "down" | "recover",
 * secrets, runner, asyncRunner, graceMs, stopTimeoutMs, claimWaitMs, refresh, note}.
 */
const TEARDOWN = [
  // `down` only: a finding is reported, never stops the teardown.
  ["docker runtime gate", (t) => (t.mode === "down" && t.rec && Number.isFinite(t.rec.since) && t.rec.env && typeof t.rec.worktree === "string" ? checkDockerRuntime({ ...gateOf(t.rec, t.rec.groups), main: t.main, runner: t.runner }) : undefined)],
  // Last started first, each bounded by stopTimeoutMs.
  ["stops", async (t) => {
    for (const s of [...(t.rec?.stops ?? [])].reverse()) await guarded(`stop ${s && s.name}`, t.note, () => replayRecorded(s, t));
  }],
  // Only groups that still run what was recorded (sameGroup); setup groups included.
  ["process groups", (t) => stopRecordedGroups(t.rec?.groups, { runner: t.runner, secrets: t.secrets, graceMs: t.graceMs, refresh: t.refresh, note: t.note })],
  ["the run's directories", (t) => removeRunDirs(t.main, t.runId, t.rec?.worktree, { runner: t.runner, note: t.note })],
  // Last of the processes: the reaper, unless it is this process (its own `down`).
  ["the reaper", (t) => (t.rec ? stopReaper(t.rec.reaper, t.runId, t.runner, t.note) : undefined)],
  ["run.json", (t) => (t.mode === "down" ? removeRun(t.main, t.runId, t.claimWaitMs) : t.rec ? fs.rmSync(runPath(t.main), { force: true }) : undefined)],
];

/** The names of the teardown's steps, in order. */
export const TEARDOWN_STEPS = TEARDOWN.map(([name]) => name);

/** Runs every TEARDOWN step for `t`, each guarded. */
async function teardown(t) {
  for (const [what, step] of TEARDOWN) await guarded(what, t.note, () => step(t));
}

/**
 * Tears run `runId` down (spec §8 `down`), from `record` (the in-memory run of this process, e.g. an `up`
 * that failed before writing its run files) or else run.json (when it names the run), sealed first so no
 * writer adds to it meanwhile: the TEARDOWN steps (the Docker runtime gate, the stops replayed exactly —
 * `/bin/sh -c <cmd>`, recorded cwd and env, plus the secrets the cmd references —, SIGTERM then SIGKILL
 * after `graceMs` to every recorded group that still runs what was recorded, its own worktree, HOME and
 * setup log, the reaper, run.json), then the lock and `<runId> end <now>` in the live log, both under the
 * lock's claim (only the `down` that removes the lock writes the end line). A step that fails is reported
 * and the next one runs. Returns {report: [lines]} (secret values masked). Throws only when the lock still
 * names the run and another process holds its claim (claimBusy, after waiting `claimWaitMs` for a live
 * holder): the teardown is done by then, and the lock and its end line wait for the owner.
 */
export async function down(main, { runId, record, secrets = {}, runner = run, asyncRunner = runAsync, graceMs = 10_000, stopTimeoutMs = 120_000, claimWaitMs = 2000 } = {}) {
  runIdOk(runId);
  const report = [];
  const note = (line) => report.push(redact(line, secrets));
  sealRun(main, runId, claimWaitMs, note);
  let rec = record ?? null;
  if (!rec) {
    try {
      rec = readRun(main);
    } catch (e) {
      note(e.message);
    }
  }
  if (rec && rec.runId !== runId) {
    note(`run.json names cycle ${rec.runId}, not ${runId}: left as it is`);
    rec = null;
  }
  if (rec && rec.digest) {
    const now = loadLive(main);
    if (now.digest.live !== rec.digest.live) note(`${LIVE_FILE} changed since up: down works from run.json as recorded`);
    if (now.digest.env_file !== rec.digest.env_file) note(`${(now.config && now.config.env_file) || "the env_file"} changed since up: the stops were replayed with its values as they are now`);
  }
  await teardown({ main, runId, rec, mode: "down", secrets, runner, asyncRunner, graceMs, stopTimeoutMs, claimWaitMs, refresh: Boolean(record), note });
  await releaseLock(main, runId, claimWaitMs, () => {
    // Synchronous: the end line is written before the claim is released.
    try {
      appendEnd(main, runId);
    } catch (e) {
      note(`the live log: ${e.message}`);
    }
  });
  return { report };
}

/**
 * Recovers every stale run (staleRecords: a lock taken over past its deadline, or a takeover rolled
 * back) before a new `up` writes its own run files (spec §8 step 1), from run.json when it names that
 * run (else noted: what its stops and groups started may be left), through the same TEARDOWN steps as
 * `down` (no runtime gate; only the stops whose cwd exists and whose env names the run's project are
 * replayed, the others journalled); then always appends `<run> end <now>` and deletes the run's claim,
 * whatever failed before (each failure noted). Returns {recovered, report}.
 */
export async function recover(main, { secrets = {}, runner = run, asyncRunner = runAsync, graceMs = 10_000, stopTimeoutMs = 120_000 } = {}) {
  const report = [];
  const recovered = [];
  for (const stale of staleRecords(main)) {
    const note = (line) => report.push(redact(`${stale.runId}: ${line}`, secrets));
    let rec = null;
    try {
      rec = readRun(main);
    } catch (e) {
      note(e.message);
    }
    if (rec && rec.runId !== stale.runId) rec = null;
    if (!rec) note("run.json does not name this run: its stop records and process groups are unknown, so what they started may be left running");
    await teardown({ main, runId: stale.runId, rec, mode: "recover", secrets, runner, asyncRunner, graceMs, stopTimeoutMs, refresh: false, note });
    await guarded("the live log", note, () => appendEnd(main, stale.runId));
    await guarded("its claim", note, () => fs.rmSync(claimPath(main, stale.runId), { force: true }));
    recovered.push(stale.runId);
  }
  return { recovered, report };
}

/**
 * The reaper (`argus-live.mjs reap <runId>`): sleeps until the lock's deadline, re-reading the lock at
 * least every `pollMs` (so a `renew` moves its wake-up), then runs `down` — only while the lock still
 * names `runId`; otherwise it exits without acting. What it did goes to `<logs>/reaper.log`.
 */
export async function reap(main, runId, { pollMs = 60_000 } = {}) {
  const logs = logsDir(main, runId);
  const say = (line) => {
    try {
      fs.mkdirSync(logs, { recursive: true, mode: 0o700 });
      fs.appendFileSync(path.join(logs, "reaper.log"), `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
    } catch {
      // nowhere to write: the reaper still does its job
    }
  };
  for (;;) {
    let lock;
    try {
      lock = readLock(main);
    } catch (e) {
      say(`${e.message}; exiting without acting`);
      return "skipped";
    }
    if (!lock || lock.runId !== runId) {
      say(`the lock names ${lock ? `cycle ${lock.runId}` : "no cycle"}, not ${runId}: exiting without acting`);
      return "skipped";
    }
    const left = lock.deadline * 1000 - Date.now();
    if (left <= 0) break;
    await sleep(Math.min(left, pollMs));
  }
  say("the deadline passed: down");
  // From here on a SIGTERM (another `down` signalling the reaper) must not stop it between the lock's claim and its removal.
  process.on("SIGTERM", () => say("SIGTERM ignored: down is under way"));
  const { secrets } = loadLive(main);
  try {
    const { report } = await down(main, { runId, secrets });
    for (const line of report) say(line);
    say("down finished");
    return "down";
  } catch (e) {
    say(redact(e.message, secrets));
    return "failed";
  }
}

// ---------------------------------------------------------------------------------------------------
// up, up --fresh, renew, status (spec §8 `up` steps 1-8 and 11, `up --fresh`, `renew`). Steps 9 (the
// filtering proxy) and 10 (proving logins) arrive with the browser driver.

const defaultLookup = (h) => dns.promises.lookup(h, { all: true });

/** checkDockerRuntime's view of a run (`rec`: run.json, or `up`'s state) whose groups are `groups`: since, env, worktree, ports, the follower's file and group. */
function gateOf(rec, groups = []) {
  return { since: rec.since, env: rec.env, worktree: rec.worktree, ports: rec.ports ?? {}, eventsFile: rec.events ?? null, follower: (groups ?? []).find((g) => g && g.name === FOLLOWER) ?? null };
}

/** `e` (an Error) tagged with the `up` step it failed in, for the CLI's report. */
const atStep = (e, step) => Object.assign(e instanceof Error ? e : new Error(String(e)), { step });

/** The host of a URL that may still hold `{port:<name>}` placeholders, or null. */
function hostOf(raw) {
  try {
    return new URL(String(raw).replace(/\{port:[^}]*\}/g, "1")).hostname.replace(/^\[(.*)\]$/, "$1");
  } catch {
    return null;
  }
}

/** True when `host` is loopback by itself (`localhost`, `127.x`, `::1`) or every address `lookup` gives it is. */
async function resolvesToLoopback(host, lookup) {
  if (normHost(host) === "loopback") return true;
  if (net.isIP(host)) return false;
  try {
    const addrs = await lookup(host);
    return Array.isArray(addrs) && addrs.length > 0 && addrs.every((a) => normHost(a.address) === "loopback");
  } catch {
    return false;
  }
}

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

/**
 * The pids the egress check lists: every process of each recorded group, unless the group is known to
 * be someone else's (its leader exited, or started at another time, while a process holds its pid). A
 * group whose identity cannot be confirmed (no start time recorded) is listed: for a check, doubt
 * means look. When recorded groups still have processes but none is listed, the listing cannot be
 * trusted (`failed: …`): an empty listing would pass anything.
 */
function runPids(groups, runner) {
  const table = processTable(runner);
  const out = [];
  let foreign = null;
  for (const g of groups) {
    if (!g || !Number.isInteger(g.pgid) || g.pgid <= 1) continue;
    const now = membersOf(table, g.pgid, {});
    const leader = now.find((p) => p.pid === g.pgid);
    if (leader && (g.exited || (g.started && !sameStart(leader.started, g.started)))) {
      foreign = foreign ?? g;
      continue;
    }
    out.push(...now.map((p) => p.pid));
  }
  if (!out.length && foreign) throw new Error(`failed: the run's process listing cannot be trusted: process group ${foreign.pgid} (${foreign.name}) has processes, none of them the run's`);
  return out;
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
