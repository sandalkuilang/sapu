// tests/argus-live-suite.test.ts — the smoke suite's lifecycle (spec §19.3, §19.4, §19.8, §19.10): `smoke plan`
// ranks the catalog into the suite's members, `smoke admit` stages a path that held fresh and dirty, `smoke
// propose` opens the staged changes as a pull request, `smoke check` names hand edits, and `smoke workflow`
// prints the CI job. gh and npm are stand-ins; git is real, against a local bare origin.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FIXTURE_CONTRACT } from "./fixture-contract";
import { ARGUS_LIVE, cleanTemps, committed, git, tempDir } from "./helpers/argus-live";
// @ts-expect-error — plain ESM script without types
import { SMOKE_PLAYWRIGHT } from "../plugins/sapu/scripts/argus-live-codegen.mjs";
// @ts-expect-error — plain ESM script without types
import { run } from "../plugins/sapu/scripts/argus-live-proc.mjs";
// @ts-expect-error — plain ESM script without types
import { smokePlan } from "../plugins/sapu/scripts/argus-live-suite.mjs";

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
