// argus-live-ci.mjs — the suite's CI runs read back (spec §19.9): `smoke ci` triages a run's results (flake, UI
// change, bug, browser-only, check, visual), stages quarantines and counts their lifecycle. It reads CI through
// argus-live-artifacts.mjs (as smoke baseline does). Artifact text is untrusted: read by name and shape, and fenced.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadLive } from "./argus-live-config.mjs";
import { loadSmoke, SMOKE_DEFAULTS } from "./argus-live-smokecfg.mjs";
import { fence } from "./argus-live-fence.mjs";
import { lastRun, readLock } from "./argus-live-lock.mjs";
import { run } from "./argus-live-proc.mjs";
import { anySuite, download, fetchRun, home, inArtifact, isPng, notesOf, PNG_MAX, PROJECT, regular, reportsIn, suiteIdsAt, testsOf, noWiring, writeTriage } from "./argus-live-artifacts.mjs";
import { readPass, readQuarantine, smokeEvent } from "./argus-live-smoke.mjs";
import { codeBlock, readState, refreshOutcomes, settleRegressions, stageInto, writeState } from "./argus-live-suite.mjs";

/** A path step's `test.step` title (codegen's), the only step names read. */
const STEP = /^step ([1-9][0-9]{0,2}) (do|expect):([a-z-]{1,20})$/;
const SETUP = /^sign in ([a-z][a-z0-9_-]{0,39}\.[1-9][0-9]?)$/;
const SHOT = /^([a-z0-9][a-z0-9-]{0,63})-(expected|actual|diff)\.png$/;
const QUARANTINE_EXIT = 3;
const QUARANTINE_MAX = 5;
/** A base-branch flake tells a pull request's flake from a new one for this long (then it is history). */
const BASE_FLAKE_MS = 30 * 86_400_000;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
/** `s` parsed as JSON, or null. */
const parse = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};
const ansi = (s) => String(s).replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
const cap = (s, n = 4000) => (s.length > n ? `${s.slice(0, n)} …` : s);

/** The deepest failed path step of a result's steps → `{n, kind: "do"|"expect", what}`, or null. */
function failedStep(steps) {
  for (const s of Array.isArray(steps) ? steps : []) {
    if (!isObj(s)) continue;
    const inner = failedStep(s.steps);
    if (inner) return inner;
    const m = s.error ? STEP.exec(String(s.title)) : null;
    if (m) return { n: Number(m[1]), kind: m[2], what: m[3] };
  }
  return null;
}

const messages = (r) => [...(Array.isArray(r.errors) ? r.errors : []), r.error].filter(isObj).map((e) => ({ message: cap(String(e.message ?? ""), 64_000), snippet: String(e.snippet ?? "") }));
/** The lane's own pass records of journey `id` in run `runId`'s pass.jsonl. */
const lanePass = (main, runId, id) => readPass(main, runId).records.filter((r) => r.id === id);

/** True when the suite holds ARIA baseline `rel` at commit `sha` (the working tree's when the clone lacks it). */
function holdsFile(main, sha, rel, runner) {
  if (runner(["git", "-C", main, "cat-file", "-e", `${sha}^{commit}`]).status === 0) return runner(["git", "-C", main, "cat-file", "-e", `${sha}:${rel}`]).status === 0;
  return fs.existsSync(path.join(main, rel));
}

/**
 * One cycle of a quarantined journey (decision 13) → `{entry, action, counted}`. With no evidence (no lane pass of the
 * path, or no quarantine-job result read) nothing is counted: `entry` as it was, the streak kept. Else `entry` `{…,
 * cycles, clean}` counted on, the cycle clean when the lane's pass held the path at least twice and nothing else and
 * every quarantine-job result read passed first time; `action` `exit` at three clean cycles in a row, `drop` at five
 * cycles, else null.
 */
export function quarantineCycle(entry, { held, other, first, otherCi }) {
  if (held + other === 0 || first + otherCi === 0) return { entry, action: null, counted: false };
  const clean = held >= 2 && other === 0 && otherCi === 0 ? (entry.clean ?? 0) + 1 : 0;
  const next = { ...entry, cycles: (entry.cycles ?? 0) + 1, clean };
  return { entry: next, action: clean >= QUARANTINE_EXIT ? "exit" : next.cycles >= QUARANTINE_MAX ? "drop" : null, counted: true };
}

/** The suite's quarantine.json entries of journeys in `ids` (readQuarantine's `[{id, issue, since, projects}]`). */
const quarantined = (main, dir, ids) => readQuarantine(main, dir).filter((q) => ids.includes(q.id));
/** A body's markdown for a change smoke ci stages. */
const changeBody = (title, lines) => [`### ${title}`, "", ...codeBlock(lines)];

/**
 * `smoke ci [--run <id>]` → `{code, lines, masked}`: run `run` (null: the newest completed run of smoke.json's
 * `ci.workflow`) of the contract's home repo, triaged by spec §19.9. Refused: a run id that is not one, a run of
 * another repository or from a fork, a run without a readable results.json in an `ci.artifact…` artifact.
 *
 * Only names and shapes are read from the artifacts: a test is read when its file is `<id>.spec.ts` of a suite
 * path and its project one of the suite's; a setup test when titled `sign in <role>.<k>`. One line per finding:
 * `harness setup <account>: …`; `flaky <id> <projects>: …` (a push to the base branch stages a quarantine, or its
 * drop after an earlier quarantine; elsewhere nothing) or `flaky-new <id> <pr>` (a pull request's head, never
 * flaky on the base: one comment on the pull request, never a quarantine); a failed step `ui-change? <id> step
 * <n>` (an action; `ci-only` when the lane's last pass held it), `bug? <id> step <n>` (an expectation), or
 * `browser-only <id> <project>` when Chromium passed; `visual <id> <n> <project>: expected …, actual …, diff …`
 * (PNGs under 5 MB copied to `.argus/smoke-ci/<run>/<id>/<project>/`, 0600); `baseline-missing <id> <project>`;
 * `aria <id> <n> [k]`; from the checks' annotations (a passing test's too) `check <id> <check> [k]`, `manual <id> <check>
 * [k]` and `info <id> <project> [k]`; `quarantined <id> <project>: …`;
 * quarantine's lifecycle for the running cycle; `pending-regression <id> <url>` for a heal the owner closed
 * (settleRegressions, with its `quarantine <id>: …` line). Every key, diff and message is printed only in one fence, `[k]`
 * naming its entry. The unfenced lines go to `.argus/smoke-ci/<run>/triage.json` for the report. Exit 3 with a
 * failure, else 2 with a harness line, else 0. `runner` is gh's and git's seam.
 */
export async function smokeCi(main, { run: asked }, { runner = run } = {}) {
  const verb = "smoke ci";
  const { repo, base } = home(main, verb);
  const loaded = loadSmoke(main);
  if (loaded.errors.length) throw new Error(`refused: ${verb}: ${loaded.errors.join("; ")}`);
  const smoke = loaded.smoke ?? SMOKE_DEFAULTS;
  const none = noWiring(main, smoke, verb);
  if (none) return none;
  anySuite(main, smoke, verb);
  const r = fetchRun(main, { asked, repo, base, workflow: smoke.ci.workflow, runner, verb });
  const { ids, notes } = suiteIdsAt(main, { r, dir: smoke.dir, runner });
  const tmp = download(main, { id: r.id, repo, prefix: smoke.ci.artifact, runner, verb });
  try {
    const { reports, skipped } = reportsIn(tmp, smoke.ci.artifact);
    if (!reports.length) throw new Error(`refused: ${verb}: run ${r.id} has no readable results.json in an ${smoke.ci.artifact} artifact`);
    const out = [`smoke ci: run ${r.id} (${r.event} on ${r.branch}, ${r.sha.slice(0, 12)})`, ...notes];
    const details = [];
    const detail = (lines) => {
      details.push(...lines.map((l, i) => (i ? `    ${l}` : `[${details.filter((d) => d.startsWith("[")).length + 1}] ${l}`)));
      return details.filter((d) => d.startsWith("[")).length;
    };
    const state = readState(main);
    const tests = reports.flatMap(testsOf);
    const passed = new Map();
    let outside = 0;
    let badFiles = 0;
    let badViolations = 0;
    const count = { failing: 0, flaky: 0, harness: 0, quarantined: 0 };
    const reads = new Map();
    const flakes = new Map();
    const failures = [];
    const lines = new Set();
    const violationsSeen = new Set();
    const add = (l) => {
      if (!lines.has(l)) {
        lines.add(l);
        out.push(l);
      }
    };
    const checked = [];
    /** Test `t`'s check annotations as lines (an ARIA one as `baseline-missing` or `aria`) → whether one is a violation. */
    const noted = (t) => {
      const { title: id, project } = t;
      const { good, bad } = notesOf(t);
      badViolations += bad;
      for (const x of good) {
        const n = x.step ?? "?";
        if (x.word === "check" && x.check === "aria-snapshot" && x.key === "baseline-missing") add(`baseline-missing ${id} ${project}`);
        else if (x.word === "check" && x.check === "aria-snapshot") {
          if (![...lines].some((l) => l.startsWith(`aria ${id} ${n} `))) add(`aria ${id} ${n} [${detail([`aria ${id} ${n} (${project}): ${x.key}`, ...(x.detail ? [`detail: ${JSON.stringify(x.detail)}`] : [])])}]`);
        } else if (!violationsSeen.has(JSON.stringify([x.word, id, x.check, x.key, x.detail]))) {
          violationsSeen.add(JSON.stringify([x.word, id, x.check, x.key, x.detail]));
          const head = x.word === "info" ? `info ${id} ${project}` : `${x.word} ${id} ${x.check}`;
          add(`${head} [${detail(x.word === "info" ? [head, `line: ${JSON.stringify(x.detail)}`] : [`${head} (${project})`, `key: ${JSON.stringify(x.key)}`, ...(x.detail ? [`detail: ${JSON.stringify(x.detail)}`] : [])])}]`);
        }
      }
      return good.some((x) => x.word === "check");
    };
    for (const t of tests) {
      if (t.project === "setup" && t.file === "auth.setup.ts" && SETUP.test(String(t.title))) {
        if (t.status === "unexpected") {
          count.harness += 1;
          add(`harness setup ${SETUP.exec(t.title)[1]}: the setup project could not sign it in`);
        }
        continue;
      }
      if (!ids.includes(t.title) || t.file !== `${t.title}.spec.ts` || !PROJECT.test(String(t.project))) {
        outside += 1;
        continue;
      }
      if (t.tags.includes("quarantine") || t.tags.includes("@quarantine")) {
        count.quarantined += 1;
        const first = t.status === "expected" && t.results.length === 1 && t.results[0].status === "passed";
        const q = reads.get(t.title) ?? [];
        q.push({ project: t.project, first });
        reads.set(t.title, q);
        add(`quarantined ${t.title} ${t.project}: ${first ? "passed first time" : t.status === "flaky" ? "flaky" : t.status === "expected" ? "passed" : "failed"}`);
        continue;
      }
      if (t.status === "expected" || t.status === "flaky") {
        passed.set(t.title, new Set([...(passed.get(t.title) ?? []), t.project]));
        checked.push(t);
      }
      if (t.status === "flaky") {
        count.flaky += 1;
        flakes.set(t.title, [...(flakes.get(t.title) ?? []), t.project]);
      } else if (t.status === "unexpected") {
        count.failing += 1;
        failures.push(t);
      }
    }
    const ciRun = r.id;
    const shotDir = (id, project) => path.join(main, ".argus", "smoke-ci", ciRun, id, project);
    const rel = (f) => path.relative(main, f);
    const pass = lastRun(main);
    for (const t of failures) {
      const { title: id, project, root } = t;
      let signal = false;
      const shots = new Map();
      for (const res of t.results) {
        for (const e of messages(res)) {
          const msg = ansi(e.message);
          if (msg.includes("A snapshot doesn't exist at ")) {
            signal = true;
            add(`baseline-missing ${id} ${project}`);
          }
          if (msg.includes("toMatchAriaSnapshot")) {
            signal = true;
            const at = (e.snippet.split("\n").find((l) => /^\s*>/.test(l)) ?? "").match(/"([0-9]{1,3})\.aria\.yml"/);
            const n = at ? at[1] : null;
            if (n && !holdsFile(main, r.sha, path.posix.join(smoke.dir, "__aria__", `${id}.spec`, `${n}.aria.yml`), runner)) add(`baseline-missing ${id} ${project}`);
            else if (![...lines].some((l) => l.startsWith(`aria ${id} ${n ?? "?"} `))) add(`aria ${id} ${n ?? "?"} [${detail([`aria ${id} ${n ?? "?"} (${project}): the snapshot's line diff`, ...cap(msg).split("\n")])}]`);
          }
        }
        for (const a of Array.isArray(res.attachments) ? res.attachments : []) {
          const m = isObj(a) ? SHOT.exec(String(a.name)) : null;
          if (!m) continue;
          signal = true;
          const got = shots.get(m[1]) ?? {};
          if (got[m[2]]) continue;
          const file = inArtifact(root, a.path);
          const bytes = file ? regular(file, PNG_MAX) : null;
          if (!isPng(bytes)) {
            badFiles += 1;
            continue;
          }
          const dest = path.join(shotDir(id, project), `${m[1]}-${m[2]}.png`);
          fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
          fs.writeFileSync(dest, bytes, { mode: 0o600 });
          got[m[2]] = rel(dest);
          shots.set(m[1], got);
        }
      }
      if (noted(t)) signal = true;
      for (const [n, got] of shots) add(`visual ${id} ${n} ${project}: ${["expected", "actual", "diff"].filter((k) => got[k]).map((k) => `${k} ${got[k]}`).join(", ")}`);
      const step = failedStep(t.results.at(-1)?.steps);
      if (!step && signal) continue;
      if (project !== "chromium" && (passed.get(id) ?? new Set()).has("chromium")) add(`browser-only ${id} ${project}`);
      else if (!step) add(`failed ${id} ${project}: no path step or check named`);
      else if (step.kind === "expect") add(`bug? ${id} step ${step.n}`);
      else add(`${(lanePass(main, pass, id) ?? []).at(-1)?.verdict === "held" ? "ci-only" : "ui-change?"} ${id} step ${step.n}`);
    }
    // A test that passed still reports what only a human can judge, and what its checks covered.
    for (const t of checked) noted(t);
    // How each open proposal ended (a merged quarantine exit counts before a flake is judged).
    refreshOutcomes(state, { runner, cwd: main });
    // Flakes (decision 13): quarantined only from a push to the base branch.
    const basePush = r.event === "push" && r.branch === base;
    const now = Date.now();
    for (const [id, projects] of flakes) {
      const j = { ...(state.journeys[id] ?? {}) };
      const head = `flaky ${id} ${projects.join(",")}`;
      // Base flakes within the window (a bare run id, as written before it, is dated from now).
      j.baseFlakes = (j.baseFlakes ?? []).map((x) => (typeof x === "string" ? { run: x, at: new Date(now).toISOString() } : x)).filter((x) => isObj(x) && typeof x.run === "string" && now - Date.parse(x.at) < BASE_FLAKE_MS);
      if (basePush) {
        j.baseFlakes = [...j.baseFlakes.filter((x) => x.run !== ciRun), { run: ciRun, at: new Date(now).toISOString() }].slice(-10);
        if (quarantined(main, smoke.dir, ids).some((q) => q.id === id)) add(`${head}: quarantined already`);
        else {
          const drop = (j.exits ?? 0) >= 1;
          const kind = drop ? "drop" : "quarantine";
          const evidence = [`CI run ${ciRun}: flaky on ${base} (${projects.join(", ")})`];
          const entry = { kind, id, run: ciRun, changes: [{ kind, id, evidence, run: ciRun }], body: changeBody(`${drop ? "Drop" : "Quarantine"}: ${id}`, [...evidence, ...(drop ? ["It left quarantine once already: a second quarantine drops it."] : ["Tagged @quarantine: the gating job skips it, the quarantine job keeps running it."])]) };
          if (!drop) entry.quarantine = { id, issue: null, since: ciRun, projects: [...projects].sort() };
          const s = stageInto(state, entry);
          if (s.staged) smokeEvent(main, readLock(main)?.runId ?? lastRun(main), { kind: drop ? "dropped" : "quarantined", id });
          if (!drop) j.tracking = `smoke-flaky:${id}`;
          add(!s.staged ? `${head}: ${kind} not staged (rejected before; digest ${s.digest.slice(0, 12)})` : drop ? `${head}: drop staged (flaky on ${base} after an earlier quarantine; digest ${s.digest.slice(0, 12)})` : `${head}: quarantine staged (digest ${s.digest.slice(0, 12)}), tracking issue smoke-flaky:${id}`);
        }
      } else if (r.event === "pull_request" && r.pr) {
        if ((j.baseFlakes ?? []).length) add(`${head}: flaky on ${base} too`);
        else {
          add(`flaky-new ${id} ${r.pr}`);
          const key = `${r.pr}:${id}`;
          if (!state.comments.includes(key)) {
            const c = comment(main, { repo, pr: r.pr, id, projects, ciRun, base, runner });
            if (c === 0) state.comments = [...state.comments, key].slice(-200);
            else add(`flaky-new ${id} ${r.pr}: the comment failed (gh exited ${c ?? "on a signal"})`);
          }
        }
      } else add(`${head}: nothing staged (a ${r.event === "push" ? "push" : r.event} to ${r.branch}, not to ${base} or a pull request)`);
      state.journeys[id] = j;
    }
    lifecycle(main, { state, smoke, ids, reads, ciRun, basePush, base, add });
    // A heal the owner closed leaves the break with them (spec §19.9): pending-regression and quarantined until they rule.
    const settled = settleRegressions(main, state, { dir: smoke.dir, members: new Set(ids) });
    for (const { id, url } of settled.pending) add(`pending-regression ${id} ${url}`);
    for (const l of settled.lines) add(l);
    if (outside) add(`skipped: ${outside} test result(s) outside the suite's names and projects`);
    if (badViolations) add(`skipped: ${badViolations} violation(s) not in a check's shape`);
    if (badFiles) add(`skipped: ${badFiles} file(s): not a PNG, over 5 MB, outside the run's test results or not a regular file`);
    for (const s of skipped) add(s);
    add(`smoke ci: ${count.failing} failing, ${count.flaky} flaky, ${count.harness} harness, ${count.quarantined} quarantined read`);
    writeState(main, state);
    writeTriage(main, r, out);
    const shown = [...out];
    if (details.length) {
      const f = fence(details.join("\n"), { secrets: loadLive(main).secrets ?? {} });
      shown.splice(out.length - 1, 0, ...f.body.split("\n"), ...(f.truncated ? [`truncated ${f.truncated} characters`] : []));
    }
    return { code: count.failing ? 3 : count.harness ? 2 : 0, lines: shown, masked: true };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** The flaky-new comment on pull request `pr` (spec §19.9), built from names alone → gh's exit status. */
function comment(main, { repo, pr, id, projects, ciRun, base, runner }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "argus-ci-"));
  try {
    const file = path.join(dir, "body.md");
    const text = `argus smoke: \`${id}\` was flaky on this pull request's head in CI run ${ciRun} (${projects.join(", ")}): it failed, then passed on retry. It was never flaky on \`${base}\`, so it is not quarantined: this change may have brought a race.\n`;
    fs.writeFileSync(file, text, { mode: 0o600 });
    return runner(["gh", "pr", "comment", String(pr), "--repo", repo, "--body-file", file], { cwd: main }).status;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Quarantine's lifecycle for the running cycle (decision 13): each journey in the suite's quarantine.json is
 * counted once a lane cycle and once a CI run (`ciRuns`), only from a push to the base branch (quarantineCycle, from
 * the cycle's pass and this run's quarantine-job `reads` of the projects it flaked on, every project for an entry
 * naming none); an exit or a drop is staged. No cycle, another event, a CI run counted already or no evidence → a
 * line, nothing counted (never dirty).
 */
function lifecycle(main, { state, smoke, ids, reads, ciRun, basePush, base, add }) {
  const list = quarantined(main, smoke.dir, ids);
  if (!list.length) return;
  if (!basePush) {
    add(`quarantine: run ${ciRun} is not a push to ${base}; streaks unchanged`);
    return;
  }
  const lock = readLock(main);
  if (!lock) {
    add("quarantine: no journey cycle is running; streaks unchanged");
    return;
  }
  for (const { id, since, projects } of list) {
    const j = { ...(state.journeys[id] ?? {}) };
    const q = j.quarantine ?? { since, cycles: 0, clean: 0, counted: [] };
    const where = (x) => `cycle ${x.cycles} of ${QUARANTINE_MAX}, clean streak ${x.clean} of ${QUARANTINE_EXIT}`;
    if ((q.counted ?? []).includes(lock.runId)) {
      add(`quarantine ${id}: ${where(q)} (this cycle is counted)`);
      continue;
    }
    if ((q.ciRuns ?? []).includes(ciRun)) {
      add(`quarantine ${id}: not counted (CI run ${ciRun} is counted already; the next push to ${base} is read)`);
      continue;
    }
    const recs = lanePass(main, lock.runId, id) ?? [];
    const held = recs.filter((x) => x.verdict === "held").length;
    // A flake is judged on the projects it flaked on (msedge has no quarantine job: its entry reads every project).
    const want = projects.filter((p) => p !== "msedge");
    const got = (reads.get(id) ?? []).filter((x) => !want.length || want.includes(x.project));
    const ci = { first: got.filter((x) => x.first).length, otherCi: got.filter((x) => !x.first).length };
    const { entry, action, counted } = quarantineCycle(q, { held, other: recs.length - held, ...ci });
    if (!counted) {
      add(`quarantine ${id}: not counted (${!got.length ? `no quarantine-job result${want.length ? ` of ${want.join(",")}` : ""} in CI run ${ciRun}` : "this cycle's pass did not run it"})`);
      continue;
    }
    entry.counted = [...(q.counted ?? []), lock.runId].slice(-10);
    entry.ciRuns = [...(q.ciRuns ?? []), ciRun].slice(-20);
    j.quarantine = entry;
    if (!action) add(`quarantine ${id}: ${where(entry)}`);
    else {
      const kind = action === "exit" ? "unquarantine" : "drop";
      const evidence = [action === "exit" ? `${QUARANTINE_EXIT} clean cycles in a row: the lane's pass held it twice and every quarantine-job result passed first time` : `quarantined for ${QUARANTINE_MAX} cycles`];
      const s = stageInto(state, { kind, id, run: ciRun, changes: [{ kind, id, evidence, run: ciRun }], body: changeBody(`${action === "exit" ? "Leave quarantine" : "Drop"}: ${id}`, evidence) });
      const d = s.digest.slice(0, 12);
      if (s.staged) smokeEvent(main, lock.runId, { kind: action === "exit" ? "unquarantined" : "dropped", id });
      if (!s.staged) add(`quarantine ${id}: ${kind} not staged (rejected before; digest ${d})`);
      else if (action === "exit") {
        // The record stands until the exit merges (refreshOutcomes): a closed or open proposal changes nothing.
        add(`quarantine ${id}: exit staged (${QUARANTINE_EXIT} clean cycles; digest ${d})`);
      } else add(`drop ${id}: staged (quarantined for ${QUARANTINE_MAX} cycles; digest ${d})`);
    }
    state.journeys[id] = j;
  }
}
