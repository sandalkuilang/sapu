// argus-live-minimize.mjs — what the repro runner's two of two leads to (spec §10 "Minimize", "Issue body
// additions"; decision 10): `minimize` drops one role or step at a time and keeps a drop only when the run
// still fails its final the same way; `redTestFile` writes the Playwright test a sapu worker uses as its RED
// test; `savedValues` shows what a run read as scrub would let it leave. Beside the runner, above it.
import fs from "node:fs";
import path from "node:path";
import { expandConfig, loadLive } from "./argus-live-config.mjs";
import { readSeen, secretHits } from "./argus-live-ledger.mjs";
import { readLock } from "./argus-live-lock.mjs";
import { redTest } from "./argus-live-redtest.mjs";
import { nextRun, reproRef, runOnce, writePrivate } from "./argus-live-repro.mjs";
import { readRun } from "./argus-live-run.mjs";
import { redactIds, scrubSecrets, verdictOf } from "./argus-live-scrub.mjs";
import { parseRepro, reductions } from "./argus-live-steps.mjs";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** The repo's live config, expanded with the running cycle's ports (the static checks read it). */
function liveOf(main) {
  const { config, errors, secrets } = loadLive(main);
  if (!config || errors.length) throw new Error(`failed: .argus/live.json: ${errors.join("; ")}`);
  const rec = readRun(main);
  return expandConfig(config, { ports: { ...((rec && rec.ports) ?? {}) }, secrets });
}

/** The candidate's run records in `dir` → `[{i, rec}]` by run number (an unreadable one left out). */
function runRecords(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((f) => /^run-[1-9][0-9]*\.json$/.test(f));
  } catch {
    names = [];
  }
  const out = [];
  for (const f of names) {
    try {
      out.push({ i: Number(f.slice(4, -5)), rec: JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) });
    } catch {
      // unreadable: not a record
    }
  }
  return out.sort((a, b) => a.i - b.i);
}

/** The least time a minimize run is taken to need before the lock's deadline. */
const MIN_RUN_MS = 60_000;

/**
 * Candidate `ref`'s repro minimized (spec §10 "Minimize"; decision 10) → `{code: 0, lines}`. Its base is the
 * newest run of the whole list that reproduced (refused without one): its `changed` names the click-family
 * steps that changed state, and how it failed its final (`expected`, `observed`, `shownSha256`) is what a
 * kept reduction must match. The removal units (`reductions`, numbered as the whole list is) are tried in
 * order, each once: a unit whose reduced list the static checks refuse is skipped without a run; any other
 * is one run of `once` with that list (`run-<i>.json` numbered after the candidate's records), kept only
 * when it exits 3 failing the final the same way. Runs stop at `max` (`limits.minimize_runs`, default 12),
 * one of them kept for a confirming run of the result; with no unit left untried it stopped at its
 * fixpoint. `min.json` (0600; the context element first) is written only when the confirm run failed the
 * same way; `minimize.json` `{runs, max, stopped, from, to, confirmed, tried: [{label, exit}]}` (`exit`
 * null for a skipped unit) always. Before each run (a try or the confirm) the lock must still name the
 * candidate's run (else `stopped down`) with the longest run so far, a minute at least, left before its
 * deadline (else `stopped deadline`): no confirm then, and exit 2. Lines: `try <label>: exit <k>|skipped
 * (…)`, `confirm: exit <k>`, then `minimized <ref>: steps <a> → <b>, runs <k>/<max>, stopped
 * fixpoint|budget|down|deadline, confirmed yes|no`; never a page's text. → `{code: 0|2, lines}`.
 */
export async function minimize(main, ref, { once = runOnce, max = null, say = () => {}, ...opts } = {}) {
  const { runId, candidate, slotRec, dir } = reproRef(main, ref);
  const records = runRecords(dir);
  const base = records.filter((r) => isObj(r.rec) && r.rec.exit === 3 && !r.rec.reduced).at(-1);
  if (!base) throw new Error(`refused: repro: ${ref} has no reproducing run (repro ${ref} first)`);
  const live = liveOf(main);
  const budget = max ?? (live.limits && live.limits.minimize_runs) ?? 12;
  const at = { accounts: slotRec.accounts, live };
  const list = candidate.repro;
  const parsed = parseRepro(list, at);
  // Each element of the list (the context left out) → the numbers its steps carry: a parallel group's members each count.
  const items = Array.isArray(list) && isObj(list[0]) && Object.hasOwn(list[0], "context") ? list.slice(1) : list;
  const grouped = (item) => isObj(item) && Array.isArray(item.parallel);
  let n = 0;
  const numbers = items.map((item) => (grouped(item) ? item.parallel.map(() => (n += 1)) : [(n += 1)]));
  /** The list holding the steps numbered in `keep`, the context element first. */
  const listOf = (keep) => [
    { context: parsed.context },
    ...items.flatMap((item, j) => {
      if (!grouped(item)) return keep.has(numbers[j][0]) ? [item] : [];
      const members = item.parallel.filter((_, x) => keep.has(numbers[j][x]));
      return members.length ? [{ ...item, parallel: members }] : [];
    }),
  ];
  const sameFinal = (r) => Boolean(r && r.code === 3 && isObj(r.result) && r.result.expected === base.rec.expected && r.result.observed === base.rec.observed && r.result.shownSha256 === base.rec.shownSha256);
  const changed = Array.isArray(base.rec.changed) ? base.rec.changed : [];
  const lines = [];
  const emit = (l) => {
    lines.push(l);
    say(l);
  };
  fs.rmSync(path.join(dir, "min.json"), { force: true });
  let next = nextRun(dir);
  // Each run needs the cycle and time: the longest run so far (a minute at least) before the lock's deadline.
  const need = Math.max(MIN_RUN_MS, ...records.map((r) => (isObj(r.rec) && Number.isFinite(r.rec.ms) ? r.rec.ms : 0)));
  /** Why no run may start now: `down` (the lock names no run, or another), `deadline` (too little of it left), else null. */
  const cannotRun = () => {
    let lock = null;
    try {
      lock = readLock(main);
    } catch {
      lock = null;
    }
    if (!lock || lock.runId !== runId) return "down";
    return lock.deadline * 1000 - Date.now() < need ? "deadline" : null;
  };
  let keep = new Set(parsed.steps.map((s) => s.n));
  const tried = [];
  const done = new Set();
  let runs = 0;
  let stopped = "fixpoint";
  for (;;) {
    const unit = reductions(parsed.steps.filter((s) => keep.has(s.n)), { changed: changed.filter((x) => keep.has(x)) }).find((u) => !done.has(u.label));
    if (!unit) break;
    if (runs >= budget - 1) {
      stopped = "budget";
      break;
    }
    done.add(unit.label);
    const without = new Set([...keep].filter((x) => !unit.drop.includes(x)));
    const reduced = listOf(without);
    try {
      parseRepro(reduced, at);
    } catch (e) {
      if (!/^refused: /.test(e.message)) throw e;
      tried.push({ label: unit.label, exit: null });
      emit(`try ${unit.label}: skipped (the static checks refuse it)`);
      continue;
    }
    const why = cannotRun();
    if (why) {
      stopped = why;
      break;
    }
    runs += 1;
    const r = await once(main, ref, { ...opts, list: reduced, i: next++ });
    tried.push({ label: unit.label, exit: r.code });
    emit(`try ${unit.label}: exit ${r.code}`);
    if (sameFinal(r)) keep = without;
  }
  const result = listOf(keep);
  let confirmed = false;
  const cutShort = () => stopped === "down" || stopped === "deadline";
  if (!cutShort() && runs < budget) stopped = cannotRun() ?? stopped;
  if (!cutShort() && runs < budget) {
    runs += 1;
    const c = await once(main, ref, { ...opts, list: result, i: next++ });
    confirmed = sameFinal(c);
    emit(`confirm: exit ${c.code}`);
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (confirmed) writePrivate(path.join(dir, "min.json"), `${JSON.stringify(result)}\n`);
  const from = parsed.steps.length;
  writePrivate(path.join(dir, "minimize.json"), `${JSON.stringify({ runs, max: budget, stopped, from, to: keep.size, confirmed, tried })}\n`);
  emit(`minimized ${ref}: steps ${from} → ${keep.size}, runs ${runs}/${budget}, stopped ${stopped}, confirmed ${confirmed ? "yes" : "no"}`);
  return { code: cutShort() ? 2 : 0, lines };
}

/**
 * Candidate `ref`'s RED test (spec §10 "Issue body additions") written to `red.spec.ts` (0600) in its
 * records → the file's absolute path, only once its `verdict.json` says reproduced (two of two): from `min.json` when the last minimize confirmed it, else from the
 * whole list `repro.json` holds (refused without one), parsed against the slot's allocation, its journey
 * the slot's, its oracle the final's, `SETTLE` the run's settle_ms.
 */
export function redTestFile(main, ref) {
  const { runId, slotRec, dir } = reproRef(main, ref);
  const word = verdictOf(main, runId, ref);
  if (word !== "reproduced") throw new Error(`refused: repro: ${ref} did not reproduce two of two (${word}); repro ${ref} first`);
  const read = (f) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    } catch {
      return null;
    }
  };
  const m = read("minimize.json");
  const min = isObj(m) && m.confirmed === true ? read("min.json") : null;
  const whole = read("repro.json");
  const list = Array.isArray(min) ? min : isObj(whole) ? whole.repro : null;
  if (!Array.isArray(list)) throw new Error(`refused: repro: ${ref} has no records (repro ${ref} first)`);
  const live = liveOf(main);
  const { context, steps } = parseRepro(list, { accounts: slotRec.accounts, live });
  const text = redTest({ journey: slotRec.journey, oracle: steps.at(-1).final, ref, context, steps, settleMs: live.settle_ms ?? 10_000 });
  const file = path.resolve(dir, "red.spec.ts");
  writePrivate(file, text);
  return file;
}

/**
 * `repro <ref> --saved` (Phase 5's issue body): the values the candidate's newest reproducing run of its whole
 * list read (`run-<i>.json` `saved`) as scrub would let them leave → `{code, out}`: scrub's refusal for the
 * run (scrubSecrets: a ledger gone, damaged or incomplete; exit 1), else per value `saved <name>: <JSON
 * string>`, its long unknown tokens redacted as scrub redacts them (the run's seen ids stay), or `saved
 * <name>: *** (<class>)` for one holding a secret (secretHits; a value that could not be checked: `***
 * (unchecked)`). Refused without such a run.
 */
export function savedValues(main, ref, { env = process.env } = {}) {
  const { runId, dir } = reproRef(main, ref);
  const base = runRecords(dir).filter((r) => isObj(r.rec) && r.rec.exit === 3 && !r.rec.reduced).at(-1);
  if (!base) throw new Error(`refused: repro: ${ref} has no reproducing run (repro ${ref} first)`);
  const { secrets, refusal } = scrubSecrets(main, { runId, env });
  if (refusal) return { code: 1, out: [refusal] };
  const seen = readSeen(main, runId);
  const out = Object.entries(isObj(base.rec.saved) ? base.rec.saved : {}).map(([k, v]) => {
    const name = /^[a-z][a-z0-9_]{0,39}$/.test(k) ? k : "(name not shown)";
    let hits;
    try {
      hits = secretHits(String(v), secrets);
    } catch {
      return `saved ${name}: *** (unchecked)`;
    }
    return hits.length ? `saved ${name}: *** (${hits[0].cls})` : `saved ${name}: ${JSON.stringify(redactIds(String(v), seen).text)}`;
  });
  return { code: 0, out };
}
