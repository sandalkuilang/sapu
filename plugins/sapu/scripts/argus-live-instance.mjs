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
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { expand, MAX_CYCLE_MINUTES, parseEnvFile } from "./argus-live-config.mjs";
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

/**
 * The async runner: `argv` without a shell, detached into its own process group (pgid = pid, handed
 * to `onStart` before anything is awaited). On `timeoutMs` the whole group gets SIGKILL. With
 * `capture`, stdout is collected (up to 1 MiB) → {status, signal, timedOut, error, stdout}.
 */
export function runAsync(argv, { cwd, env, timeoutMs, stdio = ["ignore", "ignore", "ignore"], capture = false, onStart = () => {} } = {}) {
  return new Promise((done) => {
    let finished = false;
    let timedOut = false;
    let timer;
    let stdout = "";
    const finish = (r) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      done({ timedOut, stdout, ...r });
    };
    let child;
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
    child.once(capture ? "close" : "exit", (status, signal) => finish({ status, signal }));
  });
}

/** `deadline` (epoch seconds) as milliseconds left; refuses a missing one. */
function msLeft(deadline, what) {
  if (!Number.isInteger(deadline)) throw new Error(`failed: ${what} needs the lock's deadline (epoch seconds)`);
  return deadline * 1000 - Date.now();
}

/**
 * Runs each `setup` argv in the worktree under `env`, without a shell, each in its own process group
 * (recorded in `groups` as `setup[<i>]` before it is awaited, so `down` kills a daemon it leaves
 * behind), its output appended to `log`; each step is bounded by the time left before `deadline` (the
 * lock's, epoch seconds), and a timed-out or failed step's whole group is killed. Then refuses a
 * symlink into <MAIN>. Throws `failed: setup <argv> exited <code>: <its output's last lines>` or
 * `failed: setup <argv> timed out`, every non-empty `secrets` value masked.
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
    let r;
    try {
      r = await runner(argv, {
        cwd: worktree,
        env,
        stdio: ["ignore", fd, fd],
        timeoutMs: left,
        onStart: (p) => {
          pgid = p;
          groups.push({ name: `setup[${i}]`, pgid: p, cmdline: argv.join(" ") });
        },
      });
    } finally {
      fs.closeSync(fd);
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

/**
 * Starts one expanded `start` entry: `/bin/sh -c <cmd>` in the worktree, detached into its own process
 * group (recorded in `groups`), under `env` plus the entry's own env, logged to `<logs>/<name>.log`.
 * Refused when its health `url` already answers (something else serves there) and when its env names
 * HOME or COMPOSE_PROJECT_NAME. Returns {name, pid, pgid, log, cmdline, t0, exit} (`exit` = {code,
 * signal} once it exits).
 */
export async function startEntry(entry, { worktree, env, logs, groups = [] }) {
  for (const k of Object.keys(entry.env ?? {})) if (RUN_ENV.includes(k)) throw new Error(`refused: start entry ${entry.name} may not set ${k}`);
  const url = entry.health && entry.health.url;
  if (url && (await answers(url))) throw new Error(`refused: something already serves ${url} (${entry.name})`);
  fs.mkdirSync(logs, { recursive: true, mode: 0o700 });
  const log = path.join(logs, `${entry.name}.log`);
  const fd = fs.openSync(log, "a", 0o600);
  let child;
  try {
    child = spawn("/bin/sh", ["-c", entry.cmd], { cwd: worktree, env: { ...env, ...(entry.env ?? {}) }, detached: true, stdio: ["ignore", fd, fd] });
  } finally {
    fs.closeSync(fd);
  }
  const started = { name: entry.name, pid: undefined, pgid: undefined, log, cmdline: `/bin/sh -c ${entry.cmd}`, t0: Date.now(), exit: null };
  child.once("exit", (code, signal) => {
    started.exit = { code, signal };
  });
  await new Promise((ok, fail) => {
    child.once("spawn", ok);
    child.once("error", (e) => fail(new Error(`failed: ${entry.name} could not start: ${e.message}`)));
  });
  started.pid = started.pgid = child.pid;
  groups.push({ name: entry.name, pgid: child.pid, cmdline: started.cmdline });
  return started;
}

/**
 * Waits until `entry` is healthy: `{url}` answering 2xx, `{cmd}` exiting 0 (run like the entry), or,
 * without health, the process alive after `aliveAfterMs`. A process that exits before then fails it,
 * unless it exited 0 and the entry has `stop` (a detached starter). `timeoutS` bounds the wait.
 */
export async function waitHealth(entry, started, { timeoutS, aliveAfterMs = 5000, worktree, env, secrets = {}, runner = runAsync }) {
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
      const r = await runner(["/bin/sh", "-c", entry.health.cmd], { cwd: worktree, env: { ...env, ...(entry.env ?? {}) }, timeoutMs: Math.min(30_000, left) });
      ok = !r.error && !r.timedOut && r.status === 0;
    }
    if (ok) return;
    x = exited();
    if (x) throw x;
    if (Date.now() >= until) throw timeout();
    await sleep(250);
  }
}

const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\//i;

/** The ports and database names a connection URL names, a scheme's default port included. */
function urlParts(v) {
  const m = v.match(/^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(\?[^#]*)?/i);
  if (!m) return { ports: [], databases: [] };
  const pg = /^postgres(ql)?$/i.test(m[1]);
  const hosts = m[2].slice(m[2].lastIndexOf("@") + 1).split(",");
  const ports = hosts.map((h) => {
    const p = h.match(/:(\d+)$/);
    return p ? Number(p[1]) : pg ? 5432 : null;
  });
  const decode = (x) => {
    try {
      return decodeURIComponent(x);
    } catch {
      return x;
    }
  };
  const db = m[3].split("/").filter(Boolean)[0];
  const databases = db ? [decode(db)] : [];
  const q = new URLSearchParams((m[4] || "").slice(1));
  for (const k of ["dbname", "database"]) if (q.get(k)) databases.push(q.get(k));
  if (q.get("port")) ports.push(...q.get("port").split(",").map(Number));
  return { ports: ports.filter((p) => p !== null), databases };
}

/**
 * Runs `store_check` (shell, worktree, env, bounded by `deadline`): its output must be `store`. No URL
 * in `env` may equal a value in the repo's env files (`.env`, `.env.local`, the contract's
 * `guard.envFiles`; read here, never printed) or name a port or database the contract's
 * `guard.postgres` protects. Refusals name the key, never a value.
 */
export async function checkStore({ config, env, worktree, main, contract, secrets = {}, deadline, runner = runAsync }) {
  const left = msLeft(deadline, "checkStore");
  const r = await runner(["/bin/sh", "-c", config.store_check], { cwd: worktree, env, capture: true, timeoutMs: Math.max(0, left) });
  if (r.timedOut) throw new Error("failed: store_check timed out (the cycle's deadline)");
  if (r.error || r.status !== 0) throw new Error(`failed: store_check ${r.error ? redact(r.error.message, secrets) : `exited ${r.status ?? r.signal}`}`);
  const got = r.stdout.trim();
  if (got !== config.store) throw new Error(`refused: store_check printed "${redact(got.slice(0, 80), secrets)}", not the store "${config.store}"`);
  const guard = (contract && contract.guard) || {};
  const files = [".env", ".env.local", ...(guard.envFiles ?? [])];
  const repo = new Set();
  for (const f of files) {
    let text;
    try {
      text = fs.readFileSync(path.join(main, f), "utf8");
    } catch {
      continue;
    }
    for (const v of Object.values(parseEnvFile(text))) if (v.trim()) repo.add(v.trim());
  }
  const pg = guard.postgres || { ports: [], databases: [] };
  for (const [k, raw] of Object.entries(env)) {
    const v = String(raw).trim();
    if (/^\d+$/.test(v)) {
      if (pg.ports.includes(Number(v))) throw new Error(`refused: env.${k} names port ${v}, which guard.postgres protects`);
      continue;
    }
    if (!URL_LIKE.test(v)) continue;
    if (repo.has(v)) throw new Error(`refused: env.${k} equals a value in the repo's env files (${files.join(", ")}); it would reach the owner's service`);
    const { ports, databases } = urlParts(v);
    const port = ports.find((p) => pg.ports.includes(p));
    if (port !== undefined) throw new Error(`refused: env.${k} names port ${port}, which guard.postgres protects`);
    const db = databases.find((d) => pg.databases.includes(d));
    if (db !== undefined) throw new Error(`refused: env.${k} names database ${db}, which guard.postgres protects`);
  }
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
  try {
    r = await runner(["/bin/sh", "-c", cmd], { cwd: worktree, env, stdio: ["ignore", fd, fd], timeoutMs: left, onStart: (p) => groups.push({ name, pgid: p, cmdline: `/bin/sh -c ${cmd}` }) });
  } finally {
    fs.closeSync(fd);
  }
  if (r.timedOut) throw new Error(`failed: ${name} timed out (the cycle's deadline)`);
  if (r.error) throw new Error(`failed: ${name}: ${redact(r.error.message, secrets)}`);
  if (r.status !== 0) throw new Error(`failed: ${name} exited ${r.status ?? r.signal}: ${tail(redact(readFrom(log, from), secrets))}`);
}

async function startHealthy(entry, ctx) {
  await waitHealth(entry, await startEntry(entry, ctx), ctx);
}

/**
 * `up` steps 6: the `phase: "store"` entries (started and healthy, one by one), `checkStore`, and only
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
