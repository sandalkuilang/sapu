// tests/diagrams.test.ts — every committed diagram (docs/img/<name>.svg and <name>-dark.svg) is exactly what its source
// (docs/img/src/diagrams/<name>.mjs with its a11y text) builds: an edited source or a11y file that was not rebuilt, or a
// hand-edited SVG, fails here.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");
const IMG = join(ROOT, "docs/img");
const names = readdirSync(join(IMG, "src/diagrams"))
  .filter((f) => f.endsWith(".mjs"))
  .map((f) => f.replace(/\.mjs$/, ""))
  .sort();
const out = mkdtempSync(join(tmpdir(), "diagrams-"));
afterAll(() => rmSync(out, { recursive: true, force: true }));

describe("docs/img — the committed diagrams are their sources' build", () => {
  it("builds every diagram in both themes", () => {
    expect(names.length).toBeGreaterThan(0);
    const r = spawnSync(process.execPath, [join(IMG, "src/build.mjs")], { cwd: ROOT, encoding: "utf8", env: { ...process.env, OUT: out } });
    expect(r.status, r.stderr).toBe(0);
  }, 60_000);

  it.each(names.flatMap((n) => [`${n}.svg`, `${n}-dark.svg`]))("%s equals a fresh build (rebuild: node docs/img/src/build.mjs <name>)", (file) => {
    expect(readFileSync(join(out, file), "utf8") === readFileSync(join(IMG, file), "utf8"), file).toBe(true);
  });
});
