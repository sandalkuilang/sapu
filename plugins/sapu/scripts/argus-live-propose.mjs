// argus-live-propose.mjs — every change to the committed smoke suite as a pull request (spec §19.8, §19.10):
// `smoke propose` builds the staged changes in a worktree from the base branch, passes every file and the
// body through scrub's matcher, and opens the pull request sapu never merges; `smoke workflow` prints the CI
// job /sapu:init writes with the owner's consent.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SMOKE_PLAYWRIGHT, suiteProjects } from "./argus-live-codegen.mjs";
import { LIVE_FILE, loadSmoke, SMOKE_DEFAULTS } from "./argus-live-config.mjs";
import { secretHits } from "./argus-live-ledger.mjs";
import { lastRun, RUN_ID } from "./argus-live-lock.mjs";
import { run } from "./argus-live-proc.mjs";
import { scrubSecrets } from "./argus-live-scrub.mjs";
import { readSuitePaths, smokeEvent } from "./argus-live-smoke.mjs";
import { changeDigest, generated, liveAsWritten, readState, writeState } from "./argus-live-suite.mjs";
import { agentFiledLabel, loadContract } from "./sapu-contract.mjs";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const PR_URL = /https:\/\/[^\s/]+\/[^\s/]+\/[^\s/]+\/pull\/\d+/;
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

/**
 * The outcome of each open proposal asked of gh (`gh pr view <url> --json state`): MERGED → merged (accepted),
 * CLOSED → closed (rejected: its digest moves into `rejected`, so no verb stages that change again). `state` is
 * updated in place; true when anything changed.
 */
function refreshOutcomes(state, { runner, gh, cwd }) {
  const asked = new Map();
  let changed = false;
  for (const [digest, p] of Object.entries(state.proposals)) {
    if (!isObj(p) || p.outcome !== "open" || typeof p.url !== "string" || !PR_URL.test(p.url)) continue;
    if (!asked.has(p.url)) {
      const r = runner([gh, "pr", "view", p.url, "--json", "state", "--jq", ".state"], { cwd });
      asked.set(p.url, r.status === 0 ? String(r.stdout ?? "").trim() : "");
    }
    const word = asked.get(p.url);
    const outcome = word === "MERGED" ? "merged" : word === "CLOSED" ? "closed" : null;
    if (outcome) [p.outcome, changed] = [outcome, true];
    if (outcome === "closed" && !state.rejected.includes(digest)) state.rejected.push(digest);
  }
  return changed;
}

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
  let quarantine = null;
  try {
    quarantine = JSON.parse(fs.readFileSync(qFile, "utf8"));
  } catch {
    quarantine = null;
  }
  const had = Array.isArray(quarantine);
  quarantine = had ? quarantine.filter(isObj) : [];
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
      quarantine = [...quarantine.filter((x) => x.id !== c.id), { id: q.id, issue: q.issue ?? null, since: q.since ?? c.run }];
    } else if (c.kind === "unquarantine") quarantine = quarantine.filter((q) => q.id !== c.id);
  }
  if (had || quarantine.length) fs.writeFileSync(qFile, `${JSON.stringify(quarantine, null, 2)}\n`);
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
 * `labels.agentFiled`, or its body updated. Lines: `branch:`, `change …`, `baseline: dropped …`, `baseline:
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
  for (const ch of staged) {
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
  // The lane runs' ledgers: an entry smoke ci staged names a CI run (digits), whose change carries no page value.
  const secrets = secretsOf(main, [...new Set([runId, ...todo.map((ch) => ch.run).filter((r) => !/^[0-9]{1,20}$/.test(r))])], env);
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
      const r = open && PR_URL.test(open)
        ? runner([gh, "pr", "edit", open, ...repoFlag, "--body-file", msg], { cwd: main })
        : runner([gh, "pr", "create", ...repoFlag, "--base", base, "--head", branch, "--title", title, "--body-file", msg, "--label", agentFiledLabel(c.contract)], { cwd: main });
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

/**
 * The suite's CI projects (spec §19.6), from codegen's suiteProjects, the generated config's own list: every one
 * but msedge runs in the pinned container (the screenshot projects, the engines and `chromium-<width>`, write the
 * baselines; `a11y` its ARIA files; `a11y` and `i18n` take no screenshot), and msedge, when smoke.json's browsers
 * name it, on the plain runner, whose image ships Edge, with no screenshot.
 */
function projectsOf(live, smoke) {
  const projects = suiteProjects({ live, smoke });
  return { container: projects.filter((p) => p.browser !== "msedge").map((p) => p.name), msedge: projects.some((p) => p.browser === "msedge"), engine: projects.find((p) => p.kind === "browser" && p.browser !== "msedge")?.name ?? null };
}

/** Every `${NAME}` live.json names (passwords, TOTP secrets, env values): the CI secrets the suite reads by name. */
const secretNames = (live) => [...new Set([...JSON.stringify(live).matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]))].sort();

/**
 * `smoke workflow` → `{code, lines, masked}`: `.github/workflows/<smoke.ci.workflow>` as /sapu:init writes it,
 * only with the owner's consent (spec §19.10): on pull requests, pushes to the base branch and a dispatch
 * (`baseline`: missing|changed, `grep`); `contents: read` and never `pull_request_target`; a fork's pull
 * request skipped; every action pinned to the commit `gh api` resolves, its tag in a comment; checkout without
 * persisted credentials; the gating `test` job in the pinned Playwright container (`--ipc=host --init`), a
 * matrix over the container projects, `npm ci` then `--shuffle --grep-invert @quarantine`; `msedge` on the
 * plain runner; the non-gating `quarantine` job; the dispatch-only `baseline` job, whose inputs reach the
 * shell only through `env:` and are checked against `^(missing|changed)$` and `^[a-z0-9|-]+$` first; results
 * and written baselines uploaded for 7 days, never `.auth/`; the `${NAME}` names live.json uses as
 * `secrets.<NAME>`. The lines hold names, never a value (`masked`: printed as they are).
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
  const use = {};
  for (const [k, a] of Object.entries(ACTIONS)) use[k] = pinned(a, { runner, gh, cwd: main });
  const { container, msedge, engine } = projectsOf(live, smoke);
  if (!container.length || !engine) throw new Error("refused: smoke workflow: smoke.json's browsers name no browser of the pinned container (chromium, firefox or webkit)");
  const dir = smoke.dir;
  const artifact = smoke.ci.artifact;
  const fork = "(github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository)";
  const env = (extra = []) => ["    env:", ...extra, ...secretNames(live).map((n) => `      ${n}: \${{ secrets.${n} }}`)];
  const checkout = [`      - uses: ${use.checkout}`, "        with:", "          persist-credentials: false"];
  const image = ["    container:", `      image: mcr.microsoft.com/playwright:v${SMOKE_PLAYWRIGHT}-noble`, "      options: --ipc=host --init"];
  const matrix = ["    strategy:", "      fail-fast: false", "      matrix:", `        project: [${container.join(", ")}]`];
  const workdir = ["    defaults:", "      run:", `        working-directory: ${dir}`];
  const upload = (name, paths) => [`      - uses: ${use.upload}`, "        if: ${{ !cancelled() }}", "        with:", `          name: ${name}`, ...(paths.length === 1 ? [`          path: ${paths[0]}`] : ["          path: |", ...paths.map((p) => `            ${p}`)]), "          retention-days: 7"];
  const results = (name) => upload(name, [`${dir}/test-results/`]);
  const lines = [
    `# ${smoke.ci.workflow}: the argus smoke suite (${dir}), generated by sapu's argus-live.mjs smoke workflow.`,
    "# /sapu:init writes it with the owner's consent; change .argus/smoke.json and regenerate rather than edit it.",
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
    ...matrix,
    ...env(["      HOME: /root", "      PROJECT: ${{ matrix.project }}"]),
    ...workdir,
    "    steps:",
    ...checkout,
    "      - run: npm ci",
    '      - run: npx playwright test --shuffle --grep-invert @quarantine --project setup --project "$PROJECT"',
    ...results(`${artifact}-\${{ matrix.project }}`),
    ...(msedge
      ? [
          "  msedge:",
          "    # Edge is the runner image's own (never installed by sapu), so it has no screenshot baseline.",
          `    if: github.event_name != 'workflow_dispatch' && ${fork}`,
          `    runs-on: ${RUNNER}`,
          "    timeout-minutes: 70",
          ...env(),
          ...workdir,
          "    steps:",
          ...checkout,
          `      - uses: ${use.node}`,
          "        with:",
          "          node-version: 22",
          "      - run: npm ci",
          "      - run: npx playwright install chromium",
          "      - run: npx playwright test --shuffle --grep-invert @quarantine --project setup --project msedge",
          ...results(`${artifact}-msedge`),
        ]
      : []),
    "  quarantine:",
    "    # Quarantined tests leave the critical path, never sight: this job runs them and never gates.",
    `    if: github.event_name != 'workflow_dispatch' && ${fork}`,
    `    runs-on: ${RUNNER}`,
    "    timeout-minutes: 70",
    "    continue-on-error: true",
    ...image,
    ...env(["      HOME: /root"]),
    ...workdir,
    "    steps:",
    ...checkout,
    "      - run: npm ci",
    `      - run: npx playwright test --grep @quarantine --pass-with-no-tests --project setup --project ${engine}`,
    ...results(`${artifact}-quarantine`),
    "  baseline:",
    "    # Dispatched by smoke baseline: writes the baselines the pull request then proposes for review.",
    "    if: github.event_name == 'workflow_dispatch'",
    `    runs-on: ${RUNNER}`,
    "    timeout-minutes: 70",
    ...image,
    ...matrix,
    ...env(["      HOME: /root", "      PROJECT: ${{ matrix.project }}"]),
    ...workdir,
    "    steps:",
    ...checkout,
    "      - run: npm ci",
    "      - name: Check the dispatch inputs, then write the baselines",
    "        env:",
    "          MODE: ${{ inputs.baseline }}",
    "          GREP: ${{ inputs.grep }}",
    "        run: |",
    '          case "$MODE" in missing|changed) ;; *) echo "baseline must be missing or changed" >&2; exit 1 ;; esac',
    `          if [ -z "$GREP" ] || [ "$(printf '%s.' "$GREP" | LC_ALL=C tr -d 'a-z0-9|-')" != . ]; then`,
    '            echo "grep must be journey ids joined by |" >&2',
    "            exit 1",
    "          fi",
    '          npx playwright test --update-snapshots="$MODE" --grep "$GREP" --project setup --project "$PROJECT"',
    ...results(`${artifact}-\${{ matrix.project }}`),
    ...upload("argus-smoke-baselines-${{ matrix.project }}", [`${dir}/__screenshots__/`, `${dir}/__aria__/`]),
  ];
  return { code: 0, lines, masked: true };
}
