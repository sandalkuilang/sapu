// argus-live-smoke.mjs — the lane's own pass over the smoke suite's paths (spec §19.4, §19.9, §19.11):
// `smoke run` runs each path on the live instance in a seeded random order, confirms a break with a second
// run after `up --fresh`, writes a confirmed expectation break as a slot's regression candidate, and with
// `--perf` measures each path against its baseline (argus-live-perf.mjs). Above the repro runner, below the CLI.
import { randomInt } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expandConfig, loadLive, loadSmoke, SMOKE_DEFAULTS } from "./argus-live-config.mjs";
import { liveDir, readLock } from "./argus-live-lock.mjs";
import { runOnce, writePrivate } from "./argus-live-repro.mjs";
import { perfPath } from "./argus-live-perf.mjs";
import { run as runCommand } from "./argus-live-proc.mjs";
import { readRun, updateRun } from "./argus-live-run.mjs";
import { parseRepro, suiteAccounts } from "./argus-live-steps.mjs";

const JOURNEY = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** A path run's verdict line (runOnce in path mode). */
const BROKE = /^PATH broke step=(\d+) kind=(target-missing|target-ambiguous|expect-failed|action-failed)$/;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * `ids` in the order seed `seed` (an integer from 0 to 4294967295) shuffles them: Fisher–Yates driven by
 * mulberry32, so one seed always gives one order (`smoke run --seed` replays a pass). `ids` is not changed.
 */
export function seededOrder(ids, seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...ids];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * The suite's admitted paths (spec §19.2): every `<repo>/<dir>/journeys/<id>.json`, `{journey: <id>, path:
 * [...], admitted?, routes?}` → `[{id, path, admitted, routes}]` sorted by id (`routes`: the map's `{role,
 * route}` of the journey at admission, for the CTA-route check; malformed rows dropped); none when the directory is
 * missing. Refused: a file name that is not a journey id, a file that is not that object, or one naming another journey.
 */
export function readSuitePaths(main, dir) {
  const at = path.join(main, dir, "journeys");
  let names = [];
  try {
    names = fs.readdirSync(at).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return [];
  }
  return names.map((f) => {
    const id = f.slice(0, -5);
    const shown = /^[A-Za-z0-9._-]{1,80}$/.test(f) ? f : "a file";
    if (!JOURNEY.test(id)) throw new Error(`refused: smoke run: ${shown} is not named <journey id>.json`);
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(at, f), "utf8"));
    } catch {
      raw = null;
    }
    if (!isObj(raw) || !Array.isArray(raw.path)) throw new Error(`refused: smoke run: ${f} is not {"journey", "path"}`);
    if (raw.journey !== id) throw new Error(`refused: smoke run: ${f} names journey ${typeof raw.journey === "string" && JOURNEY.test(raw.journey) ? raw.journey : "another"}`);
    const routes = (Array.isArray(raw.routes) ? raw.routes : []).filter((r) => isObj(r) && typeof r.role === "string" && typeof r.route === "string" && r.route.startsWith("/") && r.route.length <= 200);
    return { id, path: raw.path, admitted: isObj(raw.admitted) ? raw.admitted : null, routes: routes.map((r) => ({ role: r.role, route: r.route })) };
  });
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

/**
 * The regression candidate's repro of path `list` broken at step `n` (spec §19.9): the parsed `context` first, then
 * the path's elements up to step `n`, that step taking `final: "regression"` (`last` in its place when given: a
 * heal's bug writes the step's old target as a `visible` expectation).
 */
export function regressionList(list, n, context, last = null) {
  const items = isObj(list[0]) && Object.hasOwn(list[0], "context") ? list.slice(1) : list;
  const out = [{ context }];
  let k = 0;
  for (const item of items) {
    const size = isObj(item) && Array.isArray(item.parallel) ? item.parallel.length : 1;
    if (k + size >= n) {
      out.push({ ...(last ?? item), final: "regression" });
      break;
    }
    out.push(item);
    k += size;
  }
  return out;
}

/**
 * Writes `repro` (regressionList: journey `id`'s confirmed break at step `n`) as a slot's return (spec §19.9): slot
 * `slot`, or the run's lowest free one when null. run.json `slots[<slot>]` `{mode: "smoke", journey, generation: 1,
 * tokenHash: null, accounts, retired: [], submitted: true}` (no token: no explorer ever holds it; `accounts` only
 * those the candidate acts as) and `returns/<slot>.1.json` (0600) holding one `regression` candidate claiming
 * `claim`, so `repro <slot>.1.1`, `--minimize`, `--test`, `classify` and `scrub` take it by its ref. → the line to
 * print. smoke run and smoke heal both write through it.
 */
export function writeRegression(main, { runId, slot = null, id, repro, n, live, accounts, claim, result = {} }) {
  const used = {};
  let steps;
  try {
    ({ steps } = parseRepro(repro, { accounts, live }));
  } catch (e) {
    if (!/^refused: /.test(e.message)) throw e;
    return `regression ${id}: step ${n} not written (${e.message.replace(/^refused: repro: /, "")})`;
  }
  for (const s of steps) if (s.as !== "system") used[s.as] = accounts[s.as];
  const entry = { mode: "smoke", journey: id, generation: 1, tokenHash: null, accounts: used, retired: [], submitted: true };
  updateRun(
    main,
    runId,
    (prev) => {
      if (!prev) return undefined;
      const taken = prev.slots ?? {};
      if (slot !== null && Object.hasOwn(taken, String(slot))) throw new Error(`refused: smoke run: slot ${slot} is minted already`);
      slot ??= Array.from({ length: 99 }, (_, i) => i + 1).find((x) => !Object.hasOwn(taken, String(x))) ?? null;
      if (slot === null) throw new Error("refused: every slot 1 to 99 is minted already");
      return { ...prev, slots: { ...taken, [String(slot)]: entry } };
    },
    { create: false },
  );
  const roles = Object.keys(used);
  const word = (v) => (typeof v === "string" && /^[a-z0-9:-]{1,40}$/.test(v) ? v : undefined);
  const candidate = {
    claim,
    oracle: "regression",
    roles,
    ...(word(result.observed) ? { observed: word(result.observed) } : {}),
    ...(word(result.expected) ? { expected: word(result.expected) } : {}),
    repro,
    screenshots: [],
  };
  const ret = { journey: id, status: "done", roles, steps: [], created: [], values: [], candidates: [candidate], cw: [], coverage: {}, harness_events: [] };
  const dir = path.join(liveDir(main), runId, "returns");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  writePrivate(path.join(dir, `${slot}.1.json`), `${JSON.stringify(ret)}\n`);
  return `regression ${id}: step ${n} written as ${slot}.1.1 (repro ${slot}.1.1)`;
}

/**
 * `smoke run [--ids <id>,…] [--slot <n>] [--perf] [--seed <n>]` → `{code, lines}`: `ids` the journeys to run
 * (null: every suite path), `slot` the slot a confirmed break is written to (null: none), `perf` whether to
 * measure, `seed` the order's seed (null: one drawn and printed).
 *
 * In a running cycle with an instance, the suite's paths (readSuitePaths under smoke.json's `dir`), each
 * parsed in path mode against the suite's accounts (suiteAccounts) first, run one at a time in the order
 * `seed` shuffles them (seededOrder; `seed: <n>` first): each once on the instance as the last left it
 * (`dirty`), and a break (exit 3) once more after `up --fresh`. Lines: `path <id>: held`, `path <id>:
 * broke step=<n> kind=<k>` (two of two), `path <id>: flaky step=<n> kind=<k>` (the fresh run held), `path
 * <id>: harness: <reason>`; with `slot`, the first `expect-failed` break also becomes that slot's return
 * (writeRegression; a locator break waits for a heal); then `smoke run: <h> held, <b> broke, <f> flaky, <x>
 * harness`. A path in the suite's quarantine.json runs twice, one after the other (`quarantined <id>: run twice`):
 * smoke ci counts its quarantine's cycle clean only when the pass held it twice. Each verdict is appended to
 * `<run>/smoke/pass.jsonl` (0600) `{id, verdict, step, kind, seed}`.
 * Exit 3 when a path broke, else 2 when one was the harness's, else 0. `once` is the one-run seam (runOnce).
 * `perf` (spec §19.11) measures instead of judging: the same paths in the same order, each run by `perfPass`
 * (`perf <id>: …` lines, `smoke run --perf: <b> baselined, <o> ok, <r> regressed, <f> flaky, <x> not measured`),
 * exit 3 when a metric regressed (both batches) or a path broke, else 2 when the harness failed, else 0. It
 * takes no `--slot`, and is refused while another slot of the run holds a token (`refused: smoke run --perf:
 * <n> other slot(s) live`): concurrent load skews every timing. Each path's verdict is appended to
 * `<run>/smoke/perf.jsonl` (0600) `{id, verdict, baseline, batches, regressed}`.
 * Refused before any run: no cycle, a slot minted already, an unknown id, no path, a path its mode refuses
 * (`refused: smoke run: <id>: step <n>: <reason>`).
 */
export async function smokeRun(main, { ids, slot, perf, seed }, { once = runOnce } = {}) {
  if (perf && slot !== null) throw new Error("refused: smoke run --perf: it writes no regression, so it takes no --slot");
  const lock = readLock(main);
  if (!lock) throw new Error("refused: no journey cycle is running");
  const rec = readRun(main);
  if (!rec || rec.runId !== lock.runId || !rec.instanceId) throw new Error(`refused: cycle ${lock.runId} has no instance (its up did not finish)`);
  const { config, errors, secrets } = loadLive(main);
  if (!config || errors.length) throw new Error(`refused: .argus/live.json: ${errors.join("; ")}`);
  const live = expandConfig(config, { ports: { ...(rec.ports ?? {}) }, secrets });
  const loaded = loadSmoke(main);
  if (loaded.errors.length) throw new Error(`refused: smoke run: ${loaded.errors.join("; ")}`);
  const smoke = loaded.smoke ?? SMOKE_DEFAULTS;
  if (slot !== null && rec.slots && Object.hasOwn(rec.slots, String(slot))) throw new Error(`refused: smoke run: slot ${slot} is minted already`);
  const others = Object.values(rec.slots ?? {}).filter((x) => x && x.tokenHash).length;
  if (perf && others) throw new Error(`refused: smoke run --perf: ${others} other slot(s) live`);
  const all = readSuitePaths(main, smoke.dir);
  for (const id of ids ?? []) if (!all.some((p) => p.id === id)) throw new Error(`refused: smoke run: the suite has no path ${id}`);
  if (!all.length) throw new Error(`refused: smoke run: the suite has no paths (${smoke.dir}/journeys)`);
  const accounts = suiteAccounts(live);
  const picked = new Map();
  for (const p of all.filter((x) => !ids || ids.includes(x.id))) {
    try {
      picked.set(p.id, { ...p, parsed: parseRepro(p.path, { accounts, live, path: true }) });
    } catch (e) {
      if (!/^refused: /.test(e.message)) throw e;
      throw new Error(`refused: smoke run: ${p.id}: ${e.message.replace(/^refused: repro: /, "")}`);
    }
  }
  const used = seed ?? randomInt(0, 4294967296);
  const lines = [`seed: ${used}`];
  if (perf) return perfPass({ main, lock, rec, smoke, picked, order: seededOrder([...picked.keys()], used), lines, once });
  const count = { held: 0, broke: 0, flaky: 0, harness: 0 };
  const records = [];
  let written = null;
  const why = (r) => {
    const last = r.lines.at(-1) ?? "";
    return last.startsWith("HARNESS: ") ? last.slice(9) : `exit ${r.code}`;
  };
  // A quarantined path runs twice a cycle: its quarantine counts a cycle clean only when the pass held it twice.
  const quarantined = new Set(quarantineIds(main, smoke.dir));
  const order = seededOrder([...picked.keys()], used).flatMap((id) => (quarantined.has(id) ? [id, id] : [id]));
  for (const id of [...picked.keys()].filter((x) => quarantined.has(x)).sort()) lines.push(`quarantined ${id}: run twice`);
  for (const id of order) {
    const p = picked.get(id);
    const run = (dirty) => once(main, null, { path: { id, list: p.path }, dirty });
    const first = await run(true);
    let verdict = "held";
    let at = null;
    let reason = null;
    let result = {};
    const broke = (r) => (r.code === 3 ? BROKE.exec(r.lines.at(-1) ?? "") : null);
    if (first.code === 3 && broke(first)) {
      const m = broke(first);
      const again = await run(false);
      const m2 = broke(again);
      if (again.code === 3 && m2) [verdict, at, result] = ["broke", { step: Number(m2[1]), kind: m2[2] }, again.result ?? {}];
      else if (again.code === 0) [verdict, at] = ["flaky", { step: Number(m[1]), kind: m[2] }];
      else [verdict, reason] = ["harness", again.code === 3 ? "exit 3 without its PATH broke line" : why(again)];
    } else if (first.code !== 0) [verdict, reason] = ["harness", first.code === 3 ? "exit 3 without its PATH broke line" : why(first)];
    count[verdict] += 1;
    lines.push(verdict === "held" ? `path ${id}: held` : verdict === "harness" ? `path ${id}: harness: ${reason}` : `path ${id}: ${verdict} step=${at.step} kind=${at.kind}`);
    records.push({ id, verdict, step: at ? at.step : null, kind: at ? at.kind : null, seed: used });
    if (slot !== null && verdict === "broke" && at.kind === "expect-failed") {
      if (written) lines.push(`regression ${id}: step ${at.step} not written (slot ${slot} holds ${written})`);
      else {
        const claim = `smoke path ${id}: an expectation the path held at admission (step ${at.step}) failed twice, the second time after up --fresh`;
        lines.push(writeRegression(main, { runId: lock.runId, slot, id, repro: regressionList(p.path, at.step, p.parsed.context), n: at.step, live, accounts, claim, result }));
        if (lines.at(-1).includes(" written as ")) written = id;
      }
    }
  }
  lines.push(`smoke run: ${count.held} held, ${count.broke} broke, ${count.flaky} flaky, ${count.harness} harness`);
  const dir = path.join(liveDir(main), lock.runId, "smoke");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.appendFileSync(path.join(dir, "pass.jsonl"), records.map((r) => `${JSON.stringify(r)}\n`).join(""), { mode: 0o600 });
  return { code: count.broke ? 3 : count.harness ? 2 : 0, lines };
}

/**
 * `smoke run --perf`'s body: each picked path, in `order`, through perfPath (runs a batch from smoke.json's
 * `perf.runs`, thresholds from `perf.thresholds`), the instance's commit as the baseline's `head`.
 */
async function perfPass({ main, lock, rec, smoke, picked, order, lines, once }) {
  const g = runCommand(["git", "-C", rec.worktree ?? main, "rev-parse", "HEAD"]);
  const head = g.status === 0 ? String(g.stdout).trim() : "";
  if (!/^[0-9a-f]{40,64}$/.test(head)) throw new Error("refused: smoke run --perf: the instance's commit could not be read");
  const count = { baselined: 0, ok: 0, regressed: 0, flaky: 0, "not-measured": 0 };
  const rows = [];
  let exit = 0;
  for (const id of order) {
    const r = await perfPath({ main, id, list: picked.get(id).path, once, runs: smoke.perf.runs, thresholds: smoke.perf.thresholds, head });
    lines.push(...r.lines);
    rows.push(r.row);
    count[r.verdict] += 1;
    exit = r.exit === 3 || exit === 3 ? 3 : Math.max(exit, r.exit);
  }
  lines.push(`smoke run --perf: ${count.baselined} baselined, ${count.ok} ok, ${count.regressed} regressed, ${count.flaky} flaky, ${count["not-measured"]} not measured`);
  const dir = path.join(liveDir(main), lock.runId, "smoke");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.appendFileSync(path.join(dir, "perf.jsonl"), rows.map((x) => `${JSON.stringify(x)}\n`).join(""), { mode: 0o600 });
  return { code: exit, lines };
}
