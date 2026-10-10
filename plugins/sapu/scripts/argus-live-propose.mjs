// argus-live-propose.mjs — every change to the committed smoke suite as a pull request (spec §19.8, §19.10):
// `smoke propose` builds the staged changes in a worktree from the base branch, passes every file and the
// body through scrub's matcher, and opens the pull request sapu never merges; `smoke workflow` prints the CI
// job /sapu:init writes with the owner's consent.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SMOKE_PLAYWRIGHT, suiteProjects } from "./argus-live-codegen.mjs";
import { upTo } from "./argus-live-codeproj.mjs";
import { LIVE_FILE } from "./argus-live-config.mjs";
import { loadSmoke, SMOKE_DEFAULTS } from "./argus-live-smokecfg.mjs";
import { newestLedgerRun, secretHits } from "./argus-live-ledger.mjs";
import { lastRun, RUN_ID } from "./argus-live-lock.mjs";
import { run } from "./argus-live-proc.mjs";
import { scrubSecrets } from "./argus-live-scrub.mjs";
import { quarantineAt, readSuitePaths, smokeEvent } from "./argus-live-smoke.mjs";
import { changeDigest, generated, liveAsWritten, PR_URL, readState, refreshOutcomes, SUPERSEDED, writeState } from "./argus-live-suite.mjs";
import { agentFiledLabel, loadContract, needsOwnerLabel } from "./sapu-contract.mjs";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
/** Where the suite's baselines and adopted violations live (spec §19.2): a conflict there is never resolved by picking a side. */
const BASELINE_DIRS = ["__screenshots__", "__aria__", "known"];
const NEEDED = (id) => `baseline: needed ${id} (smoke baseline --from-run after this PR's first CI run)`;

/** A code fence around `text` longer than any backtick run in it, so nothing in it closes the fence. */
function fenced(text, lang = "") {
  const run = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const f = "`".repeat(run + 1);
  return `${f}${lang}\n${text}\n${f}`;
}

/** A change's line in `changes.jsonl` (spec §19.8): `{kind, id, step?, from?, to?, evidence, run}`. */
const logLine = (c) => JSON.stringify({ kind: c.kind, id: c.id, ...(c.step !== undefined ? { step: c.step } : {}), ...(c.from !== undefined ? { from: c.from } : {}), ...(c.to !== undefined ? { to: c.to } : {}), evidence: c.evidence ?? "", run: c.run });
/** A staged entry's changes.jsonl lines: its own `changes`, else one line of its kind. */
const changesOf = (e) => (Array.isArray(e.changes) && e.changes.length ? e.changes.filter(isObj).map((c) => ({ ...c, kind: c.kind ?? e.kind, id: e.id, run: c.run ?? e.run })) : [{ kind: e.kind, id: e.id, evidence: "", run: e.run }]);
const changeLine = (c) => `change ${c.kind} ${c.id}${Number.isInteger(c.step) ? ` step ${c.step}` : ""}`;

/** A git runner bound to `cwd` that refuses on a failure, naming the subcommand. */
const gitIn = (cwd, runner) => (args, opts = {}) => {
  const r = runner(["git", "-C", cwd, ...args], opts);
  if (r.status !== 0 && !opts.allowFail) throw new Error(`refused: smoke propose: git ${args[0]} failed (${String(r.stderr ?? "").trim().split("\n").at(-1).slice(0, 200)})`);
  return r;
};

/**
 * Carries the proposal branch's own work over onto the base (a rebase by file, spec §19.8): every file under
 * the suite's directory the branch changed since it left the base, but the generated ones and changes.jsonl
 * (rebuilt), is taken as the branch has it; one the base changed too is a conflict — a baseline file is then
 * dropped (never a side picked; a baseline run regenerates it), any other refuses. → `{dropped, log}`, `log`
 * the changes.jsonl lines the branch added.
 */
function carryBranch(g, { wt, dir, base, branch, generatedNames }) {
  const mb = String(g(["merge-base", `origin/${base}`, `origin/${branch}`]).stdout).trim();
  const diff = String(g(["diff", "--name-status", "--no-renames", mb, `origin/${branch}`, "--", dir]).stdout).trim();
  const dropped = [];
  let log = [];
  for (const row of diff ? diff.split("\n") : []) {
    const [status, file] = row.split("\t");
    const rel = file.slice(dir.length + 1);
    if (rel === "changes.jsonl") {
      const before = String(g(["show", `${mb}:${file}`], { allowFail: true }).stdout ?? "");
      const after = String(g(["show", `origin/${branch}:${file}`], { allowFail: true }).stdout ?? "");
      log = after.slice(after.startsWith(before) ? before.length : 0).split("\n").filter(Boolean);
      continue;
    }
    if (generatedNames.includes(rel) || rel === "package-lock.json") continue;
    const baseChanged = g(["diff", "--quiet", mb, `origin/${base}`, "--", file], { allowFail: true }).status !== 0;
    if (baseChanged) {
      if (!BASELINE_DIRS.includes(rel.split("/")[0])) throw new Error(`refused: smoke propose: ${file} changed on both origin/${base} and ${branch}`);
      fs.rmSync(path.join(wt, file), { force: true });
      dropped.push(file);
    } else if (status === "D") fs.rmSync(path.join(wt, file), { force: true });
    else {
      fs.mkdirSync(path.dirname(path.join(wt, file)), { recursive: true });
      fs.writeFileSync(path.join(wt, file), g(["show", `origin/${branch}:${file}`], { encoding: "buffer" }).stdout);
    }
  }
  return { dropped, log };
}

/**
 * Applies the staged entries to the suite directory `at` (spec §19.8, §19.9): an add's or a heal's `path` as
 * `journeys/<id>.json` (a heal keeps the file's admission record and routes: it changes targets, not the admission),
 * a drop or retire as the journey's removal, a quarantine or unquarantine on quarantine.json (codegen's @quarantine tag).
 */
function applyChanges(at, changes, base) {
  const qFile = path.join(at, "quarantine.json");
  const had = fs.existsSync(qFile);
  let quarantine = quarantineAt(at);
  const rm = (p) => fs.rmSync(path.join(at, p), { recursive: true, force: true });
  for (const c of changes) {
    if (c.kind === "add" || c.kind === "heal") {
      if (!Array.isArray(c.path)) throw new Error(`refused: smoke propose: the staged ${c.kind} of ${c.id} holds no path`);
      const file = path.join(at, "journeys", `${c.id}.json`);
      let was = null;
      try {
        was = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {
        was = null;
      }
      if (c.kind === "heal" && !(isObj(was) && was.journey === c.id)) throw new Error(`refused: smoke propose: the staged heal of ${c.id} names a journey origin/${base}'s suite does not hold`);
      const routes = c.kind === "add" ? c.routes : was.routes;
      const doc = { journey: c.id, path: c.path, admitted: (c.kind === "add" ? c.admitted : was.admitted) ?? null, ...(Array.isArray(routes) && routes.length ? { routes } : {}) };
      fs.mkdirSync(path.join(at, "journeys"), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
    } else if (c.kind === "drop" || c.kind === "retire") {
      // Baseline directories are the runner's {testFileBaseName}: the spec file's name without .ts, <id>.spec.
      for (const p of [`journeys/${c.id}.json`, `${c.id}.spec.ts`, `known/${c.id}.json`, `__aria__/${c.id}.spec`]) rm(p);
      for (const project of fs.existsSync(path.join(at, "__screenshots__")) ? fs.readdirSync(path.join(at, "__screenshots__")) : []) {
        for (const platform of fs.readdirSync(path.join(at, "__screenshots__", project))) rm(`__screenshots__/${project}/${platform}/${c.id}.spec`);
      }
      quarantine = quarantine.filter((q) => q.id !== c.id);
    } else if (c.kind === "quarantine") {
      const q = c.quarantine;
      if (!isObj(q) || q.id !== c.id) throw new Error(`refused: smoke propose: the staged quarantine of ${c.id} holds no {id, issue, since}`);
      quarantine = [...quarantine.filter((x) => x.id !== c.id), { id: q.id, issue: q.issue ?? null, since: q.since ?? c.run, projects: Array.isArray(q.projects) ? q.projects : [] }];
    } else if (c.kind === "unquarantine") quarantine = quarantine.filter((q) => q.id !== c.id);
  }
  // Written as quarantineAt reads it; `projects` only when it names some.
  const entry = ({ projects, ...q }) => (projects.length ? { ...q, projects } : q);
  if (had || quarantine.length) fs.writeFileSync(qFile, `${JSON.stringify(quarantine.map(entry), null, 2)}\n`);
}

/** The journeys of the suite at `at` whose screenshots no baseline holds yet (`__screenshots__/<project>/<platform>/<id>.spec/`). */
function baselinesNeeded(at, ids) {
  const have = new Set();
  const shots = path.join(at, "__screenshots__");
  for (const project of fs.existsSync(shots) ? fs.readdirSync(shots) : []) {
    for (const platform of fs.readdirSync(path.join(shots, project))) for (const d of fs.readdirSync(path.join(shots, project, platform))) if (d.endsWith(".spec")) have.add(d.slice(0, -5));
  }
  return ids.filter((id) => !have.has(id));
}

/**
 * Every secret scrub knows for the runs `runs` (the staged changes' own), or a refusal: a run's ledger that is
 * gone or incomplete leaves its secrets unknown, so nothing is pushed.
 */
function secretsOf(main, runs, env) {
  const all = [];
  for (const runId of runs) {
    if (!RUN_ID.test(runId)) throw new Error(`refused: smoke propose: a staged change names no run id (${runId.slice(0, 40)})`);
    const { secrets, refusal } = scrubSecrets(main, { runId, env });
    if (refusal) throw new Error(`refused: smoke propose: run ${runId}: ${refusal.replace(/^refused: scrub: /, "")}`);
    all.push(...secrets);
  }
  return all;
}

/**
 * `smoke propose [--dry-run]` → `{code, lines}` (spec §19.8). Asks gh how each open proposal ended (merged:
 * accepted; closed: rejected), skips a staged change rejected before (`skip <kind> <id>: rejected in <url>`) or
 * open already, and for the rest: a worktree from `origin/<base>` (outside the repo, removed after), the
 * proposal branch `argus/smoke-<runId>`'s own work carried over (carryBranch), the changes applied, the suite
 * regenerated from that checkout's paths, smoke.json and live.json, one changes.jsonl line per change, the
 * lockfile by `npm install --package-lock-only --ignore-scripts`; every changed text file and the body through
 * scrub's matcher (a hit refuses: `<file>:<line>:<col> <class>`, nothing pushed); one commit with the
 * contract's gitEmail and a Signed-off-by; the branch pushed (with a lease); the pull request opened with
 * `labels.agentFiled` (and `labels.needsOwner` when a heal is flagged `needsOwner`), or its body updated. Lines: `branch:`, `change …`, `baseline: dropped …`, `baseline:
 * needed …`, `proposed: <url>`. `dryRun` lists the changes and writes nothing (no fetch either).
 */
export async function smokePropose(main, { dryRun }, { runner = run, gh = "gh", npm = "npm", env = process.env } = {}) {
  const c = loadContract(main);
  if (!c.contract) throw new Error(`refused: smoke propose: ${c.error ?? "no sapu contract"}`);
  const { repo, baseBranch: base, gitEmail } = c.contract;
  const state = readState(main);
  const staged = state.staged;
  const refreshed = refreshOutcomes(state, { runner, gh, cwd: main });
  const lines = [];
  const todo = [];
  const skipped = new Set();
  const removed = new Set(staged.filter((ch) => ch.kind === "drop" || ch.kind === "retire").map((ch) => ch.id));
  for (const ch of staged) {
    if (removed.has(ch.id) && SUPERSEDED.includes(ch.kind)) {
      lines.push(`skip ${ch.kind} ${ch.id}: superseded by the staged ${staged.find((x) => x.id === ch.id && (x.kind === "drop" || x.kind === "retire")).kind}`);
      skipped.add(ch);
      continue;
    }
    const digest = ch.digest ?? changeDigest(ch);
    const p = state.proposals[digest];
    const rejected = state.rejected.includes(digest);
    if (rejected || (isObj(p) && p.outcome === "open")) {
      lines.push(`skip ${ch.kind} ${ch.id}: ${rejected ? "rejected" : "proposed already"}${isObj(p) && typeof p.url === "string" ? ` in ${p.url}` : ""}`);
      skipped.add(ch);
    } else todo.push(ch);
  }
  const all = todo.flatMap(changesOf);
  const runId = lastRun(main) ?? todo.map((ch) => ch.run).findLast((r) => RUN_ID.test(r));
  if (todo.length && !RUN_ID.test(String(runId))) throw new Error("refused: smoke propose: no run names the proposal's branch");
  const branch = `argus/smoke-${runId}`;
  if (dryRun) {
    if (!todo.length) return { code: 0, lines: [...lines, "smoke propose: nothing to propose"] };
    return { code: 0, lines: [...lines, `would propose on ${branch}: ${all.length} change(s)`, ...all.map(changeLine)] };
  }
  const settle = () => {
    state.staged = staged.filter((ch) => !skipped.has(ch));
    if (refreshed || skipped.size) writeState(main, state);
  };
  if (!todo.length) {
    settle();
    return { code: 0, lines: [...lines, "smoke propose: nothing to propose"] };
  }
  // The ledgers of the lane runs whose page values the staged changes carry: only an add's or a heal's path does. The
  // other kinds (smoke ci's, which name a CI run with no ledger; smoke plan's quarantine; smoke retire's) carry none,
  // and their run may be one a later up dropped: with only those, the branch's run's ledger is the one checked against.
  const lane = [...new Set(todo.filter((ch) => ch.kind === "add" || ch.kind === "heal").map((ch) => ch.run))];
  // Without one, the newest run that keeps a ledger (the branch's run may be a map run, which keeps none).
  const fallback = lane.length ? null : newestLedgerRun(main);
  if (!lane.length && !fallback) throw new Error("refused: smoke propose: no lane run here keeps a secret ledger to check the proposal against (run a journey cycle first)");
  const secrets = secretsOf(main, lane.length ? lane : [fallback], env);
  const g0 = gitIn(main, runner);
  const lease = String(g0(["ls-remote", "--heads", "origin", `refs/heads/${branch}`]).stdout ?? "").trim().split(/\s/)[0] ?? "";
  g0(["fetch", "--quiet", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`, ...(lease ? [`+refs/heads/${branch}:refs/remotes/origin/${branch}`] : [])]);
  const wt = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "argus-propose-"));
  try {
    g0(["worktree", "add", "--quiet", "--detach", wt, `origin/${base}`]);
    const g = gitIn(wt, runner);
    const loaded = loadSmoke(wt);
    if (loaded.errors.length) throw new Error(`refused: smoke propose: origin/${base}'s ${loaded.errors.join("; ")}`);
    const smoke = loaded.smoke ?? structuredClone(SMOKE_DEFAULTS);
    const dir = smoke.dir;
    let liveText;
    try {
      liveText = fs.readFileSync(path.join(wt, LIVE_FILE), "utf8");
    } catch {
      throw new Error(`refused: smoke propose: origin/${base} holds no ${LIVE_FILE}`);
    }
    const live = liveAsWritten(liveText, "smoke propose");
    const at = path.join(wt, dir);
    const before = generated(wt, { live, smoke, verb: "smoke propose" });
    const carried = lease ? carryBranch(g, { wt, dir, base, branch, generatedNames: [...Object.keys(before), "fixtures.ts"] }) : { dropped: [], log: [] };
    applyChanges(at, todo, base);
    const files = generated(wt, { live, smoke, verb: "smoke propose" });
    fs.mkdirSync(at, { recursive: true });
    // fixtures.ts is the owner's: created when missing, never overwritten.
    for (const [name, text] of Object.entries(files)) if (name !== "fixtures.ts" || !fs.existsSync(path.join(at, name))) fs.writeFileSync(path.join(at, name), text);
    const ids = readSuitePaths(wt, dir).map((p) => p.id);
    for (const f of fs.readdirSync(at).filter((n) => n.endsWith(".spec.ts") && !ids.includes(n.slice(0, -8)))) fs.rmSync(path.join(at, f));
    const log = [...carried.log, ...all.map(logLine)];
    const logFile = path.join(at, "changes.jsonl");
    fs.appendFileSync(logFile, all.map((ch) => `${logLine(ch)}\n`).join(""));
    const npmRun = runner([npm, "install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: at, env });
    if (npmRun.status !== 0) throw new Error(`refused: smoke propose: npm install --package-lock-only failed (exit ${npmRun.status ?? "on a signal"})`);
    g(["add", "-A", "--", dir]);
    const changed = String(g(["diff", "--cached", "--name-only"]).stdout).trim().split("\n").filter(Boolean);
    const needed = [...new Set([...baselinesNeeded(at, ids), ...carried.dropped.map((f) => f.slice(dir.length + 1).split("/").at(-2).replace(/\.spec$/, "")).filter((id) => ids.includes(id))])].sort();
    const title = `argus smoke: ${log.length} change(s) from run ${runId}`;
    const body = [
      title,
      "",
      "sapu never merges this pull request: merging it accepts these changes to the committed smoke suite; closing it rejects them, and they are not proposed again.",
      "",
      "## Changes",
      ...log.map((l) => JSON.parse(l)).map((x) => `- ${x.kind} \`${x.id}\`${Number.isInteger(x.step) ? ` step ${x.step}` : ""}`),
      "",
      "## Baselines",
      ...(needed.length ? needed.map((id) => `- ${NEEDED(id)}`) : ["- none needed"]),
      ...carried.dropped.map((f) => `- dropped \`${f}\`: it conflicted with the base; a baseline run regenerates it`),
      "",
      ...(todo.some((ch) => Array.isArray(ch.body) && ch.body.length) ? ["## Details", ...todo.flatMap((ch) => (Array.isArray(ch.body) ? [...ch.body.map(String), ""] : []))] : []),
      "## Change log",
      fenced(log.join("\n"), "json"),
      "",
    ].join("\n");
    const hits = [];
    for (const f of changed.filter((n) => !/\.png$/i.test(n))) {
      let text = "";
      try {
        text = fs.readFileSync(path.join(wt, f), "utf8");
      } catch {
        continue; // removed by the change
      }
      for (const h of secretHits(text, secrets)) hits.push(`${f}:${h.line}:${h.col} ${h.cls}`);
    }
    for (const h of secretHits(body, secrets)) hits.push(`body:${h.line}:${h.col} ${h.cls}`);
    if (hits.length) throw new Error(`refused: smoke propose: ${hits.length} secret(s): ${hits.join("; ")}; nothing is pushed`);
    const name = String(runner(["git", "-C", main, "config", "user.name"]).stdout ?? "").trim() || c.contract.ghUser;
    const msg = path.join(wt, "..", `${path.basename(wt)}.msg`);
    fs.writeFileSync(msg, `chore(argus-smoke): ${log.length} change(s) from run ${runId}\n\n${log.map((l) => changeLine(JSON.parse(l))).join("\n")}\n\nSigned-off-by: ${name} <${gitEmail}>\n`);
    try {
      g(["-c", `user.email=${gitEmail}`, "-c", `user.name=${name}`, "commit", "--quiet", "--no-verify", "-F", msg]);
      fs.writeFileSync(msg, body);
      g(["push", "--quiet", `--force-with-lease=refs/heads/${branch}:${lease}`, "origin", `HEAD:refs/heads/${branch}`]);
      const repoFlag = typeof repo === "string" ? ["--repo", repo] : [];
      const open = String(runner([gh, "pr", "list", ...repoFlag, "--head", branch, "--state", "open", "--json", "url", "--jq", ".[0].url // \"\""], { cwd: main }).stdout ?? "").trim();
      // A heal that moved its control's role or name (smoke heal's flags) is the owner's to read: the needs-owner label too.
      const owner = todo.some((ch) => ch.needsOwner === true) ? [needsOwnerLabel(c.contract)] : [];
      const r = open && PR_URL.test(open)
        ? runner([gh, "pr", "edit", open, ...repoFlag, "--body-file", msg, ...owner.flatMap((l) => ["--add-label", l])], { cwd: main })
        : runner([gh, "pr", "create", ...repoFlag, "--base", base, "--head", branch, "--title", title, "--body-file", msg, "--label", agentFiledLabel(c.contract), ...owner.flatMap((l) => ["--label", l])], { cwd: main });
      const url = open && PR_URL.test(open) && r.status === 0 ? open : (PR_URL.exec(String(r.stdout ?? "")) ?? [null])[0];
      if (!url) return { code: 2, lines: [...lines, `branch: ${branch}`, `failed: gh pr ${open ? "edit" : "create"} exited ${r.status ?? "on a signal"} after ${branch} was pushed; the changes stay staged`] };
      for (const ch of todo) state.proposals[ch.digest ?? changeDigest(ch)] = { kind: ch.kind, id: ch.id, branch, url, outcome: "open" };
      state.staged = staged.filter((ch) => !skipped.has(ch) && !todo.includes(ch));
      writeState(main, state);
      smokeEvent(main, runId, { kind: "proposal", url, branch, changes: all.length });
      return {
        code: 0,
        lines: [...lines, `branch: ${branch}`, ...all.map(changeLine), ...carried.dropped.map((f) => `baseline: dropped ${f} (it conflicts with origin/${base})`), ...needed.map(NEEDED), `proposed: ${url}`],
      };
    } finally {
      fs.rmSync(msg, { force: true });
    }
  } finally {
    runner(["git", "-C", main, "worktree", "remove", "--force", wt]);
    fs.rmSync(wt, { recursive: true, force: true });
    runner(["git", "-C", main, "worktree", "prune"]);
  }
}

// ---------------------------------------------------------------------------------------------------
// smoke workflow (spec §19.10).

/** The actions the workflow uses, each at the tag whose commit `gh api` resolves when the file is printed. */
const ACTIONS = Object.freeze({ checkout: ["actions/checkout", "v4"], node: ["actions/setup-node", "v4"], upload: ["actions/upload-artifact", "v4"] });
/** The jobs' runner: its image ships Edge (the msedge job's browser). */
const RUNNER = "ubuntu-24.04";

/** `action@tag` → `action@<40-hex commit> # tag`, through `gh api repos/<action>/commits/<tag>`; refused when gh cannot say. */
function pinned([action, tag], { runner, gh, cwd }) {
  const r = runner([gh, "api", `repos/${action}/commits/${tag}`, "--jq", ".sha"], { cwd });
  const sha = String(r.stdout ?? "").trim();
  if (r.status !== 0 || !/^[0-9a-f]{40}$/.test(sha)) throw new Error(`refused: smoke workflow: ${action}@${tag} could not be resolved to a commit (gh ${r.error ? "could not run" : `exited ${r.status ?? "on a signal"}`})`);
  return `${action}@${sha} # ${tag}`;
}

/** The registry's manifest types a multi-platform tag answers with. */
const MANIFESTS = "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json";

/**
 * The pinned Playwright image `mcr.microsoft.com/playwright:v<SMOKE_PLAYWRIGHT>-noble` → `{image, note}`: pinned by the
 * digest the registry answers for the tag (`Docker-Content-Digest` of an HTTPS HEAD, no shell, the digest's shape
 * checked), `<name>:<tag>@sha256:<64 hex>`; when it cannot be resolved, the tag alone and a comment line saying why.
 */
function imageOf({ runner, cwd }) {
  const tag = `v${SMOKE_PLAYWRIGHT}-noble`;
  const name = `mcr.microsoft.com/playwright:${tag}`;
  const r = runner(["curl", "-sSfI", "--max-time", "30", "--proto", "=https", "-H", `Accept: ${MANIFESTS}`, `https://mcr.microsoft.com/v2/playwright/manifests/${tag}`], { cwd });
  const m = r.status === 0 ? /^docker-content-digest:\s*(sha256:[0-9a-f]{64})\s*$/im.exec(String(r.stdout ?? "")) : null;
  if (m) return { image: `${name}@${m[1]}`, note: [] };
  const why = r.status === 0 ? "the registry named no digest" : r.error ? "curl could not run" : `curl exited ${r.status ?? "on a signal"}`;
  return { image: name, note: [`# The Playwright image is pinned by its tag only: its digest could not be resolved when this file was printed (${why}). Pin it by digest when you can.`] };
}

/**
 * The suite's CI projects (spec §19.6, §20.4), from codegen's suiteProjects, the generated config's own list: every
 * one but msedge runs in the pinned container (the screenshot projects, the engines and `chromium-<width>`, write the
 * baselines; `a11y` its ARIA files; `a11y`, `taste` and `i18n` take no screenshot), and msedge, when smoke.json's
 * browsers name it, on the plain runner, whose image ships Edge, with no screenshot. `taste` has its own job, so the
 * gating and quarantine matrices leave it out; the baseline run holds it (its gated rules' known rows are adopted
 * from there, as a11y's are).
 */
function projectsOf(live, smoke) {
  const projects = suiteProjects({ live, smoke });
  const inContainer = projects.filter((p) => p.browser !== "msedge");
  return {
    container: inContainer.filter((p) => p.kind !== "taste").map((p) => p.name),
    baseline: inContainer.map((p) => p.name),
    taste: projects.some((p) => p.kind === "taste"),
    msedge: projects.some((p) => p.browser === "msedge"),
    engine: projects.find((p) => p.kind === "browser" && p.browser !== "msedge")?.name ?? null,
  };
}

/**
 * The taste job's scorecard (spec §20.4, decision 17), run by `node -` from the suite's directory with the
 * results, `.argus/taste.json` and support.ts: Markdown into `$GITHUB_STEP_SUMMARY` (stdout without one), every
 * finding's page words inert (one line, at most 200 characters, in a code span). Exit 1 only when taste.json gates
 * a rule and a taste test did not pass (a gated violation, or a run that measured nothing), or when taste.json is
 * not JSON with a list of gated rule ids; otherwise 0, whatever the advisory findings.
 */
export const TASTE_SUMMARY = String.raw`const fs = require("node:fs");
const [resultsFile, tasteFile, supportFile] = process.argv.slice(2);
const RULE = /^[a-z]+\.[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CHECK = /^taste-([a-z]+)-([a-z0-9]+(?:-[a-z0-9]+)*)$/;
const JOURNEY = /^[a-z0-9][a-z0-9-]{0,63}$/;
const read = (f) => {
  try {
    return fs.readFileSync(f, "utf8");
  } catch (e) {
    return null;
  }
};
const parse = (s) => {
  try {
    return JSON.parse(s);
  } catch (e) {
    return undefined;
  }
};
const words = (v) => {
  const s = Array.from(String(v).replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g, " ").trim());
  return s.length > 200 ? s.slice(0, 199).join("") + "…" : s.join("");
};
const span = (v, cell) => {
  let s = words(v);
  if (s === "") return "\u2014";
  if (cell) s = s.replace(/\|/g, "\\|");
  const tick = "` + "`" + String.raw`";
  const fence = tick.repeat(Math.max(0, ...(s.match(/` + "`" + String.raw`+/g) || []).map((m) => m.length)) + 1);
  const pad = s.startsWith(tick) || s.endsWith(tick) ? " " : "";
  return fence + pad + s + pad + fence;
};
const out = [];
let failed = false;
let gate = [];
const tasteText = tasteFile ? read(tasteFile) : null;
if (tasteText !== null) {
  const cfg = parse(tasteText);
  if (cfg === null || typeof cfg !== "object" || Array.isArray(cfg) || (cfg.gate !== undefined && !(Array.isArray(cfg.gate) && cfg.gate.every((g) => typeof g === "string" && RULE.test(g))))) {
    out.push("**.argus/taste.json is not JSON with a list of rule ids under gate: the taste job cannot tell what gates, so it fails.**", "");
    failed = true;
  } else gate = cfg.gate || [];
}
const header = (read(supportFile || "support.ts") || "").match(/taste-bar ([0-9]+), digest/);
const tests = [];
const walk = (suite) => {
  if (suite === null || typeof suite !== "object") return;
  for (const spec of Array.isArray(suite.specs) ? suite.specs : []) {
    for (const t of spec !== null && typeof spec === "object" && Array.isArray(spec.tests) ? spec.tests : []) {
      if (t === null || typeof t !== "object" || t.projectName !== "taste") continue;
      // The last attempt's notes: a retried test's first ones are not counted twice.
      const tried = (Array.isArray(t.results) ? t.results : []).filter((r) => r !== null && typeof r === "object" && Array.isArray(r.annotations));
      const last = Array.isArray(t.results) && t.results.length ? t.results[t.results.length - 1] : null;
      // The suite's own refusal of taste.json only: any other error may quote the page.
      const why = last !== null && typeof last === "object" && last.error !== null && typeof last.error === "object" && typeof last.error.message === "string" ? last.error.message.split("\n")[0] : "";
      tests.push({ journey: JOURNEY.test(String(spec.title)) ? String(spec.title) : null, status: String(t.status), notes: tried.length ? tried[tried.length - 1].annotations : Array.isArray(t.annotations) ? t.annotations : [], config: why.startsWith("argus-smoke: .argus/taste.json ") ? why : null });
    }
  }
  for (const s of Array.isArray(suite.suites) ? suite.suites : []) walk(s);
};
const results = resultsFile ? read(resultsFile) : null;
const report = results === null ? undefined : parse(results);
if (report !== undefined && report !== null && typeof report === "object") walk(report);
const rows = [];
const info = [];
let unread = 0;
for (const t of tests) {
  for (const a of Array.isArray(t.notes) ? t.notes : []) {
    if (a === null || typeof a !== "object" || typeof a.description !== "string") continue;
    if (a.type === "argus-info") {
      if (a.description.startsWith("taste")) info.push({ journey: t.journey, line: a.description });
      continue;
    }
    if (a.type !== "argus-taste" && a.type !== "argus-violation") continue;
    const v = parse(a.description);
    const ok = v !== null && typeof v === "object" && Number.isInteger(v.step) && typeof v.key === "string";
    if (ok && a.type === "argus-taste" && RULE.test(String(v.rule))) rows.push({ journey: t.journey, step: v.step, rule: v.rule, key: v.key, measured: v.measured, expected: v.expected, gated: false });
    else if (ok && a.type === "argus-violation" && CHECK.test(String(v.check))) {
      const m = String(v.check).match(CHECK);
      rows.push({ journey: t.journey, step: v.step, rule: m[1] + "." + m[2], key: v.key, measured: v.detail, expected: "", gated: true });
    } else if (a.type === "argus-taste" || /^taste-/.test(String(v && v.check))) unread += 1;
  }
}
const passed = tests.filter((t) => t.status === "expected" || t.status === "flaky").length;
const gating = gate.length > 0;
const gated = rows.filter((r) => r.gated).length;
if (gating && (!tests.length || passed < tests.length)) failed = true;
const name = (j) => (j === null ? "(not shown)" : span(j, true));
out.unshift(
  "## Taste and usability",
  "",
  (header ? "taste-bar " + header[1] + " · " : "") + (gating ? "gating: " + gate.map((g) => span(g, false)).join(", ") : "advisory: .argus/taste.json gates no rule, so this job stays green"),
  "",
  "**" + rows.length + "** finding(s) in **" + new Set(rows.map((r) => r.journey)).size + "** journey(s) · **" + gated + "** gated · **" + info.length + "** information line(s) · " + passed + " of " + tests.length + " taste test(s) passed",
  "",
);
if (results === null) out.push("No results.json: the taste project did not run (see the run step's log).", "");
else if (report === undefined || report === null || typeof report !== "object") out.push("results.json is not Playwright's JSON report.", "");
if (rows.length) {
  const families = new Map();
  for (const r of rows) families.set(r.rule.split(".")[0], (families.get(r.rule.split(".")[0]) || 0) + 1);
  out.push("| Family | Findings |", "|---|---:|", ...[...families].sort().map(([f, n]) => "| " + span(f, true) + " | " + n + " |"), "");
  out.push("### Findings", "", "| Journey | Step | Rule | Key | Measured | Expected | Gate |", "|---|---:|---|---|---|---|---|");
  for (const r of rows.slice(0, 200)) out.push("| " + [name(r.journey), String(r.step), span(r.rule, true), span(r.key, true), span(r.measured, true), r.gated ? "" : span(r.expected, true), r.gated ? "**gated**" : ""].join(" | ") + " |");
  if (rows.length > 200) out.push("", (rows.length - 200) + " more in the job's results artifact.");
  out.push("");
}
if (info.length) {
  out.push("### Information", "");
  for (const i of info.slice(0, 100)) out.push("- " + name(i.journey) + ": " + span(i.line, false));
  if (info.length > 100) out.push("- " + (info.length - 100) + " more in the job's results artifact.");
  out.push("");
}
if (unread) out.push(unread + " taste annotation(s) not in their shape: not shown.", "");
const unpassed = tests.filter((t) => !(t.status === "expected" || t.status === "flaky"));
if (unpassed.length) out.push("Not passed: " + unpassed.map((t) => name(t.journey) + " (" + span(t.status, false) + ")").join(", ") + (gating ? "" : ". The test job gates the paths themselves."), "");
for (const c of [...new Set(unpassed.map((t) => t.config).filter((c) => c !== null))]) out.push("- " + span(c, false), "");
out.push(failed ? "**The taste job fails:** " + (gating ? "a gated rule is violated, or a taste test did not pass so a gated rule went unmeasured." : "see above.") : "The taste job passes.");
const text = out.join("\n") + "\n";
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
else process.stdout.write(text);
console.log(failed ? "taste: failed" : "taste: " + rows.length + " finding(s), " + (gating ? "gating " + gate.length + " rule(s)" : "advisory"));
process.exit(failed ? 1 : 0);`;

/** Every `${NAME}` live.json names (passwords, TOTP secrets, env values): the CI secrets the suite reads by name. */
const secretNames = (live) => [...new Set([...JSON.stringify(live).matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]))].sort();

/**
 * `smoke workflow` → `{code, lines, masked}`: `.github/workflows/<smoke.ci.workflow>` as /sapu:init writes it,
 * only with the owner's consent (spec §19.10): on pull requests, pushes to the base branch and a dispatch
 * (`baseline`: missing|changed, `grep`); `contents: read` and never `pull_request_target`; a fork's pull
 * request skipped; every action pinned to the commit `gh api` resolves, its tag in a comment; checkout without
 * persisted credentials; the gating `test` job in the pinned Playwright container (`--ipc=host --init`; pinned by
 * digest when the registry answers one, else by tag with a comment saying why), a matrix over the container
 * projects but `taste`, `npm ci --ignore-scripts` then `--shuffle --grep-invert @quarantine`, every step after the checkout
 * waiting for the suite's package.json (green before the first suite merges); the `taste` job (spec §20.4) in the
 * same container, its run never failing the job by itself, then TASTE_SUMMARY's scorecard in the job summary, which
 * fails only when .argus/taste.json gates a rule, its results uploaded as `taste-<ci.artifact>` (outside smoke ci's reads); `msedge` on the
 * plain runner; the non-gating `quarantine` job, the test job's matrix (a flake is judged on its own project's results); the dispatch-only `baseline` job (its matrix with `taste`), whose inputs reach the
 * shell only through `env:` and are checked against `^(missing|changed)$` and `^[a-z0-9][a-z0-9-]*(\\|[a-z0-9][a-z0-9-]*)*$` first,
 * the ids then anchored to a whole title word in `--grep`; results
 * and written baselines uploaded for 7 days, never `.auth/`; the `${NAME}` names live.json uses as
 * `secrets.<NAME>`, only in the env of the step that runs the suite. Refused without `ci.web_server` or a suite
 * path. The lines hold names, never a value (`masked`: printed as they are).
 */
export function smokeWorkflow(main, { runner = run, gh = "gh" } = {}) {
  const c = loadContract(main);
  if (!c.contract) throw new Error(`refused: smoke workflow: ${c.error ?? "no sapu contract"}`);
  const loaded = loadSmoke(main);
  if (loaded.errors.length) throw new Error(`refused: smoke workflow: ${loaded.errors.join("; ")}`);
  const smoke = loaded.smoke ?? structuredClone(SMOKE_DEFAULTS);
  let liveText;
  try {
    liveText = fs.readFileSync(path.join(main, LIVE_FILE), "utf8");
  } catch {
    throw new Error(`refused: smoke workflow: no ${LIVE_FILE}`);
  }
  const live = liveAsWritten(liveText, "smoke workflow");
  // The workflow runs the suite: without a way to start the app, or a path, every job would only fail.
  if (!smoke.ci.web_server.length) throw new Error("refused: smoke workflow: smoke.json names no ci.web_server, so CI could not start the app");
  if (!readSuitePaths(main, smoke.dir).length) throw new Error(`refused: smoke workflow: the suite has no paths (${smoke.dir}/journeys): write the workflow once the first suite proposal merged`);
  const use = {};
  for (const [k, a] of Object.entries(ACTIONS)) use[k] = pinned(a, { runner, gh, cwd: main });
  const { container, baseline, taste, msedge, engine } = projectsOf(live, smoke);
  if (!container.length || !engine) throw new Error("refused: smoke workflow: smoke.json's browsers name no browser of the pinned container (chromium, firefox or webkit)");
  const dir = smoke.dir;
  const artifact = smoke.ci.artifact;
  const fork = "(github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository)";
  // A job-level `if` cannot read the checkout, so every step after it waits for the suite: green until the first one merges.
  const suite = `hashFiles('${dir}/package.json') != ''`;
  const env = (extra = []) => (extra.length ? ["    env:", ...extra] : []);
  // The secrets reach only the step that runs the suite (and the app it starts), never npm ci or an action.
  const secrets = (extra = []) => ["        env:", ...extra, ...secretNames(live).map((n) => `          ${n}: \${{ secrets.${n} }}`)];
  const test = (cmd) => [`      - run: ${cmd}`, `        if: ${suite}`, ...secrets()];
  const install = ["      - run: npm ci --ignore-scripts", `        if: ${suite}`];
  const checkout = [`      - uses: ${use.checkout}`, "        with:", "          persist-credentials: false"];
  const { image: pinnedImage, note } = imageOf({ runner, cwd: main });
  const image = ["    container:", `      image: ${pinnedImage}`, "      options: --ipc=host --init"];
  const matrix = (list) => ["    strategy:", "      fail-fast: false", "      matrix:", `        project: [${list.join(", ")}]`];
  const workdir = ["    defaults:", "      run:", `        working-directory: ${dir}`];
  const upload = (name, paths) => [`      - uses: ${use.upload}`, `        if: \${{ !cancelled() && ${suite} }}`, "        with:", `          name: ${name}`, ...(paths.length === 1 ? [`          path: ${paths[0]}`] : ["          path: |", ...paths.map((p) => `            ${p}`)]), "          retention-days: 7"];
  const results = (name) => upload(name, [`${dir}/test-results/`]);
  const lines = [
    `# ${smoke.ci.workflow}: the argus smoke suite (${dir}), generated by sapu's argus-live.mjs smoke workflow.`,
    "# /sapu:init writes it with the owner's consent; change .argus/smoke.json and regenerate rather than edit it.",
    ...note,
    "name: argus-smoke",
    "on:",
    "  pull_request:",
    "  push:",
    `    branches: [${c.contract.baseBranch}]`,
    "  workflow_dispatch:",
    "    inputs:",
    "      baseline:",
    '        description: "Write screenshot and ARIA baselines: missing (new ones) or changed (the journeys named in grep)"',
    "        required: true",
    "        type: choice",
    "        options: [missing, changed]",
    "      grep:",
    '        description: "The journey ids to run, joined by |"',
    "        required: true",
    "        type: string",
    "permissions:",
    "  contents: read",
    "concurrency:",
    "  group: argus-smoke-${{ github.ref }}-${{ github.event_name }}",
    "  cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
    "jobs:",
    "  test:",
    "    # A pull request from a fork gets no secrets: skipped.",
    `    if: github.event_name != 'workflow_dispatch' && ${fork}`,
    `    runs-on: ${RUNNER}`,
    "    timeout-minutes: 70",
    ...image,
    ...matrix(container),
    ...env(["      HOME: /root", "      PROJECT: ${{ matrix.project }}"]),
    ...workdir,
    "    steps:",
    ...checkout,
    ...install,
    ...test('npx playwright test --shuffle --grep-invert @quarantine --project setup --project "$PROJECT"'),
    ...results(`${artifact}-\${{ matrix.project }}`),
    ...(taste
      ? [
          "  taste:",
          "    # The taste project (spec 20.4): advisory unless .argus/taste.json gates a rule; its scorecard is the job summary.",
          `    if: github.event_name != 'workflow_dispatch' && ${fork}`,
          `    runs-on: ${RUNNER}`,
          "    timeout-minutes: 70",
          ...image,
          ...env(["      HOME: /root"]),
          ...workdir,
          "    steps:",
          ...checkout,
          ...install,
          // The run never fails the job by itself: the scorecard step decides, from the results and the gate.
          ...test("npx playwright test --grep-invert @quarantine --project setup --project taste").flatMap((l, i) => (i === 0 ? [l, "        continue-on-error: true"] : [l])),
          "      - name: The taste scorecard, in the job summary",
          `        if: \${{ !cancelled() && ${suite} }}`,
          "        run: |",
          `          node - test-results/results.json ${upTo(dir)}/.argus/taste.json support.ts <<'ARGUS_TASTE'`,
          ...TASTE_SUMMARY.split("\n").map((l) => (l === "" ? "" : `          ${l}`)),
          "          ARGUS_TASTE",
          // Not under ci.artifact's prefix: smoke ci triages the gating jobs' results; the advisory job's are the owner's to read.
          ...results(`taste-${artifact}`),
        ]
      : []),
    ...(msedge
      ? [
          "  msedge:",
          "    # Edge is the runner image's own (never installed by sapu), so it has no screenshot baseline.",
          `    if: github.event_name != 'workflow_dispatch' && ${fork}`,
          `    runs-on: ${RUNNER}`,
          "    timeout-minutes: 70",
          ...workdir,
          "    steps:",
          ...checkout,
          `      - uses: ${use.node}`,
          `        if: ${suite}`,
          "        with:",
          "          node-version: 22",
          ...install,
          "      - run: npx playwright install chromium",
          `        if: ${suite}`,
          ...test("npx playwright test --shuffle --grep-invert @quarantine --project setup --project msedge"),
          ...results(`${artifact}-msedge`),
        ]
      : []),
    "  quarantine:",
    "    # Quarantined tests leave the critical path, never sight: this job runs them on every project and never gates.",
    `    if: github.event_name != 'workflow_dispatch' && ${fork}`,
    `    runs-on: ${RUNNER}`,
    "    timeout-minutes: 70",
    "    continue-on-error: true",
    ...image,
    ...matrix(container),
    ...env(["      HOME: /root", "      PROJECT: ${{ matrix.project }}"]),
    ...workdir,
    "    steps:",
    ...checkout,
    ...install,
    ...test('npx playwright test --grep @quarantine --pass-with-no-tests --project setup --project "$PROJECT"'),
    ...results(`${artifact}-quarantine-\${{ matrix.project }}`),
    "  baseline:",
    "    # Dispatched by smoke baseline: writes the baselines the pull request then proposes for review.",
    "    if: github.event_name == 'workflow_dispatch'",
    `    runs-on: ${RUNNER}`,
    "    timeout-minutes: 70",
    ...image,
    ...matrix(baseline),
    ...env(["      HOME: /root", "      PROJECT: ${{ matrix.project }}"]),
    ...workdir,
    "    steps:",
    ...checkout,
    ...install,
    "      - name: Check the dispatch inputs, then write the baselines",
    `        if: ${suite}`,
    ...secrets(["          MODE: ${{ inputs.baseline }}", "          GREP: ${{ inputs.grep }}"]),
    "        run: |",
    '          case "$MODE" in missing|changed) ;; *) echo "baseline must be missing or changed" >&2; exit 1 ;; esac',
    // Journey ids joined by |: each [a-z0-9][a-z0-9-]*, no empty one (a||b would match every test).
    `          case "$GREP" in ""|"|"*|*"|"|*"||"*|-*|*"|-"*) echo "grep must be journey ids joined by |" >&2; exit 1 ;; esac`,
    `          if [ "$(printf '%s.' "$GREP" | LC_ALL=C tr -d 'a-z0-9|-')" != . ]; then`,
    '            echo "grep must be journey ids joined by |" >&2',
    "            exit 1",
    "          fi",
    "          # Playwright matches --grep against \" <project> <file> <title> <tags>\": anchored, an id matches its own title only.",
    '          npx playwright test --update-snapshots="$MODE" --grep "(^| )($GREP)( |\\$)" --project setup --project "$PROJECT"',
    ...results(`${artifact}-\${{ matrix.project }}`),
    ...upload("argus-smoke-baselines-${{ matrix.project }}", [`${dir}/__screenshots__/`, `${dir}/__aria__/`]),
  ];
  return { code: 0, lines, masked: true };
}
