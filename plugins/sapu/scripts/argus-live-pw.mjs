// argus-live-pw.mjs — the explorer's only way into a browser (spec §9 "The wrapper", §7 "Budget, loops,
// handoff"): `argus-live.mjs pw <token> <role>[.<k>] <command> [args]`. Every command is allowlisted with
// its flags; every URL is inside the run's origins; every value goes to the CLI after `--`, so none is
// read as an option; every byte the page or the CLI printed is fenced by a fresh nonce; the budget, the
// loop rule and the deadline are kept per token, under the slot's lock. The wrapper builds every argv;
// the explorer never reaches the CLI, and its token is never printed, logged or written.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { openSession, slotDir } from "./argus-live-browser.mjs";
import { closeSessions, runCli, sessionAlive, sessionName } from "./argus-live-cli.mjs";
import { expandConfig, loadLive, ROLE_FREE } from "./argus-live-config.mjs";
import { fence } from "./argus-live-fence.mjs";
import { codeCommand, runHook } from "./argus-live-hooks.mjs";
import { submit } from "./argus-live-return.mjs";
import { commandLogin, login, loginCode, loginPlan, runCode } from "./argus-live-login.mjs";
import { redact, run, runAsync, sleep } from "./argus-live-proc.mjs";
import { blockedSince, canonicalOrigin } from "./argus-live-proxy.mjs";
import { readRun, recordedSecrets } from "./argus-live-run.mjs";
import { accountOf, readSlotState, slotLockWaitMs, tokenSlot, withSlotLock, writeSlotState } from "./argus-live-slots.mjs";
import { explorerTarget } from "./argus-live-targets.mjs";

/** The budget when `limits.explorer_pw_calls` is not set (spec §8's example). */
const DEFAULT_CALLS = 120;
/** The same command on the same state this many times is a loop. */
const LOOP_AT = 3;
/** The CLI's answer when the session's browser is gone (0.1.22: "The browser '<name>' is not open, please run open first"). */
const NOT_OPEN = /is not open, please run open first/;
/** `find`'s answer when nothing matched (0.1.22: "No matches found for …"). */
const NO_MATCH = /^### Result\nNo matches found for /m;
/** A URL in a console line (Chrome names the request it failed, and where). */
const URL_IN_TEXT = /\b(?:https?|wss?):\/\/[^\s'"<>()\]]+/g;
/** Chrome's errors for a request the run's layers stopped: Playwright's allowedOrigins, the proxy, the host rules. */
const BLOCKED_ERROR = /ERR_BLOCKED_BY_CLIENT|ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED|tunnel via proxy server failed/i;

/** A URL's origin in the form origins are compared in (canonicalOrigin; ws: as http:, wss: as https:), or null. */
function originOf(u) {
  try {
    const x = new URL(u);
    const scheme = x.protocol === "ws:" ? "http:" : x.protocol === "wss:" ? "https:" : x.protocol;
    if (scheme !== "http:" && scheme !== "https:") return null;
    return canonicalOrigin(`${scheme}//${x.host}`);
  } catch {
    return null;
  }
}

const bool = { bool: true };
const valued = (re, shape) => ({ value: re, shape });
const regexValue = {
  test: (s) => {
    if (s.length > 500 || /[\u0000-\u001f\u007f-\u009f]/.test(s)) return false;
    try {
      new RegExp(s);
      return true;
    } catch {
      return false;
    }
  },
};

/**
 * The explorer's allowlist (spec §9): each command's positionals (`args`: kinds, `?` optional, `+` one or
 * more) and flags (`--name` boolean, or `--name=<value>` checked by its regex; `repeat` may appear more
 * than once). Role-free commands (`roleFree`) take no account word. Anything else is refused by name.
 */
export const COMMANDS = {
  goto: { args: ["url"] },
  "tab-new": { args: ["url?"] },
  click: { args: ["target", "button?"], flags: { "--modifiers": { ...valued(/^(Alt|Control|Meta|Shift)$/, "Alt|Control|Meta|Shift"), repeat: true } } },
  dblclick: { args: ["target", "button?"], flags: { "--modifiers": { ...valued(/^(Alt|Control|Meta|Shift)$/, "Alt|Control|Meta|Shift"), repeat: true } } },
  fill: { args: ["target", "text"], flags: { "--submit": bool } },
  select: { args: ["target", "text"] },
  type: { args: ["text"], flags: { "--submit": bool } },
  check: { args: ["target"] },
  uncheck: { args: ["target"] },
  hover: { args: ["target"] },
  press: { args: ["key"] },
  drag: { args: ["target", "target"] },
  upload: { args: ["file+"] },
  "go-back": { args: [] },
  "go-forward": { args: [] },
  reload: { args: [] },
  "tab-list": { args: [] },
  "dialog-dismiss": { args: [] },
  snapshot: { args: ["target?"], flags: { "--depth": valued(/^[1-9][0-9]?$/, "1-99"), "--boxes": bool } },
  find: { args: ["text?"], flags: { "--regex": valued(regexValue, "a regular expression") } },
  screenshot: { args: ["target?"], flags: { "--full-page": bool } },
  console: { args: ["level?"] },
  requests: { args: [], flags: { "--static": bool, "--filter": valued(regexValue, "a regular expression") } },
  request: { args: ["index"] },
  "response-body": { args: ["index"] },
  resize: { args: ["size", "size"] },
  "tab-select": { args: ["tab"] },
  "tab-close": { args: ["tab?"] },
  "dialog-accept": { args: ["text?"] },
  login: { args: ["text", "text"] },
  code: { roleFree: true, args: ["text", "text?", "text?"] },
  trigger: { roleFree: true, args: ["text+"] },
  facts: { roleFree: true, args: ["text"] },
  mail: { roleFree: true, args: [] },
  submit: { roleFree: true, args: ["text"] },
};

/** How a refusal shows an explorer's argument: as given when it is short printable ASCII, else not at all. */
const shown = (s) => (typeof s === "string" && /^[\x20-\x7e]{1,200}$/.test(s) ? s : "that argument");

/**
 * The explorer's argv → `{token, account | null, cmd, flags, positionals}` (`account` the word as given,
 * accountOf resolves it): `argv[0]` the token, `argv[1]` a role-free command or an account word, then the
 * command. Flags come before the first positional (`--` ends them; after the first positional everything
 * is a positional) and must be the command's own; the positionals' count must fit the command. Refused:
 * a command off the allowlist, any other flag (`-s`, `--session`, `--config`, `--filename`, …), a flag
 * value that does not fit, a wrong number of arguments.
 */
export function parsePw(argv) {
  if (!Array.isArray(argv) || argv.length < 2) throw new Error("refused: pw <token> <role>[.<k>] <command> [args] | pw <token> <code|trigger|facts|mail|submit> [args]");
  const token = argv[0];
  const roleFree = ROLE_FREE.includes(argv[1]);
  const account = roleFree ? null : argv[1];
  const cmd = roleFree ? argv[1] : argv[2];
  const rest = argv.slice(roleFree ? 2 : 3);
  if (typeof cmd !== "string" || !Object.hasOwn(COMMANDS, cmd) || Boolean(COMMANDS[cmd].roleFree) !== roleFree) {
    if (!roleFree && cmd !== undefined && Object.hasOwn(COMMANDS, cmd)) throw new Error(`refused: ${cmd} takes no role (pw <token> ${cmd} …)`);
    throw new Error(`refused: ${cmd === undefined ? "no command given; that" : /^[a-z][a-z0-9-]{0,40}$/.test(cmd) ? cmd : "that"} is not an explorer command`);
  }
  const spec = COMMANDS[cmd];
  const flags = [];
  const positionals = [];
  let i = 0;
  for (; i < rest.length; i++) {
    const a = rest[i];
    if (typeof a !== "string") throw new Error("refused: an argument must be text");
    if (a === "--") {
      i += 1;
      break;
    }
    if (!a.startsWith("-")) break;
    const eq = a.indexOf("=");
    const name = eq < 0 ? a : a.slice(0, eq);
    const f = spec.flags && Object.hasOwn(spec.flags, name) ? spec.flags[name] : null;
    if (!f) throw new Error(`refused: ${/^--?[A-Za-z][A-Za-z0-9-]{0,40}$/.test(name) ? name : "that"} is not a flag of ${cmd}`);
    if (f.bool) {
      if (eq >= 0) throw new Error(`refused: ${name} takes no value`);
    } else if (eq < 0 || !f.value.test(a.slice(eq + 1))) throw new Error(`refused: ${name} takes =<${f.shape}>`);
    if (!f.repeat && flags.some((x) => x === name || x.startsWith(`${name}=`))) throw new Error(`refused: ${name} is given twice`);
    flags.push(a);
  }
  positionals.push(...rest.slice(i));
  const min = spec.args.filter((k) => !k.endsWith("?")).length;
  const many = spec.args.some((k) => k.endsWith("+"));
  const max = many ? Infinity : spec.args.length;
  if (positionals.length < min || positionals.length > max) throw new Error(`refused: ${cmd} takes ${spec.args.length ? spec.args.join(" ") : "no argument"}`);
  if (cmd === "find" && (positionals.length > 0) === flags.some((x) => x.startsWith("--regex="))) throw new Error("refused: find takes a text or --regex=<pattern>, one of them");
  return { token, account, cmd, flags, positionals };
}

/**
 * A `goto`/`tab-new` argument → the absolute URL to open: a path (`^/(?![/\\])`, no control characters)
 * resolved on `base` (the account's role's base_url), or an `http:`/`https:` URL without credentials;
 * either way its origin, serialised (WHATWG), must be one of `origins` as they serialise: a host spelled
 * otherwise (`localhost.`, `127.0.0.1` for `localhost`) is refused. Else
 * `refused: <arg> is outside the run's origins` — so `//host`, `/\host`, `javascript:`, `data:`,
 * `file:`, `view-source:` and `http://localhost:<port>@host` are refused.
 */
export function checkUrl(arg, { origins, base }) {
  const refuse = () => new Error(`refused: ${shown(arg)} is outside the run's origins`);
  // Controls are refused first: a URL parser drops tabs and newlines, so `/<tab>/host` would become `//host`.
  if (typeof arg !== "string" || arg === "" || arg.length > 4000 || /[\u0000-\u001f\u007f-\u009f]/.test(arg)) throw refuse();
  let u;
  try {
    if (arg.startsWith("/")) {
      if (!/^\/(?![/\\])/.test(arg)) throw refuse();
      u = new URL(arg, base);
    } else u = new URL(arg);
  } catch {
    throw refuse();
  }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password) throw refuse();
  // Spelled as a run origin spells it (WHATWG's serialisation: lower case, one form of an IP, a trailing dot kept), not merely the same host.
  const allowed = new Set(origins.map((o) => new URL(o).origin));
  if (!allowed.has(u.origin)) throw refuse();
  return u.href;
}

/** `request` output with the values of `Cookie`, `Set-Cookie`, `Authorization`, `Proxy-Authorization` and every `*-Token` header replaced by `<masked>`. */
export function maskHeaders(text) {
  return String(text).replace(/^(\s*)(cookie|set-cookie|authorization|proxy-authorization|[A-Za-z0-9-]*-token)(\s*:[ \t]*)(.*)$/gim, (_m, lead, name, sep) => `${lead}${name}${sep}<masked>`);
}

/**
 * The CLI's links to files it wrote shown by their basename only: `out/page-….yml`, and the slot's paths
 * as given or real, absolute or relative to the CLI's real cwd (0.1.22 prints `../../…/var/folders/…/out/x.png`).
 */
function baseNames(text, dir) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  let real = dir;
  try {
    real = fs.realpathSync(dir);
  } catch {
    // gone: the path as given
  }
  const dirs = [...new Set([dir, real])].map((d) => esc(d.replace(/^\//, ""))).join("|");
  return String(text)
    .replace(new RegExp(`(?:\\.\\./)*(?:\\.\\.)?/?(?:${dirs})/(?:[^\\s'")\\]]*/)?([^\\s'")\\]/]+)`, "g"), (_m, name) => name)
    .replace(/(^|[\s('"[])out\/(?:[^\s'")\]]*\/)?([^\s'")\]/]+)/g, (_m, lead, name) => `${lead}${name}`);
}

/** A positional checked by its kind (COMMANDS) → what goes to the CLI. */
function checkArg(kind, value, { origins, base, files }) {
  const k = kind.replace(/[?+]$/, "");
  const bad = (what) => new Error(`refused: ${shown(value)} is not ${what}`);
  switch (k) {
    case "url":
      return checkUrl(value, { origins, base });
    case "target":
      return explorerTarget(value);
    case "button":
      if (!/^(left|right|middle)$/.test(value)) throw bad("a button (left, right or middle)");
      return value;
    case "key":
      if (!/^[A-Za-z0-9+]{1,32}$/.test(value)) throw bad("a key (letters, digits and +, at most 32)");
      return value;
    case "file": {
      if (!/^[A-Za-z0-9._-]{1,128}$/.test(value) || value === "." || value === "..") throw bad("a fixture file name");
      const p = path.join(files, value);
      let st = null;
      try {
        st = fs.lstatSync(p);
      } catch {
        st = null;
      }
      if (!st || !st.isFile()) throw new Error(`refused: ${value} is not a fixture file of this slot`);
      return p;
    }
    case "level":
      if (!/^(error|warning|info|debug)$/.test(value)) throw bad("a console level (error, warning, info or debug)");
      return value;
    case "index":
      if (!/^[1-9][0-9]{0,5}$/.test(value) || Number(value) > 100_000) throw bad("a request number from 1 to 100000");
      return value;
    case "size":
      if (!/^[0-9]{3,4}$/.test(value) || Number(value) < 200 || Number(value) > 4000) throw bad("a size from 200 to 4000");
      return value;
    case "tab":
      if (!/^[0-9]{1,2}$/.test(value) || Number(value) > 50) throw bad("a tab index from 0 to 50");
      return value;
    default:
      if (value.length > 10_000) throw bad("at most 10000 characters");
      return value;
  }
}

/** Every value the output must never show: the env_file's (now and as `up` read them), every role password and TOTP secret, and the passwords of accounts the journey created. */
function secretsOf(main, config, live, state) {
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

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/**
 * One explorer call (spec §9): `argv` = `[token, <role>[.<k>] | <role-free command>, …]` → `{code, out}`
 * (`out` the lines to print). In order: the token (tokenSlot: unknown or retired is refused and counts
 * nothing); under the slot's lock: the deadline (`DEADLINE: submit status aborted`, all but `submit`),
 * the budget (`BUDGET: submit status handoff` past `limits.explorer_pw_calls`, all but `submit`; else the
 * call is counted, refusals included); the grammar and every argument (parsePw, accountOf, checkUrl, …);
 * an account whose login failed this run (`HARNESS: …`); the loop rule (the same command on the same
 * state a third time → `LOOP: submit status handoff`, not run); the session, opened and signed in on
 * first use (invisibly); the command, its positionals after `--` (a browser gone → the session opened
 * again and signed in, `session-reopened: <role.k>`, the command not run; a `find` with no match asked
 * again every 500 ms up to settle_ms, `found|not found after <ms> ms`); the observation (the state hash
 * the loop rule reads, the signals of every page, the console's new errors and warnings, the origins the
 * run blocked that a page named, once per slot as `blocked: <origin>`; logged_in gone from the page and
 * from a probe tab at the role's base_url → signed in again once, `re-logged-in: <role.k>`, the command not
 * repeated); and the output: the CLI's answer and the page's lines in one nonce fence, then `calls
 * <c>/<max>`, `loop <n>/3` and the wrapper's own events. `login <user> <password>` signs the session in as
 * an account the journey created (`login: ok` or `login: failed (<reason>)`; kept in state.json
 * `created` for its re-logins once it worked). The role-free `code`, `trigger`, `facts` and `mail`
 * (argus-live-hooks.mjs) print their output in the fence, then `exit <n>` when it was not 0. Exit codes: 0 the command ran (a CLI
 * error is page data, inside the fence), 1 refused or BUDGET/LOOP/DEADLINE/HARNESS, 2 the wrapper failed.
 * `cli` (a test seam) stands in for the installed CLI (run.json `browser.js`).
 */
export async function pw(main, argv, { cli = null, now = Date.now, runner = run, cliRunner = runAsync } = {}) {
  const word = Array.isArray(argv) ? argv[1] : undefined;
  let found;
  try {
    found = tokenSlot(main, Array.isArray(argv) ? argv[0] : undefined);
  } catch (e) {
    return { code: 1, out: [e.message] };
  }
  const { runId, slot } = found;
  const dir = slotDir(main, runId, slot);
  let secrets = {};
  try {
    const settle = (loadLive(main).config ?? {}).settle_ms;
    return await withSlotLock(main, runId, slot, () => call({ main, argv, word, runId, slot, dir, cli, now, runner, cliRunner, setSecrets: (s) => (secrets = s) }), { waitMs: slotLockWaitMs(settle) });
  } catch (e) {
    // A run-code failure quotes Playwright, which may quote the page: never printed outside a fence.
    const msg = /^failed: run-code: /.test(String(e && e.message)) ? "failed: the browser CLI's run-code failed" : redact(String((e && e.message) || e), secrets);
    return { code: /^refused: /.test(msg) ? 1 : 2, out: [/^(refused|failed): /.test(msg) ? msg : `failed: ${msg}`] };
  }
}

/** The body of pw, under the slot's lock. */
async function call({ main, argv, word, runId, slot, dir, cli, now, runner, cliRunner, setSecrets }) {
  // The token again, under the lock: a handoff may have retired it meanwhile.
  // The lock too: a renew may have moved the deadline while this call waited for the slot.
  const { rec: slotRec, lock: lockNow } = tokenSlot(main, argv[0]);
  const isSubmit = word === "submit";
  if (!isSubmit && lockNow.deadline * 1000 <= now()) return { code: 1, out: ["DEADLINE: submit status aborted"] };
  const { config, errors, secrets: envSecrets } = loadLive(main);
  if (!config || errors.length) throw new Error(`failed: .argus/live.json: ${errors.join("; ")}`);
  const rec = readRun(main);
  const live = expandConfig(config, { ports: { ...(rec.ports ?? {}) }, secrets: envSecrets });
  const max = (live.limits && live.limits.explorer_pw_calls) || DEFAULT_CALLS;
  const state = readSlotState(dir);
  const secrets = secretsOf(main, config, live, state);
  setSecrets(secrets);
  if (!isSubmit) {
    if (state.calls >= max) return { code: 1, out: ["BUDGET: submit status handoff"] };
    state.calls += 1;
    writeSlotState(dir, state);
  }
  const counter = `calls ${state.calls}/${max}`;
  const refused = (e) => {
    if (!/^refused: /.test(e.message)) throw e;
    return { code: 1, out: [e.message, counter] };
  };
  let p;
  let account = null;
  try {
    p = parsePw(argv);
    if (p.account !== null) account = accountOf(slotRec, p.account);
  } catch (e) {
    return refused(e);
  }
  if (p.account === null) {
    if (p.cmd === "submit") {
      // Its line holds enums only; a refusal leaves the token live (the explorer fixes its return).
      try {
        return { code: 0, out: [submit(main, { runId, slot, rec: slotRec }, p.positionals[0])] };
      } catch (e) {
        if (!/^refused: /.test(e.message)) throw e;
        return { code: 1, out: [e.message] };
      }
    }
    // code, trigger, facts, mail: what they print is page data, in the fence; their exit and the wrapper's events outside.
    let done;
    try {
      if (p.cmd === "code") {
        const c = codeCommand(p.positionals[0], p.positionals.slice(1), { worktree: rec.worktree });
        done = { stdout: c.text, code: c.code, events: [] };
      } else {
        const [name, values] = p.cmd === "trigger" ? [p.positionals[0], p.positionals.slice(1)] : [p.cmd, p.positionals];
        done = await runHook(p.cmd, name, values, { rec, live });
      }
    } catch (e) {
      return refused(e);
    }
    const { body, truncated } = fence(String(done.stdout).trimEnd(), { secrets });
    return { code: 0, out: [body, counter, ...(done.code !== 0 && done.code !== null ? [`exit ${done.code}`] : []), ...done.events, ...(truncated ? [`truncated ${truncated} characters`] : [])] };
  }

  const role = account.split(".")[0];
  const plan = loginPlan(live, role);
  let positionals;
  try {
    positionals = p.positionals.map((v, i) => checkArg(COMMANDS[p.cmd].args[Math.min(i, COMMANDS[p.cmd].args.length - 1)], v, { origins: rec.origins ?? [], base: plan.base, files: path.join(dir, "files") }));
    if (p.cmd === "login" && role === "anon") throw new Error("refused: anon is never signed in");
  } catch (e) {
    return refused(e);
  }

  // The account's credentials: those of an account the journey created and signed in with `login`, else its allocated user's.
  const r = live.roles && live.roles[role];
  const credentials = () => {
    const c = (readSlotState(dir).created ?? {})[account];
    if (c && typeof c.user === "string" && typeof c.password === "string") return { user: c.user, password: c.password, totpSecret: null };
    const u = ((r && r.users) || []).find((x) => x && x.user === slotRec.accounts[account]);
    return u ? { user: u.user, password: u.password, totpSecret: u.totp_secret ?? null } : null;
  };
  const user = (credentials() ?? {}).user ?? slotRec.accounts[account];
  if (p.cmd !== "login" && user && rec.loginFailed && Object.hasOwn(rec.loginFailed, `${role}/${user}`)) return { code: 1, out: [`HARNESS: ${account} cannot sign in this cycle; submit status aborted`, counter] };

  // The loop rule: the same command on the same state (the last observation's hash) a third time.
  let st = { ...((state.sessions ?? {})[account] ?? {}) };
  const key = sha256(JSON.stringify([account, p.cmd, p.flags, p.positionals, st.lastState ?? null]));
  const seen = (state.loops[key] ?? 0) + 1;
  state.loops = { ...state.loops, [key]: seen };
  writeSlotState(dir, state);
  if (seen >= LOOP_AT) return { code: 1, out: ["LOOP: submit status handoff", counter] };

  const js = cli ?? (rec.browser && rec.browser.js);
  if (typeof js !== "string" || !fs.existsSync(js)) throw new Error("failed: the browser CLI is not installed (run.json names none, or it is gone)");
  const home = path.join(rec.home, "browser");
  const name = sessionName(runId, slot, account);
  const cliCall = (args, timeoutMs = plan.settleMs + 60_000) => runCli({ js, session: name, args, cwd: dir, home, timeoutMs, runner: cliRunner });
  const stage = (which, payload) => runCode({ js, session: name, cwd: dir, home, code: loginCode(which, payload), timeoutMs: 4 * plan.settleMs + 60_000, runner: cliRunner });
  /** Opens the session (a login-command role's with a fresh storage state, which signs it in) → its record. */
  const open = async () => {
    let storageState = null;
    if (r && r.login) storageState = await commandLogin({ role, live, env: rec.env, worktree: rec.worktree, secrets: envSecrets, origins: rec.origins ?? [], dir, runner: cliRunner });
    const s = await openSession({ main, runId, slot, account, js, home, storageState, runner, cliRunner });
    st = { signedIn: Boolean(storageState) };
    return s;
  };
  /** Signs the open session in with the account's credentials (login, which never retries a failed account) → its answer. */
  const signIn = async (c = credentials()) => {
    const res = c ? await login({ main, runId, session: name, account, user: c.user, password: c.password, totpSecret: c.totpSecret, plan, js, home, cwd: dir, runner: cliRunner }) : { ok: false, reason: "rejected" };
    if (res.ok) st.signedIn = true;
    return res;
  };
  const save = (extra = {}) => {
    const after = readSlotState(dir);
    writeSlotState(dir, { ...after, ...extra, sessions: { ...(after.sessions ?? {}), [account]: st } });
  };

  // The session: opened on first use and signed in, invisibly (anon never is).
  let session = (rec.sessions ?? []).find((x) => x && x.name === name && x.daemon);
  if (!session) session = await open();
  if (p.cmd === "login") {
    // An account the journey created: signed in on this session; kept for its re-logins only once it worked.
    const [u, password] = positionals;
    setSecrets({ ...secrets, "login:password": password });
    const done = await signIn({ user: u, password, totpSecret: null });
    save(done.ok ? { created: { ...(readSlotState(dir).created ?? {}), [account]: { user: u, password } } } : {});
    return { code: 0, out: [counter, done.ok ? "login: ok" : `login: failed (${/^error: /.test(done.reason) ? "error" : done.reason})`] };
  }
  if (role !== "anon" && !st.signedIn) {
    if (!(r && r.login) && !(await signIn()).ok) return { code: 1, out: [`HARNESS: ${account} cannot sign in this cycle; submit status aborted`, counter] };
  }

  const args = [p.cmd, ...p.flags, ...(positionals.length ? ["--", ...positionals] : [])];
  let res = await cliCall(args);
  const events = [];
  // The browser is gone (it crashed, or was closed): the session opens again and signs in; the command is not run.
  if (res.code !== 0 && (NOT_OPEN.test(`${res.stdout}\n${res.stderr}`) || !sessionAlive(session, runner))) {
    await closeSessions([session], { js, runner, cliRunner, graceMs: 3000 });
    await open();
    events.push(`session-reopened: ${account}`);
    if (role !== "anon" && !st.signedIn && !(r && r.login) && !(await signIn()).ok) events.push("harness: login failed");
    save();
    return { code: 0, out: [counter, ...events] };
  }
  // Absence is never instant: a find with no match is asked again every 500 ms up to settle_ms.
  if (p.cmd === "find" && res.code === 0 && NO_MATCH.test(res.stdout)) {
    const start = Date.now();
    while (res.code === 0 && NO_MATCH.test(res.stdout) && Date.now() - start < plan.settleMs) {
      await sleep(Math.min(500, Math.max(0, plan.settleMs - (Date.now() - start))));
      res = await cliCall(args);
    }
    events.push(`${res.code === 0 && NO_MATCH.test(res.stdout) ? "not found" : "found"} after ${Date.now() - start} ms`);
  }
  let text = baseNames(`${res.stdout}${res.code !== 0 && res.stderr ? `\n${res.stderr}` : ""}`, dir).trimEnd();
  if (p.cmd === "request") text = maskHeaders(text);

  // Observation: the signals of every page (popups included), the state hash, logged_in; then the console's new errors and warnings.
  const pageLines = [];
  let o = null;
  try {
    o = await stage("observe", { loggedIn: role === "anon" ? null : plan.loggedIn });
  } catch {
    events.push("harness: observation failed");
  }
  if (o && typeof o === "object") {
    st.lastState = sha256(`${o.url ?? ""}\n${o.aria ?? ""}`);
    for (const x of Array.isArray(o.signals) ? o.signals : []) if (x && typeof x.text === "string") pageLines.push(`signal ${String(x.kind ?? "")}: ${x.text}`);
  }
  // Requests the run blocked: reported once per slot as `blocked: <origin>`, never as console errors. The
  // proxy's log also holds Chrome's own traffic, so an origin it blocked is reported only once a page names it.
  const slotState = readSlotState(dir);
  const fromProxy = blockedSince(main, runId, slotState.blockedOffset ?? 0);
  const proxyBlocked = new Set([...(slotState.proxyBlocked ?? []), ...fromProxy.origins.map(originOf).filter(Boolean)]);
  const runOrigins = new Set([...(rec.origins ?? []), ...(rec.allowOrigins ?? [])].map(originOf).filter(Boolean));
  const reported = new Set(slotState.blockedReported ?? []);
  const blockedNow = [];
  /** The run-outside origins a console line names as blocked (empty: the line is the page's own error). */
  const blockedIn = (line) => {
    const outside = [...line.matchAll(URL_IN_TEXT)].map((m) => originOf(m[0])).filter((x) => x && !runOrigins.has(x));
    return outside.filter((x) => BLOCKED_ERROR.test(line) || proxyBlocked.has(x));
  };
  const consoleLine = (line) => {
    const hit = blockedIn(line);
    for (const x of hit) if (!reported.has(x) && !blockedNow.includes(x)) blockedNow.push(x);
    return hit.length === 0;
  };
  if (p.cmd === "console") text = text.split("\n").filter((l) => !/^\[[A-Z]+\] /.test(l) || consoleLine(l)).join("\n");
  const consoleSeen = new Set(st.consoleSeen ?? []);
  try {
    const c = await cliCall(["console", "warning"], 30_000);
    for (const l of String(c.stdout).split("\n")) {
      const m = /^\[(ERROR|WARNING)\] (.*)$/.exec(l);
      if (!m || !consoleLine(l)) continue;
      const h = sha256(l).slice(0, 16);
      if (consoleSeen.has(h)) continue;
      consoleSeen.add(h);
      pageLines.push(`console ${m[1].toLowerCase()}: ${m[2]}`);
    }
  } catch {
    events.push("harness: observation failed");
  }
  st.consoleSeen = [...consoleSeen].slice(-1000);
  for (const x of blockedNow) pageLines.push(`blocked: ${new URL(x).origin}`);

  // Re-login: logged_in gone from the page while the account was signed in, and gone from a probe tab at
  // its base_url too (a page without the header is not a lost session). The command is not repeated.
  if (o && o.loggedIn === false && role !== "anon" && st.signedIn) {
    let gone = false;
    try {
      gone = !(await stage("probe", { url: plan.base, loggedIn: plan.loggedIn, settleMs: plan.settleMs })).in;
    } catch {
      events.push("harness: probe failed");
    }
    if (gone) {
      st.signedIn = false;
      let ok = false;
      try {
        if (r && r.login) {
          await closeSessions([session], { js, runner, cliRunner, graceMs: 3000 });
          await open();
          ok = st.signedIn;
        } else ok = (await signIn()).ok;
      } catch {
        ok = false;
      }
      events.push(ok ? `re-logged-in: ${account}` : "harness: login failed");
    }
  }
  save({ blockedOffset: fromProxy.offset, proxyBlocked: [...proxyBlocked].slice(-500), blockedReported: [...reported, ...blockedNow].slice(-500) });
  const { body, truncated } = fence([text, ...pageLines].filter((x) => x !== "").join("\n"), { secrets });
  return { code: 0, out: [body, counter, ...(seen > 1 ? [`loop ${seen}/${LOOP_AT}`] : []), ...events, ...(truncated ? [`truncated ${truncated} characters`] : [])] };
}
