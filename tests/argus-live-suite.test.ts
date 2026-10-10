// tests/argus-live-suite.test.ts — the smoke suite's lifecycle (spec §19.3, §19.4, §19.8, §19.10): `smoke plan`
// ranks the catalog into the suite's members, `smoke admit` stages a path that held fresh and dirty, `smoke
// propose` opens the staged changes as a pull request, `smoke check` names hand edits, and `smoke workflow`
// prints the CI job. gh and npm are stand-ins; git is real, against a local bare origin.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FIXTURE_CONTRACT } from "./fixture-contract";
import { ARGUS_LIVE, cleanTemps, committed, example, git, liveRun, tempDir } from "./helpers/argus-live";
// @ts-expect-error — plain ESM script without types
import { SMOKE_PLAYWRIGHT } from "../plugins/sapu/scripts/argus-live-codegen.mjs";
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
import { readStaged, smokeAdmit, smokePlan } from "../plugins/sapu/scripts/argus-live-suite.mjs";

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
  const admitRun = async (path: Obj[] = PATH(), { cookie = COOKIE(), members = [] as string[] } = {}) => {
    const t = liveRun();
    writeFileSync(join(t.main, ".argus/live.json"), `${JSON.stringify(pathLive(), null, 2)}\n`);
    writeFileSync(join(t.main, ".argus/live.env"), "PW=pw-1\nSALES_TOTP=GEZDGNBVGY3TQOJQ\nDB_PW=db-now\n");
    writeFileSync(join(t.main, ".argus/journeys.json"), JSON.stringify({ journeys: [journey("checkout", { money: true, roles: ["customer", "sales"] }), journey("refund")] }));
    const ports = { api: 41001, web: 41002, pg: 41003, redis: 41004, smtp: 41005 };
    writeRunFiles(t.main, { runId: t.runId, worktree: t.wt, worktreeHead: "a".repeat(40), home: t.home, origins: ["http://localhost:41002"], allowOrigins: [], groups: [], env: t.env, ports, instanceId: "0123456789abcdef", slots: {}, internal: { proxy: 41009 }, browser: { channel: "chrome" } });
    runs.push({ main: t.main, runId: t.runId });
    for (const id of members) {
      mkdirSync(join(t.main, "e2e/argus-smoke/journeys"), { recursive: true });
      writeFileSync(join(t.main, "e2e/argus-smoke/journeys", `${id}.json`), JSON.stringify({ journey: id, path: [], admitted: null }));
    }
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

  it("runs the return's path twice, fresh then dirty (up --fresh once), renumbered to the suite's accounts, and stages it", async () => {
    const t = await admitRun();
    const s = stub();
    const r = await admit(t.main, "1.1", s.once);
    expect(r.code).toBe(0);
    expect(r.lines).toEqual(["seed: 5", "admit checkout: held fresh and dirty; staged for smoke propose"]);
    expect(s.calls.map((c) => c.dirty)).toEqual([false, true]);
    expect(s.calls.filter((c) => c.dirty === false)).toHaveLength(1);
    // The slot's customer.1 is buyer2, the suite's customer.2; sales1 is the suite's sales.1.
    const want = PATH().map((el) => (el.as && el.as !== "system" ? { ...el, as: el.as === "customer" ? "customer.2" : "sales.1" } : el));
    for (const c of s.calls) expect(c.path).toEqual({ id: "checkout", list: want });
    const staged = readStaged(t.main);
    expect(staged).toHaveLength(1);
    expect(staged[0]).toMatchObject({ kind: "add", id: "checkout", run: t.runId });
    expect(staged[0].journey).toEqual({ journey: "checkout", path: want, admitted: { run: t.runId, head: "a".repeat(40), pathSha: expect.stringMatching(/^[0-9a-f]{64}$/), seed: 5 } });
    expect(statSync(join(t.main, ".argus/smoke-staged.json")).mode & 0o777).toBe(0o600);
    // Without a seed one is drawn, printed and recorded.
    const u = await admit(t.main, "1.1", stub().once, null);
    const seed = Number(/^seed: (\d+)$/.exec(u.lines[0])![1]);
    expect(readStaged(t.main)[0].journey.admitted.seed).toBe(seed);
    expect(readStaged(t.main)).toHaveLength(1);
  }, 30_000);

  it("a break in either run refuses with the run, the kind and the step, and stages nothing", async () => {
    const t = await admitRun();
    await expect(admit(t.main, "1.1", stub([3]).once)).rejects.toThrow("refused: admit checkout: fresh expect-failed at step 7");
    const dirty = stub([0, 3], { step: 4, kind: "target-missing" });
    await expect(admit(t.main, "1.1", dirty.once)).rejects.toThrow("refused: admit checkout: dirty target-missing at step 4");
    expect(dirty.calls.map((c) => c.dirty)).toEqual([false, true]);
    const harness = await admit(t.main, "1.1", stub([2]).once);
    expect(harness.code).toBe(2);
    expect(harness.lines.at(-1)).toBe("admit checkout: harness (fresh): step 2 system trigger exited 1");
    expect(readStaged(t.main)).toEqual([]);
    expect(existsSync(join(t.main, ".argus/smoke-staged.json"))).toBe(false);
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
