// tests/argus-live-oracles.test.ts — the repro runner on a real Chrome-family browser through the pinned CLI,
// against the fixture app's seeded defects: each oracle's repro reproduces and its fixed variant does not, a viewport
// defect, and the layout expectation. Its own file, beside tests/argus-live-repro.test.ts, so the two run on separate workers.
// A machine without Chrome or Edge fails here, never skips: the lane cannot run there either.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { browserCleanup, browserLeftovers, browserTools, fixtureProcs } from "./helpers/argus-live";
import { ORACLE_REPROS, PLACE, REPRODUCED, reproCycleFor, VOCABULARY } from "./helpers/argus-live-repro";

type Obj = Record<string, any>;

beforeAll(() => {
  browserTools();
}, 600_000);

afterEach(browserCleanup, 60_000);

describe("argus-live repro — the oracles' defects", () => {
  /** Marks this describe's fixture processes (appCycle): other test files run the fixture at the same time. */
  const MARK = "--from=argus-live-oracle-tests";
  afterEach(() => {
    for (const l of fixtureProcs(MARK)) {
      try {
        process.kill(Number(l.trim().split(/\s+/)[0]), "SIGKILL");
      } catch {
        // gone
      }
    }
  });
  const reproCycle = reproCycleFor(MARK);

  it("each seeded oracle defect reproduces, and its fixed variant does not", async () => {
    const t = await reproCycle(ORACLE_REPROS.map(([, r]) => r));
    for (const [k, [defect]] of ORACLE_REPROS.entries()) {
      t.c.defects(defect);
      const on = t.repro(t.refs[k]);
      expect(on.code, `${defect} on: ${on.lines.join(" | ")} ${on.last} ${on.err}`).toBe(3);
      expect(on.last, defect).toMatch(REPRODUCED);
      for (const l of on.lines) expect(l, defect).toMatch(VOCABULARY);
      expect(on.fence, defect).not.toBeNull();
      t.c.defects();
      const off = t.repro(t.refs[k]);
      expect(off.code, `${defect} off: ${off.lines.join(" | ")} ${off.last} ${off.err}`).toBe(0);
      expect(off.last, defect).toBe("NOT REPRODUCED");
      for (const l of off.lines) expect(l, defect).toMatch(VOCABULARY);
    }
    // What each reproduced: the oracle's final, and what the page showed in the run's words. Each run keeps its
    // own record (none overwritten): the reproducing one, then the fixed variant's.
    expect(t.record(t.refs[0], 1)).toMatchObject({ exit: 3, step: 7 });
    expect(t.record(t.refs[0], 2)).toMatchObject({ exit: 0, step: 7 });
    t.c.defects("claim-race");
    const race = t.repro(t.refs[3]);
    expect(race.last).toBe("REPRODUCED step=13 expected=count:1 observed=count:2");
    expect(race.lines).toContain("step 8 clerk.1 click: changed-state");
    expect(race.lines).toContain("step 9 clerk.2 click: changed-state");
  }, 1_800_000);

  it("a viewport defect reproduces at 390 and not at 1440; the delayed handoff is not a defect", async () => {
    const narrow = (viewport: number) => [{ context: { viewport } }, { as: "buyer.1", do: "goto", path: "/orders/new" }, { as: "buyer.1", expect: "visible", target: { role: "button", name: "Place order" }, final: "viewport-locale" }];
    // The clerk's inbox is open before the order is placed: the handoff lands 2000 ms later, within settle_ms.
    const delayed = [{ as: "clerk.1", do: "goto", path: "/inbox" }, ...PLACE(), { as: "clerk.1", expect: "visible", target: { text: "{{order}}" }, final: "handoff" }];
    const t = await reproCycle([narrow(390), narrow(1440), delayed]);
    t.c.defects("narrow-viewport");
    const small = t.repro(t.refs[0]);
    expect(small.code, small.lines.join(" | ")).toBe(3);
    expect(small.last).toBe("REPRODUCED step=2 expected=visible observed=absent");
    expect(t.repro(t.refs[1]).code).toBe(0);
    t.c.defects("delayed-handoff");
    const late = t.repro(t.refs[2]);
    expect(late.code, late.lines.join(" | ")).toBe(0);
    expect(late.lines).toContain("step 7 clerk.1 visible: held");
    t.c.defects("missing-handoff");
    expect(t.repro(t.refs[2]).code).toBe(3);
  }, 900_000);

  it("a layout expectation reproduces a real violation, holds on a clean page, and leaves out what the journey allows (lane Z1)", async () => {
    const onNew = (check: string, extra: Obj = {}) => [{ as: "buyer.1", do: "goto", path: "/orders/new" }, { as: "buyer.1", expect: "layout", check, final: "viewport-locale", ...extra }];
    const ACCOUNT = { role: "button", name: "Account" };
    const t = await reproCycle([onNew("target-size"), onNew("target-size", { target: ACCOUNT }), onNew("page-scroll"), onNew("target-size", { target: { role: "button", name: "Place order" } }), onNew("target-size", { target: { role: "button", name: "No such button" } })]);
    const [any, named, scroll, big, absent] = t.refs;
    const a = t.repro(any);
    expect(a.code, `${a.lines.join(" | ")} ${a.last} ${a.err}`).toBe(3);
    expect(a.last).toMatch(/^REPRODUCED step=2 expected=layout observed=violations:\d+$/);
    expect(a.last).toMatch(REPRODUCED);
    expect(a.fence).toContain("button|Account|button");
    for (const l of a.lines) expect(l).toMatch(VOCABULARY);
    expect(t.record(any, 1)).toMatchObject({ exit: 3, step: 2, expected: "layout" });
    const n = t.repro(named);
    expect(n.last, `${n.lines.join(" | ")} ${n.err}`).toBe("REPRODUCED step=2 expected=layout observed=violations:1");
    expect(n.fence).toContain(`"check":"target-size"`);
    expect(n.fence).toContain(`"shown":["button|Account|button"]`);
    // A page that does not scroll sideways, and a control big enough, hold; a target the page lacks cannot be judged.
    expect(t.repro(scroll).last).toBe("NOT REPRODUCED");
    expect(t.repro(big).last).toBe("NOT REPRODUCED");
    const gone = t.repro(absent);
    expect(gone.code).toBe(2);
    expect(gone.last).toBe("HARNESS: step 2 expectation could not be judged");
    // The owner's allow, then the adopted known rows: the same run holds.
    writeFileSync(join(t.c.main, ".argus/smoke.json"), JSON.stringify({ journeys: { "order-to-cash": { allow: [{ check: "target-size", key: "button|Account|button" }] } } }));
    const allowed = t.repro(named);
    expect(allowed.code, `${allowed.lines.join(" | ")} ${allowed.err}`).toBe(0);
    expect(allowed.last).toBe("NOT REPRODUCED");
    rmSync(join(t.c.main, ".argus/smoke.json"));
    expect(t.repro(named).code).toBe(3);
    mkdirSync(join(t.c.main, "e2e/argus-smoke/known"), { recursive: true });
    writeFileSync(join(t.c.main, "e2e/argus-smoke/known/order-to-cash.json"), JSON.stringify([{ check: "target-size", key: "button|Account|button" }]));
    expect(t.repro(named).last).toBe("NOT REPRODUCED");
  }, 900_000);
});

afterEach(browserLeftovers);
