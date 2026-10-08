// argus-live-cli.mjs — running the pinned browser CLI (spec §9) and closing its sessions: the CLI's
// clean environment, one CLI call, session names, and the teardown's "CLI sessions" step (each session
// closed by name, then its daemon and browser killed by identity). It sits below argus-live-run.mjs in
// the module DAG, since the teardown there closes sessions; installing the CLI and the per-slot config
// are argus-live-browser.mjs's.
import fs from "node:fs";
import { run, runAsync, sameStart, sleep, startTime } from "./argus-live-proc.mjs";

/**
 * The CLI's whole environment: PATH, USER, SHELL, TMPDIR, LANG and the LC_* variables the owner set,
 * HOME = `home` (the run's `<HOME>/browser`, so neither the owner's global CLI config nor its caches are
 * read), NO_UPDATE_NOTIFIER=1 (no registry call). Never PLAYWRIGHT_*, PWTEST_*, NODE_OPTIONS or XDG_*.
 */
export function cliEnv(home, ownerEnv = process.env) {
  const env = {};
  for (const [k, v] of Object.entries(ownerEnv)) {
    if (typeof v === "string" && (["PATH", "USER", "SHELL", "TMPDIR", "LANG"].includes(k) || /^LC_[A-Z_]+$/.test(k))) env[k] = v;
  }
  return { ...env, HOME: home, NO_UPDATE_NOTIFIER: "1" };
}

/**
 * One CLI call: `node <js> -s=<session> ...args` in `cwd` (the slot's directory: its `.playwright/`
 * scopes the CLI's config and session namespace), under cliEnv(home), in its own process group, killed
 * with whatever it left in that group when it exits or at `timeoutMs` (the daemon `open` starts is
 * detached into a group of its own, so it stays) → {code, stdout, stderr, timedOut}.
 */
export async function runCli({ js, session, args, cwd, home, timeoutMs = 60_000, runner = runAsync }) {
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
 * Every failure is noted and the next record is closed.
 */
export async function closeSessions(records, { js = null, runner = run, cliRunner = runAsync, graceMs = 10_000, note = () => {} } = {}) {
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
  if (!targets.length) return;
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

