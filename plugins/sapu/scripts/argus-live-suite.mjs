// argus-live-suite.mjs — the smoke suite's membership (spec §19.3–§19.5): `smoke plan` ranks the catalog into
// the suite's members, `smoke admit` stages a path that held twice, fresh then dirty, and `smoke check`
// regenerates the suite in memory and names every file that differs. check writes nothing (the guard lets a
// subagent run it); every change to the committed suite goes through a proposal.
import fs from "node:fs";
import path from "node:path";
import { SMOKE_PLAYWRIGHT } from "./argus-live-codegen.mjs";
import { loadSmoke, SMOKE_DEFAULTS } from "./argus-live-config.mjs";
import { lastRun, liveDir } from "./argus-live-lock.mjs";
import { readJourneys, score } from "./argus-live-map.mjs";
import { run } from "./argus-live-proc.mjs";
import { readSuitePaths } from "./argus-live-smoke.mjs";
import { loadContract } from "./sapu-contract.mjs";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const JOURNEY = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** The local state the lane keeps beside the catalog (spec §19.2): gitignored, never committed. */
export const STATE_FILE = ".argus/smoke-state.json";

/** `.argus/smoke.json` as validateSmoke fills it (the defaults without one); refused when it is broken. */
export function smokeOf(main, verb) {
  const loaded = loadSmoke(main);
  if (loaded.errors.length) throw new Error(`refused: ${verb}: ${loaded.errors.join("; ")}`);
  return loaded.smoke ?? structuredClone(SMOKE_DEFAULTS);
}

/** The suite's admitted paths (readSuitePaths), its refusals named for `verb`. */
export function suitePaths(main, dir, verb) {
  try {
    return readSuitePaths(main, dir);
  } catch (e) {
    throw new Error(String(e.message).replace(/^refused: smoke run: /, `refused: ${verb}: `));
  }
}

/** `.argus/smoke-state.json` (spec §19.2) → `{journeys: {<id>: {…}}, proposals: {<digest>: {…}}}`, empty parts when absent or unreadable. */
export function readState(main) {
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(main, STATE_FILE), "utf8"));
  } catch {
    raw = null;
  }
  return { journeys: isObj(raw) && isObj(raw.journeys) ? raw.journeys : {}, proposals: isObj(raw) && isObj(raw.proposals) ? raw.proposals : {} };
}

/** The suite's `quarantine.json` (spec §19.9): `[{id, issue, since}]` → the quarantined ids; none when absent or not that shape. */
export function quarantineIds(main, dir) {
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(main, dir, "quarantine.json"), "utf8"));
  } catch {
    raw = null;
  }
  return Array.isArray(raw) ? raw.filter((q) => isObj(q) && typeof q.id === "string" && JOURNEY.test(q.id)).map((q) => q.id) : [];
}

/** The newest verdict of each path in the lane's last pass (`<run>/smoke/pass.jsonl` of lastRun) → Map id → record. */
function lastPass(main) {
  const runId = lastRun(main);
  const out = new Map();
  if (!runId) return out;
  let text = "";
  try {
    text = fs.readFileSync(path.join(liveDir(main), runId, "smoke", "pass.jsonl"), "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    try {
      const r = JSON.parse(line);
      if (isObj(r) && typeof r.id === "string") out.set(r.id, r);
    } catch {
      // a torn last line: the records before it stand
    }
  }
  return out;
}

/** `a.b.c` versions compared numerically: < 0 when `a` is older. */
const compareVersions = (a, b) => {
  const [x, y] = [a, b].map((v) => String(v).split(/[.-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};

/** The `@playwright/test` the committed suite pins (its package.json), or null without one. */
function suitePin(main, dir) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(main, dir, "package.json"), "utf8")).devDependencies["@playwright/test"];
    return typeof v === "string" && /^\d+\.\d+\.\d+([.-][0-9A-Za-z.-]+)?$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * The open pull requests of `argus/` branches → `{byId: Map id → url, note}`: each journey whose path or spec
 * such a pull request changes (`<dir>/journeys/<id>.json`, `<dir>/<id>.spec.ts`). gh failing is a note, never fatal.
 */
function pendingProposals(main, dir, { runner, gh }) {
  const c = loadContract(main);
  const repo = c.contract && typeof c.contract.repo === "string" ? ["--repo", c.contract.repo] : [];
  const r = runner([gh, "pr", "list", ...repo, "--state", "open", "--limit", "100", "--json", "url,headRefName,files"], { cwd: main });
  const byId = new Map();
  let prs = null;
  try {
    prs = r.status === 0 ? JSON.parse(String(r.stdout ?? "")) : null;
  } catch {
    prs = null;
  }
  if (!Array.isArray(prs)) return { byId, note: `note: open argus/ pull requests not checked (gh ${r.error ? "could not run" : `exited ${r.status ?? "on a signal"}`})` };
  const at = `${dir}/`;
  for (const pr of prs) {
    if (!isObj(pr) || typeof pr.headRefName !== "string" || !pr.headRefName.startsWith("argus/") || typeof pr.url !== "string" || !/^https:\/\/[^\s]+\/pull\/\d+$/.test(pr.url)) continue;
    for (const f of Array.isArray(pr.files) ? pr.files : []) {
      const p = isObj(f) && typeof f.path === "string" && f.path.startsWith(at) ? f.path.slice(at.length) : "";
      const m = /^journeys\/([a-z0-9-]+)\.json$/.exec(p) ?? /^([a-z0-9-]+)\.spec\.ts$/.exec(p);
      if (m && !byId.has(m[1])) byId.set(m[1], pr.url);
    }
  }
  return { byId, note: null };
}

/** Distinct roles a catalog journey's steps act as (`system` is none). */
const rolesOf = (j) => new Set(j.steps.map((s) => s && s.role).filter((r) => typeof r === "string" && r !== "system")).size;

/**
 * The plan (spec §19.3) → `{entries: [{id, line, target}], lines}`, `target` true for the target set's members.
 * The catalog's journeys but global ones are ranked: pinned (in pin's order), money, exposure (SELECT's,
 * score with no visit or commit: money doubles it), suite members before non-members of that tier, filed
 * findings, distinct roles, id. Excluded and retired journeys leave the ranking; the first `max` of the rest
 * are the target set. One line each, the target set's in rank order, then the drops.
 */
export function planOf(main, { runner = run, gh = "gh" } = {}) {
  const map = readJourneys(main);
  if (!map) throw new Error("refused: smoke plan: no journey catalog (.argus/journeys.json): run map-check first");
  const smoke = smokeOf(main, "smoke plan");
  const members = new Set(suitePaths(main, smoke.dir, "smoke plan").map((p) => p.id));
  const byId = new Map(map.journeys.filter((j) => isObj(j) && typeof j.id === "string").map((j) => [j.id, j]));
  const dropped = new Map((map.dropped ?? []).filter((d) => typeof d.id === "string").map((d) => [d.id, d]));
  for (const id of smoke.pin) {
    const j = byId.get(id);
    if (j && j.global) throw new Error(`refused: smoke plan: ${id} is global: a global journey is never pinned`);
    if (!j && dropped.has(id)) {
      const why = String(dropped.get(id).reason ?? "").replace(/[^\x20-\x7e]/g, "").slice(0, 120);
      throw new Error(`refused: smoke plan: ${id} is dropped from the catalog (${why}): a dropped journey is never pinned`);
    }
    if (!j) throw new Error(`refused: smoke plan: pin names ${id}, which the catalog does not hold`);
  }
  const state = readState(main);
  const retired = (id) => members.has(id) && isObj(state.journeys[id]) && state.journeys[id].retire === true;
  const pinAt = (id) => (smoke.pin.includes(id) ? smoke.pin.indexOf(id) : Infinity);
  const key = (j) => [pinAt(j.id), j.money ? 0 : 1, -score(j, { cycle: 0 }), members.has(j.id) ? 0 : 1, -(Array.isArray(j.filed) ? j.filed.length : 0), -rolesOf(j)];
  const cmp = (a, b) => {
    const [x, y] = [key(a), key(b)];
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };
  const ranked = [...byId.values()].filter((j) => !j.global).sort(cmp);
  const quarantined = new Set(quarantineIds(main, smoke.dir));
  const pass = lastPass(main);
  const pending = pendingProposals(main, smoke.dir, { runner, gh });
  const entries = [];
  const drops = [];
  let taken = 0;
  for (const j of ranked) {
    const { id } = j;
    if (smoke.exclude.includes(id)) drops.push({ id, line: `drop ${id} (excluded)` });
    else if (retired(id)) drops.push({ id, line: `drop ${id} (retired)` });
    else if (taken >= smoke.max) drops.push({ id, line: `drop ${id} (past the cap)` });
    else {
      taken += 1;
      const last = pass.get(id);
      const line = pending.byId.has(id)
        ? `pending ${id} ${pending.byId.get(id)}`
        : quarantined.has(id) && members.has(id)
          ? `quarantined ${id}`
          : members.has(id) && last && last.verdict === "broke" && /^target-/.test(String(last.kind))
            ? `heal ${id}`
            : members.has(id)
              ? `keep ${id}`
              : `capture ${id}`;
      entries.push({ id, line, target: true });
    }
  }
  for (const j of byId.values()) if (j.global) drops.push({ id: j.id, line: `drop ${j.id} (global)` });
  for (const id of [...members].filter((m) => !byId.has(m)).sort()) drops.push({ id, line: `drop ${id} (out of the map)` });
  entries.push(...drops.map((d) => ({ ...d, target: false })));
  const lines = entries.map((e) => e.line);
  const pin = suitePin(main, smoke.dir);
  if (pin && compareVersions(pin, SMOKE_PLAYWRIGHT) < 0) lines.push(`upgrade ${pin} → ${SMOKE_PLAYWRIGHT} (baseline run needed)`);
  if (pending.note) lines.push(pending.note);
  return { entries, lines, smoke };
}

/** `smoke plan` → `{code, lines}`: one `keep|capture|drop|heal|quarantined|pending` line per journey, then `upgrade` when the suite's pin is behind. */
export function smokePlan(main, opts = {}) {
  return { code: 0, lines: planOf(main, opts).lines };
}

/** `smoke admit <slot>.<generation>` → `{code, lines}`: the return's path run twice, staged when it held both times. */
export function smokeAdmit(main, ref) {
  throw new Error("refused: smoke admit: not built yet");
}

/** `smoke check` → `{code, lines}`: every hand-edited or stale file of the suite named; writes nothing. */
export function smokeCheck(main) {
  throw new Error("refused: smoke check: not built yet");
}
