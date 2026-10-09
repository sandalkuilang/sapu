// argus-live-run.mjs — the journey lane's run record and teardown (spec §8 steps 1 and 11, `down`):
// run.json and its one writer path, the reaper, `down` and the recovery of stale runs.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closeSessions, removeSockets, sweepSessions } from "./argus-live-cli.mjs";
import { LIVE_FILE, loadLive, secretEnv, secretsIn } from "./argus-live-config.mjs";
import { checkDockerRuntime, gateOf } from "./argus-live-docker.mjs";
import { appendEnd, claim, claimBusy, claimPath, liveDir, readLock, releaseLock, RUN_ID, runIdOk, staleRecords } from "./argus-live-lock.mjs";
import { gitCommonDir } from "./sapu-contract.mjs";
import { processTable, readFrom, redact, refreshGroups, run, runAsync, sleep, sleepSync, stopRecordedGroups, tail, tempBeside, withFileLock, within } from "./argus-live-proc.mjs";

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

/** The CLI the run starts its own helpers with (`argus-live.mjs reap <runId>`, `proxy <runId>`). */
export const CLI = fileURLToPath(new URL("./argus-live.mjs", import.meta.url));

/** run.json, or null when there is none. Throws `refused: …` on one that cannot be read: it is never guessed at. */
export function readRun(main) {
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

/**
 * The env_file's values as `up` read them, recovered from run.json (its `env`, and each stop record's,
 * hold the expanded values): for each value whose template in `config` (`env`, a start entry's `env`)
 * names `${NAME}`, the value NAME had (secretsIn), or the whole recorded value when the template no
 * longer matches it. Keyed `up:…`, so they never stand for a variable. The CLI and the reaper mask with
 * these as well as the env_file's values now: an env_file edited since `up` does not unmask the values a
 * stop replays with. {} without a readable run.json or a config.
 */
export function recordedSecrets(main, config) {
  let rec;
  try {
    rec = readRun(main);
  } catch {
    rec = null;
  }
  if (!rec || !config || typeof config !== "object") return {};
  const out = {};
  const take = (templates, recorded, where) => {
    for (const [k, t] of Object.entries(templates ?? {})) {
      const v = recorded && recorded[k];
      if (typeof t !== "string" || !/\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(t) || typeof v !== "string") continue;
      const found = secretsIn(t, v);
      if (!found) out[`up:${where}.${k}`] = v;
      else for (const [n, x] of Object.entries(found)) out[`up:${where}.${k}:${n}`] = x;
    }
  };
  take(config.env, rec.env, "env");
  for (const e of Array.isArray(config.start) ? config.start : []) {
    for (const s of (rec.stops ?? []).filter((x) => x && e && x.name === e.name)) take({ ...(config.env ?? {}), ...(e.env ?? {}) }, s.env, `start.${e.name}.env`);
  }
  return out;
}

/** Writes run.json whole (beside, then renamed into place), mode 0600: its stop records carry the run's env. Only updateRun calls it. */
function putRun(main, rec) {
  const file = runPath(main);
  fs.mkdirSync(liveDir(main), { recursive: true });
  fs.renameSync(tempBeside(file, `${JSON.stringify(rec, null, 2)}\n`, 0o600), file);
}

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
 * Writes the keys of `state` into `<MAIN>/.argus/live/run.json` (spec §8 step 11's table names each key's
 * one writer), through updateRun: merged over the record as it stands, so every key `state` does not
 * hold — another owner's (`sessions`, `slots`, `loginFailed`, `reaper`, `internal`, `closing`) or one
 * this version does not know — is kept as written. `up` and `up --fresh` pass only the keys they own
 * (UP_KEYS). `worktree` is the absolute path the guard reads (null until it exists). Groups go through
 * refreshGroups — `/bin/sh -c <one command>` execs that command, so what ps shows is what `down` and
 * recovery can match; without ps they stay as recorded. `create: false` (every write of `up` after its
 * first) refuses to write a run.json a `down` removed.
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
  const own = { ...state };
  if (Object.hasOwn(state, "groups")) own.groups = refreshGroups(state.groups ?? [], table, secrets);
  if (Object.hasOwn(state, "worktree")) own.worktree = wt;
  updateRun(main, state.runId, (prev) => ({ worktree: null, ports: {}, origins: [], groups: [], stops: [], sessions: [], ...(prev ?? {}), ...own }), { create });
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
export async function replayStop(s, { secrets, asyncRunner, timeoutMs, logs, note }) {
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

/** Refuses a path that is a symlink, not a directory, or not the current user's. */
export function ownDir(dir) {
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink()) throw new Error(`refused: ${dir} is a symlink; remove it`);
  if (!st.isDirectory()) throw new Error(`refused: ${dir} is not a directory`);
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw new Error(`refused: ${dir} belongs to another user`);
  if ((st.mode & 0o777) !== 0o700) fs.chmodSync(dir, 0o700);
}

/**
 * `$TMPDIR/sapu-live`, private to this user (0700, never a symlink), holding every run's worktree and
 * HOME outside the repo. Created when missing; refused when it would lie inside the repo `realMain`,
 * before and after it exists.
 */
export function liveRoot(realMain) {
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
  const admin = path.join(gitCommonDir(main) ?? path.join(main, ".git"), "worktrees");
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

export const repoName = (realMain) => path.basename(realMain).replace(/[^A-Za-z0-9._-]/g, "-");

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
 * Removes what the run kept under `.argus/live/<runId>/` that holds secrets or the CLI's state: in each
 * slot directory (`<n>/`, `up/`, `r/`) its `.playwright/` (configs, a storage state), `state.json`
 * (counters, created accounts' passwords), `lock` and `totp.json`; and the run's `totp.json`. `out/`,
 * `files/`, `returns/`, `repro/` and `logs/` (the secret ledger among them, 0600) stay (evidence for the
 * owner, the repro and scrub). Symlinks are removed, never followed.
 * Each slot's files go under its lock (withFileLock on `<slot>/lock`, waiting at most `slotWaitMs`), so a
 * `pw` call or a handoff still writing finishes first; a lock still held after that is noted and the files
 * go anyway (those writers re-check run.json before they write, slots.mjs liveSlot).
 */
async function removeRunSecrets(main, runId, note, slotWaitMs) {
  const dir = path.join(liveDir(main), runId);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const remove = (p) => {
    try {
      fs.lstatSync(p);
    } catch {
      return;
    }
    removeTree(p, note);
  };
  remove(path.join(dir, "totp.json"));
  for (const e of entries) {
    if (!e.isDirectory() || ["logs", "returns", "repro"].includes(e.name)) continue;
    const clear = () => {
      for (const f of [".playwright", "state.json", "lock", "totp.json"]) remove(path.join(dir, e.name, f));
    };
    try {
      await withFileLock(path.join(dir, e.name, "lock"), clear, { waitMs: slotWaitMs });
    } catch (err) {
      note(`slot ${e.name}: ${err.message}; its files removed without its lock`);
      clear();
    }
  }
}

/** Runs one teardown step; an error is noted and the teardown goes on. */
export async function guarded(what, note, fn) {
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
 * Without a drain (`down`'s `drain` absent: a test's call, or recovery), the sessions the teardown closes
 * are closed undrained: each that had a daemon marks the run's secret ledger (argus-live-ledger.mjs
 * `ledgerFile`, `logs/secrets.jsonl`, 0600) incomplete, `<session> closed undrained`, so scrub refuses
 * the run rather than miss what they held.
 */
function markUndrained(main, runId, sessions) {
  const lines = (Array.isArray(sessions) ? sessions : []).filter((x) => x && typeof x.name === "string" && x.daemon).map((x) => `${JSON.stringify({ c: "incomplete", v: `${x.name} closed undrained` })}\n`);
  if (!lines.length) return;
  const logs = logsDir(main, runId);
  fs.mkdirSync(logs, { recursive: true, mode: 0o700 });
  fs.appendFileSync(path.join(logs, "secrets.jsonl"), lines.join(""), { mode: 0o600 });
}

/**
 * The teardown's steps in spec §8's order, shared by `down` and recovery: one list (the proxy, then the
 * CLI sessions by name, come after the process groups). Each runs
 * guarded: a failure is noted and the next step runs. `t` = {main, runId, rec, mode: "down" | "recover",
 * secrets, runner, asyncRunner, graceMs, stopTimeoutMs, claimWaitMs, slotWaitMs, refresh, drain, note}.
 */
const TEARDOWN = [
  // `down` only: a finding is reported, never stops the teardown.
  ["docker runtime gate", (t) => (t.mode === "down" && t.rec && Number.isFinite(t.rec.since) && t.rec.env && typeof t.rec.worktree === "string" ? checkDockerRuntime({ ...gateOf(t.rec, t.rec.groups), main: t.main, runner: t.runner }) : undefined)],
  // Last started first, each bounded by stopTimeoutMs.
  ["stops", async (t) => {
    for (const s of [...(t.rec?.stops ?? [])].reverse()) await guarded(`stop ${s && s.name}`, t.note, () => replayRecorded(s, t));
  }],
  // Only groups that still run what was recorded (sameGroup); setup groups included.
  // The run's own helpers (`internal`: the proxy) have their own steps.
  ["process groups", (t) => stopRecordedGroups((t.rec?.groups ?? []).filter((g) => !(g && g.internal)), { runner: t.runner, secrets: t.secrets, graceMs: t.graceMs, refresh: t.refresh, note: t.note })],
  ["the proxy", (t) => stopRecordedGroups((t.rec?.groups ?? []).filter((g) => g && g.internal && g.name === "proxy"), { runner: t.runner, secrets: t.secrets, graceMs: t.graceMs, refresh: t.refresh, note: (l) => t.note(`the proxy: ${l}`) })],
  // Each session drained first (`drain`: its values into the run's secret ledger; else marked undrained),
  // closed by name, then its daemon and browser killed by identity (closeSessions).
  // Then whatever a session of the run left that no record holds (sweepSessions: its daemons by name, orphaned browsers by HOME).
  ["CLI sessions", async (t) => {
    if (t.drain) await guarded("draining the CLI sessions", t.note, () => t.drain(t.rec?.sessions ?? []));
    else await guarded("the secret ledger", t.note, () => markUndrained(t.main, t.runId, t.rec?.sessions));
    await closeSessions(t.rec?.sessions, { js: t.rec?.browser?.js ?? null, runner: t.runner, cliRunner: t.asyncRunner, graceMs: t.graceMs, note: t.note });
    const homes = [...new Set([...(t.rec?.sessions ?? []).map((x) => x && x.home), t.rec?.home ? path.join(t.rec.home, "browser") : null].filter((h) => typeof h === "string"))];
    await sweepSessions({ match: (name) => name.startsWith(`${t.runId}-`), homes, runner: t.runner, graceMs: t.graceMs, note: t.note });
    for (const h of homes) removeSockets(h);
  }],
  ["the run's directories", async (t) => {
    removeRunDirs(t.main, t.runId, t.rec?.worktree, { runner: t.runner, note: t.note });
    await removeRunSecrets(t.main, t.runId, t.note, t.slotWaitMs ?? 10_000);
  }],
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
 * holder): the teardown is done by then, and the lock and its end line wait for the owner. `slotWaitMs`
 * bounds the wait for each slot's lock before its files go (removeRunSecrets). `drain(records)` (from
 * argus-live-session.mjs, supplied by the caller: this module sits below it) drains the run's recorded
 * sessions into its secret ledger before they close; without one they close undrained, and the ledger
 * says so (markUndrained).
 */
export async function down(main, { runId, record, secrets = {}, runner = run, asyncRunner = runAsync, graceMs = 10_000, stopTimeoutMs = 120_000, claimWaitMs = 2000, slotWaitMs = 10_000, drain = null } = {}) {
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
  await teardown({ main, runId, rec, mode: "down", secrets, runner, asyncRunner, graceMs, stopTimeoutMs, claimWaitMs, slotWaitMs, refresh: Boolean(record), drain, note });
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
 * names `runId`; otherwise it exits without acting. What it did goes to `<logs>/reaper.log`. `drain`
 * goes to `down` (the sessions drained into the run's secret ledger before they close).
 */
export async function reap(main, runId, { pollMs = 60_000, drain = null } = {}) {
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
  const live = loadLive(main);
  const secrets = { ...recordedSecrets(main, live.config), ...live.secrets };
  try {
    const { report } = await down(main, { runId, secrets, drain });
    for (const line of report) say(line);
    say("down finished");
    return "down";
  } catch (e) {
    say(redact(e.message, secrets));
    return "failed";
  }
}
