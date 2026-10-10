// argus-live-suite.mjs — the smoke suite's membership (spec §19.3–§19.5): `smoke plan` ranks the catalog into
// the suite's members, `smoke admit` stages a path that held twice, fresh then dirty, and `smoke check`
// regenerates the suite in memory and names every file that differs. check writes nothing (the guard lets a
// subagent run it); every change to the committed suite goes through a proposal.
import { createHash, randomInt } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SMOKE_PLAYWRIGHT } from "./argus-live-codegen.mjs";
import { expandConfig, loadLive, loadSmoke, SMOKE_DEFAULTS } from "./argus-live-config.mjs";
import { secretHits } from "./argus-live-ledger.mjs";
import { lastRun, liveDir, readLock } from "./argus-live-lock.mjs";
import { readJourneys, score } from "./argus-live-map.mjs";
import { run, tempBeside } from "./argus-live-proc.mjs";
import { runOnce } from "./argus-live-repro.mjs";
import { readRun } from "./argus-live-run.mjs";
import { scrubSecrets } from "./argus-live-scrub.mjs";
import { readSuitePaths } from "./argus-live-smoke.mjs";
import { parseRepro, suiteAccounts } from "./argus-live-steps.mjs";
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

// ---------------------------------------------------------------------------------------------------
// Staged changes (spec §19.8): what the next `smoke propose` opens as a pull request. Local, gitignored, 0600.

export const STAGED_FILE = ".argus/smoke-staged.json";
/**
 * A staged change's kinds: `add` and `heal` carry the journey file (`journey`: `{journey, path, admitted}`),
 * `drop` and `retire` remove the journey from the suite, `quarantine` carries quarantine.json's entry
 * (`quarantine`: `{id, issue, since}`), `unquarantine` removes it.
 */
export const CHANGE_KINDS = Object.freeze(["add", "heal", "drop", "retire", "quarantine", "unquarantine"]);

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/**
 * A change's digest (spec §19.8: a rejected change is remembered by it and never proposed again): its kind,
 * journey, step, old and new target and path, never its run or evidence, so the same change found again by a
 * later run has the same digest.
 */
export function changeDigest(c) {
  return sha256(JSON.stringify([c.kind, c.id, c.step ?? null, c.from ?? null, c.to ?? null, isObj(c.journey) ? (c.journey.path ?? null) : null]));
}

const isChange = (c) => isObj(c) && CHANGE_KINDS.includes(c.kind) && typeof c.id === "string" && JOURNEY.test(c.id) && typeof c.run === "string";

/** The staged changes, oldest first; none when there is no file. A file that is not `{changes: [...]}` is refused. */
export function readStaged(main) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(main, STAGED_FILE), "utf8"));
  } catch (e) {
    if (e && e.code === "ENOENT") return [];
    throw new Error(`refused: ${STAGED_FILE} is not a list of staged changes`);
  }
  if (!isObj(raw) || !Array.isArray(raw.changes) || !raw.changes.every(isChange)) throw new Error(`refused: ${STAGED_FILE} is not a list of staged changes`);
  return raw.changes;
}

/** Writes the staged changes whole (0600, a temp file renamed over it); none removes the file. */
export function writeStaged(main, changes) {
  const file = path.join(main, STAGED_FILE);
  if (!changes.length) return fs.rmSync(file, { force: true });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.renameSync(tempBeside(file, `${JSON.stringify({ changes }, null, 2)}\n`, 0o600), file);
}

/**
 * Stages `change` (`{kind, id, step?, from?, to?, evidence, run, journey?, quarantine?}`) for the next
 * proposal, replacing an earlier staged change of the same kind and journey. Lanes B's heal, quarantine and
 * drop stage through it too.
 */
export function stageChange(main, change) {
  if (!isChange(change)) throw new Error("refused: a staged change is {kind, id, run, …} with a known kind");
  writeStaged(main, [...readStaged(main).filter((c) => !(c.kind === change.kind && c.id === change.id)), change]);
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

/**
 * `smoke admit <slot>.<generation>` → `{code, lines}` (spec §19.4): the path slot `<slot>`'s return of that
 * generation holds, for a journey `smoke plan` lists as `capture`, renumbered to the suite's accounts and
 * parsed in path mode, checked against every secret scrub knows for the run (a hit refuses by step, field and
 * class), then run twice: once after `up --fresh`, once right after on the same, now dirty, instance (`seed:
 * <n>` printed and recorded). Held both times → staged as an `add` with its admission record `{run, head,
 * pathSha, seed}`; a break → `refused: admit <id>: <fresh|dirty> <kind> at step <n>`; the harness's failure →
 * exit 2, nothing staged. `once` is the one-run seam (runOnce), `runner` and `gh` smoke plan's.
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
  for (const dirty of [false, true]) {
    const r = await once(main, null, { path: { id, list }, dirty });
    const which = dirty ? "dirty" : "fresh";
    const b = r.code === 3 ? BROKE.exec(r.lines.at(-1) ?? "") : null;
    if (b) throw new Error(`refused: admit ${id}: ${which} ${b[2]} at step ${b[1]}`);
    if (r.code !== 0) {
      const last = r.lines.at(-1) ?? "";
      return { code: 2, lines: [...lines, `admit ${id}: harness (${which}): ${last.startsWith("HARNESS: ") ? last.slice(9) : `exit ${r.code}`}`] };
    }
  }
  const admitted = { run: lock.runId, head: rec.worktreeHead ?? null, pathSha: sha256(JSON.stringify(list)), seed: used };
  stageChange(main, { kind: "add", id, evidence: `held fresh and dirty in run ${lock.runId} (seed ${used})`, run: lock.runId, journey: { journey: id, path: list, admitted } });
  lines.push(`admit ${id}: held fresh and dirty; staged for smoke propose`);
  return { code: 0, lines };
}

/** `smoke check` → `{code, lines}`: every hand-edited or stale file of the suite named; writes nothing. */
export function smokeCheck(main) {
  throw new Error("refused: smoke check: not built yet");
}
