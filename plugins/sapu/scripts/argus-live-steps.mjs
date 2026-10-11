// argus-live-steps.mjs — the repro DSL (spec §10 "Repro format"; decisions 1, 5–8, 10–12, 26): a
// candidate's repro is data, never code. parseRepro checks a list before any browser work and
// normalizes it; substitute puts `{{marker}}` and the values a `read` saved in as literals; stepCode
// builds the wrapper's own `run-code` template of one browser step — its payload only as `const P =
// <JSON>;`, its target only through targetCode — whose every answer drains the session's hook;
// reductions names the units minimize may drop.
import { fillArgv } from "./argus-live-hooks.mjs";
import { HELPERS } from "./argus-live-login.mjs";
import { BLOCKED_ERROR } from "./argus-live-origin.mjs";
import { ORACLES } from "./argus-live-return.mjs";
import { configuredUser } from "./argus-live-session.mjs";
import { accountOf } from "./argus-live-slots.mjs";
import { targetCode } from "./argus-live-targets.mjs";

/** Decision 7: the expectation kinds each oracle's final may take, keys exactly ORACLES. */
export const FINAL_KINDS = {
  handoff: ["visible"],
  "status-coherence": ["fact-equals", "text-equals"],
  "dead-end": ["enabled"],
  reversal: ["fact-equals"],
  "orphaned-work": ["hidden"],
  "claim-race": ["count"],
  "stale-view": ["fact-equals"],
  "unreachable-step": ["visible"],
  "re-entry": ["value-equals"],
  discoverability: ["visible"],
  "interrupted-flow": ["count"],
  "viewport-locale": ["visible", "enabled"],
};

/** Each action's fields (`?` optional). */
const ACTIONS = {
  goto: ["path"],
  click: ["target"],
  dblclick: ["target"],
  hover: ["target"],
  check: ["target"],
  uncheck: ["target"],
  fill: ["target", "value"],
  select: ["target", "value"],
  press: ["key", "target?"],
  "go-back": [],
  reload: [],
  read: ["target", "save"],
  trigger: ["name", "values"],
  login: ["user", "password"],
};
/** Each expectation's fields. */
const EXPECTS = {
  visible: ["target"],
  hidden: ["target"],
  enabled: ["target"],
  "text-equals": ["target", "value"],
  "text-contains": ["target", "value"],
  "value-equals": ["target", "value"],
  count: ["target", "value"],
  url: ["value"],
  "fact-equals": ["marker", "field", "value"],
  mail: ["to", "contains"],
  "no-error": [],
};
/** Decision 6: the steps that always change state, and those that do when the page sent a request other than GET or HEAD meanwhile. */
const ALWAYS_CHANGES = ["select", "check", "uncheck", "trigger", "login"];
export const CLICKS = ["click", "dblclick", "press"];
/** What `system` may do: the role-free hooks, run through runHook. */
const HOOKED = ["trigger", "fact-equals", "mail"];
/** The five target kinds a repro may name (decision 5), and every key a target may hold. */
const TARGET_KINDS = ["role", "label", "text", "placeholder", "testId"];
const TARGET_KEYS = [...TARGET_KINDS, "name", "exact", "nth", "within"];
const CONTEXT_KEYS = ["viewport", "locale", "timezone"];
const SAVE = /^[a-z][a-z0-9_]{0,31}$/;
const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/;
const MAX_STEPS = 100;
const MAX_STRING = 500;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
/** How a refusal shows a word the candidate wrote: as given when it is short and plain, else not at all. */
const word = (s) => (typeof s === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(s) ? s : "that");
const keyWord = (k) => (/^[A-Za-z0-9_-]{1,40}$/.test(k) ? `"${k}"` : "(not shown)");

/** A reason a step is refused; parseRepro adds where. */
class Refusal extends Error {}
const refuse = (reason) => {
  throw new Refusal(reason);
};

/** Every string of `v` (a step, its target, its values), at most 500 characters without control characters. */
function checkStrings(v) {
  if (typeof v === "string") {
    if (v.length > MAX_STRING || CONTROLS.test(v)) refuse("a string is at most 500 characters, without control characters");
  } else if (Array.isArray(v)) v.forEach(checkStrings);
  else if (isObj(v)) Object.values(v).forEach(checkStrings);
}

/** A repro target (decision 5) → parseTarget's structure; `css`, `title`, `altText` and refs are refused. */
function targetOf(t, depth = 0) {
  const bad = () => refuse(`a target names one of ${TARGET_KINDS.join(", ")}`);
  if (!isObj(t) || depth > 8) bad();
  const keys = Object.keys(t);
  if (keys.some((k) => !TARGET_KEYS.includes(k))) bad();
  const kinds = keys.filter((k) => TARGET_KINDS.includes(k));
  if (kinds.length !== 1 || typeof t[kinds[0]] !== "string" || t[kinds[0]] === "") bad();
  const by = kinds[0];
  const out = by === "role" ? { by, role: t.role } : { by, value: t[by] };
  if (t.name !== undefined) {
    if (by !== "role" || typeof t.name !== "string") bad();
    out.name = t.name;
  }
  if (t.exact !== undefined) {
    if (by === "testId" || typeof t.exact !== "boolean") bad();
    out.exact = t.exact;
  }
  if (t.nth !== undefined) {
    if (!Number.isInteger(t.nth) || t.nth < -1 || t.nth > 1000) bad();
    out.nth = t.nth;
  }
  if (t.within !== undefined) out.within = targetOf(t.within, depth + 1);
  return out;
}

/** The repro's context element → `{viewport?, locale?, timezone?}` as given, each checked. */
function contextOf(el) {
  for (const k of Object.keys(el)) if (k !== "context") refuse(`unknown key ${keyWord(k)}`);
  const c = el.context;
  if (!isObj(c)) refuse("context is an object (viewport, locale, timezone)");
  for (const k of Object.keys(c)) if (!CONTEXT_KEYS.includes(k)) refuse(`unknown key ${keyWord(k)}`);
  const out = {};
  if (c.viewport !== undefined) {
    if (!Number.isInteger(c.viewport) || c.viewport < 200 || c.viewport > 4000) refuse("viewport must be from 200 to 4000");
    out.viewport = c.viewport;
  }
  if (c.locale !== undefined) {
    try {
      if (typeof c.locale !== "string" || !c.locale) throw new Error("no locale");
      Intl.getCanonicalLocales(c.locale);
    } catch {
      refuse("locale is not a BCP 47 tag");
    }
    out.locale = c.locale;
  }
  if (c.timezone !== undefined) {
    try {
      if (typeof c.timezone !== "string" || !c.timezone) throw new Error("no time zone");
      new Intl.DateTimeFormat("en-US", { timeZone: c.timezone });
    } catch {
      refuse("timezone is not one Intl knows");
    }
    out.timezone = c.timezone;
  }
  return out;
}

/** The highest `{i}` placeholder of a hook's argv: the number of values it takes. */
const arity = (argv) => Math.max(0, ...argv.flatMap((el) => [...String(el).matchAll(/\{(\d+)\}/g)].map((m) => Number(m[1]))));

/** One step `raw` (number `n`) checked and normalized → `{n, as, do|expect, …fields, final?}`. */
function stepOf(raw, n, { accounts, live }) {
  if (!isObj(raw)) refuse("unknown action");
  const isAction = Object.hasOwn(raw, "do");
  if (isAction === Object.hasOwn(raw, "expect")) refuse("unknown action");
  const kind = isAction ? raw.do : raw.expect;
  const table = isAction ? ACTIONS : EXPECTS;
  if (typeof kind !== "string" || !Object.hasOwn(table, kind)) refuse("unknown action");
  const fields = table[kind];
  const allowed = ["as", isAction ? "do" : "expect", "final", ...fields.map((f) => f.replace(/\?$/, ""))];
  for (const k of Object.keys(raw)) if (!allowed.includes(k)) refuse(`unknown key ${keyWord(k)}`);
  checkStrings(raw);
  let as;
  if (raw.as === "system") {
    if (!HOOKED.includes(kind)) refuse("system only triggers, reads facts and reads mail");
    as = "system";
  } else {
    try {
      as = accountOf({ accounts }, raw.as);
    } catch {
      refuse(`${word(raw.as)} is not allocated to this slot`);
    }
  }
  const step = { n, as, [isAction ? "do" : "expect"]: kind };
  const has = (f) => raw[f] !== undefined;
  const text = (f) => {
    if (typeof raw[f] !== "string") refuse(`${kind} takes ${fields.join(", ")}`);
    step[f] = raw[f];
  };
  for (const f of fields) {
    const name = f.replace(/\?$/, "");
    if (f.endsWith("?") && !has(name)) continue;
    if (name === "target") step.target = targetOf(raw.target);
    else if (name === "path") {
      if (typeof raw.path !== "string" || !/^\/(?![/\\])/.test(raw.path)) refuse("goto takes a path (/…)");
      step.path = raw.path;
    } else if (name === "key") {
      if (typeof raw.key !== "string" || !/^[A-Za-z0-9+]{1,32}$/.test(raw.key)) refuse("press takes a key (letters, digits and +, at most 32)");
      step.key = raw.key;
    } else if (name === "save") {
      if (typeof raw.save !== "string" || !SAVE.test(raw.save) || raw.save === "marker") refuse(`save takes a name (${SAVE.source}, not marker)`);
      step.save = raw.save;
    } else if (name === "values") {
      if (!Array.isArray(raw.values) || raw.values.some((v) => typeof v !== "string")) refuse("trigger takes name, values (strings)");
      step.values = [...raw.values];
    } else if (name === "value" && kind === "count") {
      if (!Number.isInteger(raw.value) || raw.value < 0 || raw.value > 10_000) refuse("count takes a target and a whole number");
      step.value = raw.value;
    } else if (name === "value" && kind === "fact-equals") {
      if (!["string", "number", "boolean"].includes(typeof raw.value)) refuse("fact-equals takes marker, field, value");
      step.value = raw.value;
    } else if (name === "value" && kind === "url") {
      if (typeof raw.value !== "string" || !/^\/(?![/\\])/.test(raw.value)) refuse("url takes a path (/…)");
      step.value = raw.value;
    } else if ((name === "user" || name === "password") && kind === "login") {
      if (typeof raw.user !== "string" || typeof raw.password !== "string" || !raw.user || !raw.password) refuse("login takes a user and a password (strings, placeholders allowed)");
      step[name] = raw[name];
    } else text(name);
  }
  if (kind === "login") {
    // Decision 26: an account of the allocation written with its number, never anon, never a configured user.
    if (typeof raw.as !== "string" || !raw.as.includes(".")) refuse("login's as names an account (<role>.<k>)");
    if (as.split(".")[0] === "anon") refuse("anon is never signed in");
    if (!/\{\{/.test(step.user) && configuredUser(live, step.user)) refuse("login takes an account the journey created, never a configured user");
    // The password goes to the ledger as `created password` and into the repro the issue quotes: a literal one
    // would refuse every issue of the finding, while one made from {{marker}} differs each run.
    if (!step.password.includes("{{marker}}")) refuse("login's password holds {{marker}} (a literal password would make the finding unfileable)");
  }
  if (kind === "trigger") {
    const hook = live.triggers && Object.hasOwn(live.triggers, step.name) ? live.triggers[step.name] : null;
    if (!hook) refuse(`trigger ${word(step.name)} is not in live.triggers`);
    const k = arity(hook.argv);
    if (step.values.length !== k) refuse(`trigger ${word(step.name)} takes ${k} value${k === 1 ? "" : "s"}`);
    // Literal values meet the trigger's regexes before any browser work; a placeholder's value after substitution.
    if (!step.values.some((v) => v.includes("{{"))) {
      try {
        fillArgv(hook.argv, hook.args, step.values, step.name);
      } catch (e) {
        refuse(e.message.replace(/^refused: /, ""));
      }
    }
  }
  if (raw.final !== undefined) {
    if (typeof raw.final !== "string" || !ORACLES.includes(raw.final)) refuse("final is not an oracle");
    if (isAction || !FINAL_KINDS[raw.final].includes(kind)) refuse(`${raw.final}'s final is ${FINAL_KINDS[raw.final].join(" or ")}`);
    step.final = raw.final;
  }
  return step;
}

/** True when step `s` changes state: always (decision 6), or a click, double click or press the run recorded in `changed`. */
const changesState = (s, changed) => ALWAYS_CHANGES.includes(s.do) || (CLICKS.includes(s.do) && changed.has(s.n));

/**
 * The proving expect of state-changing step `n` of `steps` (decision 6) → its number, or null: a trigger's is
 * the first expect of any account before the next state-changing step; any other's the first expect as the
 * same account after it (after its parallel group, when it is in one) before that account's next action
 * other than `read`. `changed` (a Set) holds the click-family steps the run recorded as changing state.
 */
export function provingExpect(steps, n, changed = new Set()) {
  const i = steps.findIndex((s) => s.n === n);
  const s = steps[i];
  if (s.do === "trigger") {
    for (const x of steps.slice(i + 1)) {
      if (x.expect) return x.n;
      if (changesState(x, changed)) return null;
    }
    return null;
  }
  let j = i + 1;
  if (s.group) while (j < steps.length && steps[j].group === s.group) j += 1;
  for (const x of steps.slice(j)) {
    if (x.as !== s.as) continue;
    if (x.expect) return x.n;
    if (x.do !== "read") return null;
  }
  return null;
}

/**
 * A candidate's repro `list` (validateReturn's array) checked before any browser work → `{context, steps}`.
 * `accounts` is the slot's allocation (`{"<role>.<k>": user}`), `live` the expanded config. The first
 * element may be `{"context": {viewport, locale, timezone}}` (each optional; defaults: live's first viewport,
 * its locale and timezone, else 1440, en-US, UTC); every other element is a step or `{"parallel": [2 to 8
 * actions of different accounts]}`, whose members get `group` (1-based). Steps are numbered from 1 (the
 * context not counted, a group's members each counted), `as` resolved to `<role>.<k>` or `system`, targets
 * in parseTarget's structure. Checks: each step's shape (decision 5, 26), placeholders used only after the
 * `read` that saves them, one `final`, on the last step, with its oracle's kinds (decision 7) and template
 * (claim race, interrupted flow), and every always-state-changing step's proving expect (decision 6). A
 * fault throws `refused: repro: step <n>: <reason>` (`refused: repro: context: <reason>` for the context).
 */
export function parseRepro(list, { accounts, live }) {
  const at = (n, reason) => new Error(`refused: repro: ${n === null ? "context" : `step ${n}`}: ${reason}`);
  if (!Array.isArray(list)) throw new Error("refused: repro: a repro is a list of steps");
  const context = { viewport: (Array.isArray(live.viewports) && live.viewports[0]) || 1440, locale: live.locale || "en-US", timezone: live.timezone || "UTC" };
  let items = list;
  if (isObj(list[0]) && Object.hasOwn(list[0], "context")) {
    try {
      Object.assign(context, contextOf(list[0]));
    } catch (e) {
      if (!(e instanceof Refusal)) throw e;
      throw at(null, e.message);
    }
    items = list.slice(1);
  }
  const steps = [];
  let n = 0;
  let groups = 0;
  const one = (raw) => {
    n += 1;
    if (n > MAX_STEPS) throw at(n, `at most ${MAX_STEPS} steps`);
    try {
      return stepOf(raw, n, { accounts, live });
    } catch (e) {
      if (!(e instanceof Refusal)) throw e;
      throw at(n, e.message);
    }
  };
  for (const item of items) {
    if (!isObj(item) || !Object.hasOwn(item, "parallel")) {
      steps.push(one(item));
      continue;
    }
    const first = n + 1;
    const group = (groups += 1);
    const bad = () => at(first, "a parallel group holds 2 to 8 actions of different accounts");
    for (const k of Object.keys(item)) if (k !== "parallel") throw at(first, `unknown key ${keyWord(k)}`);
    if (!Array.isArray(item.parallel)) throw bad();
    const members = item.parallel.map((raw) => ({ ...one(raw), group }));
    const accountsIn = new Set(members.map((s) => s.as));
    if (members.length < 2 || members.length > 8 || accountsIn.size !== members.length || members.some((s) => !s.do || s.do === "trigger" || s.do === "login" || s.final !== undefined)) throw bad();
    steps.push(...members);
  }
  if (!steps.length) throw new Error("refused: repro: a repro holds at least one step");

  // Placeholders: {{marker}}, and a name only after the read that saves it (a group's reads, after the group).
  const known = new Set(["marker"]);
  let pending = [];
  steps.forEach((s, i) => {
    const used = [];
    const scan = (v) => {
      if (typeof v === "string") for (const m of v.matchAll(PLACEHOLDER)) used.push(m[1]);
      else if (Array.isArray(v)) v.forEach(scan);
      else if (isObj(v)) Object.values(v).forEach(scan);
    };
    for (const [k, v] of Object.entries(s)) if (!["n", "as", "do", "expect", "final", "save", "group"].includes(k)) scan(v);
    const unknown = used.find((u) => !known.has(u));
    if (unknown !== undefined) throw at(s.n, `{{${/^[A-Za-z0-9_]{1,32}$/.test(unknown) ? unknown : "that"}}} is used before a read saves it`);
    if (s.save) pending.push(s.save);
    if (!s.group || (steps[i + 1] && steps[i + 1].group !== s.group) || !steps[i + 1]) {
      pending.forEach((x) => known.add(x));
      pending = [];
    }
  });

  const finals = steps.filter((s) => s.final !== undefined);
  if (finals.length > 1) throw at(finals[1].n, "one final only");
  if (finals.length === 1 && finals[0] !== steps.at(-1)) throw at(finals[0].n, "final must be the last step");
  for (const s of steps) {
    if (!ALWAYS_CHANGES.includes(s.do) || provingExpect(steps, s.n) !== null) continue;
    throw at(s.n, s.do === "trigger" ? "trigger changes state: an expect must follow before the next state-changing step" : `${s.do} changes state: an expect as ${s.as} must follow before its next action`);
  }
  const final = steps.at(-1);
  if (final.final === undefined) throw at(final.n, "the last step must be an expect naming its oracle (final)");
  if (final.final === "claim-race") {
    const raced = Array.from({ length: groups }, (_, g) => steps.filter((s) => s.group === g + 1).map((s) => s.as.split(".")[0])).some((roles) => roles.some((r, i) => roles.indexOf(r) !== i));
    if (!raced) throw at(final.n, "claim-race needs a parallel group of two accounts of one role before its final");
  }
  if (final.final === "interrupted-flow") {
    const before = steps.at(-2);
    if (!before || before.expect !== "no-error" || before.as !== final.as) throw at(final.n, "interrupted-flow needs no-error right before its final");
  }
  return { context, steps };
}

/** A copy of `step` with every `{{name}}` in its string fields (its target and values included) replaced by `vars[name]`, a literal; a name `vars` lacks stays as written. */
export function substitute(step, vars) {
  const sub = (v) => {
    if (typeof v === "string") return v.replace(PLACEHOLDER, (m, name) => (Object.hasOwn(vars, name) ? String(vars[name]) : m));
    if (Array.isArray(v)) return v.map(sub);
    if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sub(x)]));
    return v;
  };
  return Object.fromEntries(Object.entries(step).map(([k, v]) => [k, ["n", "as", "do", "expect", "final", "save", "group"].includes(k) ? v : sub(v)]));
}

/**
 * What every step template has after HELPERS: the run's origins, which errors count (decision 11: a 5xx of
 * a run origin, a console or page error unless it carries Chrome's blocked-request errors, names an origin
 * outside the run's, or is Chrome's `Failed to load resource` line for a status), and `finish`, through
 * which every answer leaves: the hook's drain of the context, its counted errors with it.
 */
const COMMON = `  const BLOCKED = ${BLOCKED_ERROR};
  const RUN = new Set(P.runOrigins);
  const ofRun = (u) => URL.canParse(u) && RUN.has(new URL(u).origin);
  const outside = (text) => [...String(text).matchAll(/\\b(?:https?|wss?):\\/\\/[^\\s'"<>()\\]]+/g)].some((m) => !ofRun(m[0]));
  const counted = (errors) => errors.filter((e) => (e.kind === "5xx" ? ofRun(e.url) : !BLOCKED.test(e.text) && !/^Failed to load resource: the server responded with a status of \\d+/.test(e.text) && !outside(e.text)));
  const failure = (e) => String((e && e.message) || e).split("\\n")[0].slice(0, 200);
  const finish = async (x) => {
    const d = await drain(ctx);
    return { ...x, errors: counted(d.errors), drain: d };
  };
`;

/**
 * An action: its target awaited up to settle_ms (else `missing-target`), the parallel barrier `P.at` (epoch
 * ms) awaited, the action with the context's requests watched (`changed` when one was neither GET nor HEAD,
 * `method` the first such), the page's load awaited and 300 ms more for its requests to start → `{ok:
 * true, changed, method, value?}` (`value` a read's: an input's, textarea's or select's value, else the
 * trimmed innerText, at most 500 characters), or `{ok: false, why: "missing-target"|"timeout"|"error", detail}`.
 */
const ACTION = `  const step = async () => {
    const L = T ? T(page) : null;
    if (L && !(await settle(async () => (await L.count()) > 0, P.settleMs))) return { ok: false, why: "missing-target" };
    if (P.at) await pause(Math.max(0, P.at - Date.now()));
    let changed = false;
    let method = null;
    const onRequest = (r) => {
      if (r.method() !== "GET" && r.method() !== "HEAD") {
        changed = true;
        method = method || r.method();
      }
    };
    const timeout = P.settleMs;
    let value;
    ctx.on("request", onRequest);
    try {
      if (P.kind === "goto") await page.goto(P.url, { timeout });
      else if (P.kind === "go-back") await page.goBack({ timeout });
      else if (P.kind === "reload") await page.reload({ timeout });
      else if (P.kind === "press" && !L) await page.keyboard.press(P.key);
      else if (P.kind === "press") await L.press(P.key, { timeout });
      else if (P.kind === "fill") await L.fill(P.value, { timeout });
      else if (P.kind === "select") await L.selectOption(P.value, { timeout });
      else if (P.kind === "click") await L.click({ timeout });
      else if (P.kind === "dblclick") await L.dblclick({ timeout });
      else if (P.kind === "hover") await L.hover({ timeout });
      else if (P.kind === "check") await L.check({ timeout });
      else if (P.kind === "uncheck") await L.uncheck({ timeout });
      else if (P.kind === "read") {
        const tag = await L.evaluate((el) => el.tagName.toLowerCase(), undefined, { timeout });
        value = (["input", "textarea", "select"].includes(tag) ? await L.inputValue({ timeout }) : (await L.innerText({ timeout })).trim()).slice(0, 500);
      } else return { ok: false, why: "error", detail: "no such action" };
      await page.waitForLoadState("load", { timeout }).catch(() => {});
      await pause(300);
    } catch (e) {
      return { ok: false, why: e && e.name === "TimeoutError" ? "timeout" : "error", detail: failure(e) };
    } finally {
      ctx.off("request", onRequest);
    }
    return { ok: true, changed, method, ...(value === undefined ? {} : { value }) };
  };
`;

/**
 * An expectation, polled every 200 ms in the page up to settle_ms, held at the first success (decision 11)
 * → `{held, observed, shown?, detail?}`, `observed` (decision 8) `absent`, `hidden`, `visible`, `disabled`,
 * `differs`, `count:<k>`, or `error` when the last poll threw (a strict-mode violation, a page gone): the
 * runner never counts that as reproduced. `shown` is what the page showed (the URL, the count, the text). `no-error` only drains: the runner judges the account's errors.
 */
const EXPECT = `  const judge = async () => {
    if (P.kind === "url") {
      const u = new URL(page.url());
      return u.pathname + u.search === P.value || u.pathname === P.value ? { held: true } : { held: false, observed: "differs", shown: u.pathname + u.search };
    }
    const L = T(page);
    const n = await L.count();
    if (P.kind === "count") return n === P.value ? { held: true } : { held: false, observed: "count:" + n, shown: n };
    if (P.kind === "hidden") return n === 0 || !(await L.isVisible()) ? { held: true } : { held: false, observed: "visible" };
    if (n === 0) return { held: false, observed: "absent" };
    const shown = await L.isVisible();
    if (P.kind === "visible") return shown ? { held: true } : { held: false, observed: "hidden" };
    if (P.kind === "enabled") return shown && (await L.isEnabled()) ? { held: true } : { held: false, observed: shown ? "disabled" : "hidden" };
    const text = P.kind === "value-equals" ? await L.inputValue({ timeout: 1000 }) : (await L.innerText({ timeout: 1000 })).trim();
    return (P.kind === "text-contains" ? text.includes(P.value) : text === P.value) ? { held: true } : { held: false, observed: "differs", shown: text.slice(0, 500) };
  };
  const step = async () => {
    if (P.kind === "no-error") return { held: true, observed: null };
    const end = Date.now() + P.settleMs;
    for (;;) {
      let r;
      try {
        r = await judge();
      } catch (e) {
        r = { held: false, observed: "error", detail: failure(e) };
      }
      if (r.held || Date.now() >= end) return { observed: null, ...r };
      await pause(200);
    }
  };
`;

/**
 * The `run-code` text of browser step `step` (normalized and substituted; a `goto`'s `url` set by the
 * runner after checkUrl): `async page => {…}` with `const P = <JSON>;` (its kind, value, key, url, the
 * runner's settle_ms, the parallel barrier `at` and the run's origins — never its target), `const T =
 * (pg) => <targetCode>;` (or `null`), HELPERS, COMMON, the action's or the expectation's `step`, and the
 * answer through `finish` — a throw too. A `login` (signed in through the driver) and the hooks (`trigger`,
 * `fact-equals`, `mail`, run through runHook) have no template.
 */
export function stepCode(step, { settleMs, at = null, runOrigins }) {
  const kind = step.do ?? step.expect;
  if (step.do === "login" || HOOKED.includes(kind)) throw new Error(`failed: ${kind} has no template`);
  const P = { kind, settleMs, at, runOrigins };
  for (const k of ["url", "value", "key"]) if (step[k] !== undefined) P[k] = step[k];
  const T = step.target ? `(pg) => ${targetCode(step.target, "pg")}` : "null";
  const fail = step.do ? '{ ok: false, why: "error", detail: failure(e) }' : '{ held: false, observed: "error", detail: failure(e) }';
  return `async page => {\n  const P = ${JSON.stringify(P)};\n  const T = ${T};\n${HELPERS}${COMMON}${step.do ? ACTION : EXPECT}  try {\n    return await finish(await step());\n  } catch (e) {\n    return await finish(${fail});\n  }\n}\n`;
}

/**
 * The removal units minimize tries, in order (decision 10): each role but `system` and the final step's
 * role (all its steps), in the order they first act; then, from the last step back, each step that is not
 * the final, a trigger, a parallel group's member or a proving expect — a state-changing step (always, or
 * a click-family step in `changed`, the reproducing run's record) together with its proving expect, and
 * never a role's only state-changing step → `[{kind: "role"|"step", label, drop: [n…]}]`.
 */
export function reductions(steps, { changed = [] } = {}) {
  const ch = new Set(changed);
  const final = steps.at(-1);
  const roleOf = (s) => s.as.split(".")[0];
  const units = [];
  for (const role of [...new Set(steps.map(roleOf))].filter((r) => r !== "system" && r !== roleOf(final))) {
    units.push({ kind: "role", label: `role ${role}`, drop: steps.filter((s) => roleOf(s) === role).map((s) => s.n) });
  }
  const stateful = steps.filter((s) => changesState(s, ch));
  const proves = new Map(stateful.map((s) => [s.n, provingExpect(steps, s.n, ch)]));
  const proving = new Set([...proves.values()].filter((x) => x !== null));
  for (const s of [...steps].reverse()) {
    if (s === final || s.do === "trigger" || s.group || proving.has(s.n)) continue;
    if (!changesState(s, ch)) {
      units.push({ kind: "step", label: `step ${s.n}`, drop: [s.n] });
      continue;
    }
    const p = proves.get(s.n);
    if (p === null || p === final.n || stateful.filter((x) => x.do !== "trigger" && roleOf(x) === roleOf(s)).length < 2) continue;
    units.push({ kind: "step", label: `steps ${s.n}+${p}`, drop: [s.n, p] });
  }
  return units;
}
