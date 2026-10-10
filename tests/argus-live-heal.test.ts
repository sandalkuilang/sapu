// tests/argus-live-heal.test.ts — `smoke heal` and spec §19.9's decision table (lane B, task B1): a heal-mode
// explorer's return changes only action targets, the healed path is re-run with every expectation unchanged,
// and only that re-run decides: UI changed (a staged heal), behaviour changed or a bug (a regression
// candidate), or nothing.
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanTemps, example, git, liveRun } from "./helpers/argus-live";
// @ts-expect-error — plain ESM script without types
import { healOnly, healPath, readState, smokeHeal, stage } from "../plugins/sapu/scripts/argus-live-heal.mjs";
// @ts-expect-error — plain ESM script without types
import { reproRef } from "../plugins/sapu/scripts/argus-live-repro.mjs";
// @ts-expect-error — plain ESM script without types
import { down, readRun, writeRunFiles } from "../plugins/sapu/scripts/argus-live-run.mjs";
// @ts-expect-error — plain ESM script without types
import { smokeRun } from "../plugins/sapu/scripts/argus-live-smoke.mjs";
// @ts-expect-error — plain ESM script without types
import { parseRepro } from "../plugins/sapu/scripts/argus-live-steps.mjs";
// @ts-expect-error — plain ESM script without types
import { generateSuite } from "../plugins/sapu/scripts/argus-live-codegen.mjs";
// @ts-expect-error — plain ESM script without types
import { SMOKE_DEFAULTS } from "../plugins/sapu/scripts/argus-live-config.mjs";

type Obj = Record<string, any>;

/** example()'s config with test ids and a seed trigger: what a smoke path may use. */
const pathLive = (): Obj => ({
  ...example(),
  test_id_attribute: "data-testid",
  triggers: { ...example().triggers, "seed-stock": { argv: ["npm", "run", "-s", "explore:seed", "--", "{1}"], args: ["^[A-Za-z0-9-]{1,64}$"], seed: true } },
});
/** A path (spec §19.4): steps 1–2 seed, 3 goto, 4 fill, 5 click, 6 read, 7 expect, 8 goto, 9 expect. */
const PATH = (): Obj[] => [
  { context: { viewport: 1440 } },
  { as: "system", do: "trigger", name: "seed-stock", values: ["{{marker}}"] },
  { as: "system", expect: "fact-equals", marker: "{{marker}}", field: "stock", value: "5" },
  { as: "customer", do: "goto", path: "/orders/new" },
  { as: "customer", do: "fill", target: { label: "Quantity" }, value: "2" },
  { as: "customer", do: "click", target: { role: "button", name: "Place order" } },
  { as: "customer", do: "read", target: { testId: "order-number" }, save: "order" },
  { as: "customer", expect: "visible", target: { text: "{{order}}" } },
  { as: "sales", do: "goto", path: "/" },
  { as: "sales", expect: "visible", target: { text: "{{order}}" } },
];
const NEW = { role: "button", name: "Submit order" };
/** PATH with step 5's target replaced by NEW: the only change a heal may make. */
const HEALED = () => PATH().map((x, i) => (i === 5 ? { ...x, target: NEW } : x));

const runs: { main: string; runId: string }[] = [];
afterEach(async () => {
  for (const r of runs.splice(0)) await down(r.main, { runId: r.runId, graceMs: 1000 }).catch(() => {});
  cleanTemps();
});

const commit = (main: string, msg: string) => git(main, "-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", "commit", "-qam", msg);

/**
 * A live cycle whose suite holds `checkout` (PATH, admitted at the repo's first commit), with smoke run's pass
 * recording a confirmed break `broke` of it, and slot 3 holding heal-mode return `ret` (generation 1).
 */
const healRun = ({ ret = null as Obj | null, broke = { verdict: "broke", step: 5, kind: "target-missing" } as Obj | null, smoke = null as Obj | null } = {}) => {
  const t = liveRun();
  writeFileSync(join(t.main, "app.txt"), "<button>Place order</button>\n");
  commit(t.main, "the order button");
  const head = git(t.main, "rev-parse", "HEAD");
  writeFileSync(join(t.main, ".argus/live.json"), `${JSON.stringify(pathLive(), null, 2)}\n`);
  writeFileSync(join(t.main, ".argus/live.env"), "PW=pw-1\nSALES_TOTP=GEZDGNBVGY3TQOJQ\nDB_PW=db-now\n");
  if (smoke) writeFileSync(join(t.main, ".argus/smoke.json"), JSON.stringify(smoke));
  const ports = { api: 41001, web: 41002, pg: 41003, redis: 41004, smtp: 41005 };
  const slots = { "3": { journey: "checkout", generation: 1, tokenHash: null, accounts: { "customer.1": "buyer1@example.test" }, retired: [], submitted: true } };
  writeRunFiles(t.main, { runId: t.runId, worktree: t.wt, home: t.home, origins: ["http://localhost:41002"], allowOrigins: [], groups: [], env: t.env, ports, instanceId: "0123456789abcdef", slots, internal: { proxy: 41009 }, browser: { channel: "chrome" } });
  runs.push({ main: t.main, runId: t.runId });
  const dir = join(t.main, "e2e/argus-smoke/journeys");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "checkout.json"), `${JSON.stringify({ journey: "checkout", path: PATH(), admitted: { run: "r", head, pathSha: "1".repeat(64), seed: 1 } }, null, 2)}\n`);
  const live = join(t.main, ".argus/live", t.runId);
  if (broke) {
    mkdirSync(join(live, "smoke"), { recursive: true });
    writeFileSync(join(live, "smoke", "pass.jsonl"), `${JSON.stringify({ id: "checkout", seed: 1, ...broke })}\n`);
  }
  if (ret) {
    mkdirSync(join(live, "returns"), { recursive: true });
    writeFileSync(join(live, "returns", "3.1.json"), JSON.stringify({ journey: "checkout", status: "done", roles: ["customer"], steps: [], created: [], values: [], candidates: [], cw: [], coverage: {}, harness_events: [], ...ret }));
  }
  return { ...t, head };
};

/** A runOnce stand-in: the verdict lines in turn (`held`, `broke <n> <kind>`, `harness`), recording each call. */
const stub = (verdicts: string[]) => {
  const calls: Obj[] = [];
  const once = async (_main: string, ref: string | null, opts: Obj) => {
    calls.push({ ref, ...opts });
    const v = verdicts[calls.length - 1] ?? "held";
    const [word, step, kind] = v.split(" ");
    const code = word === "held" ? 0 : word === "broke" ? 3 : 2;
    const last = code === 0 ? "PATH held" : code === 3 ? `PATH broke step=${step} kind=${kind}` : "HARNESS: step 1 system trigger exited 1";
    return { code, lines: [opts.dirty ? "dirty: instance 0123456789abcdef" : "fresh: instance 0123456789abcdef", last], result: { exit: code } };
  };
  return { once, calls };
};

const heal = (steps: Obj[]) => ({ heal: steps });

describe("healPath and healOnly — a heal changes action targets, nothing else (spec §19.9)", () => {
  it("replaces only the named steps' targets", () => {
    const { list, changes } = healPath(PATH(), [{ step: 5, target: NEW }], 3);
    expect(list).toEqual(HEALED());
    expect(changes).toEqual([{ step: 5, from: { role: "button", name: "Place order" }, to: NEW }]);
    // A target inside a parallel group is found by its step number (each member counts).
    const par = [{ as: "customer", do: "goto", path: "/" }, { parallel: [{ as: "customer", do: "click", target: { role: "button", name: "A" } }, { as: "sales", do: "click", target: { role: "button", name: "B" } }] }, { as: "sales", expect: "visible", target: { text: "x" } }];
    expect(healPath(par, [{ step: 3, target: NEW }], 3).list[1].parallel[1].target).toEqual(NEW);
  });

  it("refuses a heal naming an expectation, a step without a target, a step not in the path, or too many steps", () => {
    expect(() => healPath(PATH(), [{ step: 7, target: NEW }], 3)).toThrow("refused: smoke heal: step 7: a heal never changes an expectation");
    expect(() => healPath(PATH(), [{ step: 3, target: NEW }], 3)).toThrow("refused: smoke heal: step 3: goto has no target to heal");
    expect(() => healPath(PATH(), [{ step: 12, target: NEW }], 3)).toThrow("refused: smoke heal: step 12: the path has no such step");
    expect(() => healPath(PATH(), [{ step: 4, target: { label: "Qty" } }, { step: 5, target: NEW }], 1)).toThrow("refused: smoke heal: a heal changes at most 1 target");
  });

  it("healOnly refuses anything but a target: a value, an action's kind, an expectation, a step added or removed, the context", () => {
    const p = PATH();
    const at = (i: number, x: Obj) => p.map((y, j) => (j === i ? x : y));
    expect(healOnly(p, HEALED(), 3)).toEqual([{ step: 5, from: { role: "button", name: "Place order" }, to: NEW }]);
    expect(() => healOnly(p, at(4, { ...p[4], value: "3" }), 3)).toThrow("refused: smoke heal: step 4: a heal never changes a value");
    expect(() => healOnly(p, at(5, { ...p[5], do: "dblclick" }), 3)).toThrow("refused: smoke heal: step 5: a heal never changes an action's kind");
    expect(() => healOnly(p, at(7, { ...p[7], target: { text: "Order" } }), 3)).toThrow("refused: smoke heal: step 7: a heal never changes an expectation");
    expect(() => healOnly(p, at(7, { ...p[7], expect: "hidden" }), 3)).toThrow("refused: smoke heal: step 7: a heal never changes an expectation");
    expect(() => healOnly(p, at(6, { as: "customer", do: "click", target: NEW }), 3)).toThrow("refused: smoke heal: step 6: a heal never changes an action's kind");
    expect(() => healOnly(p, [...p.slice(0, 6), { as: "customer", do: "click", target: NEW }, ...p.slice(6)], 3)).toThrow("refused: smoke heal: a heal never adds or removes a step");
    expect(() => healOnly(p, [...p.slice(0, 5), ...p.slice(6)], 3)).toThrow("refused: smoke heal: a heal never adds or removes a step");
    expect(() => healOnly(p, at(0, { context: { viewport: 390 } }), 3)).toThrow("refused: smoke heal: a heal never changes the context");
    expect(() => healOnly(p, at(5, { ...p[5], as: "sales" }), 3)).toThrow("refused: smoke heal: step 5: a heal never changes its as");
    const two = HEALED().map((x, i) => (i === 4 ? { ...x, target: { label: "Qty" } } : x));
    expect(() => healOnly(p, two, 1)).toThrow("refused: smoke heal: a heal changes at most 1 target");
  });
});

describe("smoke heal — the decision table's heal rows (spec §19.9)", () => {
  it("UI changed: the healed path held twice, fresh then dirty → a staged heal with git log -S evidence, old and new targets in its body", async () => {
    const t = healRun({ ret: heal([{ step: 5, target: NEW }]) });
    writeFileSync(join(t.main, "app.txt"), "<button>Submit order</button>\n");
    commit(t.main, "rename the order button");
    const s = stub(["held", "held"]);
    const r = await smokeHeal(t.main, "3.1", { once: s.once });
    expect(r.code).toBe(0);
    expect(s.calls.map((c) => [c.ref, c.dirty, c.path.id])).toEqual([[null, false, "checkout"], [null, true, "checkout"]]);
    for (const c of s.calls) expect(c.path.list).toEqual(HEALED());
    expect(r.lines[0]).toBe("heal checkout: UI changed: the healed path held twice (fresh, then dirty), every expectation unchanged");
    expect(r.lines[1]).toMatch(/^staged: heal checkout \(digest [0-9a-f]{12}\)$/);
    expect(r.masked).toBe(true);
    // The page-derived targets and git's subjects are printed only inside the fence.
    const fenced = r.lines.slice(2).join("\n");
    expect(fenced).toMatch(/^<<<PAGE-[0-9a-f]{32}\n/);
    expect(fenced).toContain('page.getByRole("button", {"name": "Place order"})');
    expect(fenced).toContain('page.getByRole("button", {"name": "Submit order"})');
    expect(fenced).toContain("rename the order button");
    const state = readState(t.main);
    expect(statSync(join(t.main, ".argus/smoke-state.json")).mode & 0o777).toBe(0o600);
    expect(state.staged).toHaveLength(1);
    const st = state.staged[0];
    expect(st).toMatchObject({ kind: "heal", id: "checkout", run: t.runId, path: HEALED() });
    expect(st.changes).toEqual([{ kind: "heal", id: "checkout", step: 5, from: { role: "button", name: "Place order" }, to: NEW, evidence: st.changes[0].evidence, run: t.runId }]);
    expect(st.changes[0].evidence.join("\n")).toMatch(/git log -S"Place order" [0-9a-f]{12}\.\.HEAD: [0-9a-f]{7,} rename the order button/);
    const body = st.body.join("\n");
    expect(body).toContain("step 5");
    expect(body).toContain('from: page.getByRole("button", {"name": "Place order"})');
    expect(body).toContain('to:   page.getByRole("button", {"name": "Submit order"})');
    expect(body).toContain("rename the order button");
    // No suite file is touched: the heal reaches the repo only through a proposal.
    expect(JSON.parse(readFileSync(join(t.main, "e2e/argus-smoke/journeys/checkout.json"), "utf8")).path).toEqual(PATH());
  });

  it("names no commit when none removed the old name", async () => {
    const t = healRun({ ret: heal([{ step: 5, target: NEW }]) });
    const r = await smokeHeal(t.main, "3.1", { once: stub(["held", "held"]).once });
    expect(r.code).toBe(0);
    expect(readState(t.main).staged[0].changes[0].evidence[0]).toMatch(/^git log -S"Place order" [0-9a-f]{12}\.\.HEAD: no commit removed it$/);
  });

  it("behaviour changed: the healed path fails an expectation twice → a regression candidate at it, on the healed path; nothing staged", async () => {
    const t = healRun({ ret: heal([{ step: 5, target: NEW }]) });
    const r = await smokeHeal(t.main, "3.1", { once: stub(["broke 7 expect-failed", "broke 7 expect-failed"]).once });
    expect(r.code).toBe(3);
    expect(r.lines[0]).toBe("heal checkout: behaviour changed: the healed path failed step 7's expectation twice");
    expect(r.lines[1]).toBe("regression checkout: step 7 written as 1.1.1 (repro 1.1.1)");
    const { candidate } = reproRef(t.main, "1.1.1");
    expect(candidate.oracle).toBe("regression");
    expect(candidate.repro).toEqual([{ context: { viewport: 1440, locale: "en-US", timezone: "UTC" } }, ...HEALED().slice(1, 7), { ...HEALED()[7], final: "regression" }]);
    expect(readRun(t.main).slots["1"]).toMatchObject({ mode: "smoke", journey: "checkout", generation: 1, tokenHash: null, submitted: true });
    expect(readState(t.main).staged).toEqual([]);
  });

  it("a bug: heal [] with no-control → a regression candidate: the path to step n − 1, then visible on the old target", async () => {
    const t = healRun({ ret: { heal: [], heal_reason: "no-control" } });
    const s = stub([]);
    const r = await smokeHeal(t.main, "3.1", { once: s.once });
    expect(s.calls).toEqual([]);
    expect(r.code).toBe(3);
    expect(r.lines).toEqual(["heal checkout: bug: the explorer found no control for step 5's goal (a heal cannot add a step)", "regression checkout: step 5 written as 1.1.1 (repro 1.1.1)"]);
    const { candidate, slotRec } = reproRef(t.main, "1.1.1");
    const want = [{ context: { viewport: 1440, locale: "en-US", timezone: "UTC" } }, ...PATH().slice(1, 5), { as: "customer", expect: "visible", target: { role: "button", name: "Place order" }, final: "regression" }];
    expect(candidate.repro).toEqual(want);
    expect(parseRepro(candidate.repro, { accounts: slotRec.accounts, live: pathLive() }).steps.at(-1)).toMatchObject({ n: 5, expect: "visible", final: "regression" });
    expect(readState(t.main).staged).toEqual([]);
  });

  it("heal [] blocked or harness is the harness's: nothing staged, nothing written", async () => {
    for (const reason of ["blocked", "harness"]) {
      const t = healRun({ ret: { heal: [], heal_reason: reason } });
      const r = await smokeHeal(t.main, "3.1", { once: stub([]).once });
      expect(r.code).toBe(2);
      expect(r.lines).toEqual([`heal checkout: harness: the explorer was ${reason === "blocked" ? "blocked by the page" : "stopped by the harness"}; nothing staged`]);
      expect(readState(t.main).staged).toEqual([]);
      expect(Object.keys(readRun(t.main).slots)).toEqual(["3"]);
    }
  });

  it("a heal that does not hold twice stages nothing and writes nothing", async () => {
    for (const verdicts of [["held", "broke 5 target-missing"], ["broke 7 expect-failed", "held"], ["broke 6 target-ambiguous", "broke 6 target-ambiguous"]]) {
      const t = healRun({ ret: heal([{ step: 5, target: NEW }]) });
      const r = await smokeHeal(t.main, "3.1", { once: stub(verdicts).once });
      expect(r.code).toBe(3);
      expect(r.lines[0]).toMatch(/^heal checkout: did not hold \(fresh: (held|broke step=\d kind=[a-z-]+), dirty: (held|broke step=\d kind=[a-z-]+)\); nothing staged$/);
      expect(readState(t.main).staged).toEqual([]);
      expect(Object.keys(readRun(t.main).slots)).toEqual(["3"]);
    }
    const h = healRun({ ret: heal([{ step: 5, target: NEW }]) });
    const r = await smokeHeal(h.main, "3.1", { once: stub(["held", "harness"]).once });
    expect(r).toMatchObject({ code: 2, lines: ["heal checkout: harness: step 1 system trigger exited 1; nothing staged"] });
  });

  it("refuses before any run: a bad ref, no cycle, an unminted slot, no return, a return without heal, no confirmed action break, a heal the table refuses", async () => {
    const s = stub([]);
    const t = healRun({ ret: heal([{ step: 7, target: NEW }]) });
    await expect(smokeHeal(t.main, "3", { once: s.once })).rejects.toThrow("refused: smoke heal: 3 is not <slot>.<generation>");
    await expect(smokeHeal(t.main, "4.1", { once: s.once })).rejects.toThrow(`refused: smoke heal: slot 4 was never minted in cycle ${t.runId}`);
    await expect(smokeHeal(t.main, "3.2", { once: s.once })).rejects.toThrow("refused: smoke heal: no return 3.2");
    await expect(smokeHeal(t.main, "3.1", { once: s.once })).rejects.toThrow("refused: smoke heal: step 7: a heal never changes an expectation");
    const many = healRun({ ret: heal([{ step: 4, target: { label: "Qty" } }, { step: 5, target: NEW }]), smoke: { heal_max_steps: 1 } });
    await expect(smokeHeal(many.main, "3.1", { once: s.once })).rejects.toThrow("refused: smoke heal: a heal changes at most 1 target");
    const none = healRun({ ret: {} });
    await expect(smokeHeal(none.main, "3.1", { once: s.once })).rejects.toThrow("refused: smoke heal: return 3.1 holds no heal");
    for (const broke of [null, { verdict: "held", step: null, kind: null }, { verdict: "broke", step: 7, kind: "expect-failed" }, { verdict: "flaky", step: 5, kind: "target-missing" }]) {
      const u = healRun({ ret: heal([{ step: 5, target: NEW }]), broke });
      await expect(smokeHeal(u.main, "3.1", { once: s.once })).rejects.toThrow("refused: smoke heal: checkout has no confirmed action break in this cycle's pass (smoke run)");
    }
    // A target outside the selector order is refused by the path's own parse.
    const css = healRun({ ret: heal([{ step: 5, target: { text: "Submit order" } }]) });
    await expect(smokeHeal(css.main, "3.1", { once: s.once })).rejects.toThrow(/^refused: smoke heal: step 5: an action's target in a path is/);
    expect(s.calls).toEqual([]);
    const gone = healRun({ ret: heal([{ step: 5, target: NEW }]) });
    await down(gone.main, { runId: gone.runId, graceMs: 1000 });
    await expect(smokeHeal(gone.main, "3.1", { once: s.once })).rejects.toThrow("refused: no journey cycle is running");
  }, 30_000);
});

describe("staging — every suite change waits for a proposal (spec §19.8)", () => {
  it("stages by digest: the same change replaces its entry, a rejected digest is never staged again", () => {
    const t = healRun();
    const a = stage(t.main, { kind: "quarantine", id: "checkout", run: t.runId, changes: [{ kind: "quarantine", id: "checkout", evidence: ["x"], run: t.runId }], body: [] });
    expect(a.staged).toBe(true);
    expect(a.digest).toMatch(/^[0-9a-f]{64}$/);
    // The digest is the change's, not the run's or the evidence's: the same change in a later cycle is the same digest.
    const b = stage(t.main, { kind: "quarantine", id: "checkout", run: "other", changes: [{ kind: "quarantine", id: "checkout", evidence: ["y"], run: "other" }], body: [] });
    expect(b.digest).toBe(a.digest);
    expect(readState(t.main).staged).toHaveLength(1);
    expect(readState(t.main).staged[0].run).toBe("other");
    const state = readState(t.main);
    writeFileSync(join(t.main, ".argus/smoke-state.json"), JSON.stringify({ ...state, staged: [], rejected: [a.digest] }));
    expect(stage(t.main, { kind: "quarantine", id: "checkout", run: "x", changes: [{ kind: "quarantine", id: "checkout", evidence: [], run: "x" }], body: [] })).toEqual({ staged: false, digest: a.digest });
    expect(readState(t.main).staged).toEqual([]);
  });

  it("a state file that is not the state's shape refuses rather than being overwritten", () => {
    const t = healRun();
    writeFileSync(join(t.main, ".argus/smoke-state.json"), "[1]");
    expect(() => readState(t.main)).toThrow("refused: .argus/smoke-state.json is not the smoke state (remove it to start over)");
  });
});

describe("§19.9's rows that end in the lane's own pass, and the rule that CI never heals", () => {
  it("an expectation that fails twice is behaviour changed: smoke run --slot writes its regression candidate", async () => {
    const t = healRun();
    const s = stub(["broke 7 expect-failed", "broke 7 expect-failed"]);
    const r = await smokeRun(t.main, { ids: null, slot: 5, perf: false, seed: 1 }, { once: s.once });
    expect(r.lines).toContain("regression checkout: step 7 written as 5.1.1 (repro 5.1.1)");
  });

  it("a locator break confirmed fresh and dirty is what sends a journey to the heal-mode explorer", async () => {
    const t = healRun({ broke: null });
    const r = await smokeRun(t.main, { ids: null, slot: null, perf: false, seed: 1 }, { once: stub(["broke 5 target-missing", "broke 5 target-missing"]).once });
    expect(r.lines).toContain("path checkout: broke step=5 kind=target-missing");
    // smoke heal then reads that verdict from the pass: with a heal return it gets past the break check.
    const live = join(t.main, ".argus/live", t.runId, "returns");
    mkdirSync(live, { recursive: true });
    writeFileSync(join(live, "3.1.json"), JSON.stringify({ journey: "checkout", status: "done", heal: [], heal_reason: "harness" }));
    expect((await smokeHeal(t.main, "3.1", { once: stub([]).once })).code).toBe(2);
  });

  it("nothing in the generated suite heals at run time: no fallback locator, no retry of a target, no skip", () => {
    const files = generateSuite({ paths: [{ id: "checkout", path: PATH() }], live: pathLive(), smoke: SMOKE_DEFAULTS, quarantine: ["checkout"] });
    const spec = files["checkout.spec.ts"];
    for (const banned of [".or(", "heal", "test.skip", "test.fixme", "test.fail(", "catch (e) {\n    await"]) expect(spec, banned).not.toContain(banned);
    // The quarantined journey is tagged, never skipped.
    expect(spec).toContain('"tag": "@quarantine"');
  });
});
