// tests/argus-live-tastefile.test.ts — lane F's file: filing taste rows and the owner's accept
// (argus-live-tastefile.mjs, spec §20.5). Lane 0 left one stub pin per verb; lane F replaces each `it`.
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { ARGUS_LIVE, cleanTemps, committed } from "./helpers/argus-live";
// @ts-expect-error — plain ESM script without types
import { tasteAccept, tasteFile } from "../plugins/sapu/scripts/argus-live-tastefile.mjs";

afterEach(cleanTemps);

const cli = (main: string, ...args: string[]) => spawnSync(process.execPath, [ARGUS_LIVE, ...args], { cwd: main, encoding: "utf8" });

describe("argus-live taste file and accept — lane 0's stubs (lane F replaces each)", () => {
  it("taste file [--run] reaches tasteFile(main, {run, cap}), a stub (cap null: taste.json's)", async () => {
    await expect(tasteFile("/nowhere", { run: null, cap: null })).rejects.toThrow("refused: taste file: not built yet");
    const main = committed();
    for (const args of [["taste", "file"], ["taste", "file", "--run", "20000101000000-0123abcd"]]) {
      expect(cli(main, ...args), args.join(" ")).toMatchObject({ status: 1, stdout: "", stderr: "refused: taste file: not built yet\n" });
    }
  }, 30_000);

  it("taste accept <rule> <key> reaches tasteAccept(main, rule, key), a stub", async () => {
    await expect(tasteAccept("/nowhere", "scale.spacing", "/orders|1440|light")).rejects.toThrow("refused: taste accept: not built yet");
    expect(cli(committed(), "taste", "accept", "scale.spacing", "/orders|1440|light")).toMatchObject({ status: 1, stdout: "", stderr: "refused: taste accept: not built yet\n" });
  }, 30_000);
});
