// argus-live-smokecfg.mjs — `.argus/smoke.json` (spec §19.2), the smoke suite's configuration: its keys, defaults
// and checks, and the reader every smoke verb uses. Above -config.mjs (the repo-relative file rule and port names);
// nothing of a run.
import fs from "node:fs";
import path from "node:path";
import { PORT_NAME, repoFile } from "./argus-live-config.mjs";
import { parseTarget } from "./argus-live-targets.mjs";

const isStr = (v) => typeof v === "string" && v.trim() !== "";
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isInt = (v, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isInteger(v) && v >= min && v <= max;
const isPort = (v) => isInt(v, 1, 65535);

// Tracked like live.json; unknown keys are refused at every level, and every absent key takes its default.
export const SMOKE_FILE = ".argus/smoke.json";
export const SMOKE_KEYS = Object.freeze(["dir", "max", "pin", "exclude", "browsers", "journeys", "masks", "workers", "ci", "perf", "heal_max_steps", "form_cases_max", "link_cap"]);
/** The suite's browser projects (spec §19.6): WebKit stands in for Safari; msedge only where Edge is installed. */
export const SMOKE_BROWSERS = Object.freeze(["chromium", "firefox", "webkit", "msedge"]);
/** What `smoke run --perf` measures (spec §19.11). */
export const PERF_METRICS = Object.freeze(["lcp_ms", "inp_ms", "cls", "duration_ms", "requests", "bytes"]);
const deepFreeze = (o) => {
  for (const v of Object.values(o)) if (v && typeof v === "object") deepFreeze(v);
  return Object.freeze(o);
};
/** Every key's default (`workers` null: Playwright's own), frozen: validateSmoke hands out copies. */
export const SMOKE_DEFAULTS = deepFreeze({
  dir: "e2e/argus-smoke", max: 20, pin: [], exclude: [], browsers: [...SMOKE_BROWSERS], journeys: {}, masks: [], workers: null,
  ci: { web_server: [], ports: {}, workflow: "argus-smoke.yml", artifact: "argus-smoke-results" },
  perf: { runs: 5, thresholds: { lcp_ms: [0.2, 250], inp_ms: [0.25, 50], cls: [0.25, 0.05], duration_ms: [0.2, 500], requests: [0.2, 5], bytes: [0.2, 102400] } },
  heal_max_steps: 3, form_cases_max: 6, link_cap: 50,
});
const SMOKE_RANGES = { max: [1, 50], heal_max_steps: [1, 10], form_cases_max: [0, 50], link_cap: [0, 500], "perf.runs": [1, 20] };
/** A journey id as the catalog spells it (argus-live-map's KEBAB). */
const isJourneyId = (v) => typeof v === "string" && v.length <= 100 && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(v);
/** A check's name (`covered`, `target-size`, …) as an `allow` entry names it. */
const CHECK_NAME = /^[a-z][a-z0-9-]{0,39}$/;
/** The suite's directory: repo-relative, every segment a name, never under .git or .argus (gitignored). */
const isSuiteDir = (p) => repoFile(p) && p.split("/").every((x) => x !== "" && x !== ".") && ![".git", ".argus"].includes(p.split("/")[0].toLowerCase());
/** A mask: a Playwright locator parseTarget reads, never a snapshot ref or a bare CSS string. */
const isLocator = (v) => {
  try {
    const t = isStr(v) ? parseTarget(v) : null;
    return Boolean(t) && t.ref === undefined;
  } catch {
    return false;
  }
};
/** An http(s) URL whose host is loopback by its spelling: CI resolves no name for the suite (spec §19.5). */
const loopbackUrl = (raw) => {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  return (u.protocol === "http:" || u.protocol === "https:") && (u.hostname === "localhost" || u.hostname === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(u.hostname));
};

/** `.argus/smoke.json`'s content checked → `{value, errors}`: `value` with every default filled in (null on any error). */
export function validateSmoke(raw) {
  if (!isObj(raw)) return { value: null, errors: [`${SMOKE_FILE} must be a JSON object`] };
  const errs = [];
  const need = (cond, msg) => cond || errs.push(msg);
  const unknown = (obj, where, allowed) => {
    for (const k of Object.keys(obj)) if (!allowed.includes(k)) errs.push(`${where}: unknown key "${k}"`);
  };
  const int = (v, k) => need(isInt(v, ...SMOKE_RANGES[k]), `${k} must be an integer from ${SMOKE_RANGES[k][0]} to ${SMOKE_RANGES[k][1]}`);
  const browsers = (v, where) => need(Array.isArray(v) && v.length > 0 && v.every((b) => SMOKE_BROWSERS.includes(b)) && new Set(v).size === v.length, `${where} must be a non-empty array of distinct names from ${SMOKE_BROWSERS.join(", ")}`);
  const masks = (v, where) => {
    if (need(Array.isArray(v), `${where} must be an array of Playwright locators`) === true) v.forEach((m, i) => need(isLocator(m), `${where}[${i}] must be a Playwright locator such as getByTestId('clock')`));
  };
  const shown = (v) => (typeof v === "string" && /^[\x21-\x7e]{1,200}$/.test(v) ? v : "(not shown)");
  const has = (k) => k in raw;

  unknown(raw, SMOKE_FILE, SMOKE_KEYS);
  if (has("dir")) need(isSuiteDir(raw.dir), "dir must be a repo-relative directory (no absolute path, no . or .., no leading - or :, not under .git or .argus)");
  for (const k of ["max", "heal_max_steps", "form_cases_max", "link_cap"]) if (has(k)) int(raw[k], k);
  for (const k of ["pin", "exclude"]) if (has(k)) need(Array.isArray(raw[k]) && raw[k].every(isJourneyId) && new Set(raw[k]).size === raw[k].length, `${k} must be an array of distinct journey ids (kebab-case)`);
  // A pin of an id the catalog lacks is kept: smoke plan refuses it against the catalog it reads.
  if (Array.isArray(raw.pin) && Array.isArray(raw.exclude)) for (const id of raw.pin.filter((x) => isJourneyId(x) && raw.exclude.includes(x))) errs.push(`pin and exclude both name ${id}`);
  if (has("browsers")) browsers(raw.browsers, "browsers");
  if (has("masks")) masks(raw.masks, "masks");
  if (has("workers")) need(isInt(raw.workers, 1, 64) || (typeof raw.workers === "string" && /^([1-9][0-9]?|100)%$/.test(raw.workers)), 'workers must be an integer from 1 to 64 or a percentage such as "50%"');
  if (has("journeys") && need(isObj(raw.journeys), "journeys must be an object") === true) {
    for (const [id, j] of Object.entries(raw.journeys)) {
      const where = `journeys.${id}`;
      if (!isJourneyId(id)) {
        errs.push(`journeys: ${shown(id)} is not a journey id (kebab-case)`);
        continue;
      }
      if (need(isObj(j), `${where} must be an object`) !== true) continue;
      unknown(j, where, ["browsers", "masks", "screens", "allow"]);
      if ("browsers" in j) browsers(j.browsers, `${where}.browsers`);
      if ("masks" in j) masks(j.masks, `${where}.masks`);
      if ("screens" in j) need(Array.isArray(j.screens) && j.screens.every((n) => isInt(n, 1, 500)) && new Set(j.screens).size === j.screens.length, `${where}.screens must be an array of distinct step numbers from 1 to 500`);
      if ("allow" in j && need(Array.isArray(j.allow), `${where}.allow must be an array of {check, key}`) === true) {
        j.allow.forEach((a, i) => {
          const at = `${where}.allow[${i}]`;
          if (isObj(a)) unknown(a, at, ["check", "key"]);
          need(isObj(a) && typeof a.check === "string" && CHECK_NAME.test(a.check) && isStr(a.key) && a.key.length <= 200, `${at} must be {check, key}: check a check's name, key a non-empty string of at most 200 characters`);
        });
      }
    }
  }
  if (has("ci") && need(isObj(raw.ci), "ci must be an object") === true) {
    const ci = raw.ci;
    unknown(ci, "ci", ["web_server", "ports", "workflow", "artifact"]);
    if ("web_server" in ci && need(Array.isArray(ci.web_server) && ci.web_server.length > 0, "ci.web_server must be a non-empty array of {command, url, timeout_s?}") === true) {
      ci.web_server.forEach((w, i) => {
        const at = `ci.web_server[${i}]`;
        if (need(isObj(w), `${at} must be {command, url, timeout_s?}`) !== true) return;
        unknown(w, at, ["command", "url", "timeout_s"]);
        need(isStr(w.command), `${at}.command must be a non-empty string`);
        need(loopbackUrl(w.url), `${at}.url must be an http(s) URL on a loopback host (localhost, 127.0.0.1, [::1]): ${shown(w.url)}`);
        if ("timeout_s" in w) need(isInt(w.timeout_s, 1, 3600), `${at}.timeout_s must be an integer from 1 to 3600`);
      });
    }
    if ("ports" in ci) need(isObj(ci.ports) && Object.entries(ci.ports).every(([n, p]) => PORT_NAME.test(n) && isPort(p)), `ci.ports must map port names (${PORT_NAME.source.slice(1, -1)}) to ports 1-65535`);
    if ("workflow" in ci) need(typeof ci.workflow === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.ya?ml$/.test(ci.workflow), "ci.workflow must be a file name ending .yml or .yaml");
    if ("artifact" in ci) need(typeof ci.artifact === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(ci.artifact), "ci.artifact must be a name of letters, digits, ., _ and - (at most 100)");
  }
  if (has("perf") && need(isObj(raw.perf), "perf must be an object") === true) {
    unknown(raw.perf, "perf", ["runs", "thresholds"]);
    if ("runs" in raw.perf) int(raw.perf.runs, "perf.runs");
    if ("thresholds" in raw.perf && need(isObj(raw.perf.thresholds), "perf.thresholds must be an object") === true) {
      unknown(raw.perf.thresholds, "perf.thresholds", PERF_METRICS);
      for (const [m, t] of Object.entries(raw.perf.thresholds)) {
        if (PERF_METRICS.includes(m)) need(Array.isArray(t) && t.length === 2 && t.every((x) => typeof x === "number" && Number.isFinite(x) && x >= 0) && t[0] <= 10, `perf.thresholds.${m} must be [<relative 0-10>, <absolute >= 0>]`);
      }
    }
  }
  if (errs.length) return { value: null, errors: errs };
  const d = structuredClone(SMOKE_DEFAULTS);
  const r = structuredClone(raw);
  return { value: { ...d, ...r, ci: { ...d.ci, ...r.ci }, perf: { ...d.perf, ...r.perf, thresholds: { ...d.perf.thresholds, ...r.perf?.thresholds } } }, errors: [] };
}

/** `{smoke, errors, missing}` from `<main>/.argus/smoke.json`: `missing` when there is none (no suite yet). Never throws. */
export function loadSmoke(main) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(main, SMOKE_FILE), "utf8"));
  } catch (e) {
    if (e && e.code === "ENOENT") return { smoke: null, errors: [], missing: true };
    return { smoke: null, errors: [`${SMOKE_FILE} ${e instanceof SyntaxError ? `is not valid JSON: ${e.message}` : `cannot be read: ${e.message}`}`], missing: false };
  }
  const { value, errors } = validateSmoke(raw);
  return { smoke: value, errors, missing: false };
}
