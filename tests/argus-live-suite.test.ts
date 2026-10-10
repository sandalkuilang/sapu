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
import { generateSuite, SMOKE_PLAYWRIGHT } from "../plugins/sapu/scripts/argus-live-codegen.mjs";
// @ts-expect-error — plain ESM script without types
import { SMOKE_DEFAULTS } from "../plugins/sapu/scripts/argus-live-config.mjs";
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
import { changeDigest, readStaged, smokeAdmit, smokeCheck, smokePlan, stageChange } from "../plugins/sapu/scripts/argus-live-suite.mjs";
// @ts-expect-error — plain ESM script without types
import { smokePropose } from "../plugins/sapu/scripts/argus-live-propose.mjs";

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

/** The path above as the suite numbers its accounts (what admit stages). */
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
  const proposeRepo = ({ gh = (argv: string[]) => ({ status: 0, stdout: argv[1] === "create" ? "https://github.com/owner/app/pull/41\n" : "" }) } = {}) => {
    const main = suiteRepo({});
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
  const ADD = (path: Obj[] = SUITE_PATH(), evidence = `held fresh and dirty in run ${RUN} (seed 5)`) => ({ kind: "add", id: "checkout", evidence, run: RUN, journey: { journey: "checkout", path, admitted: { run: RUN, head: "a".repeat(40), pathSha: "2".repeat(64), seed: 5 } } });

  it("builds the proposal from origin/<base>: the staged path, the regenerated files, changes.jsonl and the lockfile; commits signed off, pushes argus/smoke-<run>, opens the pull request", async () => {
    const p = proposeRepo();
    stageChange(p.main, ADD());
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
    expect(JSON.parse(p.bareShow(branch, "e2e/argus-smoke/journeys/checkout.json").stdout)).toEqual(ADD().journey);
    expect(p.bareShow(branch, "e2e/argus-smoke/package-lock.json").stdout).toBe('{"lockfileVersion": 3}\n');
    const log = p.bareShow(branch, "e2e/argus-smoke/changes.jsonl").stdout.trim().split("\n").map((l: string) => JSON.parse(l));
    expect(log).toEqual([{ kind: "add", id: "checkout", evidence: ADD().evidence, run: RUN }]);
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
    expect(readStaged(p.main)).toEqual([]);
    const state = JSON.parse(readFileSync(join(p.main, ".argus/smoke-state.json"), "utf8"));
    expect(state.proposals[changeDigest(ADD())]).toEqual({ kind: "add", id: "checkout", branch, url: "https://github.com/owner/app/pull/41", outcome: "open" });
    expect(git(p.main, "status", "--porcelain", "--untracked-files=no")).toBe(before);
    expect(git(p.main, "rev-parse", "HEAD")).toBe(git(p.main, "rev-parse", "main"));
    expect(git(p.main, "worktree", "list").split("\n")).toHaveLength(1);
  }, 60_000);

  it("the body: the change list, the baselines still needed and the change log, fenced", async () => {
    let body = "";
    const p = proposeRepo({ gh: (argv) => (argv[1] === "create" ? ((body = readFileSync(argv[argv.indexOf("--body-file") + 1], "utf8")), { status: 0, stdout: "https://github.com/owner/app/pull/41\n" }) : { status: 0, stdout: "" }) });
    stageChange(p.main, ADD(SUITE_PATH(), "evidence with ``` and @someone"));
    await p.propose();
    expect(body).toContain("- add `checkout`\n");
    expect(body).toContain("baseline: needed checkout (smoke baseline --from-run after this PR's first CI run)");
    expect(body).toContain("sapu never merges this pull request");
    expect(body).toMatch(/\n````json\n\{"kind":"add","id":"checkout","evidence":"evidence with ``` and @someone","run":"[0-9a-f-]+"\}\n````\n/);
  }, 60_000);

  it("a baseline file that conflicts on the rebase is dropped and listed as needed, never resolved by picking a side", async () => {
    const p = proposeRepo();
    const shot = "e2e/argus-smoke/__screenshots__/chromium/linux/checkout/1.png";
    const aria = "e2e/argus-smoke/__aria__/checkout/1.aria.yml";
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
    stageChange(p.main, ADD());
    const r = await p.propose();
    expect(r.code).toBe(0);
    expect(r.lines).toContain("baseline: dropped e2e/argus-smoke/__screenshots__/chromium/linux/checkout/1.png (it conflicts with origin/main)");
    expect(r.lines).toContain("baseline: needed checkout (smoke baseline --from-run after this PR's first CI run)");
    expect(p.bareShow(branch, shot).status).not.toBe(0);
    expect(p.bareShow(branch, aria).stdout).toBe("- main:\n");
    expect(spawnSync("git", ["--git-dir", p.bare, "merge-base", "--is-ancestor", "main", branch]).status).toBe(0);
  }, 60_000);

  it("a file or the body holding a ledger secret refuses before any push, naming file:line:col and class", async () => {
    const p = proposeRepo();
    stageChange(p.main, ADD(SUITE_PATH(`x-${p.cookie}`)));
    let msg = "";
    await p.propose().catch((e: Error) => (msg = e.message));
    expect(msg).toMatch(/^refused: smoke propose: \d+ secret\(s\): /);
    expect(msg).toMatch(/e2e\/argus-smoke\/journeys\/checkout\.json:\d+:\d+ cookie/);
    expect(msg).toMatch(/e2e\/argus-smoke\/checkout\.spec\.ts:\d+:\d+ cookie/);
    expect(msg).not.toContain(p.cookie.slice(0, 10));
    expect(msg).toMatch(/; nothing is pushed$/);
    const q = proposeRepo();
    stageChange(q.main, ADD(SUITE_PATH(), `evidence ${q.cookie}`));
    msg = "";
    await q.propose().catch((e: Error) => (msg = e.message));
    expect(msg).toMatch(/body:\d+:\d+ cookie/);
    for (const x of [p, q]) {
      expect(spawnSync("git", ["--git-dir", x.bare, "rev-parse", "--verify", `argus/smoke-${RUN}`]).status).not.toBe(0);
      expect(x.calls.gh.some((a) => a[1] === "create")).toBe(false);
      expect(readStaged(x.main)).toHaveLength(1);
      expect(git(x.main, "worktree", "list").split("\n")).toHaveLength(1);
    }
  }, 60_000);

  it("a change its pull request was closed on is never proposed again", async () => {
    const closedUrl = "https://github.com/owner/app/pull/40";
    const p = proposeRepo({ gh: (argv) => (argv[1] === "view" ? { status: 0, stdout: "CLOSED\n" } : { status: 0, stdout: argv[1] === "create" ? "https://github.com/owner/app/pull/41\n" : "" }) });
    writeFileSync(join(p.main, ".argus/smoke-state.json"), JSON.stringify({ proposals: { [changeDigest(ADD())]: { kind: "add", id: "checkout", branch: "argus/smoke-x", url: closedUrl, outcome: "open" } } }));
    // A later run finds the same path again: same digest.
    stageChange(p.main, { ...ADD(), run: "20300102000000-0123abcd", evidence: "again" });
    const r = await p.propose();
    expect(r.lines).toEqual([`skip add checkout: rejected in ${closedUrl}`, "smoke propose: nothing to propose"]);
    expect(p.calls.gh.filter((a) => a[1] === "create")).toEqual([]);
    expect(JSON.parse(readFileSync(join(p.main, ".argus/smoke-state.json"), "utf8")).proposals[changeDigest(ADD())].outcome).toBe("closed");
    expect(readStaged(p.main)).toEqual([]);
  }, 60_000);

  it("--dry-run prints the change list and writes nothing", async () => {
    const p = proposeRepo();
    stageChange(p.main, ADD());
    const before = tree(p.main);
    const r = await p.propose(true);
    expect(r).toEqual({ code: 0, lines: [`would propose on argus/smoke-${RUN}: 1 change(s)`, "change add checkout"] });
    expect(tree(p.main)).toEqual(before);
    expect(p.calls.npm).toEqual([]);
    expect(p.calls.gh.filter((a) => a[1] === "create")).toEqual([]);
    expect(spawnSync("git", ["--git-dir", p.bare, "rev-parse", "--verify", `argus/smoke-${RUN}`]).status).not.toBe(0);
  }, 60_000);
});
