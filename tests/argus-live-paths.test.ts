// tests/argus-live-paths.test.ts — the repro runner's path mode on a real Chrome-family browser through the
// pinned CLI: its PATH verdicts, and the lane's smoke pass that turns a confirmed break into a regression
// candidate. Its own file, beside tests/argus-live-repro.test.ts, so the two run on separate workers.
// A machine without Chrome or Edge fails here, never skips: the lane cannot run there either.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { appCycle, browserCleanup, browserLeftovers, browserTools, fixtureProcs } from "./helpers/argus-live";
// @ts-expect-error — plain ESM script without types
import { runOnce } from "../plugins/sapu/scripts/argus-live-repro.mjs";

type Obj = Record<string, any>;

beforeAll(() => {
  browserTools();
}, 600_000);

afterEach(browserCleanup, 60_000);

describe("argus-live paths — the runner's PATH verdicts and the lane's smoke pass (spec §19.4, §19.9)", () => {
  /** Marks this describe's fixture processes (appCycle): other test files run the fixture at the same time. */
  const MARK = "--from=argus-live-path-tests";
  afterEach(() => {
    for (const l of fixtureProcs(MARK)) {
      try {
        process.kill(Number(l.trim().split(/\s+/)[0]), "SIGKILL");
      } catch {
        // gone
      }
    }
  });
  /** The words a path run prints outside its fence. */
  const VOCABULARY = /^((fresh|dirty): instance [0-9a-f]+|step \d+ (system|[a-z][a-z0-9_-]*\.\d+) [a-z-]+: (ok|held|failed|changed-state)|truncated \d+ characters|PATH held|PATH broke step=\d+ kind=(target-missing|target-ambiguous|expect-failed|action-failed)|HARNESS: .+)$/;
  /** A repro cycle whose live.json names the app's test id attribute (committed), up. */
  const pathCycle = () => {
    const c = appCycle({ mark: MARK, repro: true });
    const file = join(c.main, ".argus/live.json");
    writeFileSync(file, `${JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), test_id_attribute: "data-testid" }, null, 2)}\n`);
    execFileSync("git", ["-C", c.main, "-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", "commit", "-qam", "test ids"]);
    const { summary } = c.up();
    return { c, runId: summary.runId as string };
  };
  /** buyer.1 places an order of `quantity`, saved as `save`. */
  const PLACE = (save = "order", quantity = "1"): Obj[] => [
    { as: "buyer.1", do: "goto", path: "/orders/new" },
    { as: "buyer.1", do: "fill", target: { label: "Quantity" }, value: quantity },
    { as: "buyer.1", do: "click", target: { role: "button", name: "Place order" } },
    { as: "buyer.1", do: "read", target: { testId: "order-number" }, save },
    { as: "buyer.1", expect: "visible", target: { testId: "order-number" } },
  ];
  const HANDOFF = (): Obj[] => [...PLACE(), { as: "clerk.1", do: "goto", path: "/inbox" }, { as: "clerk.1", expect: "visible", target: { text: "{{order}}" } }];
  /** One path run → its exit, its lines outside the fence and its last line. */
  const once = async (main: string, id: string, list: Obj[], dirty = true) => {
    const r = await runOnce(main, null, { path: { id, list }, dirty });
    const outsideFence = r.lines.filter((l: string) => !l.startsWith("<<<"));
    for (const l of outsideFence) expect(l, id).toMatch(VOCABULARY);
    return { code: r.code, last: r.lines.at(-1), lines: r.lines };
  };

  it("PATH held, and each kind of break, recorded under <run>/smoke/<id>/", async () => {
    const { c, runId } = pathCycle();
    const held = await once(c.main, "place-order", PLACE(), false);
    expect([held.code, held.last], held.lines.join(" | ")).toEqual([0, "PATH held"]);
    expect(held.lines[0]).toMatch(/^fresh: instance [0-9a-f]+$/);
    const dir = join(c.main, ".argus/live", runId, "smoke", "place-order");
    expect(JSON.parse(readFileSync(join(dir, "run-1.json"), "utf8"))).toMatchObject({ exit: 0, kind: null, dirty: false });
    expect(JSON.parse(readFileSync(join(dir, "path.json"), "utf8"))).toMatchObject({ id: "place-order", path: PLACE() });
    expect(statSync(join(dir, "run-1.json")).mode & 0o777).toBe(0o600);

    // A dirty run (no up --fresh) on the instance as the last run left it.
    const missing = await once(c.main, "missing", [{ as: "buyer.1", do: "goto", path: "/orders/new" }, { as: "buyer.1", do: "click", target: { role: "button", name: "Place no order" } }, { as: "buyer.1", expect: "visible", target: { label: "Quantity" } }]);
    expect([missing.code, missing.last], missing.lines.join(" | ")).toEqual([3, "PATH broke step=2 kind=target-missing"]);
    expect(missing.lines[0]).toMatch(/^dirty: instance [0-9a-f]+$/);
    expect(JSON.parse(readFileSync(join(c.main, ".argus/live", runId, "smoke", "missing", "run-1.json"), "utf8"))).toMatchObject({ exit: 3, step: 2, kind: "target-missing", dirty: true });

    // Two orders in the inbox: one Claim button each.
    const twice = [...PLACE("first"), ...PLACE("second"), { as: "clerk.1", do: "goto", path: "/inbox" }, { as: "clerk.1", do: "click", target: { role: "button", name: "Claim" } }, { as: "clerk.1", expect: "visible", target: { text: "{{second}}" } }];
    const ambiguous = await once(c.main, "ambiguous", twice);
    expect([ambiguous.code, ambiguous.last], ambiguous.lines.join(" | ")).toEqual([3, "PATH broke step=12 kind=target-ambiguous"]);

    c.defects("dead-end");
    const ship = [...PLACE(), { as: "clerk.1", do: "goto", path: "/orders/{{order}}" }, { as: "clerk.1", do: "click", target: { role: "button", name: "Approve" } }, { as: "clerk.1", expect: "visible", target: { role: "button", name: "Ship" } }, { as: "clerk.1", do: "click", target: { role: "button", name: "Ship" } }, { as: "clerk.1", expect: "visible", target: { testId: "order-number" } }];
    const failed = await once(c.main, "ship", ship);
    expect([failed.code, failed.last], failed.lines.join(" | ")).toEqual([3, "PATH broke step=9 kind=action-failed"]);

    c.defects("missing-handoff");
    const broke = await once(c.main, "handoff", HANDOFF());
    expect([broke.code, broke.last], broke.lines.join(" | ")).toEqual([3, "PATH broke step=7 kind=expect-failed"]);
    // What the page showed is fenced, as a final's is.
    expect(broke.lines.some((l: string) => /^<<<PAGE-[0-9a-f]{32}\n/.test(l))).toBe(true);
    expect(JSON.parse(readFileSync(join(c.main, ".argus/live", runId, "smoke", "handoff", "run-1.json"), "utf8"))).toMatchObject({ exit: 3, step: 7, kind: "expect-failed", expected: "visible", observed: "absent" });
    // A path the path mode refuses is the harness's.
    const refused = await once(c.main, "refused", [...HANDOFF().slice(0, -1), { ...HANDOFF().at(-1), final: "handoff" }]);
    expect([refused.code, refused.last]).toEqual([2, "HARNESS: repro: step 7: a path has no final: it ends with an expect proving the journey's goal"]);
  }, 900_000);

  it("smoke run --slot: a break confirmed after up --fresh becomes a regression candidate that repro reproduces two of two", async () => {
    const { c, runId } = pathCycle();
    const journeys = join(c.main, "e2e/argus-smoke/journeys");
    mkdirSync(journeys, { recursive: true });
    writeFileSync(join(journeys, "order-handoff.json"), `${JSON.stringify({ journey: "order-handoff", path: HANDOFF() })}\n`);
    writeFileSync(join(journeys, "place-order.json"), `${JSON.stringify({ journey: "place-order", path: PLACE() })}\n`);
    c.defects("missing-handoff");
    const r = c.cli("smoke", "run", "--slot", "2", "--seed", "5");
    expect(r.code, `${r.out}\n${r.err}`).toBe(3);
    const lines = r.out.trimEnd().split("\n");
    expect(lines[0]).toBe("seed: 5");
    expect(lines).toContain("path place-order: held");
    expect(lines).toContain("path order-handoff: broke step=7 kind=expect-failed");
    expect(lines).toContain("regression order-handoff: step 7 written as 2.1.1 (repro 2.1.1)");
    expect(lines.at(-1)).toBe("smoke run: 1 held, 1 broke, 0 flaky, 0 harness");
    const two = c.cli("repro", "2.1.1");
    expect(two.code, `${two.out}\n${two.err}`).toBe(3);
    expect(two.out.trimEnd().split("\n").at(-1)).toBe("REPRODUCED step=7 expected=visible observed=absent");
    expect(JSON.parse(readFileSync(join(c.main, ".argus/live", runId, "repro", "2.1.1", "verdict.json"), "utf8"))).toEqual({ runs: [3, 3], verdict: "reproduced" });
    expect(c.cli("classify", "--oracle", "regression").out).toBe("class A labels bug,argus:needs-owner,argus,found-by:user severity S3 because regression, not on a money journey\n");
  }, 900_000);
});

afterEach(browserLeftovers);
