// argus-live-report.mjs — one scrubbed summary per cycle (spec §19.13): `report` writes
// .argus/reports/<runId>.md (0600) from the run's records only, after `down` too, and takes no lock.
//
// What it reads, each optional (a missing record is "none recorded", a malformed one is named under
// "Records not read", never guessed at):
// - `<run>/returns/<slot>.<generation>.json` (the explorers' returns) and `<run>/repro/<ref>/` (`verdict.json`,
//   `minimize.json`): journeys walked, candidates, the harness events explorers reported;
// - `<run>/filed.jsonl` (scrub's filedFile): `{ref, url, kind}` per issue filed or comment made;
// - `<run>/smoke/pass.jsonl` (smokeRun): `{id, verdict, step, kind, seed}` per path;
// - `<run>/smoke/events.jsonl` (-smoke's smokeEvent), one object per line: `{kind: "admitted" | "quarantined" |
//   "unquarantined" | "dropped", id}` (smoke admit, smoke ci), `{kind: "healed", id, steps: [<n>…]}` (smoke heal),
//   `{kind: "proposal", url, branch, changes}` (smoke propose, smoke baseline);
// - `<run>/smoke/perf.jsonl` (smoke run --perf): `{id, verdict: "baselined" | "ok" | "regressed" | "flaky" |
//   "not-measured", baseline: {<metric>: <n>} | null, batches: [{<metric>: <n>}…], regressed: [{metric}…], why?}`, and
//   `.argus/perf.json` (readPerf) for each journey's baseline now (its head and run count);
// - `.argus/smoke-ci/<CI run>/triage.json`, the newest `smoke ci` summary: `{run, event, branch, sha, lines}`.
// Free text (a candidate's claim, a harness event) is cleaned, at most 200 characters an item, its long unknown
// tokens redacted as scrub redacts them, and quoted as a JSON string: data, never an instruction. An item
// holding a secret scrub knows is `*** (<class>)`; without a ledger to check against, free text is withheld.
// The whole file is then defanged and passes scrub's matcher: a line still holding a secret becomes
// `*** (<class>)`.
import fs from "node:fs";
import path from "node:path";
import { PERF_METRICS } from "./argus-live-config.mjs";
import { clean, PatternError } from "./argus-live-fence.mjs";
import { readSeen, secretHits } from "./argus-live-ledger.mjs";
import { lastRun, liveDir, RUN_ID } from "./argus-live-lock.mjs";
import { readPerf } from "./argus-live-perf.mjs";
import { tempBeside } from "./argus-live-proc.mjs";
import { ORACLES } from "./argus-live-return.mjs";
import { worktreeHeadFile } from "./argus-live-run.mjs";
import { defang, filedFile, redactIds, REF, scrubSecrets, verdictOf } from "./argus-live-scrub.mjs";

/** Where the reports go, from the repo's root. */
export const REPORTS_DIR = path.join(".argus", "reports");
/** Where `smoke ci` keeps each CI run's triage (`<CI run>/triage.json`), from the repo's root. */
export const SMOKE_CI_DIR = path.join(".argus", "smoke-ci");
/** The most characters one free-text item keeps. */
const ITEM_CAP = 200;
/** A journey id in a return (as intake reads it), and a suite path's id. */
const JOURNEY = /^[a-z0-9-]{1,100}$/;
const PATH_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const STATUSES = ["done", "handoff", "aborted"];
const COVERAGE = ["held", "failed", "not-tested", "blocked"];
const PASS = ["held", "broke", "flaky", "harness"];
const BREAK_KIND = /^[a-z][a-z-]{0,30}$/;
const FILED_KINDS = ["issue", "comment"];
const URL_SHAPE = /^https?:\/\/[^\s<>"'`]{1,300}$/;
const BRANCH = /^argus\/[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/;
const PERF_VERDICTS = ["baselined", "ok", "regressed", "flaky", "not-measured"];
const ID_EVENTS = ["admitted", "quarantined", "unquarantined", "dropped"];
/** The first words of a `smoke ci` triage line (spec §19.9); any other line is never shown. */
const TRIAGE = ["smoke", "flaky", "flaky-new", "quarantine", "quarantined", "unquarantine", "drop", "ui-change?", "bug?", "ci-only", "browser-only", "failed", "check", "manual", "info", "baseline-missing", "visual", "aria", "stale", "harness", "skipped:"];
/** A triage line: printable words, no backtick, one space between them. */
const TRIAGE_LINE = /^[\x21-\x5f\x61-\x7e]+(?: [\x21-\x5f\x61-\x7e]+){0,15}$/;
/** web.dev's "good" values (field targets at the 75th percentile): shown beside the medians as lab context only. */
const GOOD = [["lcp_ms", 2500], ["inp_ms", 200], ["cls", 0.1]];

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const posInt = (v) => Number.isSafeInteger(v) && v > 0;

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

/** A JSONL file's non-empty lines → `[{n, v}]` (`v` null for a line that is not JSON); [] when it is missing. */
function readLines(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .map((l, i) => ({ n: i + 1, l }))
    .filter((x) => x.l.trim() !== "")
    .map(({ n, l }) => {
      try {
        return { n, v: JSON.parse(l) };
      } catch {
        return { n, v: null };
      }
    });
}

/** `s` cut to ITEM_CAP characters, `…` last (a surrogate pair never split). */
const capped = (s) => {
  const chars = [...s];
  return chars.length <= ITEM_CAP ? s : `${chars.slice(0, ITEM_CAP - 1).join("")}…`;
};

/** The newest `smoke ci` triage (by its file's time, then its CI run id) → `{rel, file}`, or null when there is none. */
function newestTriage(main) {
  let names = [];
  try {
    names = fs.readdirSync(path.join(main, SMOKE_CI_DIR)).filter((n) => /^[0-9]{1,20}$/.test(n));
  } catch {
    names = [];
  }
  const at = names.flatMap((n) => {
    const file = path.join(main, SMOKE_CI_DIR, n, "triage.json");
    try {
      return [{ rel: path.join(SMOKE_CI_DIR, n, "triage.json"), file, t: fs.statSync(file).mtimeMs, n: BigInt(n) }];
    } catch {
      return [];
    }
  });
  return at.sort((a, b) => b.t - a.t || (b.n > a.n ? 1 : b.n < a.n ? -1 : 0))[0] ?? null;
}

/** A metrics object of a perf record: only PERF_METRICS keys, each a finite number. */
const metricsOk = (m) => isObj(m) && Object.entries(m).every(([k, v]) => PERF_METRICS.includes(k) && typeof v === "number" && Number.isFinite(v));

/** The returns of run `dir`, by slot then generation → `[{slot, g, file}]`. */
function returnFiles(dir) {
  let names = [];
  try {
    names = fs.readdirSync(path.join(dir, "returns"));
  } catch {
    names = [];
  }
  return names
    .map((f) => /^([1-9][0-9]?)\.([1-9])\.json$/.exec(f))
    .filter(Boolean)
    .map((m) => ({ slot: Number(m[1]), g: Number(m[2]), file: m[0] }))
    .sort((a, b) => a.slot - b.slot || a.g - b.g);
}

/** Every section's lines of run `runId` → `[[title, lines]]`; `quote(text)` renders one free-text item. */
function sections(main, runId, quote) {
  const dir = path.join(liveDir(main), runId);
  const unread = [];
  const walked = [];
  const candidates = [];
  const harness = [];
  const filed = [];
  const byRef = new Map();
  for (const { n, v } of readLines(filedFile(main, runId))) {
    if (!isObj(v) || !FILED_KINDS.includes(v.kind) || typeof v.url !== "string" || !URL_SHAPE.test(v.url) || !(v.ref === null || (typeof v.ref === "string" && REF.test(v.ref)))) {
      unread.push(`filed.jsonl line ${n}`);
      continue;
    }
    filed.push(`- ${v.kind} ${v.url} (${v.ref === null ? "run" : `candidate ${v.ref}`})`);
    if (v.ref !== null) byRef.set(v.ref, [...(byRef.get(v.ref) ?? []), v.url]);
  }
  for (const { slot, g, file } of returnFiles(dir)) {
    const r = readJson(path.join(dir, "returns", file));
    if (!isObj(r)) {
      unread.push(`returns/${file}`);
      continue;
    }
    if (Array.isArray(r.journeys)) {
      walked.push(`- slot ${slot} generation ${g} map journeys ${r.journeys.length}`);
      continue;
    }
    const coverage = Object.entries(isObj(r.coverage) ? r.coverage : {})
      .filter(([k, x]) => ORACLES.includes(k) && COVERAGE.includes(x))
      .map(([k, x]) => `${k}=${x}`)
      .join(",");
    const journey = typeof r.journey === "string" && JOURNEY.test(r.journey) ? r.journey : "-";
    walked.push(`- slot ${slot} generation ${g} journey ${journey} status ${STATUSES.includes(r.status) ? r.status : "-"} steps ${Array.isArray(r.steps) ? r.steps.length : 0} coverage ${coverage || "none"}`);
    for (const e of Array.isArray(r.harness_events) ? r.harness_events : []) harness.push(`- slot ${slot} generation ${g}: ${quote(e)}`);
    (Array.isArray(r.candidates) ? r.candidates : []).forEach((c, i) => {
      const ref = `${slot}.${g}.${i + 1}`;
      if (!isObj(c) || !REF.test(ref)) {
        unread.push(`returns/${file} candidate ${i + 1}`);
        return;
      }
      const verdict = verdictOf(main, runId, ref);
      const m = readJson(path.join(dir, "repro", ref, "minimize.json"));
      const min = isObj(m) && m.confirmed === true && Number.isSafeInteger(m.from) && Number.isSafeInteger(m.to) ? `minimized ${m.from} → ${m.to}` : isObj(m) ? "minimize not confirmed" : "not minimized";
      const urls = byRef.get(ref) ?? [];
      candidates.push(`- ${ref} oracle ${ORACLES.includes(c.oracle) ? c.oracle : "-"}, verdict ${verdict}, ${min}, ${urls.length ? `filed ${urls.join(", ")}` : "not filed"}, claim: ${quote(c.claim ?? "")}`);
      if (verdict === "harness") harness.push(`- candidate ${ref}: harness`);
    });
  }

  // The smoke pass and the smoke verbs' events.
  const counts = { held: 0, broke: 0, flaky: 0, harness: 0, healed: 0, admitted: 0, quarantined: 0 };
  const paths = [];
  for (const { n, v } of readLines(path.join(dir, "smoke", "pass.jsonl"))) {
    const ok = isObj(v) && typeof v.id === "string" && PATH_ID.test(v.id) && PASS.includes(v.verdict) && (v.step === null || v.step === undefined || posInt(v.step)) && (v.kind === null || v.kind === undefined || (typeof v.kind === "string" && BREAK_KIND.test(v.kind)));
    if (!ok) {
      unread.push(`smoke/pass.jsonl line ${n}`);
      continue;
    }
    counts[v.verdict] += 1;
    const where = (v.verdict === "broke" || v.verdict === "flaky") && posInt(v.step) ? ` step=${v.step}${v.kind ? ` kind=${v.kind}` : ""}` : "";
    paths.push(`- path ${v.id}: ${v.verdict}${where}`);
    if (v.verdict === "harness") harness.push(`- path ${v.id}: harness`);
  }
  const events = [];
  const perf = [];
  const proposals = [];
  for (const { n, v } of readLines(path.join(dir, "smoke", "events.jsonl"))) {
    const id = isObj(v) && typeof v.id === "string" && PATH_ID.test(v.id) ? v.id : null;
    if (isObj(v) && ID_EVENTS.includes(v.kind) && id) {
      events.push(`- ${v.kind} ${id}`);
      if (Object.hasOwn(counts, v.kind)) counts[v.kind] += 1;
    } else if (isObj(v) && v.kind === "healed" && id && Array.isArray(v.steps) && v.steps.length && v.steps.every(posInt)) {
      events.push(`- healed ${id} (steps ${v.steps.join(", ")})`);
      counts.healed += 1;
    } else if (isObj(v) && v.kind === "proposal" && typeof v.url === "string" && URL_SHAPE.test(v.url) && typeof v.branch === "string" && BRANCH.test(v.branch) && Number.isSafeInteger(v.changes) && v.changes >= 0) {
      proposals.push(`- ${v.url} ${v.branch}, ${v.changes} change(s)`);
    } else unread.push(`smoke/events.jsonl line ${n}`);
  }
  // smoke run --perf's rows: each batch beside the baseline it was judged against; .argus/perf.json's baseline now.
  const perfIds = new Set();
  for (const { n, v } of readLines(path.join(dir, "smoke", "perf.jsonl"))) {
    const id = isObj(v) && typeof v.id === "string" && PATH_ID.test(v.id) ? v.id : null;
    const regressed = isObj(v) && Array.isArray(v.regressed) && v.regressed.every((r) => isObj(r) && PERF_METRICS.includes(r.metric)) ? v.regressed.map((r) => r.metric) : null;
    if (!id || !PERF_VERDICTS.includes(v.verdict) || !(v.baseline === null || metricsOk(v.baseline)) || !Array.isArray(v.batches) || v.batches.length > 10 || !v.batches.every(metricsOk) || !regressed) {
      unread.push(`smoke/perf.jsonl line ${n}`);
      continue;
    }
    perfIds.add(id);
    const used = PERF_METRICS.filter((k) => [v.baseline ?? {}, ...v.batches].some((b) => Object.hasOwn(b, k)));
    const show = (b, k) => (b && Object.hasOwn(b, k) ? String(b[k]) : "-");
    const metrics = used.map((k) => `${k} ${show(v.baseline, k)} → ${v.batches.map((b) => show(b, k)).join(", ") || "-"}`).join("; ");
    const why = v.verdict === "not-measured" && typeof v.why === "string" ? `, ${quote(v.why)}` : "";
    perf.push(`- ${id} ${v.verdict}${regressed.length ? ` (${regressed.join(", ")})` : ""}: ${metrics || "no metric"}${why}`);
  }
  let stored = {};
  try {
    stored = perfIds.size ? readPerf(main) : {};
  } catch {
    unread.push(".argus/perf.json");
  }
  for (const id of [...perfIds].sort()) if (isObj(stored[id])) perf.push(`- baseline ${id}: worktree ${stored[id].head.slice(0, 12)}, ${stored[id].n} run(s) a batch`);
  const smoke = paths.length || events.length ? [`- held ${counts.held}, broke ${counts.broke}, flaky ${counts.flaky}, harness ${counts.harness}; healed ${counts.healed}, admitted ${counts.admitted}, quarantined ${counts.quarantined}`, ...paths, ...events] : [];
  if (perf.length) perf.push(`- lab context, never a verdict (web.dev's "good" field values, at the 75th percentile of page loads): ${GOOD.map(([k, x]) => `${k} ${x}`).join(", ")}`);

  // The newest `smoke ci` summary: CI artifacts are untrusted, so only its triage lines are shown.
  const checks = [];
  const triage = newestTriage(main);
  if (triage) {
    const ci = readJson(triage.file);
    if (!isObj(ci) || !posInt(ci.run) || typeof ci.event !== "string" || !/^[a-z_]{1,40}$/.test(ci.event) || typeof ci.branch !== "string" || !/^[A-Za-z0-9._/-]{1,100}$/.test(ci.branch) || !Array.isArray(ci.lines)) unread.push(triage.rel);
    else {
      checks.push(`- CI run ${ci.run} (${ci.event}, ${ci.branch})`);
      let hidden = 0;
      for (const l of ci.lines) {
        if (typeof l === "string" && l.length <= ITEM_CAP && TRIAGE_LINE.test(l) && TRIAGE.includes(l.split(" ")[0])) checks.push(`- ${l}`);
        else hidden += 1;
      }
      if (hidden) checks.push(`- ${hidden} line(s) not shown: not a triage line`);
    }
  }

  const none = (lines) => (lines.length ? lines : ["- none recorded"]);
  const out = [
    ["Journeys walked", none(walked)],
    ["Candidates", none(candidates)],
    ["Issues filed", none(filed)],
    ["Smoke", none(smoke)],
    ["Perf", none(perf)],
    ["Visual and checks", none(checks)],
    ["Proposals", none(proposals)],
    ["Harness events", none(harness)],
  ];
  if (unread.length) out.push(["Records not read", unread.map((u) => `- ${u}`)]);
  return out;
}

/**
 * `md` with every line that scrub's matcher still finds a secret in replaced by `*** (<class>…)` (its list
 * marker kept), until none is left → the text; refused when replacing does not clear it.
 */
function matcherClean(md, secrets) {
  let text = md;
  for (let round = 0; round < 10; round++) {
    const hits = secretHits(text, secrets);
    if (!hits.length) return text;
    const byLine = new Map();
    for (const h of hits) byLine.set(h.line, [...new Set([...(byLine.get(h.line) ?? []), h.cls])]);
    text = text
      .split("\n")
      .map((l, i) => (byLine.has(i + 1) ? `${/^\s*[-*] /.exec(l)?.[0] ?? ""}*** (${byLine.get(i + 1).join(", ")})` : l))
      .join("\n");
  }
  throw new Error("refused: report: a secret stayed in the report after scrubbing; no report is written");
}

/**
 * `report [--run <runId>]` → `{code, lines}`: run `run` (null: the lock's, else the newest run directory,
 * lastRun), its report written to `.argus/reports/<runId>.md` (0600, the directory 0700; rewritten whole each
 * time) → `report: <path>`. Refused: a `run` that is no run id, no run here, a run with no directory here, a
 * secret's pattern that could not be run. The secrets are scrub's (scrubSecrets, `env` its environment); when
 * scrub would refuse the run (a ledger gone, damaged or incomplete; a configuration that cannot be read),
 * every free-text item is withheld and the report says why.
 */
export function report(main, { run }, { env = process.env } = {}) {
  if (run !== null && run !== undefined && !RUN_ID.test(String(run))) throw new Error("refused: report: --run takes a run id");
  const runId = run ?? lastRun(main);
  if (runId === null) throw new Error("refused: report: no run here");
  if (!fs.existsSync(path.join(liveDir(main), runId))) throw new Error(`refused: report: no run ${runId} here`);
  const { secrets, refusal } = scrubSecrets(main, { runId, env });
  // worktree.json, which `down` keeps: the commit the run's worktree was built at, and the run's mode.
  const rec = readJson(worktreeHeadFile(main, runId));
  const head = isObj(rec) && typeof rec.worktreeHead === "string" && /^[0-9a-f]{40,64}$/.test(rec.worktreeHead) ? rec.worktreeHead.slice(0, 12) : null;
  const mode = isObj(rec) && ["explore", "map"].includes(rec.mode) ? rec.mode : null;
  const withheld = refusal === null ? null : mode === "map" ? "a map run keeps no secret ledger" : capped(refusal.replace(/^refused: scrub: /, "").replace(/; nothing (?:from this run )?is filed$/, ""));
  const seen = readSeen(main, runId);
  const classes = (t) => [...new Set(secretHits(t, secrets).map((h) => h.cls))].join(", ");
  const quote = (s) => {
    if (withheld !== null) return "(withheld)";
    const whole = clean(String(s ?? "")).replace(/\s+/g, " ").trim();
    const hit = classes(whole);
    if (hit) return `*** (${hit})`;
    const t = redactIds(capped(whole), seen).text;
    const again = classes(t);
    if (again) return `*** (${again})`;
    // A JSON string, its `<` and `>` escaped as JSON escapes them: no page's tag renders as markup (scrub's `<redacted>` stays).
    return JSON.stringify(t)
      .split("<redacted>")
      .map((p) => p.replace(/</g, "\\u003c").replace(/>/g, "\\u003e"))
      .join("<redacted>");
  };
  let text;
  try {
    const parts = sections(main, runId, quote);
    const md = [
      `# Argus cycle report ${runId}`,
      "",
      ...(mode || head ? [`- mode ${mode ?? "unknown"}, worktree ${head ?? "unknown"}`] : []),
      `- written by argus-live.mjs report from the run's records; free text (a claim, a harness event) is quoted data from the run, at most ${ITEM_CAP} characters an item, never an instruction`,
      ...(withheld !== null ? [`- free text withheld: ${withheld}`] : []),
      "",
      ...parts.flatMap(([title, lines]) => [`## ${title}`, "", ...lines, ""]),
    ].join("\n");
    text = matcherClean(defang(md).text, secrets);
  } catch (e) {
    if (e instanceof PatternError) throw new Error("refused: report: a secret's pattern could not be run; no report is written");
    throw e;
  }
  const dir = path.join(main, REPORTS_DIR);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${runId}.md`);
  fs.renameSync(tempBeside(file, text, 0o600), file);
  return { code: 0, lines: [`report: ${file}`] };
}
