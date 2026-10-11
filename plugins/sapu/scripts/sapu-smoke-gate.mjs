#!/usr/bin/env node
// sapu-smoke-gate.mjs — whether the argus smoke suite's CI run on a PR's head blocks its merge (CONTRACT.md
// §`sapu-merge.sh`, `gate.smokeCheck`). sapu-merge.sh asks it only when the contract on origin/<base> opts in.
//
// WHAT IS READ. Everything that decides comes from the base commit (`--base-ref`, the freshly fetched
// origin/<base>) or from GitHub, not from the PR's tree (but its quarantine.json, by shape, for escape (a)):
// `.argus/smoke.json` (the suite's `dir`, `ci.workflow` and `ci.artifact`; absent = their defaults), the workflow file itself (absent = no CI wiring, not a block) and the
// suite's `quarantine.json`. The run is the newest `pull_request` run of that workflow on the PR's head, in this
// repository; its jobs as GitHub concluded them. The `quarantine` jobs never gate (they run what the gating jobs
// skip) and `baseline` runs only on dispatch.
//
// THE ESCAPES. A red run does not block when every gating job that failed is a journey job (`test (<project>)`,
// `msedge`) whose results name failing journeys only, each one excused: (a) the PR proposes its fix (it changes
// the journey's own `<dir>/<id>.spec.ts`, a heal, or its `<dir>/quarantine.json`, read at the PR's head, lists
// the journey, a quarantine proposal), (b) it is quarantined on the base commit, or (c) the PR closes the issue
// the smoke cycle filed for it: open, `smoke-regression:<id>` in its title, the lane's `bug` and `regression`
// labels, authored by an id in the trusted set (sapu-contract.mjs resolveTrusted). Anything else red (taste, a
// sign-in that failed, a cancelled or timed-out job, a failure no journey explains) blocks, whatever the PR
// changes. A PR that changes the smoke workflow itself (`.github/workflows/<ci.workflow>` as the base names it)
// is red before any run is read: its own run cannot clear it. THE OWNER OVERRIDE: any red is excused when the
// PR carries `smoke-override` and the latest event that applied or removed it applied it, by an id in the
// trusted set (the issue events API names the actor). Artifact and issue text is untrusted: only names and shapes
// are read, and nothing from it is printed but journey ids.
//
// CLI (stdout: one JSON verdict; exit 1 with a one-line reason when it cannot judge — the caller fails closed):
//   node sapu-smoke-gate.mjs --main <dir> --repo <owner/name> --base-ref <sha> --sha <sha> --pr <n>
//                            [--closes <n>,…] [--wait <minutes>]
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { download, ghOut, reportsIn, testsOf } from "./argus-live-artifacts.mjs";
import { run } from "./argus-live-proc.mjs";
import { quarantineOf } from "./argus-live-smoke.mjs";
import { SMOKE_DEFAULTS, SMOKE_FILE, validateSmoke } from "./argus-live-smokecfg.mjs";
import { loadContract, resolveTrusted } from "./sapu-contract.mjs";

const VERB = "smoke check";
const JOURNEY = /^[a-z0-9][a-z0-9-]{0,63}$/;
const NWO = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
const SHA = /^[0-9a-f]{40}$/;
/** A job conclusion that is a pass. */
const PASS = new Set(["success", "skipped", "neutral"]);
/** GitHub lists at most this many files of a pull request: a list that long may be cut short. */
const FILES_MAX = 3000;
const POLL_MS = 30_000;
const GRACE_MS = 90_000;
/** The PR label by which a trusted account lets a red smoke check through (a deadlock the escapes cannot clear). */
const OVERRIDE_LABEL = "smoke-override";
/** The labels the smoke cycle files a smoke-regression issue with (skills/journey/smoke.md, Filing). */
const REGRESSION_LABELS = ["bug", "regression"];

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const parse = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};
/** A job's name as printed: GitHub's, when it has a job name's shape. */
const shown = (name) => (typeof name === "string" && /^[A-Za-z0-9 ()._,:-]{1,100}$/.test(name) ? name : "a job");
/** A gating journey job → its project (`test (<project>)` or `msedge`), else null. */
const projectOf = (name) => (name === "msedge" ? "msedge" : (/^test \(([a-z0-9-]{1,40})\)$/.exec(String(name)) ?? [])[1] ?? null);

/** The blob `rel` at commit `ref` → its text, or null when the commit lacks it. */
function blob(runner, main, ref, rel) {
  const r = runner(["git", "-C", main, "cat-file", "blob", `${ref}:${rel}`]);
  return r.status === 0 ? String(r.stdout ?? "") : null;
}

/** The suite's settings on the base commit: smoke.json's, else the defaults; an invalid file refuses. */
function settings(runner, main, ref) {
  const text = blob(runner, main, ref, SMOKE_FILE);
  if (text === null) return SMOKE_DEFAULTS;
  const { value, errors } = validateSmoke(parse(text));
  if (!value) throw new Error(`refused: ${VERB}: ${SMOKE_FILE} on the base commit is not valid: ${errors.slice(0, 3).join("; ")}`);
  return value;
}

/** The newest pull_request run of `workflow` on `sha` in `repo` (never a fork's, never a dispatch) → `{id, status, conclusion}`, or null. */
function newestRun(runner, main, { repo, workflow, sha }) {
  const doc = parse(ghOut(runner, main, ["api", `repos/${repo}/actions/workflows/${workflow}/runs?head_sha=${sha}&per_page=50`], VERB));
  const runs = (isObj(doc) && Array.isArray(doc.workflow_runs) ? doc.workflow_runs : []).filter(
    (r) => isObj(r) && Number.isSafeInteger(r.id) && r.id > 0 && r.event === "pull_request" && r.head_sha === sha && r.repository?.full_name === repo && r.head_repository?.full_name === repo,
  );
  if (!runs.length) return null;
  const r = runs.reduce((a, b) => (b.id > a.id ? b : a));
  return { id: String(r.id), status: String(r.status), conclusion: r.conclusion === null ? null : String(r.conclusion) };
}

/** The PR's changed files, or null when GitHub's list may be cut short. */
function prFiles(runner, main, { repo, pr }) {
  const out = ghOut(runner, main, ["api", "--paginate", `repos/${repo}/pulls/${pr}/files?per_page=100`, "--jq", ".[].filename"], VERB);
  const files = out.split("\n").filter(Boolean);
  return files.length >= FILES_MAX ? null : files;
}

/**
 * The failing journeys of journey job `project`'s results in `reports` → `{ids, other}`: `other` counts what is no
 * journey's failure (a setup sign-in, a test outside the suite's names). A test tagged @quarantine is the quarantine
 * job's. No report for the job → null (nothing explains its failure).
 */
function failingJourneys(reports, artifact, project) {
  const mine = reports.filter((r) => r.name === `${artifact}-${project}`);
  if (!mine.length) return null;
  const ids = new Set();
  let other = 0;
  for (const t of mine.flatMap(testsOf)) {
    if (t.status !== "unexpected") continue;
    if (t.tags.includes("quarantine") || t.tags.includes("@quarantine")) continue;
    if (t.project === project && JOURNEY.test(String(t.title)) && t.file === `${t.title}.spec.ts`) ids.add(t.title);
    else other += 1;
  }
  return { ids: [...ids], other };
}

/** Judges completed run `r` → `{verdict: "green"|"red"|"excused", lines}`. */
function judge(runner, main, { repo, closes, base, sha, smoke, files, trustedIds, r }) {
  const doc = parse(ghOut(runner, main, ["api", `repos/${repo}/actions/runs/${r.id}/jobs?filter=latest&per_page=100`], VERB));
  const jobs = (isObj(doc) && Array.isArray(doc.jobs) ? doc.jobs : []).filter(isObj);
  const gating = jobs.filter((j) => !/^(quarantine|baseline)( \(|$)/.test(String(j.name)));
  const failed = gating.filter((j) => !PASS.has(String(j.conclusion)));
  const head = `${VERB}: run ${r.id}`;
  if (!failed.length && PASS.has(String(r.conclusion))) return { verdict: "green", lines: [`${head} green`] };
  const word = (v) => String(v ?? "").replace(/[^a-z_]/g, "").slice(0, 40) || "no conclusion";
  const what = failed.length ? failed.map((j) => `${shown(j.name)} ${word(j.conclusion)}`).join(", ") : `the run concluded ${word(r.conclusion)} with no failed job`;
  const red = (why) => ({ verdict: "red", lines: [`${head} red: ${what}${why ? ` — ${why}` : ""}`] });
  if (!failed.length || failed.some((j) => j.conclusion !== "failure" || projectOf(j.name) === null)) return red("");
  // Every failed job is a journey job whose results name only excused journeys.
  const tmp = download(main, { id: r.id, repo, prefix: smoke.ci.artifact, runner, verb: VERB });
  let reports;
  try {
    reports = reportsIn(tmp, smoke.ci.artifact).reports;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const dir = smoke.dir.replace(/\/+$/, "");
  const qfile = path.posix.join(dir, "quarantine.json");
  const quarantined = new Set(quarantineOf(parse(blob(runner, main, base, qfile) ?? "null")).map((q) => q.id));
  // (a) The PR's own proposal for a journey: its spec (a heal), or its quarantine.json at the head listing it.
  const specChanged = (id) => files.includes(`${dir}/${id}.spec.ts`);
  let proposed = null;
  const proposes = (id) => {
    if (!files.includes(qfile)) return false;
    if (proposed === null) {
      // The head's file, as GitHub holds it: unreadable (deleted at the head, say) = it quarantines nothing.
      const got = runner(["gh", "api", `repos/${repo}/contents/${qfile}?ref=${sha}`, "-H", "Accept: application/vnd.github.raw+json"], { cwd: main });
      proposed = new Set(got.status === 0 ? quarantineOf(parse(String(got.stdout ?? ""))).map((q) => q.id) : []);
    }
    return proposed.has(id);
  };
  // (c) Only shapes come back: the title is tested inside jq and never read, nor the author's login.
  const filed = (n, id) => {
    const jq = `{number, open: (.state == "open"), pr: (.pull_request != null), author: .user.id, labels: [.labels[].name | ascii_downcase], names: (.title | test("(^|[^a-z0-9-])smoke-regression:${id}($|[^a-z0-9-])"))} | @json`;
    const i = parse(ghOut(runner, main, ["api", `repos/${repo}/issues/${n}`, "--jq", jq], VERB));
    if (!isObj(i) || i.number !== n || i.open !== true || i.pr !== false || i.names !== true) return false;
    if (!Array.isArray(i.labels) || !REGRESSION_LABELS.every((l) => i.labels.includes(l))) return false;
    return trustedIds().has(i.author);
  };
  const closing = (id) => closes.find((n) => filed(n, id)) ?? null;
  const why = [];
  const blocking = [];
  for (const j of failed) {
    const got = failingJourneys(reports, smoke.ci.artifact, projectOf(j.name));
    if (!got || !got.ids.length) blocking.push(`${shown(j.name)}: its results name no failing journey`);
    else if (got.other) blocking.push(`${shown(j.name)}: ${got.other} failure(s) besides journeys (a sign-in, a test outside the suite)`);
    for (const id of got?.ids ?? []) {
      if (specChanged(id)) why.push(`${id} (the PR changes its spec)`);
      else if (proposes(id)) why.push(`${id} (the PR quarantines it)`);
      else if (quarantined.has(id)) why.push(`${id} (quarantined)`);
      else {
        const n = closing(id);
        if (n !== null) why.push(`${id} (this PR closes #${n}, its smoke-regression issue)`);
        else blocking.push(`journey ${id} failed: not quarantined, its spec unchanged, and the PR closes no smoke-regression:${id} issue the smoke cycle filed`);
      }
    }
  }
  if (blocking.length) return red([...new Set(blocking)].join("; "));
  return { verdict: "excused", lines: [`${head} red (${what}), not a block: every failing journey is excused: ${[...new Set(why)].join(", ")}`] };
}

/**
 * The owner override on PR `pr` → who applied it (`login`), or null: `OVERRIDE_LABEL` is on the PR now, and the
 * latest event that applied or removed it applied it, by an id in the trusted set.
 */
function overriddenBy(runner, main, { repo, pr, trustedIds }) {
  const name = OVERRIDE_LABEL.toLowerCase();
  const now = parse(ghOut(runner, main, ["api", `repos/${repo}/issues/${pr}`, "--jq", "[.labels[].name | ascii_downcase] | @json"], VERB));
  if (!Array.isArray(now) || !now.includes(name)) return null;
  const jq = `.[] | select((.event == "labeled" or .event == "unlabeled") and ((.label.name // "") | ascii_downcase) == "${name}") | {event, id: .actor.id, login: .actor.login} | @json`;
  const events = ghOut(runner, main, ["api", "--paginate", `repos/${repo}/issues/${pr}/events?per_page=100`, "--jq", jq], VERB).split("\n").filter(Boolean).map(parse);
  const last = events.at(-1);
  if (!isObj(last) || last.event !== "labeled" || !trustedIds().has(last.id)) return null;
  return typeof last.login === "string" && /^[A-Za-z0-9-]{1,39}(\[bot\])?$/.test(last.login) ? last.login : "a trusted account";
}

/** The trusted set of the contract on the base commit (resolveTrusted: the owner's id from the active gh account). */
function contractTrusted(main, baseRef) {
  const { contract, error } = loadContract(main, { ref: baseRef });
  if (!contract) throw new Error(`refused: ${VERB}: ${String(error).split("\n")[0]}`);
  return resolveTrusted(contract);
}

/**
 * The smoke check of PR `pr`'s head `sha` → `{verdict, run, lines}`, verdict one of `no-wiring` (no workflow file on
 * the base commit), `missing` (no run on the head), `pending` (still running once `waitMs` is spent), `green`, `red`
 * or `excused` (red, but an escape or the owner override holds). A pending run is polled every `pollMs` until
 * `waitMs`; a run not there yet, for `graceMs` at most (within `waitMs`). gh that cannot answer throws: the caller
 * fails closed. `trusted` → the trusted set ([{id}]), read once and only when an escape needs it.
 */
export async function smokeGate({ main, repo, baseRef, sha, pr, closes = [], waitMs = 0 }, { runner = run, sleep = (ms) => new Promise((ok) => setTimeout(ok, ms)), now = Date.now, pollMs = POLL_MS, graceMs = GRACE_MS, trusted = () => contractTrusted(main, baseRef) } = {}) {
  if (!NWO.test(String(repo)) || !SHA.test(String(baseRef)) || !SHA.test(String(sha)) || !Number.isSafeInteger(pr) || pr < 1) throw new Error(`refused: ${VERB}: needs a repo, a base commit, a head commit and a PR number`);
  const smoke = settings(runner, main, baseRef);
  const wf = `.github/workflows/${smoke.ci.workflow}`;
  if (blob(runner, main, baseRef, wf) === null) return { verdict: "no-wiring", run: null, lines: [`${VERB}: no CI wiring on the base commit (${wf} is absent): not a block`] };
  let ids = null;
  const trustedIds = () => (ids ??= new Set((trusted() ?? []).map((t) => t && t.id).filter((id) => Number.isSafeInteger(id) && id > 0)));
  // A red verdict stands unless the owner overrides it.
  const settle = (v) => {
    if (v.verdict !== "red") return v;
    const by = overriddenBy(runner, main, { repo, pr, trustedIds });
    return by === null ? v : { ...v, verdict: "excused", lines: [...v.lines, `${VERB}: not a block: owner override: ${OVERRIDE_LABEL} applied by ${by}`] };
  };
  // The PR's files decide the escapes; a PR that changes the smoke workflow is judged by a run of its own making.
  const files = prFiles(runner, main, { repo, pr });
  if (files === null) return settle({ verdict: "red", run: null, lines: [`${VERB}: red: the PR's file list may be cut short (${FILES_MAX} files or more): it cannot show ${wf} untouched`] });
  if (files.includes(wf)) return settle({ verdict: "red", run: null, lines: [`${VERB}: red: the PR changes the smoke workflow (${wf}): its own run cannot clear it`] });
  const start = now();
  for (;;) {
    const r = newestRun(runner, main, { repo, workflow: smoke.ci.workflow, sha });
    const spent = now() - start;
    if (r && r.status === "completed") return settle({ run: r.id, ...judge(runner, main, { repo, closes, base: baseRef, sha, smoke, files, trustedIds, r }) });
    if (!r && spent >= Math.min(graceMs, waitMs)) return { verdict: "missing", run: null, lines: [`${VERB}: no argus-smoke run on ${sha.slice(0, 12)} (${smoke.ci.workflow}): not a block`] };
    if (r && spent >= waitMs) return { verdict: "pending", run: r.id, lines: [`${VERB}: run ${r.id} is ${r.status.replace(/[^a-z_]/g, "")}${waitMs ? `, still running after ${Math.round(waitMs / 60_000)} min` : ""}`] };
    await sleep(pollMs);
  }
}

async function main() {
  const a = process.argv.slice(2);
  const o = {};
  for (let i = 0; i < a.length; i += 2) {
    if (!/^--(main|repo|base-ref|sha|pr|closes|wait)$/.test(a[i]) || a[i + 1] === undefined) throw new Error(`refused: ${VERB}: usage: sapu-smoke-gate.mjs --main <dir> --repo <owner/name> --base-ref <sha> --sha <sha> --pr <n> [--closes <n>,…] [--wait <minutes>]`);
    o[a[i].slice(2)] = a[i + 1];
  }
  const closes = (o.closes ?? "").split(",").filter(Boolean).map(Number);
  if (closes.some((n) => !Number.isSafeInteger(n) || n < 1)) throw new Error(`refused: ${VERB}: --closes takes issue numbers`);
  const wait = Number(o.wait ?? 0);
  if (!Number.isFinite(wait) || wait < 0) throw new Error(`refused: ${VERB}: --wait takes minutes`);
  const v = await smokeGate({ main: o.main ?? process.cwd(), repo: o.repo, baseRef: o["base-ref"], sha: o.sha, pr: Number(o.pr), closes, waitMs: wait * 60_000 });
  process.stdout.write(`${JSON.stringify(v)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    process.stderr.write(`${String(e && e.message ? e.message : e).split("\n")[0]}\n`);
    process.exit(1);
  });
}
