// argus-live-cli.mjs — running the pinned browser CLI (spec §9) and closing its sessions: the CLI's
// clean environment, one CLI call, session names, and the teardown's "CLI sessions" step (each session
// closed by name, then its daemon and browser killed by identity). It sits below argus-live-run.mjs in
// the module DAG, since the teardown there closes sessions; installing the CLI and the per-slot config
// are argus-live-browser.mjs's.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { run, runAsync, sameStart, sleep, startTime } from "./argus-live-proc.mjs";

/**
 * The CLI's whole environment: PATH, USER, SHELL, LANG and the LC_* variables the owner set, HOME =
 * `home` (the run's `<HOME>/browser`, so neither the owner's global CLI config nor its caches are read),
 * TMPDIR = `<home>/tmp` (Chrome's profiles and the CLI's temp files die with the run's HOME; runCli
 * creates it), PWTEST_SOCKETS_DIR = socketsDir(home) (below), NO_UPDATE_NOTIFIER=1 (no registry call). No
 * PLAYWRIGHT_*, PWTEST_*, NODE_OPTIONS or XDG_* of the owner's.
 */
export function cliEnv(home, ownerEnv = process.env) {
  const env = {};
  for (const [k, v] of Object.entries(ownerEnv)) {
    if (typeof v === "string" && (["PATH", "USER", "SHELL", "LANG"].includes(k) || /^LC_[A-Z_]+$/.test(k))) env[k] = v;
  }
  return { ...env, TMPDIR: path.join(home, "tmp"), HOME: home, PWTEST_SOCKETS_DIR: socketsDir(home), NO_UPDATE_NOTIFIER: "1" };
}

/**
 * Where the CLI's daemons put their unix sockets. A socket path holds at most 103 bytes, and the CLI
 * builds `<TMPDIR>/pw-<hash>/browser/<16 hex>.sock`, which the run's HOME (under `$TMPDIR/sapu-live`)
 * exceeds on macOS (probed: "Socket directory path is too long"). So `/tmp/sapu-<uid>`, as tmux does:
 * short, and this user's own (ownDir creates it 0700 and refuses one that is not); inside it one
 * directory per run HOME (socketsDir), which the teardown removes: the CLI leaves its sockets behind.
 */
export const SOCKETS_ROOT = `/tmp/sapu-${typeof process.getuid === "function" ? process.getuid() : "user"}`;

/** The sockets directory of the CLI sessions whose HOME is `home`: `<SOCKETS_ROOT>/<12 hex of sha256(home)>`. */
export function socketsDir(home) {
  return path.join(SOCKETS_ROOT, createHash("sha256").update(String(home)).digest("hex").slice(0, 12));
}

/** `dir`, created 0700 when missing; refused when it is a symlink, not a directory, or another user's. */
function ownDir(dir) {
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
  } catch (e) {
    if (!e || e.code !== "EEXIST") throw e;
  }
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory() || (typeof process.getuid === "function" && st.uid !== process.getuid())) {
    throw new Error(`refused: ${dir} is not this user's own directory; remove it`);
  }
  if ((st.mode & 0o777) !== 0o700) fs.chmodSync(dir, 0o700);
}

/**
 * One CLI call: `node <js> -s=<session> ...args` in `cwd` (the slot's directory: its `.playwright/`
 * scopes the CLI's config and session namespace), under cliEnv(home), in its own process group, killed
 * with whatever it left in that group when it exits or at `timeoutMs` (the daemon `open` starts is
 * detached into a group of its own, so it stays) → {code, stdout, stderr, timedOut}.
 */
export async function runCli({ js, session, args, cwd, home, timeoutMs = 60_000, runner = runAsync }) {
  const tmp = path.join(home, "tmp");
  fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
  fs.chmodSync(tmp, 0o700);
  ownDir(SOCKETS_ROOT);
  ownDir(socketsDir(home));
  const r = await runner([process.execPath, js, `-s=${session}`, ...args], { cwd, env: cliEnv(home), timeoutMs, stdio: ["ignore", "pipe", "pipe"], capture: true, killAfter: true });
  if (r.error) throw new Error(`failed: the browser CLI could not run: ${r.error.message}`);
  return { code: r.status ?? null, stdout: r.stdout ?? "", stderr: r.stderr ?? "", timedOut: Boolean(r.timedOut) };
}

/** An account word as sessions carry it: `<role>.<k>`. */
const ACCOUNT = /^[a-z][a-z0-9_-]*\.[1-9][0-9]?$/;

/** A CLI session's name: `<runId>-<slot>-<role>.<k>` (slot a number, or `up` for the proving logins). */
export function sessionName(runId, slot, account) {
  if (!ACCOUNT.test(String(account))) throw new Error(`failed: ${account} is not an account (<role>.<k>)`);
  return `${runId}-${slot}-${account}`;
}

/** A recorded process ({pid, pgid, started}) when it still runs what was recorded; else null. */
function stillThere(p, runner) {
  if (!p || !Number.isInteger(p.pid) || p.pid <= 1 || p.pid === process.pid) return null;
  const now = startTime(p.pid, runner);
  if (!now) return null; // gone
  return sameStart(now, p.started) ? p : false;
}

/** Signals `p`'s group when `p` leads it (its recorded pgid is its pid: the daemon and Chrome's root do), else `p` alone. */
function signal(p, sig) {
  try {
    process.kill(p.pgid === p.pid ? -p.pid : p.pid, sig);
  } catch {
    // gone meanwhile
  }
}

/**
 * The teardown's "CLI sessions" step: each record `{name, cwd, home, daemon, browser}` (run.json
 * `sessions`) is closed by name — `close`, never `close-all` or `kill-all`, in its own cwd and HOME (the
 * session namespace), bounded by 15 s — while `js` (the installed CLI) exists. Then its daemon and its
 * browser root, each only while it still runs what was recorded (pid and start time), get SIGTERM to
 * their group, and SIGKILL after `graceMs`; one whose pid now runs another process is left and noted.
 * With `sockets` (the teardown, once every session of the run is closed), each record's sockets
 * directory (socketsDir of its HOME) is removed too. Every failure is noted and the next record is closed.
 */
export async function closeSessions(records, { js = null, runner = run, cliRunner = runAsync, graceMs = 10_000, note = () => {}, sockets = false } = {}) {
  const list = (Array.isArray(records) ? records : []).filter((s) => s && typeof s === "object");
  const cli = typeof js === "string" && fs.existsSync(js) ? js : null;
  for (const s of list) {
    if (!cli || typeof s.name !== "string" || typeof s.cwd !== "string" || !fs.existsSync(s.cwd)) continue;
    try {
      const r = await runCli({ js: cli, session: s.name, args: ["close"], cwd: s.cwd, home: s.home, timeoutMs: 15_000, runner: cliRunner });
      if (r.timedOut) note(`CLI session ${s.name}: close timed out after 15 s`);
    } catch (e) {
      note(`CLI session ${s.name}: ${e.message}`);
    }
  }
  const targets = [];
  for (const s of list) {
    for (const which of ["daemon", "browser"]) {
      const p = stillThere(s[which], runner);
      if (p === false) note(`CLI session ${s.name}: its ${which} (pid ${s[which].pid}) now runs another process; not killed`);
      else if (p) targets.push({ s, which, p });
    }
  }
  if (targets.length) await stop(targets, runner, graceMs, note);
  // The teardown's last word on them: their sockets (left behind by the CLI) go with the run.
  if (sockets) {
    for (const home of new Set(list.map((s) => s.home).filter((h) => typeof h === "string"))) {
      try {
        const dir = socketsDir(home);
        if (fs.lstatSync(dir).isDirectory()) fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // none
      }
    }
  }
}

/** SIGTERM to each target's group, SIGKILL after `graceMs` to those still running as recorded. */
async function stop(targets, runner, graceMs, note) {
  for (const t of targets) signal(t.p, "SIGTERM");
  const end = Date.now() + graceMs;
  let left = targets;
  while (left.length && Date.now() < end) {
    await sleep(100);
    left = left.filter((t) => stillThere(t.p, runner));
  }
  for (const t of left) {
    signal(t.p, "SIGKILL");
    note(`CLI session ${t.s.name}: its ${t.which} (pid ${t.p.pid}) outlived SIGTERM for ${graceMs} ms: killed`);
  }
}

