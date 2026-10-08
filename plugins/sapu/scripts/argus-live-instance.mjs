// argus-live-instance.mjs — the journey lane's live instance (spec §8): one isolated copy of the
// repo's app per cycle, which never touches the owner's servers, services or data.
//
// The lock and the live log. `<MAIN>/.argus/live/lock.json` holds {runId, start, deadline} (epoch
// seconds); a lock whose deadline has not passed refuses every other cycle, one past it is handed to
// recovery. `<MAIN>/.git/sapu-live.log` is read by sapu-merge.sh's live_overlap, so its lines are
// exactly `<run> start <epoch> deadline <epoch>`, `<run> deadline <epoch>` and `<run> end <epoch>`.
// Every path is resolved from <MAIN> (findMain in sapu-contract.mjs), never from the cwd.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** `<yyyymmddhhmmss>-<8 hex>` (UTC): unique per run, and safe on a log line. */
export const RUN_ID = /^\d{14}-[0-9a-f]{8}$/;
/** Grace beyond `limits.max_cycle_minutes` before a lock counts as stale. */
const GRACE_S = 15 * 60;

const liveDir = (main) => path.join(main, ".argus", "live");
const lockPath = (main) => path.join(liveDir(main), "lock.json");
const liveLog = (main) => path.join(main, ".git", "sapu-live.log");
const seconds = (ms) => Math.floor(ms / 1000);
const iso = (s) => new Date(s * 1000).toISOString();

function minutes(maxCycleMinutes) {
  if (!Number.isInteger(maxCycleMinutes) || maxCycleMinutes < 1) throw new Error("limits.max_cycle_minutes must be a positive integer");
  return maxCycleMinutes;
}

function appendLive(main, runId, rest) {
  if (typeof runId !== "string" || !RUN_ID.test(runId)) throw new Error(`not a run id: ${JSON.stringify(runId)}`);
  fs.appendFileSync(liveLog(main), `${runId} ${rest}\n`);
}

/** Write `data` to a temp file beside `file`; returns the temp path. */
function tempBeside(file, data) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  fs.writeFileSync(tmp, data);
  return tmp;
}

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
  if (!l || typeof l.runId !== "string" || !RUN_ID.test(l.runId) || !Number.isInteger(l.start) || !Number.isInteger(l.deadline)) {
    throw new Error(`refused: ${file} is not a lock {runId, start, deadline}; remove it once no journey cycle is running`);
  }
  return { runId: l.runId, start: l.start, deadline: l.deadline };
}

/**
 * Take the lock for a new run and append its start line to the live log.
 * Returns {runId, start, deadline} and, when the previous lock was past its deadline, `stale` (that
 * lock, for recovery). Throws `refused: cycle <run> holds the lock until <iso>` while another run's
 * deadline has not passed.
 */
export function takeLock(main, { maxCycleMinutes, now = Date.now() }) {
  const max = minutes(maxCycleMinutes);
  const start = seconds(now);
  const runId = `${new Date(now).toISOString().slice(0, 19).replace(/\D/g, "")}-${randomBytes(4).toString("hex")}`;
  const lock = { runId, start, deadline: start + max * 60 + GRACE_S };
  fs.mkdirSync(liveDir(main), { recursive: true });
  const file = lockPath(main);
  // link(2) creates the lock whole or not at all, so no reader ever sees half a lock.
  const tmp = tempBeside(file, `${JSON.stringify(lock)}\n`);
  let stale;
  try {
    for (let tries = 0; ; tries++) {
      try {
        fs.linkSync(tmp, file);
        break;
      } catch (e) {
        if (!e || e.code !== "EEXIST" || tries >= 3) throw e;
      }
      const held = readLock(main);
      if (!held) continue;
      if (held.deadline > start) throw new Error(`refused: cycle ${held.runId} holds the lock until ${iso(held.deadline)}`);
      // Past its deadline: move it aside (one rename wins), then make sure the moved lock is the
      // stale one read above and not a fresh lock another `up` took in between.
      const aside = tempBeside(file, "");
      try {
        fs.renameSync(file, aside);
      } catch (e) {
        fs.rmSync(aside, { force: true });
        if (e && e.code === "ENOENT") continue;
        throw e;
      }
      const moved = JSON.parse(fs.readFileSync(aside, "utf8"));
      if (moved.runId !== held.runId) {
        try {
          fs.linkSync(aside, file);
        } finally {
          fs.rmSync(aside, { force: true });
        }
        throw new Error(`refused: cycle ${moved.runId} holds the lock until ${iso(moved.deadline)}`);
      }
      fs.rmSync(aside, { force: true });
      stale = held;
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  try {
    appendLive(main, runId, `start ${lock.start} deadline ${lock.deadline}`);
  } catch (e) {
    fs.rmSync(file, { force: true });
    throw new Error(`cannot append to ${liveLog(main)}: ${e.message}`);
  }
  return stale ? { ...lock, stale } : lock;
}

/**
 * Move the deadline by `maxCycleMinutes`, never past start + 3 × it; append the new deadline to the
 * live log, then rewrite the lock. Returns the new deadline. Throws `cap reached` when it cannot move.
 */
export function renew(main, { maxCycleMinutes, now = Date.now() }) {
  const max = minutes(maxCycleMinutes);
  const lock = readLock(main);
  if (!lock) throw new Error("no lock: no journey cycle is running");
  if (seconds(now) >= lock.deadline) throw new Error(`refused: the deadline of cycle ${lock.runId} passed at ${iso(lock.deadline)}`);
  const next = Math.min(lock.deadline + max * 60, lock.start + 3 * max * 60);
  if (next <= lock.deadline) throw new Error(`cap reached: cycle ${lock.runId} ends at ${iso(lock.deadline)} (start + 3 × max_cycle_minutes)`);
  // The log first: a log that runs longer than the lock only marks a gate live=1 needlessly.
  appendLive(main, lock.runId, `deadline ${next}`);
  const file = lockPath(main);
  fs.renameSync(tempBeside(file, `${JSON.stringify({ ...lock, deadline: next })}\n`), file);
  return next;
}

/** Append `<runId> end <now>` to the live log (a failed `up`, a `down`). */
export function appendEnd(main, runId, now = Date.now()) {
  appendLive(main, runId, `end ${seconds(now)}`);
}
