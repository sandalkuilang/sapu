// argus-live-baseline.mjs — the suite's baselines from CI (spec §19.8): `smoke baseline` dispatches CI's baseline
// job for a triaged run, and adopts a baseline run's screenshots, ARIA snapshots and known violations as a
// proposal. Artifacts are read through argus-live-ci.mjs, by name and shape; their text is untrusted.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { anySuite, noWiring, ARTIFACT, BASELINES, CHECK, download, fetchRun, ghOut, home, isPng, notesOf, PNG_MAX, PROJECT, regular, reportsIn, suiteIdsAt, testsOf, TEXT_MAX } from "./argus-live-ci.mjs";
import { loadSmoke, SMOKE_DEFAULTS } from "./argus-live-smokecfg.mjs";
import { secretHits } from "./argus-live-ledger.mjs";
import { lastRun } from "./argus-live-lock.mjs";
import { run } from "./argus-live-proc.mjs";
import { scrubSecrets } from "./argus-live-scrub.mjs";
import { smokeEvent } from "./argus-live-smoke.mjs";
import { codeBlock, readState, writeState } from "./argus-live-suite.mjs";
import { agentFiledLabel } from "./sapu-contract.mjs";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
/** `s` parsed as JSON, or null. */
const parse = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

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
 * names (spec §19.8; `<id>.spec` is the runner's {testFileBaseName}) — `__screenshots__/<project>/<platform>/<id>.spec/<n>.png`
 * (a PNG under 5 MB, never msedge's) and `__aria__/<id>.spec/<n>.aria.yml` (UTF-8 under 1 MB, pruned) — of journeys in
 * `ids`; everything else is skipped unread. The run's `argus-violation` annotations (`reports`, its results.json) of
 * those journeys become `known/<id>.json`, sorted `{check, key}` rows, merged with the branch's own when committed.
 */
function adoptable(tmp, { ids, dir, reports }) {
  const files = new Map();
  let skipped = 0;
  for (const art of fs.readdirSync(tmp).sort()) {
    if (!ARTIFACT.test(art) || !art.startsWith(BASELINES) || !fs.lstatSync(path.join(tmp, art)).isDirectory()) continue;
    const suffix = art.slice(BASELINES.length + 1);
    for (const rel of filesIn(path.join(tmp, art))) {
      const file = path.join(tmp, art, ...rel.split("/"));
      const shot = /^__screenshots__\/([a-z0-9-]{1,40})\/(linux|darwin|win32)\/([a-z0-9][a-z0-9-]{0,63})\.spec\/([a-z0-9][a-z0-9-]{0,63})\.png$/.exec(rel);
      const aria = /^__aria__\/([a-z0-9][a-z0-9-]{0,63})\.spec\/([a-z0-9][a-z0-9-]{0,63})\.aria\.yml$/.exec(rel);
      const id = shot ? shot[3] : aria ? aria[1] : null;
      let entry = null;
      if (id && ids.includes(id) && shot && PROJECT.test(shot[1]) && !["msedge", "setup"].includes(shot[1])) {
        const bytes = regular(file, PNG_MAX);
        if (isPng(bytes)) entry = { rel, bytes, id, step: shot[4], project: shot[1] };
      } else if (id && ids.includes(id) && aria) {
        const bytes = regular(file, TEXT_MAX);
        const text = bytes && bytes.toString("utf8");
        if (text !== null && Buffer.from(text, "utf8").equals(bytes)) entry = { rel, bytes: Buffer.from(pruneAria(text)), original: text, id, step: aria[2], project: PROJECT.test(suffix) ? suffix : null };
      }
      if (!entry || files.has(entry.rel)) skipped += entry ? 0 : 1;
      else files.set(entry.rel, { ...entry, rel: path.posix.join(dir, entry.rel) });
    }
  }
  const known = new Map();
  for (const rep of reports) {
    for (const t of testsOf(rep).filter((x) => ids.includes(x.title) && x.file === `${x.title}.spec.ts` && PROJECT.test(String(x.project)))) {
      const k = known.get(t.title) ?? { rows: new Map(), projects: new Set() };
      for (const x of notesOf(t).good.filter((v) => v.word === "check")) [k.rows.set(JSON.stringify([x.check, x.key]), { check: x.check, key: x.key }), k.projects.add(t.project)];
      known.set(t.title, k);
    }
  }
  for (const [id, { rows, projects }] of known) {
    if (rows.size) files.set(`known/${id}`, { rel: path.posix.join(dir, "known", `${id}.json`), bytes: Buffer.from(JSON.stringify([...rows.values()])), known: [...rows.values()], id, step: null, project: projects.size === 1 ? [...projects][0] : null });
  }
  return { files: [...files.values()], skipped };
}

/** `known/<id>.json`'s text: the branch's own rows (codegen and the checks read a JSON list of `{check, key}`) and `rows`, sorted, each once. */
function knownFile(file, rows) {
  const was = parse(regular(file, TEXT_MAX)?.toString("utf8") ?? "[]");
  const all = [...(Array.isArray(was) ? was : []), ...rows].filter((v) => isObj(v) && CHECK.test(String(v.check)) && typeof v.key === "string" && v.key && v.key.length <= 500);
  const keep = [...new Map(all.map((v) => [JSON.stringify([v.check, v.key]), { check: v.check, key: v.key }])).values()].sort((a, b) => (a.check + a.key < b.check + b.key ? -1 : 1));
  return `${JSON.stringify(keep, null, 2)}\n`;
}

/** The `{check, key}` rows of a `known/<id>.json` (none when it is missing or not a list). */
const knownRows = (file) => {
  const was = parse(regular(file, TEXT_MAX)?.toString("utf8") ?? "[]");
  return Array.isArray(was) ? was.filter((v) => isObj(v) && typeof v.check === "string" && typeof v.key === "string") : [];
};

/**
 * The journeys baseline run `r` was dispatched to re-baseline (mode `changed`), from smoke-state's `dispatches`: the
 * records naming the run, else those of its branch whose run gh never printed. Only their changed files are adopted.
 */
function rebaselined(state, r) {
  const named = state.dispatches.filter((d) => isObj(d) && d.ciRun === r.id);
  const recs = named.length ? named : state.dispatches.filter((d) => isObj(d) && d.ciRun === null && d.branch === r.branch);
  return new Set(recs.filter((d) => d.mode === "changed" && Array.isArray(d.ids)).flatMap((d) => d.ids));
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
 * file's journey, step and project, labelled agent-filed). A file the branch lacks is adopted; one it holds that the
 * run changed only for a journey the run was dispatched to re-baseline (rebaselined). New known violation rows only with
 * `known` (the owner's `--known`), each listed in a pull request's body, never committed onto a proposal branch unseen:
 * a re-baseline must not hide an a11y or layout regression. Every text file and the body pass scrub's matcher first.
 */
function adopt(main, { r, repo, contract, smoke, ids, known, runner, verb }) {
  const tmp = download(main, { id: r.id, repo, prefix: BASELINES, runner, verb });
  let adopted;
  let res = null;
  try {
    // The baseline job's results (results.json at each artifact's root): their violations are the known candidates.
    try {
      res = download(main, { id: r.id, repo, prefix: smoke.ci.artifact, runner, verb });
    } catch {
      res = null;
    }
    adopted = adoptable(tmp, { ids, dir: smoke.dir, reports: res ? reportsIn(res, smoke.ci.artifact).reports : [] });
  } finally {
    if (res) fs.rmSync(res, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const skip = adopted.skipped ? [`skipped: ${adopted.skipped} file(s) outside the suite's baseline names, msedge's, not a PNG or over their size`] : [];
  if (!adopted.files.length) return { code: 2, lines: [`baseline: run ${r.id} wrote nothing sapu adopts`, ...skip] };
  const wtRoot = fs.mkdtempSync(path.join(os.tmpdir(), "argus-baseline-"));
  const wt = path.join(wtRoot, "wt");
  try {
    gitOut(runner, main, ["fetch", "-q", "--no-tags", "origin", `refs/heads/${r.branch}`], verb);
    if (gitOut(runner, main, ["rev-parse", "FETCH_HEAD"], verb) !== r.sha) throw new Error(`refused: ${verb}: run ${r.id} is stale: ${r.branch} has moved past its head ${r.sha.slice(0, 12)}`);
    gitOut(runner, main, ["worktree", "add", "-q", "--detach", wt, r.sha], verb);
    const changedOk = rebaselined(readState(main), r);
    const notes = [];
    const files = [];
    for (const f of adopted.files) {
      const at = path.join(wt, f.rel);
      if (f.known) {
        const was = new Set(knownRows(at).map((v) => JSON.stringify([v.check, v.key])));
        const fresh = f.known.filter((v) => !was.has(JSON.stringify([v.check, v.key])));
        if (!fresh.length) continue;
        if (known) files.push({ ...f, fresh });
        else notes.push(`known: ${fresh.length} new violation row(s) of ${f.id} not adopted (smoke baseline --known adopts them, listed in a pull request)`);
        continue;
      }
      const before = fs.existsSync(at) ? regular(at, PNG_MAX) : null;
      if (before && before.equals(f.bytes)) continue;
      if (before && !changedOk.has(f.id)) notes.push(`skipped: ${f.rel} differs from ${r.branch}, and run ${r.id} was not dispatched to re-baseline ${f.id}`);
      else files.push(f);
    }
    if (!files.length) return { code: 2, lines: [`baseline: run ${r.id} wrote nothing sapu adopts`, ...notes, ...skip] };
    const fresh = files.filter((f) => f.fresh);
    const direct = r.branch.startsWith("argus/") && !fresh.length;
    const dest = direct ? r.branch : `argus/baselines-${r.id}`;
    const row = (f) => `| \`${f.rel}\` | ${f.id} | ${f.step && /^[0-9]+$/.test(f.step) ? f.step : "—"} | ${f.project ?? "—"} |`;
    const listed = fresh.length ? ["", "New known violations, adopted with `--known`: each row below stops failing its check from this merge on. The rows the branch already holds are unchanged.", "", ...codeBlock(fresh.flatMap((f) => f.fresh.map((v) => `+ ${f.rel} ${JSON.stringify({ check: v.check, key: v.key })}`)))] : [];
    const body = [`argus smoke: the baselines CI's baseline run ${r.id} wrote on \`${r.branch}\` (${r.sha.slice(0, 12)}), for review in this pull request's image view (2-up, swipe, onion skin). Merging accepts them; a test fails until its baseline is accepted.`, "", "| file | journey | step | project |", "|---|---|---|---|", ...files.map(row), ...listed, ""].join("\n");
    const changes = files.map((f) => JSON.stringify({ kind: "baseline", id: f.id, ...(f.step && /^[0-9]+$/.test(f.step) ? { step: Number(f.step) } : {}), to: f.rel, evidence: [`CI baseline run ${r.id} (${f.project ?? "baseline job"})`], run: r.id }));
    const { secrets, refusal } = scrubSecrets(main, { runId: lastRun(main) });
    if (refusal) throw new Error(`refused: ${verb}: ${refusal.replace(/^refused: (scrub: )?/, "")}`);
    const hits = [];
    for (const [name, text] of [...files.filter((f) => !f.rel.endsWith(".png")).flatMap((f) => [[f.rel, f.original ?? f.bytes.toString("utf8")], [f.rel, f.bytes.toString("utf8")]]), ["the pull request's body", body]]) {
      for (const h of secretHits(text, secrets)) hits.push(`${name} ${h.line}:${h.col} ${h.cls}`);
    }
    if (hits.length) return { code: 1, lines: [...new Set(hits), `refused: ${verb}: ${new Set(hits).size} secret(s) in the adopted files; nothing is pushed`] };
    for (const f of files) {
      fs.mkdirSync(path.dirname(path.join(wt, f.rel)), { recursive: true });
      fs.writeFileSync(path.join(wt, f.rel), f.known ? knownFile(path.join(wt, f.rel), f.known) : f.bytes);
    }
    fs.appendFileSync(path.join(wt, smoke.dir, "changes.jsonl"), `${changes.join("\n")}\n`);
    gitOut(runner, wt, ["add", "-A", "--", smoke.dir], verb);
    const who = ["-c", `user.name=${contract.ghUser}`, "-c", `user.email=${contract.gitEmail}`, "-c", "commit.gpgsign=false"];
    gitOut(runner, wt, [...who, "commit", "-q", "-m", `argus: smoke baselines from CI run ${r.id}`, "-m", `${files.length} file(s) the baseline job wrote on ${r.branch}, adopted by name and shape.`, "-m", `Signed-off-by: ${contract.ghUser} <${contract.gitEmail}>`], verb);
    const sha = gitOut(runner, wt, ["rev-parse", "HEAD"], verb);
    gitOut(runner, wt, ["push", "-q", "origin", `HEAD:refs/heads/${dest}`], verb);
    if (direct) return { code: 0, lines: [`baseline: committed ${files.length} file(s) to ${dest} (${sha.slice(0, 12)})`, ...notes, ...skip] };
    const bodyFile = path.join(wtRoot, "body.md");
    fs.writeFileSync(bodyFile, body, { mode: 0o600 });
    const pr = runner(["gh", "pr", "create", "--repo", repo, "--base", r.branch, "--head", dest, "--title", `argus: smoke baselines from CI run ${r.id}`, "--body-file", bodyFile, "--label", agentFiledLabel(contract)], { cwd: main });
    const url = /https:\/\/\S+\/pull\/[0-9]+/.exec(String(pr.stdout ?? ""));
    if (!url) return { code: 2, lines: [`baseline: pushed ${dest} (${sha.slice(0, 12)}); gh pr create exited ${pr.status ?? "on a signal"} before printing a pull request URL`, ...notes, ...skip] };
    smokeEvent(main, lastRun(main), { kind: "proposal", url: url[0], branch: dest, changes: files.length });
    return { code: 0, lines: [`baseline: ${files.length} file(s) proposed in ${url[0]} (${dest} into ${r.branch})`, ...notes, ...skip] };
  } finally {
    runner(["git", "-C", main, "worktree", "remove", "--force", wt]);
    fs.rmSync(wtRoot, { recursive: true, force: true });
  }
}

/**
 * `smoke baseline --from-run <id> [--ids <id>,…]` → `{code, lines}` (spec §19.8, decision 7). Run `fromRun` of the
 * contract's home repo, refused from a fork or another repository, or stale (its branch moved past its head).
 * - A baseline run (`workflow_dispatch`): its `argus-smoke-baselines…` artifacts adopted by name and shape (of `ids`
 *   only, when given; new known rows only with `known`) and committed as `adopt` says.
 * - A normal run, triaged by `smoke ci` first: the workflow's baseline job dispatched on the run's branch, `missing`
 *   for its `baseline-missing` journeys and `changed` for exactly `ids` (each with a visual or ARIA mismatch; no
 *   mismatch is re-baselined unasked) → `baseline: dispatched <ids> mode=<m>; adopt with smoke baseline --from-run
 *   <new run>`, each dispatch recorded in smoke-state's `dispatches`. Without the right to dispatch, the `gh workflow
 *   run` line is printed for the owner (code 2).
 */
export async function smokeBaseline(main, { fromRun, ids, known = false }, { runner = run } = {}) {
  const verb = "smoke baseline";
  if (fromRun === null || fromRun === undefined) throw new Error(`refused: ${verb}: --from-run <run id> names the CI run`);
  const { repo, base, contract } = home(main, verb);
  const loaded = loadSmoke(main);
  if (loaded.errors.length) throw new Error(`refused: ${verb}: ${loaded.errors.join("; ")}`);
  const smoke = loaded.smoke ?? SMOKE_DEFAULTS;
  const none = noWiring(main, smoke, verb);
  if (none) return none;
  anySuite(main, smoke, verb);
  for (const id of ids ?? []) if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error(`refused: ${verb}: the suite has no path that`);
  const r = fetchRun(main, { asked: fromRun, repo, base, workflow: smoke.ci.workflow, runner, verb });
  notStale(main, { r, repo, runner, verb });
  // The run's own commit holds its suite: a proposal's run triages and adopts the journeys the proposal adds.
  const suite = suiteIdsAt(main, { r, dir: smoke.dir, runner }).ids;
  for (const id of ids ?? []) if (!suite.includes(id)) throw new Error(`refused: ${verb}: the suite has no path ${id}`);
  if (r.event === "workflow_dispatch") return adopt(main, { r, repo, contract, smoke, ids: ids ?? suite, known, runner, verb });
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
  const dispatches = [];
  let code = 0;
  for (const [mode, list] of jobs) {
    const argv = ["workflow", "run", smoke.ci.workflow, "--repo", repo, "--ref", r.branch, "-f", `baseline=${mode}`, "-f", `grep=${list.join("|")}`];
    const d = runner(["gh", ...argv], { cwd: main });
    if (d.status === 0) {
      const id = /\/actions\/runs\/([0-9]{1,20})/.exec(String(d.stdout ?? ""));
      lines.push(`baseline: dispatched ${list.join(",")} mode=${mode}; adopt with smoke baseline --from-run ${id ? id[1] : `<the new run> (gh run list --workflow ${smoke.ci.workflow} --event workflow_dispatch --branch ${r.branch})`}`);
      dispatches.push({ ciRun: id ? id[1] : null, from: r.id, branch: r.branch, mode, ids: list });
    } else {
      code = 2;
      const shown = `gh ${argv.slice(0, -1).join(" ")} grep='${list.join("|")}'`;
      if (/HTTP 403|HTTP 404|not accessible|scope|permission|admin rights/i.test(String(d.stderr ?? ""))) lines.push("baseline: no right to dispatch the workflow (it needs write access and the actions scope); the owner runs:", shown);
      else lines.push(`failed: gh workflow run exited ${d.status ?? "on a signal"}; the owner may run:`, shown);
    }
  }
  if (dispatches.length) {
    const state = readState(main);
    state.dispatches = [...state.dispatches, ...dispatches].slice(-100);
    writeState(main, state);
  }
  return { code, lines };
}
