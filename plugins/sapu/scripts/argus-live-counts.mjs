// argus-live-counts.mjs — a return's repro targets counted on the explorer's live page (`submit --check` and
// `submit`): a target that matches more than one element fails every replay as `ambiguous-target`, so the
// explorer hears of it while it still stands on the page. Only the count of a step whose page is the live
// one is sound; every other step is named in a note. Reads the slot's open session, opens nothing.
import { sessionName } from "./argus-live-cli.mjs";
import { runCode } from "./argus-live-login.mjs";
import { browserHome } from "./argus-live-run.mjs";
import { CLICKS, targetFn } from "./argus-live-steps.mjs";

/** The most steps a note lists. */
const LISTED = 8;
/** Why a step was not counted → the note's text. */
const WHY = {
  page: "the step's page is not the one its account stands on, or is not known",
  placeholder: "the target holds a {{placeholder}}",
  session: "the account has no open page",
  unread: "the live page could not be read",
  config: ".argus/live.json could not be read",
  repro: "the repro is not a valid repro",
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

/** The `run-code` text that answers `{path, counts}`: the page's pathname and each target's match count (null when it threw). */
const countCode = (steps) =>
  `async page => {\n  const Ts = [${steps.map(targetFn).join(", ")}];\n  const counts = [];\n  for (const T of Ts) {\n    try {\n      counts.push(await T(page).count());\n    } catch {\n      counts.push(null);\n    }\n  }\n  let path = "";\n  try {\n    path = new URL(page.url()).pathname;\n  } catch {\n    path = "";\n  }\n  return { path, counts };\n}\n`;

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
 * most one, since an absent target may be the very bug. A step whose page is not the live one, whose target
 * holds a `{{placeholder}}`, or whose account has no open page is listed in a note, never refused. Nothing
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
      if (JSON.stringify(s.target).includes("{{")) skip("placeholder", i, s.n);
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
      if (!Number.isInteger(n) || n < 0 || j.page !== answer.path) return skip(Number.isInteger(n) ? "page" : "unread", j.i, j.s.n);
      const where = `candidates[${j.i}].repro step ${j.s.n}: its target matches`;
      if (n > 1) errors.push(`${where} ${n} elements on the page ${account} stands on; make it match one (scope it with within, add exact, or choose with nth)`);
      else if (n === 0 && j.s.do) errors.push(`${where} nothing on the page ${account} stands on; fix the target, or leave the page as the step needs it`);
    });
  }
  const notes = [...skipped].map(([why, rows]) => `note: not counted on the live page (${WHY[why]}): ${listed(rows)}`);
  return { errors, notes };
}
