// argus-live-artifacts.mjs — the suite's CI runs and their artifacts, read by name and shape (spec §19.8, §19.9):
// the contract's home, the run and its fork check, the downloads, results.json's tests and their check annotations,
// the suite's ids at a run's own commit, and `.argus/smoke-ci/<run>/triage.json` (written by smoke ci, read by smoke
// baseline and the report). Below -ci.mjs and -baseline.mjs, which both read CI through it. Artifact text is untrusted.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PROJECT as SMOKE_PROJECT, readSuitePaths } from "./argus-live-smoke.mjs";
import { readState } from "./argus-live-suite.mjs";
import { loadContract } from "./sapu-contract.mjs";

/** A GitHub Actions run id. */
export const RUN_ID = /^[1-9][0-9]{0,19}$/;
/** The suite's project names (spec §19.6): anything else in a report is not read. */
export const PROJECT = SMOKE_PROJECT;
/** A check's name (spec §19.7): a custom check's, or axe's rule as `axe:<rule>`. */
export const CHECK = /^(axe:)?[a-z][a-z0-9-]{0,39}$/;
export const ARTIFACT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
export const BRANCH = /^[A-Za-z0-9._/-]{1,200}$/;
const NWO = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MB = 1024 * 1024;
const RESULTS_MAX = 16 * MB;
export const PNG_MAX = 5 * MB;
export const TEXT_MAX = MB;
/** The check annotations a suite test carries in results.json (spec §19.7, lanes C1 and C2) → the triage word they print as. */
const NOTES = new Map([["argus-violation", "check"], ["argus-manual", "manual"], ["argus-info", "info"]]);
/** The baseline job's artifacts (spec §19.8). */
export const BASELINES = "argus-smoke-baselines";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
/** `s` parsed as JSON, or null. */
const parse = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};
const cap = (s, n = 4000) => (s.length > n ? `${s.slice(0, n)} …` : s);

/** The contract's home repo and base branch, or a refusal naming `verb`. */
export function home(main, verb) {
  const { contract } = loadContract(main);
  if (!contract || !NWO.test(String(contract.repo)) || !BRANCH.test(String(contract.baseBranch))) throw new Error(`refused: ${verb}: the committed contract names no home repo and base branch`);
  return { repo: contract.repo, base: contract.baseBranch, contract };
}

/** The CI wiring's absence (no `.github/workflows/<ci.workflow>` in the checkout) → the line a verb answers with, else null: CI is optional. */
export function noWiring(main, smoke, verb) {
  const rel = `.github/workflows/${smoke.ci.workflow}`;
  return fs.existsSync(path.join(main, rel)) ? null : { code: 0, lines: [`${verb}: no CI wiring (${rel} is absent): skipped`] };
}

/**
 * Refuses before gh is asked anything when there is nothing to triage or adopt: the working tree's suite has no path
 * and no proposal is open (an open one may add the first paths, which only its CI run holds).
 */
export function anySuite(main, smoke, verb) {
  if (readSuitePaths(main, smoke.dir).length) return;
  if (Object.values(readState(main).proposals ?? {}).some((p) => isObj(p) && p.outcome === "open")) return;
  throw new Error(`refused: ${verb}: the suite has no paths (${smoke.dir}/journeys)`);
}

/**
 * The suite's journey ids at run `r`'s own commit (`git ls-tree` of `<dir>/journeys` at its head: a pull request that
 * adds a journey runs that journey's test), the commit fetched from origin when the clone lacks it → `{ids, notes}`.
 * A head no fetch can bring falls back to the working tree's suite, with a note saying so.
 */
export function suiteIdsAt(main, { r, dir, runner }) {
  const has = () => runner(["git", "-C", main, "cat-file", "-e", `${r.sha}^{commit}`]).status === 0;
  if (!has()) runner(["git", "-C", main, "fetch", "-q", "--no-tags", "origin", `refs/heads/${r.branch}`]);
  if (!has()) runner(["git", "-C", main, "fetch", "-q", "--no-tags", "origin", r.sha]);
  if (!has()) return { ids: readSuitePaths(main, dir).map((p) => p.id), notes: [`note: run ${r.id}'s head ${r.sha.slice(0, 12)} is not in this clone: the suite's ids are the working tree's`] };
  const ls = runner(["git", "-C", main, "ls-tree", "--name-only", `${r.sha}:${dir}/journeys`]);
  const names = ls.status === 0 ? String(ls.stdout ?? "").split("\n") : [];
  return { ids: names.filter((f) => /^[a-z0-9][a-z0-9-]{0,63}\.json$/.test(f)).map((f) => f.slice(0, -5)).sort(), notes: [] };
}

/** `gh <argv>` through `runner` → stdout, or a refusal naming `verb` (gh's own words never printed). */
export function ghOut(runner, main, argv, verb) {
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
 * Run `asked` (null: the newest completed push run of the suite's workflow on `base`) of `repo`, read through gh → runOf's.
 * Refused: a run id that is not one, a run of another repository, a run from a fork (its artifacts are never read).
 */
export function fetchRun(main, { asked, repo, base, workflow, runner, verb }) {
  if (asked !== null && !(typeof asked === "string" && RUN_ID.test(asked))) throw new Error(`refused: ${verb}: ${typeof asked === "string" && /^[\x20-\x7e]{1,40}$/.test(asked) ? asked : "that"} is not a run id`);
  let id = asked;
  if (id === null) {
    // The base branch's newest push: the run a flake is quarantined from and a quarantine's cycle is counted on.
    const list = parse(ghOut(runner, main, ["api", `repos/${repo}/actions/workflows/${workflow}/runs?status=completed&event=push&branch=${encodeURIComponent(base)}&per_page=1`], verb));
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
export function regular(file, max) {
  let st;
  try {
    st = fs.lstatSync(file);
  } catch {
    return null;
  }
  if (!st.isFile() || st.size > max) return null;
  return fs.readFileSync(file);
}
export const isPng = (b) => b !== null && b.length > 8 && b.subarray(0, 8).equals(PNG_SIGNATURE);

/** An attachment's runner path → the file inside artifact `root` (the part after `/test-results/`, each segment a plain name), or null. */
export function inArtifact(root, p) {
  if (typeof p !== "string") return null;
  const i = p.lastIndexOf("/test-results/");
  if (i < 0) return null;
  const segs = p.slice(i + 14).split("/");
  if (segs.some((s) => !/^[A-Za-z0-9._-]{1,200}$/.test(s) || /^\.+$/.test(s))) return null;
  return path.join(root, ...segs);
}

/** Every Playwright JSON report in `dir`'s artifacts named `prefix…` → `{reports: [{name, root, json}], skipped: [line]}`. */
export function reportsIn(dir, prefix) {
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
export function testsOf({ json, root }) {
  const out = [];
  const walk = (suite, file) => {
    if (!isObj(suite)) return;
    for (const spec of Array.isArray(suite.specs) ? suite.specs : []) {
      if (!isObj(spec)) continue;
      for (const t of Array.isArray(spec.tests) ? spec.tests : []) {
        if (!isObj(t)) continue;
        out.push({ file: spec.file ?? suite.file ?? file, title: spec.title, tags: Array.isArray(spec.tags) ? spec.tags : [], project: t.projectName, status: t.status, results: Array.isArray(t.results) ? t.results.filter(isObj) : [], annotations: Array.isArray(t.annotations) ? t.annotations : [], root });
      }
    }
    for (const s of Array.isArray(suite.suites) ? suite.suites : []) walk(s, suite.file ?? file);
  };
  for (const s of json.suites) walk(s, null);
  return out;
}

/**
 * A suite test's check annotations (its results', else its own) → `{good: [{word, check, step, key, detail}], bad}`:
 * `argus-violation` (word `check`) and `argus-manual` (`manual`) hold JSON `{check, step, key, detail}` (bad: not in a
 * check's shape), `argus-info` a report line (`info`, the line its detail). Keys and details are page text: fenced.
 */
export function notesOf(t) {
  const all = t.results.some((r) => Array.isArray(r.annotations)) ? t.results.flatMap((r) => (Array.isArray(r.annotations) ? r.annotations : [])) : t.annotations;
  const good = [];
  let bad = 0;
  for (const a of all) {
    const word = isObj(a) ? NOTES.get(a.type) : undefined;
    if (!word || typeof a.description !== "string" || a.description.length > TEXT_MAX) continue;
    const v = word === "info" ? { check: "info", key: "-", detail: a.description } : parse(a.description);
    if (!isObj(v) || !CHECK.test(String(v.check)) || typeof v.key !== "string" || !v.key || v.key.length > 500) bad += 1;
    else good.push({ word, check: v.check, step: Number.isInteger(v.step) ? v.step : null, key: v.key, detail: typeof v.detail === "string" ? cap(v.detail, 500) : null });
  }
  return { good, bad };
}

// ---------------------------------------------------------------------------------------------------
// `.argus/smoke-ci/<CI run>/triage.json`: smoke ci writes it, smoke baseline and the report read it (readTriage).

const TRIAGE_VERSION = 1;
const ID = "([a-z0-9][a-z0-9-]{0,63})";
const PROJ = "([a-z0-9-]{1,40})";
/** The unfenced line shapes that are findings → their structured form (the words around them may change). */
const FINDINGS = [
  [new RegExp(`^baseline-missing ${ID} ${PROJ}$`), (m) => ({ kind: "baseline-missing", id: m[1], project: m[2] })],
  [new RegExp(`^visual ${ID} ([0-9]{1,3}) ${PROJ}: `), (m) => ({ kind: "visual", id: m[1], step: Number(m[2]), project: m[3] })],
  [new RegExp(`^aria ${ID} ([0-9]{1,3}|\\?) \\[`), (m) => ({ kind: "aria", id: m[1], step: m[2] === "?" ? null : Number(m[2]) })],
  [new RegExp(`^(check|manual) ${ID} ((?:axe:)?[a-z][a-z0-9-]{0,39}) \\[`), (m) => ({ kind: m[1], id: m[2], check: m[3] })],
  [new RegExp(`^info ${ID} ${PROJ} \\[`), (m) => ({ kind: "info", id: m[1], project: m[2] })],
  [new RegExp(`^flaky ${ID} ([a-z0-9,-]{1,200}): `), (m) => ({ kind: "flaky", id: m[1], projects: m[2].split(",") })],
  [new RegExp(`^flaky-new ${ID} ([0-9]{1,10})$`), (m) => ({ kind: "flaky-new", id: m[1], pr: Number(m[2]) })],
  [new RegExp(`^(ui-change\\?|bug\\?|ci-only) ${ID} step ([0-9]{1,3})$`), (m) => ({ kind: m[1], id: m[2], step: Number(m[3]) })],
  [new RegExp(`^(browser-only|failed|quarantined) ${ID} ${PROJ}(?:: |$)`), (m) => ({ kind: m[1], id: m[2], project: m[3] })],
  [new RegExp(`^pending-regression ${ID} `), (m) => ({ kind: "pending-regression", id: m[1] })],
  [/^harness setup ([a-z][a-z0-9_-]*\.[0-9]{1,3}): /, (m) => ({ kind: "harness", account: m[1] })],
];
/** `lines`' findings, in order. */
const findingsOf = (lines) => lines.flatMap((l) => {
  for (const [re, f] of FINDINGS) {
    const m = typeof l === "string" ? re.exec(l) : null;
    if (m) return [f(m)];
  }
  return [];
});

/** Writes CI run `r`'s triage (0600): `{version, run, event, branch, sha, lines, findings}`. */
export function writeTriage(main, r, lines) {
  const at = path.join(main, ".argus", "smoke-ci", r.id);
  fs.mkdirSync(at, { recursive: true, mode: 0o700 });
  const doc = { version: TRIAGE_VERSION, run: Number(r.id), event: r.event, branch: r.branch, sha: r.sha, lines, findings: findingsOf(lines) };
  fs.writeFileSync(path.join(at, "triage.json"), `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
}

/**
 * CI run `ciRun`'s triage → `{version, run, event, branch, sha, lines, findings}`, every field shape-checked, or null
 * (none, unreadable, another version or shape). One written before the version (no `version`) has its findings
 * read from its lines. The one reader: smoke baseline's input, the report's "newest smoke ci summary".
 */
export function readTriage(main, ciRun) {
  if (!RUN_ID.test(String(ciRun))) return null;
  const t = parse((() => {
    try {
      return fs.readFileSync(path.join(main, ".argus", "smoke-ci", String(ciRun), "triage.json"), "utf8");
    } catch {
      return "";
    }
  })());
  const ok = isObj(t) && (t.version === undefined || t.version === TRIAGE_VERSION) && Number.isSafeInteger(t.run) && t.run > 0 && /^[a-z_]{1,40}$/.test(String(t.event)) && BRANCH.test(String(t.branch)) && Array.isArray(t.lines) && t.lines.every((l) => typeof l === "string");
  if (!ok) return null;
  const findings = Array.isArray(t.findings) ? t.findings.filter((f) => isObj(f) && typeof f.kind === "string") : findingsOf(t.lines);
  return { version: TRIAGE_VERSION, run: t.run, event: t.event, branch: t.branch, sha: typeof t.sha === "string" ? t.sha : null, lines: t.lines, findings };
}
