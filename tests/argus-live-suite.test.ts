// tests/argus-live-suite.test.ts — the smoke suite's lifecycle (spec §19.3, §19.4, §19.8, §19.10): `smoke plan`
// ranks the catalog into the suite's members, `smoke admit` stages a path that held fresh and dirty, `smoke
// propose` opens the staged changes as a pull request, `smoke check` names hand edits, and `smoke workflow`
// prints the CI job. gh and npm are stand-ins; git is real, against a local bare origin.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FIXTURE_CONTRACT } from "./fixture-contract";
import { ARGUS_LIVE, cleanTemps, committed, example, git, liveRun, tempDir } from "./helpers/argus-live";
// @ts-expect-error — plain ESM script without types
import { generateSuite, SMOKE_PLAYWRIGHT, smokeConfig, suiteProjects } from "../plugins/sapu/scripts/argus-live-codegen.mjs";
// @ts-expect-error — plain ESM script without types
import { SMOKE_DEFAULTS, validateSmoke } from "../plugins/sapu/scripts/argus-live-smokecfg.mjs";
// @ts-expect-error — plain ESM script without types
import { appendLedger, ledgerFile } from "../plugins/sapu/scripts/argus-live-ledger.mjs";
// @ts-expect-error — plain ESM script without types
import { run } from "../plugins/sapu/scripts/argus-live-proc.mjs";
// @ts-expect-error — plain ESM script without types
import { pw } from "../plugins/sapu/scripts/argus-live-pw.mjs";
// @ts-expect-error — plain ESM script without types
import { down, writeRunFiles } from "../plugins/sapu/scripts/argus-live-run.mjs";
// @ts-expect-error — plain ESM script without types
import { mintSlot } from "../plugins/sapu/scripts/argus-live-slots.mjs";
// @ts-expect-error — plain ESM script without types
import { changeDigest, readState, smokeAdmit, smokeCheck, smokePlan, smokeRetire, stage } from "../plugins/sapu/scripts/argus-live-suite.mjs";
// @ts-expect-error — plain ESM script without types
import { report } from "../plugins/sapu/scripts/argus-live-report.mjs";
// @ts-expect-error — plain ESM script without types
import { seededOrder } from "../plugins/sapu/scripts/argus-live-smoke.mjs";
// @ts-expect-error — plain ESM script without types
import { smokePropose, smokeWorkflow } from "../plugins/sapu/scripts/argus-live-propose.mjs";

type Obj = Record<string, any>;

afterEach(cleanTemps);

/** A catalog journey: `roles` its steps' roles in order, `filed` how many findings it filed. */
const journey = (id: string, { money = false, global = false, roles = ["customer"], filed = 0 }: { money?: boolean; global?: boolean; roles?: string[]; filed?: number } = {}): Obj => ({
  id,
  domain: "shop",
  title: id,
  money,
  global,
  goal: `the ${id} goal`,
  steps: roles.map((role) => ({ role, goal: `a ${role} step` })),
  filed: Array.from({ length: filed }, (_, i) => `https://github.com/owner/app/issues/${i + 1}`),
});

/** The fixture catalog: e pinned (by smoke.json), d money, b filed twice, c and f two roles, a the rest, g global, x dropped. */
const CATALOG = (): Obj => ({
  roots: ["src"],
  journeys: [
    journey("a"),
    journey("b", { filed: 2 }),
    journey("c", { roles: ["customer", "sales"] }),
    journey("d", { money: true }),
    journey("e"),
    journey("f", { roles: ["sales", "customer", "sales"] }),
    journey("g", { global: true }),
  ],
  dropped: [{ id: "x", reason: "step 1 anchor gone", head: "0".repeat(40) }],
});

/** A repo holding `catalog` as .argus/journeys.json, `smoke` as .argus/smoke.json (null: none) and suite paths for `members`. */
const planRepo = ({ catalog = CATALOG(), smoke = { pin: ["e"] } as Obj | null, members = [] as string[] } = {}) => {
  const main = committed();
  mkdirSync(join(main, ".argus"), { recursive: true });
  writeFileSync(join(main, ".argus/journeys.json"), JSON.stringify(catalog));
  if (smoke) writeFileSync(join(main, ".argus/smoke.json"), JSON.stringify(smoke));
  const dir = join(main, (smoke && smoke.dir) || "e2e/argus-smoke", "journeys");
  mkdirSync(dir, { recursive: true });
  for (const id of members) writeFileSync(join(dir, `${id}.json`), JSON.stringify({ journey: id, path: [], admitted: null }));
  return main;
};

/**
 * A runner whose `gh` answers from `answers` (a function of gh's argv → `{status, stdout}`; default: no open
 * pull request), recording each gh call; every other command runs for real.
 */
const ghStub = (answers: (argv: string[]) => { status: number; stdout: string } = () => ({ status: 0, stdout: "[]" })) => {
  const calls: string[][] = [];
  const runner = (argv: string[], opts: Obj = {}) => {
    if (argv[0] !== "gh") return run(argv, opts);
    calls.push(argv.slice(1));
    const a = answers(argv.slice(1));
    return { status: a.status, stdout: a.stdout, stderr: "" };
  };
  return { runner, calls };
};

const plan = (main: string, answers?: (argv: string[]) => { status: number; stdout: string }) => smokePlan(main, { runner: ghStub(answers).runner });

describe("smoke plan — the catalog ranked into the suite's members (spec §19.3)", () => {
  it("ranks pin > money > exposure > filed > roles > id, skipping global and dropped journeys", () => {
    const r = plan(planRepo());
    expect(r.code).toBe(0);
    // e pinned; d money (exposure doubles with money, as SELECT's score has it); b filed; c and f two roles, by id; a.
    expect(r.lines).toEqual(["capture e", "capture d", "capture b", "capture c", "capture f", "capture a", "drop g (global)"]);
    expect(r.lines.join("\n")).not.toMatch(/\bx\b/);
  });

  it("members already in the suite rank before non-members of their tier, never above a higher tier", () => {
    const r = plan(planRepo({ members: ["a", "f"] }));
    expect(r.lines).toEqual(["capture e", "capture d", "keep f", "keep a", "capture b", "capture c", "drop g (global)"]);
  });

  it("the first max minus exclude are the target set; the rest are dropped past the cap", () => {
    const r = plan(planRepo({ smoke: { pin: ["e"], exclude: ["d"], max: 3 }, members: ["c"] }));
    expect(r.lines).toEqual(["capture e", "keep c", "capture b", "drop d (excluded)", "drop f (past the cap)", "drop a (past the cap)", "drop g (global)"]);
  });

  it("every line kind: keep, capture, drop with each reason, heal, quarantined, pending, upgrade", () => {
    const main = planRepo({ smoke: { pin: ["e"], exclude: ["f"] }, members: ["a", "b", "c", "d", "e", "f", "gone", "old"] });
    const dir = join(main, "e2e/argus-smoke");
    // d's last lane pass broke at a locator: a heal decides it.
    const runId = "20300101000000-0123abcd";
    mkdirSync(join(main, ".argus/live", runId, "smoke"), { recursive: true });
    writeFileSync(join(main, ".argus/live", runId, "smoke/pass.jsonl"), `${JSON.stringify({ id: "d", verdict: "broke", step: 3, kind: "target-missing", seed: 1 })}\n${JSON.stringify({ id: "a", verdict: "held", step: null, kind: null, seed: 1 })}\n`);
    writeFileSync(join(dir, "quarantine.json"), JSON.stringify([{ id: "b", issue: 12, since: "20300101000000-0123abcd" }]));
    // old's issue was closed as not planned: retired.
    writeFileSync(join(main, ".argus/smoke-state.json"), JSON.stringify({ journeys: { old: { retire: true } } }));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ devDependencies: { "@playwright/test": "1.63.2" } }));
    const catalog = CATALOG();
    catalog.journeys.push(journey("old"), journey("h"));
    const prs = [
      { url: "https://github.com/owner/app/pull/7", headRefName: "argus/smoke-20300101000000-0123abcd", files: [{ path: "e2e/argus-smoke/journeys/h.json" }, { path: "e2e/argus-smoke/h.spec.ts" }] },
      { url: "https://github.com/owner/app/pull/8", headRefName: "feature/x", files: [{ path: "e2e/argus-smoke/journeys/c.json" }] },
    ];
    writeFileSync(join(main, ".argus/journeys.json"), JSON.stringify(catalog));
    const r = plan(main, () => ({ status: 0, stdout: JSON.stringify(prs) }));
    expect(r.lines).toEqual([
      "keep e",
      "heal d",
      "quarantined b",
      "keep c",
      "keep a",
      "pending h https://github.com/owner/app/pull/7",
      "drop f (excluded)",
      "drop old (retired)",
      "drop g (global)",
      "drop gone (out of the map)",
      `upgrade 1.63.2 → ${SMOKE_PLAYWRIGHT} (baseline run needed)`,
    ]);
  });

  it("asks gh for the open pull requests of argus/ branches; a gh failure is named, never fatal", () => {
    const main = planRepo();
    const s = ghStub();
    smokePlan(main, { runner: s.runner });
    expect(s.calls).toEqual([["pr", "list", "--state", "open", "--limit", "100", "--json", "url,headRefName,files"]]);
    const r = plan(main, () => ({ status: 1, stdout: "" }));
    expect(r.lines.at(-1)).toBe("note: open argus/ pull requests not checked (gh exited 1)");
  });

  it("refuses a pinned global, a pinned dropped journey, a pin the catalog lacks, and no catalog", () => {
    expect(() => plan(planRepo({ smoke: { pin: ["g"] } }))).toThrow("refused: smoke plan: g is global: a global journey is never pinned");
    expect(() => plan(planRepo({ smoke: { pin: ["x"] } }))).toThrow("refused: smoke plan: x is dropped from the catalog (step 1 anchor gone): a dropped journey is never pinned");
    expect(() => plan(planRepo({ smoke: { pin: ["nope"] } }))).toThrow("refused: smoke plan: pin names nope, which the catalog does not hold");
    const none = committed();
    expect(() => plan(none)).toThrow("refused: smoke plan: no journey catalog (.argus/journeys.json): run map-check first");
  });

  it("refuses a broken smoke.json; without one the defaults rule", () => {
    const main = planRepo({ smoke: null });
    expect(plan(main).lines[0]).toBe("capture d");
    writeFileSync(join(main, ".argus/smoke.json"), JSON.stringify({ max: 99 }));
    expect(() => plan(main)).toThrow("refused: smoke plan: max must be an integer from 1 to 50");
  });

  it("through the CLI: refused unless the repo's own contract keeps traces visible", () => {
    const cli = (main: string, env: Obj = {}) => spawnSync(process.execPath, [ARGUS_LIVE, "smoke", "plan"], { cwd: main, encoding: "utf8", env: { ...process.env, ...env } });
    const contract = (main: string, policy: Obj | null) => {
      mkdirSync(join(main, ".claude"), { recursive: true });
      writeFileSync(join(main, ".claude/sapu.json"), JSON.stringify({ ...FIXTURE_CONTRACT, ...(policy ? { policy } : {}) }));
      git(main, "add", ".claude");
      git(main, "-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", "commit", "-qm", "contract");
    };
    const TRACE = "refused: smoke: a committed suite would leave a trace\n";
    const none = planRepo();
    expect(cli(none).stderr).toBe(TRACE);
    const hidden = planRepo();
    contract(hidden, { traces: "none" });
    expect(cli(hidden).stderr).toBe(TRACE);
    // A local contract (outside the repo, found by the origin remote) leaves no trace either: refused.
    const local = planRepo();
    const home = tempDir();
    git(local, "remote", "add", "origin", "https://github.com/owner/app.git");
    mkdirSync(join(home, ".config/sapu/repos/owner__app"), { recursive: true });
    writeFileSync(join(home, ".config/sapu/repos/owner__app/sapu.json"), JSON.stringify(FIXTURE_CONTRACT));
    expect(cli(local, { HOME: home }).stderr).toMatch(/^refused: /);
    const ok = planRepo();
    contract(ok, null);
    const r = cli(ok, { PATH: `${tempDir()}:/usr/bin:/bin` });
    expect(r.stderr).toBe("");
    expect(r.stdout.split("\n").slice(0, 2)).toEqual(["capture e", "capture d"]);
  }, 60_000);
});

describe("a heal the owner closed: pending-regression, quarantined, until the owner retires it or a fix holds (spec §19.9)", () => {
  const LANE = "20300101000000-0123abcd";
  const HEAL_URL = "https://github.com/owner/app/pull/9";
  const DIGEST = "d".repeat(64);
  /** A repo whose suite holds a and d, the lane's last pass holding d `verdict`, and d's heal proposed in HEAL_URL (open). */
  const closedHealRepo = (verdict = "broke") => {
    const main = planRepo({ members: ["a", "d"] });
    mkdirSync(join(main, ".argus/live", LANE, "smoke"), { recursive: true });
    writeFileSync(join(main, ".argus/live", LANE, "smoke/pass.jsonl"), `${JSON.stringify({ id: "d", verdict, step: verdict === "held" ? null : 3, kind: verdict === "held" ? null : "target-missing", seed: 1 })}\n`);
    writeFileSync(join(main, ".argus/smoke-state.json"), JSON.stringify({ proposals: { [DIGEST]: { kind: "heal", id: "d", branch: `argus/smoke-${LANE}`, url: HEAL_URL, outcome: "open" } } }));
    return main;
  };
  /** gh: no open pull request; `state` for `gh pr view`. */
  const viewed = (state: string) => (argv: string[]) => (argv[1] === "view" ? { status: 0, stdout: `${state}\n` } : { status: 0, stdout: "[]" });
  const QUARANTINE = (since = LANE) => ({ id: "d", issue: null, since });

  it("smoke plan asks gh how the heal ended; closed → pending-regression <id> <url>, a quarantine staged, the digest rejected", () => {
    const main = closedHealRepo();
    const s = ghStub(viewed("CLOSED"));
    const r = smokePlan(main, { runner: s.runner });
    expect(s.calls).toContainEqual(["pr", "view", HEAL_URL, "--json", "state", "--jq", ".state"]);
    const state = readState(main);
    const q = state.staged.find((x: Obj) => x.kind === "quarantine");
    expect(r.lines).toEqual(["capture e", `pending-regression d ${HEAL_URL}`, "keep a", "capture b", "capture c", "capture f", "drop g (global)", `quarantine d: staged until the owner decides (digest ${q.digest.slice(0, 12)})`]);
    expect(state.rejected).toEqual([DIGEST]);
    expect(state.proposals[DIGEST].outcome).toBe("closed");
    expect(state.journeys.d.regression).toEqual({ url: HEAL_URL, run: LANE });
    expect(q).toMatchObject({ kind: "quarantine", id: "d", run: LANE, quarantine: QUARANTINE() });
    expect(q.changes[0].evidence.join("\n")).toContain(`its heal ${HEAL_URL} was closed unmerged`);
    // The next plan asks gh nothing more about it and stages nothing twice; the line stays until the owner decides.
    const again = ghStub(viewed("CLOSED"));
    const r2 = smokePlan(main, { runner: again.runner });
    expect(again.calls.filter((a) => a[1] === "view")).toEqual([]);
    expect(r2.lines).toContain(`pending-regression d ${HEAL_URL}`);
    expect(r2.lines.filter((l: string) => l.startsWith("quarantine d"))).toEqual([]);
    expect(readState(main).staged).toHaveLength(1);
  });

  it("a merged heal, or one still open, is no regression", () => {
    for (const word of ["MERGED", "OPEN"]) {
      const main = closedHealRepo();
      const r = smokePlan(main, { runner: ghStub(viewed(word)).runner });
      expect(r.lines.join("\n")).not.toContain("pending-regression");
      expect(readState(main).staged).toEqual([]);
      expect(readState(main).rejected).toEqual([]);
    }
  });

  it("once quarantine.json holds it, nothing more is staged; a quarantine the owner closed is named, never staged again", () => {
    const main = closedHealRepo();
    writeFileSync(join(main, "e2e/argus-smoke/quarantine.json"), JSON.stringify([QUARANTINE()]));
    const r = smokePlan(main, { runner: ghStub(viewed("CLOSED")).runner });
    expect(r.lines).toContain(`pending-regression d ${HEAL_URL}`);
    expect(r.lines.join("\n")).not.toMatch(/^quarantine d/m);
    expect(readState(main).staged).toEqual([]);
    rmSync(join(main, "e2e/argus-smoke/quarantine.json"));
    const state = readState(main);
    const digest = changeDigest({ kind: "quarantine", id: "d", run: LANE, changes: [{ kind: "quarantine", id: "d" }], quarantine: QUARANTINE() });
    writeFileSync(join(main, ".argus/smoke-state.json"), JSON.stringify({ ...state, rejected: [...state.rejected, digest] }));
    expect(smokePlan(main, { runner: ghStub().runner }).lines.at(-1)).toBe(`quarantine d: not staged (rejected before; digest ${digest.slice(0, 12)})`);
  });

  it("a fix the lane's pass holds ends it: the mark and the quarantine it staged are gone, the line is keep", () => {
    const main = closedHealRepo();
    smokePlan(main, { runner: ghStub(viewed("CLOSED")).runner });
    writeFileSync(join(main, ".argus/live", LANE, "smoke/pass.jsonl"), `${JSON.stringify({ id: "d", verdict: "held", step: null, kind: null, seed: 2 })}\n`);
    const r = smokePlan(main, { runner: ghStub().runner });
    expect(r.lines[1]).toBe("keep d");
    const state = readState(main);
    expect(state.journeys.d.regression).toBeUndefined();
    expect(state.staged).toEqual([]);
  });

  it("smoke retire <id>: the owner's ruling stages a retire in place of the journey's other changes; plan lists it retired, then capture once it left the suite", () => {
    const main = closedHealRepo();
    smokePlan(main, { runner: ghStub(viewed("CLOSED")).runner });
    const r = smokeRetire(main, "d");
    const state = readState(main);
    expect(state.staged).toHaveLength(1);
    const st = state.staged[0];
    expect(st).toMatchObject({ kind: "retire", id: "d", run: LANE, changes: [{ kind: "retire", id: "d", run: LANE }] });
    expect(r).toEqual({ code: 0, lines: [`retire d: staged (digest ${st.digest.slice(0, 12)}); smoke propose removes it from the suite, then smoke plan lists it capture`] });
    expect(state.journeys.d).toEqual({ retire: true });
    expect(smokePlan(main, { runner: ghStub().runner }).lines).toContain("drop d (retired)");
    // The retire merged: d left the suite, its mark goes, and the catalog's d is captured again.
    rmSync(join(main, "e2e/argus-smoke/journeys/d.json"));
    expect(smokePlan(main, { runner: ghStub().runner }).lines[1]).toBe("capture d");
    expect(readState(main).journeys.d).toEqual({});
  });

  it("a retire the owner closed clears the mark: the journey is kept, and that retire is never staged again", () => {
    const main = closedHealRepo("held");
    const first = smokeRetire(main, "d");
    expect(first.code).toBe(0);
    const state = readState(main);
    const digest = state.staged[0].digest;
    writeFileSync(join(main, ".argus/smoke-state.json"), JSON.stringify({ ...state, staged: [], proposals: { ...state.proposals, [digest]: { kind: "retire", id: "d", branch: `argus/smoke-${LANE}`, url: "https://github.com/owner/app/pull/10", outcome: "open" } } }));
    const r = smokePlan(main, { runner: ghStub((argv) => (argv[1] === "view" ? { status: 0, stdout: argv[2].endsWith("/10") ? "CLOSED\n" : "MERGED\n" } : { status: 0, stdout: "[]" })).runner });
    expect(r.lines[1]).toBe("keep d");
    expect(readState(main).journeys.d.retire).toBeUndefined();
    expect(smokeRetire(main, "d")).toEqual({ code: 0, lines: [`retire d: not staged (this change was rejected before; digest ${digest.slice(0, 12)})`] });
    expect(readState(main).journeys.d.retire).toBeUndefined();
  });

  it("smoke retire refuses a journey the suite lacks, a bad id, and a repo with no lane run", () => {
    const main = closedHealRepo();
    expect(() => smokeRetire(main, "zz")).toThrow("refused: smoke retire: the suite has no path zz");
    expect(() => smokeRetire(main, "Bad Id")).toThrow("refused: smoke retire: that is not a journey id");
    rmSync(join(main, ".argus/live"), { recursive: true });
    expect(() => smokeRetire(main, "d")).toThrow("refused: smoke retire: no lane run names the change (run a journey cycle first)");
    expect(readState(main).staged).toEqual([]);
  });
});

/** example()'s config with test ids and a seed trigger (the smoke tests' own). */
const pathLive = (): Obj => ({
  ...example(),
  test_id_attribute: "data-testid",
  triggers: { ...example().triggers, "seed-stock": { argv: ["npm", "run", "-s", "explore:seed", "--", "{1}"], args: ["^[A-Za-z0-9-]{1,64}$"], seed: true } },
});
/** A path (spec §19.4) as an explorer writes it: accounts by role word, as its slot allocated them. */
const PATH = (fill = "2"): Obj[] => [
  { context: { viewport: 1440 } },
  { as: "system", do: "trigger", name: "seed-stock", values: ["{{marker}}"] },
  { as: "system", expect: "fact-equals", marker: "{{marker}}", field: "stock", value: "5" },
  { as: "customer", do: "goto", path: "/orders/new" },
  { as: "customer", do: "fill", target: { label: "Quantity" }, value: fill },
  { as: "customer", do: "click", target: { role: "button", name: "Place order" } },
  { as: "customer", do: "read", target: { testId: "order-number" }, save: "order" },
  { as: "customer", expect: "visible", target: { text: "{{order}}" } },
  { as: "sales", do: "goto", path: "/" },
  { as: "sales", expect: "visible", target: { text: "{{order}}" } },
];
const rmLedger = (main: string, runId: string) => rmSync(ledgerFile(main, runId));
/** A cookie value the run's ledger holds, built at run time (never a literal in the repo). */
const COOKIE = () => `${["sess", "ion"].join("")}${randomBytes(12).toString("hex")}`;

describe("smoke admit — a path staged once it held fresh and dirty (spec §19.4)", () => {
  const runs: { main: string; runId: string }[] = [];
  afterEach(async () => {
    for (const r of runs.splice(0)) await down(r.main, { runId: r.runId, graceMs: 1000 }).catch(() => {});
  });
  /**
   * A live cycle whose catalog holds checkout (capture) and whose slot 1, allocated customer.1 = buyer2 and
   * sales.1 = sales1, returned `path`; the run's ledger holds `cookie`.
   */
  const admitRun = async (path: Obj[] = PATH(), { cookie = COOKIE(), members = [] as string[], held = [] as string[], smoke = null as Obj | null } = {}) => {
    const t = liveRun();
    writeFileSync(join(t.main, ".argus/live.json"), `${JSON.stringify(pathLive(), null, 2)}\n`);
    writeFileSync(join(t.main, ".argus/live.env"), "PW=pw-1\nSALES_TOTP=GEZDGNBVGY3TQOJQ\nDB_PW=db-now\n");
    // The map routes of checkout's steps (one twice) ride the admitted journey file, for the CTA-route check.
    const checkout = journey("checkout", { money: true, roles: ["customer", "sales"] });
    checkout.steps = [...checkout.steps.map((st: Obj, i: number) => ({ ...st, route: i ? "/inbox" : "/orders/new" })), { role: "customer", goal: "again", route: "/orders/new" }];
    writeFileSync(join(t.main, ".argus/journeys.json"), JSON.stringify({ journeys: [checkout, journey("refund")] }));
    const ports = { api: 41001, web: 41002, pg: 41003, redis: 41004, smtp: 41005 };
    writeRunFiles(t.main, { runId: t.runId, worktree: t.wt, worktreeHead: "a".repeat(40), home: t.home, origins: ["http://localhost:41002"], allowOrigins: [], groups: [], env: t.env, ports, instanceId: "0123456789abcdef", slots: {}, internal: { proxy: 41009 }, browser: { channel: "chrome" } });
    runs.push({ main: t.main, runId: t.runId });
    for (const id of members) {
      mkdirSync(join(t.main, "e2e/argus-smoke/journeys"), { recursive: true });
      writeFileSync(join(t.main, "e2e/argus-smoke/journeys", `${id}.json`), JSON.stringify({ journey: id, path: [], admitted: null }));
    }
    // Suite members whose paths parse: the admission's dirty run comes after one pass over them.
    for (const id of held) {
      mkdirSync(join(t.main, "e2e/argus-smoke/journeys"), { recursive: true });
      writeFileSync(join(t.main, "e2e/argus-smoke/journeys", `${id}.json`), JSON.stringify({ journey: id, path: SUITE_PATH(), admitted: null }));
    }
    if (smoke) writeFileSync(join(t.main, ".argus/smoke.json"), JSON.stringify(smoke));
    appendLedger(t.main, t.runId, [{ c: "cookie", v: cookie }]);
    const { token } = await mintSlot(t.main, { slot: 1, journey: "checkout", accounts: { "customer.1": "buyer2@example.test", "sales.1": "sales1@example.test" } });
    const r = await pw(t.main, [token, "submit", JSON.stringify({ journey: "checkout", status: "done", path })]);
    expect(r.out).toEqual(["submitted: slot 1 generation 1 status done"]);
    return { ...t, cookie };
  };
  /** A runOnce stand-in answering each call's exit in turn (default 0), recording what it was given. */
  const stub = (exits: number[] = [], broke = { step: 7, kind: "expect-failed" }) => {
    const calls: Obj[] = [];
    const once = async (_main: string, ref: string | null, opts: Obj) => {
      calls.push({ ref, ...opts });
      const code = exits[calls.length - 1] ?? 0;
      const last = code === 0 ? "PATH held" : code === 3 ? `PATH broke step=${broke.step} kind=${broke.kind}` : "HARNESS: step 2 system trigger exited 1";
      return { code, lines: [opts.dirty ? "dirty: instance 0123456789abcdef" : "fresh: instance 0123456789abcdef", last] };
    };
    return { once, calls };
  };
  const admit = (main: string, ref: string, once: unknown, seed: number | null = 5) => smokeAdmit(main, ref, { once, seed, runner: ghStub().runner });

  it("runs the return's path fresh (up --fresh once), at every viewport width, then dirty, renumbered to the suite's accounts, and stages it", async () => {
    const t = await admitRun();
    const s = stub();
    const r = await admit(t.main, "1.1", s.once);
    expect(r.code).toBe(0);
    expect(r.lines).toEqual(["seed: 5", "admit checkout: widths 1440, 390; dirty after 0 suite path(s) in seed order", "admit checkout: held fresh and dirty; staged for smoke propose"]);
    expect(s.calls.map((c) => c.dirty)).toEqual([false, true, true]);
    expect(s.calls.filter((c) => c.dirty === false)).toHaveLength(1);
    // The slot's customer.1 is buyer2, the suite's customer.2; sales1 is the suite's sales.1.
    const want = PATH().map((el) => (el.as && el.as !== "system" ? { ...el, as: el.as === "customer" ? "customer.2" : "sales.1" } : el));
    const at = (w: number) => [{ context: { viewport: w } }, ...want.slice(1)];
    expect(s.calls.map((c) => c.path)).toEqual([{ id: "checkout", list: at(1440) }, { id: "checkout", list: at(390) }, { id: "checkout", list: at(1440) }]);
    const staged = readState(t.main).staged;
    expect(staged).toHaveLength(1);
    expect(staged[0]).toMatchObject({ kind: "add", id: "checkout", run: t.runId, changes: [{ kind: "add", id: "checkout", evidence: `held fresh and dirty in run ${t.runId} (seed 5)`, run: t.runId }], digest: changeDigest(staged[0]) });
    const routes = [{ role: "customer", route: "/orders/new" }, { role: "sales", route: "/inbox" }];
    expect({ path: staged[0].path, admitted: staged[0].admitted, routes: staged[0].routes }).toEqual({ path: want, admitted: { run: t.runId, head: "a".repeat(40), pathSha: expect.stringMatching(/^[0-9a-f]{64}$/), seed: 5 }, routes });
    expect(statSync(join(t.main, ".argus/smoke-state.json")).mode & 0o777).toBe(0o600);
    // Without a seed one is drawn, printed and recorded.
    const u = await admit(t.main, "1.1", stub().once, null);
    const seed = Number(/^seed: (\d+)$/.exec(u.lines[0])![1]);
    expect(readState(t.main).staged[0].admitted.seed).toBe(seed);
    expect(readState(t.main).staged).toHaveLength(1);
    // Each admission is an event of the cycle, and the cycle's report counts it.
    expect(eventsOf(t.main, t.runId)).toEqual([{ kind: "admitted", id: "checkout" }, { kind: "admitted", id: "checkout" }]);
    expect(reportOf(t.main, t.runId)).toContain("- admitted checkout");
    // A path a closed proposal rejected is not staged again.
    const state = readState(t.main);
    writeFileSync(join(t.main, ".argus/smoke-state.json"), JSON.stringify({ ...state, staged: [], rejected: [state.staged[0].digest] }));
    const again = await admit(t.main, "1.1", stub().once, 5);
    expect(again.lines.at(-1)).toBe(`admit checkout: held fresh and dirty; not staged (a closed proposal rejected this path; digest ${state.staged[0].digest.slice(0, 12)})`);
    expect(readState(t.main).staged).toEqual([]);
  }, 30_000);

  it("a break in either run refuses with the run, the kind and the step, and stages nothing", async () => {
    const t = await admitRun();
    await expect(admit(t.main, "1.1", stub([3]).once)).rejects.toThrow("refused: admit checkout: fresh expect-failed at step 7");
    await expect(admit(t.main, "1.1", stub([0, 3], { step: 4, kind: "target-missing" }).once)).rejects.toThrow("refused: admit checkout: width 390 target-missing at step 4");
    const dirty = stub([0, 0, 3], { step: 4, kind: "target-missing" });
    await expect(admit(t.main, "1.1", dirty.once)).rejects.toThrow("refused: admit checkout: dirty target-missing at step 4");
    expect(dirty.calls.map((c) => c.dirty)).toEqual([false, true, true]);
    const harness = await admit(t.main, "1.1", stub([2]).once);
    expect(harness.code).toBe(2);
    expect(harness.lines.at(-1)).toBe("admit checkout: harness (fresh): step 2 system trigger exited 1");
    expect(readState(t.main).staged).toEqual([]);
    expect(existsSync(join(t.main, ".argus/smoke-state.json"))).toBe(false);
  }, 30_000);

  it("the dirty run comes after one pass over the suite's other paths in the recorded seed's order; a journey's own viewports narrow the widths", async () => {
    const t = await admitRun(PATH(), { held: ["refund", "returns", "wishlist"], smoke: { journeys: { checkout: { viewports: [1440] } } } });
    const s = stub();
    const r = await admit(t.main, "1.1", s.once, 7);
    expect(r.lines).toContain("admit checkout: widths 1440; dirty after 3 suite path(s) in seed order");
    expect(s.calls.map((c) => [c.path.id, c.dirty])).toEqual([["checkout", false], ...seededOrder(["refund", "returns", "wishlist"], 7).map((id: string) => [id, true]), ["checkout", true]]);
    // Another path's break is smoke run's to judge; its harness failure stops the admission.
    const h = await admit(t.main, "1.1", stub([0, 2]).once, 7);
    expect(h.code).toBe(2);
    expect(h.lines.at(-1)).toBe(`admit checkout: harness (suite pass, ${seededOrder(["refund", "returns", "wishlist"], 7)[0]}): step 2 system trigger exited 1`);
    expect((await admit(t.main, "1.1", stub([0, 3]).once, 7)).code).toBe(0);
  }, 30_000);

  it("refuses a journey smoke plan does not list as capture", async () => {
    const t = await admitRun(PATH(), { members: ["checkout"] });
    const s = stub();
    await expect(admit(t.main, "1.1", s.once)).rejects.toThrow("refused: admit checkout: smoke plan lists it as keep, not capture");
    writeFileSync(join(t.main, ".argus/smoke.json"), JSON.stringify({ exclude: ["checkout"] }));
    await expect(admit(t.main, "1.1", s.once)).rejects.toThrow("refused: admit checkout: smoke plan lists it as drop (excluded), not capture");
    expect(s.calls).toEqual([]);
  }, 30_000);

  it("refuses a path whose values hold a ledger secret, by step, field and class, never by value", async () => {
    const cookie = COOKIE();
    const t = await admitRun(PATH(`x-${cookie}`), { cookie });
    const s = stub();
    let msg = "";
    await admit(t.main, "1.1", s.once).catch((e: Error) => (msg = e.message));
    expect(msg).toBe("refused: admit checkout: a secret in its values: step 4 value cookie");
    expect(msg).not.toContain(cookie.slice(0, 8));
    expect(s.calls).toEqual([]);
    // A ledger that is gone: nothing can be checked, so nothing is staged.
    rmLedger(t.main, t.runId);
    await expect(admit(t.main, "1.1", s.once)).rejects.toThrow(/^refused: admit checkout: its values cannot be checked \(the run's secret ledger is gone/);
  }, 30_000);

  it("refuses a ref that is not <slot>.<generation>, no cycle, a slot that returned no path", async () => {
    const t = await admitRun();
    const s = stub();
    await expect(admit(t.main, "1.1.1", s.once)).rejects.toThrow("refused: smoke admit: 1.1.1 is not <slot>.<generation>");
    await expect(admit(t.main, "2.1", s.once)).rejects.toThrow("refused: smoke admit: slot 2 generation 1 has not submitted");
    await expect(admit(committed(), "1.1", s.once)).rejects.toThrow("refused: no journey cycle is running");
    const { token } = await mintSlot(t.main, { slot: 3, journey: "refund", accounts: { "customer.1": "buyer1@example.test" } });
    await pw(t.main, [token, "submit", JSON.stringify({ journey: "refund", status: "done" })]);
    await expect(admit(t.main, "3.1", s.once)).rejects.toThrow("refused: smoke admit: slot 3 generation 1 returned no path");
    expect(s.calls).toEqual([]);
  }, 30_000);
});

/** The path above as the suite numbers its accounts (what admit stages). */
/** Run `runId`'s smoke events (smokeEvent's lines), and its report's lines (report, written from the run's records). */
const eventsOf = (main: string, runId: string): Obj[] => readFileSync(join(main, ".argus/live", runId, "smoke/events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const reportOf = (main: string, runId: string): string[] => readFileSync(report(main, { run: runId }, { env: { PATH: process.env.PATH ?? "" } }).lines[0].slice(8), "utf8").split("\n");
const SUITE_PATH = (fill = "2"): Obj[] => PATH(fill).map((el) => (el.as && el.as !== "system" ? { ...el, as: el.as === "customer" ? "customer.2" : "sales.1" } : el));
const RUN = "20300101000000-0123abcd";
const commit = (cwd: string, msg: string) => git(cwd, "-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", "commit", "-qm", msg);
/** Every file under `dir`, relative, sorted, with its bytes. */
const tree = (dir: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const walk = (d: string, rel: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      if (e.isDirectory()) walk(join(d, e.name), `${rel}${e.name}/`);
      else out[`${rel}${e.name}`] = readFileSync(join(d, e.name), "latin1");
    }
  };
  walk(dir, "");
  return out;
};

/** A repo whose committed suite holds `paths` ({id: path}) generated as smoke propose would write it. */
const suiteRepo = (paths: Record<string, Obj[]> = { checkout: SUITE_PATH() }) => {
  const main = committed();
  mkdirSync(join(main, ".argus"), { recursive: true });
  writeFileSync(join(main, ".argus/live.json"), `${JSON.stringify(pathLive(), null, 2)}\n`);
  writeFileSync(join(main, ".argus/smoke.json"), "{}\n");
  const dir = join(main, "e2e/argus-smoke");
  mkdirSync(join(dir, "journeys"), { recursive: true });
  for (const [id, path] of Object.entries(paths)) writeFileSync(join(dir, "journeys", `${id}.json`), `${JSON.stringify({ journey: id, path, admitted: { run: RUN, head: "a".repeat(40), pathSha: "1".repeat(64), seed: 1 } }, null, 2)}\n`);
  const files = generateSuite({ paths: Object.entries(paths).map(([id, path]) => ({ id, path })), live: pathLive(), smoke: structuredClone(SMOKE_DEFAULTS), quarantine: [] });
  for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text as string);
  git(main, "add", ".");
  commit(main, "suite");
  return main;
};

describe("smoke check — hand edits, stale files and live.json drift named; nothing written (spec §19.5)", () => {
  it("passes a clean suite and writes nothing", () => {
    const main = suiteRepo();
    const before = tree(main);
    const r = smokeCheck(main);
    expect(r).toEqual({ code: 0, lines: ["smoke check: 6 generated files current"] });
    expect(tree(main)).toEqual(before);
  });

  it("names a hand-edited spec, a stale generation and a live.json drift, each once, and writes nothing", () => {
    const main = suiteRepo();
    const spec = join(main, "e2e/argus-smoke/checkout.spec.ts");
    // A body edited by hand: its header's digest no longer matches.
    writeFileSync(spec, readFileSync(spec, "utf8").replace("test.step(", "test.step.skip("));
    let r = smokeCheck(main);
    expect(r.code).toBe(1);
    expect(r.lines).toEqual(["hand-edited e2e/argus-smoke/checkout.spec.ts", "smoke check: 1 finding(s); smoke propose regenerates the suite"]);
    // A stale generation: the path changed, the spec was not regenerated (its header matches its own body).
    git(main, "checkout", "--", ".");
    const jf = join(main, "e2e/argus-smoke/journeys/checkout.json");
    const j = JSON.parse(readFileSync(jf, "utf8"));
    j.path = SUITE_PATH("3");
    writeFileSync(jf, JSON.stringify(j));
    r = smokeCheck(main);
    expect(r.lines).toEqual(["stale e2e/argus-smoke/checkout.spec.ts (its header's digest is of another generation)", "smoke check: 1 finding(s); smoke propose regenerates the suite"]);
    // live.json drift: live.json changed since the suite was generated; the old live.json regenerates what is there.
    git(main, "checkout", "--", ".");
    const live = pathLive();
    live.login_url = "/sign-in";
    writeFileSync(join(main, ".argus/live.json"), JSON.stringify(live));
    const before = tree(main);
    r = smokeCheck(main);
    expect(r.code).toBe(1);
    expect(r.lines.slice(0, -1).every((l: string) => /^drift e2e\/argus-smoke\/\S+ \(\.argus\/live\.json changed since it was generated\)$/.test(l))).toBe(true);
    expect(r.lines.length).toBeGreaterThan(1);
    expect(tree(main)).toEqual(before);
  });

  it("names a missing generated file and a spec with no path", () => {
    const main = suiteRepo();
    rmSync(join(main, "e2e/argus-smoke/support.ts"));
    writeFileSync(join(main, "e2e/argus-smoke/refund.spec.ts"), "// no path\n");
    expect(smokeCheck(main).lines).toEqual(["missing e2e/argus-smoke/support.ts", "orphan e2e/argus-smoke/refund.spec.ts (no journeys/refund.json)", "smoke check: 2 finding(s); smoke propose regenerates the suite"]);
  });

  it("without a suite there is nothing to check", () => {
    expect(smokeCheck(committed())).toEqual({ code: 0, lines: ["smoke check: no suite (e2e/argus-smoke/journeys holds no path)"] });
  });
});

describe("smoke propose — the staged changes as a pull request sapu never merges (spec §19.8)", () => {
  /**
   * A repo with a contract and a suite pushed to a local bare origin, a cycle directory `RUN` whose ledger
   * holds `cookie`, and stand-ins for gh (`gh(argv)` answers) and npm (writes a lockfile, records its call).
   */
  const proposeRepo = ({ gh = (argv: string[]) => ({ status: 0, stdout: argv[1] === "create" ? "https://github.com/owner/app/pull/41\n" : "" }), paths = {} as Record<string, Obj[]> } = {}) => {
    const main = suiteRepo(paths);
    git(main, "branch", "-M", "main");
    mkdirSync(join(main, ".claude"), { recursive: true });
    writeFileSync(join(main, ".claude/sapu.json"), JSON.stringify({ ...FIXTURE_CONTRACT, guard: { ...FIXTURE_CONTRACT.guard, envFiles: ["live.env"] } }));
    git(main, "add", ".");
    commit(main, "contract");
    writeFileSync(join(main, ".argus/live.env"), "PW=pw-1\nSALES_TOTP=GEZDGNBVGY3TQOJQ\nDB_PW=db-now\n");
    const bare = tempDir();
    git(bare, "init", "-q", "--bare");
    git(main, "remote", "add", "origin", bare);
    git(main, "push", "-q", "origin", "main");
    const cookie = COOKIE();
    appendLedger(main, RUN, [{ c: "cookie", v: cookie }]);
    const calls: { gh: string[][]; npm: Obj[] } = { gh: [], npm: [] };
    const runner = (argv: string[], opts: Obj = {}) => {
      if (argv[0] === "gh") {
        calls.gh.push(argv.slice(1));
        return { ...gh(argv.slice(1)), stderr: "" };
      }
      if (argv[0] === "npm") {
        calls.npm.push({ argv: argv.slice(1), cwd: opts.cwd });
        writeFileSync(join(opts.cwd, "package-lock.json"), '{"lockfileVersion": 3}\n');
        return { status: 0, stdout: "", stderr: "" };
      }
      return run(argv, opts);
    };
    const bareShow = (ref: string, file: string) => spawnSync("git", ["--git-dir", bare, "show", `${ref}:${file}`], { encoding: "utf8" });
    return { main, bare, cookie, calls, runner, bareShow, propose: (dryRun = false) => smokePropose(main, { dryRun }, { runner }) };
  };
  const ADMITTED = { run: RUN, head: "a".repeat(40), pathSha: "2".repeat(64), seed: 5 };
  /** smoke admit's staged entry for checkout. */
  const ADD = (path: Obj[] = SUITE_PATH(), evidence = `held fresh and dirty in run ${RUN} (seed 5)`) => ({ kind: "add", id: "checkout", run: RUN, changes: [{ kind: "add", id: "checkout", evidence, run: RUN }], body: ["### Add: checkout"], path, admitted: ADMITTED });

  it("builds the proposal from origin/<base>: the staged path, the regenerated files, changes.jsonl and the lockfile; commits signed off, pushes argus/smoke-<run>, opens the pull request", async () => {
    const p = proposeRepo();
    stage(p.main, ADD());
    const before = git(p.main, "status", "--porcelain", "--untracked-files=no");
    const r = await p.propose();
    expect(r.code).toBe(0);
    expect(r.lines).toEqual([
      `branch: argus/smoke-${RUN}`,
      "change add checkout",
      "baseline: needed checkout (smoke baseline --from-run after this PR's first CI run)",
      "proposed: https://github.com/owner/app/pull/41",
    ]);
    const branch = `argus/smoke-${RUN}`;
    const want = generateSuite({ paths: [{ id: "checkout", path: SUITE_PATH() }], live: pathLive(), smoke: structuredClone(SMOKE_DEFAULTS), quarantine: [] });
    for (const [f, text] of Object.entries(want)) expect(p.bareShow(branch, `e2e/argus-smoke/${f}`).stdout, f).toBe(text);
    expect(JSON.parse(p.bareShow(branch, "e2e/argus-smoke/journeys/checkout.json").stdout)).toEqual({ journey: "checkout", path: SUITE_PATH(), admitted: ADMITTED });
    expect(p.bareShow(branch, "e2e/argus-smoke/package-lock.json").stdout).toBe('{"lockfileVersion": 3}\n');
    const log = p.bareShow(branch, "e2e/argus-smoke/changes.jsonl").stdout.trim().split("\n").map((l: string) => JSON.parse(l));
    expect(log).toEqual(ADD().changes);
    expect(p.calls.npm).toEqual([{ argv: ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], cwd: expect.stringMatching(/e2e\/argus-smoke$/) }]);
    // One commit on main's head, by the contract's gitEmail, signed off.
    const head = spawnSync("git", ["--git-dir", p.bare, "log", "-1", "--format=%ae%n%B", branch], { encoding: "utf8" }).stdout;
    expect(head.split("\n")[0]).toBe(FIXTURE_CONTRACT.gitEmail);
    expect(head).toMatch(new RegExp(`\\nSigned-off-by: .+ <${FIXTURE_CONTRACT.gitEmail.replace(".", "\\.")}>\\n`));
    expect(git(p.main, "rev-parse", "main")).toBe(spawnSync("git", ["--git-dir", p.bare, "rev-parse", `${branch}~1`], { encoding: "utf8" }).stdout.trim());
    // The pull request: into the base, from the branch, the agent-filed label, the body naming the baseline still needed.
    const create = p.calls.gh.find((a) => a[0] === "pr" && a[1] === "create")!;
    const flag = (f: string) => create[create.indexOf(f) + 1];
    expect([flag("--repo"), flag("--base"), flag("--head"), flag("--label")]).toEqual(["owner/app", "main", branch, "sapu:agent-filed"]);
    expect(p.calls.gh.some((a) => a[0] === "pr" && a[1] === "merge")).toBe(false);
    // Staged changes leave the stage, the proposal is remembered, the owner's checkout is untouched, the worktree gone.
    expect(readState(p.main).staged).toEqual([]);
    const state = JSON.parse(readFileSync(join(p.main, ".argus/smoke-state.json"), "utf8"));
    expect(state.proposals[changeDigest(ADD())]).toEqual({ kind: "add", id: "checkout", branch, url: "https://github.com/owner/app/pull/41", outcome: "open" });
    expect(git(p.main, "status", "--porcelain", "--untracked-files=no")).toBe(before);
    expect(git(p.main, "rev-parse", "HEAD")).toBe(git(p.main, "rev-parse", "main"));
    expect(git(p.main, "worktree", "list").split("\n")).toHaveLength(1);
    // The proposal is an event of the run it is named for, and that run's report lists it.
    expect(eventsOf(p.main, RUN)).toEqual([{ kind: "proposal", url: "https://github.com/owner/app/pull/41", branch, changes: 1 }]);
    expect(reportOf(p.main, RUN)).toContain(`- \`https://github.com/owner/app/pull/41\` ${branch}, 1 change(s)`);
  }, 60_000);

  it("the body: the change list, the baselines still needed and the change log, fenced", async () => {
    let body = "";
    const p = proposeRepo({ gh: (argv) => (argv[1] === "create" ? ((body = readFileSync(argv[argv.indexOf("--body-file") + 1], "utf8")), { status: 0, stdout: "https://github.com/owner/app/pull/41\n" }) : { status: 0, stdout: "" }) });
    stage(p.main, ADD(SUITE_PATH(), "evidence with ``` and @someone"));
    await p.propose();
    expect(body).toContain("- add `checkout`\n");
    expect(body).toContain("baseline: needed checkout (smoke baseline --from-run after this PR's first CI run)");
    expect(body).toContain("sapu never merges this pull request");
    expect(body).toMatch(/\n````json\n\{"kind":"add","id":"checkout","evidence":"evidence with ``` and @someone","run":"[0-9a-f-]+"\}\n````\n/);
  }, 60_000);

  it("a baseline file that conflicts on the rebase is dropped and listed as needed, never resolved by picking a side", async () => {
    const p = proposeRepo();
    const shot = "e2e/argus-smoke/__screenshots__/chromium/linux/checkout.spec/1.png";
    const aria = "e2e/argus-smoke/__aria__/checkout.spec/1.aria.yml";
    const put = (f: string, text: string) => {
      mkdirSync(join(p.main, f, ".."), { recursive: true });
      writeFileSync(join(p.main, f), text);
    };
    put(shot, "\x89PNG v1");
    git(p.main, "add", ".");
    commit(p.main, "baseline v1");
    git(p.main, "push", "-q", "origin", "main");
    const branch = `argus/smoke-${RUN}`;
    // The proposal branch's baseline commit (a baseline run's adoption): the shot changed, an ARIA file added.
    git(p.main, "checkout", "-q", "-b", branch);
    put(shot, "\x89PNG v2");
    put(aria, "- main:\n");
    git(p.main, "add", ".");
    commit(p.main, "baselines");
    git(p.main, "push", "-q", "origin", branch);
    // The base moves on: the same shot changed differently.
    git(p.main, "checkout", "-q", "main");
    put(shot, "\x89PNG v3");
    git(p.main, "add", ".");
    commit(p.main, "baseline v3");
    git(p.main, "push", "-q", "origin", "main");
    stage(p.main, ADD());
    const r = await p.propose();
    expect(r.code).toBe(0);
    expect(r.lines).toContain("baseline: dropped e2e/argus-smoke/__screenshots__/chromium/linux/checkout.spec/1.png (it conflicts with origin/main)");
    expect(r.lines).toContain("baseline: needed checkout (smoke baseline --from-run after this PR's first CI run)");
    expect(p.bareShow(branch, shot).status).not.toBe(0);
    expect(p.bareShow(branch, aria).stdout).toBe("- main:\n");
    expect(spawnSync("git", ["--git-dir", p.bare, "merge-base", "--is-ancestor", "main", branch]).status).toBe(0);
  }, 60_000);

  it("a file or the body holding a ledger secret refuses before any push, naming file:line:col and class", async () => {
    const p = proposeRepo();
    stage(p.main, ADD(SUITE_PATH(`x-${p.cookie}`)));
    let msg = "";
    await p.propose().catch((e: Error) => (msg = e.message));
    expect(msg).toMatch(/^refused: smoke propose: \d+ secret\(s\): /);
    expect(msg).toMatch(/e2e\/argus-smoke\/journeys\/checkout\.json:\d+:\d+ cookie/);
    expect(msg).toMatch(/e2e\/argus-smoke\/checkout\.spec\.ts:\d+:\d+ cookie/);
    expect(msg).not.toContain(p.cookie.slice(0, 10));
    expect(msg).toMatch(/; nothing is pushed$/);
    const q = proposeRepo();
    stage(q.main, ADD(SUITE_PATH(), `evidence ${q.cookie}`));
    msg = "";
    await q.propose().catch((e: Error) => (msg = e.message));
    expect(msg).toMatch(/body:\d+:\d+ cookie/);
    for (const x of [p, q]) {
      expect(spawnSync("git", ["--git-dir", x.bare, "rev-parse", "--verify", `argus/smoke-${RUN}`]).status).not.toBe(0);
      expect(x.calls.gh.some((a) => a[1] === "create")).toBe(false);
      expect(readState(x.main).staged).toHaveLength(1);
      expect(git(x.main, "worktree", "list").split("\n")).toHaveLength(1);
    }
  }, 60_000);

  it("a change its pull request was closed on is never proposed again", async () => {
    const closedUrl = "https://github.com/owner/app/pull/40";
    const p = proposeRepo({ gh: (argv) => (argv[1] === "view" ? { status: 0, stdout: "CLOSED\n" } : { status: 0, stdout: argv[1] === "create" ? "https://github.com/owner/app/pull/41\n" : "" }) });
    writeFileSync(join(p.main, ".argus/smoke-state.json"), JSON.stringify({ proposals: { [changeDigest(ADD())]: { kind: "add", id: "checkout", branch: "argus/smoke-x", url: closedUrl, outcome: "open" } } }));
    // A later run finds the same path again: same digest.
    const other = "20300102000000-0123abcd";
    stage(p.main, { ...ADD(), run: other, changes: [{ kind: "add", id: "checkout", evidence: "again", run: other }] });
    const r = await p.propose();
    expect(r.lines).toEqual([`skip add checkout: rejected in ${closedUrl}`, "smoke propose: nothing to propose"]);
    expect(p.calls.gh.filter((a) => a[1] === "create")).toEqual([]);
    const state = readState(p.main);
    expect(state.proposals[changeDigest(ADD())].outcome).toBe("closed");
    expect(state.rejected).toEqual([changeDigest(ADD())]);
    expect(state.staged).toEqual([]);
    // The digest is rejected now: no verb stages that change again.
    expect(stage(p.main, ADD())).toEqual({ staged: false, digest: changeDigest(ADD()) });
  }, 60_000);

  it("applies every staged kind: a heal keeps the admission and routes, a drop removes the journey and its baselines, quarantine.json follows", async () => {
    let body = "";
    const p = proposeRepo({ paths: { checkout: SUITE_PATH(), refund: SUITE_PATH(), wishlist: SUITE_PATH() }, gh: (argv) => (argv[1] === "create" ? ((body = readFileSync(argv[argv.indexOf("--body-file") + 1], "utf8")), { status: 0, stdout: "https://github.com/owner/app/pull/41\n" }) : { status: 0, stdout: "" }) });
    const dir = join(p.main, "e2e/argus-smoke");
    const put = (f: string, text: string) => {
      mkdirSync(join(dir, f, ".."), { recursive: true });
      writeFileSync(join(dir, f), text);
    };
    const routes = [{ role: "sales", route: "/inbox" }];
    const checkout = JSON.parse(readFileSync(join(dir, "journeys/checkout.json"), "utf8"));
    put("journeys/checkout.json", JSON.stringify({ ...checkout, routes }));
    put("known/refund.json", "[]\n");
    put("__aria__/refund.spec/1.aria.yml", "- main:\n");
    put("__screenshots__/chromium/linux/refund.spec/1.png", "\x89PNG");
    put("__screenshots__/chromium/linux/checkout.spec/1.png", "\x89PNG");
    put("quarantine.json", JSON.stringify([{ id: "checkout", issue: null, since: "90" }]));
    git(p.main, "add", ".");
    commit(p.main, "baselines and quarantine");
    git(p.main, "push", "-q", "origin", "main");
    const healed = SUITE_PATH("3");
    const heal = { kind: "heal", id: "checkout", step: 3, from: { label: "Quantity" }, to: { label: "Qty" }, evidence: ["git log: no commit removed it"], run: RUN };
    stage(p.main, { kind: "heal", id: "checkout", run: RUN, changes: [heal], body: ["### Heal: checkout", "", "held twice"], path: healed, needsOwner: true });
    stage(p.main, { kind: "unquarantine", id: "checkout", run: "100", changes: [{ kind: "unquarantine", id: "checkout", evidence: ["3 clean cycles"], run: "100" }], body: ["### Leave quarantine: checkout"] });
    stage(p.main, { kind: "drop", id: "refund", run: "100", changes: [{ kind: "drop", id: "refund", evidence: ["quarantined for 5 cycles"], run: "100" }], body: ["### Drop: refund"] });
    stage(p.main, { kind: "quarantine", id: "wishlist", run: "100", changes: [{ kind: "quarantine", id: "wishlist", evidence: ["CI run 100: flaky on main (chromium)"], run: "100" }], body: ["### Quarantine: wishlist"], quarantine: { id: "wishlist", issue: null, since: "100" } });
    const r = await p.propose();
    expect(r.code).toBe(0);
    expect(r.lines.slice(0, 5)).toEqual([`branch: argus/smoke-${RUN}`, "change heal checkout step 3", "change unquarantine checkout", "change drop refund", "change quarantine wishlist"]);
    const branch = `argus/smoke-${RUN}`;
    const show = (f: string) => p.bareShow(branch, `e2e/argus-smoke/${f}`);
    expect(JSON.parse(show("journeys/checkout.json").stdout)).toEqual({ ...checkout, path: healed, routes });
    for (const gone of ["journeys/refund.json", "refund.spec.ts", "known/refund.json", "__aria__/refund.spec/1.aria.yml", "__screenshots__/chromium/linux/refund.spec/1.png"]) expect(show(gone).status, gone).not.toBe(0);
    expect(show("__screenshots__/chromium/linux/checkout.spec/1.png").status).toBe(0);
    expect(JSON.parse(show("quarantine.json").stdout)).toEqual([{ id: "wishlist", issue: null, since: "100" }]);
    expect(show("wishlist.spec.ts").stdout).toContain('"tag": "@quarantine"');
    expect(show("checkout.spec.ts").stdout).not.toContain("@quarantine");
    const log = show("changes.jsonl").stdout.trim().split("\n").map((l: string) => JSON.parse(l));
    expect(log).toEqual([heal, { kind: "unquarantine", id: "checkout", evidence: ["3 clean cycles"], run: "100" }, { kind: "drop", id: "refund", evidence: ["quarantined for 5 cycles"], run: "100" }, { kind: "quarantine", id: "wishlist", evidence: ["CI run 100: flaky on main (chromium)"], run: "100" }]);
    expect(body).toContain("## Details\n### Heal: checkout\n\nheld twice\n");
    // A heal that moved its control's name or role asks for the owner: the pull request carries the needs-owner label too.
    const create = p.calls.gh.find((a) => a[0] === "pr" && a[1] === "create")!;
    expect(create.filter((x, i) => create[i - 1] === "--label")).toEqual(["sapu:agent-filed", "argus:needs-owner"]);
    const state = readState(p.main);
    expect(state.staged).toEqual([]);
    expect(Object.values(state.proposals).map((x: Obj) => [x.kind, x.id, x.outcome])).toEqual([["heal", "checkout", "open"], ["unquarantine", "checkout", "open"], ["drop", "refund", "open"], ["quarantine", "wishlist", "open"]]);
  }, 60_000);

  it("a retire (smoke retire's) removes the journey; its run needs no ledger, as it carries no page value", async () => {
    const p = proposeRepo({ paths: { checkout: SUITE_PATH(), refund: SUITE_PATH() } });
    // The owner retired refund between cycles, naming a run a later up dropped: no ledger is left for it.
    const old = "20290101000000-0123abcd";
    stage(p.main, { kind: "retire", id: "refund", run: old, changes: [{ kind: "retire", id: "refund", evidence: ["the owner ruled the change that broke it intended"], run: old }], body: ["### Retire: refund"] });
    const r = await p.propose();
    expect(r.code).toBe(0);
    expect(r.lines.slice(0, 2)).toEqual([`branch: argus/smoke-${RUN}`, "change retire refund"]);
    const show = (f: string) => p.bareShow(`argus/smoke-${RUN}`, `e2e/argus-smoke/${f}`);
    for (const gone of ["journeys/refund.json", "refund.spec.ts"]) expect(show(gone).status, gone).not.toBe(0);
    expect(show("journeys/checkout.json").status).toBe(0);
  }, 60_000);

  it("a staged drop supersedes a heal of the same journey, staged before or after it: the proposal drops it and skips the heal", async () => {
    for (const order of [["drop", "heal"], ["heal", "drop"]]) {
      const p = proposeRepo({ paths: { checkout: SUITE_PATH(), refund: SUITE_PATH() } });
      const heal = { kind: "heal", id: "checkout", run: RUN, changes: [{ kind: "heal", id: "checkout", step: 3, from: { label: "Quantity" }, to: { label: "Qty" }, evidence: [], run: RUN }], body: [], path: SUITE_PATH("3") };
      const drop = { kind: "drop", id: "checkout", run: "100", changes: [{ kind: "drop", id: "checkout", evidence: ["quarantined for 5 cycles"], run: "100" }], body: [] };
      for (const k of order) stage(p.main, k === "drop" ? drop : heal);
      const r = await p.propose();
      expect(r.code, order.join(",")).toBe(0);
      expect(r.lines, order.join(",")).toContain("change drop checkout");
      expect(r.lines.some((l: string) => l.startsWith("change heal")), order.join(",")).toBe(false);
      expect(p.bareShow(`argus/smoke-${RUN}`, "e2e/argus-smoke/journeys/checkout.json").status).not.toBe(0);
      expect(readState(p.main).staged).toEqual([]);
    }
  }, 120_000);

  it("a heal of a journey the base does not hold refuses, nothing pushed", async () => {
    const p = proposeRepo();
    stage(p.main, { kind: "heal", id: "checkout", run: RUN, changes: [{ kind: "heal", id: "checkout", step: 3, from: {}, to: {}, evidence: [], run: RUN }], body: [], path: SUITE_PATH() });
    await expect(p.propose()).rejects.toThrow("refused: smoke propose: the staged heal of checkout names a journey origin/main's suite does not hold");
    expect(readState(p.main).staged).toHaveLength(1);
  }, 60_000);

  it("--dry-run prints the change list and writes nothing", async () => {
    const p = proposeRepo();
    stage(p.main, ADD());
    const before = tree(p.main);
    const r = await p.propose(true);
    expect(r).toEqual({ code: 0, lines: [`would propose on argus/smoke-${RUN}: 1 change(s)`, "change add checkout"] });
    expect(tree(p.main)).toEqual(before);
    expect(p.calls.npm).toEqual([]);
    expect(p.calls.gh.filter((a) => a[1] === "create")).toEqual([]);
    expect(spawnSync("git", ["--git-dir", p.bare, "rev-parse", "--verify", `argus/smoke-${RUN}`]).status).not.toBe(0);
  }, 60_000);
});

describe("smoke workflow — the CI job /sapu:init writes with consent (spec §19.10)", () => {
  const SHAS: Record<string, string> = { "actions/checkout": "1".repeat(40), "actions/setup-node": "2".repeat(40), "actions/upload-artifact": "3".repeat(40) };
  const WEB = { web_server: [{ command: "npm run start:ci", url: "http://localhost:3100/" }] };
  const DIGEST = `sha256:${"d".repeat(64)}`;
  /**
   * A repo with the contract, live.json (two viewports, a locale), `smoke` (with a ci.web_server unless `noWeb`) and a
   * suite path unless `noPath`; gh resolves each action's tag to its SHA unless `unresolved`; the registry answers the
   * image's digest unless `noDigest`.
   */
  const flow = ({ smoke = {} as Obj, live = {} as Obj, unresolved = "", noWeb = false, noPath = false, noDigest = false } = {}) => {
    const main = committed();
    mkdirSync(join(main, ".argus"), { recursive: true });
    mkdirSync(join(main, ".claude"), { recursive: true });
    writeFileSync(join(main, ".claude/sapu.json"), JSON.stringify(FIXTURE_CONTRACT));
    git(main, "add", ".");
    commit(main, "contract");
    writeFileSync(join(main, ".argus/live.json"), JSON.stringify({ ...pathLive(), locales: ["de-DE"], ...live }));
    writeFileSync(join(main, ".argus/smoke.json"), JSON.stringify(noWeb ? smoke : { ...smoke, ci: { ...WEB, ...smoke.ci } }));
    if (!noPath) {
      mkdirSync(join(main, "e2e/argus-smoke/journeys"), { recursive: true });
      writeFileSync(join(main, "e2e/argus-smoke/journeys/checkout.json"), JSON.stringify({ journey: "checkout", path: SUITE_PATH(), admitted: null }));
    }
    const calls: string[][] = [];
    const runner = (argv: string[], opts: Obj = {}) => {
      if (argv[0] === "curl") {
        calls.push(argv);
        return noDigest ? { status: 6, stdout: "", stderr: "curl: (6) Could not resolve host" } : { status: 0, stdout: `HTTP/2 200\r\ncontent-type: application/vnd.oci.image.index.v1+json\r\ndocker-content-digest: ${DIGEST}\r\n\r\n`, stderr: "" };
      }
      if (argv[0] !== "gh") return run(argv, opts);
      calls.push(argv.slice(1));
      const m = /^repos\/([^/]+\/[^/]+)\/commits\/(.+)$/.exec(argv[2] ?? "");
      if (!m || m[1] === unresolved) return { status: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" };
      return { status: 0, stdout: `${SHAS[m[1]]}\n`, stderr: "" };
    };
    return { main, calls, out: () => smokeWorkflow(main, { runner }) };
  };
  /** The lines of job `name` (from `  <name>:` to the next job). */
  const job = (lines: string[], name: string) => {
    const i = lines.indexOf(`  ${name}:`);
    expect(i, name).toBeGreaterThan(-1);
    const end = lines.findIndex((l, k) => k > i && /^ {2}[a-z]/.test(l));
    return lines.slice(i, end < 0 ? undefined : end);
  };

  it("triggers on pull requests, pushes to the base branch and a dispatch with the baseline and grep inputs", () => {
    const { lines, code, masked } = flow().out();
    expect(code).toBe(0);
    expect(masked).toBe(true);
    const text = lines.join("\n");
    expect(text).toContain("\non:\n  pull_request:\n  push:\n    branches: [main]\n  workflow_dispatch:\n    inputs:\n      baseline:\n");
    expect(text).toMatch(/\n {6}baseline:\n(?: {8}.*\n)* {8}options: \[missing, changed\]\n/);
    expect(text).toMatch(/\n {6}grep:\n(?: {8}.*\n)* {8}type: string\n/);
    expect(text).toContain("\npermissions:\n  contents: read\n");
    expect(text).not.toContain("pull_request_target");
    expect(lines.every((l) => !l.includes("\t") && !/\s$/.test(l))).toBe(true);
  });

  it("pins every action to a full commit SHA gh resolves, its tag in a comment; an unresolvable tag prints nothing", () => {
    const f = flow();
    const { lines } = f.out();
    const uses = lines.filter((l) => /\buses:/.test(l));
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u).toMatch(/^ +- uses: (actions\/[a-z-]+)@([0-9a-f]{40}) # v\d+$/);
    for (const u of uses) expect(u).toContain(SHAS[/uses: ([^@]+)@/.exec(u)![1]]);
    expect(f.calls.filter((c) => c[0] !== "curl").every((c) => c[0] === "api" && /^repos\/actions\/[a-z-]+\/commits\/v\d+$/.test(c[1]))).toBe(true);
    expect(() => flow({ unresolved: "actions/setup-node" }).out()).toThrow(/^refused: smoke workflow: actions\/setup-node@v\d+ could not be resolved to a commit \(gh exited 1\)$/);
  });

  it("skips a fork's pull request, checks out without persisted credentials, and runs the suite's npm ci and the shuffled, gating run in the pinned container", () => {
    const { lines } = flow().out();
    const test = job(lines, "test");
    expect(test).toContain("    if: github.event_name != 'workflow_dispatch' && (github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository)");
    expect(test).toContain(`      image: mcr.microsoft.com/playwright:v${SMOKE_PLAYWRIGHT}-noble@${DIGEST}`);
    expect(test).toContain("      options: --ipc=host --init");
    expect(test).toContain("        project: [chromium, firefox, webkit, chromium-390, a11y, i18n]");
    expect(test).toContain("        working-directory: e2e/argus-smoke");
    expect(test).toContain("      - run: npm ci --ignore-scripts");
    expect(test).toContain('      - run: npx playwright test --shuffle --grep-invert @quarantine --project setup --project "$PROJECT"');
    expect(test).toContain("      PROJECT: ${{ matrix.project }}");
    for (const name of ["test", "msedge", "quarantine", "baseline"]) {
      const j = job(lines, name);
      const k = j.findIndex((l) => l.includes("uses: actions/checkout@"));
      expect(j.slice(k + 1, k + 3), name).toEqual(["        with:", "          persist-credentials: false"]);
    }
  });

  it("refuses before the suite exists: no ci.web_server to start the app, or no path to run", () => {
    expect(() => flow({ noWeb: true }).out()).toThrow("refused: smoke workflow: smoke.json names no ci.web_server, so CI could not start the app");
    expect(() => flow({ noPath: true }).out()).toThrow("refused: smoke workflow: the suite has no paths (e2e/argus-smoke/journeys): write the workflow once the first suite proposal merged");
  });

  it("every step after the checkout runs only once the suite exists, so the workflow stays green before the first suite merges", () => {
    const { lines } = flow().out();
    for (const name of ["test", "msedge", "quarantine", "baseline"]) {
      const j = job(lines, name);
      const steps = j.slice(j.indexOf("    steps:") + 1).join("\n").split(/\n(?= {6}- )/);
      expect(steps[0], name).toMatch(/^ {6}- uses: actions\/checkout@/);
      for (const s of steps.slice(1)) expect(s, `${name}: ${s.split("\n")[0]}`).toMatch(/\n {8}if: (\$\{\{ !cancelled\(\) && hashFiles\('e2e\/argus-smoke\/package\.json'\) != '' \}\}|hashFiles\('e2e\/argus-smoke\/package\.json'\) != '')(\n|$)/);
    }
  });

  it("the secrets reach only the step that runs the suite, never npm ci; npm ci runs no install scripts", () => {
    const { lines } = flow().out();
    const text = lines.join("\n");
    expect(text).not.toMatch(/- run: npm ci$/m);
    expect(text.match(/npm ci --ignore-scripts/g)).toHaveLength(4);
    for (const name of ["test", "msedge", "quarantine", "baseline"]) {
      const j = job(lines, name);
      const steps = j.slice(j.indexOf("    steps:") + 1).join("\n").split(/\n(?= {6}- )/);
      // No job-level env holds a secret.
      expect(j.slice(0, j.indexOf("    steps:")).join("\n"), name).not.toContain("secrets.");
      for (const s of steps) {
        if (!s.includes("secrets.")) continue;
        expect(s, name).toMatch(/npx playwright test /);
        expect(s, name).not.toContain("npm ci");
      }
      expect(steps.filter((s) => s.includes("secrets.")), name).toHaveLength(1);
    }
  });

  it("pins the Playwright image by the digest the registry answers for its tag; unresolved, the tag stays and the file says why", () => {
    const f = flow();
    const { lines } = f.out();
    expect(f.calls.find((c) => c[0] === "curl")).toEqual(["curl", "-sSfI", "--max-time", "30", "--proto", "=https", "-H", "Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json", `https://mcr.microsoft.com/v2/playwright/manifests/v${SMOKE_PLAYWRIGHT}-noble`]);
    expect(lines.filter((l) => l.includes("image: "))).toEqual(Array(3).fill(`      image: mcr.microsoft.com/playwright:v${SMOKE_PLAYWRIGHT}-noble@${DIGEST}`));
    const tag = flow({ noDigest: true }).out().lines;
    expect(tag.filter((l) => l.includes("image: "))).toEqual(Array(3).fill(`      image: mcr.microsoft.com/playwright:v${SMOKE_PLAYWRIGHT}-noble`));
    expect(tag).toContain(`# The Playwright image is pinned by its tag only: its digest could not be resolved when this file was printed (curl exited 6). Pin it by digest when you can.`);
  });

  it("runs msedge on the plain runner with no container, and only when smoke.json lists it", () => {
    const { lines } = flow().out();
    const edge = job(lines, "msedge");
    expect(edge.join("\n")).not.toContain("container:");
    expect(edge).toContain("    runs-on: ubuntu-24.04");
    expect(edge).toContain("      - run: npx playwright test --shuffle --grep-invert @quarantine --project setup --project msedge");
    expect(flow({ smoke: { browsers: ["chromium", "webkit"] } }).out().lines.join("\n")).not.toContain("msedge");
    expect(job(flow({ smoke: { browsers: ["chromium", "webkit"] }, live: { locales: [], viewports: [1440] } }).out().lines, "test")).toContain("        project: [chromium, webkit, a11y]");
  });

  it("the matrix and the generated config's projects are one list, codegen's suiteProjects: msedge alone leaves the container", () => {
    for (const [smoke, live] of [[{}, {}], [{ browsers: ["firefox", "msedge"] }, { viewports: [1280, 390] }], [{ browsers: ["webkit", "chromium"] }, { locales: [], pseudo_locales: ["en-XA"] }]] as [Obj, Obj][]) {
      const f = flow({ smoke, live });
      const { lines } = f.out();
      const writtenLive = JSON.parse(readFileSync(join(f.main, ".argus/live.json"), "utf8"));
      const full = validateSmoke(smoke).value;
      const names = suiteProjects({ live: writtenLive, smoke: full }).map((p: Obj) => p.name);
      const matrix = (j: string) => /^ {8}project: \[(.*)\]$/.exec(job(lines, j).find((l) => l.startsWith("        project: ["))!)![1].split(", ");
      expect(matrix("test"), JSON.stringify(smoke)).toEqual(names.filter((n: string) => n !== "msedge"));
      expect(matrix("baseline")).toEqual(matrix("test"));
      expect(lines.includes("  msedge:")).toBe(names.includes("msedge"));
      // The config names the same projects (after setup), so --project "$PROJECT" always finds one.
      const config = smokeConfig({ live: writtenLive, smoke: full });
      for (const n of names) expect(config, n).toContain(`{ name: ${JSON.stringify(n)}, `);
      // The quarantine job runs every container project: a flake is judged on its own project's results.
      expect(matrix("quarantine")).toEqual(matrix("test"));
    }
  });

  it("keeps quarantined tests running in a non-gating job", () => {
    const q = job(flow().out().lines, "quarantine");
    expect(q).toContain("    continue-on-error: true");
    expect(q).toContain('      - run: npx playwright test --grep @quarantine --pass-with-no-tests --project setup --project "$PROJECT"');
    expect(q.join("\n")).toContain("          name: argus-smoke-results-quarantine-${{ matrix.project }}");
  });

  it("the baseline job runs only on dispatch, its inputs reaching the shell through env and checked before use", () => {
    const b = job(flow().out().lines, "baseline");
    const text = b.join("\n");
    expect(b).toContain("    if: github.event_name == 'workflow_dispatch'");
    expect(text).toContain("          MODE: ${{ inputs.baseline }}");
    expect(text).toContain("          GREP: ${{ inputs.grep }}");
    // The inputs appear in ${{ }} only as env values, never inside a run script.
    for (const l of b.filter((x) => x.includes("inputs."))) expect(l).toMatch(/^ +(MODE|GREP): \$\{\{ inputs\.(baseline|grep) \}\}$/);
    const check = b.findIndex((l) => l.includes('case "$MODE" in missing|changed)'));
    const use = b.findIndex((l) => l.includes('--update-snapshots="$MODE" --grep'));
    expect(check).toBeGreaterThan(-1);
    expect(use).toBeGreaterThan(check);
    // Playwright matches --grep against " <project> <file> <title> <tags>": the ids are anchored to a whole title word.
    expect(b[use].trim()).toBe('npx playwright test --update-snapshots="$MODE" --grep "(^| )($GREP)( |\\$)" --project setup --project "$PROJECT"');
    // The shell check: run it on good and bad inputs.
    const script = b.slice(b.findIndex((l) => l.includes("run: |")) + 1, use).map((l) => l.trim()).join("\n");
    const sh = (MODE: string, GREP: string) => spawnSync("sh", ["-c", script], { env: { PATH: process.env.PATH, MODE, GREP } }).status;
    expect(sh("missing", "checkout|refund-v2")).toBe(0);
    expect(sh("changed", "checkout")).toBe(0);
    expect(sh("missing", "a1|b-2|c")).toBe(0);
    for (const [m, g] of [["all", "checkout"], ["missing", ""], ["missing", "a;rm -rf /"], ["missing", "a\nb"], ["missing", "A"], ["missing", "$(id)"], ["missing", "a||b"], ["missing", "|a"], ["missing", "a|"], ["missing", "|"], ["missing", "-a"], ["missing", "a|-b"], ["missing", "a b"]]) expect(sh(m, g), `${m} ${JSON.stringify(g)}`).not.toBe(0);
    // The anchored pattern, as the shell hands it to Playwright, matches a title word and nothing around it.
    const grep = spawnSync("sh", ["-c", 'printf %s "(^| )($GREP)( |\\$)"'], { env: { PATH: process.env.PATH, GREP: "cart|web" }, encoding: "utf8" }).stdout;
    const re = new RegExp(grep);
    expect(re.test(" chromium cart.spec.ts cart")).toBe(true);
    for (const miss of [" chromium add-to-cart.spec.ts add-to-cart", " webkit checkout.spec.ts checkout", " chromium cart-v2.spec.ts cart-v2"]) expect(re.test(miss), miss).toBe(false);
  });

  it("uploads the results and the written baselines for seven days, never the signed-in states", () => {
    const { lines } = flow().out();
    const text = lines.join("\n");
    expect(text).not.toContain(".auth");
    const uploads = lines.flatMap((l, i) => (l.includes("uses: actions/upload-artifact@") ? [lines.slice(i, i + 8).join("\n")] : []));
    expect(uploads.length).toBe(5);
    for (const u of uploads) expect(u).toContain("          retention-days: 7");
    expect(text).toContain("          name: argus-smoke-results-${{ matrix.project }}\n          path: e2e/argus-smoke/test-results/");
    expect(job(lines, "baseline").join("\n")).toContain("          name: argus-smoke-baselines-${{ matrix.project }}\n          path: |\n            e2e/argus-smoke/__screenshots__/\n            e2e/argus-smoke/__aria__/");
  });

  it("passes exactly the ${NAME} names live.json uses, each from the repo's secrets, and no value", () => {
    const f = flow();
    const text = f.out().lines.join("\n");
    const names = [...text.matchAll(/^ +([A-Z][A-Z0-9_]*): \$\{\{ secrets\.([A-Z0-9_]+) \}\}$/gm)].map((m) => [m[1], m[2]]);
    expect(new Set(names.map(([a]) => a))).toEqual(new Set(["DB_PW", "PW", "SALES_TOTP"]));
    for (const [a, b] of names) expect(a).toBe(b);
    expect(text).not.toMatch(/pw-1|db-now|GEZDGNBVGY3TQOJQ/);
  });
});
