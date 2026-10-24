// argus-live-login.mjs — signing a role's account in (spec §9 "Login", §8 step 10): RFC 6238 codes with
// Node's own crypto and a time step never used twice for a secret, the wrapper's own browser code (argus-live-logincode.mjs, built
// from constant templates; every value a JSON literal, every target through targetCode), the login of a
// session (plain, two-step, modal, TOTP), a login command's storage state, and `up`'s proving logins. The
// explorer never sees any of it: a login's actions and values never reach the wrapper's output.
import { createHash, createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { openSession, slotConfig, slotDir, withRunKey, writeSlotConfig } from "./argus-live-browser.mjs";
import { closeSessions, removeSockets, runCli } from "./argus-live-cli.mjs";
import { secretEnv } from "./argus-live-config.mjs";
import { clean, nonce } from "./argus-live-fence.mjs";
import { liveDir, runIdOk } from "./argus-live-lock.mjs";
import { canonicalOrigin, exactHost } from "./argus-live-origin.mjs";
import { redact, run, runAsync, sleep, tail, tempBeside, withFileLock } from "./argus-live-proc.mjs";
import { logsDir, readRun, updateRun } from "./argus-live-run.mjs";
import { loginCode } from "./argus-live-logincode.mjs";

export { HELPERS, loginCode, loginStageSource } from "./argus-live-logincode.mjs";

// ---------------------------------------------------------------------------------------------------
// TOTP (RFC 6238 over RFC 4226: HMAC-SHA1, 30 s steps).

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_MS = 30_000;
/** A code is never handed out with less than this left in its step: it must reach the app in time. */
const MIN_LEFT_MS = 3000;

/** RFC 4648 base32 → a Buffer; case-insensitive, `=` padding and spaces ignored; any other character refused. */
export function base32Decode(s) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const c of String(s).toUpperCase().replace(/[\s=]/g, "")) {
    const i = BASE32.indexOf(c);
    if (i < 0) throw new Error("failed: a TOTP secret must be base32 (RFC 4648)");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

/** The RFC 6238 code of base32 `secret` at time step `step` (HMAC-SHA1, `digits` digits). */
export function totp(secret, step, digits = 6) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 10 ** digits).padStart(digits, "0");
}

/**
 * The time step to use for `secret`, never one handed out before for it, by any process: under the lock
 * `<file>.lock` (withFileLock; stale after 30 s or once its holder no longer runs), reads `file`
 * (`{<first 16 hex of sha256(secret)>: lastStep}`; the secret itself is never written), takes the current
 * step — the next one when under 3 s remain in it, or the one after the last handed out when that is not
 * earlier — and records it (0600) before releasing the lock. Then waits until that step has begun.
 */
export async function reserveStep(file, secret, { now = Date.now, sleep: wait = sleep } = {}) {
  const key = createHash("sha256").update(String(secret)).digest("hex").slice(0, 16);
  const step = await withFileLock(
    `${file}.lock`,
    () => {
      let used = {};
      try {
        used = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {
        used = {};
      }
      if (!used || typeof used !== "object" || Array.isArray(used)) used = {};
      const t = now();
      let s = Math.floor(t / STEP_MS);
      if ((s + 1) * STEP_MS - t < MIN_LEFT_MS) s += 1;
      const last = Number.isInteger(used[key]) ? used[key] : -1;
      if (s <= last) s = last + 1;
      fs.renameSync(tempBeside(file, `${JSON.stringify({ ...used, [key]: s })}\n`, 0o600), file);
      return s;
    },
    { staleMs: 30_000 },
  );
  const startsIn = step * STEP_MS - now();
  if (startsIn > 0) await wait(startsIn);
  return step;
}

/** The JSON of a `run-code` call's `### Result` section; anything else throws `failed: run-code: <its error>`. */
function resultOf(r) {
  const out = String(r.stdout ?? "");
  const m = /(?:^|\n)### Result\n([\s\S]*?)(?=\n### |\s*$)/.exec(out);
  if (r.code === 0 && m) {
    try {
      return JSON.parse(m[1].trim());
    } catch {
      // not JSON: reported below
    }
  }
  if (r.timedOut) throw new Error("failed: run-code timed out");
  const err = /(?:^|\n)### Error\n([^\n]*)/.exec(out);
  const why = err ? err[1] : String(r.stderr || out).trim().split("\n").pop() || `exit ${r.code}`;
  throw new Error(`failed: run-code: ${why.slice(0, 300)}`);
}

/**
 * Runs `code` (the wrapper's own, from loginCode) in session `session`: written to
 * `<cwd>/.playwright/run-<nonce>.js` (0600), run as `run-code --filename=<file>`, removed in `finally` →
 * the parsed result (resultOf). The CLI echoes the code it ran; that output is read here and never shown.
 */
export async function runCode({ js, session, cwd, home, code, timeoutMs = 120_000, runner = runAsync }) {
  const file = path.join(cwd, ".playwright", `run-${nonce()}.js`);
  fs.writeFileSync(file, withRunKey(code, cwd), { mode: 0o600, flag: "wx" });
  try {
    return resultOf(await runCli({ js, session, args: ["run-code", `--filename=${file}`], cwd, home, timeoutMs, runner }));
  } finally {
    fs.rmSync(file, { force: true });
  }
}

// ---------------------------------------------------------------------------------------------------
// Logins.

/**
 * How role `role` signs in, from the expanded config `live`: `{url, base, open, loggedIn, settleMs}` —
 * its own `base_url`, `login_url` (resolved on the base), `login_open` and `logged_in`, each falling back
 * to the top level; `settle_ms` (10 000 by default).
 */
export function loginPlan(live, role) {
  const r = (live.roles && live.roles[role]) || {};
  const base = new URL(r.base_url ?? live.base_url).href;
  return { url: new URL(r.login_url ?? live.login_url, base).href, base, open: r.login_open ?? live.login_open ?? null, loggedIn: r.logged_in ?? live.logged_in, settleMs: live.settle_ms ?? 10_000 };
}

/**
 * Where every process reserves its TOTP steps: `<MAIN>/.git/sapu-totp.json` (`{<16 hex of sha256(secret)>:
 * lastStep}`, no secret), kept across runs, so a cycle starting within 30 s of the last never reuses a
 * step the app saw (a refused code is never retried); `.argus/live/` when the checkout has no `.git` directory.
 */
export function totpFile(main) {
  let dir = path.join(main, ".git");
  try {
    if (!fs.statSync(dir).isDirectory()) dir = liveDir(main);
  } catch {
    dir = liveDir(main);
  }
  return path.join(dir, "sapu-totp.json");
}

/** Appends `<account> <user>: <detail>` (cleaned: its secrets masked, controls replaced) to the run's `logs/logins.log`; never shown to the explorer. */
function logDetail(main, runId, account, user, detail, secrets) {
  try {
    const dir = logsDir(main, runId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(path.join(dir, "logins.log"), `${account} ${user}: ${clean(String(detail), { secrets }).replace(/\n/g, " ")}\n`, { mode: 0o600 });
  } catch {
    // the log is a convenience; the refusal stands
  }
}

/**
 * The one line saying where a credentials stage took the page for a one-time-code step (`otp` as the stage
 * returned it): rule, URL path (a long id-like segment shown as `:id`) and field attributes, each cut to
 * 80 characters. The page wrote them, so they are plain strings here; no value of any field is ever in it.
 */
function otpDetail(otp) {
  const t = (v) => String(v ?? "").slice(0, 80);
  if (!otp || typeof otp !== "object") return "no-totp-secret: the page asked for a one-time code; its field could not be described";
  const path = t(otp.path).replace(/[A-Za-z0-9_-]{24,}/g, ":id");
  const field = JSON.stringify({ tag: t(otp.tag), type: t(otp.type), name: t(otp.name), id: t(otp.id), role: t(otp.role), label: t(otp.label) });
  return `no-totp-secret: one-time code step at ${path} taken by rule ${t(otp.rule)}, field ${field}`;
}

/** How long a stage may run: each of its waits is bounded by settle_ms, its actions by the CLI's timeouts. */
const stageTimeout = (plan) => 4 * plan.settleMs + 60_000;

/** The reason a judged stage failed: a 429 or a lockout text is a rate limit (a harness event), else rejected. */
function reasonOf(r) {
  if (r.status429 || r.lockout) return "rate-limited";
  if (r.state === "no-form") return "no-login-form";
  if (r.state === "error") return "error: playwright"; // Playwright's text may quote the page: its detail goes to the log
  return "rejected";
}

/**
 * Where the failed logins of the configured accounts are kept: run.json `loginFailed` (`{"<role>/<user>":
 * reason}`) of run `runId` → `{get(key) → reason | null, set(key, reason)}`. Only the wrapper's own logins
 * of configured accounts write it; an account the explorer created keeps its failures in its slot.
 */
export function runFailures(main, runId) {
  return {
    get: (key) => {
      const rec = readRun(main);
      return rec && rec.runId === runId && rec.loginFailed && Object.hasOwn(rec.loginFailed, key) ? rec.loginFailed[key] : null;
    },
    set: (key, reason) => updateRun(main, runId, (prev) => (prev ? { ...prev, loginFailed: { ...(prev.loginFailed ?? {}), [key]: reason } } : undefined), { create: false }),
  };
}

/**
 * Signs session `session` (account `account`, `<role>.<k>`) in as `user` (spec §9 "Login") by plan
 * `plan` (loginPlan): the credentials stage, then, when a one-time-code field shows, a code for a time
 * step reserved in the repo's TOTP file (totpFile, reserveStep) → `{ok: true, origins}` or `{ok: false,
 * reason, origins}`, reason `rejected`, `rate-limited` (a 429 or a lockout text), `no-login-form`,
 * `no-totp-secret` or `error: playwright` (fixed words: Playwright's own text, which may quote the page,
 * goes to the run's `logs/logins.log`, masked, as does the field that was taken for a code step when
 * there is no TOTP secret: the page's URL path, the field's tag, type, name, id, role and aria-label, and
 * the rule that picked it, never its value); `origins` = every origin the pages requested meanwhile. On
 * success the session's request and console lists are cleared (`requests --clear`, `console --clear`),
 * so the login's traffic never reaches the explorer. A failure is recorded in `failures` under
 * `"<role>/<user>"` (by default runFailures: run.json `loginFailed`, the configured accounts'), and a user
 * found there is refused at once, with no browser work: a failed login is never retried within a run
 * (lockouts), but for the one retry of a RETRYABLE reason (proveLogins, loginRetry: the first try records none: firstTryFailures). A CLI that fails (the session gone) throws `failed: …` and records nothing.
 */
export async function login({ main, runId, session, account, user, password, totpSecret = null, plan, js, home, cwd, runner = runAsync, now = Date.now, sleep: wait = sleep, failures = runFailures(main, runId) }) {
  runIdOk(runId);
  const role = String(account).split(".")[0];
  const key = `${role}/${user}`;
  const known = failures.get(key);
  if (known) return { ok: false, reason: known, origins: [] };
  const timeoutMs = stageTimeout(plan);
  const call = (stage, payload) => runCode({ js, session, cwd, home, code: loginCode(stage, { ...payload, loggedIn: plan.loggedIn, settleMs: plan.settleMs }), timeoutMs, runner });
  const origins = new Set();
  let r = await call("credentials", { url: plan.url, open: plan.open, user, password });
  for (const o of r.origins ?? []) origins.add(o);
  let reason = null;
  if (r.state === "otp") {
    if (!totpSecret) {
      reason = "no-totp-secret";
      logDetail(main, runId, account, user, otpDetail(r.otp), { password });
    } else {
      const step = await reserveStep(totpFile(main), totpSecret, { now, sleep: wait });
      r = await call("otp", { code: totp(totpSecret, step) });
      for (const o of r.origins ?? []) origins.add(o);
    }
  }
  if (!reason && r.state !== "in") reason = reasonOf(r);
  if (reason) {
    if (r.state === "error") logDetail(main, runId, account, user, r.error ?? "unknown", { password, ...(totpSecret ? { totp: totpSecret } : {}) });
    failures.set(key, reason);
    return { ok: false, reason, origins: [...origins] };
  }
  for (const args of [["requests", "--clear"], ["console", "--clear"]]) await runCli({ js, session, args, cwd, home, timeoutMs: 30_000, runner });
  return { ok: true, origins: [...origins] };
}

/** True when `host` (a cookie's domain, a leading dot dropped) is the host of one of `origins`, spelled as it spells it. */
const runHost = (host, origins) => {
  const h = exactHost(String(host).replace(/^\./, ""));
  return Boolean(h) && origins.some((o) => exactHost(new URL(o).hostname) === h);
};

/**
 * A login command's storage state (spec §9: `login: {command}` runs per session open): role `role`'s
 * `login.command` from the expanded config `live` (its secrets by reference, ARGUS_SECRET_<NAME>), run by
 * `/bin/sh -c` in `worktree` under `env` (the instance environment), in its own process group, killed
 * after settle_ms + 30 s. Its stdout must be a Playwright storage state `{cookies: [...], origins: [...]}`
 * whose cookie domains are hosts of the run's `origins` and whose origins are run origins; it is written
 * 0600 to `<dir>/.playwright/<role>-<nonce>.state.json` (openSession removes it once the session opened)
 * → the file. Anything else throws `failed: the login command of <role> …`, never its output.
 */
export async function commandLogin({ role, live, env, worktree, secrets = {}, origins, dir, runner = runAsync }) {
  const cmd = live.roles && live.roles[role] && live.roles[role].login && live.roles[role].login.command;
  if (typeof cmd !== "string") throw new Error(`failed: roles.${role} has no login command`);
  const limit = (live.settle_ms ?? 10_000) + 30_000;
  const r = await runner(["/bin/sh", "-c", cmd], { cwd: worktree, env: { ...env, ...secretEnv(cmd, secrets) }, timeoutMs: limit, stdio: ["ignore", "pipe", "pipe"], capture: true, killAfter: true });
  const fail = (why) => new Error(`failed: the login command of ${role} ${why}`);
  if (r.timedOut) throw fail(`timed out after ${Math.round(limit / 1000)} s`);
  if (r.error) throw fail(`could not run: ${r.error.message}`);
  if (r.status !== 0) throw fail(`exited ${r.status ?? r.signal}: ${tail(redact(r.stderr, secrets))}`);
  let state;
  try {
    state = JSON.parse(r.stdout);
  } catch {
    state = null;
  }
  if (!state || typeof state !== "object" || !Array.isArray(state.cookies) || !Array.isArray(state.origins)) throw fail("printed no storage state ({cookies: [], origins: []})");
  const allowed = new Set(origins.map(canonicalOrigin));
  for (const c of state.cookies) {
    if (!c || typeof c.domain !== "string" || !runHost(c.domain, origins)) throw fail(`printed a cookie for ${c && typeof c.domain === "string" ? c.domain : "no domain"}, not a host of the run`);
  }
  for (const o of state.origins) {
    let ok = false;
    try {
      ok = allowed.has(canonicalOrigin(o.origin));
    } catch {
      ok = false;
    }
    if (!ok) throw fail(`printed storage for ${o && typeof o.origin === "string" ? o.origin : "no origin"}, not a run origin`);
  }
  const file = path.join(dir, ".playwright", `${role}-${nonce()}.state.json`);
  fs.writeFileSync(file, JSON.stringify(state), { mode: 0o600, flag: "wx" });
  return file;
}

/**
 * `up` step 10: one proving login per configured account — every user of every role with `users`
 * (`<role>.<k>`, k from 1 in order), once per role with a login command (`<role>.1`) — sequential,
 * `login_spacing_ms` apart, in slot directory `up` (its CLI config written here, from `origins`,
 * `allowOrigins`, `proxyPort` and `chrome`). Each: the session opened (with the command's storage state,
 * then logged_in checked at the role's base_url by a probe), signed in (login), and every origin its pages
 * requested (their own requests and WebSockets, redirects and blocked ones included: the proxy's log also
 * holds Chrome's own background traffic, which is not the login's) must be a run origin or an
 * `allow_origins` one, else `refused: the login of <role>.<k> reached <origin>, outside the run's origins`; a failure is `refused: <role>.<k> could not sign in (<reason>)`.
 * The session is closed and its record dropped either way; a RETRYABLE failure gets one more try (retryOnce) → the count proven.
 */
export async function proveLogins(main, runId, { live, secrets = {}, origins, allowOrigins = [], js, home, proxyPort, chrome, env, worktree, runner = run, cliRunner = runAsync, say = () => {}, sleep: wait = sleep }) {
  const dir = slotDir(main, runId, "up");
  writeSlotConfig(dir, slotConfig({ dir, origins, allowOrigins, proxyPort, live, chrome }));
  const allowed = new Set([...origins, ...allowOrigins].map(canonicalOrigin));
  const accounts = [];
  for (const [role, r] of Object.entries(live.roles ?? {})) {
    if (role === "anon" || !r || typeof r !== "object") continue;
    if (Array.isArray(r.users)) r.users.forEach((u, i) => accounts.push({ role, account: `${role}.${i + 1}`, user: u.user, password: u.password, totpSecret: u.totp_secret ?? null }));
    else if (r.login) accounts.push({ role, account: `${role}.1`, command: true });
  }
  let proven = 0;
  for (const a of accounts) {
    if (proven > 0 && live.login_spacing_ms) await wait(live.login_spacing_ms);
    const failures = runFailures(main, runId);
    await retryOnce((n) => proveOne(a, n === 1 ? firstTryFailures(failures) : failures), { wait: () => wait(Math.max(live.login_spacing_ms ?? 0, RETRY_MS)), say: (why) => say(`login ${a.account}: ${why}; one more try`) });
    proven += 1;
    say(`login ${a.account}: proven`);
  }
  return proven;

  async function proveOne(a, failures) {
    const plan = loginPlan(live, a.role);
    let record = null;
    try {
      let res;
      if (a.command) {
        const state = await commandLogin({ role: a.role, live, env, worktree, secrets, origins, dir, runner: cliRunner });
        record = await openSession({ main, runId, slot: "up", account: a.account, js, home, storageState: state, runner, cliRunner });
        const p = await runCode({ js, session: record.name, cwd: dir, home, code: loginCode("probe", { url: plan.base, loggedIn: plan.loggedIn, settleMs: plan.settleMs }), timeoutMs: stageTimeout(plan), runner: cliRunner });
        if (p.error) logDetail(main, runId, a.account, "command", p.error, secrets);
        res = { ok: Boolean(p.in), reason: p.error ? "error: playwright" : "rejected", origins: p.origins ?? [] };
      } else {
        record = await openSession({ main, runId, slot: "up", account: a.account, js, home, runner, cliRunner });
        res = await login({ main, runId, session: record.name, account: a.account, user: a.user, password: a.password, totpSecret: a.totpSecret, plan, js, home, cwd: dir, runner: cliRunner, failures });
      }
      const outside = res.origins.find((o) => {
        try {
          return !allowed.has(canonicalOrigin(o));
        } catch {
          return true;
        }
      });
      if (outside) throw new Error(`refused: the login of ${a.account} reached ${outside}, outside the run's origins`);
      if (!res.ok) throw new Error(`refused: ${a.account} could not sign in (${res.reason})`);
    } catch (e) {
      if (/^refused: /.test(e.message)) throw e;
      // A run-code failure quotes Playwright, which may quote the page: fixed words here, the detail in the log.
      if (/^failed: run-code: /.test(e.message)) {
        logDetail(main, runId, a.account, a.user ?? "command", e.message, { ...secrets, ...(a.password ? { password: a.password } : {}) });
        throw new Error(`refused: ${a.account} could not sign in (error: playwright)`);
      }
      throw new Error(`refused: ${a.account} could not sign in (${redact(e.message.replace(/^failed: /, ""), secrets)})`);
    } finally {
      if (record) {
        await closeSessions([record], { js, runner, cliRunner, graceMs: 3000 });
        let shared = true;
        try {
          const after = updateRun(main, runId, (prev) => (prev ? { ...prev, sessions: (prev.sessions ?? []).filter((s) => !s || s.name !== record.name) } : undefined), { create: false });
          shared = Boolean(after && (after.sessions ?? []).some((s) => s && s.home === record.home));
        } catch {
          // run.json gone or sealed: the teardown closes what it holds
        }
        // Its record is gone, so the teardown would not remove its sockets: they go now, unless another session of that HOME uses them.
        if (!shared) removeSockets(record.home);
      }
    }
  }
}
/** The pause before a proving login's retry, and the reasons a retry can clear: an OTP form shown late, a login form not rendered yet, a Playwright error. */
const RETRY_MS = 2000;
const RETRYABLE = new Set(["no-login-form", "no-totp-secret", "error: playwright"]);
/** `failures` as a first try sees it: a RETRYABLE reason is not recorded, so the retry's login() runs for real. */
export const firstTryFailures = (failures) => ({ get: failures.get, set: (k, reason) => (RETRYABLE.has(reason) ? undefined : failures.set(k, reason)) });
/** `fn(1)`, then `fn(2)` once for a RETRYABLE reason only: never `rejected`, `rate-limited`, a login command's own refusal or an outside origin. */
export async function retryOnce(fn, { wait, say = () => {} }) {
  try {
    return await fn(1);
  } catch (e) {
    const m = /could not sign in \(([^)]*)\)$/.exec(e.message);
    if (!m || !RETRYABLE.has(m[1])) throw e;
    say(m[1]);
    await wait();
    return fn(2);
  }
}
/**
 * login() for a slot's or a repro's session: a RETRYABLE failure gets one more try after the instance settles
 * (`spacingMs` or RETRY_MS, the longer), and only the last answer is recorded in `failures` (retryOnce and
 * firstTryFailures, as `up`'s proving logins use them). `rejected`, `rate-limited` and a user already in
 * `failures` get login()'s answer after one try. → login()'s answer.
 */
export async function loginRetry(opts, { spacingMs = 0, sleep: wait = sleep, say = () => {} } = {}) {
  const failures = opts.failures ?? runFailures(opts.main, opts.runId);
  if (failures.get(`${String(opts.account).split(".")[0]}/${opts.user}`)) return login({ ...opts, failures });
  let res = null;
  try {
    await retryOnce(
      async (n) => {
        res = await login({ ...opts, failures: n === 1 ? firstTryFailures(failures) : failures });
        if (!res.ok) throw Object.assign(new Error(`could not sign in (${res.reason})`), { res });
      },
      { wait: () => wait(Math.max(spacingMs, RETRY_MS)), say },
    );
  } catch (e) {
    if (!e.res) throw e;
  }
  return res;
}
