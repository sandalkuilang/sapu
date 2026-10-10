// argus-live-propose.mjs — every change to the committed smoke suite as a pull request (spec §19.8, §19.10):
// `smoke propose` builds the staged changes in a worktree from the base branch, passes every file and the
// body through scrub's matcher, and opens the pull request sapu never merges; `smoke workflow` prints the CI
// job /sapu:init writes with the owner's consent.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSmoke, SMOKE_DEFAULTS, LIVE_FILE } from "./argus-live-config.mjs";
import { secretHits } from "./argus-live-ledger.mjs";
import { lastRun, RUN_ID } from "./argus-live-lock.mjs";
import { run } from "./argus-live-proc.mjs";
import { scrubSecrets } from "./argus-live-scrub.mjs";
import { readSuitePaths } from "./argus-live-smoke.mjs";
import { changeDigest, generated, liveAsWritten, readStaged, readState, STATE_FILE, writeStaged } from "./argus-live-suite.mjs";
import { agentFiledLabel, loadContract } from "./sapu-contract.mjs";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const PR_URL = /https:\/\/[^\s/]+\/[^\s/]+\/[^\s/]+\/pull\/\d+/;
/** Where the suite's baselines and adopted violations live (spec §19.2): a conflict there is never resolved by picking a side. */
const BASELINE_DIRS = ["__screenshots__", "__aria__", "known"];
const NEEDED = (id) => `baseline: needed ${id} (smoke baseline --from-run after this PR's first CI run)`;

/** Writes the lane's local state whole (0600). */
function writeState(main, state) {
  const file = path.join(main, STATE_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** A code fence around `text` longer than any backtick run in it, so nothing in it closes the fence. */
function fenced(text, lang = "") {
  const run = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const f = "`".repeat(run + 1);
  return `${f}${lang}\n${text}\n${f}`;
}

/** A change's line in `changes.jsonl` (spec §19.8): `{kind, id, step?, from?, to?, evidence, run}`. */
const logLine = (c) => JSON.stringify({ kind: c.kind, id: c.id, ...(c.step !== undefined ? { step: c.step } : {}), ...(c.from !== undefined ? { from: c.from } : {}), ...(c.to !== undefined ? { to: c.to } : {}), evidence: String(c.evidence ?? ""), run: c.run });
const changeLine = (c) => `change ${c.kind} ${c.id}${Number.isInteger(c.step) ? ` step ${c.step}` : ""}`;

/**
 * The outcome of each open proposal asked of gh (`gh pr view <url> --json state`): MERGED → merged (accepted),
 * CLOSED → closed (rejected, remembered by its digest). `state` is updated in place; true when anything changed.
 */
function refreshOutcomes(state, { runner, gh, cwd }) {
  const asked = new Map();
  let changed = false;
  for (const p of Object.values(state.proposals)) {
    if (!isObj(p) || p.outcome !== "open" || typeof p.url !== "string" || !PR_URL.test(p.url)) continue;
    if (!asked.has(p.url)) {
      const r = runner([gh, "pr", "view", p.url, "--json", "state", "--jq", ".state"], { cwd });
      asked.set(p.url, r.status === 0 ? String(r.stdout ?? "").trim() : "");
    }
    const word = asked.get(p.url);
    const outcome = word === "MERGED" ? "merged" : word === "CLOSED" ? "closed" : null;
    if (outcome) [p.outcome, changed] = [outcome, true];
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

/** Applies the staged changes to the suite directory `at` (spec §19.8, §19.9). */
function applyChanges(at, changes) {
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
      if (!isObj(c.journey) || c.journey.journey !== c.id || !Array.isArray(c.journey.path)) throw new Error(`refused: smoke propose: the staged ${c.kind} of ${c.id} holds no journey file`);
      fs.mkdirSync(path.join(at, "journeys"), { recursive: true });
      fs.writeFileSync(path.join(at, "journeys", `${c.id}.json`), `${JSON.stringify(c.journey, null, 2)}\n`);
    } else if (c.kind === "drop" || c.kind === "retire") {
      for (const p of [`journeys/${c.id}.json`, `${c.id}.spec.ts`, `known/${c.id}.json`, `__aria__/${c.id}`]) rm(p);
      for (const project of fs.existsSync(path.join(at, "__screenshots__")) ? fs.readdirSync(path.join(at, "__screenshots__")) : []) {
        for (const platform of fs.readdirSync(path.join(at, "__screenshots__", project))) rm(`__screenshots__/${project}/${platform}/${c.id}`);
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

/** The journeys of the suite at `at` whose screenshots no baseline holds yet (`__screenshots__/<project>/<platform>/<id>/`). */
function baselinesNeeded(at, ids) {
  const have = new Set();
  const shots = path.join(at, "__screenshots__");
  for (const project of fs.existsSync(shots) ? fs.readdirSync(shots) : []) {
    for (const platform of fs.readdirSync(path.join(shots, project))) for (const id of fs.readdirSync(path.join(shots, project, platform))) have.add(id);
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
  const staged = readStaged(main);
  const refreshed = refreshOutcomes(state, { runner, gh, cwd: main });
  const lines = [];
  const todo = [];
  const skipped = new Set();
  for (const ch of staged) {
    const p = state.proposals[changeDigest(ch)];
    if (isObj(p) && (p.outcome === "closed" || p.outcome === "open")) {
      lines.push(`skip ${ch.kind} ${ch.id}: ${p.outcome === "closed" ? "rejected" : "proposed already"} in ${p.url}`);
      skipped.add(ch);
    } else todo.push(ch);
  }
  const runId = lastRun(main) ?? todo.at(-1)?.run;
  if (todo.length && !RUN_ID.test(String(runId))) throw new Error("refused: smoke propose: no run names the proposal's branch");
  const branch = `argus/smoke-${runId}`;
  if (dryRun) {
    if (!todo.length) return { code: 0, lines: [...lines, "smoke propose: nothing to propose"] };
    return { code: 0, lines: [...lines, `would propose on ${branch}: ${todo.length} change(s)`, ...todo.map(changeLine)] };
  }
  const settle = () => {
    if (refreshed) writeState(main, state);
    if (skipped.size) writeStaged(main, staged.filter((ch) => !skipped.has(ch)));
  };
  if (!todo.length) {
    settle();
    return { code: 0, lines: [...lines, "smoke propose: nothing to propose"] };
  }
  const secrets = secretsOf(main, [...new Set([...todo.map((ch) => ch.run)])], env);
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
    applyChanges(at, todo);
    const files = generated(wt, { live, smoke, verb: "smoke propose" });
    fs.mkdirSync(at, { recursive: true });
    // fixtures.ts is the owner's: created when missing, never overwritten.
    for (const [name, text] of Object.entries(files)) if (name !== "fixtures.ts" || !fs.existsSync(path.join(at, name))) fs.writeFileSync(path.join(at, name), text);
    const ids = readSuitePaths(wt, dir).map((p) => p.id);
    for (const f of fs.readdirSync(at).filter((n) => n.endsWith(".spec.ts") && !ids.includes(n.slice(0, -8)))) fs.rmSync(path.join(at, f));
    const log = [...carried.log, ...todo.map(logLine)];
    const logFile = path.join(at, "changes.jsonl");
    fs.appendFileSync(logFile, todo.map((ch) => `${logLine(ch)}\n`).join(""));
    const npmRun = runner([npm, "install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: at, env });
    if (npmRun.status !== 0) throw new Error(`refused: smoke propose: npm install --package-lock-only failed (exit ${npmRun.status ?? "on a signal"})`);
    g(["add", "-A", "--", dir]);
    const changed = String(g(["diff", "--cached", "--name-only"]).stdout).trim().split("\n").filter(Boolean);
    const needed = [...new Set([...baselinesNeeded(at, ids), ...carried.dropped.map((f) => f.slice(dir.length + 1).split("/").at(-2)).filter((id) => ids.includes(id))])].sort();
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
      for (const ch of todo) state.proposals[changeDigest(ch)] = { kind: ch.kind, id: ch.id, branch, url, outcome: "open" };
      writeState(main, state);
      writeStaged(main, staged.filter((ch) => !skipped.has(ch) && !todo.includes(ch)));
      return {
        code: 0,
        lines: [...lines, `branch: ${branch}`, ...todo.map(changeLine), ...carried.dropped.map((f) => `baseline: dropped ${f} (it conflicts with origin/${base})`), ...needed.map(NEEDED), `proposed: ${url}`],
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

/** `smoke workflow` → `{code, lines}`: the CI workflow's YAML, one line each. */
export function smokeWorkflow(main) {
  throw new Error("refused: smoke workflow: not built yet");
}
