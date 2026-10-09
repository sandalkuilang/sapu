// argus-live-map.mjs — the journey map, `.argus/journeys.json` (spec §6): `map-check` keeps only journeys
// whose every step is anchored in HEAD's code (decision 21), names the map's refresh triggers and prints
// the catalog. It reads the configuration and git, never a run, and starts nothing. The map an explorer
// returns in map mode is checked against its schema (validateMap) and merged into the file (mergeMap). SELECT
// ranks the journeys and allocates their accounts (score, selectJourneys).
import fs from "node:fs";
import path from "node:path";
import { loadLive, ROLE_NAME } from "./argus-live-config.mjs";
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

/** Writes `.argus/journeys.json` whole (a temp file renamed over it). */
export function writeJourneys(main, map) {
  const file = path.join(main, JOURNEYS_FILE);
  fs.renameSync(tempBeside(file, `${JSON.stringify(map, null, 2)}\n`), file);
}

/** A repo-relative path that stays inside the repo (no `..`, not absolute). */
const repoPath = (p) => typeof p === "string" && p !== "" && !path.isAbsolute(p) && !p.split(/[\\/]/).includes("..");

/** A trigger's name as a map step gives it (a key of `live.triggers`). */
const TRIGGER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const MAP_KEYS = ["roots", "journeys", "notes"];
const JOURNEY_KEYS = ["id", "domain", "title", "money", "global", "goal", "steps"];
const STEP_KEYS = ["role", "route", "trigger", "goal", "claim", "sources"];
const SOURCE_KEYS = ["file", "line", "text"];

/**
 * The map an explorer returns in map mode (decision 20) → `{value, errors}`: `{roots: [≤ 100 repo-relative
 * paths], journeys: [≤ 100 {id kebab-case, domain ≤ 60, title ≤ 120, money, global, goal ≤ 500, steps: [1–40
 * {role, route? (starts /, ≤ 200), trigger?, goal ≤ 500, claim?, sources: [1–10 {file, line ≥ 1, text 16–500}]}]}],
 * notes? ≤ 2000}`; every unknown key is an error. `value` is the map as given when there is none.
 */
export function validateMap(obj) {
  const errors = [];
  const err = (m) => errors.push(m);
  if (!isObj(obj)) return { value: null, errors: ["the map must be a JSON object"] };
  const word = (k) => (/^[A-Za-z0-9_-]{1,40}$/.test(k) ? `"${k}"` : "(not shown)");
  const keys = (o, allowed, where) => {
    for (const k of Object.keys(o)) if (!allowed.includes(k)) err(`${where}: unknown key ${word(k)}`);
  };
  const str = (v, where, max, min = 1) => (typeof v === "string" && v.length >= min && v.length <= max) || err(`${where} must be a string of ${min > 1 ? `${min} to ${max}` : `at most ${max}`} characters`);
  const bool = (v, where) => typeof v === "boolean" || err(`${where} must be true or false`);
  const list = (v, where, max, min = 0) => {
    if (!Array.isArray(v)) return (err(`${where} must be an array`), []);
    if (v.length > max) err(`${where} holds at most ${max} entries`);
    else if (v.length < min) err(`${where} must hold ${min} to ${max} ${where.endsWith("sources") ? "anchors" : "entries"}`);
    return v.slice(0, max);
  };
  const objects = (v, where, max, min, allowed, fn) =>
    list(v, where, max, min).forEach((x, i) => {
      const at = `${where}[${i}]`;
      if (!isObj(x)) return err(`${at} must be an object`);
      keys(x, allowed, at);
      fn(x, at);
    });
  const file = (v, where) => repoPath(v) || err(`${where} must be a repo-relative path (no ..)`);
  keys(obj, MAP_KEYS, "the map");
  list(obj.roots, "roots", 100).forEach((r, i) => file(r, `roots[${i}]`));
  objects(obj.journeys, "journeys", 100, 0, JOURNEY_KEYS, (j, at) => {
    if (typeof j.id !== "string" || !KEBAB.test(j.id) || j.id.length > 100) err(`${at}.id must be kebab-case`);
    str(j.domain, `${at}.domain`, 60);
    str(j.title, `${at}.title`, 120);
    bool(j.money, `${at}.money`);
    bool(j.global, `${at}.global`);
    str(j.goal, `${at}.goal`, 500);
    objects(j.steps, `${at}.steps`, 40, 1, STEP_KEYS, (s, st) => {
      if (typeof s.role !== "string" || !ROLE_NAME.test(s.role) || s.role.length > 40) err(`${st}.role must be a role name`);
      if (s.route !== undefined && (typeof s.route !== "string" || !s.route.startsWith("/") || s.route.length > 200)) err(`${st}.route must start with / (at most 200 characters)`);
      if (s.trigger !== undefined && (typeof s.trigger !== "string" || !TRIGGER.test(s.trigger))) err(`${st}.trigger must be a trigger name (${TRIGGER.source})`);
      str(s.goal, `${st}.goal`, 500);
      if (s.claim !== undefined) bool(s.claim, `${st}.claim`);
      objects(s.sources, `${st}.sources`, 10, 1, SOURCE_KEYS, (a, sa) => {
        file(a.file, `${sa}.file`);
        if (!Number.isInteger(a.line) || a.line < 1) err(`${sa}.line must be a whole number from 1`);
        str(a.text, `${sa}.text`, 500, MIN_ANCHOR);
      });
    });
  });
  if (obj.notes !== undefined) str(obj.notes, "notes", 2000);
  return { value: obj, errors };
}

/** What a journey keeps from the map it was in when a returned map names its id: its coverage history (decision 22). */
const HISTORY = ["lastCycle", "lastHead", "filed"];

/**
 * `prev` (the map as it stands, or null) with the returned map `value` merged in (spec §6 "Refresh", decision
 * 20) → the new map: `head` the commit the map was built at, `roots` replaced, a journey of a known id given
 * the returned domain, title, flags, goal and steps (keeping lastCycle, lastHead and filed), a new id
 * appended (`lastCycle: null`), every other journey and `dropped` kept.
 */
export function mergeMap(prev, value, { head }) {
  const before = prev ?? { journeys: [], dropped: [] };
  const back = new Map(value.journeys.map((j) => [j.id, j]));
  const journeys = before.journeys.map((j) => {
    const r = back.get(j.id);
    if (!r) return j;
    back.delete(j.id);
    return { ...j, ...r, ...Object.fromEntries(HISTORY.filter((k) => Object.hasOwn(j, k)).map((k) => [k, j[k]])) };
  });
  for (const j of back.values()) journeys.push({ ...j, lastCycle: null });
  return { ...before, head, roots: value.roots, dropped: before.dropped ?? [], journeys };
}

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

/** How many journeys a cycle runs at once when `limits.max_parallel_journeys` is not set. */
const MAX_PARALLEL = 2;

/**
 * A journey's SELECT score (spec §6, decision 22): `cycles_since_visit × exposure × (1 + commits)`, with
 * `cycles_since_visit = cycle − lastCycle` (`cycle` when never visited) and at least 1, exposure 2 for a
 * money journey, doubled again when the momus report flagged it (`flagged`, ids), `commits` the commits
 * touching its anchor files since its last visit.
 */
export function score(j, { cycle, flagged = [], commits = 0 }) {
  const since = Math.max(1, cycle - (Number.isInteger(j.lastCycle) ? j.lastCycle : 0));
  return since * (j.money ? 2 : 1) * (flagged.includes(j.id) ? 2 : 1) * (1 + commits);
}

/** The commits touching journey `j`'s anchor files in `lastHead..HEAD` (0 without lastHead, or when git cannot tell). */
function commitsSince(main, j, runner) {
  if (typeof j.lastHead !== "string" || !/^[0-9a-f]{4,64}$/.test(j.lastHead)) return 0;
  const files = [...new Set(j.steps.flatMap((s) => (s.sources ?? []).map((a) => a.file)).filter(repoPath))];
  if (!files.length) return 0;
  const r = runner(["git", "-C", main, "rev-list", "--count", `${j.lastHead}..HEAD`, "--", ...files]);
  const n = Number(String(r.stdout ?? "").trim());
  return r.status === 0 && Number.isInteger(n) ? n : 0;
}

/**
 * `.argus/live.json`'s roles for SELECT: each users role's users, which must be literal (select prints the
 * account lists `slot` takes); refused without the file or with a `${` in a user.
 */
function selectRoles(main) {
  const { config, errors } = loadLive(main);
  if (!isObj(config)) throw new Error(`refused: ${errors[0] ?? "no .argus/live.json"}`);
  const roles = isObj(config.roles) ? config.roles : {};
  for (const [r, role] of Object.entries(roles)) {
    for (const [i, u] of (isObj(role) && Array.isArray(role.users) ? role.users : []).entries()) {
      if (isObj(u) && typeof u.user === "string" && u.user.includes("${")) throw new Error(`refused: roles.${r}.users[${i}].user must be written literally for select`);
    }
  }
  const max = config.limits && Number.isInteger(config.limits.max_parallel_journeys) ? config.limits.max_parallel_journeys : MAX_PARALLEL;
  return { roles, max };
}

/**
 * Journey `j`'s accounts from what is still free (`used`: users roles' `<role>/<user>` and login-command
 * roles' `<role>/command` taken this cycle) → `{accounts}` (`{"<role>.<k>": user | null}`, the roles in their
 * steps' order) or `{role}` the first role with no free account. First pass one account per role a step
 * names (`system` none; `anon.1` without a user; a login-command role's `.1`, once per cycle); second pass
 * a second account of a users role a `claim: true` step names, when one is free.
 */
function allocate(j, roles, used) {
  const order = [...new Set(j.steps.map((s) => s.role).filter((r) => r !== "system"))];
  const claims = new Set(j.steps.filter((s) => s.claim === true).map((s) => s.role));
  const taken = new Set();
  const per = {};
  const freeUser = (r) => (roles[r].users ?? []).map((u) => isObj(u) && u.user).find((u) => typeof u === "string" && !used.has(`${r}/${u}`) && !taken.has(`${r}/${u}`));
  for (const r of order) {
    const role = isObj(roles[r]) ? roles[r] : null;
    if (r === "anon" && role) per[r] = [null];
    else if (role && role.login) {
      if (used.has(`${r}/command`)) return { role: r };
      taken.add(`${r}/command`);
      per[r] = [null];
    } else {
      const u = role ? freeUser(r) : undefined;
      if (u === undefined) return { role: r };
      taken.add(`${r}/${u}`);
      per[r] = [u];
    }
  }
  for (const r of order) {
    if (!claims.has(r) || r === "anon" || roles[r].login) continue;
    const u = freeUser(r);
    if (u !== undefined) (taken.add(`${r}/${u}`), per[r].push(u));
  }
  for (const k of taken) used.add(k);
  const accounts = {};
  for (const r of order) per[r].forEach((u, i) => (accounts[`${r}.${i + 1}`] = u));
  return { accounts };
}

/**
 * SELECT (spec §6, decision 22): the map's journeys scored (score) and taken in rank order (score, then id),
 * or in the order of `ids` when given → `{picks: [{id, score, accounts}], waits: [{id, score, why}], displaced:
 * [{id, score}]}`. A global journey first is selected alone (the rest wait: `global journey selected alone`);
 * a later one waits (`a global journey waits for a cycle of its own`); otherwise up to
 * `limits.max_parallel_journeys` (default 2) journeys (`limit <max> reached`), each with accounts no other
 * pick holds (`no free account for <role>`). With `ids`, the picks of the score's own ranking that are not
 * picked are `displaced`. Refused: an id the map does not hold, a user not written literally.
 */
export function selectJourneys(main, { cycle, flagged = [], ids = null, runner = run }) {
  const { roles, max } = selectRoles(main);
  const map = readJourneys(main);
  const all = (map ? map.journeys : []).map((j) => ({ j, score: score(j, { cycle, flagged, commits: commitsSince(main, j, runner) }) }));
  const ranked = [...all].sort((a, b) => b.score - a.score || (a.j.id < b.j.id ? -1 : a.j.id > b.j.id ? 1 : 0));
  const pass = (list) => {
    const picks = [];
    const waits = [];
    const used = new Set();
    let alone = false;
    for (const { j, score: s } of list) {
      const wait = (why) => waits.push({ id: j.id, score: s, why });
      if (alone) wait("global journey selected alone");
      else if (j.global && picks.length) wait("a global journey waits for a cycle of its own");
      else if (picks.length >= max) wait(`limit ${max} reached`);
      else {
        const a = allocate(j, roles, used);
        if (a.role) wait(`no free account for ${a.role}`);
        else {
          picks.push({ id: j.id, score: s, accounts: a.accounts });
          alone = Boolean(j.global);
        }
      }
    }
    return { picks, waits };
  };
  if (ids === null) return { ...pass(ranked), displaced: [] };
  const chosen = ids.map((id) => {
    const x = all.find((y) => y.j.id === id);
    if (!x) throw new Error(`refused: select: no journey ${id} in ${JOURNEYS_FILE}`);
    return x;
  });
  const mine = pass(chosen);
  const picked = new Set(mine.picks.map((p) => p.id));
  return { ...mine, displaced: pass(ranked).picks.filter((p) => !picked.has(p.id)).map(({ id, score: s }) => ({ id, score: s })) };
}
