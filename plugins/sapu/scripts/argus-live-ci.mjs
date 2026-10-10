// argus-live-ci.mjs — the suite's CI runs read back (spec §19.8, §19.9): `smoke ci` triages a run's results
// (flake, UI change, bug, browser-only, check, visual) and stages quarantines; `smoke baseline` adopts CI's
// screenshots, ARIA snapshots and known violations as a proposal. Artifact text is untrusted: read by name and
// shape, and fenced.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadLive, loadSmoke, SMOKE_DEFAULTS } from "./argus-live-config.mjs";
import { fence } from "./argus-live-fence.mjs";
import { codeBlock, readState, stageInto, writeState } from "./argus-live-heal.mjs";
import { secretHits } from "./argus-live-ledger.mjs";
import { lastRun, liveDir, readLock } from "./argus-live-lock.mjs";
import { run } from "./argus-live-proc.mjs";
import { scrubSecrets } from "./argus-live-scrub.mjs";
import { readSuitePaths } from "./argus-live-smoke.mjs";
import { agentFiledLabel, loadContract } from "./sapu-contract.mjs";

/** A GitHub Actions run id. */
const RUN_ID = /^[1-9][0-9]{0,19}$/;
/** The suite's project names (spec §19.6): anything else in a report is not read. */
const PROJECT = /^(setup|chromium|firefox|webkit|msedge|a11y|i18n|chromium-[1-9][0-9]{1,3})$/;
/** A path step's `test.step` title (codegen's), the only step names read. */
const STEP = /^step ([1-9][0-9]{0,2}) (do|expect):([a-z-]{1,20})$/;
/** A check's name (spec §19.7): a custom check's, or axe's rule as `axe:<rule>`. */
const CHECK = /^(axe:)?[a-z][a-z0-9-]{0,39}$/;
const SETUP = /^sign in ([a-z][a-z0-9_-]{0,39}\.[1-9][0-9]?)$/;
const SHOT = /^([a-z0-9][a-z0-9-]{0,63})-(expected|actual|diff)\.png$/;
const ARTIFACT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const BRANCH = /^[A-Za-z0-9._/-]{1,200}$/;
const NWO = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MB = 1024 * 1024;
const RESULTS_MAX = 16 * MB;
const PNG_MAX = 5 * MB;
const TEXT_MAX = MB;
/** The violations a check attaches to a test result (lanes C1, C2): `[{check, step?, key, detail?, status?}]`. */
export const VIOLATIONS = "argus-violations";
/** The baseline job's artifacts (spec §19.8). */
const BASELINES = "argus-smoke-baselines";
const QUARANTINE_EXIT = 3;
const QUARANTINE_MAX = 5;

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

/** The contract's home repo and base branch, or a refusal naming `verb`. */
function home(main, verb) {
  const { contract } = loadContract(main);
  if (!contract || !NWO.test(String(contract.repo)) || !BRANCH.test(String(contract.baseBranch))) throw new Error(`refused: ${verb}: the committed contract names no home repo and base branch`);
  return { repo: contract.repo, base: contract.baseBranch, contract };
}

/** The suite's journey ids; none refuses before gh is asked anything (nothing to triage or adopt). */
function suiteIds(main, smoke, verb) {
  const ids = readSuitePaths(main, smoke.dir).map((p) => p.id);
  if (!ids.length) throw new Error(`refused: ${verb}: the suite has no paths (${smoke.dir}/journeys)`);
  return ids;
}

/** `gh <argv>` through `runner` → stdout, or a refusal naming `verb` (gh's own words never printed). */
function ghOut(runner, main, argv, verb) {
  const r = runner(["gh", ...argv], { cwd: main });
  if (r.status !== 0) throw new Error(`refused: ${verb}: gh ${argv.slice(0, 2).join(" ")} exited ${r.status ?? "on a signal"}`);
  return String(r.stdout ?? "");
}

/** A REST run object → `{id, event, branch, sha, repo, headRepo, pr}`, every field shape-checked; else a refusal. */
function runOf(raw, verb, asked = null) {
  const bad = (what) => new Error(`refused: ${verb}: run ${asked ?? "?"} ${what}`);
  if (!isObj(raw) || !Number.isSafeInteger(raw.id) || raw.id < 1) throw bad("is not a workflow run GitHub described");
  const id = String(raw.id);
  if (asked !== null && id !== asked) throw bad("is not the run GitHub answered");
  const name = (o) => (isObj(o) && NWO.test(String(o.full_name)) ? o.full_name : null);
  const out = {
    id,
    event: /^[a-z_]{1,40}$/.test(String(raw.event)) ? raw.event : null,
    branch: BRANCH.test(String(raw.head_branch)) ? raw.head_branch : null,
    sha: /^[0-9a-f]{40}$/.test(String(raw.head_sha)) ? raw.head_sha : null,
    repo: name(raw.repository),
    headRepo: name(raw.head_repository),
    pr: Array.isArray(raw.pull_requests) && isObj(raw.pull_requests[0]) && Number.isSafeInteger(raw.pull_requests[0].number) && raw.pull_requests[0].number > 0 ? raw.pull_requests[0].number : null,
  };
  if (!out.event || !out.branch || !out.sha || !out.repo) throw bad("has a field sapu does not read (event, branch, head or repository)");
  return out;
}

/**
 * Run `asked` (null: the newest completed run of the suite's workflow) of `repo`, read through gh → runOf's.
 * Refused: a run id that is not one, a run of another repository, a run from a fork (its artifacts are never read).
 */
export function fetchRun(main, { asked, repo, workflow, runner, verb }) {
  if (asked !== null && !(typeof asked === "string" && RUN_ID.test(asked))) throw new Error(`refused: ${verb}: ${typeof asked === "string" && /^[\x20-\x7e]{1,40}$/.test(asked) ? asked : "that"} is not a run id`);
  let id = asked;
  if (id === null) {
    const list = parse(ghOut(runner, main, ["api", `repos/${repo}/actions/workflows/${workflow}/runs?status=completed&per_page=1`], verb));
    const first = isObj(list) && Array.isArray(list.workflow_runs) ? list.workflow_runs[0] : null;
    if (!isObj(first) || !Number.isSafeInteger(first.id)) throw new Error(`refused: ${verb}: ${workflow} has no completed run`);
    id = String(first.id);
  }
  const r = runOf(parse(ghOut(runner, main, ["api", `repos/${repo}/actions/runs/${id}`], verb)), verb, id);
  if (r.repo !== repo) throw new Error(`refused: ${verb}: run ${id} belongs to another repository, not ${repo}`);
  if (r.headRepo !== repo) throw new Error(`refused: ${verb}: run ${id} comes from a fork: its artifacts are not read`);
  return r;
}

/** Downloads every artifact of run `id` named `prefix…` into a fresh 0700 directory → its path (the caller removes it). */
export function download(main, { id, repo, prefix, runner, verb }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "argus-ci-"));
  const r = runner(["gh", "run", "download", id, "--repo", repo, "--pattern", `${prefix}*`, "--dir", dir], { cwd: main });
  if (r.status !== 0) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(`refused: ${verb}: gh run download exited ${r.status ?? "on a signal"} (no ${prefix} artifact?)`);
  }
  return dir;
}

/** The regular file at `file` (never a link) when it holds at most `max` bytes → its bytes, else null. */
function regular(file, max) {
  let st;
  try {
    st = fs.lstatSync(file);
  } catch {
    return null;
  }
  if (!st.isFile() || st.size > max) return null;
  return fs.readFileSync(file);
}
const isPng = (b) => b !== null && b.length > 8 && b.subarray(0, 8).equals(PNG_SIGNATURE);

/** An attachment's runner path → the file inside artifact `root` (the part after `/test-results/`, each segment a plain name), or null. */
function inArtifact(root, p) {
  if (typeof p !== "string") return null;
  const i = p.lastIndexOf("/test-results/");
  if (i < 0) return null;
  const segs = p.slice(i + 14).split("/");
  if (segs.some((s) => !/^[A-Za-z0-9._-]{1,200}$/.test(s) || /^\.+$/.test(s))) return null;
  return path.join(root, ...segs);
}

/** Every Playwright JSON report in `dir`'s artifacts named `prefix…` → `{reports: [{name, root, json}], skipped: [line]}`. */
function reportsIn(dir, prefix) {
  const reports = [];
  const skipped = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const root = path.join(dir, name);
    if (!ARTIFACT.test(name) || !name.startsWith(prefix) || !fs.lstatSync(root).isDirectory()) continue;
    const file = path.join(root, "results.json");
    let st = null;
    try {
      st = fs.lstatSync(file);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    if (st.size > RESULTS_MAX) {
      skipped.push(`skipped: results.json of ${name} (over ${RESULTS_MAX / MB} MB)`);
      continue;
    }
    const json = parse(fs.readFileSync(file, "utf8"));
    if (!isObj(json) || !Array.isArray(json.suites)) skipped.push(`skipped: results.json of ${name} (not Playwright's JSON report)`);
    else reports.push({ name, root, json });
  }
  return { reports, skipped };
}

/** Every test of a report → `{file, title, tags, project, status, results, root}`, suites walked depth first. */
function testsOf({ json, root }) {
  const out = [];
  const walk = (suite, file) => {
    if (!isObj(suite)) return;
    for (const spec of Array.isArray(suite.specs) ? suite.specs : []) {
      if (!isObj(spec)) continue;
      for (const t of Array.isArray(spec.tests) ? spec.tests : []) {
        if (!isObj(t)) continue;
        out.push({ file: spec.file ?? suite.file ?? file, title: spec.title, tags: Array.isArray(spec.tags) ? spec.tags : [], project: t.projectName, status: t.status, results: Array.isArray(t.results) ? t.results.filter(isObj) : [], root });
      }
    }
    for (const s of Array.isArray(suite.suites) ? suite.suites : []) walk(s, suite.file ?? file);
  };
  for (const s of json.suites) walk(s, null);
  return out;
}

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

/** A result's violations attachment(s) → `{good: [{check, key, detail, manual}], bad}` (bad: entries not in a check's shape). */
function violationsOf(r, root) {
  const good = [];
  let bad = 0;
  for (const a of Array.isArray(r.attachments) ? r.attachments : []) {
    if (!isObj(a) || a.name !== VIOLATIONS) continue;
    let raw = null;
    if (typeof a.body === "string" && a.body.length <= (TEXT_MAX * 4) / 3 + 4) raw = Buffer.from(a.body, "base64");
    else if (a.path) raw = regular(inArtifact(root, a.path) ?? "", TEXT_MAX);
    const list = raw === null ? null : parse(raw.toString("utf8"));
    for (const v of Array.isArray(list) ? list : []) {
      if (!isObj(v) || !CHECK.test(String(v.check)) || typeof v.key !== "string" || !v.key || v.key.length > 500) bad += 1;
      else good.push({ check: v.check, key: v.key, detail: typeof v.detail === "string" ? cap(v.detail, 500) : null, manual: v.status === "manual" });
    }
  }
  return { good, bad };
}

/** The lane's own last pass verdict of journey `id` (the newest cycle's pass.jsonl), or null. */
function lanePass(main, runId, id) {
  if (!runId) return null;
  let text = "";
  try {
    text = fs.readFileSync(path.join(liveDir(main), runId, "smoke", "pass.jsonl"), "utf8");
  } catch {
    return [];
  }
  return text.split("\n").map(parse).filter((r) => isObj(r) && r.id === id);
}

/** True when the suite holds ARIA baseline `rel` at commit `sha` (the working tree's when the clone lacks it). */
function holdsFile(main, sha, rel, runner) {
  if (runner(["git", "-C", main, "cat-file", "-e", `${sha}^{commit}`]).status === 0) return runner(["git", "-C", main, "cat-file", "-e", `${sha}:${rel}`]).status === 0;
  return fs.existsSync(path.join(main, rel));
}

/**
 * One cycle of a quarantined journey (decision 13) → `{entry, action}`: `entry` `{…, cycles, clean}` counted on, the
 * cycle clean when the lane's pass held the path at least twice and nothing else, and at least one quarantine-job
 * result was read and every one passed first time; `action` `exit` at three clean cycles in a row, `drop` at five
 * cycles, else null.
 */
export function quarantineCycle(entry, { held, other, first, otherCi }) {
  const clean = held >= 2 && other === 0 && first >= 1 && otherCi === 0 ? (entry.clean ?? 0) + 1 : 0;
  const next = { ...entry, cycles: (entry.cycles ?? 0) + 1, clean };
  return { entry: next, action: clean >= QUARANTINE_EXIT ? "exit" : next.cycles >= QUARANTINE_MAX ? "drop" : null };
}

/** The suite's quarantine.json → the journey ids it holds with their `since` (`[{id, since}]`); none when missing. */
function quarantined(main, dir, ids) {
  let raw = null;
  try {
    raw = parse(fs.readFileSync(path.join(main, dir, "quarantine.json"), "utf8"));
  } catch {
    raw = null;
  }
  return (Array.isArray(raw) ? raw : []).flatMap((q) => {
    const id = typeof q === "string" ? q : isObj(q) ? q.id : null;
    return ids.includes(id) ? [{ id, since: isObj(q) && typeof q.since === "string" ? q.since : null }] : [];
  });
}

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
 * `aria <id> <n> [k]`; `check <id> <check> [k]`; `manual <id> <check> [k]`; `quarantined <id> <project>: …`;
 * quarantine's lifecycle for the running cycle. Every key, diff and message is printed only in one fence, `[k]`
 * naming its entry. The unfenced lines go to `.argus/smoke-ci/<run>/triage.json` for the report. Exit 3 with a
 * failure, else 2 with a harness line, else 0. `runner` is gh's and git's seam.
 */
export async function smokeCi(main, { run: asked }, { runner = run } = {}) {
  const verb = "smoke ci";
  const { repo, base } = home(main, verb);
  const loaded = loadSmoke(main);
  if (loaded.errors.length) throw new Error(`refused: ${verb}: ${loaded.errors.join("; ")}`);
  const smoke = loaded.smoke ?? SMOKE_DEFAULTS;
  const ids = suiteIds(main, smoke, verb);
  const r = fetchRun(main, { asked, repo, workflow: smoke.ci.workflow, runner, verb });
  const tmp = download(main, { id: r.id, repo, prefix: smoke.ci.artifact, runner, verb });
  try {
    const { reports, skipped } = reportsIn(tmp, smoke.ci.artifact);
    if (!reports.length) throw new Error(`refused: ${verb}: run ${r.id} has no readable results.json in an ${smoke.ci.artifact} artifact`);
    const out = [`smoke ci: run ${r.id} (${r.event} on ${r.branch}, ${r.sha.slice(0, 12)})`];
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
        const q = reads.get(t.title) ?? { first: 0, otherCi: 0 };
        q[first ? "first" : "otherCi"] += 1;
        reads.set(t.title, q);
        add(`quarantined ${t.title} ${t.project}: ${first ? "passed first time" : t.status === "flaky" ? "flaky" : t.status === "expected" ? "passed" : "failed"}`);
        continue;
      }
      if (t.status === "expected" || t.status === "flaky") passed.set(t.title, new Set([...(passed.get(t.title) ?? []), t.project]));
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
            if (n && !holdsFile(main, r.sha, path.posix.join(smoke.dir, "__aria__", id, `${n}.aria.yml`), runner)) add(`baseline-missing ${id} ${project}`);
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
        const v = violationsOf(res, root);
        badViolations += v.bad;
        for (const x of v.good) {
          signal = true;
          const word = x.manual ? "manual" : "check";
          const seen = JSON.stringify([word, id, x.check, x.key]);
          if (violationsSeen.has(seen)) continue;
          violationsSeen.add(seen);
          add(`${word} ${id} ${x.check} [${detail([`${word} ${id} ${x.check} (${project})`, `key: ${JSON.stringify(x.key)}`, ...(x.detail ? [`detail: ${JSON.stringify(x.detail)}`] : [])])}]`);
        }
      }
      for (const [n, got] of shots) add(`visual ${id} ${n} ${project}: ${["expected", "actual", "diff"].filter((k) => got[k]).map((k) => `${k} ${got[k]}`).join(", ")}`);
      const step = failedStep(t.results.at(-1)?.steps);
      if (!step && signal) continue;
      if (project !== "chromium" && (passed.get(id) ?? new Set()).has("chromium")) add(`browser-only ${id} ${project}`);
      else if (!step) add(`failed ${id} ${project}: no path step or check named`);
      else if (step.kind === "expect") add(`bug? ${id} step ${step.n}`);
      else add(`${(lanePass(main, pass, id) ?? []).at(-1)?.verdict === "held" ? "ci-only" : "ui-change?"} ${id} step ${step.n}`);
    }
    // Flakes (decision 13): quarantined only from a push to the base branch.
    const basePush = r.event === "push" && r.branch === base;
    for (const [id, projects] of flakes) {
      const j = { ...(state.journeys[id] ?? {}) };
      const head = `flaky ${id} ${projects.join(",")}`;
      if (basePush) {
        j.baseFlakes = [...new Set([...(j.baseFlakes ?? []), ciRun])].slice(-10);
        if (quarantined(main, smoke.dir, ids).some((q) => q.id === id)) add(`${head}: quarantined already`);
        else {
          const drop = (j.exits ?? 0) >= 1;
          const kind = drop ? "drop" : "quarantine";
          const evidence = [`CI run ${ciRun}: flaky on ${base} (${projects.join(", ")})`];
          const entry = { kind, id, run: ciRun, changes: [{ kind, id, evidence, run: ciRun }], body: changeBody(`${drop ? "Drop" : "Quarantine"}: ${id}`, [...evidence, ...(drop ? ["It left quarantine once already: a second quarantine drops it."] : ["Tagged @quarantine: the gating job skips it, the quarantine job keeps running it."])]) };
          if (!drop) entry.quarantine = { id, issue: null, since: ciRun };
          const s = stageInto(state, entry);
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
    lifecycle(main, { state, smoke, ids, reads, ciRun, add });
    if (outside) add(`skipped: ${outside} test result(s) outside the suite's names and projects`);
    if (badViolations) add(`skipped: ${badViolations} violation(s) not in a check's shape`);
    if (badFiles) add(`skipped: ${badFiles} file(s): not a PNG, over 5 MB, outside the run's test results or not a regular file`);
    for (const s of skipped) add(s);
    add(`smoke ci: ${count.failing} failing, ${count.flaky} flaky, ${count.harness} harness, ${count.quarantined} quarantined read`);
    writeState(main, state);
    const at = path.join(main, ".argus", "smoke-ci", ciRun);
    fs.mkdirSync(at, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(at, "triage.json"), `${JSON.stringify({ run: Number(ciRun), event: r.event, branch: r.branch, sha: r.sha, lines: out }, null, 2)}\n`, { mode: 0o600 });
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
 * counted once a cycle (quarantineCycle, from the cycle's pass and this run's quarantine-job `reads`); an exit or
 * a drop is staged. No cycle → one line, nothing counted.
 */
function lifecycle(main, { state, smoke, ids, reads, ciRun, add }) {
  const list = quarantined(main, smoke.dir, ids);
  if (!list.length) return;
  const lock = readLock(main);
  if (!lock) {
    add("quarantine: no journey cycle is running; streaks unchanged");
    return;
  }
  for (const { id, since } of list) {
    const j = { ...(state.journeys[id] ?? {}) };
    const q = j.quarantine ?? { since, cycles: 0, clean: 0, counted: [] };
    const where = (x) => `cycle ${x.cycles} of ${QUARANTINE_MAX}, clean streak ${x.clean} of ${QUARANTINE_EXIT}`;
    if ((q.counted ?? []).includes(lock.runId)) {
      add(`quarantine ${id}: ${where(q)} (this cycle is counted)`);
      continue;
    }
    const recs = lanePass(main, lock.runId, id) ?? [];
    const held = recs.filter((x) => x.verdict === "held").length;
    const ci = reads.get(id) ?? { first: 0, otherCi: 0 };
    const { entry, action } = quarantineCycle(q, { held, other: recs.length - held, ...ci });
    entry.counted = [...(q.counted ?? []), lock.runId].slice(-10);
    j.quarantine = entry;
    if (!action) add(`quarantine ${id}: ${where(entry)}`);
    else {
      const kind = action === "exit" ? "unquarantine" : "drop";
      const evidence = [action === "exit" ? `${QUARANTINE_EXIT} clean cycles in a row: the lane's pass held it twice and every quarantine-job result passed first time` : `quarantined for ${QUARANTINE_MAX} cycles`];
      const s = stageInto(state, { kind, id, run: ciRun, changes: [{ kind, id, evidence, run: ciRun }], body: changeBody(`${action === "exit" ? "Leave quarantine" : "Drop"}: ${id}`, evidence) });
      const d = s.digest.slice(0, 12);
      if (!s.staged) add(`quarantine ${id}: ${kind} not staged (rejected before; digest ${d})`);
      else if (action === "exit") {
        j.quarantine = null;
        j.exits = (j.exits ?? 0) + 1;
        add(`quarantine ${id}: exit staged (${QUARANTINE_EXIT} clean cycles; digest ${d})`);
      } else add(`drop ${id}: staged (quarantined for ${QUARANTINE_MAX} cycles; digest ${d})`);
    }
    state.journeys[id] = j;
  }
}

/** Run `r`'s branch must still be at its head (spec §19.8: a stale run's files are never adopted or re-run). */
function notStale(main, { r, repo, runner, verb }) {
  let b = null;
  try {
    b = parse(ghOut(runner, main, ["api", `repos/${repo}/branches/${encodeURIComponent(r.branch)}`], verb));
  } catch {
    throw new Error(`refused: ${verb}: branch ${r.branch} of run ${r.id} is gone`);
  }
  if (!isObj(b) || !isObj(b.commit) || b.commit.sha !== r.sha) throw new Error(`refused: ${verb}: run ${r.id} is stale: ${r.branch} has moved past its head ${r.sha.slice(0, 12)}`);
}

/** A string with every digit run as `\d+` and the marker as its shape, as a YAML regex `/…/`. */
const toRegex = (s) => `/${s.split(/(argus-[0-9a-z]+|[0-9]+)/).map((p, i) => (i % 2 ? (p.startsWith("argus-") ? "argus-[0-9a-z]+" : "\\d+") : p.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"))).join("")}/`;
const ruled = (s) => /[0-9]/.test(s) || /argus-[0-9a-z]+/.test(s);
/** A quoted YAML name: a regex when it holds a digit or the marker, else as it was. */
function quoted(q) {
  let s;
  try {
    s = JSON.parse(q);
  } catch {
    return q;
  }
  return typeof s === "string" && ruled(s) ? toRegex(s) : q;
}

/**
 * An adopted ARIA snapshot pruned (spec §19.7): every name or text holding a digit — quoted, or a line's unquoted
 * value — becomes a regex with each digit run as `\d+` and the marker as `argus-[0-9a-z]+`; regexes stay.
 */
export function pruneAria(text) {
  return text.split("\n").map((line) => {
    const m = /^(\s*- )(\/[a-z]+)?(.*)$/.exec(line);
    if (!m) return line;
    const [, lead, prop = "", rest] = m;
    let out = "";
    for (let i = 0; i < rest.length; ) {
      const tail = rest.slice(i);
      const q = tail[0] === '"' ? /^"(?:[^"\\]|\\.)*"/.exec(tail) : tail[0] === "/" ? /^\/(?:[^/\\]|\\.)*\//.exec(tail) : null;
      if (q) {
        out += q[0][0] === '"' ? quoted(q[0]) : q[0];
        i += q[0].length;
      } else if (tail.startsWith(": ")) {
        const v = tail.slice(2);
        return `${lead}${prop}${out}: ${v.startsWith('"') ? v.replace(/^"(?:[^"\\]|\\.)*"/, quoted) : /^\/.*\/$/.test(v) || !ruled(v) ? v : toRegex(v)}`;
      } else out += rest[i++];
    }
    return `${lead}${prop}${out}`;
  }).join("\n");
}

/** Every regular file under `dir` (no link followed, at most 6 levels) → paths relative to it, `/`-joined. */
function filesIn(dir, rel = "", depth = 0) {
  if (depth > 6) return [];
  return fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((e) => {
    const r = rel ? `${rel}/${e.name}` : e.name;
    return e.isDirectory() ? filesIn(dir, r, depth + 1) : e.isFile() ? [r] : [];
  });
}

/**
 * The baseline artifacts in `tmp` → `{files: [{rel, bytes, id, step, project}], skipped}`: only the suite's baseline
 * names (spec §19.8) — `__screenshots__/<project>/<platform>/<id>/<n>.png` (a PNG under 5 MB, never msedge's),
 * `__aria__/<id>/<n>.aria.yml` (UTF-8 under 1 MB, pruned) and `violations-<id>.json` (under 1 MB, `known/<id>.json`
 * as sorted `{check, key}`) — of journeys in `ids`; everything else is skipped unread.
 */
function adoptable(tmp, { ids, dir }) {
  const files = new Map();
  let skipped = 0;
  for (const art of fs.readdirSync(tmp).sort()) {
    if (!ARTIFACT.test(art) || !art.startsWith(BASELINES) || !fs.lstatSync(path.join(tmp, art)).isDirectory()) continue;
    const suffix = art.slice(BASELINES.length + 1);
    for (const rel of filesIn(path.join(tmp, art))) {
      const file = path.join(tmp, art, ...rel.split("/"));
      const shot = /^__screenshots__\/([a-z0-9-]{1,40})\/(linux|darwin|win32)\/([a-z0-9][a-z0-9-]{0,63})\/([a-z0-9][a-z0-9-]{0,63})\.png$/.exec(rel);
      const aria = /^__aria__\/([a-z0-9][a-z0-9-]{0,63})\/([a-z0-9][a-z0-9-]{0,63})\.aria\.yml$/.exec(rel);
      const known = /^violations-([a-z0-9][a-z0-9-]{0,63})\.json$/.exec(rel);
      const id = shot ? shot[3] : aria ? aria[1] : known ? known[1] : null;
      let entry = null;
      if (id && ids.includes(id) && shot && PROJECT.test(shot[1]) && !["msedge", "setup"].includes(shot[1])) {
        const bytes = regular(file, PNG_MAX);
        if (isPng(bytes)) entry = { rel, bytes, id, step: shot[4], project: shot[1] };
      } else if (id && ids.includes(id) && aria) {
        const bytes = regular(file, TEXT_MAX);
        const text = bytes && bytes.toString("utf8");
        if (text !== null && Buffer.from(text, "utf8").equals(bytes)) entry = { rel, bytes: Buffer.from(pruneAria(text)), original: text, id, step: aria[2], project: PROJECT.test(suffix) ? suffix : null };
      } else if (id && ids.includes(id) && known) {
        const bytes = regular(file, TEXT_MAX);
        const list = bytes && parse(bytes.toString("utf8"));
        if (Array.isArray(list)) {
          const keep = [...new Map(list.filter((v) => isObj(v) && CHECK.test(String(v.check)) && typeof v.key === "string" && v.key && v.key.length <= 500).map((v) => [JSON.stringify([v.check, v.key]), { check: v.check, key: v.key }])).values()].sort((a, b) => (a.check + a.key < b.check + b.key ? -1 : 1));
          entry = { rel: `known/${id}.json`, bytes: Buffer.from(`${JSON.stringify(keep, null, 2)}\n`), id, step: null, project: PROJECT.test(suffix) ? suffix : null };
        }
      }
      if (!entry || files.has(entry.rel)) skipped += entry ? 0 : 1;
      else files.set(entry.rel, { ...entry, rel: path.posix.join(dir, entry.rel) });
    }
  }
  return { files: [...files.values()], skipped };
}

/** git in `cwd` through `runner` → stdout, or a refusal naming `verb` and the git command. */
function gitOut(runner, cwd, args, verb) {
  const r = runner(["git", "-C", cwd, ...args]);
  if (r.status !== 0) throw new Error(`refused: ${verb}: git ${args[0]} exited ${r.status ?? "on a signal"}`);
  return String(r.stdout ?? "").trim();
}

/**
 * Baseline run `r`'s files committed (spec §19.8): on the run's own `argus/` branch, else on a new
 * `argus/baselines-<run>` branch from its head with a pull request into the run's branch (its body a table of each
 * file's journey, step and project, labelled agent-filed). Every text file and the body pass scrub's matcher first.
 */
function adopt(main, { r, repo, contract, smoke, ids, runner, verb }) {
  const tmp = download(main, { id: r.id, repo, prefix: BASELINES, runner, verb });
  let adopted;
  try {
    adopted = adoptable(tmp, { ids, dir: smoke.dir });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const { files, skipped } = adopted;
  const skip = skipped ? [`skipped: ${skipped} file(s) outside the suite's baseline names, msedge's, not a PNG or over their size`] : [];
  if (!files.length) return { code: 2, lines: [`baseline: run ${r.id} wrote nothing sapu adopts`, ...skip] };
  const direct = r.branch.startsWith("argus/");
  const dest = direct ? r.branch : `argus/baselines-${r.id}`;
  const row = (f) => `| \`${f.rel}\` | ${f.id} | ${f.step && /^[0-9]+$/.test(f.step) ? f.step : "—"} | ${f.project ?? "—"} |`;
  const body = [`argus smoke: the baselines CI's baseline run ${r.id} wrote on \`${r.branch}\` (${r.sha.slice(0, 12)}), for review in this pull request's image view (2-up, swipe, onion skin). Merging accepts them; a test fails until its baseline is accepted.`, "", "| file | journey | step | project |", "|---|---|---|---|", ...files.map(row), ""].join("\n");
  const changes = files.map((f) => JSON.stringify({ kind: "baseline", id: f.id, ...(f.step && /^[0-9]+$/.test(f.step) ? { step: Number(f.step) } : {}), to: f.rel, evidence: [`CI baseline run ${r.id} (${f.project ?? "baseline job"})`], run: r.id }));
  const { secrets, refusal } = scrubSecrets(main, { runId: lastRun(main) });
  if (refusal) throw new Error(`refused: ${verb}: ${refusal.replace(/^refused: (scrub: )?/, "")}`);
  const hits = [];
  for (const [name, text] of [...files.filter((f) => !f.rel.endsWith(".png")).flatMap((f) => [[f.rel, f.original ?? f.bytes.toString("utf8")], [f.rel, f.bytes.toString("utf8")]]), ["the pull request's body", body]]) {
    for (const h of secretHits(text, secrets)) hits.push(`${name} ${h.line}:${h.col} ${h.cls}`);
  }
  if (hits.length) return { code: 1, lines: [...new Set(hits), `refused: ${verb}: ${new Set(hits).size} secret(s) in the adopted files; nothing is pushed`] };
  const wtRoot = fs.mkdtempSync(path.join(os.tmpdir(), "argus-baseline-"));
  const wt = path.join(wtRoot, "wt");
  try {
    gitOut(runner, main, ["fetch", "-q", "--no-tags", "origin", `refs/heads/${r.branch}`], verb);
    if (gitOut(runner, main, ["rev-parse", "FETCH_HEAD"], verb) !== r.sha) throw new Error(`refused: ${verb}: run ${r.id} is stale: ${r.branch} has moved past its head ${r.sha.slice(0, 12)}`);
    gitOut(runner, main, ["worktree", "add", "-q", "--detach", wt, r.sha], verb);
    for (const f of files) {
      fs.mkdirSync(path.dirname(path.join(wt, f.rel)), { recursive: true });
      fs.writeFileSync(path.join(wt, f.rel), f.bytes);
    }
    fs.appendFileSync(path.join(wt, smoke.dir, "changes.jsonl"), `${changes.join("\n")}\n`);
    gitOut(runner, wt, ["add", "-A", "--", smoke.dir], verb);
    const who = ["-c", `user.name=${contract.ghUser}`, "-c", `user.email=${contract.gitEmail}`, "-c", "commit.gpgsign=false"];
    gitOut(runner, wt, [...who, "commit", "-q", "-m", `argus: smoke baselines from CI run ${r.id}`, "-m", `${files.length} file(s) the baseline job wrote on ${r.branch}, adopted by name and shape.`, "-m", `Signed-off-by: ${contract.ghUser} <${contract.gitEmail}>`], verb);
    const sha = gitOut(runner, wt, ["rev-parse", "HEAD"], verb);
    gitOut(runner, wt, ["push", "-q", "origin", `HEAD:refs/heads/${dest}`], verb);
    if (direct) return { code: 0, lines: [`baseline: committed ${files.length} file(s) to ${dest} (${sha.slice(0, 12)})`, ...skip] };
    const bodyFile = path.join(wtRoot, "body.md");
    fs.writeFileSync(bodyFile, body, { mode: 0o600 });
    const pr = runner(["gh", "pr", "create", "--repo", repo, "--base", r.branch, "--head", dest, "--title", `argus: smoke baselines from CI run ${r.id}`, "--body-file", bodyFile, "--label", agentFiledLabel(contract)], { cwd: main });
    const url = /https:\/\/\S+\/pull\/[0-9]+/.exec(String(pr.stdout ?? ""));
    if (!url) return { code: 2, lines: [`baseline: pushed ${dest} (${sha.slice(0, 12)}); gh pr create exited ${pr.status ?? "on a signal"} before printing a pull request URL`, ...skip] };
    return { code: 0, lines: [`baseline: ${files.length} file(s) proposed in ${url[0]} (${dest} into ${r.branch})`, ...skip] };
  } finally {
    runner(["git", "-C", main, "worktree", "remove", "--force", wt]);
    fs.rmSync(wtRoot, { recursive: true, force: true });
  }
}

/**
 * `smoke baseline --from-run <id> [--ids <id>,…]` → `{code, lines}` (spec §19.8, decision 7). Run `fromRun` of the
 * contract's home repo, refused from a fork or another repository, or stale (its branch moved past its head).
 * - A baseline run (`workflow_dispatch`): its `argus-smoke-baselines…` artifacts adopted by name and shape (of `ids`
 *   only, when given) and committed as `adopt` says.
 * - A normal run, triaged by `smoke ci` first: the workflow's baseline job dispatched on the run's branch, `missing`
 *   for its `baseline-missing` journeys and `changed` for exactly `ids` (each with a visual or ARIA mismatch; no
 *   mismatch is re-baselined unasked) → `baseline: dispatched <ids> mode=<m>; adopt with smoke baseline --from-run
 *   <new run>`. Without the right to dispatch, the `gh workflow run` line is printed for the owner (code 2).
 */
export async function smokeBaseline(main, { fromRun, ids }, { runner = run } = {}) {
  const verb = "smoke baseline";
  if (fromRun === null || fromRun === undefined) throw new Error(`refused: ${verb}: --from-run <run id> names the CI run`);
  const { repo, contract } = home(main, verb);
  const loaded = loadSmoke(main);
  if (loaded.errors.length) throw new Error(`refused: ${verb}: ${loaded.errors.join("; ")}`);
  const smoke = loaded.smoke ?? SMOKE_DEFAULTS;
  const suite = suiteIds(main, smoke, verb);
  for (const id of ids ?? []) if (!suite.includes(id)) throw new Error(`refused: ${verb}: the suite has no path ${/^[a-z0-9-]{1,64}$/.test(id) ? id : "that"}`);
  const r = fetchRun(main, { asked: fromRun, repo, workflow: smoke.ci.workflow, runner, verb });
  notStale(main, { r, repo, runner, verb });
  if (r.event === "workflow_dispatch") return adopt(main, { r, repo, contract, smoke, ids: ids ?? suite, runner, verb });
  let triage = null;
  try {
    triage = parse(fs.readFileSync(path.join(main, ".argus", "smoke-ci", r.id, "triage.json"), "utf8"));
  } catch {
    triage = null;
  }
  if (!isObj(triage) || !Array.isArray(triage.lines)) throw new Error(`refused: ${verb}: run ${r.id} is not triaged yet (smoke ci --run ${r.id} first)`);
  const of = (re) => [...new Set(triage.lines.flatMap((l) => (typeof l === "string" && re.exec(l) ? [re.exec(l)[1]] : [])).filter((id) => suite.includes(id)))].sort();
  const missing = of(/^baseline-missing ([a-z0-9-]+) /);
  const mismatched = of(/^(?:visual|aria) ([a-z0-9-]+) /);
  for (const id of ids ?? []) if (!mismatched.includes(id)) throw new Error(`refused: ${verb}: ${id} has no visual or ARIA mismatch in run ${r.id}: nothing to re-baseline`);
  const jobs = [["missing", missing], ["changed", [...(ids ?? [])].sort()]].filter(([, x]) => x.length);
  if (!jobs.length) return { code: 0, lines: [`baseline: nothing to dispatch (run ${r.id} has no baseline-missing journey; a mismatch is re-baselined only with --ids)`] };
  const lines = [];
  let code = 0;
  for (const [mode, list] of jobs) {
    const argv = ["workflow", "run", smoke.ci.workflow, "--repo", repo, "--ref", r.branch, "-f", `baseline=${mode}`, "-f", `grep=${list.join("|")}`];
    const d = runner(["gh", ...argv], { cwd: main });
    if (d.status === 0) {
      const id = /\/actions\/runs\/([0-9]{1,20})/.exec(String(d.stdout ?? ""));
      lines.push(`baseline: dispatched ${list.join(",")} mode=${mode}; adopt with smoke baseline --from-run ${id ? id[1] : `<the new run> (gh run list --workflow ${smoke.ci.workflow} --event workflow_dispatch --branch ${r.branch})`}`);
    } else {
      code = 2;
      const shown = `gh ${argv.slice(0, -1).join(" ")} grep='${list.join("|")}'`;
      if (/HTTP 403|HTTP 404|not accessible|scope|permission|admin rights/i.test(String(d.stderr ?? ""))) lines.push("baseline: no right to dispatch the workflow (it needs write access and the actions scope); the owner runs:", shown);
      else lines.push(`failed: gh workflow run exited ${d.status ?? "on a signal"}; the owner may run:`, shown);
    }
  }
  return { code, lines };
}
