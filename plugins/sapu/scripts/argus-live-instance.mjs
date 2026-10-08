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
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { expand, MAX_CYCLE_MINUTES } from "./argus-live-config.mjs";
import { findMain } from "./sapu-contract.mjs";

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

/** Write `data` to a temp file beside `file`; returns the temp path. */
function tempBeside(file, data) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  fs.writeFileSync(tmp, data);
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

/** The refusal for a claim another process holds on a lock that still names `runId`. */
function claimBusy(main, runId) {
  const file = claimPath(main, runId);
  let pid;
  try {
    pid = JSON.parse(fs.readFileSync(file, "utf8")).pid;
  } catch {
    pid = undefined;
  }
  if (alive(pid)) return new Error(`refused: cycle ${runId}'s lock is being changed by process ${pid}; try again`);
  return new Error(`refused: a change to cycle ${runId}'s lock was interrupted (process ${pid ?? "unknown"} is gone); remove ${file} once no journey cycle is running`);
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
 * Returns {runId, start, deadline} and, when it took over a lock past its deadline, `stale` (that
 * lock, for recovery; also kept in `claim-<stale run>.json`). Throws `refused: cycle <run> holds the
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
  return stale ? { ...lock, stale } : lock;
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
  const [lo, hi] = range;
  const out = {};
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

/** The real path of `p`, or, when it does not exist, its nearest existing ancestor's real path + the rest. */
function realish(p) {
  let rest = "";
  for (let at = path.resolve(p); ; at = path.dirname(at)) {
    try {
      return path.join(fs.realpathSync.native(at), rest);
    } catch {
      if (path.dirname(at) === at) return path.resolve(p);
      rest = path.join(path.basename(at), rest);
    }
  }
}

/**
 * A linked worktree of HEAD at `$TMPDIR/sapu-live/<repo>-<runId>`, outside the repo, so no lookup that
 * walks up the directory tree finds the repo's own `.env`. Returns its real path (the form the guard
 * compares).
 */
export function makeWorktree(main, runId, { runner = run } = {}) {
  runIdOk(runId);
  const realMain = fs.realpathSync.native(main);
  const parent = path.join(fs.realpathSync.native(os.tmpdir()), "sapu-live");
  const wt = path.join(parent, `${path.basename(realMain).replace(/[^A-Za-z0-9._-]/g, "-")}-${runId}`);
  if (within(realMain, wt)) throw new Error(`refused: the worktree ${wt} would lie inside the repo (TMPDIR points into it)`);
  fs.mkdirSync(parent, { recursive: true });
  const r = runner(["git", "-C", main, "worktree", "add", "--detach", wt, "HEAD"]);
  if (r.error || r.status !== 0) throw new Error(`failed: git worktree add ${wt}: ${((r.error && r.error.message) || r.stderr || "").trim()}`);
  return fs.realpathSync.native(wt);
}

/** The run's own empty HOME, `<MAIN>/.argus/live/<runId>/home` (mode 0700); refused when not empty. */
export function makeHome(main, runId) {
  runIdOk(runId);
  const home = path.join(fs.realpathSync.native(main), ".argus", "live", runId, "home");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  if (fs.readdirSync(home).length) throw new Error(`refused: ${home} is not empty`);
  return home;
}

/** What every command inherits from the session: nothing that names an account or a credential. */
const BASE_ENV = ["PATH", "USER", "SHELL", "TMPDIR", "LANG"];
const RUN_ENV = ["HOME", "COMPOSE_PROJECT_NAME"];

/**
 * The only environment any command of the instance gets: `PATH, USER, SHELL, TMPDIR, LANG, LC_*`
 * (when set), the `pass_env` names (when set), every `env` entry expanded, `COMPOSE_PROJECT_NAME =
 * argus-<runId>` and `HOME` = the run's empty home. No owner home, so no tool picks up the owner's
 * cloud, Git or registry credentials. `env` and `pass_env` may not name HOME or COMPOSE_PROJECT_NAME.
 */
export function instanceEnv({ config, ports, secrets, runId, home }) {
  runIdOk(runId);
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
  return env;
}

/**
 * Throws `refused: <link> points into the main checkout` for any symlink in the worktree (its `.git`
 * aside) whose target lies in <MAIN>: the instance would write there (a dependency directory linked
 * from the owner's checkout). Symlinked directories are not followed.
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
        if (within(realMain, realish(path.resolve(dir, fs.readlinkSync(p))))) throw new Error(`refused: ${p} points into the main checkout`);
      } else if (d.isDirectory()) stack.push(p);
    }
  }
}

/** The last lines of a command's output, for an error message. */
const tail = (text) => (text || "").trim().split("\n").slice(-5).join(" | ").slice(-500);

/**
 * Runs each `setup` argv in the worktree under `env`, without a shell; then refuses a symlink into
 * <MAIN>. Throws `failed: setup <argv> exited <code>: <its output's last lines>`.
 */
export function runSetup(worktree, config, env, { main = findMain(worktree), runner = run } = {}) {
  if (!main) throw new Error(`failed: no main checkout found for ${worktree}`);
  for (const argv of config.setup ?? []) {
    const r = runner(argv, { cwd: worktree, env });
    if (r.error) throw new Error(`failed: setup ${argv.join(" ")}: ${r.error.message}`);
    if (r.status !== 0) throw new Error(`failed: setup ${argv.join(" ")} exited ${r.status ?? r.signal}: ${tail(r.stderr || r.stdout)}`);
  }
  refuseLinksIntoMain(worktree, main);
}
