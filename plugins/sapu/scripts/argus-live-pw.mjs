// argus-live-pw.mjs — the explorer's only way into a browser (spec §9 "The wrapper", §7 "Budget, loops,
// handoff"): `argus-live.mjs pw <token> <role>[.<k>] <command> [args]`. Every command is allowlisted with
// its flags; every URL is inside the run's origins; every value goes to the CLI after `--`, so none is
// read as an option; every byte the page or the CLI printed is fenced by a fresh nonce; the budget, the
// loop rule and the deadline are kept per token, under the slot's lock. The wrapper builds every argv;
// the explorer never reaches the CLI, and its token is never printed, logged or written.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { slotDir } from "./argus-live-browser.mjs";
import { expandConfig, loadLive, loadSmoke, ROLE_FREE, SMOKE_DEFAULTS } from "./argus-live-config.mjs";
import { fence } from "./argus-live-fence.mjs";
import { codeCommand, runHook } from "./argus-live-hooks.mjs";
import { appendLedger } from "./argus-live-ledger.mjs";
import { LAYOUT_KINDS, pageExpression } from "./argus-live-layout.mjs";
import { submit } from "./argus-live-return.mjs";
import { BLOCKED_ERROR, checkUrl, originOf, shown } from "./argus-live-origin.mjs";
import { redact, run, runAsync, sleep } from "./argus-live-proc.mjs";
import { blockedSince } from "./argus-live-proxy.mjs";
import { readRun } from "./argus-live-run.mjs";
import { writeVerdict } from "./argus-live-scrub.mjs";
import { boundSeed, sourceLines } from "./argus-live-seed.mjs";
import { configuredUser, maskSecrets, sessionDriver } from "./argus-live-session.mjs";
import { accountOf, readSlotState, refuseNotLive, slotLockWaitMs, tokenSlot, withSlotLock, writeSlotState } from "./argus-live-slots.mjs";
import { pathChecks } from "./argus-live-steps.mjs";
import { explorerTarget } from "./argus-live-targets.mjs";

/** The budget when `limits.explorer_pw_calls` is not set (spec §8's example). */
export const DEFAULT_CALLS = 120;
/** The same command on the same state this many times is a loop. */
const LOOP_AT = 3;
/** `find`'s answer when nothing matched (0.1.22: "No matches found for …"). */
const NO_MATCH = /^### Result\nNo matches found for /m;
/** A URL in a console line (Chrome names the request it failed, and where). */
const URL_IN_TEXT = /\b(?:https?|wss?):\/\/[^\s'"<>()\]]+/g;
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
  layout: { args: ["check?"] },
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
  source: { roleFree: true, args: [] },
};

/** `source` on any token but a seed map slot's. */
const SOURCE_ONLY = "refused: source takes a seed map slot's token (slot <n> --map --seed)";

/**
 * The explorer's argv → `{token, account | null, cmd, flags, positionals}` (`account` the word as given,
 * accountOf resolves it): `argv[0]` the token, `argv[1]` a role-free command or an account word, then the
 * command. Flags come before the first positional (`--` ends them; after the first positional everything
 * is a positional) and must be the command's own; the positionals' count must fit the command. Refused:
 * a command off the allowlist, any other flag (`-s`, `--session`, `--config`, `--filename`, …), a flag
 * value that does not fit, a wrong number of arguments.
 */
const PW_USAGE = "pw <token> <role>[.<k>] <command> [args] | pw <token> <code|trigger|facts|mail|submit|source> [args]";

export function parsePw(argv) {
  if (!Array.isArray(argv) || argv.length < 2) throw new Error(`refused: ${PW_USAGE}`);
  const token = argv[0];
  const roleFree = ROLE_FREE.includes(argv[1]);
  const account = roleFree ? null : argv[1];
  const cmd = roleFree ? argv[1] : argv[2];
  const rest = argv.slice(roleFree ? 2 : 3);
  if (typeof cmd !== "string" || !Object.hasOwn(COMMANDS, cmd) || Boolean(COMMANDS[cmd].roleFree) !== roleFree) {
    if (!roleFree && cmd !== undefined && Object.hasOwn(COMMANDS, cmd)) throw new Error(`refused: ${cmd} takes no role (pw <token> ${cmd} …)`);
    if (cmd === undefined) {
      // One word after the token: an account with no command, or a command the explorer does not have (`show`).
      const w = argv[1];
      if (/^[a-z][a-z0-9_-]*\.[1-9][0-9]?$/.test(w)) throw new Error(`refused: no command follows ${w}: ${PW_USAGE}`);
      throw new Error(`refused: ${/^[a-z][a-z0-9_-]{0,40}$/.test(w) ? w : "that word"} is not an explorer command, and no command follows it as an account: ${PW_USAGE}`);
    }
    throw new Error(`refused: ${/^[a-z][a-z0-9-]{0,40}$/.test(cmd) ? cmd : "that"} is not an explorer command`);
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
    case "check":
      if (!LAYOUT_KINDS.includes(value)) throw bad(`a layout check (${LAYOUT_KINDS.join(", ")})`);
      return value;
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

/** At most this many violations of a `layout` answer are listed. */
const LAYOUT_LISTED = 40;

/**
 * The `{check, key}` rows the layout oracle skips for `journey` (spec §19.7, as the generated suite does): the
 * journey's `allow` in .argus/smoke.json and its adopted known violations, `<smoke dir>/known/<journey>.json`.
 * A missing file holds none; one that is not valid is refused (`failed: <file> is not valid …`, no text of it).
 */
export function layoutSkips(main, journey) {
  if (typeof journey !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(journey)) return [];
  const loaded = loadSmoke(main);
  if (loaded.errors.length) throw new Error("failed: .argus/smoke.json is not valid");
  const smoke = loaded.smoke ?? SMOKE_DEFAULTS;
  const rows = (v) => (Array.isArray(v) ? v : []).filter((r) => r && typeof r.check === "string" && typeof r.key === "string").map(({ check, key }) => ({ check, key }));
  const mine = smoke.journeys && Object.hasOwn(smoke.journeys, journey) ? smoke.journeys[journey] : null;
  const rel = path.posix.join(smoke.dir, "known", `${journey}.json`);
  let known = [];
  try {
    known = rows(JSON.parse(fs.readFileSync(path.join(main, rel), "utf8")));
  } catch (e) {
    if (e && e.code === "ENOENT") known = [];
    else throw new Error(`failed: ${rel} is ${e instanceof SyntaxError ? "not valid JSON" : "unreadable"}`);
  }
  return [...rows(mine && mine.allow), ...known];
}

/**
 * A `layout` answer (`{ok, found}`, the page's) as the explorer reads it: `layout [<check>]: <n> violations`, then one
 * `<check> <key>: <detail>` line each (at most 40, the rest counted), less the rows in `skip`; only rows of the
 * shape and the check asked are kept. Page-derived, so the caller fences it.
 */
function layoutText(ans, check, skip) {
  const what = check ? `layout ${check}` : "layout";
  if (!ans || ans.ok !== true || !Array.isArray(ans.found)) return `${what}: unavailable (the page changed or has not loaded; ask again)`;
  const one = (v) => String(v).replace(/\s+/g, " ").trim();
  const rows = ans.found.filter((f) => f && typeof f.check === "string" && typeof f.key === "string" && LAYOUT_KINDS.includes(f.check) && (!check || f.check === check) && !skip.some((x) => x.check === f.check && x.key === f.key));
  if (rows.length === 0) return `${what}: no violations`;
  return [`${what}: ${rows.length} violation${rows.length === 1 ? "" : "s"}`, ...rows.slice(0, LAYOUT_LISTED).map((f) => `${f.check} ${one(f.key)}: ${typeof f.detail === "string" ? one(f.detail) : ""}`), ...(rows.length > LAYOUT_LISTED ? [`(${rows.length - LAYOUT_LISTED} more not listed)`] : [])].join("\n");
}

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/** The PNG files right in a slot's `out/` (a screenshot the CLI wrote is one of them). */
function pngsIn(dir) {
  try {
    return new Set(fs.readdirSync(path.join(dir, "out"), { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith(".png")).map((e) => e.name));
  } catch {
    return new Set();
  }
}

/**
 * One explorer call (spec §9): `argv` = `[token, <role>[.<k>] | <role-free command>, …]` → `{code, out}`
 * (`out` the lines to print). In order: the token (tokenSlot: unknown or retired is refused and counts
 * nothing); the run live (refuseNotLive: an `up --fresh` under way or a `down` sealing it is refused, all
 * but `submit`, counting nothing); under the slot's lock: the deadline (`DEADLINE: submit status aborted`, all but `submit`),
 * the budget (`BUDGET: submit status handoff` past `limits.explorer_pw_calls`, all but `submit`; else the
 * call is counted, refusals included); the grammar and every argument (parsePw, accountOf, checkUrl, …);
 * an account whose login failed this run (`HARNESS: …`); the loop rule (the same command on the same
 * state a third time → `LOOP: submit status handoff`, not run); the session, opened and signed in on
 * first use (invisibly); the command, its positionals after `--` (a browser gone → the session opened
 * again and signed in, `session-reopened: <role.k>`, the command not run; a `find` with no match asked
 * again every 500 ms up to settle_ms, `found|not found after <ms> ms`); the observation (the state hash
 * the loop rule reads, the hook's drain kept in the run's secret ledger — the account `drained: false`
 * in its state from the session's first use in the call until then —, the signals of every page, the console's new errors and warnings, the origins the
 * run blocked that a page named, once per slot as `blocked: <origin>`; after a `screenshot`, each PNG it
 * wrote gets its verdict beside it, read after that drain (writeVerdict: the `shot` stage over every frame;
 * never printed); logged_in gone from the page and
 * from a probe tab at the role's base_url → signed in again once, `re-logged-in: <role.k>`, the command not
 * repeated; every probe told as `probed: <role.k>` and logged to `logs/probes.jsonl`); and the output: the CLI's answer and the page's lines in one nonce fence, then `calls
 * <c>/<max>`, `loop <n>/3` and the wrapper's own events. `login <user> <password>` signs the session in as
 * an account the journey created (its password appended to the run's secret ledger first, as `created
 * password`; `login: ok` or `login: failed (<reason>)`; kept in state.json
 * `created` for its re-logins once it worked; its failures in state.json `createdFailed`, never in run.json
 * `loginFailed`); a user of `roles.*.users` is refused, whichever slot holds it. Every write of the slot's
 * state re-checks that the run is still live (stillLive): a `down` meanwhile is refused, nothing left. `submit` is handled before
 * the config is read (it needs only the slot). The role-free `code`, `trigger`, `facts` and `mail`
 * (argus-live-hooks.mjs) print their output in the fence, then `exit <n>` when it was not 0. Exit codes: 0 the command ran (a CLI
 * error is page data, inside the fence), 1 refused or BUDGET/LOOP/DEADLINE/HARNESS, 2 the wrapper failed.
 * A map slot's token (decision 20) takes `code` and `submit` only, also in a run with no instance (mapCall); a
 * seed map slot's also `source` (spec §19.12). `source` on any other token is refused, and counted.
 * `layout [<check>]` (spec §19.15) is not a CLI command: the wrapper runs the layout oracle's own expression in the
 * page (a `run-code` template of its making; the explorer names only one of its four checks) and prints the violations
 * it found, less the journey's `allow` and adopted known rows (layoutSkips), in the fence.
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
  if (word !== "submit") {
    try {
      // A map slot needs no instance (decision 20): only its run named and not sealed.
      if (found.mode === "map" && (found.run.closing || found.run.runId !== runId)) throw new Error(`refused: cycle ${runId} is being torn down`);
      if (found.mode !== "map") refuseNotLive(found.run, runId);
    } catch (e) {
      return { code: 1, out: [e.message] };
    }
  }
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

/**
 * What a return's `path` and `heal` are checked with (spec §19.4, §19.9): the slot's accounts, live.json as
 * the run expands it, smoke.json's `heal_max_steps` → pathChecks, or null when either file cannot be read
 * (a return holding neither never asks).
 */
function returnChecks(main, slotRec) {
  const { config, errors, secrets } = loadLive(main);
  const s = loadSmoke(main);
  if (!config || errors.length || s.errors.length) return null;
  const rec = readRun(main);
  const live = expandConfig(config, { ports: { ...((rec && rec.ports) ?? {}) }, secrets });
  return pathChecks({ accounts: slotRec.accounts, live, healMax: (s.smoke ?? SMOKE_DEFAULTS).heal_max_steps });
}

/** The body of pw, under the slot's lock. */
async function call({ main, argv, word, runId, slot, dir, cli, now, runner, cliRunner, setSecrets }) {
  // The token again, under the lock: a handoff may have retired it meanwhile.
  // The lock too: a renew may have moved the deadline while this call waited for the slot.
  const { rec: slotRec, lock: lockNow } = tokenSlot(main, argv[0]);
  // submit needs only the slot's record: past DEADLINE and BUDGET, never counted, and a .argus/live.json
  // gone bad meanwhile never blocks the return. Its line holds enums only; a refusal leaves the token live.
  if (word === "submit") {
    try {
      return { code: 0, out: [submit(main, { runId, slot, rec: slotRec }, parsePw(argv).positionals[0], { checks: () => returnChecks(main, slotRec) })] };
    } catch (e) {
      if (!/^refused: /.test(e.message)) throw e;
      return { code: 1, out: [e.message] };
    }
  }
  if (slotRec.mode === "map") return mapCall({ main, argv, word, runId, slot, dir, lockNow, now });
  refuseNotLive(readRun(main), runId);
  if (lockNow.deadline * 1000 <= now()) return { code: 1, out: ["DEADLINE: submit status aborted"] };
  const { config, errors, secrets: envSecrets } = loadLive(main);
  if (!config || errors.length) throw new Error(`failed: .argus/live.json: ${errors.join("; ")}`);
  const rec = readRun(main);
  const live = expandConfig(config, { ports: { ...(rec.ports ?? {}) }, secrets: envSecrets });
  const max = (live.limits && live.limits.explorer_pw_calls) || DEFAULT_CALLS;
  const state = readSlotState(dir);
  const secrets = maskSecrets(main, config, live, state);
  setSecrets(secrets);
  if (state.calls >= max) return { code: 1, out: ["BUDGET: submit status handoff"] };
  const ifLive = { main, runId }; // each write of the slot's state re-checks the run (stillLive)
  state.calls += 1;
  writeSlotState(dir, state, ifLive);
  const counter = `calls ${state.calls}/${max}`;
  const refused = (e) => {
    if (!/^refused: /.test(e.message)) throw e;
    return { code: 1, out: [e.message, counter] };
  };
  let p;
  let account = null;
  try {
    p = parsePw(argv);
    if (p.cmd === "source") throw new Error(SOURCE_ONLY);
    if (p.account !== null) account = accountOf(slotRec, p.account);
  } catch (e) {
    return refused(e);
  }
  if (p.account === null) {
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

  // A created account's failed logins are kept in the slot's state.json `createdFailed`, never in run.json `loginFailed`.
  const createdFailures = {
    get: (key) => {
      const f = readSlotState(dir).createdFailed ?? {};
      return Object.hasOwn(f, key) ? f[key] : null;
    },
    set: (key, reason) => {
      const cur = readSlotState(dir);
      writeSlotState(dir, { ...cur, createdFailed: { ...(cur.createdFailed ?? {}), [key]: reason } }, ifLive);
    },
  };
  const js = cli ?? (rec.browser && rec.browser.js);
  // The account's session (argus-live-session.mjs): its credentials, its state and every CLI call it makes.
  const d = sessionDriver({ main, runId, slot, account, rec, live, envSecrets, slotRec, dir, js, failures: createdFailures, runner, cliRunner });
  const { role, plan } = d;
  const r = live.roles && live.roles[role];
  let positionals;
  try {
    positionals = p.positionals.map((v, i) => checkArg(COMMANDS[p.cmd].args[Math.min(i, COMMANDS[p.cmd].args.length - 1)], v, { origins: rec.origins ?? [], base: plan.base, files: path.join(dir, "files") }));
    if (p.cmd === "login" && role === "anon") throw new Error("refused: anon is never signed in");
    // A configured user (any slot's, any role's, spelled in any case) is the wrapper's to sign in: an explorer's
    // failed attempt would end another slot's journey and count towards the app's lockout of that user.
    if (p.cmd === "login" && configuredUser(live, positionals[0])) throw new Error("refused: login takes an account the journey created, never a configured user");
  } catch (e) {
    return refused(e);
  }

  const c0 = d.credentials();
  const user = (c0 ?? {}).user ?? slotRec.accounts[account];
  const failedBefore = c0 && c0.created ? createdFailures.get(`${role}/${user}`) : user && rec.loginFailed && Object.hasOwn(rec.loginFailed, `${role}/${user}`);
  if (p.cmd !== "login" && failedBefore) return { code: 1, out: [`HARNESS: ${account} cannot sign in this cycle; submit status aborted`, counter] };

  // The loop rule: the same command on the same state (the last observation's hash) a third time.
  const key = sha256(JSON.stringify([account, p.cmd, p.flags, p.positionals, d.state.lastState ?? null]));
  const seen = (state.loops[key] ?? 0) + 1;
  state.loops = { ...state.loops, [key]: seen };
  writeSlotState(dir, state, ifLive);
  if (seen >= LOOP_AT) return { code: 1, out: ["LOOP: submit status handoff", counter] };

  if (typeof js !== "string" || !fs.existsSync(js)) throw new Error("failed: the browser CLI is not installed (run.json names none, or it is gone)");
  const save = (extra = {}) => {
    const after = readSlotState(dir);
    writeSlotState(dir, { ...after, ...extra, sessions: { ...(after.sessions ?? {}), [account]: d.state } }, ifLive);
  };

  // The session: opened on first use (and hooked: a hook that failed is told) and signed in, invisibly (anon never is).
  const { record: session, events: opening } = await d.ensure();
  // From here until the observation drains it, what the session's hook gathers is not in the ledger yet.
  d.state.drained = false;
  save();
  if (p.cmd === "login") {
    // An account the journey created: signed in on this session; kept for its re-logins only once it worked.
    // Its password goes to the run's secret ledger first, so scrub refuses it after down too.
    const [u, password] = positionals;
    setSecrets({ ...secrets, "login:password": password });
    appendLedger(main, runId, [{ c: "created password", v: password }]);
    const done = await d.signIn({ user: u, password, totpSecret: null, created: true });
    save(done.ok ? { created: { ...(readSlotState(dir).created ?? {}), [account]: { user: u, password } } } : {});
    return { code: 0, out: [counter, ...opening, done.ok ? "login: ok" : `login: failed (${/^error: /.test(done.reason) ? "error" : done.reason})`] };
  }
  if (role !== "anon" && !d.state.signedIn) {
    if (!(r && r.login) && !(await d.signIn()).ok) return { code: 1, out: [`HARNESS: ${account} cannot sign in this cycle; submit status aborted`, counter] };
  }

  const args = [p.cmd, ...p.flags, ...(positionals.length ? ["--", ...positionals] : [])];
  const shotsBefore = p.cmd === "screenshot" ? pngsIn(dir) : null;
  /** `layout`: the oracle's own expression run in the page (never an argument of the explorer's), its answer put in words. */
  const layout = async () => {
    const check = positionals[0];
    const skip = layoutSkips(main, slotRec.journey);
    const code = `async page => {\n  try {\n    return { ok: true, found: await page.evaluate(${JSON.stringify(pageExpression("layout", check ? { only: [check] } : {}))}) };\n  } catch (e) {\n    return { ok: false };\n  }\n}\n`;
    try {
      return { code: 0, stdout: layoutText(await d.code(code), check, skip), stderr: "" };
    } catch (e) {
      if (!/^failed: run-code/.test(e.message)) throw e;
      return { code: 1, stdout: "", stderr: e.message };
    }
  };
  let res = p.cmd === "layout" ? await layout() : await d.cli(args);
  const events = [...opening];
  // The browser is gone (it crashed, or was closed): the session opens again and signs in; the command is not run.
  if (d.gone(res, session)) {
    events.push(...(await d.reopen(session)));
    save();
    return { code: 0, out: [counter, ...events] };
  }
  // Absence is never instant: a find with no match is asked again every 500 ms up to settle_ms.
  if (p.cmd === "find" && res.code === 0 && NO_MATCH.test(res.stdout)) {
    const start = Date.now();
    while (res.code === 0 && NO_MATCH.test(res.stdout) && Date.now() - start < plan.settleMs) {
      await sleep(Math.min(500, Math.max(0, plan.settleMs - (Date.now() - start))));
      res = await d.cli(args);
    }
    // A retry the CLI failed prints its error (in the fence) and no verdict.
    if (res.code === 0) events.push(`${NO_MATCH.test(res.stdout) ? "not found" : "found"} after ${Date.now() - start} ms`);
  }
  let text = baseNames(`${res.stdout}${res.code !== 0 && res.stderr ? `\n${res.stderr}` : ""}`, dir).trimEnd();
  if (p.cmd === "request") text = maskHeaders(text);

  // Observation: the signals of every page (popups included), the state hash, logged_in; then the console's new errors and warnings.
  const pageLines = [];
  const { o, events: observed } = await d.observe();
  events.push(...observed);
  // A screenshot's verdict, read after that drain and written beside it (decision 18); nothing of it is printed.
  if (shotsBefore && res.code === 0) {
    const taken = [...pngsIn(dir)].filter((f) => !shotsBefore.has(f));
    let shot = null;
    try {
      if (taken.length) shot = await d.stage("shot", {});
    } catch {
      shot = null; // unread: the verdict says secret
    }
    for (const f of taken) writeVerdict(main, runId, path.join(dir, "out", f), shot, { drained: Boolean(o) });
  }
  if (o && typeof o === "object") {
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
  const consoleSeen = new Set(d.state.consoleSeen ?? []);
  try {
    const c = await d.cli(["console", "warning"], 30_000);
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
  d.state.consoleSeen = [...consoleSeen].slice(-1000);
  for (const x of blockedNow) pageLines.push(`blocked: ${new URL(x).origin}`);

  // Re-login: logged_in gone from the page while the account was signed in, and gone from a probe tab at
  // its base_url too (a page without the header is not a lost session). The command is not repeated.
  events.push(...(await d.relogin(o)));
  save({ blockedOffset: fromProxy.offset, proxyBlocked: [...proxyBlocked].slice(-500), blockedReported: [...reported, ...blockedNow].slice(-500) });
  const { body, truncated } = fence([text, ...pageLines].filter((x) => x !== "").join("\n"), { secrets });
  return { code: 0, out: [body, counter, ...(seen > 1 ? [`loop ${seen}/${LOOP_AT}`] : []), ...events, ...(truncated ? [`truncated ${truncated} characters`] : [])] };
}

/**
 * A map slot's call (decision 20), under the slot's lock: the deadline and the budget as an explorer's,
 * then `code` only (anything else but `submit`, handled before, is `refused: a map slot takes only code and
 * submit`, counted); its output fenced and masked with the env file's values. A seed map slot (spec §19.12)
 * also takes `source`: the run's seed in a SOURCE fence (sourceLines), read from the run's files only: no
 * process, no browser, no network (`refused: a seed map slot takes only code, source and submit`). Each
 * write of the slot's state re-checks that the run is not sealed (stillLive's map form).
 */
async function mapCall({ main, argv, word, runId, slot, dir, lockNow, now }) {
  const rec = readRun(main);
  if (!rec || rec.runId !== runId || rec.closing) throw new Error(`refused: cycle ${runId} is being torn down`);
  if (lockNow.deadline * 1000 <= now()) return { code: 1, out: ["DEADLINE: submit status aborted"] };
  const { config, secrets } = loadLive(main);
  const max = (config && config.limits && config.limits.explorer_pw_calls) || DEFAULT_CALLS;
  const state = readSlotState(dir);
  if (state.calls >= max) return { code: 1, out: ["BUDGET: submit status handoff"] };
  state.calls += 1;
  writeSlotState(dir, state, { main, runId, map: true });
  const counter = `calls ${state.calls}/${max}`;
  try {
    const seeded = boundSeed(dir) !== null;
    if (word === "source") {
      if (!seeded) throw new Error(SOURCE_ONLY);
      parsePw(argv);
      const { lines, truncated } = sourceLines(main, runId, slot, dir, { secrets });
      return { code: 0, out: [...lines, counter, ...(truncated ? [`truncated ${truncated} characters`] : [])] };
    }
    if (word !== "code") throw new Error(seeded ? "refused: a seed map slot takes only code, source and submit" : "refused: a map slot takes only code and submit");
    const p = parsePw(argv);
    const c = codeCommand(p.positionals[0], p.positionals.slice(1), { worktree: rec.worktree });
    const { body, truncated } = fence(String(c.text).trimEnd(), { secrets });
    return { code: 0, out: [body, counter, ...(c.code !== 0 && c.code !== null ? [`exit ${c.code}`] : []), ...(truncated ? [`truncated ${truncated} characters`] : [])] };
  } catch (e) {
    if (!/^refused: /.test(e.message)) throw e;
    return { code: 1, out: [e.message, counter] };
  }
}
