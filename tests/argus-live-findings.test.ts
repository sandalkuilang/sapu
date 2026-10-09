// tests/argus-live-findings.test.ts — the journey lane's findings side without a browser: the module DAG,
// origins, the session driver (the CLI shim standing in for @playwright/cli), and later the repro DSL, the
// generated test, classes, the secret ledger's matcher, scrub, the journey map, SELECT and doc drift.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain ESM script without types
import { checkUrl, originOf } from "../plugins/sapu/scripts/argus-live-origin.mjs";

const SCRIPTS = join(__dirname, "../plugins/sapu/scripts");

describe("argus-live modules — the DAG", () => {
  /** Each argus-live module (`argus-live`, `argus-live-pw`, …) → the argus-live modules it imports. */
  const graph = () => {
    const out = new Map<string, string[]>();
    for (const f of readdirSync(SCRIPTS).filter((x) => /^argus-live(-[a-z]+)?\.mjs$/.test(x))) {
      const text = readFileSync(join(SCRIPTS, f), "utf8");
      out.set(f.replace(/\.mjs$/, ""), [...text.matchAll(/from "\.\/(argus-live-[a-z]+)\.mjs"/g)].map((m) => m[1]));
    }
    return out;
  };
  /** Every module `from` reaches through its imports. */
  const reach = (g: Map<string, string[]>, from: string) => {
    const seen = new Set<string>();
    const stack = [...(g.get(from) ?? [])];
    while (stack.length) {
      const m = stack.pop()!;
      if (seen.has(m)) continue;
      seen.add(m);
      stack.push(...(g.get(m) ?? []));
    }
    return seen;
  };

  it("every argus-live module imports only modules below it", () => {
    const g = graph();
    expect(g.has("argus-live-origin")).toBe(true);
    expect(g.has("argus-live-start")).toBe(true);
    for (const [m, deps] of g) for (const d of deps) expect(g.has(d), `${m} imports ${d}`).toBe(true);
    for (const m of g.keys()) expect(reach(g, m).has(m), `${m} imports itself through its imports`).toBe(false);
    for (const leaf of ["argus-live-fence", "argus-live-targets", "argus-live-origin"]) expect(g.get(leaf), leaf).toEqual([]);
    expect(reach(g, "argus-live-pw").has("argus-live-instance")).toBe(false);
    expect(reach(g, "argus-live-start").has("argus-live-browser")).toBe(false);
    expect(readFileSync(join(SCRIPTS, "argus-live-instance.mjs"), "utf8").split("\n").length).toBeLessThan(700);
  });

  it("origins are compared as the run spells them", () => {
    expect(originOf("wss://Example.test/x")).toBe("https://example.test:443");
    expect(originOf("ws://localhost:5/x")).toBe("http://localhost:5");
    expect(originOf("javascript:x")).toBeNull();
    const at = { origins: ["http://localhost:4100"], base: "http://localhost:4100/" };
    expect(checkUrl("/orders/new", at)).toBe("http://localhost:4100/orders/new");
    expect(() => checkUrl("//x.test/", at)).toThrow("refused: //x.test/ is outside the run's origins");
  });
});
