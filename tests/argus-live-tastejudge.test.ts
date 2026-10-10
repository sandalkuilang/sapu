// tests/argus-live-tastejudge.test.ts — lane J's file: the taste judge and its confirmation replay
// (argus-live-tastejudge.mjs, spec §20.4). Lane 0 left one stub pin per verb; lane J replaces each `it`.
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { ARGUS_LIVE, cleanTemps, committed } from "./helpers/argus-live";
// @ts-expect-error — plain ESM script without types
import { tasteConfirm, tasteJudge } from "../plugins/sapu/scripts/argus-live-tastejudge.mjs";

afterEach(cleanTemps);

const cli = (main: string, ...args: string[]) => spawnSync(process.execPath, [ARGUS_LIVE, ...args], { cwd: main, encoding: "utf8" });

describe("argus-live taste judge and confirm — lane 0's stubs (lane J replaces each)", () => {
  it("taste judge [--run] reaches tasteJudge(main, {run}), a stub", async () => {
    await expect(tasteJudge("/nowhere", { run: null })).rejects.toThrow("refused: taste judge: not built yet");
    const main = committed();
    for (const args of [["taste", "judge"], ["taste", "judge", "--run", "20000101000000-0123abcd"]]) {
      expect(cli(main, ...args), args.join(" ")).toMatchObject({ status: 1, stdout: "", stderr: "refused: taste judge: not built yet\n" });
    }
  }, 30_000);

  it("taste confirm <row> reaches tasteConfirm(main, ref), a stub", async () => {
    await expect(tasteConfirm("/nowhere", "t1")).rejects.toThrow("refused: taste confirm: not built yet");
    expect(cli(committed(), "taste", "confirm", "t1")).toMatchObject({ status: 1, stdout: "", stderr: "refused: taste confirm: not built yet\n" });
  }, 30_000);
});
