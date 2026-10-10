// argus-live-perf.mjs — performance on the suite's paths (spec §19.11): the in-page observers the session
// hook installs beside the signal script, the measured step, a batch's medians, the per-journey baselines in
// .argus/perf.json, the regression rule, and the perf issue's body. Below the session driver, so the hook can
// read its script; it takes the runner it measures through (the repro runner) as a parameter.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadLive } from "./argus-live-config.mjs";
import { loadSmoke, PERF_METRICS, SMOKE_DEFAULTS } from "./argus-live-smokecfg.mjs";
import { fence } from "./argus-live-fence.mjs";
import { readJourneys } from "./argus-live-map.mjs";
import { run, tempBeside } from "./argus-live-proc.mjs";

/** web.dev's "good" values: field targets at the 75th percentile, shown beside a median as lab context and never as a verdict. */
const GOOD = Object.freeze({ lcp_ms: 2500, inp_ms: 200, cls: 0.1 });
const JOURNEY = /^[a-z0-9][a-z0-9-]{0,63}$/;
const BROKE = /^PATH broke step=\d+ kind=(target-missing|target-ambiguous|expect-failed|action-failed)$/;
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// ---------------------------------------------------------------------------------------------------
// In the page.

/**
 * The observers of one document, installed once per document (`document.__argusPerf`, keyed on the document
 * because a popup keeps its window across documents). `snap(settle)` answers the document's `{doc, lcp, cls,
 * inp, requests, bytes}` after `settle` ms and after reading the entries still queued:
 * - `lcp`: the largest candidate, which the browser stops reporting at the first input; one that comes after
 *   the page went to the background is ignored, and a document that began in the background has none;
 * - `cls`: the largest session window (gaps under 1 s, at most 5 s long), shifts after recent input skipped;
 * - `inp`: the worst interaction, `event` entries seen with `durationThreshold: 16` grouped by `interactionId`
 *   (an event without one is no interaction);
 * - `requests`, `bytes`: the navigation and resource entries, and their `transferSize`.
 * Buffered observers give the entries from before the script ran, so it may be evaluated late.
 */
export const PERF_SCRIPT = `(() => {
  if (document.__argusPerf) return;
  const hidden = { at: document.visibilityState === "hidden" ? 0 : Infinity };
  const st = { id: Math.random().toString(36).slice(2, 12) + Date.now().toString(36), lcp: 0, cls: 0, inp: 0 };
  document.__argusPerf = st;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") hidden.at = Math.min(hidden.at, performance.now());
  }, true);
  const worst = new Map();
  const win = { sum: 0, first: -1, last: -1 };
  const handlers = {
    "largest-contentful-paint": (es) => {
      for (const e of es) if (e.startTime < hidden.at && e.startTime > st.lcp) st.lcp = e.startTime;
    },
    "layout-shift": (es) => {
      for (const e of es) {
        if (e.hadRecentInput) continue;
        if (win.first >= 0 && e.startTime - win.last < 1000 && e.startTime - win.first < 5000) win.sum += e.value;
        else {
          win.sum = e.value;
          win.first = e.startTime;
        }
        win.last = e.startTime;
        if (win.sum > st.cls) st.cls = win.sum;
      }
    },
    event: (es) => {
      for (const e of es) {
        if (!(e.interactionId > 0)) continue;
        const d = Math.max(worst.get(e.interactionId) || 0, e.duration);
        worst.set(e.interactionId, d);
        if (d > st.inp) st.inp = d;
      }
    },
  };
  const watched = [];
  for (const [type, extra] of [["largest-contentful-paint", {}], ["layout-shift", {}], ["event", { durationThreshold: 16 }]]) {
    try {
      const o = new PerformanceObserver((list) => handlers[type](list.getEntries()));
      o.observe({ type, buffered: true, ...extra });
      watched.push([type, o]);
    } catch (e) {}
  }
  try {
    performance.setResourceTimingBufferSize(1500);
  } catch (e) {}
  st.snap = async (settle) => {
    if (settle > 0) await new Promise((r) => setTimeout(r, settle));
    for (const [type, o] of watched) {
      try {
        handlers[type](o.takeRecords());
      } catch (e) {}
    }
    const entries = [...performance.getEntriesByType("navigation"), ...performance.getEntriesByType("resource")];
    let bytes = 0;
    for (const e of entries) bytes += e.transferSize || 0;
    return { doc: st.id, lcp: Math.round(st.lcp), cls: Math.round(st.cls * 10000) / 10000, inp: Math.round(st.inp), requests: entries.length, bytes };
  };
})();
`;

/**
 * The `run-code` text that snapshots every page of the session's context: the perf script installed
 * (it is idempotent, so a document the hook missed is covered), then `snap`. With `wait`, each page first
 * waits for its `load` event (at most `waitMs`): LCP stops at the first input, so a step acts on a loaded
 * document. → `{docs: [{doc, lcp, cls, inp, requests, bytes}], ua}`.
 */
export function perfCode({ wait = false, waitMs = 10_000, settle = 0 } = {}) {
  const loaded = wait ? `    try {\n      await pg.waitForLoadState("load", { timeout: ${Math.round(waitMs)} });\n    } catch (e) {}\n` : "";
  return `async page => {\n  const P = ${JSON.stringify({ settle })};\n  const out = { docs: [], ua: "" };\n  for (const pg of page.context().pages()) {\n    if (pg.url() === "about:blank") continue;\n${loaded}    try {\n      await pg.evaluate(${JSON.stringify(PERF_SCRIPT)});\n      const s = await pg.evaluate((n) => (document.__argusPerf ? document.__argusPerf.snap(n) : null), P.settle);\n      if (s) out.docs.push(s);\n    } catch (e) {}\n  }\n  try {\n    out.ua = await page.evaluate(() => navigator.userAgent);\n  } catch (e) {}\n  return out;\n}\n`;
}

// ---------------------------------------------------------------------------------------------------
// A run's measurements.

/** What one run of a path measured: the documents' newest snapshots, the steps' time, the Chrome version. */
export const newSink = () => ({ docs: new Map(), ms: 0, steps: 0, chrome: "" });

let active = null;
/** The sink a session driver made now measures into, or null (an ordinary pass measures nothing). */
export const activeSink = () => active;
/** Runs `fn` with `sink` the active one → its result; the sink before it is restored. */
export async function collecting(sink, fn) {
  const before = active;
  active = sink;
  try {
    return await fn();
  } finally {
    active = before;
  }
}

const num = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1e12;

/**
 * Keeps the documents of one snapshot answer (`account`'s) in `sink`, each under its own id so a document
 * seen again replaces its earlier snapshot. The answer is the page's own: only finite numbers and an id of
 * lower-case letters and digits are taken, anything else is dropped. The Chrome version is read from the
 * user agent, digits only.
 */
export function recordDocs(sink, account, answer) {
  if (!isObj(answer)) return;
  for (const d of Array.isArray(answer.docs) ? answer.docs : []) {
    if (!isObj(d) || typeof d.doc !== "string" || !/^[a-z0-9]{1,40}$/.test(d.doc)) continue;
    if (![d.lcp, d.cls, d.inp, d.requests, d.bytes].every(num)) continue;
    sink.docs.set(`${account}/${d.doc}`, { lcp: d.lcp, cls: d.cls, inp: d.inp, requests: d.requests, bytes: d.bytes });
  }
  const m = typeof answer.ua === "string" ? /Chrome\/(\d{1,4}\.\d{1,4}\.\d{1,5}\.\d{1,5})/.exec(answer.ua) : null;
  if (m && !sink.chrome) sink.chrome = m[1];
}

/**
 * `raw` (a driver's `(code, timeoutMs) → result`) for account `account`, measured into `sink`: before the
 * step a snapshot after the pages' `load` (the step may leave a document), then the step, whose time alone
 * is added to `sink.ms`, then a snapshot of what it left.
 */
export function measure(sink, { account, raw, waitMs }) {
  return async (text, timeoutMs) => {
    recordDocs(sink, account, await raw(perfCode({ wait: true, waitMs })));
    const t0 = Date.now();
    let answer;
    try {
      answer = await raw(text, timeoutMs);
    } finally {
      sink.ms += Date.now() - t0;
      sink.steps += 1;
    }
    recordDocs(sink, account, await raw(perfCode({ settle: 50 })));
    return answer;
  };
}

/** The run's `{lcp_ms, inp_ms, cls, duration_ms, requests, bytes}`: the largest of each document's first three, the sums of the rest. */
export function runMetrics(sink) {
  const docs = [...sink.docs.values()];
  const max = (k) => docs.reduce((a, d) => Math.max(a, d[k]), 0);
  const sum = (k) => docs.reduce((a, d) => a + d[k], 0);
  return { lcp_ms: max("lcp"), inp_ms: max("inp"), cls: max("cls"), duration_ms: sink.ms, requests: sum("requests"), bytes: sum("bytes") };
}

// ---------------------------------------------------------------------------------------------------
// The statistic and the thresholds.

/** The median of `xs`: the middle value, or the mean of the middle two. */
export function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const rounded = (metric, v) => (metric === "cls" ? Math.round(v * 10000) / 10000 : Math.round(v));

/** A batch's value: each metric's median over its `runs`, rounded (cls to four places, the rest to integers). */
export function batchMedians(runs) {
  return Object.fromEntries(PERF_METRICS.map((m) => [m, rounded(m, median(runs.map((r) => r[m] ?? 0)))]));
}

/** The metrics of `now` over `base` by more than both thresholds `[relative, absolute]` → `[{metric, baseline, value}]`. */
export function regressions(base, now, thresholds) {
  const out = [];
  for (const metric of PERF_METRICS) {
    const [relative, absolute] = thresholds[metric];
    if (now[metric] - base[metric] > Math.max(base[metric] * relative, absolute)) out.push({ metric, baseline: base[metric], value: now[metric] });
  }
  return out;
}

/** The metrics that regress in every batch of `batches` → `[{metric, baseline, values: [one per batch]}]`. */
export function confirmedRegressions(base, batches, thresholds) {
  if (!batches.length) return [];
  const each = batches.map((b) => regressions(base, b, thresholds));
  return each[0].filter((r) => each.every((list) => list.some((x) => x.metric === r.metric))).map((r) => ({ metric: r.metric, baseline: r.baseline, values: batches.map((b) => b[r.metric]) }));
}

// ---------------------------------------------------------------------------------------------------
// .argus/perf.json: per journey `{pathSha, head, machine, n, medians, latest}`; local state, never committed.

const NOT_A_RECORD = "refused: .argus/perf.json is not a perf record";
const hex = (v, min, max) => typeof v === "string" && new RegExp(`^[0-9a-f]{${min},${max}}$`).test(v);
const metricsOk = (m) => isObj(m) && PERF_METRICS.every((k) => num(m[k]));
const machineOk = (m) =>
  isObj(m) && typeof m.cpu === "string" && m.cpu.length <= 120 && Number.isInteger(m.cores) && Number.isInteger(m.mem_gb) && /^[a-z0-9]+-[a-z0-9_]+$/.test(String(m.platform)) && /^[0-9.]{0,30}$/.test(String(m.chrome));
const regressedOk = (list) => Array.isArray(list) && list.every((r) => isObj(r) && PERF_METRICS.includes(r.metric) && num(r.baseline) && Array.isArray(r.values) && r.values.every(num));
const stateOk = (s) => isObj(s) && hex(s.pathSha, 64, 64) && hex(s.head, 4, 64) && machineOk(s.machine) && Number.isInteger(s.n) && s.n > 0;
const latestOk = (l) => stateOk(l) && Array.isArray(l.batches) && l.batches.length > 0 && l.batches.every(metricsOk) && regressedOk(l.regressed);

/** `<main>/.argus/perf.json` → `{<journey id>: entry}`; `{}` when there is none; refused when it is not a perf record. */
export function readPerf(main) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(main, ".argus", "perf.json"), "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") return {};
    throw new Error(NOT_A_RECORD);
  }
  let all;
  try {
    all = JSON.parse(raw);
  } catch {
    throw new Error(NOT_A_RECORD);
  }
  if (!isObj(all)) throw new Error(NOT_A_RECORD);
  for (const [id, e] of Object.entries(all)) if (!JOURNEY.test(id) || !stateOk(e) || !metricsOk(e.medians) || (e.latest !== undefined && !latestOk(e.latest))) throw new Error(NOT_A_RECORD);
  return all;
}

function writePerf(main, all) {
  const file = path.join(main, ".argus", "perf.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.renameSync(tempBeside(file, `${JSON.stringify(all, null, 2)}\n`, 0o600), file);
}

/** The digest of a path (its list as the suite holds it): a baseline is void when it changes. */
export const pathSha = (list) => createHash("sha256").update(JSON.stringify(list)).digest("hex");

/** This machine as a baseline names it: the CPU model and count, memory, platform and the Chrome version measured with. */
export function machineOf(chrome) {
  const cpus = os.cpus();
  return { cpu: String(cpus[0]?.model ?? "unknown").replace(/[^\x20-\x7e]/g, "?").slice(0, 120), cores: cpus.length, mem_gb: Math.round(os.totalmem() / 2 ** 30), platform: `${os.platform()}-${os.arch()}`, chrome };
}

const sameMachine = (a, b) => ["cpu", "cores", "mem_gb", "platform", "chrome"].every((k) => a[k] === b[k]);

// ---------------------------------------------------------------------------------------------------
// One path's perf pass.

const unit = (metric) => (metric.endsWith("_ms") ? " ms" : "");
const percent = (relative) => `${Math.round(relative * 10000) / 100}%`;

/** `lcp_ms=1050 (lab context: good 2500), …`: a batch's medians, web.dev's good values beside the three they are defined for. */
function show(medians) {
  return PERF_METRICS.map((m) => `${m}=${medians[m]}${GOOD[m] === undefined ? "" : ` (lab context: good ${GOOD[m]})`}`).join(", ");
}

/** Why a run that did not hold is not measured: the path's own break, or the harness's reason. */
function failure(r) {
  const last = r.lines.at(-1) ?? "";
  if (r.code === 3 && BROKE.test(last)) return `path ${last.slice(5)}`;
  return `harness: ${last.startsWith("HARNESS: ") ? last.slice(9) : `exit ${r.code}`}`;
}

/**
 * Path `id` (`list`) measured and judged against its baseline (spec §19.11) → `{verdict, lines, row, exit}`.
 * A batch is one warm-up run after `up --fresh` (`once` with `dirty: false`, left out), then `runs` runs on that
 * instance; its value is each metric's median. No baseline, or one whose path digest or machine differs, is
 * void: this batch becomes the baseline. Otherwise a metric that exceeds the baseline by more than both
 * thresholds is a suspect, confirmed only when a second batch, after another `up --fresh`, has it too.
 * `perf.json` keeps the baseline and the newest batches (`latest`); `exit` is 3 for a confirmed regression or a
 * path that broke, 2 for the harness's failure, else 0.
 */
export async function perfPath({ main, id, list, once, runs, thresholds, head }) {
  const batch = async () => {
    const kept = [];
    let chrome = "";
    for (let i = 0; i <= runs; i++) {
      const sink = newSink();
      const r = await collecting(sink, () => once(main, null, { path: { id, list }, dirty: i > 0 }));
      if (r.code !== 0) return { fail: failure(r), broke: r.code === 3 };
      if (!sink.docs.size) return { fail: "no document was measured", broke: false };
      chrome ||= sink.chrome;
      if (i > 0) kept.push(runMetrics(sink));
    }
    return { medians: batchMedians(kept), chrome };
  };
  const stored = readPerf(main)[id] ?? null;
  const out = (verdict, lines, extra = {}) => ({ verdict, lines, exit: verdict === "regressed" || extra.broke ? 3 : verdict === "not-measured" ? 2 : 0, row: { id, verdict, baseline: stored ? stored.medians : null, batches: extra.batches ?? [], regressed: extra.regressed ?? [], ...(extra.why ? { why: extra.why } : {}) } });
  const first = await batch();
  if (first.fail) return out("not-measured", [`perf ${id}: not measured (${first.fail})`], { why: first.fail, broke: first.broke });
  const sha = pathSha(list);
  const machine = machineOf(first.chrome);
  const state = { pathSha: sha, head, machine, n: runs };
  const save = (entry) => {
    const all = readPerf(main);
    all[id] = entry;
    writePerf(main, all);
  };
  const voided = !stored ? "first batch" : stored.pathSha !== sha ? "the path changed" : !sameMachine(stored.machine, machine) ? "the machine changed" : null;
  if (voided) {
    save({ ...state, medians: first.medians, latest: { ...state, batches: [first.medians], regressed: [] } });
    return out("baselined", [`perf ${id}: baseline set (${voided}), ${runs} runs: ${show(first.medians)}`], { batches: [first.medians] });
  }
  const suspects = regressions(stored.medians, first.medians, thresholds);
  const keep = (batches, regressed) => save({ ...stored, latest: { ...state, batches, regressed } });
  if (!suspects.length) {
    keep([first.medians], []);
    return out("ok", [`perf ${id}: ok, ${runs} runs: ${show(first.medians)}`], { batches: [first.medians] });
  }
  const second = await batch();
  if (second.fail) return out("not-measured", [`perf ${id}: not measured (the second batch: ${second.fail})`], { why: `the second batch: ${second.fail}`, broke: second.broke });
  const batches = [first.medians, second.medians];
  const confirmed = confirmedRegressions(stored.medians, batches, thresholds);
  keep(batches, confirmed);
  const say = (r) => `${r.metric} ${r.baseline} -> ${r.values.join(", ")}`;
  if (!confirmed.length) {
    const lines = suspects.map((r) => `perf ${id}: flaky ${r.metric} ${r.baseline} -> ${r.value}, ${second.medians[r.metric]} (the second batch was within the thresholds)`);
    return out("flaky", lines, { batches });
  }
  const lines = confirmed.map((r) => `perf ${id}: regressed ${say(r)} (more than ${percent(thresholds[r.metric][0])} and ${thresholds[r.metric][1]}${unit(r.metric)})`);
  return out("regressed", lines, { batches, regressed: confirmed });
}

// ---------------------------------------------------------------------------------------------------
// The commands.

/** The stored entry of journey `id` for verb `smoke perf`, or a refusal. */
function entryOf(main, id) {
  if (typeof id !== "string" || !JOURNEY.test(id)) throw new Error("refused: smoke perf: not a journey id");
  const e = readPerf(main)[id];
  if (!e) throw new Error(`refused: smoke perf: ${id} has no perf record`);
  if (!e.latest) throw new Error(`refused: smoke perf: ${id} has no batch`);
  return e;
}

/** A path inside the repo that `git log` may take: relative, no `..`, no leading dash. */
const repoPath = (f) => typeof f === "string" && f.length > 0 && f.length <= 300 && !path.isAbsolute(f) && !f.startsWith("-") && !f.split("/").includes("..") && !/[\0\r\n\\]/.test(f);

/** The journey's anchor files (its steps' sources in .argus/journeys.json). */
function anchorFiles(main, id) {
  const j = (readJourneys(main)?.journeys ?? []).find((x) => x && x.id === id);
  return [...new Set((j ? j.steps : []).flatMap((s) => (s.sources ?? []).map((a) => a.file)).filter(repoPath))];
}

/**
 * `smoke perf --issue <id>` → `{code, lines, masked}`: the body of a perf issue for a confirmed regression
 * (spec §19.11): the baseline, both batches with the thresholds and each metric's verdict, web.dev's good values
 * as lab context, one `dedupe:` key (`perf:<id>:<metric>`) per regressed metric, and `git log` over the anchor
 * files since the baseline's head, fenced as data. The lines are already masked, so the CLI prints them as they
 * are. Refused: an id that is not a journey's, no record, no batch, no confirmed regression.
 */
export function perfIssue(main, id) {
  const e = entryOf(main, id);
  const { latest } = e;
  if (!latest.regressed.length) throw new Error(`refused: smoke perf: ${id} has no confirmed regression`);
  const loaded = loadSmoke(main);
  if (loaded.errors.length) throw new Error(`refused: smoke perf: ${loaded.errors.join("; ")}`);
  const th = (loaded.smoke ?? SMOKE_DEFAULTS).perf.thresholds;
  const bad = new Set(latest.regressed.map((r) => r.metric));
  const m = latest.machine;
  const lines = [`perf regression: ${id}`, ...latest.regressed.map((r) => `dedupe: perf:${id}:${r.metric}`), `baseline: head ${e.head.slice(0, 7)}, ${e.n} runs a batch`, `machine: ${m.cores} cores, ${m.mem_gb} GB, ${m.platform}, Chrome ${m.chrome}`];
  const head = ["metric", "baseline", ...latest.batches.map((_, i) => `batch ${i + 1}`), "thresholds", "verdict"];
  const rows = PERF_METRICS.map((k) => [k, String(e.medians[k]), ...latest.batches.map((b) => String(b[k])), `${percent(th[k][0])} and ${th[k][1]}${unit(k)}`, bad.has(k) ? "regressed" : "within"]);
  const widths = head.map((_, c) => Math.max(...[head, ...rows].map((r) => r[c].length)));
  for (const r of [head, ...rows]) lines.push(r.map((cell, c) => cell.padEnd(widths[c])).join("  ").trimEnd());
  lines.push(`lab context (web.dev's field targets at the 75th percentile, never a verdict): ${Object.entries(GOOD).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  const files = anchorFiles(main, id);
  if (!files.length) lines.push("commits since the baseline: the journey has no anchor files in .argus/journeys.json");
  else {
    const g = run(["git", "-C", main, "log", "--format=%h %s", `${e.head}..HEAD`, "--", ...files]);
    lines.push(`commits since the baseline's head over the journey's anchor files (${files.length}):`);
    const text = g.status === 0 ? String(g.stdout).trimEnd() : "(git log could not be read)";
    lines.push(fence(text || "(none)", { label: "COMMITS", secrets: loadLive(main).secrets }).body);
  }
  return { code: 0, lines, masked: true };
}

/** `smoke perf --rebaseline <id>` → `{code, lines}`: the baseline becomes the newest batch (its path digest, head, machine and runs with it). */
export function perfRebaseline(main, id) {
  const e = entryOf(main, id);
  const { latest } = e;
  const all = readPerf(main);
  all[id] = { pathSha: latest.pathSha, head: latest.head, machine: latest.machine, n: latest.n, medians: latest.batches.at(-1), latest: { ...latest, regressed: [] } };
  writePerf(main, all);
  return { code: 0, lines: [`perf ${id}: baseline moved to the newest batch (head ${latest.head.slice(0, 7)})`] };
}
