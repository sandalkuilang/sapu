// argus-live-suite.mjs — the smoke suite's membership (spec §19.3–§19.5): `smoke plan` ranks the catalog into
// the suite's members, `smoke admit` stages a path that held twice, fresh then dirty, and `smoke check`
// regenerates the suite in memory and names every file that differs. check writes nothing (the guard lets a
// subagent run it); every change to the committed suite goes through a proposal.
import { createHash, randomInt } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { generateSuite, headerDigest, SMOKE_PLAYWRIGHT } from "./argus-live-codegen.mjs";
import { expandConfig, LIVE_FILE, loadLive, validateLive } from "./argus-live-config.mjs";
import { loadSmoke, SMOKE_DEFAULTS } from "./argus-live-smokecfg.mjs";
import { secretHits } from "./argus-live-ledger.mjs";
import { lastRun, liveDir, readLock, RUN_ID } from "./argus-live-lock.mjs";
import { readJourneys, score } from "./argus-live-map.mjs";
import { run, tempBeside } from "./argus-live-proc.mjs";
import { runOnce } from "./argus-live-repro.mjs";
import { readRun } from "./argus-live-run.mjs";
import { scrubSecrets } from "./argus-live-scrub.mjs";
import { quarantineIds, readPass, readSuitePaths, seededOrder, smokeEvent } from "./argus-live-smoke.mjs";
import { parseRepro, suiteAccounts } from "./argus-live-steps.mjs";
import { loadContract } from "./sapu-contract.mjs";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const JOURNEY = /^[a-z0-9][a-z0-9-]{0,63}$/;
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
/** The lane's local smoke state (spec §19.2): gitignored, never committed (readState). */
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

/** The newest verdict of each path in the lane's last pass (`<run>/smoke/pass.jsonl` of lastRun) → Map id → record. */
function lastPass(main) {
  return new Map(readPass(main, lastRun(main)).records.map((r) => [r.id, r]));
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
 * `state` is the smoke state to read (settled by smokePlan; else the file's).
 * The catalog's journeys but global ones are ranked: pinned (in pin's order), money, exposure (SELECT's,
 * score with no visit or commit: money doubles it), suite members before non-members of that tier, filed
 * findings, distinct roles, id. Excluded and retired journeys leave the ranking; the first `max` of the rest
 * are the target set. One line each, the target set's in rank order, then the drops.
 */
export function planOf(main, { runner = run, gh = "gh", state: given = null } = {}) {
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
  const state = given ?? readState(main);
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
      const mark = members.has(id) && isObj(state.journeys[id]) && isObj(state.journeys[id].regression) ? state.journeys[id].regression : null;
      const line = pending.byId.has(id)
        ? `pending ${id} ${pending.byId.get(id)}`
        : mark && typeof mark.url === "string" && PR_URL.test(mark.url)
          ? `pending-regression ${id} ${PR_URL.exec(mark.url)[0]}`
          : quarantined.has(id) && members.has(id)
          ? `quarantined ${id}`
          : members.has(id) && last && last.verdict === "broke" && /^target-/.test(String(last.kind))
            ? `heal ${id}`
            : members.has(id) && last && last.verdict === "broke" && /^(action|expect)-failed$/.test(String(last.kind)) && Number.isInteger(last.step)
              ? `regression-candidate ${id} step ${last.step} ${last.kind}`
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

/**
 * `smoke plan` → `{code, lines}`: one `keep|capture|drop|heal|quarantined|pending|pending-regression` line per journey,
 * then `upgrade` when the suite's pin is behind, then the `quarantine <id>: …` lines of settleRegressions. It asks gh
 * how each open proposal ended first (refreshOutcomes), and writes the smoke state when that or settling changed it.
 */
export function smokePlan(main, { runner = run, gh = "gh" } = {}) {
  const smoke = smokeOf(main, "smoke plan");
  const state = readState(main);
  const before = JSON.stringify(state);
  refreshOutcomes(state, { runner, gh, cwd: main });
  const members = new Set(suitePaths(main, smoke.dir, "smoke plan").map((p) => p.id));
  const settled = settleRegressions(main, state, { dir: smoke.dir, members });
  const { lines } = planOf(main, { runner, gh, state });
  if (JSON.stringify(state) !== before) writeState(main, state);
  return { code: 0, lines: [...lines, ...settled.lines] };
}

// ---------------------------------------------------------------------------------------------------
// The lane's local smoke state (spec §19.2, §19.8, §19.9): gitignored, 0600, one file every smoke verb shares.
// smoke admit, smoke heal and smoke ci stage into it; smoke propose turns the staged changes into a pull request.

/** `v` as JSON with every object's keys sorted: one change, one text. */
export const canonical = (v) => JSON.stringify(v, (_k, x) => (isObj(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));

/**
 * A staged change's kinds: `add` and `heal` carry the journey's `path` (an add its `admitted` record and the map's
 * `routes` too), `drop` and `retire` remove the journey from the suite, `quarantine` carries quarantine.json's
 * entry (`quarantine`: `{id, issue, since}`), `unquarantine` removes it.
 */
export const CHANGE_KINDS = Object.freeze(["add", "heal", "drop", "retire", "quarantine", "unquarantine"]);

/** The kinds a staged drop or retire of the same journey supersedes (smoke propose skips them, stageInto removes them). */
export const SUPERSEDED = Object.freeze(["heal", "quarantine", "unquarantine"]);

/** An empty smoke state. */
const EMPTY = () => ({ version: 1, staged: [], rejected: [], journeys: {}, comments: [], proposals: {}, dispatches: [] });
const isEntry = (e) => isObj(e) && CHANGE_KINDS.includes(e.kind) && typeof e.id === "string" && JOURNEY.test(e.id) && typeof e.run === "string" && (e.changes === undefined || Array.isArray(e.changes));

/**
 * The lane's smoke state → `{version: 1, staged, rejected, journeys, comments, proposals}` (an empty one when the file
 * is missing): `staged` the changes the next proposal holds (`{kind, id, run, changes, body, path?, admitted?,
 * routes?, quarantine?, digest}`), `rejected` the digests of changes a closed proposal held, `journeys.<id>` the
 * per-journey streaks (`retire`, flakes, quarantine), `comments` the pull request comments made, `proposals` each
 * proposal by digest (`{kind, id, branch, url, outcome: open|merged|closed}`), `dispatches` each baseline job smoke
 * baseline dispatched (`{ciRun, from, branch, mode, ids}`, `ciRun` null when gh printed no run URL). A file that is not that shape is
 * refused, never overwritten: it may hold an outcome the owner gave.
 */
export function readState(main) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(main, STATE_FILE), "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") return EMPTY();
    throw new Error(`refused: ${STATE_FILE} cannot be read (${(e && e.code) || "error"})`);
  }
  let s;
  try {
    s = JSON.parse(raw);
  } catch {
    s = null;
  }
  const lists = ["staged", "rejected", "comments", "dispatches"];
  const bad = !isObj(s) || (s.version !== undefined && s.version !== 1) || (s.journeys !== undefined && !isObj(s.journeys)) || (s.proposals !== undefined && !isObj(s.proposals));
  if (bad || lists.some((k) => s[k] !== undefined && !Array.isArray(s[k])) || !(s.staged ?? []).every(isEntry)) {
    throw new Error(`refused: ${STATE_FILE} is not the smoke state (remove it to start over)`);
  }
  return { ...EMPTY(), ...s, version: 1 };
}

/** Writes the smoke state whole (0600, a temp file renamed over it): every part, proposals included, as read. */
export function writeState(main, state) {
  const file = path.join(main, STATE_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.renameSync(tempBeside(file, `${JSON.stringify(state, null, 2)}\n`, 0o600), file);
}

/**
 * A staged change's digest (spec §19.8: a rejected change is remembered by it and never proposed again): sha256 of
 * its kind, journey, changes, path and quarantined journey, never the run, the evidence, the body or a quarantine's
 * `since` and projects, so the same change
 * found again by a later run has the same digest.
 */
export function changeDigest(entry) {
  const changes = (entry.changes ?? []).map(({ run: _r, evidence: _e, ...c }) => c);
  // A quarantine is its journey's: the run that flaked (`since`) or its projects would make a rejected one new again.
  const quarantine = isObj(entry.quarantine) ? { id: entry.quarantine.id } : null;
  return createHash("sha256").update(canonical({ kind: entry.kind, id: entry.id, changes, path: entry.path ?? null, quarantine })).digest("hex");
}

/**
 * Stages `entry` (`{kind, id, run, changes: [changes.jsonl lines], body: [markdown lines], …}`) into smoke state
 * `state` (changed in place) → `{staged, digest}`. A staged entry of the same kind and journey is replaced; a digest
 * the owner rejected (a closed proposal) is never staged again (`staged: false`).
 */
export function stageInto(state, entry) {
  if (!isEntry(entry)) throw new Error("refused: a staged change is {kind, id, run, …} with a known kind");
  const digest = changeDigest(entry);
  if (state.rejected.includes(digest)) return { staged: false, digest };
  // A drop or retire removes the journey: it supersedes that journey's staged heal and quarantine changes.
  const gone = (s) => (entry.kind === "drop" || entry.kind === "retire") && s.id === entry.id && SUPERSEDED.includes(s.kind);
  state.staged = [...state.staged.filter((s) => !(s.kind === entry.kind && s.id === entry.id) && !gone(s)), { ...entry, digest }];
  return { staged: true, digest };
}

/** stageInto on the state file: read, staged, written. */
export function stage(main, entry) {
  const state = readState(main);
  const r = stageInto(state, entry);
  if (r.staged) writeState(main, state);
  return r;
}

/** A markdown code fence around `lines` that no backtick run inside them can close. */
export function codeBlock(lines) {
  const text = lines.join("\n");
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const f = "`".repeat(Math.max(3, longest + 1));
  return [`${f}text`, ...lines, f];
}

// ---------------------------------------------------------------------------------------------------
// The owner's rulings on a proposal (spec §19.8, §19.9): merged accepts it; closed rejects it, and a closed heal
// leaves the break with the owner — pending-regression and quarantined — until a fix holds or smoke retire.

/** A pull request's URL in gh's words. */
export const PR_URL = /https:\/\/[^\s/]+\/[^\s/]+\/[^\s/]+\/pull\/\d+/;

/**
 * The outcome of each open proposal asked of gh (`gh pr view <url> --json state`): MERGED → merged (accepted),
 * CLOSED → closed (rejected: its digest moves into `rejected`, so no verb stages that change again). A merged
 * unquarantine ends the journey's quarantine record and counts one more exit (`exits`). A closed heal
 * marks its journey `regression: {url, run}` (the run its branch names); a closed retire clears the journey's
 * `retire`. `state` is updated in place; true when anything changed.
 */
export function refreshOutcomes(state, { runner = run, gh = "gh", cwd }) {
  const asked = new Map();
  let changed = false;
  for (const [digest, p] of Object.entries(state.proposals)) {
    if (!isObj(p) || p.outcome !== "open" || typeof p.url !== "string" || !PR_URL.test(p.url)) continue;
    if (!asked.has(p.url)) {
      const r = runner([gh, "pr", "view", p.url, "--json", "state", "--jq", ".state"], { cwd });
      asked.set(p.url, r.status === 0 ? String(r.stdout ?? "").trim() : "");
    }
    const word = asked.get(p.url);
    const outcome = word === "MERGED" ? "merged" : word === "CLOSED" ? "closed" : null;
    if (outcome) [p.outcome, changed] = [outcome, true];
    // A quarantine's exit counts once it merged: its streak ends and the journey has left quarantine once more.
    if (outcome === "merged" && p.kind === "unquarantine" && typeof p.id === "string" && JOURNEY.test(p.id)) {
      const j = isObj(state.journeys[p.id]) ? state.journeys[p.id] : {};
      state.journeys[p.id] = { ...j, quarantine: null, exits: (j.exits ?? 0) + 1 };
    }
    if (outcome !== "closed") continue;
    if (!state.rejected.includes(digest)) state.rejected.push(digest);
    if (typeof p.id !== "string" || !JOURNEY.test(p.id) || (p.kind !== "heal" && p.kind !== "retire")) continue;
    const j = { ...(isObj(state.journeys[p.id]) ? state.journeys[p.id] : {}) };
    const run = String(p.branch ?? "").replace(/^argus\/smoke-/, "");
    if (p.kind === "heal") j.regression = { url: PR_URL.exec(p.url)[0], run: RUN_ID.test(run) ? run : null };
    else delete j.retire;
    state.journeys[p.id] = j;
  }
  return changed;
}

/** The quarantine that holds journey `id`, its heal closed (`mark`), until the owner decides; `run` names it. */
function regressionQuarantine(id, mark, run) {
  const evidence = [`its heal ${mark.url} was closed unmerged: quarantined until the owner decides (a fix the lane's pass holds, or smoke retire ${id})`];
  return { kind: "quarantine", id, run, changes: [{ kind: "quarantine", id, evidence, run }], body: [`### Quarantine: ${id}`, "", ...evidence], quarantine: { id, issue: null, since: run } };
}

/**
 * The closed heals the owner has not ruled on (spec §19.9), for smoke plan and smoke ci → `{pending: [{id, url}],
 * lines}`, `state` changed in place. A suite member marked `regression` is pending until the lane's last pass holds
 * it (a fix: the mark and the quarantine staged for it go) or the owner retires it; while pending, a quarantine is
 * staged unless quarantine.json holds it or it was staged or proposed already (`quarantine <id>: …` lines). A journey
 * that left the suite loses `retire` and its mark: a retire merged, and smoke plan lists it capture again.
 */
export function settleRegressions(main, state, { dir, members }) {
  const pending = [];
  const lines = [];
  const pass = lastPass(main);
  const held = new Set(quarantineIds(main, dir));
  for (const [id, was] of Object.entries(state.journeys)) {
    if (!JOURNEY.test(id) || !isObj(was) || (was.retire === undefined && was.regression === undefined)) continue;
    const j = { ...was };
    const mark = isObj(j.regression) && typeof j.regression.url === "string" && PR_URL.test(j.regression.url) ? j.regression : null;
    const run = mark && (mark.run ?? lastRun(main));
    const entry = run ? regressionQuarantine(id, mark, run) : null;
    const digest = entry && changeDigest(entry);
    if (!members.has(id)) [j.retire, j.regression] = [undefined, undefined];
    else if (j.retire === true || !mark) j.regression = undefined;
    else if (pass.get(id)?.verdict === "held") {
      j.regression = undefined;
      state.staged = state.staged.filter((s) => s.digest !== digest);
    } else {
      pending.push({ id, url: PR_URL.exec(mark.url)[0] });
      const p = digest && state.proposals[digest];
      if (entry && !held.has(id) && !(isObj(p) && p.outcome !== "closed") && !state.staged.some((s) => s.digest === digest)) {
        const s = stageInto(state, entry);
        lines.push(s.staged ? `quarantine ${id}: staged until the owner decides (digest ${digest.slice(0, 12)})` : `quarantine ${id}: not staged (rejected before; digest ${digest.slice(0, 12)})`);
      }
    }
    state.journeys[id] = JSON.parse(JSON.stringify(j));
  }
  return { pending, lines };
}

/**
 * `smoke retire <id>` → `{code, lines}` (spec §19.9): the owner's ruling that what broke a suite journey was an
 * intended change (they closed its regression issue as not planned, or said so). A `retire` is staged in place of
 * every other change staged for it (smoke propose removes its path, spec, known violations and baselines) and the
 * journey is marked `retire`: smoke plan lists it `drop <id> (retired)` until that merges, then `capture`. The
 * owner's alone: the guard refuses it to every subagent. A retire the owner closed before is not staged again.
 */
export function smokeRetire(main, id) {
  if (typeof id !== "string" || !JOURNEY.test(id)) throw new Error("refused: smoke retire: that is not a journey id");
  const smoke = smokeOf(main, "smoke retire");
  if (!suitePaths(main, smoke.dir, "smoke retire").some((p) => p.id === id)) throw new Error(`refused: smoke retire: the suite has no path ${id}`);
  const run = lastRun(main);
  if (!run) throw new Error("refused: smoke retire: no lane run names the change (run a journey cycle first)");
  const state = readState(main);
  const evidence = ["the owner ruled the change that broke it intended"];
  const entry = { kind: "retire", id, run, changes: [{ kind: "retire", id, evidence, run }], body: [`### Retire: ${id}`, "", "The owner ruled the change that broke this journey intended: its path, spec, known violations and baselines leave the suite, and smoke plan lists it capture for a new path."] };
  const digest = changeDigest(entry);
  if (state.rejected.includes(digest)) return { code: 0, lines: [`retire ${id}: not staged (this change was rejected before; digest ${digest.slice(0, 12)})`] };
  state.staged = state.staged.filter((s) => s.id !== id);
  stageInto(state, entry);
  const { regression: _gone, ...rest } = isObj(state.journeys[id]) ? state.journeys[id] : {};
  state.journeys[id] = { ...rest, retire: true };
  writeState(main, state);
  return { code: 0, lines: [`retire ${id}: staged (digest ${digest.slice(0, 12)}); smoke propose removes it from the suite, then smoke plan lists it capture`] };
}

// ---------------------------------------------------------------------------------------------------
// smoke admit (spec §19.4).

const ADMIT_REF = /^([1-9][0-9]?)\.([1-9])$/;
/** A path run's verdict line (runOnce in path mode). */
const BROKE = /^PATH broke step=(\d+) kind=(target-missing|target-ambiguous|expect-failed|action-failed)$/;

/**
 * `list` with each account the slot allocated (`slotAccounts`, `{"<role>.<k>": user | null}`) written as the
 * suite's account of the same user (`suite`, suiteAccounts): a users role's `<role>.<k>` by its user, anon and
 * a login-command role as `.1`. A bare role word is that role's `.1` of the slot.
 */
function renumber(list, slotAccounts, suite, id) {
  const to = {};
  for (const [a, user] of Object.entries(slotAccounts ?? {})) {
    const role = a.split(".")[0];
    const k = Object.keys(suite).find((s) => s.split(".")[0] === role && (user === null ? s === `${role}.1` : suite[s] === user));
    if (!k) throw new Error(`refused: admit ${id}: ${a}'s user is not one of live.json's ${role} accounts`);
    to[a] = k;
  }
  const step = (el) => {
    if (!isObj(el) || typeof el.as !== "string" || el.as === "system") return el;
    const a = el.as.includes(".") ? el.as : `${el.as}.1`;
    return Object.hasOwn(to, a) ? { ...el, as: to[a] } : el;
  };
  return list.map((el) => (isObj(el) && Array.isArray(el.parallel) ? { ...el, parallel: el.parallel.map(step) } : step(el)));
}

/** The map's routes of catalog journey `id` (`[{role, route}]`, distinct): the CTA-route check's, kept in the journey file. */
function mapRoutes(main, id) {
  const j = ((readJourneys(main) ?? {}).journeys ?? []).find((x) => isObj(x) && x.id === id);
  const rows = (isObj(j) && Array.isArray(j.steps) ? j.steps : []).filter((s) => isObj(s) && typeof s.role === "string" && typeof s.route === "string");
  return [...new Map(rows.map((s) => [`${s.role} ${s.route}`, { role: s.role, route: s.route }])).values()];
}

/** Every string leaf of `step` with its field's dotted name (`target.name`, `values.0`). */
function leaves(v, at = "", out = []) {
  if (typeof v === "string") out.push([at, v]);
  else if (Array.isArray(v)) v.forEach((x, i) => leaves(x, at ? `${at}.${i}` : String(i), out));
  else if (isObj(v)) for (const [k, x] of Object.entries(v)) if (k !== "as") leaves(x, at ? `${at}.${k}` : k, out);
  return out;
}

/** Where `list` holds a secret of `secrets` (scrub's matcher): `step <n> <field> <class>` each, never the value. */
function secretPlaces(list, secrets) {
  const out = [];
  let n = 0;
  for (const el of list) {
    if (isObj(el) && Object.hasOwn(el, "context")) continue;
    for (const s of isObj(el) && Array.isArray(el.parallel) ? el.parallel : [el]) {
      n += 1;
      for (const [field, v] of leaves(s)) for (const h of secretHits(v, secrets)) out.push(`step ${n} ${/^[A-Za-z0-9_.]{1,60}$/.test(field) ? field : "a field"} ${h.cls}`);
    }
  }
  return [...new Set(out)];
}

/** `list` with its context's viewport set to `width` (a context added when it has none). */
const atWidth = (list, width) => (isObj(list[0]) && Object.hasOwn(list[0], "context") ? [{ context: { ...list[0].context, viewport: width } }, ...list.slice(1)] : [{ context: { viewport: width } }, ...list]);

/**
 * The widths a suite path runs at (the generated config's projects): live.json's first viewport (every engine's), then
 * each further one smoke.json's `journeys.<id>.viewports` does not leave out.
 */
function widthsOf(live, smoke, id) {
  const all = [...new Set(Array.isArray(live.viewports) && live.viewports.length ? live.viewports : [1440])];
  const own = smoke.journeys && smoke.journeys[id] && smoke.journeys[id].viewports;
  return [all[0], ...all.slice(1).filter((w) => !own || own.includes(w))];
}

/**
 * `smoke admit <slot>.<generation>` → `{code, lines}` (spec §19.4): the path slot `<slot>`'s return of that
 * generation holds, for a journey `smoke plan` lists as `capture`, renumbered to the suite's accounts and
 * parsed in path mode, checked against every secret scrub knows for the run (a hit refuses by step, field and
 * class), then run as the suite will: after `up --fresh` at the first width (`fresh`), on the same instance at
 * every further width the suite runs it at (`width <w>`), then after one pass over the suite's other paths in
 * the order seed `<n>` shuffles them (printed and recorded; another path's break is smoke run's to judge) at the
 * first width again (`dirty`). Held every time → staged as an `add` with its admission record `{run, head,
 * pathSha, seed}`; a break → `refused: admit <id>: <fresh|width <w>|dirty> <kind> at step <n>`; the harness's
 * failure → exit 2, nothing staged. `once` is the one-run seam (runOnce), `runner` and `gh` smoke plan's.
 */
export async function smokeAdmit(main, ref, { once = runOnce, seed = null, runner = run, gh = "gh", env = process.env } = {}) {
  const m = ADMIT_REF.exec(String(ref));
  if (!m) throw new Error(`refused: smoke admit: ${/^[0-9.]{1,12}$/.test(String(ref)) ? ref : "that"} is not <slot>.<generation>`);
  const lock = readLock(main);
  if (!lock) throw new Error("refused: no journey cycle is running");
  const rec = readRun(main);
  if (!rec || rec.runId !== lock.runId || !rec.instanceId) throw new Error(`refused: cycle ${lock.runId} has no instance (its up did not finish)`);
  const [slot, generation] = [m[1], m[2]];
  let ret = null;
  try {
    ret = JSON.parse(fs.readFileSync(path.join(liveDir(main), lock.runId, "returns", `${slot}.${generation}.json`), "utf8"));
  } catch {
    throw new Error(`refused: smoke admit: slot ${slot} generation ${generation} has not submitted`);
  }
  const slotRec = rec.slots && rec.slots[slot];
  if (!isObj(ret) || !Array.isArray(ret.path) || !slotRec) throw new Error(`refused: smoke admit: slot ${slot} generation ${generation} returned no path`);
  const id = ret.journey;
  if (typeof id !== "string" || !JOURNEY.test(id)) throw new Error(`refused: smoke admit: slot ${slot} generation ${generation} names no journey`);
  const entry = planOf(main, { runner, gh }).entries.find((e) => e.id === id);
  if (!entry) throw new Error(`refused: admit ${id}: smoke plan does not list it`);
  if (entry.line !== `capture ${id}`) throw new Error(`refused: admit ${id}: smoke plan lists it as ${entry.line.replace(` ${id}`, "").replace(/ https:\S+$/, "")}, not capture`);
  const { config, errors, secrets: envFile } = loadLive(main);
  if (!config || errors.length) throw new Error(`refused: .argus/live.json: ${errors.join("; ")}`);
  const live = expandConfig(config, { ports: { ...(rec.ports ?? {}) }, secrets: envFile });
  const list = renumber(ret.path, slotRec.accounts, suiteAccounts(live), id);
  try {
    parseRepro(list, { accounts: suiteAccounts(live), live, path: true });
  } catch (e) {
    if (!/^refused: /.test(e.message)) throw e;
    throw new Error(`refused: admit ${id}: ${e.message.replace(/^refused: repro: /, "")}`);
  }
  const { secrets, refusal } = scrubSecrets(main, { runId: lock.runId, env });
  if (refusal) throw new Error(`refused: admit ${id}: its values cannot be checked (${refusal.replace(/^refused: scrub: /, "")})`);
  const places = secretPlaces(list, secrets);
  if (places.length) throw new Error(`refused: admit ${id}: a secret in its values: ${places.join("; ")}`);
  const used = seed ?? randomInt(0, 4294967296);
  const lines = [`seed: ${used}`];
  const smoke = smokeOf(main, "smoke admit");
  const widths = widthsOf(live, smoke, id);
  const others = [];
  for (const p of readSuitePaths(main, smoke.dir).filter((x) => x.id !== id)) {
    try {
      parseRepro(p.path, { accounts: suiteAccounts(live), live, path: true });
      others.push(p);
    } catch (e) {
      if (!/^refused: /.test(e.message)) throw e;
      lines.push(`admit ${id}: suite path ${p.id} skipped (its path does not parse)`);
    }
  }
  const order = seededOrder(others.map((p) => p.id), used);
  const runs = [
    { which: "fresh", path: { id, list: atWidth(list, widths[0]) }, dirty: false },
    ...widths.slice(1).map((w) => ({ which: `width ${w}`, path: { id, list: atWidth(list, w) }, dirty: true })),
    ...order.map((o) => ({ which: `suite pass, ${o}`, path: { id: o, list: others.find((p) => p.id === o).path }, dirty: true, other: true })),
    { which: "dirty", path: { id, list: atWidth(list, widths[0]) }, dirty: true },
  ];
  for (const { which, path: p, dirty, other } of runs) {
    const r = await once(main, null, { path: p, dirty });
    const b = r.code === 3 ? BROKE.exec(r.lines.at(-1) ?? "") : null;
    if (b && other) continue;
    if (b) throw new Error(`refused: admit ${id}: ${which} ${b[2]} at step ${b[1]}`);
    if (r.code !== 0) {
      const last = r.lines.at(-1) ?? "";
      return { code: 2, lines: [...lines, `admit ${id}: harness (${which}): ${last.startsWith("HARNESS: ") ? last.slice(9) : `exit ${r.code}`}`] };
    }
  }
  lines.push(`admit ${id}: widths ${widths.join(", ")}; dirty after ${order.length} suite path(s) in seed order`);
  const admitted = { run: lock.runId, head: rec.worktreeHead ?? null, pathSha: sha256(JSON.stringify(list)), seed: used };
  const routes = mapRoutes(main, id);
  const evidence = `held fresh and dirty in run ${lock.runId} (seed ${used})`;
  const body = [`### Add: ${id}`, "", `The path held twice, after up --fresh and then dirty, in run ${lock.runId} (seed ${used}).`];
  const r = stage(main, { kind: "add", id, run: lock.runId, changes: [{ kind: "add", id, evidence, run: lock.runId }], body, path: list, admitted, ...(routes.length ? { routes } : {}) });
  if (r.staged) smokeEvent(main, lock.runId, { kind: "admitted", id });
  lines.push(r.staged ? `admit ${id}: held fresh and dirty; staged for smoke propose` : `admit ${id}: held fresh and dirty; not staged (a closed proposal rejected this path; digest ${r.digest.slice(0, 12)})`);
  return { code: 0, lines };
}

// ---------------------------------------------------------------------------------------------------
// smoke check (spec §19.5), and the suite as generated from a checkout's own inputs (smoke propose's too).

/** `text`, live.json as written (its `${NAME}` references unexpanded), checked → the config; refused when it is not one. */
export function liveAsWritten(text, verb) {
  let config;
  try {
    config = JSON.parse(text);
  } catch {
    throw new Error(`refused: ${verb}: ${LIVE_FILE} is not valid JSON`);
  }
  const errors = validateLive(config);
  if (errors.length) throw new Error(`refused: ${verb}: ${LIVE_FILE}: ${errors.slice(0, 5).join("; ")}`);
  return config;
}

/**
 * The suite `root`'s inputs would generate (spec §19.5): its paths, `live` and `smoke` → `{<file>: text}`
 * (generateSuite; its fixtures.ts is the owner's, created when missing). Codegen's refusal is named for `verb`.
 */
export function generated(root, { live, smoke, verb }) {
  const paths = suitePaths(root, smoke.dir, verb);
  try {
    return generateSuite({ paths: paths.map((p) => ({ id: p.id, path: p.path, routes: p.routes })), live, smoke, quarantine: quarantineIds(root, smoke.dir) });
  } catch (e) {
    throw new Error(String(e.message).replace(/^refused: [^:]+: /, `refused: ${verb}: `));
  }
}

/**
 * live.json as it was when `file` (repo-relative) was last committed, or null (never committed, or no
 * live.json then): what a generated file that matches its own header was made from, when live.json drifted.
 */
function liveWhen(main, file, runner) {
  const sha = String(runner(["git", "-C", main, "log", "-1", "--format=%H", "--", file]).stdout ?? "").trim();
  if (!/^[0-9a-f]{40,64}$/.test(sha)) return null;
  const r = runner(["git", "-C", main, "show", `${sha}:${LIVE_FILE}`]);
  try {
    return r.status === 0 ? liveAsWritten(r.stdout, "smoke check") : null;
  } catch {
    return null;
  }
}

/**
 * `smoke check` → `{code, lines}`: the suite regenerated in memory from its paths, smoke.json and live.json,
 * each generated file compared with what is there: `missing <file>`; `hand-edited <file>` (its body is not
 * what its header's digest names); `drift <file> (.argus/live.json changed since it was generated)` (the
 * live.json of the file's last commit regenerates it exactly); `stale <file> (its header's digest is of another
 * generation)`; then `orphan <file> (no journeys/<id>.json)` for a spec with no path. Exit 1 on any finding.
 * Never gated and writes nothing: a subagent may run it (the guard's LIVE_READS).
 */
export function smokeCheck(main, { runner = run } = {}) {
  const smoke = smokeOf(main, "smoke check");
  const dir = smoke.dir;
  if (!suitePaths(main, dir, "smoke check").length) return { code: 0, lines: [`smoke check: no suite (${dir}/journeys holds no path)`] };
  let liveText;
  try {
    liveText = fs.readFileSync(path.join(main, LIVE_FILE), "utf8");
  } catch {
    throw new Error(`refused: smoke check: no ${LIVE_FILE}`);
  }
  const files = generated(main, { live: liveAsWritten(liveText, "smoke check"), smoke, verb: "smoke check" });
  delete files["fixtures.ts"]; // the owner's: never compared
  const lines = [];
  for (const name of Object.keys(files).sort()) {
    const rel = `${dir}/${name}`;
    let disk;
    try {
      disk = fs.readFileSync(path.join(main, dir, name), "utf8");
    } catch {
      lines.push(`missing ${rel}`);
      continue;
    }
    if (disk === files[name]) continue;
    if (!headerDigest(disk).ok) {
      lines.push(`hand-edited ${rel}`);
      continue;
    }
    const old = liveWhen(main, rel, runner);
    let then = null;
    try {
      then = old ? generated(main, { live: old, smoke, verb: "smoke check" })[name] : null;
    } catch {
      then = null;
    }
    lines.push(then === disk ? `drift ${rel} (${LIVE_FILE} changed since it was generated)` : `stale ${rel} (its header's digest is of another generation)`);
  }
  let names = [];
  try {
    names = fs.readdirSync(path.join(main, dir));
  } catch {
    names = [];
  }
  for (const f of names.filter((n) => n.endsWith(".spec.ts") && !Object.hasOwn(files, n)).sort()) lines.push(`orphan ${dir}/${f} (no journeys/${f.slice(0, -8)}.json)`);
  if (!lines.length) return { code: 0, lines: [`smoke check: ${Object.keys(files).length} generated files current`] };
  return { code: 1, lines: [...lines, `smoke check: ${lines.length} finding(s); smoke propose regenerates the suite`] };
}
