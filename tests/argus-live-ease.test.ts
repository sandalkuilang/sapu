// tests/argus-live-ease.test.ts — lane T2's file: the ease probes of argus-live-ease.mjs (spec §20.2).
// Lane 0 left one stub pin per locked export; lane T2 replaces each `it` as it builds that export.
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain ESM script without types
import { CHECKS, EASE_INIT, EASE_SOURCE, easeOf, pathCost, ruleExpression, rulesFor } from "../plugins/sapu/scripts/argus-live-ease.mjs";

describe("argus-live-ease.mjs — lane 0's stubs (lane T2 replaces each)", () => {
  it("EASE_SOURCE is an in-page function's source (stub: it throws when called)", () => {
    expect(typeof EASE_SOURCE).toBe("string");
    expect(() => new Function(`return (${EASE_SOURCE})({});`)()).toThrow("refused: EASE_SOURCE: not built yet");
  });

  it("EASE_INIT is the init payload's feedback clock (stub: empty, so nothing is installed)", () => {
    expect(EASE_INIT).toBe("");
  });

  it("CHECKS registers no suite check yet", () => {
    expect(CHECKS).toEqual([]);
  });

  it("pathCost(steps, geometry) is not built yet", () => {
    expect(() => pathCost([], [])).toThrow("refused: pathCost: not built yet");
  });

  it("easeOf(page) is not built yet", async () => {
    await expect(easeOf({})).rejects.toThrow("refused: easeOf: not built yet");
  });

  it("rulesFor(screen, bar, cfg) is not built yet", () => {
    expect(() => rulesFor({}, {}, {})).toThrow("refused: rulesFor: not built yet");
  });

  it("ruleExpression(rule) is not built yet", () => {
    expect(() => ruleExpression("feedback.busy")).toThrow("refused: ruleExpression: not built yet");
  });
});
