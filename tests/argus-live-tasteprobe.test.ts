// tests/argus-live-tasteprobe.test.ts — lane T1's file: the visual probes of argus-live-taste.mjs (spec §20.2).
// Lane 0 left one stub pin per locked export; lane T1 replaces each `it` as it builds that export.
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain ESM script without types
import { CHECKS, censusOf, ruleExpression, rulesFor, TASTE_INIT, TASTE_SOURCE } from "../plugins/sapu/scripts/argus-live-taste.mjs";

describe("argus-live-taste.mjs — lane 0's stubs (lane T1 replaces each)", () => {
  it("TASTE_SOURCE is an in-page function's source (stub: it throws when called)", () => {
    expect(typeof TASTE_SOURCE).toBe("string");
    expect(() => new Function(`return (${TASTE_SOURCE})({});`)()).toThrow("refused: TASTE_SOURCE: not built yet");
  });

  it("TASTE_INIT is the init payload's motion recorder (stub: empty, so nothing is installed)", () => {
    expect(TASTE_INIT).toBe("");
  });

  it("CHECKS registers no suite check yet", () => {
    expect(CHECKS).toEqual([]);
  });

  it("censusOf(page) is not built yet", async () => {
    await expect(censusOf({})).rejects.toThrow("refused: censusOf: not built yet");
  });

  it("rulesFor(screen, bar, cfg) is not built yet", () => {
    expect(() => rulesFor({}, {}, {})).toThrow("refused: rulesFor: not built yet");
  });

  it("ruleExpression(rule) is not built yet", () => {
    expect(() => ruleExpression("scale.spacing")).toThrow("refused: ruleExpression: not built yet");
  });
});
