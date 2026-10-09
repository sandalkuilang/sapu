// argus-live-map.mjs — the journey map, `.argus/journeys.json` (spec §6): `map-check` keeps only journeys
// whose every step is anchored in HEAD's code (decision 21), names the map's refresh triggers and prints
// the catalog. It reads the configuration and git, never a run, and starts nothing.
import fs from "node:fs";
import path from "node:path";
import { loadLive } from "./argus-live-config.mjs";
import { run, tempBeside } from "./argus-live-proc.mjs";

export const JOURNEYS_FILE = ".argus/journeys.json";
const NOT_A_MAP = `refused: ${JOURNEYS_FILE} is not a journey map`;
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** An anchor's least number of non-space characters, and the most times it may occur in its file. */
const MIN_ANCHOR = 16;
const MAX_OCCURRENCES = 3;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** `.argus/journeys.json` as an object, or null when there is none; refused when it is not a journey map. */
export function readJourneys(main) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(main, JOURNEYS_FILE), "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") return null;
    throw new Error(NOT_A_MAP);
  }
  let map;
  try {
    map = JSON.parse(raw);
  } catch {
    throw new Error(NOT_A_MAP);
  }
  const steps = (j) => isObj(j) && Array.isArray(j.steps) && j.steps.every((s) => isObj(s) && (s.sources === undefined || (Array.isArray(s.sources) && s.sources.every(isObj))));
  const ok =
    isObj(map) &&
    Array.isArray(map.journeys) &&
    map.journeys.every(steps) &&
    (map.roots === undefined || (Array.isArray(map.roots) && map.roots.every((r) => typeof r === "string"))) &&
    (map.dropped === undefined || (Array.isArray(map.dropped) && map.dropped.every(isObj)));
  if (!ok) throw new Error(NOT_A_MAP);
  return map;
}

/** Writes the map whole (a temp file renamed over it). */
function writeJourneys(main, map) {
  const file = path.join(main, JOURNEYS_FILE);
  fs.renameSync(tempBeside(file, `${JSON.stringify(map, null, 2)}\n`), file);
}

/** A repo-relative path that stays inside the repo (no `..`, not absolute). */
const repoPath = (p) => typeof p === "string" && p !== "" && !path.isAbsolute(p) && !p.split(/[\\/]/).includes("..");

/** `p` is the root `r` or lies under it (both repo-relative). */
const under = (p, r) => {
  const root = r.replace(/\/+$/, "");
  return root !== "" && (p === root || p.startsWith(`${root}/`));
};

/** A route's last path segment that is not a parameter (`:id`, `[id]`, `{id}`, `*`), lower case; null for `/`. */
function lastSegment(route) {
  const segs = route.replace(/[?#].*$/, "").split("/").filter(Boolean);
  const named = segs.filter((s) => !/^:|^\[.*\]$|^\{.*\}$|^\*$/.test(s));
  return named.length ? named.at(-1).toLowerCase() : null;
}

/** HEAD's commit and a reader of a file's text at HEAD (null when HEAD has no such file), each file read once. */
function atHead(main, runner) {
  const r = runner(["git", "-C", main, "rev-parse", "HEAD"]);
  if (r.status !== 0) throw new Error("refused: map-check: the repo has no HEAD commit");
  const head = r.stdout.trim();
  const files = new Map();
  const text = (file) => {
    if (!files.has(file)) {
      const s = repoPath(file) ? runner(["git", "-C", main, "show", `${head}:${file}`]) : { status: 1 };
      files.set(file, s.status === 0 ? s.stdout : null);
    }
    return files.get(file);
  };
  return { head, text };
}

/** The 1-based lines `needle` starts on in `hay`, one per occurrence (two on one line count two). */
function occurrences(hay, needle) {
  const lines = [];
  for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + 1)) lines.push(hay.slice(0, at).split("\n").length);
  return lines;
}

/**
 * Why step `i` (1-based) of a journey fails map-check, or null; its anchors' `line` moved to the nearest
 * occurrence. `live` is null when there is no `.argus/live.json` (roles and triggers unchecked).
 */
function stepProblem(step, i, { text, roots, live }) {
  const sources = step.sources ?? [];
  for (const [k, s] of sources.entries()) {
    const j = k + 1;
    const t = typeof s.text === "string" ? s.text : "";
    if (t.replace(/\s/g, "").length < MIN_ANCHOR) return `step ${i}: anchor ${j} has fewer than ${MIN_ANCHOR} non-space characters`;
    const content = text(s.file);
    const at = content === null ? [] : occurrences(content, t);
    if (!at.length) return `step ${i}: anchor ${j} is not in ${s.file} at HEAD`;
    if (at.length > MAX_OCCURRENCES) return `step ${i}: anchor ${j} occurs ${at.length} times in ${s.file} (at most ${MAX_OCCURRENCES})`;
    const want = Number.isInteger(s.line) ? s.line : 1;
    s.line = at.reduce((best, l) => (Math.abs(l - want) < Math.abs(best - want) ? l : best), at[0]);
  }
  const inRoots = sources.filter((s) => roots.some((r) => under(s.file, r)));
  if (step.role === "system") {
    if (live && !Object.hasOwn(live.triggers, step.trigger)) return `step ${i}: trigger ${step.trigger ?? "(none)"} is not in live.triggers`;
    return inRoots.length ? null : `step ${i}: no anchor under roots`;
  }
  if (live && !Object.hasOwn(live.roles, step.role)) return `step ${i}: role ${step.role} is not in live.roles`;
  if (typeof step.route !== "string" || !step.route.startsWith("/")) return `step ${i}: no route`;
  const seg = lastSegment(step.route);
  if (seg === null) return inRoots.length ? null : `step ${i}: no anchor under roots`;
  const names = inRoots.some((s) => s.file.toLowerCase().includes(seg) || s.text.toLowerCase().includes(seg));
  return names ? null : `step ${i}: no anchor in a route or permission file under roots names ${seg}`;
}

/** `.argus/live.json`'s roles and triggers, or null without the file; refused when it cannot be read as JSON. */
function liveKeys(main) {
  const { config, errors } = loadLive(main);
  if (config === null) {
    if (/is missing/.test(errors[0] ?? "")) return null;
    throw new Error(`refused: ${errors[0]}`);
  }
  const keys = (v) => (isObj(v) ? v : {});
  return { roles: keys(config.roles), triggers: keys(config.triggers) };
}

/**
 * `map-check` (spec §6, decision 21) over `.argus/journeys.json` at HEAD → {kept, dropped: [{id, reason}],
 * rolesUnchecked, newDrops}. A journey with any failing step, a later duplicate id or an id that is not
 * kebab-case leaves `journeys` for `dropped` (`{id, reason, head}`, replacing an earlier entry of that id;
 * a kept journey's old entry goes); `newDrops` are the ids not already dropped at this head. The file is
 * rewritten (anchors' lines moved). No map → nothing kept, nothing written.
 */
export function mapCheck(main, { runner = run } = {}) {
  const live = liveKeys(main);
  const map = readJourneys(main);
  if (!map) return { kept: [], dropped: [], rolesUnchecked: live === null, newDrops: [] };
  const { head, text } = atHead(main, runner);
  const roots = map.roots ?? [];
  const kept = [];
  const dropped = [];
  const ids = new Set();
  for (const j of map.journeys) {
    let reason = null;
    if (typeof j.id !== "string" || !KEBAB.test(j.id)) reason = "id is not kebab-case";
    else if (ids.has(j.id)) reason = "duplicate id";
    else for (const [k, step] of j.steps.entries()) if ((reason = stepProblem(step, k + 1, { text, roots, live }))) break;
    if (typeof j.id === "string" && KEBAB.test(j.id)) ids.add(j.id);
    if (reason) dropped.push({ id: j.id, reason });
    else kept.push(j);
  }
  const before = map.dropped ?? [];
  const newDrops = dropped.filter((d) => !before.some((b) => b.id === d.id && b.head === head)).map((d) => d.id);
  const keptIds = new Set(kept.map((j) => j.id));
  const nowIds = new Set(dropped.map((d) => d.id));
  const rest = before.filter((b) => !keptIds.has(b.id) && !nowIds.has(b.id));
  writeJourneys(main, { ...map, journeys: kept, dropped: [...rest, ...dropped.map((d) => ({ ...d, head }))] });
  return { kept, dropped, rolesUnchecked: live === null, newDrops };
}

/**
 * Why the map wants a refresh (spec §6) → [] or reasons, in this order: `no map` (alone); files under
 * `roots` added, deleted or renamed since `head`; a momus report newer than `head`'s commit; `head` no
 * longer in HEAD's history; journeys `newDrops` (mapCheck's) dropped anew.
 */
export function refreshReasons(main, { newDrops = [], runner = run } = {}) {
  const map = readJourneys(main);
  if (!map) return ["no map"];
  const out = [];
  const head = typeof map.head === "string" && /^[0-9a-f]{4,64}$/.test(map.head) ? map.head : null;
  const inHistory = head !== null && runner(["git", "-C", main, "merge-base", "--is-ancestor", head, "HEAD"]).status === 0;
  if (inHistory) {
    const roots = map.roots ?? [];
    const d = runner(["git", "-C", main, "diff", "-z", "--name-status", "-M", "--diff-filter=ADR", head, "HEAD"]);
    const parts = d.status === 0 ? d.stdout.split("\0").filter(Boolean) : [];
    let changed = 0;
    for (let i = 0; i < parts.length; ) {
      const paths = parts[i].startsWith("R") ? parts.slice(i + 1, i + 3) : parts.slice(i + 1, i + 2);
      i += 1 + paths.length;
      if (paths.some((p) => roots.some((r) => under(p, r)))) changed++;
    }
    if (changed) out.push(`roots changed: ${changed} file(s) added, deleted or renamed`);
    const t = runner(["git", "-C", main, "show", "-s", "--format=%ct", head]);
    const at = Number(t.stdout?.trim());
    if (t.status === 0 && Number.isFinite(at) && newestMomus(main) > at * 1000) out.push("a momus report is newer than the map");
  }
  if (!inHistory) out.push("the map's head is no longer in the history");
  if (newDrops.length) out.push(`new drops: ${newDrops.join(",")}`);
  return out;
}

/** The newest `.momus/report-*.md`'s mtime (ms), or -Infinity without one. */
function newestMomus(main) {
  const dir = path.join(main, ".momus");
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => /^report-.*\.md$/.test(n));
  } catch {
    names = [];
  }
  return Math.max(-Infinity, ...names.map((n) => fs.statSync(path.join(dir, n)).mtimeMs));
}

/**
 * The catalog (spec §6 "Catalog output"): per domain (sorted) `<domain>:` and per journey `  <id> — <title>
 * — <role> → <role> …[ money][ global] — last cycle <n|never>, filed <k>` (the role chain with repeats in a
 * row said once), then `dropped:` and `  <id>: <reason>` per dropped journey. No map → [].
 */
export function catalog(main) {
  const map = readJourneys(main);
  if (!map) return [];
  const out = [];
  const domains = [...new Set(map.journeys.map((j) => String(j.domain ?? "(no domain)")))].sort();
  for (const d of domains) {
    out.push(`${d}:`);
    for (const j of map.journeys.filter((x) => String(x.domain ?? "(no domain)") === d)) {
      const chain = j.steps.map((s) => s.role).filter((r, i, all) => i === 0 || r !== all[i - 1]);
      const flags = `${j.money ? " money" : ""}${j.global ? " global" : ""}`;
      const last = Number.isInteger(j.lastCycle) ? j.lastCycle : "never";
      out.push(`  ${j.id} — ${j.title ?? j.id} — ${chain.join(" → ")}${flags} — last cycle ${last}, filed ${Array.isArray(j.filed) ? j.filed.length : 0}`);
    }
  }
  const dropped = map.dropped ?? [];
  if (dropped.length) out.push("dropped:", ...dropped.map((x) => `  ${x.id}: ${x.reason}`));
  return out;
}
