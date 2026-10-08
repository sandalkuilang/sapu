// argus-live-login.mjs — signing a role's account in (spec §9 "Login", §8 step 10): RFC 6238 codes with
// Node's own crypto and a time step never used twice for a secret, the wrapper's own browser code (built
// from constant templates; every value a JSON literal, every target through targetCode), the login of a
// session (plain, two-step, modal, TOTP), a login command's storage state, and `up`'s proving logins. The
// explorer never sees any of it: a login's actions and values never reach the wrapper's output.
import { createHash, createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { openSession, slotConfig, slotDir, writeSlotConfig } from "./argus-live-browser.mjs";
import { closeSessions, removeSockets, runCli } from "./argus-live-cli.mjs";
import { secretEnv } from "./argus-live-config.mjs";
import { nonce } from "./argus-live-fence.mjs";
import { liveDir, runIdOk } from "./argus-live-lock.mjs";
import { redact, run, runAsync, sleep, tail, tempBeside, withFileLock } from "./argus-live-proc.mjs";
import { canonicalOrigin, exactHost } from "./argus-live-proxy.mjs";
import { readRun, updateRun } from "./argus-live-run.mjs";
import { parseTarget, targetCode } from "./argus-live-targets.mjs";

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

// ---------------------------------------------------------------------------------------------------
// The wrapper's own browser code: `async page => {…}` functions run through `run-code --filename`. Each
// is a constant template; a stage's payload enters only as `const P = <JSON>;` and its targets only as
// targetCode's output (every string a JSON literal), so no value and no config string becomes code.

/** Helpers every stage has: waiting, visibility, waiting up to a time for a condition. */
const HELPERS = `  const pause = (ms) => page.waitForTimeout(ms);
  const visible = async (loc) => {
    try {
      return await loc.first().isVisible();
    } catch (e) {
      return false;
    }
  };
  const settle = async (check, ms) => {
    const end = Date.now() + ms;
    for (;;) {
      let v = null;
      try {
        v = await check();
      } catch (e) {
        v = null;
      }
      if (v) return v;
      if (Date.now() >= end) return null;
      await pause(100);
    }
  };
  const ctx = page.context();
  const bodyText = async (pg) => {
    try {
      return await pg.locator("body").innerText({ timeout: 1000 });
    } catch (e) {
      return "";
    }
  };
  const LOCKOUT = /too many|\\blocked\\b|try again later/i;
`;

/** What a login stage watches: the origin of every request and WebSocket of the context's pages (popups included), and any 429. */
const WATCH = `  const origins = new Set();
  let status429 = false;
  const seen = (u) => {
    try {
      const x = new URL(u);
      const s = x.protocol === "ws:" ? "http:" : x.protocol === "wss:" ? "https:" : x.protocol;
      if (s === "http:" || s === "https:") origins.add(s + "//" + x.host);
    } catch (e) {}
  };
  const onRequest = (r) => seen(r.url());
  const onResponse = (r) => {
    if (r.status() === 429) status429 = true;
  };
  const onSocket = (w) => seen(w.url());
  const watched = new Set();
  const watch = (pg) => {
    if (watched.has(pg)) return;
    watched.add(pg);
    pg.on("websocket", onSocket);
  };
  ctx.on("request", onRequest);
  ctx.on("response", onResponse);
  ctx.on("page", watch);
  ctx.pages().forEach(watch);
  const unwatch = () => {
    ctx.off("request", onRequest);
    ctx.off("response", onResponse);
    ctx.off("page", watch);
    for (const pg of watched) pg.off("websocket", onSocket);
  };
  const failure = (e) => String((e && e.message) || e).split("\\n")[0].slice(0, 200);
  const limited = async () => status429 || LOCKOUT.test(await bodyText(page));
  const done = async (state, error) => ({ state, status429, lockout: state !== "in" && LOCKOUT.test(await bodyText(page)), origins: [...origins], ...(error ? { error } : {}) });
  const TEXT = "input[type=text]:visible, input:not([type]):visible";
  const submit = async (field) => {
    const form = field.locator("xpath=ancestor::form[1]");
    if (await form.count()) {
      const button = form.locator("button[type=submit]:visible, input[type=submit]:visible, button:not([type]):visible");
      if (await button.count()) return button.first().click();
    }
    return field.press("Enter");
  };
  const otpField = async () => {
    const otp = page.locator("input[autocomplete=one-time-code]:visible");
    if (await otp.count()) return otp.first();
    if (loggedIn && (await visible(loggedIn(page)))) return null;
    const one = page.locator("input[type=text]:visible, input[type=tel]:visible, input[type=number]:visible, input:not([type]):visible");
    return (await one.count()) === 1 ? one.first() : null;
  };
`;

const STAGES = {
  // Opens the login page fresh, clicks P.open when set, fills the user field (an email input, else the
  // text input before the password field, else the single text input), submits it first when no password
  // field shows (two-step), fills and submits the password, then waits for logged_in or a one-time-code field.
  credentials: `${WATCH}  const pickUser = async () => {
    const email = page.locator("input[type=email]:visible");
    if (await email.count()) return email.first();
    const texts = page.locator(TEXT);
    const n = await texts.count();
    if (!n) return null;
    const pw = page.locator("input[type=password]:visible");
    if (await pw.count()) {
      const handle = await pw.first().elementHandle();
      const i = await texts.evaluateAll((els, p) => {
        let k = -1;
        els.forEach((el, j) => {
          if (el.compareDocumentPosition(p) & 4) k = j;
        });
        return k;
      }, handle);
      await handle.dispose();
      if (i >= 0) return texts.nth(i);
    }
    return n === 1 ? texts.first() : null;
  };
  try {
    await page.goto(P.url);
    if (opener) await opener(page).click();
    const user = await settle(pickUser, P.settleMs);
    if (!user) return await done("no-form");
    await user.fill(P.user);
    const pw = page.locator("input[type=password]:visible");
    if (!(await visible(pw))) {
      await submit(user);
      const next = await settle(async () => ((await visible(pw)) ? "password" : (await limited()) ? "limited" : null), P.settleMs);
      if (next !== "password") return await done(next ? "failed" : "no-form");
    }
    await pw.first().fill(P.password);
    await submit(pw.first());
    const outcome = await settle(async () => ((await visible(loggedIn(page))) ? "in" : (await otpField()) ? "otp" : (await limited()) ? "failed" : null), P.settleMs);
    return await done(outcome || "failed");
  } catch (e) {
    return await done("error", failure(e));
  } finally {
    unwatch();
  }
`,
  // Fills P.code into the one-time-code field (else the single visible text input), submits, waits for logged_in.
  otp: `${WATCH}  try {
    const field = await settle(otpField, P.settleMs);
    if (!field) return await done("no-form");
    await field.fill(P.code);
    await submit(field);
    const outcome = await settle(async () => ((await visible(loggedIn(page))) ? "in" : (await limited()) ? "failed" : null), P.settleMs);
    return await done(outcome || "failed");
  } catch (e) {
    return await done("error", failure(e));
  } finally {
    unwatch();
  }
`,
  // A new page at P.url: is logged_in visible there within P.settleMs? The page is closed again.
  probe: `${WATCH}  let probe = null;
  try {
    probe = await ctx.newPage();
    await probe.goto(P.url);
    const ok = await settle(() => visible(loggedIn(probe)), P.settleMs);
    return { in: Boolean(ok), origins: [...origins] };
  } catch (e) {
    return { in: false, origins: [...origins], error: failure(e) };
  } finally {
    unwatch();
    if (probe) await probe.close().catch(() => {});
  }
`,
  // After an explorer's command: the signals every page buffered (drained), logged_in on the current
  // page (null without a target), its URL and aria snapshot (the wrapper hashes them), the tab count.
  observe: `  const signals = [];
  for (const pg of ctx.pages()) {
    try {
      signals.push(...(await pg.evaluate(() => {
        const b = window.__argusSignals || [];
        return b.splice(0, b.length);
      })));
    } catch (e) {}
  }
  let aria = "";
  try {
    aria = await page.locator("body").ariaSnapshot({ timeout: 2000 });
  } catch (e) {}
  return { signals, loggedIn: loggedIn ? await visible(loggedIn(page)) : null, url: page.url(), aria, tabs: ctx.pages().length };
`,
};

/** `(pg) => <targetCode>` for a target string the config holds (parseTarget's forms, never a ref), or `null`. */
function targetFn(s) {
  if (s === undefined || s === null) return "null";
  return `(pg) => ${targetCode(parseTarget(s), "pg")}`;
}

/**
 * The code of login stage `stage` (`credentials`, `otp`, `probe`, `observe`) for `payload` (`url`,
 * `user`, `password`, `code`, `settleMs`, and the target strings `loggedIn` and `open`): the text of an
 * `async page => {…}` function. The payload enters as `const P = <JSON>;` only; `loggedIn` and `open`
 * also become `(pg) => <targetCode>` functions. A stage returns plain JSON: credentials and otp
 * `{state: "in"|"otp"|"failed"|"no-form"|"error", status429, lockout, origins, error?}`, probe `{in,
 * origins}`, observe `{signals, loggedIn, url, aria, tabs}`.
 */
export function loginCode(stage, payload) {
  if (!Object.hasOwn(STAGES, stage)) throw new Error(`failed: no login stage ${stage}`);
  return `async page => {\n  const P = ${JSON.stringify(payload)};\n  const loggedIn = ${targetFn(payload.loggedIn)};\n  const opener = ${targetFn(payload.open)};\n${HELPERS}${STAGES[stage]}}\n`;
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
  fs.writeFileSync(file, code, { mode: 0o600, flag: "wx" });
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

/** The run's `totp.json`, beside its slot directories: every process of the run reserves its steps there. */
const totpFile = (main, runId) => path.join(liveDir(main), runId, "totp.json");

/** How long a stage may run: each of its waits is bounded by settle_ms, its actions by the CLI's timeouts. */
const stageTimeout = (plan) => 4 * plan.settleMs + 60_000;

/** The reason a judged stage failed: a 429 or a lockout text is a rate limit (a harness event), else rejected. */
function reasonOf(r) {
  if (r.status429 || r.lockout) return "rate-limited";
  if (r.state === "no-form") return "no-login-form";
  if (r.state === "error") return `error: ${r.error ?? "unknown"}`;
  return "rejected";
}

/**
 * Signs session `session` (account `account`, `<role>.<k>`) in as `user` (spec §9 "Login") by plan
 * `plan` (loginPlan): the credentials stage, then, when a one-time-code field shows, a code for a time
 * step reserved in the run's totp.json (reserveStep) → `{ok: true, origins}` or `{ok: false, reason,
 * origins}`, reason `rejected`, `rate-limited` (a 429 or a lockout text), `no-login-form`,
 * `no-totp-secret` or `error: <first line>`; `origins` = every origin the pages requested meanwhile. On
 * success the session's request and console lists are cleared (`requests --clear`, `console --clear`),
 * so the login's traffic never reaches the explorer. A failure is recorded in run.json
 * `loginFailed["<role>/<user>"]`, and a user found there is refused at once, with no browser work: a
 * failed login is never retried within a run (lockouts). A CLI that fails (the session gone) throws
 * `failed: …` and records nothing.
 */
export async function login({ main, runId, session, account, user, password, totpSecret = null, plan, js, home, cwd, runner = runAsync, now = Date.now, sleep: wait = sleep }) {
  runIdOk(runId);
  const role = String(account).split(".")[0];
  const key = `${role}/${user}`;
  const rec = readRun(main);
  const known = rec && rec.runId === runId && rec.loginFailed && Object.hasOwn(rec.loginFailed, key) ? rec.loginFailed[key] : null;
  if (known) return { ok: false, reason: known, origins: [] };
  const timeoutMs = stageTimeout(plan);
  const call = (stage, payload) => runCode({ js, session, cwd, home, code: loginCode(stage, { ...payload, loggedIn: plan.loggedIn, settleMs: plan.settleMs }), timeoutMs, runner });
  const origins = new Set();
  let r = await call("credentials", { url: plan.url, open: plan.open, user, password });
  for (const o of r.origins ?? []) origins.add(o);
  let reason = null;
  if (r.state === "otp") {
    if (!totpSecret) reason = "no-totp-secret";
    else {
      const step = await reserveStep(totpFile(main, runId), totpSecret, { now, sleep: wait });
      r = await call("otp", { code: totp(totpSecret, step) });
      for (const o of r.origins ?? []) origins.add(o);
    }
  }
  if (!reason && r.state !== "in") reason = reasonOf(r);
  if (reason) {
    updateRun(main, runId, (prev) => (prev ? { ...prev, loginFailed: { ...(prev.loginFailed ?? {}), [key]: reason } } : undefined), { create: false });
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
 * The session is closed and its record dropped from run.json either way → the number of accounts proven.
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
    const plan = loginPlan(live, a.role);
    let record = null;
    try {
      let res;
      if (a.command) {
        const state = await commandLogin({ role: a.role, live, env, worktree, secrets, origins, dir, runner: cliRunner });
        record = await openSession({ main, runId, slot: "up", account: a.account, js, home, storageState: state, runner, cliRunner });
        const p = await runCode({ js, session: record.name, cwd: dir, home, code: loginCode("probe", { url: plan.base, loggedIn: plan.loggedIn, settleMs: plan.settleMs }), timeoutMs: stageTimeout(plan), runner: cliRunner });
        res = { ok: Boolean(p.in), reason: p.error ? `error: ${p.error}` : "rejected", origins: p.origins ?? [] };
      } else {
        record = await openSession({ main, runId, slot: "up", account: a.account, js, home, runner, cliRunner });
        res = await login({ main, runId, session: record.name, account: a.account, user: a.user, password: a.password, totpSecret: a.totpSecret, plan, js, home, cwd: dir, runner: cliRunner });
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
      proven += 1;
      say(`login ${a.account}: proven`);
    } catch (e) {
      if (/^refused: /.test(e.message)) throw e;
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
  return proven;
}
