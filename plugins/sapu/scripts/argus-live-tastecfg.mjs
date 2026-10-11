// argus-live-tastecfg.mjs — phase 7's shared surfaces (spec §20.3): the taste bar the plugin ships
// (`data/taste-bar.json`: rules, frames, calibrated archetype bands, sources), the owner's `.argus/taste.json`
// and the lane's `.argus/taste-state.json`, each with its one validator, reader and writer. A leaf module: it
// imports no other argus-live module, so the probes, the judge, SELECT, filing and the suite all read the same
// shapes from here.
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isInt = (v, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isInteger(v) && v >= min && v <= max;
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const deepFreeze = (o) => {
  for (const v of Object.values(o)) if (v && typeof v === "object") deepFreeze(v);
  return Object.freeze(o);
};
/** How a refusal shows a word the file holds: as given when short and plain, else not at all. */
const shown = (v) => (typeof v === "string" && /^[\x21-\x7e]{1,200}$/.test(v) ? v : "(not shown)");
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// ---------------------------------------------------------------------------------------------------
// The bar.

/** The bar's file in the installed plugin. */
export const BAR_FILE = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "data", "taste-bar.json");
/** Decision 4's classes: broken on its face, a self-contradiction, beyond the outside range. */
export const RULE_CLASSES = Object.freeze(["implicit", "derived", "bar"]);
/**
 * Each rule family (a rule id's prefix) → the probe module that measures it (`taste`: argus-live-taste.mjs, `ease`:
 * argus-live-ease.mjs, `aiux`: argus-live-aiux.mjs) and its scope: `screen` rules are measured on one screen (the suite runs them, a replay's `taste`
 * expectation re-runs them); `cycle` rules compare a cycle's screens or paths and run only in the lane's judge.
 */
export const FAMILIES = deepFreeze({
  scale: { probe: "taste", scope: "screen" },
  hierarchy: { probe: "taste", scope: "screen" },
  colour: { probe: "taste", scope: "screen" },
  contrast: { probe: "taste", scope: "screen" },
  motion: { probe: "taste", scope: "screen" },
  density: { probe: "taste", scope: "screen" },
  feedback: { probe: "ease", scope: "screen" },
  states: { probe: "ease", scope: "screen" },
  copy: { probe: "ease", scope: "screen" },
  ai: { probe: "aiux", scope: "screen" },
  consistent: { probe: "ease", scope: "cycle" },
  efficiency: { probe: "ease", scope: "cycle" },
});
/**
 * Screen rules only the lane's judge and confirmation measure (never the suite, never a replay's `taste` final): what
 * one page expression on one page cannot see. A rule with a `peer` or `band` threshold compares the cycle's screens.
 */
const LANE_ONLY = Object.freeze({
  "feedback.skeleton-peers": "it compares a screen with its peers",
  "feedback.optimistic": "it reads the owner's optimistic routes",
  "states.recovery": "a form case drives it",
  "states.error": "the routed fault: only the lane's confirmation arms it",
});
/** Bar rule `rule` → why only the lane measures it, or null when a page expression can (the suite, a `taste` final). */
export function laneOnly(rule) {
  if (!isObj(rule) || typeof rule.id !== "string") return null;
  if (isObj(rule.threshold) && ("peer" in rule.threshold || "band" in rule.threshold)) return "it compares the cycle's screens";
  if (rule.family === "ai") return "it reads the owner's declared AI surfaces";
  return Object.hasOwn(LANE_ONLY, rule.id) ? LANE_ONLY[rule.id] : null;
}
/**
 * The owner's design tokens (live.json `tokens`: a CSS file's custom properties or a JSON file's leaves, read as
 * a11yTokens reads them) as the taste probe's scale (`rulesFor`'s `cfg.tokens`): `{spacing?, radius?, type?}`, each
 * the sorted px values whose name (a custom property's, a JSON path's) names that kind; px as written, `rem`/`em`
 * at 16 px (the root's default), a bare number px; anything else (`calc()`, `var()`, `%`) is no value. Null when no
 * kind holds a value, so a frame is not outranked by an empty scale. Self-contained: support.ts embeds its source.
 */
export function tokensPx(kind, text) {
  const KINDS = [["radius", /radius|radii|rounded|corner/i], ["type", /font[-_.]?size|text[-_.]?size|type[-_.]?(scale|size)|(^|[-_.])text([-_.]|$)/i], ["spacing", /spac|gap|gutter|inset|margin|padding|(^|[-_.])space([-_.]|$)/i]];
  const out = { spacing: [], radius: [], type: [] };
  const px = (v) => {
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    const m = String(v).match(/^\s*(\d*\.?\d+)\s*(px|rem|em)?\s*$/i);
    return m ? Number(m[1]) * (m[2] && /em$/i.test(m[2]) ? 16 : 1) : null;
  };
  const add = (name, v) => {
    const k = KINDS.find((x) => x[1].test(name));
    const n = px(v);
    if (k && n !== null && n <= 1000) out[k[0]].push(Math.round(n * 100) / 100);
  };
  if (kind === "css") {
    for (const m of String(text).replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/--([\w-]+)\s*:\s*([^;}]+)/g)) add(m[1], m[2].trim());
  } else if (kind === "json") {
    const walk = (n, at) => {
      if (typeof n === "string" || typeof n === "number") add(at, n);
      else if (n && typeof n === "object" && !Array.isArray(n)) {
        if ("$value" in n || "value" in n) return walk("$value" in n ? n.$value : n.value, at);
        for (const [k, v] of Object.entries(n)) if (!k.startsWith("$")) walk(v, at ? at + "." + k : k);
      }
    };
    try {
      walk(JSON.parse(text), "");
    } catch (e) {
      return null;
    }
  }
  const res = {};
  for (const k of Object.keys(out)) if (out[k].length) res[k] = [...new Set(out[k])].sort((a, b) => a - b);
  return Object.keys(res).length ? res : null;
}
/** Decision 16's archetypes: a screen is compared only with its own. */
export const ARCHETYPES = Object.freeze(["marketing", "docs", "app", "form", "data"]);
const BAR_KEYS = ["version", "probe", "sources", "rules", "frames", "archetypes"];
const RULE_KEYS = ["id", "family", "class", "metric", "threshold", "cite", "gate", "info", "terms"];
/** A threshold's words: bounds (`min`, `max`, `range` outside fires, `within` inside fires), the peer and band tests, ratios. */
const THRESHOLD = {
  min: isNum,
  max: isNum,
  range: (v) => Array.isArray(v) && v.length === 2 && v.every(isNum) && v[0] <= v[1],
  within: (v) => Array.isArray(v) && v.length === 2 && v.every(isNum) && v[0] <= v[1],
  peer: (v) => Array.isArray(v) && v.length === 2 && v.every((x) => isNum(x) && x >= 0),
  band: (v) => ["p10", "p50", "p90"].includes(v),
  ratio: (v) => isNum(v) && v > 0,
  plus_s: (v) => isNum(v) && v >= 0,
  opacity_max: (v) => isNum(v) && v >= 0,
  min_wait: (v) => isNum(v) && v >= 0,
};
const FRAME_METRICS = ["spacing", "radius", "type", "durations"];
const METRIC = /^[a-z][a-z0-9_]{0,63}$/;
const RULE_ID = /^([a-z]+)\.[a-z0-9]+(-[a-z0-9]+)*$/;
const httpsUrl = (v) => {
  if (typeof v !== "string" || v.length > 500 || /\s/.test(v)) return false;
  try {
    return new URL(v).protocol === "https:";
  } catch {
    return false;
  }
};

/**
 * The bar's content checked → `{value, errors}` (`value` null on any error): `{version, probe, sources, rules, frames,
 * archetypes}`, unknown keys refused at every level. `sources` maps a research id to its https URL; each rule is
 * `{id: <family>.<name>, family, class, metric, threshold, cite: [source ids], gate: false, info?: true, terms?:
 * {<lang>: [labels]}}`; each frame `{cite, historical?, spacing?, radius?, type?, durations?, layers?}`, a metric
 * `{values: [ascending]}` or `{range: [min, max], step?}`; `archetypes.<archetype>.<metric>` is a band `{n, sites, p10,
 * p50, p90, urls}` — numbers, metric names and https URLs only, never another string (decision 16).
 */
export function validateBar(raw) {
  if (!isObj(raw)) return { value: null, errors: ["taste-bar.json must be a JSON object"] };
  const errs = [];
  const need = (cond, msg) => cond || errs.push(msg);
  const unknown = (obj, where, allowed) => {
    for (const k of Object.keys(obj)) if (!allowed.includes(k)) errs.push(`${where}: unknown key "${shown(k)}"`);
  };
  unknown(raw, "taste-bar.json", BAR_KEYS);
  need(isInt(raw.version, 1), "version must be a positive integer");
  need(raw.probe === null || (typeof raw.probe === "string" && /^[0-9a-f]{64}$/.test(raw.probe)), "probe must be null or a sha256 (64 hex digits)");
  const sources = isObj(raw.sources) ? raw.sources : {};
  if (need(isObj(raw.sources), "sources must map research ids to https URLs") === true) {
    for (const [id, url] of Object.entries(raw.sources)) need(KEBAB.test(id) && httpsUrl(url), `sources.${shown(id)} must be a research id mapped to an https URL`);
  }
  const cites = (v, where) => {
    if (need(Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string" && KEBAB.test(x)), `${where} must be a non-empty array of source ids`) !== true) return;
    for (const id of v) need(Object.hasOwn(sources, id), `${where}: ${id} is not in sources`);
  };
  const ids = new Set();
  if (need(Array.isArray(raw.rules) && raw.rules.length > 0, "rules must be a non-empty array") === true) {
    raw.rules.forEach((r, i) => {
      const at = `rules[${i}]`;
      if (need(isObj(r), `${at} must be an object`) !== true) return;
      unknown(r, at, RULE_KEYS);
      const m = typeof r.id === "string" ? RULE_ID.exec(r.id) : null;
      if (need(m && Object.hasOwn(FAMILIES, m[1]), `${at}.id must be <family>.<name> with a family of ${Object.keys(FAMILIES).join(", ")}`) === true) {
        need(r.family === m[1], `${at}: the id ${r.id} names family ${m[1]}, not ${shown(r.family)}`);
        need(!ids.has(r.id), `${at}: the id ${r.id} is taken`);
        ids.add(r.id);
      }
      need(RULE_CLASSES.includes(r.class), `${at}.class must be ${RULE_CLASSES.slice(0, -1).join(", ")} or ${RULE_CLASSES.at(-1)}`);
      need(typeof r.metric === "string" && METRIC.test(r.metric), `${at}.metric must be a metric name (${METRIC.source})`);
      need(isObj(r.threshold) && Object.keys(r.threshold).length > 0 && Object.entries(r.threshold).every(([k, v]) => Object.hasOwn(THRESHOLD, k) && THRESHOLD[k](v)), `${at}.threshold must be an object of ${Object.keys(THRESHOLD).join(", ")}, each a number or a pair of numbers`);
      cites(r.cite, `${at}.cite`);
      need(r.gate === false, `${at}.gate must be false: the owner promotes a rule in .argus/taste.json`);
      if ("info" in r) need(r.info === true, `${at}.info must be true when present`);
      if ("terms" in r) need(isObj(r.terms) && Object.keys(r.terms).length > 0 && Object.entries(r.terms).every(([lang, list]) => /^[a-z]{2,3}$/.test(lang) && Array.isArray(list) && list.length > 0 && list.every((t) => typeof t === "string" && t.length >= 1 && t.length <= 60)), `${at}.terms must map a language to a non-empty list of labels`);
    });
  }
  if (need(isObj(raw.frames), "frames must be an object") === true) {
    for (const [name, f] of Object.entries(raw.frames)) {
      const at = `frames.${shown(name)}`;
      if (need(KEBAB.test(name) && isObj(f), `${at} must be an object`) !== true) continue;
      unknown(f, at, ["cite", "historical", ...FRAME_METRICS, "layers"]);
      cites(f.cite, `${at}.cite`);
      if ("historical" in f) need(f.historical === true, `${at}.historical must be true when present`);
      if ("layers" in f) need(isInt(f.layers, 1, 12), `${at}.layers must be an integer from 1 to 12`);
      need(FRAME_METRICS.some((k) => k in f) || "layers" in f, `${at} must hold at least one of ${FRAME_METRICS.join(", ")}, layers`);
      for (const k of FRAME_METRICS.filter((x) => x in f)) {
        const v = f[k];
        const values = isObj(v) && Array.isArray(v.values) && v.values.length > 0 && v.values.every((x) => isNum(x) && x >= 0) && v.values.every((x, j) => j === 0 || x > v.values[j - 1]);
        const range = isObj(v) && THRESHOLD.range(v.range) && v.range[0] >= 0 && (v.step === undefined || (isNum(v.step) && v.step > 0));
        need(isObj(v) && Object.keys(v).every((x) => ["values", "range", "step"].includes(x)) && (values ? !("range" in v) && !("step" in v) : range && !("values" in v)), `${at}.${k} must be {values: [ascending numbers]} or {range: [min, max], step?}`);
      }
    }
  }
  if (need(isObj(raw.archetypes), "archetypes must be an object") === true) {
    for (const [a, metrics] of Object.entries(raw.archetypes)) {
      const at = `archetypes.${shown(a)}`;
      if (need(ARCHETYPES.includes(a) && isObj(metrics), `${at}: an archetype is one of ${ARCHETYPES.join(", ")}, holding bands by metric`) !== true) continue;
      for (const [metric, b] of Object.entries(metrics)) {
        const bt = `${at}.${shown(metric)}`;
        if (need(METRIC.test(metric) && isObj(b), `${bt}: a band is {n, sites, p10, p50, p90, urls} under a metric name`) !== true) continue;
        unknown(b, bt, ["n", "sites", "p10", "p50", "p90", "urls"]);
        need(isInt(b.sites, 1) && isInt(b.n, 1) && b.n >= b.sites, `${bt}: n must be an integer of at least its sites (a site gives a page at least)`);
        need(["p10", "p50", "p90"].every((p) => isNum(b[p])) && b.p10 <= b.p50 && b.p50 <= b.p90, `${bt}: p10 <= p50 <= p90, each a number`);
        need(Array.isArray(b.urls) && b.urls.length > 0 && b.urls.every(httpsUrl) && new Set(b.urls).size === b.urls.length && (!isInt(b.n) || b.urls.length <= b.n), `${bt}.urls must be the distinct https URLs measured, at most n`);
      }
    }
  }
  return errs.length ? { value: null, errors: errs } : { value: structuredClone(raw), errors: [] };
}

let cachedBar = null;
/** The plugin's bar, validated once and frozen. A broken bar is the engine's defect: `failed: …`, naming its first error. */
export function loadBar() {
  if (cachedBar) return cachedBar;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(BAR_FILE, "utf8"));
  } catch (e) {
    throw new Error(`failed: the taste bar ${e instanceof SyntaxError ? "is not valid JSON" : "cannot be read"} (${BAR_FILE})`);
  }
  const { value, errors } = validateBar(raw);
  if (!value) throw new Error(`failed: the taste bar is broken: ${errors[0]}`);
  cachedBar = deepFreeze(value);
  return cachedBar;
}

// ---------------------------------------------------------------------------------------------------
// `.argus/taste.json`.

/** Tracked like smoke.json, the owner's: unknown keys are refused at every level, and every absent key takes its default. */
export const TASTE_FILE = ".argus/taste.json";
export const TASTE_KEYS = Object.freeze(["version", "frame", "archetypes", "accept", "gate", "off", "cap", "optimistic", "ai", "copy"]);
export const TASTE_DEFAULTS = deepFreeze({ version: 1, frame: null, archetypes: {}, accept: [], gate: [], off: [], cap: 5, optimistic: [], ai: [], copy: { vague: [] } });
/** A route glob: a path from `/`, path characters, `*` (one segment) and `**` (any depth); `:param` is a literal segment; no `.` or `..` segment. */
const ROUTE_GLOB = /^\/[A-Za-z0-9._~:@!$&'()+,;=*/-]{0,199}$/;
const isGlob = (v) => typeof v === "string" && ROUTE_GLOB.test(v) && !v.split("/").some((s) => s === "." || s === "..");
const LABEL = /^[^\u0000-\u001f\u007f-\u009f]{1,60}$/;

/** `route` (a route template as the map spells it, `/orders/:id`) matched against `glob`: `*` stands for one segment's characters, `**` for any depth. */
export function routeMatches(glob, route) {
  if (!isGlob(glob) || typeof route !== "string") return false;
  const re = glob
    .split(/(\/\*\*$|\*\*|\*)/)
    .map((p) => (p === "/**" ? "(?:/.*)?" : p === "**" ? ".*" : p === "*" ? "[^/]*" : p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${re}$`).test(route);
}

/**
 * `.argus/taste.json`'s content checked against `bar` (the plugin's) → `{value, errors}`: `value` with every default
 * filled in (null on any error). `frame` one of the bar's frames; `archetypes` route globs → one of ARCHETYPES; `accept`
 * `[{rule, key, why}]` (`key` the screen key the issue names); `gate` distinct rule ids of the bar, `off` distinct rule
 * ids, family names or `*` (the value: the rule ids they name, sorted), no rule in both,
 * an information rule never gated, nor a rule the suite cannot measure (a cycle rule, or laneOnly's); `cap` 1-20; `optimistic` and `ai` route globs; `copy.vague` the owner's labels.
 */
export function validateTaste(raw, bar = loadBar()) {
  if (!isObj(raw)) return { value: null, errors: [`${TASTE_FILE} must be a JSON object`] };
  const errs = [];
  const need = (cond, msg) => cond || errs.push(msg);
  const unknown = (obj, where, allowed) => {
    for (const k of Object.keys(obj)) if (!allowed.includes(k)) errs.push(`${where}: unknown key "${shown(k)}"`);
  };
  const rules = new Map(bar.rules.map((r) => [r.id, r]));
  const frames = Object.keys(bar.frames).sort();
  const has = (k) => k in raw;
  for (const k of Object.keys(raw)) if (!TASTE_KEYS.includes(k)) errs.push(`unknown key "${shown(k)}"`);
  // The file's own version: 1, the only one so far (a later shape names another, and an older plugin refuses it).
  if (has("version")) need(raw.version === 1, "version must be 1");
  if (has("frame")) need(typeof raw.frame === "string" && frames.includes(raw.frame), `frame must be one of ${frames.join(", ")}`);
  if (has("archetypes") && need(isObj(raw.archetypes), "archetypes must map route globs to archetypes") === true) {
    for (const [glob, a] of Object.entries(raw.archetypes)) {
      if (!isGlob(glob)) errs.push(`archetypes: ${shown(glob)} is not a route glob (/…, path characters and *)`);
      else need(ARCHETYPES.includes(a), `archetypes.${glob} must be one of ${ARCHETYPES.join(", ")}`);
    }
  }
  const ruleList = (k) => {
    if (need(Array.isArray(raw[k]) && raw[k].every((x) => typeof x === "string") && new Set(raw[k]).size === raw[k].length, `${k} must be an array of distinct rule ids`) !== true) return;
    for (const id of raw[k]) need(rules.has(id), `${k}: ${shown(id)} is not a rule of the bar`);
  };
  if (has("gate")) ruleList("gate");
  // off: rule ids, a family's name (its every rule) or `*` (the whole pass), each expanded to the rule ids it names.
  let offIds = [];
  if (has("off") && need(Array.isArray(raw.off) && raw.off.every((x) => typeof x === "string") && new Set(raw.off).size === raw.off.length, "off must be an array of distinct rule ids, family names or *") === true) {
    for (const w of raw.off) {
      const named = w === "*" ? bar.rules : rules.has(w) ? [rules.get(w)] : bar.rules.filter((r) => r.family === w);
      if (need(named.length > 0, `off: ${shown(w)} is not a rule, a family or * of the bar`) === true) offIds.push(...named.map((r) => r.id));
    }
    offIds = [...new Set(offIds)].sort();
  }
  if (Array.isArray(raw.gate)) {
    for (const id of raw.gate.filter((x) => rules.has(x))) {
      if (offIds.includes(id)) errs.push(`gate and off both name ${id}`);
      const rule = rules.get(id);
      const lane = FAMILIES[rule.family].scope === "cycle" ? "it compares the cycle's screens or paths" : laneOnly(rule);
      if (rule.info) errs.push(`gate: ${id} is information only: it cannot gate`);
      else if (lane) errs.push(`gate: ${id} is the lane's alone (${lane}): the suite cannot measure it, so it cannot gate`);
    }
  }
  if (has("accept") && need(Array.isArray(raw.accept), "accept must be an array of {rule, key, why}") === true) {
    raw.accept.forEach((a, i) => {
      const at = `accept[${i}]`;
      if (isObj(a)) unknown(a, at, ["rule", "key", "why"]);
      if (need(isObj(a) && typeof a.rule === "string" && typeof a.key === "string" && a.key !== "" && a.key.length <= 300 && typeof a.why === "string" && a.why.trim() !== "" && a.why.length <= 500, `${at} must be {rule, key, why}: key the screen key (at most 300 characters), why the owner's reason (at most 500)`) === true) {
        need(rules.has(a.rule), `${at}.rule: ${shown(a.rule)} is not a rule of the bar`);
      }
    });
  }
  if (has("cap")) need(isInt(raw.cap, 1, 20), "cap must be an integer from 1 to 20");
  for (const k of ["optimistic", "ai"]) if (has(k)) need(Array.isArray(raw[k]) && raw[k].every(isGlob) && new Set(raw[k]).size === raw[k].length, `${k} must be an array of distinct route globs (/…, path characters and *)`);
  if (has("copy") && need(isObj(raw.copy), "copy must be an object") === true) {
    unknown(raw.copy, "copy", ["vague"]);
    if ("vague" in raw.copy) need(Array.isArray(raw.copy.vague) && raw.copy.vague.length <= 50 && raw.copy.vague.every((t) => typeof t === "string" && LABEL.test(t) && t.trim() !== "") && new Set(raw.copy.vague).size === raw.copy.vague.length, "copy.vague must be an array of distinct labels of 1 to 60 characters, without control characters");
  }
  if (errs.length) return { value: null, errors: errs };
  const d = structuredClone(TASTE_DEFAULTS);
  const r = structuredClone(raw);
  return { value: { ...d, ...r, copy: { ...d.copy, ...r.copy }, off: offIds }, errors: [] };
}

/** What a taste verb says when taste.json turns the pass off. */
export const PASS_OFF = "the taste pass is off for this repo (.argus/taste.json's off covers every rule): nothing recorded, judged or filed";
/** Whether taste.json's value `cfg` turns the whole pass off (`off: ["*"]`, or every rule of the bar named): nothing is recorded, judged or filed. */
export function tasteOff(cfg, bar = loadBar()) {
  return Boolean(cfg) && Array.isArray(cfg.off) && bar.rules.every((r) => cfg.off.includes(r.id));
}

/** `{taste, errors, missing}` from `<main>/.argus/taste.json`: every default when there is none (`missing`; the taste pass is on by default). Never throws. */
export function loadTaste(main) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(main, TASTE_FILE), "utf8"));
  } catch (e) {
    if (e && e.code === "ENOENT") return { taste: validateTaste({}).value, errors: [], missing: true };
    return { taste: null, errors: [`${TASTE_FILE} ${e instanceof SyntaxError ? `is not valid JSON: ${e.message}` : `cannot be read: ${e.message}`}`], missing: false };
  }
  try {
    const { value, errors } = validateTaste(raw);
    return { taste: value, errors, missing: false };
  } catch (e) {
    return { taste: null, errors: [e.message], missing: false };
  }
}

// ---------------------------------------------------------------------------------------------------
// The page side (Task 0.1's post-probe decisions): one buffer a document, written by the taste and ease init
// scripts the session hook installs in every document, drained by the lane's own run-code; the media restore;
// the pass's budget.

/** The pass's time a cycle (recording, judge, confirmation replays): past it no new screen is recorded and no new row replayed. */
export const TASTE_BUDGET_MS = 15 * 60_000;
/** Decision 10's feedback clock counts an attribute change only for these (never a `data-*` one). */
export const RENDER_ATTRIBUTES = Object.freeze(["class", "style", "hidden", "aria-hidden", "open", "disabled", "aria-expanded", "aria-selected", "aria-busy"]);
/** The most events one document's buffer keeps between drains; the rest are counted as `dropped`. */
export const TASTE_EVENTS_MAX = 1000;
const str120 = (v) => typeof v === "string" && v.length <= 120;
const ms = (v) => isNum(v) && v >= 0;
const MOTION = { phase: (v) => ["run", "start", "end", "cancel", "iteration"].includes(v), name: str120, duration_ms: ms, delay_ms: ms, easing: str120, target: str120 };
/**
 * Every buffered event is `{kind, t, …fields}`, `t` the document's `performance.now()` (ms): `input` a user action
 * (`type`), `change` the first rendering-relevant change after it (`cause` an added node that passes
 * `checkVisibility`, a RENDER_ATTRIBUTES `attribute` (`attr`), a `focus` move to another shown element than the
 * action's own (decision 10: a focus move is visible feedback), or a `navigation`; `attr` null otherwise), `busy` a
 * busy signal shown or gone (`on`, `signal`), and `transition` / `animation` a motion event with its timing and a
 * short target key (page text: fenced wherever printed).
 */
export const TASTE_EVENTS = deepFreeze({
  input: { type: (v) => ["click", "dblclick", "pointerdown", "keydown", "input", "submit"].includes(v) },
  change: { cause: (v) => ["added", "attribute", "focus", "navigation"].includes(v), attr: (v) => v === null || RENDER_ATTRIBUTES.includes(v) },
  busy: { on: (v) => typeof v === "boolean", signal: (v) => ["aria-busy", "progressbar", "disabled", "spinner", "skeleton"].includes(v) },
  transition: MOTION,
  animation: MOTION,
});

/** A buffered event's shape checked → the fault's words, or null. */
export function tasteEventFault(e) {
  if (!isObj(e) || !Object.hasOwn(TASTE_EVENTS, e.kind)) return "not an event of a known kind";
  if (!ms(e.t)) return "t must be the document's performance.now()";
  const fields = TASTE_EVENTS[e.kind];
  for (const k of Object.keys(e)) if (k !== "kind" && k !== "t" && !Object.hasOwn(fields, k)) return `unknown key ${shown(k)}`;
  for (const [k, ok] of Object.entries(fields)) if (!ok(e[k])) return `${e.kind}.${k} is out of shape`;
  return null;
}

/**
 * The key the taste recorders and the lane's readers share (the phase-end review's M3): every in-page source writes it
 * as this mark, and the lane puts a key in its place where a source enters a page (the CLI's init payload, a run-code
 * file: argus-live-browser.mjs writeInitPayload, argus-live-login.mjs runCode; the suite at run time). The page's own
 * scripts do not know it, so they can neither push a record nor drain the buffer.
 */
export const TASTE_KEY_MARK = "@@argus-taste-key@@";
/** `text` with the taste key in place of every TASTE_KEY_MARK. */
export const withTasteKey = (text, key) => (typeof text === "string" && text.includes(TASTE_KEY_MARK) ? text.split(TASTE_KEY_MARK).join(key) : text);
/**
 * The taste key kept in directory `runDir` (`<dir>/taste.key`, 0600, made on first use: 32 random hex digits; the lane
 * keeps one beside each slot's init payload). Every process reads the same key there; a page never does.
 */
export function tasteKey(runDir) {
  const file = path.join(runDir, "taste.key");
  try {
    const k = fs.readFileSync(file, "utf8").trim();
    if (/^[0-9a-f]{32}$/.test(k)) return k;
  } catch {
    // none yet
  }
  // No mkdir: the slot's writeSlotConfig made runDir; a call that finds it gone met a down and must fail, not
  // bring the slot's directory back.
  if (!fs.existsSync(runDir)) throw new Error(`${runDir} is gone: the slot was torn down`);
  const k = randomBytes(16).toString("hex");
  try {
    fs.writeFileSync(file, `${k}\n`, { mode: 0o600, flag: "wx" });
    return k;
  } catch {
    return fs.readFileSync(file, "utf8").trim(); // another process made it first
  }
}

/**
 * The buffer, first in the session hook's init payload, once a document: its records live in a closure, never on the
 * page. `document.__argusTastePush(record, key)` (the taste, ease and AI recorders), `__argusTasteDrain(key)` (the
 * lane's TASTE_DRAIN) and `__argusTastePeek(key)` (a probe reading the records without draining them) are fixed
 * properties a page cannot replace or delete, and each does nothing without the taste key. A record of an unknown kind
 * or without a numeric `t`, or past TASTE_EVENTS_MAX, is counted as dropped. No builtin method the page could patch is
 * called on the records.
 */
export const TASTE_BUFFER = `(() => {
  if (Object.prototype.hasOwnProperty.call(document, "__argusTastePush")) return;
  const KEY = "${TASTE_KEY_MARK}";
  const KINDS = Object.assign(Object.create(null), ${JSON.stringify(Object.fromEntries(Object.keys(TASTE_EVENTS).map((k) => [k, true])))});
  let buffer = [];
  let dropped = 0;
  const copy = (list) => { const out = []; for (let i = 0; i < list.length; i++) out[i] = list[i]; return out; };
  const fix = (name, value) => Object.defineProperty(document, name, { value, writable: false, configurable: false, enumerable: false });
  fix("__argusTastePush", (rec, key) => {
    if (key !== KEY) return;
    if (!rec || KINDS[rec.kind] !== true || typeof rec.t !== "number" || buffer.length >= ${TASTE_EVENTS_MAX}) {
      dropped += 1;
      return;
    }
    buffer[buffer.length] = rec;
  });
  fix("__argusTasteDrain", (key) => {
    if (key !== KEY) return null;
    const out = { events: buffer, dropped };
    buffer = [];
    dropped = 0;
    return out;
  });
  fix("__argusTastePeek", (key) => (key === KEY ? copy(buffer) : null));
})();
`;
/** A page expression (page.evaluate) draining the current document's buffer → `{url, timeOrigin, dropped, events}`. */
export const TASTE_DRAIN = `(() => {
  const r = typeof document.__argusTasteDrain === "function" ? document.__argusTasteDrain("${TASTE_KEY_MARK}") : null;
  return { url: location.href, timeOrigin: performance.timeOrigin, dropped: r ? r.dropped : 0, events: r ? r.events : [] };
})()`;
/** A page expression → the current document's buffered records, not drained (`[]` with none). */
export const TASTE_PEEK = `(typeof document.__argusTastePeek === "function" ? document.__argusTastePeek("${TASTE_KEY_MARK}") || [] : [])`;
/** A page expression → the media the page answers now, as explicit values `{colorScheme: light|dark, reducedMotion: reduce|no-preference}`. */
export const MEDIA_READ = `(() => ({ colorScheme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light", reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches ? "reduce" : "no-preference" }))()`;
/**
 * `m` as `page.emulateMedia`'s explicit argument. `null` hands the choice to the OS (dark on a dark-mode machine,
 * Task 0.1), so a dark or reduced-motion pass restores the values MEDIA_READ gave at its start, never null.
 */
export function explicitMedia(m) {
  if (!isObj(m) || !["light", "dark"].includes(m.colorScheme) || !["reduce", "no-preference"].includes(m.reducedMotion)) throw new Error("failed: taste: emulateMedia takes explicit values (colorScheme light|dark, reducedMotion reduce|no-preference), never null");
  return { colorScheme: m.colorScheme, reducedMotion: m.reducedMotion };
}

// ---------------------------------------------------------------------------------------------------
/**
 * aesthetics.md §7's outcome table (the one severity of the pass, the judge's ranking and filing's alike): each rule
 * whose confirmed row is S3, and why. Any other row is S4, coherence without an action consequence, unless it costs
 * `costS` seconds of klm_s a run or more. A colour role split is coherence (aesthetics.md §4): S4.
 */
export const TASTE_OUTCOME = Object.freeze({
  "colour.dark-contrast": "text under its WCAG 2.2 contrast minimum in the dark theme only (SC 1.4.3, AA)",
  "feedback.busy": "a wait over 1 s with no busy signal: the user cannot tell the action is working",
  "feedback.progress": "a wait over 10 s with no determinate progress",
  "feedback.endless": "a loader that never ends: the user waits for a result that is not coming",
  "states.error": "a failed data request leaves the screen with no way to retry or leave",
  "states.success": "a successful write the page never names: the user cannot tell it happened",
  "states.recovery": "fields lost after a rejected submit: the user types them again",
  "copy.broken": "a value rendered as broken copy where the user reads it",
  "ai.error": "an AI surface's error leaves no way on",
  "efficiency.actions": "an efficiency regression: the best known path no longer holds and this one costs 3× its actions",
  "efficiency.klm": "an efficiency regression: the best known path no longer holds and this one costs 10 s or more of klm_s",
});
/** A row's severity and why → `{severity, why}` (the cost, then TASTE_OUTCOME). */
export function tasteSeverity(r, costS = 10) {
  if (isNum(r.cost) && r.cost >= costS) return { severity: "S3", why: `it costs ${r.cost} s of klm_s a run (${costS} s or more is S3)` };
  if (Object.hasOwn(TASTE_OUTCOME, r.rule)) return { severity: "S3", why: TASTE_OUTCOME[r.rule] };
  return { severity: "S4", why: "coherence without an action consequence (aesthetics.md §7)" };
}

/**
 * A run's taste records pruned to what outlives the cycle (`down` and the reaper call it): the judge's rows, the
 * Curator's verdicts and the time spent stay (the report, `taste file --run` and the next cycle's judge read them);
 * the screenshots, held ones included, each slot's recorded screens (page text) and the Curator's brief go. Never throws.
 */
export function pruneTaste(runDir) {
  const rm = (p) => {
    try {
      fs.rmSync(p, { recursive: true, force: true });
    } catch {
      // gone, or not ours to remove
    }
  };
  for (const p of ["taste/shots", "held-shots", "taste/brief.json"]) rm(path.join(runDir, p));
  let slots = [];
  try {
    slots = fs.readdirSync(path.join(runDir, "taste"), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    slots = [];
  }
  for (const s of slots) rm(path.join(runDir, "taste", s, "screens.jsonl"));
}

// `.argus/taste-state.json` (local state, 0600): per journey, the last judge, the best known path and each confirmed row.

export const TASTE_STATE_FILE = ".argus/taste-state.json";
/** A confirmed row's states: `queued` (over the cap, ranked again next cycle), `open` (filed), `closed`, `accepted` (the owner's ruling). */
export const ROW_STATES = Object.freeze(["queued", "open", "closed", "accepted"]);
/** A screen key (decision 17): `<route template>|<viewport width>|<light|dark>`. */
export const SCREEN_KEY = /^\/[^\s|]{0,200}\|[1-9][0-9]{2,3}\|(light|dark)$/;
/**
 * An issue's title key and the state's row key (decision 19). The screen key's route comes from the page's URL: in a
 * title only a safe charset passes (letters, digits, `/ . _ - : * { } [ ] |`), anything else becomes `_`.
 */
export const titleKey = (rule, screen) => `taste:${rule}:${String(screen).replace(/[^A-Za-z0-9/._:*{}[\]|-]/g, "_")}`;
/**
 * The one screenshot a run keeps of screen key `key`: `<run>/taste/shots/<shotName(key)>.png` (0600), its scrub
 * verdict beside it as `<name>.verdict.json` — the first 32 hex digits of the key's sha256. The recorder names its
 * shots so in the page (the same digest), the session keeps only a shot of that name, scrub attaches only a file of
 * that form, and filing finds a row's shot by its screen key.
 */
export const shotName = (key) => createHash("sha256").update(String(key)).digest("hex").slice(0, 32);
const RUN_ID = /^\d{14}-[0-9a-f]{8}$/;
const SEVERITY = ["S1", "S2", "S3", "S4"];

/** The state's shape checked → the first fault's words, or null. */
function stateFault(s) {
  if (!isObj(s) || s.version !== 1 || !isObj(s.journeys) || Object.keys(s).some((k) => k !== "version" && k !== "journeys")) return "is not {version: 1, journeys}";
  for (const [id, j] of Object.entries(s.journeys)) {
    const at = `journey ${shown(id)}`;
    if (!KEBAB.test(id) || id.length > 100 || !isObj(j)) return `${at} is not a journey id holding an object`;
    if (Object.keys(j).some((k) => !["judged", "best", "rows"].includes(k))) return `${at} has an unknown key`;
    if (!(j.judged === null || RUN_ID.test(String(j.judged)))) return `${at}: judged must be a run id or null`;
    const b = j.best;
    if (!(b === null || (isObj(b) && Object.keys(b).length === 4 && RUN_ID.test(String(b.run)) && isInt(b.actions) && isNum(b.klm_s) && b.klm_s >= 0 && /^[0-9a-f]{64}$/.test(String(b.pathSha))))) return `${at}: best must be {run, actions, klm_s, pathSha} or null`;
    if (!isObj(j.rows)) return `${at}: rows must be an object`;
    for (const [key, r] of Object.entries(j.rows)) {
      const ok =
        isObj(r) &&
        Object.keys(r).length === 8 &&
        typeof r.rule === "string" &&
        RULE_ID.test(r.rule) &&
        typeof r.screen === "string" &&
        SCREEN_KEY.test(r.screen) &&
        key === titleKey(r.rule, r.screen) &&
        RULE_CLASSES.includes(r.class) &&
        SEVERITY.includes(r.severity) &&
        ROW_STATES.includes(r.state) &&
        (r.issue === null || httpsUrl(r.issue)) &&
        RUN_ID.test(String(r.first)) &&
        RUN_ID.test(String(r.last));
      if (!ok) return `${at}: row ${shown(key)} is not {rule, screen, class, severity, state, issue, first, last} under its title key`;
    }
  }
  return null;
}

/** `<main>/.argus/taste-state.json` → the state (`{version: 1, journeys: {}}` when there is none); `failed: …` on any other shape, never guessed at. */
export function readTasteState(main) {
  let text;
  try {
    text = fs.readFileSync(path.join(main, TASTE_STATE_FILE), "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") return { version: 1, journeys: {} };
    throw new Error(`failed: ${TASTE_STATE_FILE} cannot be read`);
  }
  let s;
  try {
    s = JSON.parse(text);
  } catch {
    throw new Error(`failed: ${TASTE_STATE_FILE} is not valid JSON`);
  }
  const fault = stateFault(s);
  if (fault) throw new Error(`failed: ${TASTE_STATE_FILE} ${fault}`);
  return s;
}

/** Writes `state` whole (beside, then renamed into place), mode 0600, after checking its shape: `failed: …` otherwise. */
export function writeTasteState(main, state) {
  const fault = stateFault(state);
  if (fault) throw new Error(`failed: ${TASTE_STATE_FILE} ${fault}; not written`);
  const file = path.join(main, TASTE_STATE_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------------------------------------------
// The Curator's return (spec §20.4, decision 17): `<run>/taste/curator.json`, written by the agent's dispatcher, read
// by the judge (its leads), filing (its verdicts) and the report (its verdicts, substitutions and walkthrough).

/** Where the Curator's return of a run lies, relative to the run's directory. */
export const CURATOR_FILE = "taste/curator.json";
/**
 * The judge's brief for the Curator, relative to the run's directory: per screen its key, archetype, counts, rows by
 * title key and shot names, at most BRIEF_SCREEN_BYTES a screen, and the shots it reads (those of screens with rows,
 * and one a archetype for the substitution test).
 */
export const BRIEF_FILE = "taste/brief.json";
export const BRIEF_SCREEN_BYTES = 1500;
export const CURATOR_VERDICTS = Object.freeze(["confirm", "reject", "polish"]);
/** aesthetics.md §8's substitution test, one answer a screen. */
export const SUBSTITUTIONS = Object.freeze(["substitutable", "partly", "no"]);
/** A cognitive-walkthrough answer: fixed words, never free text (decision 20). */
export const CW_WORDS = Object.freeze(["pass", "fail", "n/a"]);
const CURATOR_KEYS = ["verdicts", "leads", "substitutions", "cw"];

/**
 * The Curator's return checked whole → `{value, errors}` (`value` null on any error): `{verdicts: [{title: a title key
 * (`taste:<rule>:<screen key>`, the one issue it would be), verdict: confirm|reject|polish, reason (at most 2000
 * characters)}], leads: [{rule: a screen rule of the bar, screen:
 * a screen key}], substitutions: [{screen, substitution: substitutable|partly|no}] (one a screen), cw: [{journey,
 * step: 1–100, q1, q2, q3, q4: pass|fail|n/a}]}`, every key present, none other. One verdict a title key: a title
 * names every element row of one rule on one screen, and no judge renumbers it. A verdict naming no title of the judge
 * is the reader's to drop (it knows the rows); everything else out of shape refuses the record.
 */
export function validateCurator(raw, bar = loadBar()) {
  const errors = [];
  const err = (e) => errors.length < 20 && errors.push(e);
  if (!isObj(raw)) return { value: null, errors: ["is not {verdicts, leads, substitutions, cw}"] };
  for (const k of Object.keys(raw)) if (!CURATOR_KEYS.includes(k)) err(`unknown key ${shown(k)}`);
  for (const k of CURATOR_KEYS) if (!Array.isArray(raw[k])) err(`${k} must be a list`);
  if (errors.length) return { value: null, errors };
  const screenRules = new Set(bar.rules.filter((r) => FAMILIES[r.family].scope === "screen").map((r) => r.id));
  const list = (k, max, each) => {
    if (raw[k].length > max) err(`${k} holds more than ${max}`);
    raw[k].slice(0, max).forEach((x, i) => (isObj(x) ? each(x, `${k}[${i}]`) : err(`${k}[${i}] is not an object`)));
  };
  const only = (x, at, keys) => Object.keys(x).filter((k) => !keys.includes(k)).forEach((k) => err(`${at}: unknown key ${shown(k)}`));
  const rules = new Set(bar.rules.map((r) => r.id));
  const titled = new Set();
  list("verdicts", 500, (x, at) => {
    only(x, at, ["title", "verdict", "reason"]);
    const m = typeof x.title === "string" ? /^taste:([a-z]+\.[a-z0-9]+(?:-[a-z0-9]+)*):(.+)$/.exec(x.title) : null;
    if (!m || !rules.has(m[1]) || !SCREEN_KEY.test(m[2]) || titleKey(m[1], m[2]) !== x.title || !CURATOR_VERDICTS.includes(x.verdict) || typeof x.reason !== "string" || x.reason.length > 2000) err(`${at} is not {title: a title key of taste-bar ${bar.version}, verdict: confirm|reject|polish, reason}`);
    else if (titled.has(x.title)) err(`${at}: a second verdict for ${shown(x.title)}`);
    else titled.add(x.title);
  });
  list("leads", 100, (x, at) => {
    only(x, at, ["rule", "screen"]);
    if (!screenRules.has(x.rule) || typeof x.screen !== "string" || !SCREEN_KEY.test(x.screen)) err(`${at} is not {rule: a screen rule of taste-bar ${bar.version}, screen: a screen key}`);
  });
  const screens = new Set();
  list("substitutions", 200, (x, at) => {
    only(x, at, ["screen", "substitution"]);
    if (typeof x.screen !== "string" || !SCREEN_KEY.test(x.screen) || !SUBSTITUTIONS.includes(x.substitution)) err(`${at} is not {screen, substitution: substitutable|partly|no}`);
    else if (screens.has(x.screen)) err(`${at}: a second substitution for ${shown(x.screen)}`);
    else screens.add(x.screen);
  });
  list("cw", 500, (x, at) => {
    only(x, at, ["journey", "step", "q1", "q2", "q3", "q4"]);
    if (typeof x.journey !== "string" || !KEBAB.test(x.journey) || !isInt(x.step, 1, 100) || !["q1", "q2", "q3", "q4"].every((q) => CW_WORDS.includes(x[q]))) err(`${at} is not {journey, step: 1-100, q1..q4: pass|fail|n/a}`);
  });
  return errors.length ? { value: null, errors } : { value: { verdicts: raw.verdicts, leads: raw.leads, substitutions: raw.substitutions, cw: raw.cw }, errors: [] };
}

/** A short value of a brief: a number, or text cut to 60 characters (page text: the Curator reads it as data). */
const short = (v) => (isNum(v) ? v : typeof v === "string" ? v.slice(0, 60) : null);

/**
 * The Curator's brief (BRIEF_FILE) of judge run `runId` (`screens` its recorded screens, `arch` each screen key's
 * archetype `{name, inferred}`, `rows` judge.json's rows): per screen key `{key, archetype, counts, titles: [{title, rule, class, rows,
 * measured, expected}], shots}` (its rows grouped by title key, at most three measured values; at most
 * BRIEF_SCREEN_BYTES a screen, measured values then titles cut to fit, `more` counting the titles left out), and `read`:
 * the shots of the screens with rows and the first shot of each other archetype, for the substitution test.
 */
export function curatorBrief(runId, bar, screens, arch, rows) {
  const entries = new Map();
  const entry = (key, s) => {
    if (!entries.has(key)) {
      const a = arch.get(s ? s.key : key) ?? arch.get(`${key.split("|").slice(0, 2).join("|")}|light`) ?? { name: "app", inferred: true };
      const t = s && isObj(s.taste) ? s.taste : {};
      const own = t.media && t.media.colorScheme === "dark" ? t.dark : t.light;
      entries.set(key, { key, archetype: `${a.name}${a.inferred ? " (inferred)" : ""}`, counts: isObj(own) && isObj(own.counts) ? own.counts : null, titles: [], shots: [] });
    }
    return entries.get(key);
  };
  for (const s of screens) {
    entry(s.key, s);
    for (const sh of Array.isArray(s.shots) ? s.shots : []) if (isObj(sh) && typeof sh.key === "string") {
      const e = entry(sh.key, sh.key === s.key ? s : null);
      if (!e.shots.includes(sh.name)) e.shots.push(sh.name);
    }
  }
  for (const r of rows) {
    const e = entry(r.screen, null);
    const title = titleKey(r.rule, r.screen);
    const t = e.titles.find((x) => x.title === title) ?? (e.titles.push({ title, rule: r.rule, class: r.class, rows: 0, measured: [], expected: short(r.expected) }), e.titles.at(-1));
    t.rows += 1;
    const m = short(r.measured);
    if (m !== null && t.measured.length < 3 && !t.measured.includes(m)) t.measured.push(m);
  }
  const fit = (e) => {
    const size = () => Buffer.byteLength(JSON.stringify(e));
    for (const t of e.titles) if (size() > BRIEF_SCREEN_BYTES) t.measured = t.measured.slice(0, 1);
    while (size() > BRIEF_SCREEN_BYTES && e.titles.length) (e.titles.pop(), (e.more = (e.more ?? 0) + 1));
    return e;
  };
  const list = [...entries.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).map(fit);
  const read = [];
  for (const e of list) if (e.titles.length || e.more) for (const n of e.shots) if (!read.includes(n)) read.push(n);
  const seen = new Set(list.filter((e) => (e.titles.length || e.more) && e.shots.length).map((e) => e.archetype));
  for (const e of list) if (!seen.has(e.archetype) && e.shots.length) (seen.add(e.archetype), read.push(e.shots[0]));
  return { version: 1, run: runId, bar: bar.version, screens: list, read };
}

/** Run directory `runDir`'s Curator return (as `taste curator` stored it) → `{value, fault}`: none → `{value: null, fault: null}`; unreadable or out of shape → the fault's words. */
export function readCuratorFile(runDir, bar = loadBar()) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(runDir, CURATOR_FILE), "utf8"));
  } catch (e) {
    if (e && e.code === "ENOENT") return { value: null, fault: null };
    return { value: null, fault: `${CURATOR_FILE} ${e instanceof SyntaxError ? "is not valid JSON" : "cannot be read"}` };
  }
  const { value, errors } = validateCurator(raw, bar);
  return value ? { value, fault: null } : { value: null, fault: `${CURATOR_FILE} ${errors[0]}` };
}
