// tests/argus-live-report.test.ts — lane F of phase 6 (spec §19.13, §19.14): the filed record scrub keeps
// (`<run>/filed.jsonl`), the per-cycle report written from a run's records only, and the API-level hint
// `repro --test` prints. No browser: every record is a fixture, every secret is built at run time.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ARGUS_LIVE, cleanTemps, committed, example, liveRun, longSecret, partsIn, tempDir } from "./helpers/argus-live";
// @ts-expect-error — plain ESM script without types
import { appendLedger } from "../plugins/sapu/scripts/argus-live-ledger.mjs";
// @ts-expect-error — plain ESM script without types
import { report } from "../plugins/sapu/scripts/argus-live-report.mjs";
// @ts-expect-error — plain ESM script without types
import { apiLevelHint } from "../plugins/sapu/scripts/argus-live-repro.mjs";
// @ts-expect-error — plain ESM script without types
import { down, writeRunFiles } from "../plugins/sapu/scripts/argus-live-run.mjs";
// @ts-expect-error — plain ESM script without types
import { filedFile, scrub } from "../plugins/sapu/scripts/argus-live-scrub.mjs";

type Obj = Record<string, any>;

/** Runs a test brought up with writeRunFiles: each is torn down after its test. */
const runs: { main: string; runId: string }[] = [];
afterEach(async () => {
  for (const r of runs.splice(0)) await down(r.main, { runId: r.runId, graceMs: 1000 }).catch(() => {});
  cleanTemps();
});

/** The secrets of one run, made at run time: a ledger cookie, the env file's value and a role password. */
const SECRETS = () => ({ cookie: longSecret(24, "report-cookie"), envFile: longSecret(18, "report-env"), role: longSecret(14, "report-role") });
/** An environment with nothing secret-like: the report and scrub read only the run's own secrets. */
const ENV = { PATH: process.env.PATH ?? "" };
const ACCOUNTS = { "customer.1": "buyer1@example.test", "sales.1": "sales1@example.test", "buyer.1": "buyer2@example.test", "clerk.1": "clerk1@example.test" };

/**
 * A run as scrub and the report read it: the lock (liveRun), run.json naming slot 1, the live config (the
 * spec's example, its role password the run's own), its env file and a ledger holding one cookie.
 */
const cycle = () => {
  const t = liveRun();
  const s = SECRETS();
  const live = example();
  live.roles.customer.users[0].password = s.role;
  writeFileSync(join(t.main, ".argus/live.json"), `${JSON.stringify(live, null, 2)}\n`);
  writeFileSync(join(t.main, ".argus/live.env"), `PW=pw-1\nSALES_TOTP=${"GEZD".repeat(4)}\nDB_PW=${s.envFile}\n`);
  writeRunFiles(t.main, { runId: t.runId, worktree: t.wt, home: t.home, origins: ["http://localhost:41002"], allowOrigins: [], groups: [], env: t.env, ports: { api: 41001, web: 41002, pg: 41003, redis: 41004, smtp: 41005 }, slots: { "1": { journey: "order-to-cash", accounts: ACCOUNTS } } });
  runs.push({ main: t.main, runId: t.runId });
  appendLedger(t.main, t.runId, [{ c: "cookie", v: s.cookie }]);
  const runDir = join(t.main, ".argus/live", t.runId);
  const put = (rel: string, value: unknown) => {
    mkdirSync(join(runDir, rel, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(join(runDir, rel), typeof value === "string" ? value : `${JSON.stringify(value)}\n`);
  };
  const jsonl = (rel: string, values: unknown[]) => put(rel, values.map((v) => `${JSON.stringify(v)}\n`).join(""));
  return { ...t, s, runDir, put, jsonl };
};

const URL9 = "https://github.com/o/r/issues/9";
const COMMENT = `${URL9}#issuecomment-77`;

describe("argus-live scrub — the filed record", () => {
  /** A body file, a runner standing in for gh that answers `stdout` and records whether filed.jsonl existed at the call. */
  const filing = (t: ReturnType<typeof cycle>, stdout: string, status = 0) => {
    const body = join(tempDir(), "body.md");
    writeFileSync(body, "A clean body.\n");
    const calls: Obj[] = [];
    const runner = (argv: string[]) => {
      calls.push({ argv, recorded: existsSync(filedFile(t.main, t.runId)) });
      return { status, stdout };
    };
    return { body, calls, runner };
  };
  const records = (t: ReturnType<typeof cycle>) =>
    existsSync(filedFile(t.main, t.runId))
      ? readFileSync(filedFile(t.main, t.runId), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
      : [];

  it("--create appends {ref, url, kind} to <run>/filed.jsonl after gh printed the issue, never before", async () => {
    const t = cycle();
    t.put("repro/1.1.1/verdict.json", { runs: [3, 3], verdict: "reproduced" });
    const f = filing(t, `${URL9}\n`);
    const r = await scrub(t.main, { run: t.runId, ref: "1.1.1", title: "A title", bodyFile: f.body, create: true }, { env: ENV, runner: f.runner });
    // What scrub prints is as before: the record adds no line.
    expect(r).toEqual({ code: 0, out: ["scrub: ok; redacted 0, defanged 0, cut 0 line(s)", "title: A title", `filed: ${URL9}`] });
    expect(f.calls.map((c) => c.recorded)).toEqual([false]);
    expect(records(t)).toEqual([{ ref: "1.1.1", url: URL9, kind: "issue" }]);
    expect(filedFile(t.main, t.runId)).toBe(join(t.runDir, "filed.jsonl"));
    expect(statSync(filedFile(t.main, t.runId)).mode & 0o777).toBe(0o600);
    // A comment on a run named alone: no candidate, appended after the first.
    const c = filing(t, `${COMMENT}\n`);
    expect((await scrub(t.main, { run: t.runId, title: "A title", bodyFile: c.body, comment: 9 }, { env: ENV, runner: c.runner })).out.at(-1)).toBe(`commented: ${COMMENT}`);
    expect(records(t)).toEqual([
      { ref: "1.1.1", url: URL9, kind: "issue" },
      { ref: null, url: COMMENT, kind: "comment" },
    ]);
  });

  it("nothing is recorded when nothing was filed", async () => {
    const t = cycle();
    // gh printed no issue URL.
    const failed = filing(t, "", 1);
    expect((await scrub(t.main, { run: t.runId, title: "A title", bodyFile: failed.body, create: true }, { env: ENV, runner: failed.runner })).code).toBe(2);
    // A secret in the body: refused before gh.
    const held = filing(t, `${URL9}\n`);
    writeFileSync(held.body, `see ${t.s.cookie}\n`);
    expect(await scrub(t.main, { run: t.runId, title: "A title", bodyFile: held.body, create: true }, { env: ENV, runner: held.runner })).toEqual({
      code: 1,
      out: ["body 1:5 cookie", "refused: scrub: 1 secret(s) in the issue; nothing is filed"],
    });
    expect(held.calls).toEqual([]);
    // A check only (neither --create nor --comment): gh never runs.
    const check = filing(t, `${URL9}\n`);
    expect((await scrub(t.main, { run: t.runId, title: "A title", bodyFile: check.body }, { env: ENV, runner: check.runner })).code).toBe(0);
    expect(check.calls).toEqual([]);
    expect(existsSync(filedFile(t.main, t.runId))).toBe(false);
  });
});
