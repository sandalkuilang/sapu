// argus-live-lock.mjs — the journey lane's lock and live log (spec §8 step 1 and `renew`).
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
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { MAX_CYCLE_MINUTES } from "./argus-live-config.mjs";
import { sleep, tempBeside } from "./argus-live-proc.mjs";
import { gitCommonDir } from "./sapu-contract.mjs";

/** `<yyyymmddhhmmss>-<8 hex>` (UTC): unique per run, and safe on a log line and in a file name. */
export const RUN_ID = /^\d{14}-[0-9a-f]{8}$/;
/** Grace beyond `limits.max_cycle_minutes`, in the first deadline and in the renewal cap alike. */
const GRACE_S = 15 * 60;
/** Every epoch the lock holds or computes lies in the years 2000-2099. */
const EPOCH_MIN = 946684800;
const EPOCH_MAX = 4102444800;

export const liveDir = (main) => path.join(main, ".argus", "live");
const lockPath = (main) => path.join(liveDir(main), "lock.json");
export const claimPath = (main, runId) => path.join(liveDir(main), `claim-${runId}.json`);
// in the repository's git directory: <MAIN>/.git in a plain clone, elsewhere for a submodule or --separate-git-dir
const liveLog = (main) => path.join(gitCommonDir(main) ?? path.join(main, ".git"), "sapu-live.log");
export const iso = (s) => new Date(s * 1000).toISOString();
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

export function runIdOk(runId) {
  if (typeof runId !== "string" || !RUN_ID.test(runId)) throw new Error(`not a run id: ${JSON.stringify(runId)}`);
}

function appendLive(main, runId, rest) {
  runIdOk(runId);
  fs.appendFileSync(liveLog(main), `${runId} ${rest}\n`);
}

/** Take the claim on run `runId`'s lock: true, or false when another process holds it. */
export function claim(main, runId, record) {
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
export function claimBusy(main, runId) {
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

/** The run a reader after the explorers takes (`intake`, `scrub`): the lock's, else the newest run directory (an explorer may return after the reaper ran; a run that is down is read the same way), else null. */
export function lastRun(main) {
  const lock = readLock(main);
  if (lock) return lock.runId;
  let names = [];
  try {
    names = fs.readdirSync(liveDir(main)).filter((n) => RUN_ID.test(n));
  } catch {
    names = [];
  }
  return names.sort().pop() ?? null;
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
 * Removes the lock while it names `runId`, under `claim-<runId>.json` (the lock rule), and runs
 * `removed` (the end line) under that same claim, so a second `down` finds the lock gone and adds no
 * second end. A busy claim is waited on up to `waitMs`, then refused. Returns true when it removed it.
 */
export async function releaseLock(main, runId, waitMs, removed = () => {}) {
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
