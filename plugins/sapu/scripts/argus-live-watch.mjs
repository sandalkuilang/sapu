// argus-live-watch.mjs — the record that keeps `show --follow` one watcher per repo: `.argus/live/watch.json` in
// the main checkout, {pid, start, port, dashboardPgid, dashboardStart}. A watcher is the process that holds the
// port the owner's tab points at; a second one would start a second dashboard on the same browser HOME.
import fs from "node:fs";
import path from "node:path";
import { liveDir } from "./argus-live-lock.mjs";
import { killGroup, membersOf, pidAlive, processTable, run, sameStart, startTime, takeOver, tempBeside } from "./argus-live-proc.mjs";

const watchFile = (main) => path.join(liveDir(main), "watch.json");

const readRecord = (file) => {
  try {
    const raw = fs.readFileSync(file, "utf8");
    return { raw, rec: JSON.parse(raw) };
  } catch {
    return { raw: null, rec: null };
  }
};

/**
 * True when the process the record names still runs: its pid is alive and, where a start time was recorded,
 * started at that time (a reused pid starts later). A record without a start time, or one whose pid's start
 * time cannot be read now (`ps` failed), can only be judged by the pid: an alive pid is taken for the watcher,
 * so it is never taken over or its dashboard group killed on a guess. `startOf` reads a start time (tests).
 */
export function watcherRuns(rec, runner = run, startOf = startTime) {
  if (!rec || !Number.isInteger(rec.pid) || rec.pid <= 0 || !pidAlive(rec.pid)) return false;
  if (!rec.start) return true;
  const now = startOf(rec.pid, runner);
  return now === undefined ? true : sameStart(now, rec.start);
}

/**
 * The dashboard group a dead watcher left, or null: the recorded group still has processes and, when its
 * leader is among them, that leader started at the recorded time (a leader gone with members left is still the
 * recorded group: a pid in use as a group id is never handed out again). A leader with no recorded start is
 * not told from another process, so it is left alone.
 */
export function leftDashboard(rec, runner = run) {
  const pgid = rec && rec.dashboardPgid;
  if (!Number.isInteger(pgid) || pgid <= 1) return null;
  let table;
  try {
    table = processTable(runner);
  } catch {
    return null;
  }
  const members = membersOf(table, pgid, []);
  if (!members.length) return null;
  const leader = members.find((p) => p.pid === pgid);
  if (leader && !(rec.dashboardStart && sameStart(leader.started, rec.dashboardStart))) return null;
  return pgid;
}

/**
 * Takes the repo's watcher record for this process, whose listening port is `port` →
 * `{live: <record>}` when another watcher runs (nothing is written), else `{mine: true}`. The record is
 * created whole with link(2), so it is never half written and two starters cannot both win. A record whose
 * watcher is gone is taken over after SIGTERM to the dashboard group it left (leftDashboard); an unreadable
 * one is taken over. A record is never written without this process's start time (it could not be told from a
 * reused pid later): when `ps` cannot give it, the claim fails, `failed: …`, and the watcher does not serve.
 */
export function claimWatch(main, port, runner = run, startOf = startTime) {
  const file = watchFile(main);
  const start = startOf(process.pid, runner);
  if (!start) throw new Error("failed: this watcher's start time cannot be read (ps gave none), so it cannot record itself as the repo's watcher; no watcher was started");
  fs.mkdirSync(liveDir(main), { recursive: true });
  const mine = `${JSON.stringify({ pid: process.pid, start, port, dashboardPgid: null, dashboardStart: null })}\n`;
  for (let tries = 0; tries < 10; tries++) {
    const tmp = tempBeside(file, mine, 0o600);
    try {
      fs.linkSync(tmp, file);
      return { mine: true };
    } catch (e) {
      if (!e || e.code !== "EEXIST") throw e;
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    const { raw, rec } = readRecord(file);
    if (raw === null && !fs.existsSync(file)) continue; // released meanwhile
    if (watcherRuns(rec, runner, startOf)) return { live: rec };
    const group = leftDashboard(rec, runner);
    if (group !== null) killGroup(group, "SIGTERM");
    takeOver(file, raw ?? "");
  }
  throw new Error(`failed: ${path.relative(main, file)} keeps changing hands; try again`);
}

/** Records the dashboard group this watcher's CLI leads (`pgid` null: none); a record that is no longer this process's is left alone. */
export function noteDashboard(main, pgid, runner = run) {
  const file = watchFile(main);
  const { rec } = readRecord(file);
  if (!rec || rec.pid !== process.pid) return;
  const next = { ...rec, dashboardPgid: pgid, dashboardStart: pgid === null ? null : (startTime(pgid, runner) ?? null) };
  const tmp = tempBeside(file, `${JSON.stringify(next)}\n`, 0o600);
  try {
    fs.renameSync(tmp, file);
  } catch {
    fs.rmSync(tmp, { force: true });
  }
}

/** Removes the record when it is this process's. */
export function releaseWatch(main) {
  const file = watchFile(main);
  const { rec } = readRecord(file);
  if (rec && rec.pid === process.pid) fs.rmSync(file, { force: true });
}
