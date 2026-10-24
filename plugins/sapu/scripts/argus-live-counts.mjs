// argus-live-counts.mjs — a return's repro targets counted on the explorer's live page (`submit --check` and
// `submit`): a target that matches more than one element fails every replay as `ambiguous-target`, so the
// explorer hears of it while it still stands on the page. An expectation is judged there too, once and by the
// repro's own evaluation, so one that can never be judged on its target (a text read of an input, a value of a
// div) is told while the explorer can still fix it. Only a step whose page is the live one is sound; every
// other step is named in a note. Reads the slot's open session, opens nothing.
import { sessionName } from "./argus-live-cli.mjs";
import { runCode } from "./argus-live-login.mjs";
import { browserHome } from "./argus-live-run.mjs";
import { CLICKS, JUDGE_TARGET, targetFn } from "./argus-live-steps.mjs";

/** The most steps a note lists. */
const LISTED = 8;
/** The expectations judged on the live page: the kinds the repro judges by one read of one element. */
const JUDGED = ["visible", "hidden", "enabled", "text-equals", "text-contains", "value-equals"];
/** The tags whose element has no text of its own: a void element, its innerText is always empty. */
const TEXTLESS = ["input", "img"];
/** The roles an input, a textarea or a select can have: `value-equals` on any other role's element throws on every page. */
const FIELD_ROLES = ["textbox", "searchbox", "combobox", "listbox", "spinbutton", "slider", "checkbox", "radio", "switch", "button"];
/** Why a step was not counted → the note's text. */
const WHY = {
  page: "the step's page is not the one its account stands on, or is not known",
  placeholder: "the target holds a {{placeholder}}",
  session: "the account has no open page",
  unread: "the live page could not be read",
  config: ".argus/live.json could not be read",
  repro: "the repro is not a valid repro",
  // The page as it stands now, not as the step met it (a form reset, a control gone): a hint, never a refusal.
  none: "an action's target matches nothing on the page as it stands now; check it still exists when the step runs",
};
/** Why an expectation cannot be judged where it stands → the note's text (the page now may differ from the step's: a note, never a refusal). */
const UNJUDGED = {
  textless: "a text expectation's target has no text of its own, an input or an image; read a field with value-equals, or target the element that holds the text",
  label: "a text expectation's target is a label that does not hold the text now; target the element that holds it",
  novalue: "a value-equals target is not an input, a textarea or a select",
  error: "the expectation cannot be evaluated on its target; a text expectation needs an HTML element",
};

/** The pathname of a repro path (`/orders?x=1` → `/orders`), else null. */
const pathOf = (p) => {
  try {
    return new URL(p, "http://x").pathname;
  } catch {
    return null;
  }
};

/**
 * The steps of a repro (parseRepro's) that have a target and the page each acts on → `[{s, page}]`, `page` the
 * pathname its account stands on at that step or null when that is not known. A `goto` and a `url`
 * expectation set it; a click, a double click, a key press, a `login` or a `go-back` may navigate and unset
 * it; every other step leaves it. A `count` expectation is left out: any number is its point.
 */
export function liveTargets(steps) {
  const at = new Map();
  const out = [];
  for (const s of steps) {
    if (s.as === "system") continue;
    if (s.target && s.expect !== "count") out.push({ s, page: at.get(s.as) ?? null });
    if (s.do === "goto") at.set(s.as, pathOf(s.path));
    else if (s.expect === "url") at.set(s.as, pathOf(s.value));
    else if (CLICKS.includes(s.do) || s.do === "go-back" || s.do === "login") at.set(s.as, null);
  }
  return out;
}

/**
 * The `run-code` text that answers `{path, counts, judged}`: the page's pathname, each target's match count (null
 * when it threw) and, for an expectation of a kind the repro judges by one read whose target matched exactly one
 * element, `{held}` (or `{threw: true}` when the evaluation threw) and the element's `tag`; null for the rest.
 * The evaluation is JUDGE_TARGET, the repro's own.
 */
const countCode = (steps) => {
  const Ps = steps.map((s) => (JUDGED.includes(s.expect) ? { kind: s.expect, value: s.value } : null));
  return `async page => {\n${JUDGE_TARGET}  const Ts = [${steps.map(targetFn).join(", ")}];\n  const Ps = ${JSON.stringify(Ps)};\n  const counts = [];\n  const judged = [];\n  for (const [k, T] of Ts.entries()) {\n    let n = null;\n    try {\n      n = await T(page).count();\n    } catch {\n      n = null;\n    }\n    counts.push(n);\n    let j = null;\n    if (Ps[k] && n === 1) {\n      j = {};\n      try {\n        j.held = (await judgeTarget(Ps[k], T)).held === true;\n      } catch {\n        j.threw = true;\n      }\n      try {\n        j.tag = await T(page).evaluate((el) => el.tagName.toLowerCase(), undefined, { timeout: 1000 });\n      } catch {\n        j.tag = null;\n      }\n    }\n    judged.push(j);\n  }\n  let path = "";\n  try {\n    path = new URL(page.url()).pathname;\n  } catch {\n    path = "";\n  }\n  return { path, counts, judged };\n}\n`;
};

/** Why expectation `s`, judged as `j` (the browser's answer for it), cannot be judged where it stands → a key of UNJUDGED, else null. */
function unjudged(s, j) {
  if (!j || typeof j !== "object" || !JUDGED.includes(s.expect)) return null;
  const text = s.expect === "text-equals" || s.expect === "text-contains";
  if (text && TEXTLESS.includes(j.tag)) return "textless";
  if (j.threw === true) return s.expect === "value-equals" ? "novalue" : "error";
  // A value naming a {{placeholder}} cannot hold before it is filled in.
  if (text && j.tag === "label" && j.held === false && !JSON.stringify(s.value).includes("{{")) return "label";
  return null;
}

/** The role of a `value-equals` target that fails on every page, else null: a role no input, textarea or select has. */
const neverField = (s) => {
  const t = s.target;
  return s.expect === "value-equals" && t && t.by === "role" && typeof t.role === "string" && !t.role.includes("{{") && !FIELD_ROLES.includes(t.role) ? t.role : null;
};

/** Skipped steps `[{i, n}]` as one line: `candidates[0] steps 2, 3; candidates[1] step 1` (at most LISTED steps, the rest counted); a candidate as a whole (`n` null) stands alone. */
function listed(rows) {
  const by = new Map();
  let shown = 0;
  for (const { i, n } of [...rows].sort((a, b) => a.i - b.i || (a.n ?? 0) - (b.n ?? 0))) {
    if (shown >= LISTED) break;
    shown += 1;
    by.set(i, [...(by.get(i) ?? []), n]);
  }
  const text = [...by].map(([i, ns]) => (ns[0] === null ? `candidates[${i}]` : `candidates[${i}] step${ns.length > 1 ? "s" : ""} ${ns.join(", ")}`)).join("; ");
  return rows.length > LISTED ? `${text}; and ${rows.length - LISTED} more` : text;
}

/**
 * The candidates' repro targets of a validated return `obj` counted on the page each account stands on →
 * `{errors, notes}`. `checks` is returnChecks' (null: nothing can be parsed), `run` the run record (its
 * `sessions`), `js` the browser CLI. An action's target must match exactly one element; an expectation's at
 * most one, since an absent target may be the very bug. An expectation whose target matches one is judged once
 * (JUDGE_TARGET): one that cannot be judged there is a note (UNJUDGED), the page now may differ from the step's.
 * Refused from the target's role alone, on any page: a `value-equals` on a role no input has. A step whose page
 * is not the live one, whose target holds a `{{placeholder}}`, or whose account has no open page is listed in a note, never refused. Nothing
 * page-derived is printed: the lines hold step numbers, accounts and counts only.
 */
export async function liveCounts(obj, { checks, run, runId, slot, js, cliRunner }) {
  const errors = [];
  const skipped = new Map();
  const skip = (why, i, n = null) => skipped.set(why, [...(skipped.get(why) ?? []), { i, n }]);
  const jobs = new Map();
  (Array.isArray(obj.candidates) ? obj.candidates : []).forEach((c, i) => {
    if (!Array.isArray(c.repro) || !JSON.stringify(c.repro).includes('"target"')) return;
    let steps = null;
    try {
      steps = checks ? checks.parseSteps(c.repro) : null;
    } catch {
      steps = null;
    }
    if (!steps) return skip(checks ? "repro" : "config", i);
    for (const { s, page } of liveTargets(steps)) {
      const role = neverField(s);
      if (role) errors.push(`candidates[${i}].repro step ${s.n}: value-equals reads the value of an input, a textarea or a select, and a ${role} never is one; target the field itself, or use text-equals`);
      else if (JSON.stringify(s.target).includes("{{")) skip("placeholder", i, s.n);
      else if (page === null) skip("page", i, s.n);
      else jobs.set(s.as, [...(jobs.get(s.as) ?? []), { s, page, i }]);
    }
  });
  for (const [account, list] of jobs) {
    const session = ((run && run.sessions) ?? []).find((x) => x && x.name === sessionName(runId, slot, account) && x.daemon);
    if (!session) {
      list.forEach((j) => skip("session", j.i, j.s.n));
      continue;
    }
    let answer = null;
    try {
      answer = await runCode({ js, session: session.name, cwd: session.cwd, home: browserHome(run), code: countCode(list.map((j) => j.s)), timeoutMs: 30_000, runner: cliRunner });
    } catch {
      answer = null;
    }
    if (!answer || typeof answer.path !== "string" || !Array.isArray(answer.counts)) {
      list.forEach((j) => skip("unread", j.i, j.s.n));
      continue;
    }
    list.forEach((j, k) => {
      const n = answer.counts[k];
      const why = unjudged(j.s, Array.isArray(answer.judged) ? answer.judged[k] : null);
      if (!Number.isInteger(n) || n < 0 || j.page !== answer.path) return skip(Number.isInteger(n) ? "page" : "unread", j.i, j.s.n);
      const where = `candidates[${j.i}].repro step ${j.s.n}: its target matches`;
      if (n > 1) errors.push(`${where} ${n} elements on the page ${account} stands on; make it match one (scope it with within, add exact, or choose with nth)`);
      else if (n === 0 && j.s.do) skip("none", j.i, j.s.n);
      else if (n === 1 && why) skip(why, j.i, j.s.n);
    });
  }
  const notes = [...skipped].map(([why, rows]) => (why in UNJUDGED ? `note: cannot be judged on the live page (${UNJUDGED[why]})` : `note: not counted on the live page (${WHY[why]})`) + `: ${listed(rows)}`);
  return { errors, notes };
}
