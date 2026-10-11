// tests/sapu-smoke-gate.test.ts — plugins/sapu/scripts/sapu-smoke-gate.mjs: whether the argus smoke suite's CI run
// on a PR's head blocks sapu-merge.sh. The base commit is a real git repo (the gate reads origin/<base>'s blobs);
// gh is a fake that answers from a map of REST paths, and `gh run download` writes the artifacts a test names.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
// @ts-expect-error — plain ESM script without types
import { smokeGate } from "../plugins/sapu/scripts/sapu-smoke-gate.mjs";
// @ts-expect-error — plain ESM script without types
import { run } from "../plugins/sapu/scripts/argus-live-proc.mjs";

const top = realpathSync(mkdtempSync(join(tmpdir(), "smoke-gate-")));
afterAll(() => rmSync(top, { recursive: true, force: true }));
const REPO = "owner/app";
const SHA = "a".repeat(40);
const WORKFLOW = ".github/workflows/argus-smoke.yml";
let n = 0;

/** A git repo whose one commit holds `files` → {main, base}. */
function baseRepo(files: Record<string, string>) {
  const main = join(top, `r${++n}`);
  mkdirSync(main, { recursive: true });
  const git = (...a: string[]) => execFileSync("git", a, { cwd: main, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "o@example.com");
  git("config", "user.name", "O");
  for (const [f, t] of Object.entries({ "README.md": "x\n", ...files })) {
    mkdirSync(join(main, f, ".."), { recursive: true });
    writeFileSync(join(main, f), t);
  }
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  return { main, base: git("rev-parse", "HEAD").trim() };
}

type Test = { title: string; project: string; status: string; tags?: string[]; file?: string };
/** A Playwright JSON report holding `tests`. */
const report = (tests: Test[]) => ({
  suites: tests.map((t) => ({ file: t.file ?? `${t.title}.spec.ts`, specs: [{ title: t.title, file: t.file ?? `${t.title}.spec.ts`, tags: t.tags ?? [], tests: [{ projectName: t.project, status: t.status, results: [] }] }] })),
});

type Gh = { api: Record<string, unknown>; artifacts?: Record<string, Test[]>; calls: string[][]; fail?: string };
/** A fake runner: gh from `gh`, everything else (git) for real. */
function runner(gh: Gh) {
  return (argv: string[], opts: Record<string, unknown> = {}) => {
    if (argv[0] !== "gh") return run(argv, opts);
    gh.calls.push(argv);
    if (argv[1] === "run" && argv[2] === "download") {
      const dir = argv[argv.indexOf("--dir") + 1];
      for (const [name, tests] of Object.entries(gh.artifacts ?? {})) {
        mkdirSync(join(dir, name), { recursive: true });
        writeFileSync(join(dir, name, "results.json"), JSON.stringify(report(tests)));
      }
      return { status: 0, stdout: "", stderr: "" };
    }
    const words = argv.slice(2);
    const jq = words.includes("--jq") ? words[words.indexOf("--jq") + 1] : null;
    const p = words.find((w, i) => !w.startsWith("-") && words[i - 1] !== "--jq");
    const key = String(p).split("?")[0];
    if (gh.fail && key.includes(gh.fail)) return { status: 1, stdout: "", stderr: "boom" };
    if (!(key in gh.api)) return { status: 1, stdout: "", stderr: "Not Found" };
    const v = gh.api[key];
    if (jq === ".[].filename") return { status: 0, stdout: (v as Array<{ filename: string }>).map((f) => f.filename).join("\n"), stderr: "" };
    // any other filter runs through the real jq, so the filters the gate passes are exercised
    if (jq) return { status: 0, stdout: execFileSync("jq", ["-r", jq], { input: JSON.stringify(v), encoding: "utf8" }), stderr: "" };
    return { status: 0, stdout: JSON.stringify(v), stderr: "" };
  };
}

const runsPath = (wf = "argus-smoke.yml") => `repos/${REPO}/actions/workflows/${wf}/runs`;
const jobsPath = (id: number) => `repos/${REPO}/actions/runs/${id}/jobs`;
const filesPath = `repos/${REPO}/pulls/7/files`;
const wfRun = (id: number, over: Record<string, unknown> = {}) => ({ id, event: "pull_request", status: "completed", conclusion: "failure", head_sha: SHA, repository: { full_name: REPO }, head_repository: { full_name: REPO }, ...over });
const job = (name: string, conclusion: string) => ({ name, status: "completed", conclusion });

/** A red run 11 whose `test (chromium)` job failed on journey `checkout`, the PR touching `files`. */
function redRun(over: Partial<Gh> = {}, files = ["src/app.ts"]): Gh {
  return {
    calls: [],
    api: { [runsPath()]: { workflow_runs: [wfRun(11)] }, [jobsPath(11)]: { jobs: [job("test (chromium)", "failure"), job("test (firefox)", "success"), job("quarantine (chromium)", "success")] }, [filesPath]: files.map((filename) => ({ filename })), [`repos/${REPO}/issues/7`]: { number: 7, pull_request: {}, labels: [{ name: "smoke" }] } },
    artifacts: { "argus-smoke-results-chromium": [{ title: "sign in admin.1", project: "setup", status: "expected", file: "auth.setup.ts" }, { title: "checkout", project: "chromium", status: "unexpected" }, { title: "login", project: "chromium", status: "expected" }] },
    ...over,
  };
}

/** The trusted set the gate resolves (the owner, id 1). */
const OWNER = [{ login: "owner", id: 1 }];
const gate = (main: string, base: string, gh: Gh, extra: Record<string, unknown> = {}, seams: Record<string, unknown> = {}) =>
  smokeGate({ main, repo: REPO, baseRef: base, sha: SHA, pr: 7, closes: [], waitMs: 0, ...extra }, { runner: runner(gh), trusted: () => OWNER, ...seams });
const issuePath = (n: number) => `repos/${REPO}/issues/${n}`;
const eventsPath = `repos/${REPO}/issues/7/events`;
const contentsPath = (rel: string) => `repos/${REPO}/contents/${rel}`;
/** The smoke-regression issue `n` the lane files for journey `id`, as GitHub's REST shows it. */
const regression = (n: number, id: string, over: Record<string, unknown> = {}) => ({ number: n, title: `smoke-regression:${id} broke at step 3`, state: "open", user: { login: "owner", id: 1 }, labels: [{ name: "bug" }, { name: "regression" }, { name: "argus:needs-owner" }], ...over });
/** The PR's labels and its label events: `smoke-override` applied by `actor`. */
const override = (actor: { login: string; id: number }) => ({
  [issuePath(7)]: { number: 7, pull_request: {}, labels: [{ name: "smoke-override" }] },
  [eventsPath]: [{ event: "labeled", label: { name: "smoke-override" }, actor }],
});

describe("smokeGate", () => {
  it("no workflow file on the base commit: no CI wiring, not a block, gh never asked", async () => {
    const { main, base } = baseRepo({});
    const gh: Gh = { api: {}, calls: [] };
    const v = await gate(main, base, gh);
    expect(v.verdict).toBe("no-wiring");
    expect(v.lines.join("\n")).toMatch(/no CI wiring.*argus-smoke\.yml/);
    expect(gh.calls).toEqual([]);
  });

  it("no run of the workflow on the head: missing, not a block (runs of a fork, another repo or a baseline dispatch are not the PR's check)", async () => {
    const { main, base } = baseRepo({ [WORKFLOW]: "name: argus-smoke\n" });
    const others = [wfRun(5, { event: "workflow_dispatch" }), wfRun(6, { head_repository: { full_name: "evil/app" } }), wfRun(7, { repository: { full_name: "other/app" } }), wfRun(8, { head_sha: "b".repeat(40) })];
    const v = await gate(main, base, { api: { [runsPath()]: { workflow_runs: others }, [filesPath]: [] }, calls: [] });
    expect(v.verdict).toBe("missing");
    expect(v.lines.join("\n")).toMatch(/no argus-smoke run on aaaaaaaaaaaa/);
  });

  it("a run still going with no wait: pending", async () => {
    const { main, base } = baseRepo({ [WORKFLOW]: "x\n" });
    const v = await gate(main, base, { api: { [runsPath()]: { workflow_runs: [wfRun(11, { status: "in_progress", conclusion: null })] }, [filesPath]: [] }, calls: [] });
    expect(v).toMatchObject({ verdict: "pending", run: "11" });
  });

  it("waits for a pending run, polling, then judges it; gives up as pending once the wait is spent", async () => {
    const { main, base } = baseRepo({ [WORKFLOW]: "x\n" });
    let t = 0;
    const gh: Gh = { api: { [runsPath()]: { workflow_runs: [wfRun(11, { status: "queued", conclusion: null })] }, [jobsPath(11)]: { jobs: [job("test (chromium)", "success")] }, [filesPath]: [] }, calls: [] };
    const sleep = async (ms: number) => {
      t += ms;
      if (t >= 90_000) gh.api[runsPath()] = { workflow_runs: [wfRun(11, { conclusion: "success" })] };
    };
    const v = await gate(main, base, gh, { waitMs: 600_000 }, { sleep, now: () => t, pollMs: 30_000 });
    expect(v.verdict).toBe("green");
    expect(t).toBe(90_000);
    t = 0;
    gh.api[runsPath()] = { workflow_runs: [wfRun(12, { status: "in_progress", conclusion: null })] };
    const stuck = await gate(main, base, gh, { waitMs: 60_000 }, { sleep: async (ms: number) => void (t += ms), now: () => t, pollMs: 30_000 });
    expect(stuck.verdict).toBe("pending");
    expect(stuck.lines.join("\n")).toMatch(/still running after 1 min/);
  });

  it("a run that has not appeared yet is waited for a short grace only, then it is missing", async () => {
    const { main, base } = baseRepo({ [WORKFLOW]: "x\n" });
    let t = 0;
    const gh: Gh = { api: { [runsPath()]: { workflow_runs: [] }, [filesPath]: [] }, calls: [] };
    const v = await gate(main, base, gh, { waitMs: 3_600_000 }, { sleep: async (ms: number) => void (t += ms), now: () => t, pollMs: 30_000, graceMs: 90_000 });
    expect(v.verdict).toBe("missing");
    expect(t).toBe(90_000);
  });

  it("green: every gating job passed; a failed quarantine job never gates", async () => {
    const { main, base } = baseRepo({ [WORKFLOW]: "x\n" });
    const gh: Gh = { api: { [runsPath()]: { workflow_runs: [wfRun(10, { conclusion: "success" }), wfRun(11, { conclusion: "success" })] }, [jobsPath(11)]: { jobs: [job("test (chromium)", "success"), job("msedge", "skipped"), job("quarantine (chromium)", "failure"), job("baseline (chromium)", "skipped")] }, [filesPath]: [] }, calls: [] };
    const v = await gate(main, base, gh);
    expect(v).toMatchObject({ verdict: "green", run: "11" });
  });

  it("red: a journey failed that is neither quarantined nor closed by the PR", async () => {
    const { main, base } = baseRepo({ [WORKFLOW]: "x\n" });
    const v = await gate(main, base, redRun());
    expect(v).toMatchObject({ verdict: "red", run: "11" });
    expect(v.lines.join("\n")).toMatch(/test \(chromium\).*checkout/);
  });

  it("escape (a): a failing journey whose own spec the PR changes (a heal) is excused", async () => {
    const { main, base } = baseRepo({ [WORKFLOW]: "x\n" });
    const v = await gate(main, base, redRun({}, ["e2e/argus-smoke/checkout.spec.ts", "e2e/argus-smoke/journeys/checkout.json"]));
    expect(v.verdict).toBe("excused");
    expect(v.lines.join("\n")).toMatch(/checkout \(the PR changes its spec\)/);
  });

  it("escape (a): a failing journey the PR's quarantine.json lists (a quarantine proposal) is excused; one it does not list is not", async () => {
    const { main, base } = baseRepo({ [WORKFLOW]: "x\n" });
    const gh = redRun({}, ["e2e/argus-smoke/quarantine.json"]);
    gh.api[contentsPath("e2e/argus-smoke/quarantine.json")] = [{ id: "checkout", issue: null, since: "1", projects: ["chromium"] }];
    const v = await gate(main, base, gh);
    expect(v.verdict).toBe("excused");
    expect(v.lines.join("\n")).toMatch(/checkout \(the PR quarantines it\)/);
    expect(gh.calls.some((c) => c.some((w) => w.includes(`ref=${SHA}`)))).toBe(true);
    gh.api[contentsPath("e2e/argus-smoke/quarantine.json")] = [{ id: "cart" }];
    expect((await gate(main, base, gh)).verdict).toBe("red");
    // the PR's quarantine.json unreadable (deleted at the head, say): nothing excused
    delete gh.api[contentsPath("e2e/argus-smoke/quarantine.json")];
    expect((await gate(main, base, gh)).verdict).toBe("red");
  });

  it("escape (a) is per journey: another journey's spec, the suite's support files or a file beside the suite excuse nothing", async () => {
    const { main, base } = baseRepo({ [WORKFLOW]: "x\n" });
    for (const files of [["e2e/argus-smoke/cart.spec.ts"], ["e2e/argus-smoke/support.ts", "e2e/argus-smoke/playwright.config.ts"], ["e2e/argus-smoke/journeys/checkout.json"], ["e2e/argus-smoke-notes/checkout.spec.ts"]]) {
      const v = await gate(main, base, redRun({}, files));
      expect(v.verdict, files.join(",")).toBe("red");
      expect(v.lines.join("\n")).toMatch(/journey checkout failed/);
    }
  });

  it("escape (a) follows smoke.json's dir and workflow on the base commit", async () => {
    const { main, base } = baseRepo({ ".argus/smoke.json": JSON.stringify({ dir: "qa/smoke", ci: { workflow: "qa.yml", artifact: "qa-results" } }), ".github/workflows/qa.yml": "x\n" });
    const art = { "qa-results-chromium": redRun().artifacts!["argus-smoke-results-chromium"] };
    const gh = redRun({ artifacts: art }, ["qa/smoke/checkout.spec.ts"]);
    gh.api = { ...gh.api, [runsPath("qa.yml")]: gh.api[runsPath()] };
    expect((await gate(main, base, gh)).verdict).toBe("excused");
    const near = redRun({ artifacts: art }, ["e2e/argus-smoke/checkout.spec.ts"]);
    near.api = { ...near.api, [runsPath("qa.yml")]: near.api[runsPath()] };
    expect((await gate(main, base, near)).verdict).toBe("red");
  });

  it("a PR that changes the smoke workflow itself gets no pass from its own run: red, whatever the run says, and before any run is read", async () => {
    const { main, base } = baseRepo({ ".argus/smoke.json": JSON.stringify({ ci: { workflow: "qa.yml" } }), ".github/workflows/qa.yml": "x\n" });
    const gh: Gh = { api: { [runsPath("qa.yml")]: { workflow_runs: [wfRun(11, { conclusion: "success" })] }, [jobsPath(11)]: { jobs: [job("test (chromium)", "success")] }, [filesPath]: [{ filename: ".github/workflows/qa.yml" }], [issuePath(7)]: { number: 7, labels: [] } }, calls: [] };
    const v = await gate(main, base, gh);
    expect(v).toMatchObject({ verdict: "red", run: null });
    expect(v.lines.join("\n")).toMatch(/changes the smoke workflow \(\.github\/workflows\/qa\.yml\)/);
    expect(gh.calls.some((c) => String(c[2]).includes("/runs"))).toBe(false);
    // another workflow is no concern of the smoke check
    gh.api[filesPath] = [{ filename: ".github/workflows/ci.yml" }];
    expect((await gate(main, base, gh)).verdict).toBe("green");
    // a file list GitHub may have cut short cannot show the workflow untouched
    gh.api[filesPath] = Array.from({ length: 3000 }, (_, i) => ({ filename: `f${i}` }));
    expect((await gate(main, base, gh)).verdict).toBe("red");
  });

  it("escape (b): every failing journey is quarantined on the base commit", async () => {
    const { main, base } = baseRepo({ [WORKFLOW]: "x\n", "e2e/argus-smoke/quarantine.json": JSON.stringify([{ id: "checkout", issue: null, since: "1", projects: ["chromium"] }]) });
    const v = await gate(main, base, redRun());
    expect(v.verdict).toBe("excused");
    expect(v.lines.join("\n")).toMatch(/checkout \(quarantined\)/);
  });

  it("a test tagged @quarantine is the quarantine job's: never a failing journey", async () => {
    const { main, base } = baseRepo({ [WORKFLOW]: "x\n" });
    const gh = redRun({ artifacts: { "argus-smoke-results-chromium": [{ title: "checkout", project: "chromium", status: "unexpected", tags: ["@quarantine"] }, { title: "cart", project: "chromium", status: "unexpected" }] } });
    const v = await gate(main, base, gh);
    expect(v.verdict).toBe("red");
    expect(v.lines.join("\n")).toMatch(/cart/);
    expect(v.lines.join("\n")).not.toMatch(/checkout/);
  });

  it("escape (c): the PR closes the smoke-regression issue of every failing journey; another journey's issue is no escape", async () => {
    const { main, base } = baseRepo({ [WORKFLOW]: "x\n" });
    const gh = redRun();
    gh.api[issuePath(12)] = regression(12, "checkout", { title: "argus: smoke-regression:checkout broke at step 3" });
    gh.api[issuePath(13)] = regression(13, "checkout-v2");
    expect((await gate(main, base, gh, { closes: [12] })).verdict).toBe("excused");
    const v = await gate(main, base, gh, { closes: [13] });
    expect(v.verdict).toBe("red");
  });

  it("escape (c) holds only for an issue the lane filed: open, a trusted author, the lane's bug and regression labels, an issue not a PR", async () => {
    const { main, base } = baseRepo({ [WORKFLOW]: "x\n" });
    const cases: Array<[string, Record<string, unknown>]> = [
      ["an outsider's issue", { user: { login: "mallory", id: 66 } }],
      ["a login like the owner's under another id", { user: { login: "owner", id: 66 } }],
      ["no regression label", { labels: [{ name: "bug" }] }],
      ["no bug label", { labels: [{ name: "regression" }] }],
      ["closed", { state: "closed" }],
      ["a pull request", { pull_request: {} }],
    ];
    for (const [why, over] of cases) {
      const gh = redRun();
      gh.api[issuePath(12)] = regression(12, "checkout", over);
      const v = await gate(main, base, gh, { closes: [12] });
      expect(v.verdict, why).toBe("red");
      expect(v.lines.join("\n")).not.toMatch(/mallory|66/);
    }
    // a collaborator in the trusted set files it: trusted
    const gh = redRun();
    gh.api[issuePath(12)] = regression(12, "checkout", { user: { login: "pal", id: 5 }, labels: [{ name: "Bug" }, { name: "Regression" }] });
    expect((await gate(main, base, gh, { closes: [12] }, { trusted: () => [...OWNER, { login: "pal", id: 5 }] })).verdict).toBe("excused");
  });

  it("owner override: smoke-override on the PR, last applied by a trusted account, lets a red through (any red); an outsider's does not", async () => {
    const { main, base } = baseRepo({ [WORKFLOW]: "x\n" });
    const taste = redRun();
    taste.api[jobsPath(11)] = { jobs: [job("taste", "failure")] };
    Object.assign(taste.api, override({ login: "owner", id: 1 }));
    const v = await gate(main, base, taste);
    expect(v.verdict).toBe("excused");
    expect(v.lines.join("\n")).toMatch(/owner override: smoke-override applied by owner/);
    expect(v.lines.join("\n")).toMatch(/taste/);
    // the workflow-change red too
    const wf = redRun({}, [WORKFLOW]);
    Object.assign(wf.api, override({ login: "owner", id: 1 }));
    expect((await gate(main, base, wf)).verdict).toBe("excused");
    // an outsider applied it (or an id posing as the owner's login)
    for (const actor of [{ login: "mallory", id: 66 }, { login: "owner", id: 66 }]) {
      const out = redRun();
      Object.assign(out.api, override(actor));
      expect((await gate(main, base, out)).verdict).toBe("red");
    }
    // the owner applied it, someone removed it, an outsider re-applied it: the last application counts
    const re = redRun();
    Object.assign(re.api, override({ login: "owner", id: 1 }));
    (re.api[eventsPath] as unknown[]).push({ event: "unlabeled", label: { name: "smoke-override" }, actor: { login: "owner", id: 1 } }, { event: "labeled", label: { name: "smoke-override" }, actor: { login: "mallory", id: 66 } });
    expect((await gate(main, base, re)).verdict).toBe("red");
    // applied by the owner once, not on the PR now
    const gone = redRun();
    Object.assign(gone.api, override({ login: "owner", id: 1 }), { [issuePath(7)]: { number: 7, pull_request: {}, labels: [] } });
    expect((await gate(main, base, gone)).verdict).toBe("red");
    // a green run never reads the label
    const green: Gh = { api: { [runsPath()]: { workflow_runs: [wfRun(11, { conclusion: "success" })] }, [jobsPath(11)]: { jobs: [job("test (chromium)", "success")] }, [filesPath]: [] }, calls: [] };
    expect((await gate(main, base, green)).verdict).toBe("green");
    expect(green.calls.some((c) => String(c[2]).includes("/issues/"))).toBe(false);
  });

  it("the escapes cover journeys only: a failed taste job, a sign-in that failed, a cancelled job or a failure no journey explains stays red", async () => {
    const { main, base } = baseRepo({ [WORKFLOW]: "x\n", "e2e/argus-smoke/quarantine.json": JSON.stringify([{ id: "checkout" }]) });
    const taste = redRun();
    taste.api[jobsPath(11)] = { jobs: [job("test (chromium)", "failure"), job("taste", "failure")] };
    expect((await gate(main, base, taste)).lines.join("\n")).toMatch(/taste/);
    expect((await gate(main, base, taste)).verdict).toBe("red");
    const setup = redRun({ artifacts: { "argus-smoke-results-chromium": [{ title: "sign in admin.1", project: "setup", status: "unexpected", file: "auth.setup.ts" }, { title: "checkout", project: "chromium", status: "unexpected" }] } });
    expect((await gate(main, base, setup)).verdict).toBe("red");
    const cancelled = redRun();
    cancelled.api[jobsPath(11)] = { jobs: [job("test (chromium)", "failure"), job("test (firefox)", "cancelled")] };
    expect((await gate(main, base, cancelled)).verdict).toBe("red");
    // firefox failed too, but its results name no failing journey (npm ci broke, say): not explained, so red
    const unexplained = redRun();
    unexplained.api[jobsPath(11)] = { jobs: [job("test (chromium)", "failure"), job("test (firefox)", "failure")] };
    expect((await gate(main, base, unexplained)).verdict).toBe("red");
    // a PR that changes the suite does not clear them either: escape (a) is a journey's, not the run's
    expect((await gate(main, base, { ...taste, api: { ...taste.api, [filesPath]: [{ filename: "e2e/argus-smoke/checkout.spec.ts" }] } })).verdict).toBe("red");
  });

  it("a run that failed before any job, or was cancelled, is red", async () => {
    const { main, base } = baseRepo({ [WORKFLOW]: "x\n" });
    const gh: Gh = { api: { [runsPath()]: { workflow_runs: [wfRun(11, { conclusion: "startup_failure" })] }, [jobsPath(11)]: { jobs: [] }, [filesPath]: [], [issuePath(7)]: { number: 7, labels: [] } }, calls: [] };
    expect((await gate(main, base, gh)).verdict).toBe("red");
    gh.api[runsPath()] = { workflow_runs: [wfRun(11, { conclusion: "cancelled" })] };
    gh.api[jobsPath(11)] = { jobs: [job("test (chromium)", "cancelled")] };
    expect((await gate(main, base, gh)).verdict).toBe("red");
  });

  it("fails closed: gh that cannot answer, or a smoke.json that is not valid, is an error, never a pass", async () => {
    const { main, base } = baseRepo({ [WORKFLOW]: "x\n" });
    await expect(gate(main, base, { api: { [filesPath]: [] }, calls: [], fail: "runs" })).rejects.toThrow(/gh api .* exited 1/);
    const bad = baseRepo({ [WORKFLOW]: "x\n", ".argus/smoke.json": "{" });
    await expect(gate(bad.main, bad.base, { api: {}, calls: [] })).rejects.toThrow(/smoke\.json/);
  });
});
