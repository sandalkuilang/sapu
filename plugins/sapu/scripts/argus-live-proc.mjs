// argus-live-proc.mjs — processes for the journey lane's live instance (spec §8): the runners (`run`,
// `runAsync`), process groups and their kills, and process identity (a pid and its start time), which
// every kill of a teardown asks first; and the small helpers the other argus-live modules share
// (redact, tail, within, resolveLink, tempBeside).
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Write `data` to a temp file beside `file` (created with `mode`, when given); returns the temp path. */
export function tempBeside(file, data, mode) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  fs.writeFileSync(tmp, data, mode === undefined ? undefined : { mode });
  return tmp;
}

/**
 * The one runner every external command goes through, so tests can substitute it:
 * `argv` without a shell → {status, stdout, stderr, error} (spawnSync's).
 */
export function run(argv, opts = {}) {
  return spawnSync(argv[0], argv.slice(1), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024, ...opts });
}

/** `p` is `root` or lies under it (both already real paths). */
export const within = (root, p) => {
  const r = path.relative(root, p);
  return r === "" || (r !== ".." && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r));
};

/** Symlinks followed while resolving one path before giving up (Linux's MAXSYMLINKS). */
export const MAX_HOPS = 40;

/**
 * The real path `p` leads to, following every symlink on the way even when the end is missing (a
 * broken link, or a chain through one): the real path of the nearest existing ancestor plus the
 * missing rest. Null when it takes more than MAX_HOPS links (a loop): the caller fails closed.
 */
export function resolveLink(p) {
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

/** `text` with every non-empty secret value replaced by `***` (longest first). */
export function redact(text, secrets = {}) {
  const values = [...new Set(Object.values(secrets).filter((v) => typeof v === "string" && v !== ""))].sort((a, b) => b.length - a.length);
  return values.reduce((t, v) => t.split(v).join("***"), String(text ?? ""));
}

/** The last lines of a command's output, for an error message. */
export const tail = (text) => (text || "").trim().split("\n").slice(-5).join(" | ").slice(-500);

/** What `file` gained from byte `from` on (at most its last 64 KiB). */
export function readFrom(file, from) {
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
 * to `onStart` before anything is awaited). An `onStart` that throws (its group could not be recorded:
 * a `down` sealed run.json) gets the group SIGKILL at once and resolves with that error: nothing is left
 * running that no record names. On `timeoutMs` the whole group gets SIGKILL; with `killAfter`, so does
 * whatever the group left running once it exits. With `capture`, stdout is collected (up to 1 MiB) until
 * it closes or `DRAIN_MS` after the exit → {status, signal, timedOut, error, stdout, exited}, `exited`
 * true only when the process exited (so a caller marks its record exited only then); with `capture` and
 * `stdio[2]` "pipe", stderr is collected the same way (`stderr`).
 */
export function runAsync(argv, { cwd, env, timeoutMs, stdio = ["ignore", "ignore", "ignore"], capture = false, killAfter = false, onStart = () => {} } = {}) {
  return new Promise((done) => {
    let finished = false;
    let timedOut = false;
    let timer;
    let stdout = "";
    let stderr = "";
    let child;
    const finish = (r) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (killAfter && child && child.pid) killGroup(child.pid);
      done({ timedOut, stdout, ...(capture && child && child.stderr ? { stderr } : {}), ...r });
    };
    try {
      child = spawn(argv[0], argv.slice(1), { cwd, env, detached: true, stdio: capture ? [stdio[0], "pipe", stdio[2]] : stdio });
    } catch (e) {
      finish({ error: e });
      return;
    }
    child.once("error", (e) => finish({ error: e }));
    if (capture) child.stdout.on("data", (d) => stdout.length < 1 << 20 && (stdout += d));
    if (capture && child.stderr) child.stderr.on("data", (d) => stderr.length < 1 << 20 && (stderr += d));
    if (!child.pid) return;
    try {
      onStart(child.pid);
    } catch (e) {
      killGroup(child.pid);
      finish({ error: e });
      return;
    }
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        killGroup(child.pid);
      }, Math.max(0, timeoutMs));
    }
    child.once("exit", (status, signal) => {
      if (!capture) return finish({ status, signal, exited: true });
      const drained = () => finish({ status, signal, exited: true });
      const open = [child.stdout, child.stderr].filter((s) => s && !s.closed && !s.readableEnded);
      if (!open.length) return drained();
      let left = open.length;
      for (const s of open) s.once("close", () => --left === 0 && drained());
      setTimeout(drained, DRAIN_MS);
    });
  });
}

/** `deadline` (epoch seconds) as milliseconds left; refuses a missing one. */
export function msLeft(deadline, what) {
  if (!Number.isInteger(deadline)) throw new Error(`failed: ${what} needs the lock's deadline (epoch seconds)`);
  return deadline * 1000 - Date.now();
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
export function startTime(pid, runner = run) {
  const ticks = procStart(pid);
  if (ticks) return ticks;
  const r = runner(["ps", "-o", "lstart=", "-p", String(pid)], { env: C_LOCALE() });
  const m = !r.error && r.status === 0 && String(r.stdout).trim().match(LSTART);
  return m ? m[1].replace(/\s+/g, " ") : undefined;
}

/** Every process as {pid, ppid, pgid, started, command} (`ps -A -ww -o pid= -o ppid= -o pgid= -o lstart= -o command=`, the same on macOS and Linux; on Linux `started` is the boot ticks from /proc where it can be read, as startTime gives them). */
export function processTable(runner) {
  const r = runner(["ps", "-A", "-ww", "-o", "pid=", "-o", "ppid=", "-o", "pgid=", "-o", "lstart=", "-o", "command="], { env: C_LOCALE() });
  if (r.error || r.status !== 0) throw new Error(`failed: ps could not list processes: ${(r.error && r.error.message) || tail(r.stderr)}`);
  const out = [];
  for (const line of r.stdout.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    const t = m && m[4].match(LSTART);
    if (t) out.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), started: procStart(Number(m[1])) ?? t[1].replace(/\s+/g, " "), command: m[4].slice(t[0].length).trim() });
  }
  return out;
}

/**
 * True when two recorded start times name the same process start: boot ticks (`ticks:<n>`) only when
 * equal; `ps -o lstart` times when equal or at most 1 s apart (lstart is derived from a boot time that
 * drifts). A reused pid starts far later.
 */
export function sameStart(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (String(a).startsWith("ticks:") || String(b).startsWith("ticks:")) return false;
  const [x, y] = [Date.parse(a), Date.parse(b)];
  return Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) <= 1000;
}

/** The processes of group `pgid` in `table`, as recorded: {pid, started, cmdline} (secret values masked). */
export const membersOf = (table, pgid, secrets) => table.filter((p) => p.pgid === pgid).map((p) => ({ pid: p.pid, started: p.started, cmdline: redact(p.command, secrets) }));

/** Blocks this thread for `ms` (updateRun is synchronous: its callers push records from synchronous code). */
export const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Each recorded group as `ps` shows it now (`table`, from processTable): `members` = [{pid, started,
 * cmdline}] of every process in it, `cmdline` = its leader's (a field for reports: identity is the pid
 * and start time). A group whose leader is not the process recorded — it exited (`exited`, set by
 * startEntry, runSetup and runStep) or started at another time — while a process holds its pid is left
 * as recorded: that process is someone else's.
 */
export function refreshGroups(groups, table, secrets) {
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
export function sameGroup(g, now) {
  const leader = now.find((p) => p.pid === g.pgid);
  if (leader && !g.exited && sameStart(leader.started, g.started)) return true;
  return now.some((p) => (g.members ?? []).some((m) => m && m.pid === p.pid && sameStart(m.started, p.started)));
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
export async function stopRecordedGroups(groups, { runner, secrets, graceMs, refresh = false, note }) {
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

/**
 * The pids the egress check lists: every process of each recorded group, unless the group is known to
 * be someone else's (its leader exited, or started at another time, while a process holds its pid). A
 * group whose identity cannot be confirmed (no start time recorded) is listed: for a check, doubt
 * means look. When recorded groups still have processes but none is listed, the listing cannot be
 * trusted (`failed: …`): an empty listing would pass anything.
 */
export function runPids(groups, runner) {
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

/** The process runs (one of another user's counts as running). */
const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return Boolean(e && e.code === "EPERM");
  }
};

/** This process's start time (startTime), read once. */
let ownStart;
const ownStarted = (runner) => (ownStart ??= startTime(process.pid, runner) ?? null);

/** A lock file whose content cannot be read as a holder is left this long before it counts as abandoned (a holder writes it whole, with link(2)). */
const UNREADABLE_LOCK_MS = 5000;

/**
 * Runs `fn` while holding the lock file `file` (spec §9: the TOTP steps and each slot's calls), → what
 * `fn` returns. The lock is created whole with link(2) (so it never exists half-written) holding
 * `{pid, started, nonce}`. A lock whose holder no longer runs (its pid gone, or running with another
 * start time), or older than `staleMs`, is taken over: renamed aside, and taken only when what was
 * renamed is still the lock judged stale (else put back). A live holder is waited for, polling, up to
 * `waitMs` → `failed: <file> is held by process <pid>`. Released (removed) only while it is still this
 * call's own.
 */
export async function withFileLock(file, fn, { waitMs = 30_000, staleMs = Infinity, runner = run, poll = 50 } = {}) {
  const mine = JSON.stringify({ pid: process.pid, started: ownStarted(runner), nonce: randomBytes(8).toString("hex") });
  const end = Date.now() + waitMs;
  for (;;) {
    const tmp = tempBeside(file, mine, 0o600);
    try {
      fs.linkSync(tmp, file);
      break;
    } catch (e) {
      if (!e || e.code !== "EEXIST") throw e;
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    let raw = null;
    let age = 0;
    try {
      raw = fs.readFileSync(file, "utf8");
      age = Date.now() - fs.statSync(file).mtimeMs;
    } catch {
      continue; // released meanwhile
    }
    let holder = null;
    try {
      holder = JSON.parse(raw);
    } catch {
      holder = null;
    }
    const dead = holder && Number.isInteger(holder.pid) && holder.pid > 0 ? (holder.started ? !sameStart(startTime(holder.pid, runner), holder.started) : !pidAlive(holder.pid)) : age > UNREADABLE_LOCK_MS;
    if (dead || age > staleMs) {
      takeOver(file, raw);
      continue;
    }
    if (Date.now() >= end) throw new Error(`failed: ${file} is held by process ${holder ? holder.pid : "unknown"}; try again`);
    await sleep(poll);
  }
  try {
    return await fn();
  } finally {
    try {
      if (fs.readFileSync(file, "utf8") === mine) fs.rmSync(file, { force: true });
    } catch {
      // taken over or removed: not this call's any more
    }
  }
}

/** Moves a stale lock `file` (whose content was `raw`) aside and removes it; one that changed meanwhile (another taker's fresh lock) is put back. */
function takeOver(file, raw) {
  const aside = `${file}.stale-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    fs.renameSync(file, aside);
  } catch {
    return; // gone meanwhile
  }
  try {
    if (fs.readFileSync(aside, "utf8") !== raw) fs.linkSync(aside, file);
  } catch {
    // another lock is in place already: the one put aside was stale or is now superseded
  } finally {
    fs.rmSync(aside, { force: true });
  }
}
