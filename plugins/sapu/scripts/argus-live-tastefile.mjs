// argus-live-tastefile.mjs — filing the taste pass's confirmed rows (spec §20.5, plan decision 19): first-class
// `ux` issues, one per `taste:<rule>:<screen key>`, at most `cap` a cycle (the rest queued, ranked again when the
// next judge confirms them), each through scrub (`scrub --create`, the run's filed.jsonl); measured S4 coherence
// items in the cycle's one `[polish]` roll-up; and the owner's accept.
//
// What files, and only that (precision is what makes a taste finding taken seriously):
// - a judge row (`<run>/taste/judge.json`, lane J's) measured two of two (`confirmed: true`), of a rule the bar holds
//   with the class the bar gives it, neither information only nor in taste.json's `off`;
// - a `bar` row only with an internal witness (the owner's tokens or frame, or the app's own peer screen): never for
//   differing from the outside range alone;
// - never a row taste.json `accept`s or the state holds `accepted`, never one an open issue already names (by the
//   state's issue, else by its title key in the title of any issue gh lists), never one whose issue the owner closed
//   as not planned (their ruling: `taste accept` is staged on their word only).
// Severity is aesthetics.md §7's by outcome, as a fixed table per rule (OUTCOME), plus the efficiency cost: a row
// costing 10 s or more of klm_s a run is S3. No row is rated above S3 here: §7's S1/S2 owe the money arithmetic
// (SKILL.md §5), which only an orchestrator can write. needs-owner goes on a consistency split with no majority and
// on a row the Curator's verdict disputes (reject, or polish on an S3 row); an S4 row the Curator rejects is held.
import fs from "node:fs";
import path from "node:path";
import { classify } from "./argus-live-classes.mjs";
import { readSeen } from "./argus-live-ledger.mjs";
import { lastRun, liveDir, RUN_ID } from "./argus-live-lock.mjs";
import { run as spawnRun, tempBeside } from "./argus-live-proc.mjs";
import { NO_MAJORITY } from "./argus-live-ease.mjs";
import { defang, filedFile, redactIds, scrub, scrubRun, scrubSecrets } from "./argus-live-scrub.mjs";
import { CURATOR_FILE, FAMILIES, PASS_OFF, ROW_IDENTITY, tasteOff, validateCurator, loadBar, loadTaste, readCuratorFile, readTasteState, RULE_CLASSES, SCREEN_KEY, shotName, TASTE_FILE, TASTE_STATE_FILE, titleKey, validateTaste, writeTasteState } from "./argus-live-tastecfg.mjs";
import { loadContract, needsOwnerLabel, resolvePolicy } from "./sapu-contract.mjs";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const num = (v) => typeof v === "number" && Number.isFinite(v);
/** A journey id as the state keeps it. */
const JOURNEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ROW_ID = /^t[1-9][0-9]{0,5}$/;
const RULE_ID = /^([a-z]+)\.[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** The longest key, measured value or witness value a row may hold (lane 0's finding format). */
const TEXT_MAX = 300;
const WITNESS_KINDS = ["tokens", "frame", "peer", "band"];
/** The witnesses inside the app: the owner's tokens (or the frame they adopted) and the app's own best peer screen. */
const INTERNAL = ["tokens", "frame", "peer"];
/** A judge row's `expected` for a consistency split where no way holds a majority (two screens, two ways). */
const EFFICIENCY = ["actions", "best", "klm_s", "typed", "fitts_bits", "modals", "wait_ms", "recovery"];
/** The most issues gh's listing returns for the dedupe (every state: a closed issue may be the owner's ruling). Titles are compared, never printed. */
const ISSUE_LIMIT = 2000;
/** The most rows one `[polish]` roll-up lists; the rest stay queued. */
const POLISH_MAX = 30;
const RANK = { S1: 1, S2: 2, S3: 3, S4: 4 };
/** Seconds of klm_s a run that make any row S3 (decision 19), unless the bar's efficiency.klm says otherwise. */
const COST_S = 10;

/**
 * aesthetics.md §7 by outcome, one fixed rating per rule: the rules whose measured failure changes or blocks what the
 * user does on a journey's screen are S3, each with its reason; every other rule is coherence without an action
 * consequence, S4.
 */
const OUTCOME = {
  "colour.role": "one status shown in two colours: SC 3.2.4 (AA) on a journey's screen (aesthetics.md §4)",
  "colour.dark-contrast": "text under its WCAG 2.2 contrast minimum in the dark theme only (SC 1.4.3, AA)",
  "feedback.busy": "a wait over 1 s with no busy signal: the user cannot tell the action is working",
  "feedback.progress": "a wait over 10 s with no determinate progress",
  "states.error": "a failed data request leaves the screen with no way to retry or leave",
  "states.success": "a successful write the page never names: the user cannot tell it happened",
  "states.recovery": "fields lost after a rejected submit: the user types them again",
  "copy.broken": "a value rendered as broken copy where the user reads it",
  "ai.error": "an AI surface's error leaves no way on",
  "efficiency.actions": "an efficiency regression: the best known path no longer holds and this one costs 3× its actions",
  "efficiency.klm": "an efficiency regression: the best known path no longer holds and this one costs 10 s or more of klm_s",
};
const CLASS_WORDS = { implicit: "broken on its face", derived: "the app contradicts itself or its tokens", bar: "beyond the outside range, with an internal witness; never a bug" };

/** Where the judge's record of run `runId` lies. */
export const judgeFile = (main, runId) => path.join(liveDir(main), runId, "taste", "judge.json");
/** Where the Curator's return of run `runId` lies (-tastecfg CURATOR_FILE, validateCurator's shape). */
export const curatorFile = (main, runId) => path.join(liveDir(main), runId, CURATOR_FILE);

const text = (v) => typeof v === "string" && v.length <= TEXT_MAX && !/[\r\n]/.test(v);
const value = (v) => v === null || num(v) || text(v);

/** One judge row's fault in words, or null (lane 0's shape; keys beyond it are ignored). */
function rowFault(r) {
  if (!isObj(r)) return "is not an object";
  if (typeof r.row !== "string" || !ROW_ID.test(r.row)) return "row must be t<k>";
  if (typeof r.journey !== "string" || !JOURNEY.test(r.journey) || r.journey.length > 100) return "journey must be a journey id";
  const m = typeof r.rule === "string" ? RULE_ID.exec(r.rule) : null;
  if (!m || !Object.hasOwn(FAMILIES, m[1])) return "rule must be a rule id of a known family";
  if (!RULE_CLASSES.includes(r.class)) return `class must be ${RULE_CLASSES.join(", ")}`;
  if (typeof r.screen !== "string" || !SCREEN_KEY.test(r.screen)) return "screen must be a screen key";
  if (!text(r.key) || r.key === "") return `key must be 1-${TEXT_MAX} characters on one line`;
  if (!value(r.measured) || !value(r.expected)) return "measured and expected must be numbers or short strings";
  if (!Array.isArray(r.witnesses) || r.witnesses.length > WITNESS_KINDS.length || !r.witnesses.every((w) => isObj(w) && WITNESS_KINDS.includes(w.kind) && value(w.value) && (w.from === undefined || value(w.from)))) return "witnesses must be at most four {kind: tokens|frame|peer|band, value, from}";
  if (!(r.cost === null || (num(r.cost) && r.cost >= 0))) return "cost must be klm_s seconds or null";
  if (!(r.confirmed === null || typeof r.confirmed === "boolean")) return "confirmed must be null, true or false";
  return null;
}

/** A journey's entry of judge.json → its fault in words, or null. */
function journeyFault(j) {
  if (!isObj(j)) return "is not an object";
  if (!((Number.isSafeInteger(j.screens) && j.screens >= 0) || (Array.isArray(j.screens) && j.screens.every((s) => typeof s === "string" && SCREEN_KEY.test(s))))) return "screens must be a count or a list of screen keys";
  if (!(j.efficiency === null || j.efficiency === undefined || (isObj(j.efficiency) && EFFICIENCY.every((k) => j.efficiency[k] === undefined || j.efficiency[k] === null || (num(j.efficiency[k]) && j.efficiency[k] >= 0))))) return `efficiency must be null or {${EFFICIENCY.join(", ")}}, each a number or null`;
  return null;
}

/**
 * Run `runId`'s judge record (`<run>/taste/judge.json`, lane 0's shape: `{version: 1, run, bar, rows, journeys}`) →
 * `{judge, fault}`: both null when there is none; `fault` the words naming what is out of shape (nothing is guessed
 * at, and nothing from it files).
 */
export function readJudge(main, runId) {
  let j;
  try {
    j = JSON.parse(fs.readFileSync(judgeFile(main, runId), "utf8"));
  } catch (e) {
    if (e && e.code === "ENOENT") return { judge: null, fault: null };
    return { judge: null, fault: `taste/judge.json ${e instanceof SyntaxError ? "is not valid JSON" : "cannot be read"}` };
  }
  const no = (why) => ({ judge: null, fault: `taste/judge.json ${why}` });
  if (!isObj(j) || j.version !== 1 || !Array.isArray(j.rows) || !isObj(j.journeys) || !Number.isSafeInteger(j.bar) || j.bar < 1) return no("is not {version: 1, run, bar, rows, journeys}");
  if (j.run !== runId) return no("is not this run's");
  const ids = new Set();
  for (const [i, r] of j.rows.entries()) {
    const f = rowFault(r);
    if (f) return no(`row ${i + 1}: ${f}`);
    if (ids.has(r.row)) return no(`row ${i + 1}: ${r.row} is taken`);
    ids.add(r.row);
  }
  for (const [id, x] of Object.entries(j.journeys)) {
    if (!JOURNEY.test(id) || id.length > 100) return no("journeys must be keyed by journey ids");
    const f = journeyFault(x);
    if (f) return no(`journey ${id}: ${f}`);
  }
  return { judge: j, fault: null };
}

/** A judge row's identity across the judges of one run (ROW_IDENTITY): a second judge renumbers rows, never this. */
const identity = (x) => ROW_IDENTITY.map((k) => x[k]).join("\n");

/**
 * Run `runId`'s Curator return (`<run>/taste/curator.json`, as `taste curator` stored it) → `{verdicts: Map<row,
 * {verdict, reason}>, substitutions, cw, fault}`: each verdict matched to the row of `rows` (judge.json's, as it is now)
 * with its journey, rule, screen and key, never by the row id the Curator read (a later judge renumbers), a verdict
 * matching no row dropped, the first of a row kept. None → empty; out of shape → empty with the fault's words.
 */
export function readCurator(main, runId, rows) {
  const verdicts = new Map();
  const { value, fault } = readCuratorFile(path.join(liveDir(main), runId));
  if (!value) return { verdicts, substitutions: [], cw: [], fault };
  const byIdentity = new Map(rows.map((r) => [identity(r), r.row]));
  for (const v of value.verdicts) {
    const row = byIdentity.get(identity(v));
    if (row && !verdicts.has(row)) verdicts.set(row, { verdict: v.verdict, reason: v.reason.slice(0, 500) });
  }
  return { verdicts, substitutions: value.substitutions, cw: value.cw, fault: null };
}

/**
 * `taste curator <file>` → `{code, lines}`: the Curator's return (the JSON in `file`, which the orchestrator saved from
 * the agent's answer) checked whole by validateCurator, each verdict stored with its row's journey, rule, screen and key
 * as the run's judge.json (the one the Curator read) names them, a verdict naming no row dropped and counted, written
 * to `<run>/taste/curator.json` (0600, beside, then renamed). The run is the lock's, else the newest. Refused, nothing
 * written: no run, no judge.json, a file that cannot be read or is not JSON, a return out of shape (its first faults,
 * never its text).
 */
export function tasteCurator(main, file) {
  const refuse = (why) => {
    throw new Error(`refused: taste curator: ${why}`);
  };
  const runId = lastRun(main);
  if (runId === null) refuse("no run here");
  const { judge, fault } = readJudge(main, runId);
  if (fault) refuse(fault);
  if (!judge) refuse(`run ${runId} has no taste/judge.json (run taste judge first)`);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path.resolve(main, String(file)), "utf8"));
  } catch (e) {
    refuse(`the return ${e instanceof SyntaxError ? "is not valid JSON" : "cannot be read"}`);
  }
  const { value, errors } = validateCurator(raw);
  if (!value) refuse(`the Curator's return is out of shape: ${errors.slice(0, 5).join("; ")}`);
  const rows = new Map(judge.rows.map((r) => [r.row, r]));
  const seen = new Set();
  const verdicts = [];
  for (const v of value.verdicts) {
    const r = rows.get(v.row);
    if (!r || seen.has(v.row)) continue;
    seen.add(v.row);
    verdicts.push({ row: v.row, ...Object.fromEntries(ROW_IDENTITY.map((k) => [k, r[k]])), verdict: v.verdict, reason: v.reason });
  }
  const out = path.join(liveDir(main), runId, CURATOR_FILE);
  fs.renameSync(tempBeside(out, `${JSON.stringify({ ...value, verdicts })}\n`, 0o600), out);
  const dropped = value.verdicts.length - verdicts.length;
  return { code: 0, lines: [`taste curator: run ${runId}: ${verdicts.length} verdicts${dropped ? ` (${dropped} naming no judge row, or a row twice, dropped)` : ""}, ${value.leads.length} leads, ${value.substitutions.length} substitutions, ${value.cw.length} walkthrough answers → ${CURATOR_FILE}`] };
}

/** A row's severity and why → `{severity, why}` (OUTCOME, then the cost). */
function severityOf(r, costS) {
  if (num(r.cost) && r.cost >= costS) return { severity: "S3", why: `it costs ${r.cost} s of klm_s a run (${costS} s or more is S3)` };
  if (Object.hasOwn(OUTCOME, r.rule)) return { severity: "S3", why: OUTCOME[r.rule] };
  return { severity: "S4", why: "coherence without an action consequence (aesthetics.md §7)" };
}

/** `s` as a code span its own backticks cannot close (CommonMark). */
const code = (s) => {
  const n = Math.max(0, ...(String(s).match(/`+/g) ?? []).map((x) => x.length)) + 1;
  const pad = /^`|`$/.test(s) ? " " : "";
  return `${"`".repeat(n)}${pad}${s}${pad}${"`".repeat(n)}`;
};
const routeOf = (screen) => screen.split("|")[0];
const viewportOf = (screen) => screen.split("|").slice(1).join(" × ");
/** Groups of rows by rank: severity, then cost (highest first), then witnesses (most first), then the first row. */
const byRank = (a, b) => RANK[a.severity] - RANK[b.severity] || (b.cost ?? -1) - (a.cost ?? -1) || b.witnesses - a.witnesses || a.n - b.n;
/**
 * A row as the issue quotes it: one JSON line inside a `json` block (page text never reaches the prose). Of the
 * Curator's verdict only its word: its reason is model text written from untrusted screenshots, never an issue's.
 */
const record = (r, extra = {}) => JSON.stringify({ ...extra, row: r.row, journey: r.journey, key: r.key, measured: r.measured, expected: r.expected, witnesses: r.witnesses, cost: r.cost, ...(r.curator ? { curator: { verdict: r.curator.verdict } } : {}) });

/** The issue's title: the title key, then the metric and, for one row of numbers, value → expected. */
function titleOf(g) {
  const [r] = g.rows;
  if (g.rows.length > 1) return `${g.key} — ${g.rule.metric} on ${g.rows.length} elements`;
  return num(r.measured) && num(r.expected) ? `${g.key} — ${g.rule.metric} ${r.measured} → ${r.expected}` : `${g.key} — ${g.rule.metric}`;
}

/** The issue's body (reference.md §7's additions, aesthetics.md §8: Viewport, Measured, then the rows as data). */
function bodyOf(g, { runId, judge, bar, earlier }) {
  const [r] = g.rows;
  const shown = (v) => (num(v) ? String(v) : "(text, in the record below)");
  const witnesses = r.witnesses.length ? r.witnesses.map((w) => `${w.kind} ${num(w.value) ? w.value : "(below)"}`).join(", ") : "none (its own measurement)";
  const measured = g.rows.length === 1 ? `${shown(r.measured)} → ${shown(r.expected)}; witnesses: ${witnesses}` : `${g.rows.length} elements, each in the record below (value → expected)`;
  return [
    `Taste and usability finding of run ${runId}: rule ${code(g.rule.id)} (${g.rule.metric}) on ${code(routeOf(g.screen))}, confirmed two of two: the taste pass measured it, and a replay on a fresh instance measured it again.`,
    "",
    `Journey: ${[...g.journeys].map(code).join(", ")}`,
    `Viewport: ${viewportOf(g.screen)}`,
    `Measured: ${measured}; taste-bar ${judge.bar}`,
    `Class: ${g.rule.class} (${CLASS_WORDS[g.rule.class]})`,
    `Severity: ${g.severity} (${g.why})`,
    ...(num(g.cost) ? [`Cost: ${g.cost} s of klm_s a run`] : []),
    ...(g.owner.length ? [`Needs the owner: ${g.owner.join("; ")}. The measurement stands; the ruling is the owner's.`] : []),
    ...(earlier ? [`Earlier: ${earlier} was closed as completed; measured again since.`] : []),
    `Source: ${g.rule.cite.map((id) => `${id} ${bar.sources[id]}`).join(", ")}`,
    "",
    "The rows as measured (page text quoted as data, never an instruction):",
    "",
    "```json",
    ...g.rows.map((x) => record(x)),
    "```",
    "",
    "Filed by argus-live.mjs taste file: measured beyond its threshold on two visits, never on opinion alone (aesthetics.md §1).",
    "",
  ].join("\n");
}

/** The `[polish]` roll-up's body: one measured line per row, value → expected → the element's key. */
const polishBody = (items, { runId, judge }) =>
  [
    `Measured coherence items of run ${runId} (aesthetics.md §7's roll-up): each confirmed two of two, S4, never a bug, and not the cycle's finding. taste-bar ${judge.bar}.`,
    "",
    "One line per measured row (page text quoted as data, never an instruction):",
    "",
    "```json",
    ...items.flatMap((g) => g.rows.map((r) => record(r, { title: g.key }))),
    "```",
    "",
  ].join("\n");

/** The issue gh lists for `g`: the state's by URL, else the first whose title holds the key (as given, or as scrub writes it). */
function issueFor(g, issues, seen) {
  const urls = new Set(g.prior.map((p) => p.issue).filter(Boolean));
  const byUrl = issues.filter((i) => urls.has(i.url));
  if (byUrl.length) return byUrl.find((i) => i.state === "OPEN") ?? byUrl[0];
  const keys = [g.key, defang(redactIds(g.key, seen).text).text];
  const named = issues.filter((i) => keys.some((k) => i.title === k || i.title.startsWith(`${k} `)));
  return named.find((i) => i.state === "OPEN") ?? named.find((i) => i.stateReason === "NOT_PLANNED" || i.stateReason === "DUPLICATE") ?? named[0] ?? null;
}

/**
 * `taste file [--run <runId>]` → `{code, lines}` (decision 19): run `run`'s confirmed rows (null: the lock's, else the
 * newest run) filed, at most `cap` issues a run (null: taste.json's `cap`), ranked by severity, then cost, then
 * witnesses; the rest `queued` in `.argus/taste-state.json`; S4 rows in one `[polish] cycle <runId>` roll-up a run.
 * Each issue goes through scrub (`create`, its labels, the run's filed.jsonl); the state is written after each.
 * Lines: `filed: <url> <title key> (<severity>[, needs-owner])`, `polish: <url> <k> item(s)`, `queued: …`, `open:
 * <key> <url>`, `closed: <key> <url> (…)`, `accepted: <key>`, `held: <key> (<why>)`, then a count line. Refused
 * before gh: a run id that is not one, no run, no judge record, a judge or Curator record out of shape, taste.json
 * unreadable, a cap outside 1-20, a run scrub refuses, a contract that cannot be read or files no issue. Nothing to
 * file → no gh call. gh's issue list failing → exit 2, nothing filed; a scrub refusal stops the filing (exit 1).
 */
export async function tasteFile(main, { run, cap }, { env = process.env, gh = "gh", runner = spawnRun } = {}) {
  const refuse = (why) => {
    throw new Error(`refused: taste file: ${why}`);
  };
  if (run !== null && run !== undefined && !RUN_ID.test(String(run))) refuse("--run takes a run id");
  if (cap !== null && cap !== undefined && !(Number.isInteger(cap) && cap >= 1 && cap <= 20)) refuse("cap must be an integer from 1 to 20");
  const runId = run ?? lastRun(main);
  if (runId === null) refuse("no run here");
  if (!fs.existsSync(path.join(liveDir(main), runId))) refuse(`no run ${runId} here`);
  const { taste, errors } = loadTaste(main);
  if (!taste) refuse(`${TASTE_FILE}: ${errors.join("; ")}`);
  if (tasteOff(taste)) return { code: 0, lines: [`taste file: run ${runId}: ${PASS_OFF}`] };
  const capN = cap ?? taste.cap;
  const bar = loadBar();
  const { judge, fault } = readJudge(main, runId);
  if (fault) refuse(fault);
  if (!judge) refuse(`run ${runId} has no taste/judge.json (run taste judge first)`);
  const cur = readCurator(main, runId, judge.rows);
  if (cur.fault) refuse(cur.fault);
  const state = readTasteState(main);
  const rules = new Map(bar.rules.map((r) => [r.id, r]));
  const klm = rules.get("efficiency.klm");
  const costS = klm && num(klm.threshold.plus_s) ? klm.threshold.plus_s : COST_S;
  const accepted = new Set(taste.accept.map((a) => titleKey(a.rule, a.key)));
  const lines = [`taste file: run ${runId}, taste-bar ${judge.bar}, cap ${capN}`];
  const held = new Map();

  // The confirmed rows, grouped by title key; each group's severity, cost, witnesses and needs-owner reasons.
  const groups = new Map();
  judge.rows.forEach((r, n) => {
    if (r.confirmed !== true) return;
    const rule = rules.get(r.rule);
    const key = titleKey(r.rule, r.screen);
    if (!rule || rule.class !== r.class) return held.set(key, `the bar's rule ${r.rule} is not the one judged (taste-bar ${judge.bar}, now ${bar.version})`);
    if (rule.info || taste.off.includes(r.rule)) return;
    if (r.class === "bar" && !r.witnesses.some((w) => INTERNAL.includes(w.kind))) return held.set(key, "a bar row without an internal witness");
    const { severity, why } = severityOf(r, costS);
    const v = cur.verdicts.get(r.row);
    const owner = [];
    if (rule.family === "consistent" && r.expected === NO_MAJORITY) owner.push("a consistency split with no majority: two ways, neither the app's own rule");
    if (v && v.verdict === "reject") {
      if (severity === "S4") return held.set(key, "the Curator rejected an S4 coherence item");
      owner.push("the Curator rejected the measured row");
    }
    if (v && v.verdict === "polish" && severity !== "S4") owner.push(`the Curator rated it polish; measured ${severity}`);
    const g = groups.get(key) ?? { key, rule, screen: r.screen, rows: [], journeys: new Set(), severity, why, cost: null, witnesses: 0, owner: [], n };
    g.rows.push(v ? { ...r, curator: { verdict: v.verdict, reason: v.reason } } : r);
    g.journeys.add(r.journey);
    if (RANK[severity] < RANK[g.severity]) Object.assign(g, { severity, why });
    if (num(r.cost) && (g.cost === null || r.cost > g.cost)) g.cost = r.cost;
    g.witnesses = Math.max(g.witnesses, r.witnesses.length);
    for (const o of owner) if (!g.owner.includes(o)) g.owner.push(o);
    groups.set(key, g);
  });
  for (const [key, why] of held) if (!groups.has(key)) lines.push(`held: ${key} (${why})`);

  // The state's rows of each group, and the owner's acceptances.
  let changed = false;
  const prior = (g) => [...g.journeys].map((j) => state.journeys[j]?.rows?.[g.key]).filter(Boolean);
  const put = (g, st, issue) => {
    for (const j of g.journeys) {
      const entry = (state.journeys[j] ??= { judged: runId, best: null, rows: {} });
      const was = entry.rows[g.key];
      entry.rows[g.key] = { rule: g.rule.id, screen: g.screen, class: g.rule.class, severity: g.severity, state: st, issue: issue === undefined ? (was?.issue ?? null) : issue, first: was?.first ?? runId, last: runId };
    }
    changed = true;
  };
  const save = () => changed && (writeTasteState(main, state), (changed = false));
  const count = { filed: 0, polish: 0, queued: 0, open: 0, closed: 0, accepted: 0, held: [...held.keys()].filter((k) => !groups.has(k)).length };
  const todo = [];
  for (const g of groups.values()) {
    g.prior = prior(g);
    if (accepted.has(g.key) || g.prior.some((p) => p.state === "accepted")) {
      put(g, "accepted");
      lines.push(`accepted: ${g.key}`);
      count.accepted += 1;
    } else todo.push(g);
  }
  const summary = () => `taste file: filed ${count.filed}, polish ${count.polish} item(s), queued ${count.queued}, open ${count.open}, closed ${count.closed}, accepted ${count.accepted}, held ${count.held}`;
  if (!todo.length) {
    save();
    return { code: 0, lines: [...lines, "taste file: nothing to file"] };
  }

  // Before gh: the run scrub would refuse, and a contract that files nothing.
  const which = scrubRun(main, { run: runId });
  if (which.refusal) return { code: 1, lines: [...lines, which.refusal] };
  const loaded = loadContract(main);
  if (loaded.error && !loaded.missing) return { code: 1, lines: [...lines, `refused: taste file: the committed sapu contract cannot be read (${loaded.error.split("\n")[0]}): nothing is filed`] };
  if (resolvePolicy(loaded.contract ?? null).fileIssues === false) return { code: 1, lines: [...lines, "refused: taste file: the contract's policy.fileIssues is false: nothing is filed"] };
  const secrets = scrubSecrets(main, { runId, env });
  if (secrets.refusal) return { code: 1, lines: [...lines, secrets.refusal] };

  // Every issue, in every state, never `--search` (its sub-limit silently misses matches).
  const listed = runner([gh, "issue", "list", "--state", "all", "--limit", String(ISSUE_LIMIT), "--json", "number,title,url,state,stateReason"], { cwd: main, env });
  let issues = null;
  try {
    issues = listed.status === 0 ? JSON.parse(String(listed.stdout ?? "")) : null;
  } catch {
    issues = null;
  }
  if (!Array.isArray(issues)) return { code: 2, lines: [...lines, `failed: taste file: gh's issue listing exited ${listed.status ?? "on a signal"} without a list; nothing is filed (the dedupe compares every issue's title)`] };
  const shaped = (i) => isObj(i) && typeof i.title === "string" && typeof i.url === "string" && ["OPEN", "CLOSED"].includes(i.state);
  issues = issues.filter(shaped);
  // An issue the state names that the list does not hold (older than its limit): viewed by its URL, never filed twice.
  const listedUrls = new Set(issues.map((i) => i.url));
  for (const url of new Set(todo.flatMap((g) => g.prior.map((p) => p.issue)).filter((u) => u && !listedUrls.has(u)))) {
    const v = runner([gh, "issue", "view", url, "--json", "number,title,url,state,stateReason"], { cwd: main, env });
    try {
      const i = v.status === 0 ? JSON.parse(String(v.stdout ?? "")) : null;
      if (shaped(i) && i.url === url) issues.push(i);
    } catch {
      // gone, or not an issue: the title decides
    }
  }
  const seen = readSeen(main, runId);
  const thisRun = new Set();
  try {
    for (const l of fs.readFileSync(filedFile(main, runId), "utf8").split("\n")) if (l.trim()) thisRun.add(JSON.parse(l).url);
  } catch {
    // none filed yet
  }
  let budget = capN - issues.filter((i) => thisRun.has(i.url) && i.title.startsWith("taste:")).length;
  const rolledUp = issues.some((i) => i.title.startsWith(`[polish] cycle ${runId} `));

  const single = [];
  const polish = [];
  for (const g of todo) {
    const i = issueFor(g, issues, seen);
    if (i && i.state === "OPEN") {
      put(g, "open", i.url);
      lines.push(`open: ${g.key} ${i.url}`);
      count.open += 1;
    } else if (i && (i.stateReason === "NOT_PLANNED" || i.stateReason === "DUPLICATE")) {
      put(g, "closed", i.url);
      lines.push(`closed: ${g.key} ${i.url} (closed as ${i.stateReason === "DUPLICATE" ? "a duplicate" : "not planned"}: the owner's ruling; stage taste accept ${g.rule.id} ${g.screen} only on their word)`);
      count.closed += 1;
    } else {
      g.earlier = i ? i.url : null;
      (g.severity === "S4" && !g.owner.length ? polish : single).push(g);
    }
  }
  const needsOwner = needsOwnerLabel(loaded.contract ?? null);
  const queue = (g, why) => {
    put(g, "queued");
    lines.push(`queued: ${g.key} (${g.severity}, ${why})`);
    count.queued += 1;
  };
  /** The run's shot of screen key `screen` (shotName), when the recorder took one: scrub's verdict decides whether it leaves. */
  const shotOf = (screen) => {
    const png = path.join(liveDir(main), runId, "taste", "shots", `${shotName(screen)}.png`);
    return fs.lstatSync(png, { throwIfNoEntry: false })?.isFile() ? [png] : [];
  };
  /** Files one issue through scrub (`attach` its screen's shot) → its URL, or null after pushing scrub's lines (the filing stops). */
  const fileThrough = async (name, title, body, labels, attach = []) => {
    const dir = path.join(liveDir(main), runId, "taste", "filing");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const bodyFile = path.join(dir, `${name}.md`);
    fs.renameSync(tempBeside(bodyFile, body, 0o600), bodyFile);
    const r = await scrub(main, { run: runId, title, bodyFile, attach, create: true, labels }, { env, gh, runner });
    const url = r.code === 0 ? (r.out.find((l) => l.startsWith("filed: ")) ?? "").slice(7) : "";
    if (url) return url;
    lines.push(...r.out.filter((l) => !l.startsWith("title: ")));
    return null;
  };

  let stop = 0;
  for (const g of single.sort(byRank)) {
    if (stop || budget <= 0) {
      queue(g, stop ? "not filed: the filing stopped" : `over the cap of ${capN}`);
      continue;
    }
    const cls = classify({ oracle: "taste", tasteClass: g.rule.class, cost: num(g.cost) && g.cost >= costS });
    const labels = [...cls.labels, `severity:${g.severity.toLowerCase()}`, ...(g.owner.length ? [needsOwner] : [])];
    const url = await fileThrough(g.rows[0].row, titleOf(g), bodyOf(g, { runId, judge, bar, earlier: g.earlier }), labels, shotOf(g.rows[0].screen));
    if (!url) {
      stop = 1;
      queue(g, "not filed: scrub refused it");
      continue;
    }
    put(g, "open", url);
    save();
    lines.push(`filed: ${url} ${g.key} (${g.severity}${g.owner.length ? ", needs-owner" : ""})`);
    count.filed += 1;
    budget -= 1;
  }
  const items = polish.sort(byRank);
  const take = stop || rolledUp ? [] : items.slice(0, POLISH_MAX);
  for (const g of items.filter((x) => !take.includes(x))) queue(g, stop ? "not filed: the filing stopped" : rolledUp ? "this run's roll-up is filed" : `over the roll-up's ${POLISH_MAX}`);
  if (take.length) {
    const url = await fileThrough("polish", `[polish] cycle ${runId} — ${take.length} coherence items`, polishBody(take, { runId, judge }), ["ux", "argus", "found-by:user", "severity:s4", "priority:p3"]);
    if (url) {
      for (const g of take) put(g, "open", url);
      lines.push(`polish: ${url} ${take.length} item(s)`);
      count.polish = take.length;
    } else {
      stop = 1;
      for (const g of take) queue(g, "not filed: scrub refused the roll-up");
    }
  }
  save();
  lines.push(summary());
  const failed = lines.some((l) => l.startsWith("failed: "));
  return { code: stop ? (failed ? 2 : 1) : 0, lines };
}

/**
 * `taste accept <rule> <key>` → `{code, lines}` (decision 19): the owner's ruling that `rule` on screen `key` is
 * intended, staged only on their word (the guard refuses it to every subagent): `{rule, key, why}` added to
 * `.argus/taste.json` (validated whole before it is written; the owner commits it), and every row of
 * `.argus/taste-state.json` under that title key marked `accepted`. Refused: a rule the bar lacks or that is
 * information only, a key that is no screen key, a taste.json that cannot be read or does not validate.
 */
export async function tasteAccept(main, rule, key) {
  const refuse = (why) => {
    throw new Error(`refused: taste accept: ${why}`);
  };
  const bar = loadBar();
  const r = bar.rules.find((x) => x.id === rule);
  if (!r) refuse(`${typeof rule === "string" && RULE_ID.test(rule) ? rule : "that"} is not a rule of the bar`);
  if (r.info) refuse(`${rule} is information only: it never files`);
  if (typeof key !== "string" || !SCREEN_KEY.test(key)) refuse("the key is a screen key, <route template>|<viewport width>|<light|dark>");
  const file = path.join(main, TASTE_FILE);
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if (!(e && e.code === "ENOENT")) refuse(`${TASTE_FILE} ${e instanceof SyntaxError ? "is not valid JSON" : "cannot be read"}`);
  }
  const before = validateTaste(raw, bar);
  if (!before.value) refuse(`${TASTE_FILE}: ${before.errors.join("; ")}`);
  const tk = titleKey(rule, key);
  const state = readTasteState(main);
  const rows = Object.values(state.journeys).flatMap((j) => (j.rows[tk] ? [j.rows[tk]] : []));
  const already = before.value.accept.some((a) => a.rule === rule && a.key === key);
  if (!already) {
    const url = rows.map((x) => x.issue).find(Boolean);
    const next = { ...raw, accept: [...(Array.isArray(raw.accept) ? raw.accept : []), { rule, key, why: `the owner's ruling (taste accept)${url ? `, on ${url}` : ""}` }] };
    const after = validateTaste(next, bar);
    if (!after.value) refuse(`${TASTE_FILE}: ${after.errors.join("; ")}`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.renameSync(tempBeside(file, `${JSON.stringify(next, null, 2)}\n`, 0o644), file);
  }
  const marked = rows.filter((x) => x.state !== "accepted");
  for (const x of marked) x.state = "accepted";
  if (marked.length) writeTasteState(main, state);
  const said = already ? `is already in ${TASTE_FILE}` : `added to ${TASTE_FILE} (commit it)`;
  return { code: 0, lines: [`taste accept: ${tk} ${said}; ${marked.length} row(s) of ${TASTE_STATE_FILE} accepted`] };
}
