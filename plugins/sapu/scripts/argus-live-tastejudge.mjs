// argus-live-tastejudge.mjs — the taste pass's judge (spec §20.3, §20.4): every recorded screen's rules against
// the witnesses (the owner's frame, the app's best peer, the archetype's band), `<run>/taste/judge.json`, the best
// known path in `.argus/taste-state.json`, and the confirmation replay that makes a row two of two. Taste proposes,
// measurement decides (aesthetics.md §1): a row exists only where a number crossed a threshold, and a `bar` row only
// where the corpus band and an internal witness both agree.
import fs from "node:fs";
import path from "node:path";
import { AIUX_DRIVE, driveArg, faultArm, rulesFor as aiRules } from "./argus-live-aiux.mjs";
import { loadLive } from "./argus-live-config.mjs";
import { crossRules, pathCost, rulesFor as easeRules, ruleExpression as easeExpression } from "./argus-live-ease.mjs";
import { fence } from "./argus-live-fence.mjs";
import { liveDir, readLock, RUN_ID } from "./argus-live-lock.mjs";
import { readJourneys } from "./argus-live-map.mjs";
import { pathSha } from "./argus-live-perf.mjs";
import { tempBeside } from "./argus-live-proc.mjs";
import { runOnce } from "./argus-live-repro.mjs";
import { confirming, routeTemplate, spendTaste, tasteDir, tasteSpent } from "./argus-live-session.mjs";
import { loadSmoke } from "./argus-live-smokecfg.mjs";
import { censusOf, rulesFor as tasteRules, ruleExpression as tasteExpression } from "./argus-live-taste.mjs";
import { CURATOR_FILE, FAMILIES, loadBar, loadTaste, readCuratorFile, readTasteState, routeMatches, SCREEN_KEY, TASTE_BUDGET_MS, TASTE_FILE, titleKey, tokensPx, writeTasteState } from "./argus-live-tastecfg.mjs";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const round = (n) => Math.round(n * 100) / 100;
const writePrivate = (file, obj) => fs.renameSync(tempBeside(file, `${JSON.stringify(obj, null, 2)}\n`, 0o600), file);
const judgeFile = (main, runId) => path.join(tasteDir(main, runId), "judge.json");

/** A band is a witness only with this many sites and pages (decision 16); below, it is `thin` and shown only. */
const WITNESS_BAND = { sites: 5, n: 15 };
/** A peer comparison needs this many screens of the archetype in the cycle, the judged one included (decision 19). */
const PEERS_AT_LEAST = 3;
/** The starting severity of a confirmed row (aesthetics.md §7; F's filing may raise it): broken on its face S3, coherence and the bar S4, a cost of 10 s or more S3. */
const severityOf = (row) => (row.rule.startsWith("efficiency.") || (isNum(row.cost) && row.cost >= 10) || row.class === "implicit" ? "S3" : "S4");

// ---------------------------------------------------------------------------------------------------
// The run's records.

/** `run` (null: the newest run that recorded a screen) checked → its id; refused when it recorded none. */
function pickRun(main, run, verb) {
  if (run !== null && run !== undefined) {
    if (typeof run !== "string" || !RUN_ID.test(run)) throw new Error(`refused: ${verb}: --run takes a run id`);
    if (!fs.existsSync(tasteDir(main, run))) throw new Error(`refused: ${verb}: run ${run} recorded no screen`);
    return run;
  }
  let names = [];
  try {
    names = fs.readdirSync(liveDir(main)).filter((n) => RUN_ID.test(n) && fs.existsSync(tasteDir(main, n)));
  } catch {
    names = [];
  }
  if (!names.length) throw new Error(`refused: ${verb}: no run recorded a screen`);
  return names.sort().at(-1);
}

/** Every screen run `runId`'s slots recorded (`<run>/taste/<slot>/screens.jsonl`), in slot then file order → `{screens, bad}` (`bad` the lines of another shape). */
function readScreens(main, runId) {
  const base = tasteDir(main, runId);
  const screens = [];
  let bad = 0;
  const slots = fs
    .readdirSync(base)
    .filter((n) => /^[1-9][0-9]{0,3}$/.test(n))
    .sort((a, b) => Number(a) - Number(b));
  for (const slot of slots) {
    let text = "";
    try {
      text = fs.readFileSync(path.join(base, slot, "screens.jsonl"), "utf8");
    } catch {
      continue;
    }
    for (const l of text.split("\n").filter(Boolean)) {
      let s = null;
      try {
        s = JSON.parse(l);
      } catch {
        s = null;
      }
      const ok = isObj(s) && s.v === 1 && typeof s.journey === "string" && KEBAB.test(s.journey) && typeof s.key === "string" && SCREEN_KEY.test(s.key) && s.key === `${s.route}|${s.width}|${s.theme}`;
      if (ok) screens.push(s);
      else bad += 1;
    }
  }
  return { screens, bad };
}

/** Each journey's explorer path in run `runId` (`<run>/returns/<slot>.<generation>.json` holding `path`; the newest generation of the lowest slot) → Map(id → list). */
function explorerPaths(main, runId) {
  const dir = path.join(liveDir(main), runId, "returns");
  const out = new Map();
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /^[1-9][0-9]{0,3}\.[1-9]\.json$/.test(f));
  } catch {
    return out;
  }
  const order = (f) => f.split(".").map(Number);
  files.sort((a, b) => order(a)[0] - order(b)[0] || order(b)[1] - order(a)[1]);
  for (const f of files) {
    let r = null;
    try {
      r = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    } catch {
      r = null;
    }
    if (isObj(r) && typeof r.journey === "string" && Array.isArray(r.path) && r.path.length && !out.has(r.journey)) out.set(r.journey, r.path);
  }
  return out;
}

/**
 * The suite's admitted paths by journey (held at every width, so a held path), when the repo opted into the suite:
 * each `<dir>/journeys/<id>.json` `{journey: <id>, path}` (as -smoke reads them; a file of another shape is no held path).
 */
function heldPaths(main) {
  const { smoke } = loadSmoke(main);
  const out = new Map();
  if (!smoke) return out;
  const at = path.join(main, smoke.dir, "journeys");
  let names = [];
  try {
    names = fs.readdirSync(at).filter((f) => /^[a-z0-9]+(-[a-z0-9]+)*\.json$/.test(f));
  } catch {
    return out;
  }
  for (const f of names) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(at, f), "utf8"));
      if (isObj(raw) && raw.journey === f.slice(0, -5) && Array.isArray(raw.path)) out.set(raw.journey, raw.path);
    } catch {
      // not a held path
    }
  }
  return out;
}

/**
 * The Curator's leads for run `runId`'s judge (decision 17: a perception the next pass measures first): those of the
 * newest Curator return at or before the run, only when it validates whole (validateCurator) → `{run, leads, fault}`.
 */
function curatorLeads(main, runId, bar) {
  let names = [];
  try {
    names = fs.readdirSync(liveDir(main)).filter((n) => RUN_ID.test(n) && n <= runId && fs.existsSync(path.join(liveDir(main), n, CURATOR_FILE)));
  } catch {
    names = [];
  }
  const run = names.sort().at(-1);
  if (!run) return { run: null, leads: [], fault: null };
  const { value, fault } = readCuratorFile(path.join(liveDir(main), run), bar);
  return { run, leads: value ? value.leads : [], fault };
}

/** Run `runId`'s judge.json, or null. */
function readJudge(main, runId) {
  try {
    const j = JSON.parse(fs.readFileSync(judgeFile(main, runId), "utf8"));
    return isObj(j) && j.version === 1 && Array.isArray(j.rows) ? j : null;
  } catch {
    return null;
  }
}

/**
 * The owner's design tokens (live.json `tokens`: a CSS or JSON file in the repo, as the a11y token check reads it) in
 * px as the taste probe's scale (tokensPx), or null: they outrank the frame in the lane as in the suite.
 */
export function laneTokens(main) {
  try {
    const src = (loadLive(main).config ?? {}).tokens;
    const kind = isObj(src) && typeof src.css === "string" ? "css" : isObj(src) && typeof src.json === "string" ? "json" : null;
    if (!kind) return null;
    const file = path.resolve(main, src[kind]);
    if (path.relative(main, file).startsWith("..")) return null;
    return tokensPx(kind, fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------
// The judge.

/** A finding as the probes return it, `{rule, key, measured, expected}` (lane 0's shape), checked → the finding or null. */
function finding(f) {
  if (!isObj(f) || typeof f.rule !== "string" || typeof f.key !== "string" || f.key === "" || f.key.length > 300 || /[\r\n]/.test(f.key)) return null;
  const value = (v) => isNum(v) || (typeof v === "string" && v.length <= 200);
  if (!value(f.measured)) return null;
  return { rule: f.rule, key: f.key, measured: f.measured, expected: value(f.expected) ? f.expected : null };
}

/** Screen `s`'s archetype (decision 16): the owner's glob, else `data` for a table of 10 rows or more in `main`, else `app`, inferred. */
function archetypeOf(s, cfg) {
  const declared = Object.entries(cfg.archetypes).find(([glob]) => routeMatches(glob, s.route));
  if (declared) return { name: declared[1], inferred: false };
  return s.rows >= 10 ? { name: "data", inferred: false } : { name: "app", inferred: true };
}

/**
 * A rule the ease probe compares across the cycle's screens (crossRules: the consistency family, and a load behind a
 * spinner where a peer screen uses a skeleton): no replay re-measures it, the next cycle's judge reporting it again does.
 */
const crossScreen = (rule) => rule.family === "consistent" || rule.id === "feedback.skeleton-peers";

/** The band of `metric` for archetype `a`, when it is a witness: enough sites and pages, an archetype not inferred. */
function bandOf(bar, a, metric) {
  const b = (bar.archetypes[a.name] ?? {})[metric];
  if (!b) return { band: null, shown: null };
  if (a.inferred || b.sites < WITNESS_BAND.sites || b.n < WITNESS_BAND.n) return { band: null, shown: `${a.name} ${metric} ${a.inferred ? "inferred" : "thin"}` };
  return { band: b, shown: null };
}

/** Does the band agree that `m` is beyond the outside range? max-type: above p90; min-type: under p10; range: outside [p10, p90]. */
function bandAgrees(threshold, m, band) {
  if (!isNum(m)) return false;
  if ("max" in threshold) return m > band.p90;
  if ("min" in threshold) return m < band.p10;
  if ("range" in threshold) return m < band.p10 || m > band.p90;
  return false;
}

/** The owner's frame as a witness of a duration (decision 5): `motion.duration` outside the frame's durations. */
function frameWitness(rule, m, cfg, bar) {
  const f = cfg.frame ? bar.frames[cfg.frame] : null;
  if (!f || !f.durations || rule.metric !== "animation_ms" || !isNum(m)) return null;
  const [lo, hi] = f.durations.values ? [f.durations.values[0], f.durations.values.at(-1)] : f.durations.range;
  return m < lo || m > hi ? { kind: "frame", value: `${lo}-${hi}`, from: cfg.frame } : null;
}

/** The screen key a row of `rule` names on record `s`: a dark-parity rule the dark screen (when the page is themed), any other the screen's own. */
const rowScreen = (s, rule) => (rule.family === "colour" && rule.id.startsWith("colour.dark-") && s.themed ? `${s.route}|${s.width}|dark` : s.key);

/** The time from each recorded input to the first change after it, summed over records `list` (decision 3's `wait_ms`), or null with no input. */
function waitOf(list) {
  let ms = 0;
  let inputs = 0;
  for (const s of list) {
    const ev = [...(Array.isArray(s.events) ? s.events : [])].sort((a, b) => a.t - b.t);
    ev.forEach((e, i) => {
      if (e.kind !== "input") return;
      inputs += 1;
      const next = ev.slice(i + 1).find((x) => x.kind === "change" || x.kind === "input");
      if (next && next.kind === "change") ms += next.t - e.t;
    });
  }
  return inputs ? Math.round(ms) : null;
}

/**
 * `taste judge [--run <runId>]` → `{code, lines, masked}`: every screen run `run` (null: the newest that recorded one)
 * recorded, judged into `<run>/taste/judge.json` (0600) `{version: 1, run, bar, rows, journeys}`. Per screen, both
 * probes' rulesFor (the record with `cycle`, the run's other records, so a cross-screen rule can compare), less the
 * owner's `off` rules and the information rules. A rule with a `peer` threshold (decision 19's counts) is a row only
 * when the screen's archetype has 3 screens or more this cycle and its value is beyond max(best × ratio, best + plus) of
 * the best other one — and, where the archetype's band is a witness, beyond the band's percentile too. A `bar` row
 * needs the band (5 sites, 15 pages, an archetype not inferred) agreeing, and an internal witness: a peer screen of its
 * archetype that holds the rule, or the owner's frame (durations); `implicit` and `derived` rows stand on their
 * measurement. A cross-screen (`consistent`) row the previous run's judge also reported is confirmed: two cycles are
 * its two visits. Efficiency (decision 3): each journey's explorer path costed (pathCost); the best known path is
 * the suite's admitted path for the journey when it is shorter than the state's (a held path only), and a path at the
 * rule's ratio of its actions, or its seconds of KLM more, is a row the best path's replay confirms. taste-state.json
 * gets each judged journey's `judged` and `best`. Rows carry over a confirmation from an earlier judge of the run.
 */
export async function tasteJudge(main, { run }, { now = Date.now } = {}) {
  const t0 = now();
  const runId = pickRun(main, run, "taste judge");
  const bar = loadBar();
  const { taste: cfg, errors } = loadTaste(main);
  if (!cfg) throw new Error(`refused: taste judge: ${TASTE_FILE}: ${errors[0]}`);
  const rules = new Map(bar.rules.map((r) => [r.id, r]));
  const off = new Set(cfg.off);
  const scale = { ...cfg, tokens: laneTokens(main) };
  const { screens, bad } = readScreens(main, runId);
  const arch = new Map(screens.map((s) => [s.key, archetypeOf(s, cfg)]));
  let failed = 0;
  let info = 0;
  const found = []; // [{s, rule, f}]
  const keep = (s, raw, cross) => {
    const f = finding(raw);
    const rule = f && rules.get(f.rule);
    // Cross-screen rules come from crossRules alone, efficiency from the paths below.
    if (!rule || off.has(rule.id) || rule.family === "efficiency" || crossScreen(rule) !== cross) return;
    if (rule.info) info += 1;
    else found.push({ s, rule, f });
  };
  // Each recorded screen through the probes' rulesFor: T1's reads `taste` (censusOf's), T2's `route`, `events` and
  // `ease` (its screen kind), the AI probe's `route` and `ai` (on the owner's `ai` routes only); `cycle` holds the run's
  // other recorded screens.
  screens.forEach((s, i) => {
    const view = { ...s, cycle: screens.filter((_, j) => j !== i) };
    for (const fn of [tasteRules, easeRules, aiRules]) {
      let list = [];
      try {
        list = fn(view, bar, scale);
      } catch {
        failed += 1;
        continue;
      }
      for (const raw of Array.isArray(list) ? list : []) keep(s, raw, false);
    }
  });
  // The cross-screen rules over the run's screens (T2's crossRules, each with its archetype): a finding names a
  // screen key, and each journey that recorded that screen gets the row.
  try {
    const cross = crossRules(screens.map((s) => ({ key: s.key, route: s.route, journey: s.journey, archetype: arch.get(s.key).name, events: s.events, ease: s.ease ?? {} })), bar, scale);
    for (const raw of Array.isArray(cross) ? cross : []) {
      const seenJourneys = new Set();
      for (const s of screens.filter((x) => x.key === raw.screen && !seenJourneys.has(x.journey))) {
        seenJourneys.add(s.journey);
        keep(s, raw, true);
      }
    }
  } catch {
    failed += 1;
  }
  // Peer values: per rule, each screen key's largest measured number.
  const values = new Map();
  for (const { s, rule, f } of found) {
    if (!rule.threshold.peer || !isNum(f.measured)) continue;
    const m = values.get(rule.id) ?? new Map();
    m.set(s.key, Math.max(m.get(s.key) ?? -Infinity, f.measured));
    values.set(rule.id, m);
  }
  const groupOf = (s) => [...arch.entries()].filter(([, a]) => a.name === arch.get(s.key).name).map(([k]) => k);
  const shown = new Set();
  let unwitnessed = 0;
  const rows = [];
  const seen = new Set();
  const push = (r) => {
    const id = `${r.journey}\n${r.rule}\n${r.screen}\n${r.key}`;
    if (!seen.has(id)) (seen.add(id), rows.push(r));
  };
  for (const { s, rule, f } of found) {
    const a = arch.get(s.key);
    const group = groupOf(s);
    const { band, shown: why } = bandOf(bar, a, rule.metric);
    if (why) shown.add(why);
    const base = { journey: s.journey, rule: rule.id, class: rule.class, screen: rowScreen(s, rule), key: f.key, measured: f.measured, cost: null, confirmed: null };
    if (rule.threshold.peer) {
      const mine = values.get(rule.id) ?? new Map();
      const others = group.filter((k) => k !== s.key && mine.has(k));
      if (group.length < PEERS_AT_LEAST || !others.length || !isNum(f.measured)) continue;
      const bestKey = others.reduce((x, y) => (mine.get(y) < mine.get(x) ? y : x));
      const best = mine.get(bestKey);
      const [ratio, plus] = rule.threshold.peer;
      let expected = round(Math.max(best * ratio, best + plus));
      if (!(f.measured > expected)) continue;
      const witnesses = [{ kind: "peer", value: best, from: bestKey }];
      if (band) {
        const limit = band[rule.threshold.band ?? "p90"];
        if (!(f.measured > limit)) continue;
        expected = round(Math.max(expected, limit));
        witnesses.push({ kind: "band", value: limit, from: `${a.name} ${rule.threshold.band ?? "p90"}` });
      }
      push({ ...base, expected, witnesses });
      continue;
    }
    if (rule.class !== "bar") {
      push({ ...base, expected: f.expected, witnesses: [] });
      continue;
    }
    // A bar row: the band agreeing, and an internal witness.
    const internal = [];
    const holds = group.filter((k) => k !== s.key && !found.some((x) => x.s.key === k && x.rule.id === rule.id));
    if (group.length >= PEERS_AT_LEAST && holds.length) internal.push({ kind: "peer", value: "holds", from: holds.sort()[0] });
    const frame = frameWitness(rule, f.measured, cfg, bar);
    if (frame) internal.push(frame);
    if (!band || !bandAgrees(rule.threshold, f.measured, band) || !internal.length) {
      unwitnessed += 1;
      continue;
    }
    push({ ...base, expected: f.expected, witnesses: [{ kind: "band", value: "max" in rule.threshold ? band.p90 : "min" in rule.threshold ? band.p10 : `${band.p10}-${band.p90}`, from: `${a.name} ${rule.metric}` }, ...internal] });
  }

  // Efficiency: each journey's explorer path against the best known held path.
  const state = readTasteState(main);
  const paths = explorerPaths(main, runId);
  const held = heldPaths(main);
  const journeys = {};
  const ids = [...new Set([...screens.map((s) => s.journey), ...paths.keys()])].sort();
  // pathCost's geometry: one M a goal step of the journey's map (every step names its goal), no replay boxes (Kieras'
  // mean P), so an explorer's path and the best path of one journey are priced alike.
  let mapped = [];
  try {
    mapped = readJourneys(main)?.journeys ?? [];
  } catch {
    mapped = [];
  }
  const geometryOf = (id) => {
    const j = mapped.find((x) => x.id === id);
    return j ? { goals: j.steps.length, targets: [] } : { targets: [] };
  };
  const costOf = (list, id) => {
    try {
      const c = pathCost(list, geometryOf(id));
      return isObj(c) && [c.actions, c.typed, c.modals, c.fitts_bits, c.klm_s].every(isNum) ? c : null;
    } catch {
      return null;
    }
  };
  for (const id of ids) {
    const mine = screens.filter((s) => s.journey === id);
    const entry = state.journeys[id] ?? { judged: null, best: null, rows: {} };
    const heldList = held.get(id);
    const heldCost = heldList ? costOf(heldList, id) : null;
    if (heldCost && (!entry.best || heldCost.actions < entry.best.actions || pathSha(heldList) === entry.best.pathSha)) entry.best = { run: runId, actions: heldCost.actions, klm_s: round(heldCost.klm_s), pathSha: pathSha(heldList) };
    const list = paths.get(id);
    const cost = list ? costOf(list, id) : null;
    const recovery = rows.filter((r) => r.journey === id && r.rule === "states.recovery" && isNum(r.measured)).reduce((n, r) => n + r.measured, 0);
    journeys[id] = { screens: new Set(mine.map((s) => s.key)).size, efficiency: cost ? { actions: cost.actions, best: entry.best ? entry.best.actions : null, klm_s: round(cost.klm_s), typed: cost.typed, fitts_bits: round(cost.fitts_bits), modals: cost.modals, wait_ms: waitOf(mine), recovery } : null };
    const first = [...mine].sort((x, y) => x.t - y.t)[0];
    if (cost && entry.best && first && pathSha(list) !== entry.best.pathSha) {
      const witnesses = [{ kind: "peer", value: entry.best.actions, from: `best path ${entry.best.run}` }];
      const more = round(cost.klm_s - entry.best.klm_s);
      const actions = rules.get("efficiency.actions");
      const klm = rules.get("efficiency.klm");
      const base = { journey: id, screen: first.key, key: id, witnesses, cost: more > 0 ? more : null, confirmed: null };
      if (actions && !off.has(actions.id) && cost.actions >= actions.threshold.ratio * entry.best.actions) push({ ...base, rule: actions.id, class: actions.class, measured: cost.actions, expected: actions.threshold.ratio * entry.best.actions });
      if (klm && !off.has(klm.id) && more >= klm.threshold.plus_s) push({ ...base, rule: klm.id, class: klm.class, measured: round(cost.klm_s), expected: round(entry.best.klm_s + klm.threshold.plus_s) });
    }
    state.journeys[id] = { ...entry, judged: runId };
  }

  // Two cycles are a cross-screen row's two visits; an earlier judge of this run keeps its confirmations.
  const before = new Map((readJudge(main, runId)?.rows ?? []).map((r) => [`${r.journey}\n${r.rule}\n${r.screen}\n${r.key}`, r.confirmed]));
  const earlier = previousJudge(main, runId);
  // The Curator's leads, when its return validates, are measured first: the rows they name take the first numbers, so
  // a confirmation run in row order under the pass's budget replays them before the rest.
  const lead = curatorLeads(main, runId, bar);
  const led = (r) => lead.leads.some((l) => l.rule === r.rule && l.screen === r.screen);
  rows.sort((x, y) => Number(led(y)) - Number(led(x)) || (x.journey < y.journey ? -1 : x.journey > y.journey ? 1 : x.screen < y.screen ? -1 : x.screen > y.screen ? 1 : x.rule < y.rule ? -1 : x.rule > y.rule ? 1 : x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  const out = rows.map((r, i) => {
    const id = `${r.journey}\n${r.rule}\n${r.screen}\n${r.key}`;
    const again = crossScreen(rules.get(r.rule)) && earlier.has(id) ? true : null;
    return { row: `t${i + 1}`, journey: r.journey, rule: r.rule, class: r.class, screen: r.screen, key: r.key, measured: r.measured, expected: r.expected, witnesses: r.witnesses, cost: r.cost, confirmed: before.get(id) ?? again };
  });
  for (const r of out) if (r.confirmed === true) keepConfirmed(state, r, runId);
  fs.mkdirSync(tasteDir(main, runId), { recursive: true, mode: 0o700 });
  writePrivate(judgeFile(main, runId), { version: 1, run: runId, bar: bar.version, rows: out, journeys });
  writeTasteState(main, state);
  spendTaste(main, runId, "judge", now() - t0);

  const by = (c) => out.filter((r) => r.class === c).length;
  const lines = [`taste judge ${runId}: ${screens.length} screens recorded, ${out.length} rows (implicit ${by("implicit")}, derived ${by("derived")}, bar ${by("bar")}), taste-bar ${bar.version}`];
  if (unwitnessed) lines.push(`not rows: ${unwitnessed} beyond the bar without the corpus band and an internal witness`);
  if (info) lines.push(`information: ${info} findings of information rules (never rows)`);
  if (shown.size) lines.push(`bands shown only: ${shown.size}`);
  if (lead.fault) lines.push(`leads: the Curator's return of ${lead.run} is out of shape: its leads are not used`);
  else if (lead.leads.length) lines.push(`leads: ${out.filter(led).length} row(s) named by the ${lead.leads.length} lead(s) of ${lead.run}'s Curator come first`);
  if (failed) lines.push(`harness: a probe's rules failed ${failed} times`);
  if (bad) lines.push(`harness: ${bad} recorded screens of another shape skipped`);
  const secrets = loadLive(main).secrets ?? {};
  if (out.length) lines.push(fence(out.map(rowLine).join("\n"), { secrets }).body);
  return { code: 0, lines, masked: true };
}

/** A row in words (page text: printed only inside a fence). */
const rowLine = (r) => `${r.row} ${r.journey} ${r.rule} ${r.class} ${r.screen} key=${r.key} measured=${r.measured} expected=${r.expected ?? "-"} witnesses=${r.witnesses.map((w) => `${w.kind}:${w.value}@${w.from}`).join(",") || "-"}${r.confirmed === true ? " confirmed" : r.confirmed === false ? " not-confirmed" : ""}`;

/** The rows of the newest earlier run's judge.json, by identity. */
function previousJudge(main, runId) {
  let names = [];
  try {
    names = fs.readdirSync(liveDir(main)).filter((n) => RUN_ID.test(n) && n < runId).sort();
  } catch {
    names = [];
  }
  for (const n of names.reverse()) {
    const j = readJudge(main, n);
    if (j) return new Set(j.rows.map((r) => `${r.journey}\n${r.rule}\n${r.screen}\n${r.key}`));
  }
  return new Set();
}

/** A confirmed row kept in `state` under its title key (queued until filed; an existing row keeps its state, issue and first run). */
function keepConfirmed(state, r, runId) {
  const j = state.journeys[r.journey] ?? { judged: null, best: null, rows: {} };
  const k = titleKey(r.rule, r.screen);
  const had = j.rows[k];
  j.rows[k] = had ? { ...had, last: runId } : { rule: r.rule, screen: r.screen, class: r.class, severity: severityOf(r), state: "queued", issue: null, first: runId, last: runId };
  state.journeys[r.journey] = j;
}

// ---------------------------------------------------------------------------------------------------
// The confirmation replay.

/**
 * The in-daemon code the replay arms before its first navigation for a `states.error` row (decision 12, Task 0.1):
 * the first same-origin JSON GET (fetch or XHR) made while the page is at the row's route template is answered 500;
 * every other request goes on. The route lives with the session, which the replay closes at its end.
 */
function faultCode(S) {
  return `async page => {
  const S = ${JSON.stringify(S)};
  const routeOf = ${routeTemplate.toString()};
  let done = false;
  await page.context().route("**/*", async (route) => {
    const req = route.request();
    try {
      if (done || req.method() !== "GET" || !["fetch", "xhr"].includes(req.resourceType())) return await route.fallback();
      const at = new URL(req.frame().page().url());
      if (new URL(req.url()).origin !== at.origin || routeOf(at.pathname, S.routes) !== S.route) return await route.fallback();
      const response = await route.fetch();
      if (!done && /json/i.test(response.headers()["content-type"] || "")) {
        done = true;
        return await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "argus taste: routed fault" }) });
      }
      return await route.fulfill({ response });
    } catch (e) {
      try {
        await route.fallback();
      } catch (e2) {}
    }
  });
  return { armed: true };
}
`;
}

/**
 * The rules a page expression cannot re-measure (decision 6, decision 9): it cannot switch the media, so a `taste`
 * final would read them held. The confirmation measures them itself: the probe's census (censusOf: the page's own
 * scheme, the other one and reduced motion, the media restored as read, never null), then its rulesFor for the rule.
 */
export const MEDIA_RULES = Object.freeze(["colour.dark-contrast", "colour.dark-border", "colour.dark-surface", "motion.reduced"]);

/**
 * The replay's sink for row `row` (the session driver's, slot `r`, while confirming): `arm` (the routed fault of a
 * `states.error` row, the AI probe's marked fault of an `ai.error` row, else null); `wrap(text)` a step's code followed, at the first step after which the page is at
 * the row's route template and width, once the network settled, by the row's measurement — a MEDIA_RULES row through
 * the taste probe's censusOf and rulesFor (their sources, self-contained, with `bar`'s rule and frames and the owner's
 * frame), an AI row through the AI probe's drive (AIUX_DRIVE: it sends its own prompt on the surface and measures what
 * follows), any other through its probe's ruleExpression; `take(answer)` keeps that measurement (`measured`: `{rows}` of
 * the rule, at most 50, or `{rows: null}` when it failed) and removes it from the step's answer.
 */
export function confirmSink(row, { routes, settleMs, bar = loadBar(), cfg = null }) {
  const [route, width] = row.screen.split("|");
  const family = row.rule.split(".")[0];
  const frame = cfg ? { frame: cfg.frame ?? null, tokens: cfg.tokens ?? null } : {};
  const media = MEDIA_RULES.includes(row.rule);
  const ai = family === "ai";
  const S = { rule: row.rule, route, width: Number(width), routes, settleMs, media, ...(media ? { census: String(censusOf), rules: String(tasteRules), bar: { version: bar.version, rules: bar.rules.filter((r) => r.id === row.rule), frames: bar.frames }, cfg: frame } : ai ? { drive: AIUX_DRIVE, driveArg: driveArg(row.rule) } : { expr: (FAMILIES[family].probe === "ease" ? easeExpression : tasteExpression)(row.rule, frame) }) };
  const sink = {
    measured: null,
    arm: row.rule === "states.error" ? faultCode(S) : row.rule === "ai.error" ? faultArm() : null,
    wrap: (text) =>
      sink.measured
        ? text
        : `async page => {
  const answer = await (${text.trimEnd()})(page);
  const S = ${JSON.stringify(S)};
  try {
    const vp = page.viewportSize();
    const width = vp && vp.width ? vp.width : await page.evaluate("innerWidth");
    if (width === S.width && (${routeTemplate.toString()})(new URL(page.url()).pathname, S.routes) === S.route) {
      await page.waitForLoadState("networkidle", { timeout: S.settleMs }).catch(() => {});
      let rows = null;
      try {
        rows = S.media ? new Function("return " + S.rules)()(await new Function("return " + S.census)()(page), S.bar, S.cfg) : S.drive ? await new Function("return " + S.drive)()(page, S.driveArg) : await page.evaluate(S.expr);
      } catch (e) {
        rows = null;
      }
      answer.__taste = { rows: Array.isArray(rows) ? rows.filter((r) => r && r.rule === S.rule).slice(0, 50).map((r) => ({ key: String(r.key).slice(0, 300), measured: r.measured })) : null };
    }
  } catch (e) {}
  return answer;
}
`,
    take: (answer) => {
      if (isObj(answer) && Object.hasOwn(answer, "__taste")) {
        if (!sink.measured) sink.measured = isObj(answer.__taste) ? answer.__taste : { rows: null };
        delete answer.__taste;
      }
      return answer;
    },
  };
  return sink;
}

/** Was row `row` measured again by `measured` (the sink's)? A peer-count row: a row of its key beyond its expected; any other: a row of its key. */
function remeasured(row, measured, rule) {
  const mine = measured.rows.filter((r) => r.key === row.key);
  if (rule.threshold.peer) return mine.some((r) => isNum(r.measured) && isNum(row.expected) && r.measured > row.expected);
  return mine.length > 0;
}

/**
 * `taste confirm <row>` → `{code, lines, masked}`: judge row `ref` (`t<k>`) of the lock's run replayed in slot `r` on a
 * fresh instance (runOnce in path mode, its records under `<run>/smoke/taste-<row>/`) and measured again; the result
 * written back to judge.json (`confirmed` true or false) and a confirmed row kept in taste-state.json (`queued`). A
 * screen row replays the journey's explorer path through the confirm sink; an efficiency row replays the journey's
 * best known path (the suite's, by its sha): it is confirmed only when that path no longer holds — while it holds, the
 * longer path was the explorer's detour. A cross-screen row is confirmed by the next cycle's judge, never a replay.
 * Exit 0 when the replay decided, 2 when the harness failed or the screen was never reached (`confirmed` left null).
 * Refused: no cycle, a row of another shape or not in the judge, the taste pass's time spent (TASTE_BUDGET_MS), no path.
 */
export async function tasteConfirm(main, ref, { once = runOnce, now = Date.now } = {}) {
  const t0 = now();
  const lock = readLock(main);
  if (!lock) throw new Error("refused: no journey cycle is running");
  const runId = lock.runId;
  if (typeof ref !== "string" || !/^t[1-9][0-9]{0,4}$/.test(ref)) throw new Error(`refused: taste confirm: ${typeof ref === "string" && /^[\x21-\x7e]{1,20}$/.test(ref) ? ref : "that"} is not a judge row (t<k>)`);
  const judge = readJudge(main, runId);
  if (!judge) throw new Error(`refused: taste confirm: cycle ${runId} has no judge rows (taste judge first)`);
  const row = judge.rows.find((r) => r.row === ref);
  if (!row) throw new Error(`refused: taste confirm: no row ${ref} in cycle ${runId}'s judge`);
  const bar = loadBar();
  const rule = bar.rules.find((r) => r.id === row.rule);
  if (!rule) throw new Error(`refused: taste confirm: ${ref}'s rule is not in taste-bar ${bar.version}`);
  if (crossScreen(rule)) throw new Error(`refused: taste confirm: ${row.rule} compares the cycle's screens: the next cycle's judge confirms it, not a replay`);
  if (tasteSpent(main, runId) >= TASTE_BUDGET_MS) throw new Error("refused: taste confirm: the taste pass's time this cycle is spent");
  const state = readTasteState(main);
  let confirmed = null;
  let said;
  let replay = [];
  /** The replay's own HARNESS line (runOnce's, masked by it), carried into the answer. */
  const ran = (r) => ((replay = (Array.isArray(r.lines) ? r.lines : []).filter((l) => /^HARNESS: /.test(l)).slice(-1)), r);
  try {
    if (rule.family === "efficiency") {
      const best = (state.journeys[row.journey] ?? {}).best;
      const list = best ? [...heldPaths(main)].map(([, l]) => l).find((l) => pathSha(l) === best.pathSha) : null;
      if (!list) throw new Error(`refused: taste confirm: the best path of ${row.journey} is not in the suite`);
      const r = ran(await once(main, null, { path: { id: `taste-${ref}`, list } }));
      if (r.code === 0) [confirmed, said] = [false, "the best path still holds: the longer path was the explorer's detour"];
      else if (r.code === 3) [confirmed, said] = [true, "the best path no longer holds"];
      else said = "harness: the best path's replay failed";
    } else {
      const list = explorerPaths(main, runId).get(row.journey);
      if (!list) throw new Error(`refused: taste confirm: journey ${row.journey} returned no path to replay`);
      let routes = [];
      try {
        routes = JSON.parse(fs.readFileSync(path.join(main, ".argus/journeys.json"), "utf8")).journeys.flatMap((j) => j.steps.map((s) => s.route)).filter((x) => typeof x === "string");
      } catch {
        routes = [];
      }
      const sink = confirmSink(row, { routes, settleMs: (loadLive(main).config ?? {}).settle_ms ?? 10_000, bar, cfg: { ...(loadTaste(main).taste ?? {}), tokens: laneTokens(main) } });
      const r = ran(await confirming(sink, () => once(main, null, { path: { id: `taste-${ref}`, list } })));
      if (!sink.measured) said = r.code === 2 && !sink.measured ? "harness: the replay failed before the screen" : "harness: the replay never reached the screen";
      else if (sink.measured.rows === null) said = "harness: the rule's expression failed on the screen";
      else [confirmed, said] = remeasured(row, sink.measured, rule) ? [true, "measured again"] : [false, "not measured again: the screen holds the rule"];
    }
  } finally {
    spendTaste(main, runId, "confirm", now() - t0);
  }
  if (confirmed !== null) {
    const fresh = readJudge(main, runId) ?? judge;
    const at = fresh.rows.find((r) => r.row === ref && r.rule === row.rule && r.key === row.key);
    if (at) at.confirmed = confirmed;
    writePrivate(judgeFile(main, runId), fresh);
    if (confirmed) {
      keepConfirmed(state, row, runId);
      writeTasteState(main, state);
    }
  }
  const word = confirmed === true ? "confirmed" : confirmed === false ? "not confirmed" : "not decided";
  const lines = [`taste confirm ${ref}: ${word} (${said.replace(/^harness: /, "")})`, ...(said.startsWith("harness: ") ? [said, ...replay] : []), fence(rowLine({ ...row, confirmed }), { secrets: loadLive(main).secrets ?? {} }).body];
  return { code: confirmed === null ? 2 : 0, lines, masked: true };
}
