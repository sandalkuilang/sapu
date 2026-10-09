// argus-live-session.mjs — one account's CLI session as the wrapper drives it (spec §9 "The wrapper",
// "Login"): opened on first use, hooked (the in-daemon listeners every document and popup is watched by)
// and signed in, opened again when its browser is gone, observed after each command, and signed in again
// when logged_in is lost from the page and from a probe tab. `pw`'s explorer
// calls and the repro runner's steps share it, so neither keeps a copy of the session handling.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { openSession, SIGNAL_SCRIPT } from "./argus-live-browser.mjs";
import { closeSessions, runCli, sessionAlive, sessionName } from "./argus-live-cli.mjs";
import { loadLive } from "./argus-live-config.mjs";
import { commandLogin, login, loginCode, loginPlan, runCode } from "./argus-live-login.mjs";
import { run, runAsync } from "./argus-live-proc.mjs";
import { logsDir, recordedSecrets } from "./argus-live-run.mjs";
import { readSlotState, stillLive } from "./argus-live-slots.mjs";

/** The CLI's answer when the session's browser is gone (0.1.22: "The browser '<name>' is not open, please run open first"). */
const NOT_OPEN = /is not open, please run open first/;

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/** Every value the output must never show: the env_file's (now and as `up` read them), every role password and TOTP secret, and the passwords of accounts the journey created. */
export function maskSecrets(main, config, live, state) {
  const out = { ...recordedSecrets(main, config), ...loadLive(main).secrets };
  for (const [role, r] of Object.entries((live && live.roles) || {})) {
    (r && Array.isArray(r.users) ? r.users : []).forEach((u, i) => {
      if (u && typeof u.password === "string") out[`role:${role}.${i}.password`] = u.password;
      if (u && typeof u.totp_secret === "string") out[`role:${role}.${i}.totp`] = u.totp_secret;
    });
  }
  for (const [a, c] of Object.entries(state.created ?? {})) if (c && typeof c.password === "string") out[`created:${a}`] = c.password;
  return out;
}

/** True when `u` is a user of some role of the expanded config `live`, compared trimmed and without case. */
export function configuredUser(live, u) {
  const norm = (x) => String(x).trim().toLowerCase();
  return Object.values((live && live.roles) || {}).some((r) => (r && Array.isArray(r.users) ? r.users : []).some((x) => x && typeof x.user === "string" && norm(x.user) === norm(u)));
}

/**
 * Appends one re-login probe to the run's `logs/probes.jsonl` (0600): `{slot, account, url, start, end}`
 * (epoch ms), so the probe tab's request to the role's base_url is told apart from the page's own.
 */
function logProbe(main, runId, entry) {
  try {
    const logs = logsDir(main, runId);
    fs.mkdirSync(logs, { recursive: true, mode: 0o700 });
    fs.appendFileSync(path.join(logs, "probes.jsonl"), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  } catch {
    // the `probed:` line still tells it
  }
}

/**
 * The driver of account `account`'s session in slot `slot` of run `runId` (`rec` its run.json as the
 * caller read it, `live` the expanded config, `envSecrets` the env_file's values, `slotRec` the slot's
 * run.json record, `dir` the slot's directory, `js` the installed CLI) → `{name, plan, role, state,
 * credentials, cli, stage, code, ensure, signIn, gone, reopen, observe, relogin}`:
 * - `state`: the account's `{signedIn, lastState, consoleSeen}` from the slot's state.json, replaced by
 *   `{signedIn}` when the session opens again; the caller saves it.
 * - `credentials()`: those of an account the journey created and signed in with `login` (the slot's
 *   state.json `created`), else its allocated user's (`created: false`), else null; `credentials` (a
 *   parameter) replaces it.
 * - `cli(args, timeoutMs)`: one CLI call in the slot's directory, under the run's browser HOME;
 *   `stage(which, payload)` a login stage (loginCode) and `code(text, timeoutMs)` a template the caller
 *   built, each through runCode.
 * - `ensure()` → `{record, opened, events}`: the recorded session with a daemon, else one opened now
 *   (stillLive; a login-command role's with the storage state commandLogin wrote, which signs it in;
 *   openSession) and hooked: the `hook` stage with the run's origins, the signal script and `capBytes`
 *   (the bytes of distinct header values its context records); a hook that failed is `harness: hook
 *   failed` among `events`, and the session is used all the same.
 * - `signIn(c)` → login's answer (`failures`, when given, records a created account's failures);
 *   `state.signedIn` set on success.
 * - `gone(res, record)`: the command failed and the CLI said the browser is not open, or the recorded
 *   daemon no longer runs.
 * - `reopen(record)` → events: the session closed and opened again (and hooked), signed in unless anon or
 *   a login-command role (`session-reopened: <role.k>`, and `harness: login failed` when that failed).
 * - `observe()` → `{o, events}`: the observe stage (signals, logged_in, URL, aria); `state.lastState`
 *   the hash the loop rule reads; a failure → `harness: observation failed`.
 * - `relogin(o)` → events: when `o` lacks logged_in while the account is signed in, a probe tab at the
 *   role's base_url (`probed: <role.k>`, logged to `logs/probes.jsonl`), and when it lacks it too, one
 *   sign-in (`re-logged-in: <role.k>` or `harness: login failed`; a login-command role's session is
 *   closed and opened again).
 */
export function sessionDriver({ main, runId, slot, account, rec, live, envSecrets, slotRec, dir, js, credentials = null, failures = null, capBytes = 4 * 2 ** 20, runner = run, cliRunner = runAsync }) {
  const role = account.split(".")[0];
  const r = live.roles && live.roles[role];
  const plan = loginPlan(live, role);
  const name = sessionName(runId, slot, account);
  const home = () => path.join(rec.home, "browser");
  let record = null;
  const d = {
    name,
    plan,
    role,
    state: { ...((readSlotState(dir).sessions ?? {})[account] ?? {}) },
    credentials:
      credentials ??
      (() => {
        const c = (readSlotState(dir).created ?? {})[account];
        if (c && typeof c.user === "string" && typeof c.password === "string") return { user: c.user, password: c.password, totpSecret: null, created: true };
        const u = ((r && r.users) || []).find((x) => x && x.user === slotRec.accounts[account]);
        return u ? { user: u.user, password: u.password, totpSecret: u.totp_secret ?? null, created: false } : null;
      }),
    cli: (args, timeoutMs = plan.settleMs + 60_000) => runCli({ js, session: name, args, cwd: dir, home: home(), timeoutMs, runner: cliRunner }),
    stage: (which, payload) => d.code(loginCode(which, payload)),
    code: (text, timeoutMs = 4 * plan.settleMs + 60_000) => runCode({ js, session: name, cwd: dir, home: home(), code: text, timeoutMs, runner: cliRunner }),
  };
  /** Opens the session (a login-command role's with a fresh storage state, which signs it in) and hooks it → the hook's events. */
  const open = async () => {
    stillLive(main, runId); // an up --fresh or a down may have begun while this call waited
    let storageState = null;
    if (r && r.login) storageState = await commandLogin({ role, live, env: rec.env, worktree: rec.worktree, secrets: envSecrets, origins: rec.origins ?? [], dir, runner: cliRunner });
    record = await openSession({ main, runId, slot, account, js, home: home(), storageState, runner, cliRunner });
    d.state = { signedIn: Boolean(storageState) };
    const runOrigins = [...new Set([...(rec.origins ?? []), ...(rec.allowOrigins ?? [])].map((o) => new URL(o).origin))];
    try {
      await d.stage("hook", { runOrigins, signals: SIGNAL_SCRIPT, capBytes });
      return [];
    } catch {
      return ["harness: hook failed"];
    }
  };
  d.ensure = async () => {
    const found = (rec.sessions ?? []).find((x) => x && x.name === name && x.daemon);
    if (found) {
      record = found;
      return { record, opened: false, events: [] };
    }
    const events = await open();
    return { record, opened: true, events };
  };
  /** Signs the open session in with the account's credentials (login, which never retries a failed account) → its answer. */
  d.signIn = async (c = d.credentials()) => {
    const res = c ? await login({ main, runId, session: name, account, user: c.user, password: c.password, totpSecret: c.totpSecret, plan, js, home: home(), cwd: dir, runner: cliRunner, ...(c.created && failures ? { failures } : {}) }) : { ok: false, reason: "rejected" };
    if (res.ok) d.state.signedIn = true;
    return res;
  };
  d.gone = (res, session) => res.code !== 0 && (NOT_OPEN.test(`${res.stdout}\n${res.stderr}`) || !sessionAlive(session, runner));
  d.reopen = async (session) => {
    await closeSessions([session], { js, runner, cliRunner, graceMs: 3000 });
    const hooked = await open();
    const events = [`session-reopened: ${account}`, ...hooked];
    if (role !== "anon" && !d.state.signedIn && !(r && r.login) && !(await d.signIn()).ok) events.push("harness: login failed");
    return events;
  };
  d.observe = async () => {
    let o = null;
    const events = [];
    try {
      o = await d.stage("observe", { loggedIn: role === "anon" ? null : plan.loggedIn });
    } catch {
      events.push("harness: observation failed");
    }
    if (o && typeof o === "object") d.state.lastState = sha256(`${o.url ?? ""}\n${o.aria ?? ""}`);
    return { o, events };
  };
  d.relogin = async (o) => {
    const events = [];
    if (!(o && o.loggedIn === false && role !== "anon" && d.state.signedIn)) return events;
    // The probe tab's request is the wrapper's: told outside the fence and logged with its times.
    const start = Date.now();
    let probe = null;
    try {
      probe = await d.stage("probe", { url: plan.base, loggedIn: plan.loggedIn, settleMs: plan.settleMs });
    } catch {
      probe = null;
    }
    events.push(`probed: ${account}`);
    logProbe(main, runId, { slot, account, url: plan.base, start, end: Date.now() });
    if (!probe) events.push("harness: probe failed");
    if (probe && !probe.in) {
      d.state.signedIn = false;
      let ok = false;
      try {
        if (r && r.login) {
          await closeSessions([record], { js, runner, cliRunner, graceMs: 3000 });
          events.push(...(await open()));
          ok = d.state.signedIn;
        } else ok = (await d.signIn()).ok;
      } catch {
        ok = false;
      }
      events.push(ok ? `re-logged-in: ${account}` : "harness: login failed");
    }
    return events;
  };
  return d;
}
