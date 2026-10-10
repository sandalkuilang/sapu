// argus-live-heal.mjs — a broken suite path: UI change or bug (spec §19.9). `smoke heal` reads a heal-mode
// explorer's return, re-runs the path with only the named action targets replaced and every expectation
// unchanged, and stages a heal proposal (into -suite's smoke state, which `smoke propose` turns into a pull
// request) or writes a regression candidate by the decision table.
import fs from "node:fs";
import path from "node:path";
import { expandConfig, loadLive, loadSmoke, SMOKE_DEFAULTS } from "./argus-live-config.mjs";
import { fence } from "./argus-live-fence.mjs";
import { liveDir, readLock } from "./argus-live-lock.mjs";
import { readJourneys } from "./argus-live-map.mjs";
import { run } from "./argus-live-proc.mjs";
import { runOnce } from "./argus-live-repro.mjs";
import { readRun } from "./argus-live-run.mjs";
import { readSuitePaths, regressionList, smokeEvent, writeRegression } from "./argus-live-smoke.mjs";
import { canonical, codeBlock, stage } from "./argus-live-suite.mjs";
import { parseRepro, suiteAccounts } from "./argus-live-steps.mjs";
import { targetCode } from "./argus-live-targets.mjs";

/**
 * The pass's break kinds a heal answers (spec §19.9, "locator break"): the old target, confirmed two of two, matches
 * nothing or several. `action-failed` (a timeout or error on a target that is there and unique: a disabled or
 * covered control) is no locator break but a regression candidate, which smoke run --slot writes.
 */
const ACTION_BREAKS = ["target-missing", "target-ambiguous"];
const BROKE = /^PATH broke step=(\d+) kind=(target-missing|target-ambiguous|expect-failed|action-failed)$/;
const REF = /^([1-9][0-9]?)\.([1-9])$/;
const TARGET_TEXT = ["role", "name", "label", "placeholder", "testId", "text"];

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const refused = (msg) => new Error(`refused: smoke heal: ${msg}`);
const hasContext = (list) => isObj(list[0]) && Object.hasOwn(list[0], "context");

/** Path step `n` (context not counted, each parallel member counted) → `[item index, member index | null]`, or null. */
function locate(list, n) {
  let k = 0;
  for (let i = hasContext(list) ? 1 : 0; i < list.length; i++) {
    const item = list[i];
    if (isObj(item) && Array.isArray(item.parallel)) {
      if (n <= k + item.parallel.length) return [i, n - k - 1];
      k += item.parallel.length;
    } else if (++k === n) return [i, null];
  }
  return null;
}

/** A path's steps in order, each `{n, step}` (a parallel item's members in their order). */
function flat(list) {
  const out = [];
  for (const item of hasContext(list) ? list.slice(1) : list) {
    for (const s of isObj(item) && Array.isArray(item.parallel) ? item.parallel : [item]) out.push({ n: out.length + 1, step: s });
  }
  return out;
}

/**
 * What a heal changed from path `before` to `after` → `[{step, from, to}]` (the DSL's targets), or a refusal
 * (spec §19.9): a heal never changes the context, an expectation, an action's kind, a value or any other field,
 * never adds, removes or regroups a step, and changes at most `max` targets.
 */
export function healOnly(before, after, max) {
  if (hasContext(before) !== hasContext(after) || (hasContext(before) && canonical(before[0]) !== canonical(after[0]))) throw refused("a heal never changes the context");
  const shape = (l) => (hasContext(l) ? l.slice(1) : l).map((x) => (isObj(x) && Array.isArray(x.parallel) ? x.parallel.length : 1)).join(",");
  const a = flat(before);
  const b = flat(after);
  if (a.length !== b.length || shape(before) !== shape(after)) throw refused("a heal never adds or removes a step");
  const out = [];
  for (const { n, step: x } of a) {
    const y = b[n - 1].step;
    if (!isObj(x) || !isObj(y)) throw refused(`step ${n}: a heal never changes a step's shape`);
    const isExpect = Object.hasOwn(x, "expect");
    if (isExpect !== Object.hasOwn(y, "expect") || (isExpect && canonical(x) !== canonical(y))) throw refused(`step ${n}: a heal never changes an ${isExpect ? "expectation" : "action's kind"}`);
    if (isExpect) continue;
    if (x.do !== y.do) throw refused(`step ${n}: a heal never changes an action's kind`);
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
      if (k === "target" || canonical(x[k]) === canonical(y[k])) continue;
      throw refused(`step ${n}: a heal never changes ${k === "value" || k === "values" ? "a value" : `its ${/^[a-z]{1,20}$/.test(k) ? k : "fields"}`}`);
    }
    if (Object.hasOwn(x, "target") !== Object.hasOwn(y, "target")) throw refused(`step ${n}: a heal never adds or removes a target`);
    if (Object.hasOwn(x, "target") && canonical(x.target) !== canonical(y.target)) {
      // A control of another role does something else (a button that became a link): a behaviour change, never a heal.
      if (isObj(x.target) && isObj(y.target) && typeof x.target.role === "string" && typeof y.target.role === "string" && x.target.role !== y.target.role) {
        const word = (r) => (/^[a-z]{1,30}$/.test(r) ? r : "another");
        throw refused(`step ${n}: a heal keeps the control's role (${word(x.target.role)}, not ${word(y.target.role)})`);
      }
      out.push({ step: n, from: x.target, to: y.target });
    }
  }
  if (out.length > max) throw refused(`a heal changes at most ${max} target${max === 1 ? "" : "s"}`);
  return out;
}

/**
 * Path `list` with heal `heal` (`[{step, target}]`, the return's) applied → `{list, changes}` (healOnly's).
 * Refused: a step the path lacks, an expectation, an action without a target, more than `max` steps.
 */
export function healPath(list, heal, max) {
  if (heal.length > max) throw refused(`a heal changes at most ${max} target${max === 1 ? "" : "s"}`);
  const out = structuredClone(list);
  for (const { step: n, target } of heal) {
    const at = locate(out, n);
    if (!at) throw refused(`step ${n}: the path has no such step`);
    const [i, j] = at;
    const s = j === null ? out[i] : out[i].parallel[j];
    if (!isObj(s) || Object.hasOwn(s, "expect")) throw refused(`step ${n}: a heal never changes an expectation`);
    if (!Object.hasOwn(s, "target")) throw refused(`step ${n}: ${/^[a-z-]{1,20}$/.test(String(s.do)) ? s.do : "that step"} has no target to heal`);
    s.target = structuredClone(target);
  }
  return { list: out, changes: healOnly(list, out, max) };
}

/**
 * What the owner should read in a heal's change `{from, to}` → flags: `role changed` when one target names a role and
 * the other finds its control another way (a label, a test id), `name changed` when the names it finds by differ.
 */
function flagsOf({ from, to }) {
  const role = (t) => (isObj(t) && typeof t.role === "string" ? t.role : null);
  const names = (t) => JSON.stringify(namesOf(t).sort());
  return [...(role(from) !== role(to) ? ["role changed"] : []), ...(names(from) !== names(to) ? ["name changed"] : [])];
}

/** A run's verdict from runOnce's path mode → `{held}` | `{broke: {step, kind}}` | `{harness: reason}`. */
function verdictOf(r) {
  const last = r.lines.at(-1) ?? "";
  if (r.code === 0) return { held: true };
  const m = r.code === 3 ? BROKE.exec(last) : null;
  if (m) return { broke: { step: Number(m[1]), kind: m[2] } };
  return { harness: last.startsWith("HARNESS: ") ? last.slice(9) : `exit ${r.code}` };
}
const said = (v) => (v.held ? "held" : v.broke ? `broke step=${v.broke.step} kind=${v.broke.kind}` : "harness");

/** The names a target finds its element by (its own and its `within`'s), for `git log -S`. */
function namesOf(t) {
  const out = [];
  for (let x = t; isObj(x); x = x.within) for (const k of TARGET_TEXT) if (k !== "role" && typeof x[k] === "string" && x[k] && !x[k].includes("{{")) out.push(x[k]);
  return [...new Set(out)];
}

/**
 * The advisory evidence of a healed step (spec §19.9), as lines: per old name, `git log -S"<name>"
 * <head12>..HEAD: <h> <subject>` for each commit that added or removed it (or `no commit removed it`), then the
 * commits touching the journey's anchor files since admission. Git's words are repo text: shown fenced.
 */
function evidence(main, { id, from, head, runner }) {
  const ok = typeof head === "string" && /^[0-9a-f]{40}$/.test(head) && runner(["git", "-C", main, "cat-file", "-e", `${head}^{commit}`]).status === 0;
  if (!ok) return ["admission head: not in this clone; no git evidence"];
  const short = head.slice(0, 12);
  const log = (args) => {
    const r = runner(["git", "-C", main, "log", "--format=%h %s", ...args]);
    return r.status === 0 ? String(r.stdout ?? "").split("\n").filter(Boolean).map((l) => l.slice(0, 200)) : null;
  };
  const out = [];
  for (const name of namesOf(from)) {
    const found = log([`-S${name}`, `${head}..HEAD`]);
    const at = `git log -S${JSON.stringify(name)} ${short}..HEAD`;
    if (found === null) out.push(`${at}: git could not tell`);
    else if (!found.length) out.push(`${at}: no commit removed it`);
    else for (const c of found) out.push(`${at}: ${c}`);
  }
  let files = [];
  try {
    const j = (readJourneys(main)?.journeys ?? []).find((x) => isObj(x) && x.id === id);
    files = [...new Set((j?.steps ?? []).flatMap((s) => (s.sources ?? []).map((a) => a.file)).filter((f) => typeof f === "string" && /^[^/\\-][^\\]*$/.test(f) && !f.split("/").includes("..")))];
  } catch {
    files = [];
  }
  for (const c of files.length ? (log([`${head}..HEAD`, "--", ...files]) ?? []) : []) out.push(`anchor files: ${c}`);
  return out;
}

/** The last verdict smoke run recorded for journey `id` in this cycle's pass, or null. */
function lastPass(main, runId, id) {
  let text = "";
  try {
    text = fs.readFileSync(path.join(liveDir(main), runId, "smoke", "pass.jsonl"), "utf8");
  } catch {
    return null;
  }
  const recs = text.split("\n").flatMap((l) => {
    try {
      const r = JSON.parse(l);
      return isObj(r) && r.id === id ? [r] : [];
    } catch {
      return [];
    }
  });
  return recs.at(-1) ?? null;
}

/**
 * `smoke heal <slot>.<generation>` → `{code, lines, masked}`: decision table §19.9 on a heal-mode explorer's return.
 *
 * Needs a cycle with an instance, the slot minted in it, a return holding `heal`, and this cycle's pass having
 * confirmed a locator break of the journey (smoke run's `broke`, kind target-missing or target-ambiguous; an
 * action-failed break is refused: smoke run --slot writes it as a regression candidate). Then:
 * - `heal: []` with `no-control` → a bug: the path to step n − 1, then `visible` on the step's old target as the
 *   regression candidate's final, written as the lowest free slot's return (code 3); `blocked` or `harness` →
 *   the harness's (code 2). Nothing runs.
 * - a heal → the path with only those targets replaced (healPath; a refusal throws, another role included), run twice, after `up
 *   --fresh` then dirty: held both times → UI changed, a staged heal (its changes, the healed path, the old and
 *   new target of each step and the git evidence in its body, `role changed` or `name changed` flagged there and
 *   on a `needs owner` line, the entry then `needsOwner` (propose's needs-owner label); code 0; a digest the owner rejected before is `not
 *   staged` and records no `healed` event, still code 0, as admit); an expectation failed both times →
 *   behaviour changed, a regression candidate at it on the healed path (code 3); a harness run → code 2; else
 *   `did not hold`, nothing staged (code 3).
 * Page-derived targets and git's words are printed only inside a fence (`masked`: the env file's values are masked
 * by the fence itself). `once` is runOnce's seam, `runner` git's.
 */
export async function smokeHeal(main, ref, { once = runOnce, runner = run } = {}) {
  const m = typeof ref === "string" ? REF.exec(ref) : null;
  if (!m) throw refused(`${typeof ref === "string" && /^[\x20-\x7e]{1,40}$/.test(ref) ? ref : "that"} is not <slot>.<generation>`);
  const [slot, generation] = [Number(m[1]), Number(m[2])];
  const lock = readLock(main);
  if (!lock) throw new Error("refused: no journey cycle is running");
  const rec = readRun(main);
  if (!rec || rec.runId !== lock.runId || !rec.instanceId) throw new Error(`refused: cycle ${lock.runId} has no instance (its up did not finish)`);
  if (!isObj(rec.slots) || !isObj(rec.slots[String(slot)])) throw refused(`slot ${slot} was never minted in cycle ${lock.runId}`);
  let ret = null;
  try {
    ret = JSON.parse(fs.readFileSync(path.join(liveDir(main), lock.runId, "returns", `${slot}.${generation}.json`), "utf8"));
  } catch {
    ret = null;
  }
  if (!isObj(ret)) throw refused(`no return ${slot}.${generation}`);
  if (!Array.isArray(ret.heal)) throw refused(`return ${slot}.${generation} holds no heal`);
  const { config, errors, secrets } = loadLive(main);
  if (!config || errors.length) throw new Error(`refused: .argus/live.json: ${errors.join("; ")}`);
  const live = expandConfig(config, { ports: { ...(rec.ports ?? {}) }, secrets });
  const loaded = loadSmoke(main);
  if (loaded.errors.length) throw refused(loaded.errors.join("; "));
  const smoke = loaded.smoke ?? SMOKE_DEFAULTS;
  const id = ret.journey;
  const suite = readSuitePaths(main, smoke.dir).find((p) => p.id === id);
  if (!suite) throw refused(`the suite has no path ${typeof id === "string" && /^[a-z0-9-]{1,64}$/.test(id) ? id : "for that return"}`);
  const accounts = suiteAccounts(live);
  const parse = (list) => {
    try {
      return parseRepro(list, { accounts, live, path: true });
    } catch (e) {
      if (!/^refused: /.test(e.message)) throw e;
      throw refused(e.message.replace(/^refused: repro: /, ""));
    }
  };
  const parsed = parse(suite.path);
  const pass = lastPass(main, lock.runId, id);
  if (pass && pass.verdict === "broke" && pass.kind === "action-failed" && Number.isInteger(pass.step)) {
    throw refused(`${id} broke at step ${pass.step} with action-failed: its control is there and unique, so it is a regression candidate (smoke run --slot), never a heal`);
  }
  if (!pass || pass.verdict !== "broke" || !ACTION_BREAKS.includes(pass.kind) || !Number.isInteger(pass.step)) throw refused(`${id} has no confirmed action break in this cycle's pass (smoke run)`);
  const write = (n, repro, claim) => writeRegression(main, { runId: lock.runId, id, n, repro, live, accounts, claim });

  if (!ret.heal.length) {
    if (ret.heal_reason !== "no-control") {
      return { code: 2, lines: [`heal ${id}: harness: the explorer was ${ret.heal_reason === "blocked" ? "blocked by the page" : "stopped by the harness"}; nothing staged`] };
    }
    const n = pass.step;
    const at = locate(suite.path, n);
    const step = at && (at[1] === null ? suite.path[at[0]] : suite.path[at[0]].parallel[at[1]]);
    const lines = [`heal ${id}: bug: the explorer found no control for step ${n}'s goal (a heal cannot add a step)`];
    if (!isObj(step) || !isObj(step.target) || at[1] !== null) lines.push(`regression ${id}: step ${n} not written (step ${n} has no target of its own to prove)`);
    else lines.push(write(n, regressionList(suite.path, n, parsed.context, { as: step.as, expect: "visible", target: step.target }), `smoke path ${id}: the explorer found no control for step ${n}'s goal, which the path reached at admission`));
    return { code: 3, lines };
  }

  const { list: healed, changes } = healPath(suite.path, ret.heal, smoke.heal_max_steps);
  const healedParsed = parse(healed);
  const runPath = (dirty) => once(main, null, { path: { id, list: healed }, dirty });
  const fresh = verdictOf(await runPath(false));
  const dirty = verdictOf(await runPath(true));
  const harness = [fresh, dirty].find((v) => v.harness);
  if (harness) return { code: 2, lines: [`heal ${id}: harness: ${harness.harness}; nothing staged`] };
  if (fresh.broke && dirty.broke && fresh.broke.kind === "expect-failed" && dirty.broke.kind === "expect-failed") {
    const n = dirty.broke.step;
    return {
      code: 3,
      lines: [
        `heal ${id}: behaviour changed: the healed path failed step ${n}'s expectation twice`,
        write(n, regressionList(healed, n, healedParsed.context), `smoke path ${id}: with its healed targets, an expectation the path held at admission (step ${n}) failed twice, after up --fresh and dirty`),
      ],
    };
  }
  if (!fresh.held || !dirty.held) return { code: 3, lines: [`heal ${id}: did not hold (fresh: ${said(fresh)}, dirty: ${said(dirty)}); nothing staged`] };

  const code = (n) => targetCode(parsed.steps[n - 1].target);
  const newCode = (n) => targetCode(healedParsed.steps[n - 1].target);
  const head = isObj(suite.admitted) ? suite.admitted.head : null;
  const lines = [];
  const staged = changes.map((c) => ({ kind: "heal", id, step: c.step, from: c.from, to: c.to, evidence: evidence(main, { id, from: c.from, head, runner }), run: lock.runId }));
  for (const c of staged) lines.push(`step ${c.step}`, `  from: ${code(c.step)}`, `  to:   ${newCode(c.step)}`, ...c.evidence.map((e) => `  ${e}`));
  const flags = changes.flatMap((c) => flagsOf(c).map((f) => `step ${c.step}: ${f}`));
  const body = [
    `### Heal: ${id}`,
    "",
    ...(flags.length ? [`**Needs owner:** ${flags.join("; ")}. The control is found by another role or name: check it does what the old one did.`, ""] : []),
    `The path's unchanged expectations held twice (after up --fresh, then dirty) with these targets. Advisory evidence follows each step.`,
    "",
    ...codeBlock(lines),
  ];
  const s = stage(main, { kind: "heal", id, run: lock.runId, changes: staged, path: healed, body, ...(flags.length ? { needsOwner: true } : {}) });
  if (s.staged) smokeEvent(main, lock.runId, { kind: "healed", id, steps: [...new Set(staged.map((c) => c.step))] });
  const d = s.digest.slice(0, 12);
  const f = fence(lines.join("\n"), { secrets });
  return {
    code: 0,
    masked: true,
    lines: [
      `heal ${id}: UI changed: the healed path held twice (fresh, then dirty), every expectation unchanged`,
      s.staged ? `staged: heal ${id} (digest ${d})` : `heal ${id}: not staged (this change was rejected before; digest ${d})`,
      ...(flags.length ? [`heal ${id}: needs owner (${flags.join("; ")})`] : []),
      ...f.body.split("\n"),
      ...(f.truncated ? [`truncated ${f.truncated} characters`] : []),
    ],
  };
}
