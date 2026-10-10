// argus-live-return.mjs — the explorer's return (spec §7 "Return"): `pw <token> submit <json>` validates
// it against the schema, caps every free-text field, writes it per generation and retires the token;
// `argus-live.mjs intake <slot>` prints it for the orchestrator — a summary built from enums and counts
// only, then each generation whole inside a fresh `<<<RETURN-<nonce>` fence, as data. A map slot's return is
// the journey map (validateMap), which `map-check --merge` reads back (mapReturn).
import fs from "node:fs";
import path from "node:path";
import { fence } from "./argus-live-fence.mjs";
import { lastRun, liveDir, runIdOk } from "./argus-live-lock.mjs";
import { validateMap } from "./argus-live-map.mjs";
import { tempBeside } from "./argus-live-proc.mjs";
import { readRun, updateRun, worktreeHeadFile } from "./argus-live-run.mjs";
import { accountOf } from "./argus-live-slots.mjs";

/** The oracles a candidate may name and coverage may judge (spec §7, §10, §19.9). */
export const ORACLES = ["handoff", "status-coherence", "dead-end", "reversal", "orphaned-work", "claim-race", "stale-view", "unreachable-step", "re-entry", "discoverability", "interrupted-flow", "viewport-locale", "regression"];
/**
 * The oracles only the lane's own pass names (spec §19.9): a regression is decided by re-running the suite's
 * unchanged expectations, never by an explorer's word, so an explorer's return never names one.
 */
export const LANE_ORACLES = ["regression"];
const EXPLORER_ORACLES = ORACLES.filter((o) => !LANE_ORACLES.includes(o));
/** Why a heal-mode explorer found no new target (spec §19.9): no control for the step's goal, a page that blocked it, the harness. */
const HEAL_REASONS = ["no-control", "blocked", "harness"];
const UNCHECKED = "cannot be checked (.argus/live.json or .argus/smoke.json is not readable)";
const STATUSES = ["done", "handoff", "aborted"];
const VERDICTS = ["held", "failed", "not-tested", "blocked"];
/** A marker's shape (argus-live-hooks' VALUE): what a trigger or `facts` may take. */
const MARKER = /^[A-Za-z0-9][A-Za-z0-9._@:-]{0,127}$/;
/** The longest free-text string kept, and the largest return taken. */
const TEXT_CAP = 500;
const JSON_CAP = 256 * 1024;
/** How deep a repro step's objects and arrays may nest (the step itself is level 1), and the shape of its keys. */
const REPRO_DEPTH = 8;
const REPRO_KEY = /^[A-Za-z0-9_-]{1,40}$/;

/** A free-text string capped at 500 characters (`…` appended; a surrogate pair never split). */
const cap = (s) => {
  if (s.length <= TEXT_CAP) return s;
  let end = TEXT_CAP;
  if (/[\uD800-\uDBFF]/.test(s[end - 1])) end -= 1;
  return `${s.slice(0, end)}…`;
};

/** How an error shows a key the explorer wrote: quoted when it is a short plain word, else not at all. */
const word = (k) => (/^[A-Za-z0-9_-]{1,40}$/.test(k) ? `"${k}"` : "(not shown)");

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * The explorer's return `obj` checked against spec §7's schema for the slot (`journey`, `accounts` its
 * allocation, `outFiles` the names in its `out/`) → `{value, errors}`: `value` the return with every
 * free-text string capped (cap), `errors` one message per fault (unknown keys included). Spec §19.4, §19.9:
 * `path` (a smoke path, kept as written once `parsePath` takes it) and `heal` (`[{step, target}]`, at most
 * `healMax`, each target a locator `healTarget` turns into the DSL's; or `[]` with `heal_reason`) are read
 * through `checks()` (pathChecks; called only for a return holding either, null when it cannot be built).
 */
export function validateReturn(obj, { journey, accounts, outFiles, checks = null }) {
  const errors = [];
  const err = (m) => errors.push(m);
  if (!isObj(obj)) return { value: null, errors: ["the return must be a JSON object"] };
  const keys = (o, allowed, where) => {
    for (const k of Object.keys(o)) if (!allowed.includes(k)) err(`${where}: unknown key ${word(k)}`);
  };
  const text = (v, where, { optional = true } = {}) => {
    if (v === undefined && optional) return undefined;
    if (typeof v !== "string") {
      err(`${where} must be a string`);
      return undefined;
    }
    return cap(v);
  };
  const list = (v, where, max) => {
    if (v === undefined) return [];
    if (!Array.isArray(v)) {
      err(`${where} must be an array`);
      return [];
    }
    if (v.length > max) err(`${where} holds at most ${max} entries`);
    return v.slice(0, max);
  };
  const account = (w, where, { system = false } = {}) => {
    if (system && w === "system") return w;
    try {
      accountOf({ accounts }, w);
      return w;
    } catch {
      err(`${where}: ${typeof w === "string" && /^[a-z0-9._-]{1,40}$/.test(w) ? w : "that"} is not an account of this slot`);
      return w;
    }
  };
  const objects = (v, where, max, allowed, fn) =>
    list(v, where, max).map((x, i) => {
      const at = `${where}[${i}]`;
      if (!isObj(x)) {
        err(`${at} must be an object`);
        return null;
      }
      keys(x, allowed, at);
      return fn(x, at);
    });
  /**
   * A repro: at most 100 objects whose leaves are strings, numbers or booleans, nested at most REPRO_DEPTH
   * levels, their keys REPRO_KEY's shape (phase 4 validates its steps).
   */
  const leaves = (v, at, depth = 1) => {
    if (typeof v === "string") return cap(v);
    if (typeof v === "number" || typeof v === "boolean") return v;
    if ((Array.isArray(v) || isObj(v)) && depth > REPRO_DEPTH) {
      err(`${at} nests deeper than ${REPRO_DEPTH} levels`);
      return null;
    }
    if (Array.isArray(v)) return v.map((x, i) => leaves(x, `${at}[${i}]`, depth + 1));
    if (isObj(v)) {
      const entries = Object.entries(v);
      if (entries.some(([k]) => !REPRO_KEY.test(k))) {
        err(`${at} has a key that is not a short plain word (${REPRO_KEY.source})`);
        return null;
      }
      return Object.fromEntries(entries.map(([k, x]) => [k, leaves(x, `${at}.${k}`, depth + 1)]));
    }
    err(`${at} must hold only strings, numbers and booleans`);
    return null;
  };

  keys(obj, ["journey", "status", "roles", "steps", "created", "values", "candidates", "cw", "coverage", "harness_events", "next", "notes", "path", "heal", "heal_reason"], "the return");
  const v = {};
  if (obj.journey !== journey) err(`journey must be ${journey}, the slot's`);
  v.journey = journey;
  if (!STATUSES.includes(obj.status)) err(`status must be one of ${STATUSES.join(", ")}`);
  v.status = obj.status;
  v.roles = list(obj.roles, "roles", 50).map((w, i) => account(w, `roles[${i}]`));
  v.steps = objects(obj.steps, "steps", 500, ["role", "action", "locator", "saw", "off_goal"], (x, at) => {
    if (typeof x.off_goal !== "boolean" && x.off_goal !== undefined) err(`${at}.off_goal must be true or false`);
    return { role: account(x.role, `${at}.role`, { system: true }), action: text(x.action, `${at}.action`), locator: text(x.locator, `${at}.locator`), saw: text(x.saw, `${at}.saw`), off_goal: Boolean(x.off_goal) };
  });
  v.created = list(obj.created, "created", 100).map((m, i) => {
    if (typeof m !== "string" || !MARKER.test(m)) err(`created[${i}] must be a marker (${MARKER.source})`);
    return m;
  });
  v.values = objects(obj.values, "values", 200, ["marker", "field", "role", "value", "from"], (x, at) => ({
    marker: text(x.marker, `${at}.marker`),
    field: text(x.field, `${at}.field`),
    role: account(x.role, `${at}.role`),
    value: text(x.value, `${at}.value`),
    from: text(x.from, `${at}.from`),
  }));
  v.candidates = objects(obj.candidates, "candidates", 20, ["claim", "oracle", "measured", "roles", "observed", "expected", "repro", "screenshots", "h2h3"], (x, at) => {
    if (!EXPLORER_ORACLES.includes(x.oracle)) err(`${at}.oracle must be one of ${EXPLORER_ORACLES.join(", ")}`);
    const shots = list(x.screenshots, `${at}.screenshots`, 20).map((s, i) => {
      if (typeof s !== "string" || !/^[A-Za-z0-9._-]{1,200}$/.test(s) || !outFiles.includes(s)) err(`${at}.screenshots[${i}] is not a file in this slot's out/`);
      return s;
    });
    const repro = list(x.repro, `${at}.repro`, 100).map((s, i) => {
      if (!isObj(s)) err(`${at}.repro[${i}] must be an object`);
      return leaves(s, `${at}.repro[${i}]`);
    });
    return {
      claim: text(x.claim, `${at}.claim`, { optional: false }),
      oracle: x.oracle,
      measured: text(x.measured, `${at}.measured`),
      roles: list(x.roles, `${at}.roles`, 50).map((w, i) => account(w, `${at}.roles[${i}]`)),
      observed: text(x.observed, `${at}.observed`),
      expected: text(x.expected, `${at}.expected`),
      repro,
      screenshots: shots,
      h2h3: text(x.h2h3, `${at}.h2h3`),
    };
  });
  v.cw = objects(obj.cw, "cw", 100, ["step", "q1", "q2", "q3", "q4"], (x, at) => Object.fromEntries(["step", "q1", "q2", "q3", "q4"].map((k) => [k, text(x[k], `${at}.${k}`)])));
  v.coverage = {};
  if (obj.coverage !== undefined) {
    if (!isObj(obj.coverage)) err("coverage must be an object");
    else
      for (const [k, x] of Object.entries(obj.coverage)) {
        if (!EXPLORER_ORACLES.includes(k)) err(`coverage: ${word(k)} is not an oracle`);
        else if (!VERDICTS.includes(x)) err(`coverage.${k} must be one of ${VERDICTS.join(", ")}`);
        else v.coverage[k] = x;
      }
  }
  v.harness_events = list(obj.harness_events, "harness_events", 50).map((x, i) => text(x, `harness_events[${i}]`, { optional: false }));
  v.next = text(obj.next, "next");
  v.notes = text(obj.notes, "notes");
  let pc;
  const checked = () => {
    if (pc === undefined) {
      try {
        pc = checks ? checks() : null;
      } catch {
        pc = null;
      }
    }
    return pc;
  };
  if (obj.path !== undefined) {
    const before = errors.length;
    const p = list(obj.path, "path", 101).map((s, i) => {
      if (!isObj(s)) err(`path[${i}] must be an object`);
      return leaves(s, `path[${i}]`);
    });
    if (errors.length === before) {
      if (!checked()) err(`path: ${UNCHECKED}`);
      else {
        try {
          checked().parsePath(p);
          v.path = p;
        } catch (e) {
          err(`path: ${String(e.message).replace(/^refused: repro: /, "")}`);
        }
      }
    }
  }
  if (obj.heal !== undefined) {
    if (!Array.isArray(obj.heal)) err("heal must be an array");
    else if (!checked()) err(`heal: ${UNCHECKED}`);
    else {
      const { healMax, healTarget } = checked();
      if (obj.heal.length > healMax) err(`heal holds at most ${healMax} entries`);
      const steps = new Set();
      v.heal = obj.heal.slice(0, healMax).map((x, i) => {
        const at = `heal[${i}]`;
        if (!isObj(x)) {
          err(`${at} must be an object`);
          return null;
        }
        keys(x, ["step", "target"], at);
        if (!Number.isInteger(x.step) || x.step < 1 || x.step > 100) err(`${at}.step must be a step number from 1 to 100`);
        else if (steps.has(x.step)) err(`${at}.step names step ${x.step} twice`);
        steps.add(x.step);
        try {
          return { step: x.step, target: healTarget(x.target) };
        } catch (e) {
          err(`${at}.target: ${String(e.message).replace(/^refused: /, "")}`);
          return null;
        }
      });
    }
  }
  if (obj.heal_reason !== undefined) {
    if (!Array.isArray(obj.heal) || obj.heal.length) err("heal_reason goes only with heal: []");
    else if (!HEAL_REASONS.includes(obj.heal_reason)) err(`heal_reason must be one of ${HEAL_REASONS.join(", ")}`);
    else v.heal_reason = obj.heal_reason;
  } else if (Array.isArray(obj.heal) && !obj.heal.length) err(`heal: [] needs heal_reason (no-control, blocked or harness)`);
  return { value: v, errors };
}

const returnsDir = (main, runId) => path.join(liveDir(main), runId, "returns");

/** A map return (decision 20): the journey map's `journeys`, never an explorer return's `status`. */
const isMap = (r) => isObj(r) && Array.isArray(r.journeys) && !Object.hasOwn(r, "status");

/**
 * Slot `slot`'s returns in the run a reader takes (lastRun: the lock's, else the newest run directory) →
 * `{runId, dir, files}`, the files sorted by generation. Refused when there is none.
 */
function returnFiles(main, slot) {
  if (!Number.isInteger(slot) || slot < 1) throw new Error("refused: a slot is a positive integer");
  const runId = lastRun(main);
  const dir = runId ? returnsDir(main, runId) : null;
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => new RegExp(`^${slot}\\.[1-9]\\.json$`).test(f));
  } catch {
    files = [];
  }
  if (!files.length) throw new Error(`refused: slot ${slot} has not submitted`);
  return { runId, dir, files: files.sort((a, b) => Number(a.split(".")[1]) - Number(b.split(".")[1])) };
}

/**
 * The commit run `runId`'s worktree was built at: run.json `worktreeHead` while run.json names the run, else
 * the copy `down` keeps (worktreeHeadFile) → the sha, or null when the run recorded none.
 */
function worktreeHead(main, runId) {
  let rec = null;
  try {
    rec = readRun(main);
  } catch {
    rec = null;
  }
  const sha = (v) => (typeof v === "string" && /^[0-9a-f]{40,64}$/.test(v) ? v : null);
  if (rec && rec.runId === runId) return sha(rec.worktreeHead);
  try {
    return sha(JSON.parse(fs.readFileSync(worktreeHeadFile(main, runId), "utf8")).worktreeHead);
  } catch {
    return null;
  }
}

/**
 * What `map-check --merge <slot>` merges (decision 20): the newest generation of map slot `slot`'s return in
 * the run a reader takes, validated again (validateMap) → `{runId, generation, value, head}`, `head` the
 * commit the run's worktree was built at (the code the map agent read). Refused: no return, one that is not
 * a map or no longer valid, a run that recorded no worktree commit.
 */
export function mapReturn(main, slot) {
  const { runId, dir, files } = returnFiles(main, slot);
  const f = files.at(-1);
  let obj = null;
  try {
    obj = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
  } catch {
    obj = null;
  }
  if (!isMap(obj)) throw new Error(`refused: map-check --merge: slot ${slot} returned no map`);
  const { value, errors } = validateMap(obj);
  if (errors.length) throw new Error(`refused: map-check --merge: ${errors.slice(0, 5).join("; ")}`);
  const head = worktreeHead(main, runId);
  if (!head) throw new Error(`refused: map-check --merge: run ${runId} recorded no worktree commit`);
  return { runId, generation: Number(f.split(".")[1]), value, head };
}

/**
 * `pw <token> submit <json>` for slot `slot` of run `runId` (`rec` its run.json `slots` entry; the caller
 * holds the slot's lock) → the line to print: the JSON (at most 256 KB) validated (validateReturn),
 * written to `.argus/live/<run>/returns/<slot>.<generation>.json` (0600), the slot marked `submitted` and
 * its token retired → `submitted: slot <n> generation <g> status <s>` (enums only). A map slot's return is
 * the journey map, validated by validateMap → `submitted: slot <n> generation <g> map journeys <k>`. Errors →
 * `refused: return: <the first five>`, nothing written, the token still live. `checks` reaches validateReturn.
 */
export function submit(main, { runId, slot, rec }, json, { checks = null } = {}) {
  runIdOk(runId);
  if (typeof json !== "string" || Buffer.byteLength(json) > JSON_CAP) throw new Error("refused: return: the JSON must be at most 256 KB");
  let obj;
  try {
    obj = JSON.parse(json);
  } catch {
    throw new Error("refused: return: not JSON");
  }
  let outFiles = [];
  try {
    outFiles = fs.readdirSync(path.join(liveDir(main), runId, String(slot), "out"));
  } catch {
    outFiles = [];
  }
  const map = rec.mode === "map";
  const { value, errors } = map ? validateMap(obj) : validateReturn(obj, { journey: rec.journey, accounts: rec.accounts, outFiles, checks });
  if (errors.length) throw new Error(`refused: return: ${errors.slice(0, 5).join("; ")}`);
  const dir = returnsDir(main, runId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${slot}.${rec.generation}.json`);
  fs.renameSync(tempBeside(file, `${JSON.stringify(value)}\n`, 0o600), file);
  updateRun(
    main,
    runId,
    (prev) => {
      const cur = prev && prev.slots && prev.slots[String(slot)];
      if (!cur) return undefined;
      return { ...prev, slots: { ...prev.slots, [String(slot)]: { ...cur, submitted: true, tokenHash: null, retired: [...(cur.retired ?? []), ...(cur.tokenHash ? [cur.tokenHash] : [])] } } };
    },
    { create: false },
  );
  return map ? `submitted: slot ${slot} generation ${rec.generation} map journeys ${value.journeys.length}` : `submitted: slot ${slot} generation ${rec.generation} status ${value.status}`;
}

/**
 * `argus-live.mjs intake <slot>` → the lines to print: per generation, in order, a summary from enums and
 * counts only (`slot <n> generation <g> journey <id> status <s> steps <k> candidates <k> coverage
 * <oracle>=<verdict>,…`), then the whole return pretty-printed in a fresh `<<<RETURN-<nonce>` fence (its
 * marker shapes escaped, `secrets` masked); a map return's summary is `slot <n> generation <g> map journeys
 * <k> roots <k>`. No return → `refused: slot <n> has not submitted`.
 */
export function intake(main, slot, { secrets = {} } = {}) {
  const { dir, files } = returnFiles(main, slot);
  const lines = [];
  for (const f of files) {
    const g = Number(f.split(".")[1]);
    const r = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    if (isMap(r)) {
      lines.push(`slot ${slot} generation ${g} map journeys ${r.journeys.length} roots ${Array.isArray(r.roots) ? r.roots.length : 0}`);
      lines.push(fence(JSON.stringify(r, null, 2), { label: "RETURN", cap: Infinity, secrets }).body);
      continue;
    }
    const journey = /^[a-z0-9-]{1,100}$/.test(r.journey) ? r.journey : "-";
    const status = STATUSES.includes(r.status) ? r.status : "-";
    const coverage = Object.entries(isObj(r.coverage) ? r.coverage : {})
      .filter(([k, x]) => ORACLES.includes(k) && VERDICTS.includes(x))
      .map(([k, x]) => `${k}=${x}`)
      .join(",");
    lines.push(`slot ${slot} generation ${g} journey ${journey} status ${status} steps ${Array.isArray(r.steps) ? r.steps.length : 0} candidates ${Array.isArray(r.candidates) ? r.candidates.length : 0} coverage ${coverage}`);
    lines.push(fence(JSON.stringify(r, null, 2), { label: "RETURN", cap: Infinity, secrets }).body);
  }
  return lines;
}
