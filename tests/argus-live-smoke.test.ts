// tests/argus-live-smoke.test.ts — phase 6's shared surfaces (spec §19): live.json's smoke keys, the
// `.argus/smoke.json` schema and its defaults, and the CLI's dispatch of every new verb (each answers
// through its lane's function).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FIXTURE_CONTRACT } from "./fixture-contract";
import { ARGUS_LIVE, cleanTemps, committed, example, git, liveRun } from "./helpers/argus-live";
// @ts-expect-error — plain ESM script without types
import { pw } from "../plugins/sapu/scripts/argus-live-pw.mjs";
// @ts-expect-error — plain ESM script without types
import { reproRef } from "../plugins/sapu/scripts/argus-live-repro.mjs";
// @ts-expect-error — plain ESM script without types
import { validateReturn } from "../plugins/sapu/scripts/argus-live-return.mjs";
// @ts-expect-error — plain ESM script without types
import { down, readRun, writeRunFiles } from "../plugins/sapu/scripts/argus-live-run.mjs";
// @ts-expect-error — plain ESM script without types
import { handoffSlot, mintSlot } from "../plugins/sapu/scripts/argus-live-slots.mjs";
// @ts-expect-error — plain ESM script without types
import { seededOrder, smokeRun } from "../plugins/sapu/scripts/argus-live-smoke.mjs";
// @ts-expect-error — plain ESM script without types
import { parseRepro, pathChecks, suiteAccounts } from "../plugins/sapu/scripts/argus-live-steps.mjs";
// @ts-expect-error — plain ESM script without types
import { validateLive } from "../plugins/sapu/scripts/argus-live-config.mjs";
// @ts-expect-error — plain ESM script without types
import { loadSmoke, PERF_METRICS, SMOKE_BROWSERS, SMOKE_DEFAULTS, SMOKE_FILE, SMOKE_KEYS, validateSmoke } from "../plugins/sapu/scripts/argus-live-smokecfg.mjs";

type Obj = Record<string, any>;

afterEach(cleanTemps);

describe("live.json — the smoke suite's keys", () => {
  const errs = (patch: Obj) => validateLive({ ...example(), ...patch }) as string[];

  it("takes test_id_attribute, pseudo_locales, tokens and a trigger's seed", () => {
    expect(errs({ test_id_attribute: "data-testid" })).toEqual([]);
    expect(errs({ test_id_attribute: "data-qa-id" })).toEqual([]);
    expect(errs({ pseudo_locales: ["en-XA", "ar-XB"] })).toEqual([]);
    expect(errs({ tokens: { css: "src/styles/tokens.css" } })).toEqual([]);
    expect(errs({ tokens: { json: "design/tokens.json" } })).toEqual([]);
    const triggers = { "payment-settles": { ...example().triggers["payment-settles"], seed: true }, expire: { argv: ["npm", "run", "expire"], seed: false } };
    expect(errs({ triggers })).toEqual([]);
  });

  it("refuses a test_id_attribute that is not an attribute name", () => {
    for (const v of ["Data-testid", "1data", "data testid", "data_testid", "", `d${"a".repeat(64)}`, 7, null]) {
      expect(errs({ test_id_attribute: v }), String(v)).toEqual([expect.stringMatching(/^test_id_attribute must match/)]);
    }
  });

  it("refuses a pseudo-locale code Intl refuses", () => {
    expect(errs({ pseudo_locales: ["en-XA", "not a locale"] })).toEqual(["pseudo_locales must be BCP 47 language tags such as en-XA: not a locale"]);
    expect(errs({ pseudo_locales: "en-XA" })).toEqual(["pseudo_locales must be an array of strings"]);
  });

  it("refuses tokens with both keys, neither, an absolute path or ..", () => {
    const bad = [{ css: "a.css", json: "b.json" }, {}, { css: "/etc/tokens.css" }, { json: "../tokens.json" }, { css: "a/../../b.css" }, { css: "-x.css" }, { css: ":x.css" }, { css: "a\\b.css" }, { yaml: "t.yml" }, { css: 3 }, "tokens.css", null];
    for (const tokens of bad) expect(errs({ tokens }), JSON.stringify(tokens)).toEqual([expect.stringMatching(/^tokens must be \{"css": <file>\} or \{"json": <file>\}/)]);
  });

  it("refuses a seed that is not a boolean, and a seed on facts or mail", () => {
    expect(errs({ triggers: { t: { argv: ["x"], seed: "yes" } } })).toEqual(["triggers.t.seed must be true or false"]);
    expect(errs({ facts: { ...example().facts, seed: true } })).toEqual(['facts: unknown key "seed"']);
    expect(errs({ mail: { ...example().mail, seed: true } })).toEqual(['mail: unknown key "seed"']);
  });
});

describe("smoke.json — the suite's schema", () => {
  it("an empty object takes every default", () => {
    const { value, errors } = validateSmoke({});
    expect(errors).toEqual([]);
    expect(value).toEqual(SMOKE_DEFAULTS);
    expect(value).toMatchObject({ dir: "e2e/argus-smoke", max: 20, pin: [], exclude: [], browsers: ["chromium", "firefox", "webkit", "msedge"], workers: null, heal_max_steps: 3, form_cases_max: 6, link_cap: 50 });
    expect(value.perf).toEqual({ runs: 5, thresholds: { lcp_ms: [0.2, 250], inp_ms: [0.25, 50], cls: [0.25, 0.05], duration_ms: [0.2, 500], requests: [0.2, 5], bytes: [0.2, 102400] } });
    expect(value.ci).toEqual({ web_server: [], ports: {}, workflow: "argus-smoke.yml", artifact: "argus-smoke-results" });
    expect(SMOKE_BROWSERS).toEqual(["chromium", "firefox", "webkit", "msedge"]);
    expect(PERF_METRICS).toEqual(["lcp_ms", "inp_ms", "cls", "duration_ms", "requests", "bytes"]);
    expect(SMOKE_FILE).toBe(".argus/smoke.json");
    for (const list of [SMOKE_KEYS, SMOKE_BROWSERS, PERF_METRICS]) expect(Object.isFrozen(list)).toBe(true);
    // A default is never shared: changing a value leaves the next one whole.
    value.pin.push("x");
    value.perf.thresholds.cls[0] = 9;
    expect(validateSmoke({}).value).toEqual(SMOKE_DEFAULTS);
    expect(SMOKE_DEFAULTS.perf.thresholds.cls).toEqual([0.25, 0.05]);
  });

  it("names every key the spec lists, and refuses an unknown one at every level", () => {
    expect([...SMOKE_KEYS]).toEqual(["dir", "max", "pin", "exclude", "browsers", "journeys", "masks", "workers", "ci", "perf", "heal_max_steps", "form_cases_max", "link_cap"]);
    expect(validateSmoke({ maxx: 3 }).errors).toEqual(['.argus/smoke.json: unknown key "maxx"']);
    expect(validateSmoke({ ci: { webserver: [] } }).errors).toEqual(['ci: unknown key "webserver"']);
    expect(validateSmoke({ perf: { run: 3 } }).errors).toEqual(['perf: unknown key "run"']);
    expect(validateSmoke({ journeys: { checkout: { screen: [1] } } }).errors).toEqual(['journeys.checkout: unknown key "screen"']);
    expect(validateSmoke({ ci: { web_server: [{ command: "npm start", url: "http://localhost:3000", wait: 3 }] } }).errors).toEqual(['ci.web_server[0]: unknown key "wait"']);
    expect(validateSmoke({ journeys: { checkout: { allow: [{ check: "covered", key: "button Pay", why: "x" }] } } }).errors).toEqual(['journeys.checkout.allow[0]: unknown key "why"']);
    expect(validateSmoke([]).errors).toEqual([".argus/smoke.json must be a JSON object"]);
    expect(validateSmoke({ maxx: 3 }).value).toBeNull();
  });

  it("caps max at 50 and keeps every integer in its range", () => {
    expect(validateSmoke({ max: 50 }).value.max).toBe(50);
    expect(validateSmoke({ max: 51 }).errors).toEqual(["max must be an integer from 1 to 50"]);
    expect(validateSmoke({ max: 0 }).errors).toEqual(["max must be an integer from 1 to 50"]);
    expect(validateSmoke({ max: 2.5 }).errors).toEqual(["max must be an integer from 1 to 50"]);
    expect(validateSmoke({ heal_max_steps: 11 }).errors).toEqual(["heal_max_steps must be an integer from 1 to 10"]);
    expect(validateSmoke({ form_cases_max: 51 }).errors).toEqual(["form_cases_max must be an integer from 0 to 50"]);
    expect(validateSmoke({ link_cap: -1 }).errors).toEqual(["link_cap must be an integer from 0 to 500"]);
    expect(validateSmoke({ perf: { runs: 0 } }).errors).toEqual(["perf.runs must be an integer from 1 to 20"]);
    expect(validateSmoke({ heal_max_steps: 1, form_cases_max: 0, link_cap: 0, perf: { runs: 20 } }).errors).toEqual([]);
  });

  it("workers: unset, a count or a percentage", () => {
    expect(validateSmoke({ workers: 4 }).value.workers).toBe(4);
    expect(validateSmoke({ workers: "50%" }).value.workers).toBe("50%");
    for (const w of [0, 65, "0%", "101%", "4", 1.5]) expect(validateSmoke({ workers: w }).errors, String(w)).toEqual(['workers must be an integer from 1 to 64 or a percentage such as "50%"']);
  });

  it("dir: a repo-relative directory outside .git and .argus", () => {
    expect(validateSmoke({ dir: "test/e2e/smoke" }).value.dir).toBe("test/e2e/smoke");
    for (const dir of ["/abs", "../x", "a/../b", ".", "", "a//b", "a/./b", "-x", ":x", "a\\b", ".git/x", ".argus/smoke", ".GIT", 3]) {
      expect(validateSmoke({ dir }).errors, String(dir)).toEqual(["dir must be a repo-relative directory (no absolute path, no . or .., no leading - or :, not under .git or .argus)"]);
    }
  });

  it("pin and exclude: journey ids, a pin of an unknown id kept for smoke plan to refuse", () => {
    const { value, errors } = validateSmoke({ pin: ["checkout", "not-in-the-catalog"], exclude: ["admin-export"] });
    expect(errors).toEqual([]);
    expect(value.pin).toEqual(["checkout", "not-in-the-catalog"]);
    expect(value.exclude).toEqual(["admin-export"]);
    expect(validateSmoke({ pin: ["Checkout"] }).errors).toEqual(["pin must be an array of distinct journey ids (kebab-case)"]);
    expect(validateSmoke({ exclude: ["a", "a"] }).errors).toEqual(["exclude must be an array of distinct journey ids (kebab-case)"]);
    expect(validateSmoke({ pin: ["a", "b"], exclude: ["b"] }).errors).toEqual(["pin and exclude both name b"]);
  });

  it("browsers: a non-empty subset of the four, per journey too", () => {
    expect(validateSmoke({ browsers: ["chromium", "webkit"] }).value.browsers).toEqual(["chromium", "webkit"]);
    for (const b of [[], ["safari"], ["chromium", "chromium"], "chromium"]) expect(validateSmoke({ browsers: b }).errors, JSON.stringify(b)).toEqual(["browsers must be a non-empty array of distinct names from chromium, firefox, webkit, msedge"]);
    expect(validateSmoke({ journeys: { checkout: { browsers: ["edge"] } } }).errors).toEqual(["journeys.checkout.browsers must be a non-empty array of distinct names from chromium, firefox, webkit, msedge"]);
    expect(validateSmoke({ journeys: { checkout: { viewports: [1440, 390] } } }).errors).toEqual([]);
    for (const v of [[], [100], [1440, 1440], "1440"]) expect(validateSmoke({ journeys: { checkout: { viewports: v } } }).errors, JSON.stringify(v)).toEqual(["journeys.checkout.viewports must be a non-empty array of distinct widths from 200 to 4000"]);
  });

  it("journeys: kebab-case ids, masks as locators, screens as step numbers, allow as {check, key}", () => {
    const ok = { checkout: { browsers: ["chromium"], masks: ["getByTestId('clock')"], screens: [2, 5], allow: [{ check: "target-size", key: "link Help" }] } };
    expect(validateSmoke({ journeys: ok, masks: ["getByRole('status')"] })).toEqual({ value: expect.objectContaining({ journeys: ok, masks: ["getByRole('status')"] }), errors: [] });
    expect(validateSmoke({ journeys: { Checkout: {} } }).errors).toEqual(["journeys: Checkout is not a journey id (kebab-case)"]);
    expect(validateSmoke({ masks: [".clock"] }).errors).toEqual(["masks[0] must be a Playwright locator such as getByTestId('clock')"]);
    expect(validateSmoke({ masks: ["e12"] }).errors).toEqual(["masks[0] must be a Playwright locator such as getByTestId('clock')"]);
    expect(validateSmoke({ journeys: { checkout: { masks: ["getByRole("] } } }).errors).toEqual(["journeys.checkout.masks[0] must be a Playwright locator such as getByTestId('clock')"]);
    expect(validateSmoke({ journeys: { checkout: { screens: [0] } } }).errors).toEqual(["journeys.checkout.screens must be an array of distinct step numbers from 1 to 500"]);
    expect(validateSmoke({ journeys: { checkout: { allow: [{ check: "Covered", key: "x" }] } } }).errors).toEqual(["journeys.checkout.allow[0] must be {check, key}: check a check's name, key a non-empty string of at most 200 characters"]);
  });

  it("ci: loopback web servers, named ports, a workflow file and an artifact name", () => {
    const ci = { web_server: [{ command: "npm run start:ci", url: "http://localhost:3000/health", timeout_s: 120 }, { command: "npm run api", url: "http://127.0.0.1:4000" }, { command: "x", url: "https://[::1]:8443/" }], ports: { web: 3000, api: 4000 }, workflow: "smoke.yaml", artifact: "smoke-results" };
    expect(validateSmoke({ ci }).value.ci).toEqual(ci);
    expect(validateSmoke({ ci: { workflow: "e2e.yml" } }).value.ci).toEqual({ web_server: [], ports: {}, workflow: "e2e.yml", artifact: "argus-smoke-results" });
    for (const url of ["http://example.test", "http://10.0.0.1:3000", "http://app.localhost.example.test", "ftp://localhost/", "localhost:3000", "http://localhost:{port:web}"]) {
      expect(validateSmoke({ ci: { web_server: [{ command: "npm start", url }] } }).errors, url).toEqual([`ci.web_server[0].url must be an http(s) URL on a loopback host (localhost, 127.0.0.1, [::1]): ${url}`]);
    }
    expect(validateSmoke({ ci: { web_server: [] } }).errors).toEqual(["ci.web_server must be a non-empty array of {command, url, timeout_s?}"]);
    expect(validateSmoke({ ci: { web_server: [{ url: "http://localhost:1" }] } }).errors).toEqual(["ci.web_server[0].command must be a non-empty string"]);
    expect(validateSmoke({ ci: { web_server: [{ command: "x", url: "http://localhost:1", timeout_s: 0 }] } }).errors).toEqual(["ci.web_server[0].timeout_s must be an integer from 1 to 3600"]);
    expect(validateSmoke({ ci: { ports: { Web: 3000 } } }).errors).toEqual(["ci.ports must map port names ([a-z][a-z0-9_-]*) to ports 1-65535"]);
    expect(validateSmoke({ ci: { ports: { web: 70000 } } }).errors).toEqual(["ci.ports must map port names ([a-z][a-z0-9_-]*) to ports 1-65535"]);
    expect(validateSmoke({ ci: { workflow: "../x.yml" } }).errors).toEqual(["ci.workflow must be a file name ending .yml or .yaml"]);
    expect(validateSmoke({ ci: { artifact: "a b" } }).errors).toEqual(["ci.artifact must be a name of letters, digits, ., _ and - (at most 100)"]);
  });

  it("perf: thresholds per metric, merged over the defaults", () => {
    const { value } = validateSmoke({ perf: { runs: 7, thresholds: { lcp_ms: [0.1, 100] } } });
    expect(value.perf).toEqual({ runs: 7, thresholds: { ...SMOKE_DEFAULTS.perf.thresholds, lcp_ms: [0.1, 100] } });
    expect(validateSmoke({ perf: { thresholds: { fcp_ms: [0.1, 1] } } }).errors).toEqual(['perf.thresholds: unknown key "fcp_ms"']);
    for (const t of [[0.1], [-0.1, 1], [0.1, -1], [11, 1], ["0.1", 1], [0.1, Infinity]]) {
      expect(validateSmoke({ perf: { thresholds: { cls: t } } }).errors, JSON.stringify(t)).toEqual(["perf.thresholds.cls must be [<relative 0-10>, <absolute >= 0>]"]);
    }
  });

  it("loadSmoke: missing, unreadable, invalid or valid", () => {
    const main = committed();
    expect(loadSmoke(main)).toEqual({ smoke: null, errors: [], missing: true });
    mkdirSync(join(main, ".argus"), { recursive: true });
    writeFileSync(join(main, ".argus/smoke.json"), "{");
    expect(loadSmoke(main)).toEqual({ smoke: null, errors: [expect.stringMatching(/^\.argus\/smoke\.json is not valid JSON: /)], missing: false });
    writeFileSync(join(main, ".argus/smoke.json"), JSON.stringify({ max: 99 }));
    expect(loadSmoke(main)).toEqual({ smoke: null, errors: ["max must be an integer from 1 to 50"], missing: false });
    writeFileSync(join(main, ".argus/smoke.json"), JSON.stringify({ max: 5 }));
    expect(loadSmoke(main)).toEqual({ smoke: { ...SMOKE_DEFAULTS, max: 5 }, errors: [], missing: false });
  });
});

describe("argus-live CLI — phase 6's verbs", () => {
  const cli = (main: string, ...args: string[]) => spawnSync(process.execPath, [ARGUS_LIVE, ...args], { cwd: main, encoding: "utf8" });
  /** A repo whose committed contract has `policy` (null: no contract at all). */
  const repo = (policy: Obj | null = {}) => {
    const main = committed();
    if (policy) {
      mkdirSync(join(main, ".claude"), { recursive: true });
      writeFileSync(join(main, ".claude/sapu.json"), JSON.stringify({ ...FIXTURE_CONTRACT, ...(Object.keys(policy).length ? { policy } : {}) }));
      git(main, "add", ".");
      git(main, "-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", "commit", "-qm", "contract");
    }
    return main;
  };
  /** Every verb phase 6 added, each built now, with its answer in a repo with a contract but no cycle, suite or run. */
  const NO_SUITE = "refused: smoke ci: the suite has no paths (e2e/argus-smoke/journeys)\n";
  const CHECK = "smoke check: no suite (e2e/argus-smoke/journeys holds no path)\n";
  const VERBS: [string[], string][] = [
    [["smoke", "plan"], "refused: smoke plan: no journey catalog (.argus/journeys.json): run map-check first\n"],
    [["smoke", "admit", "2.1"], "refused: no journey cycle is running\n"],
    [["smoke", "heal", "2.1"], "refused: no journey cycle is running\n"],
    [["smoke", "ci"], NO_SUITE],
    [["smoke", "ci", "--run", "123456"], NO_SUITE],
    [["smoke", "baseline", "--from-run", "123456"], NO_SUITE.replace("smoke ci", "smoke baseline")],
    [["smoke", "baseline", "--from-run", "123456", "--ids", "checkout"], NO_SUITE.replace("smoke ci", "smoke baseline")],
    [["smoke", "workflow"], "refused: smoke workflow: no .argus/live.json\n"],
    [["smoke", "run", "--perf"], "refused: no journey cycle is running\n"],
    [["smoke", "perf", "--issue", "checkout"], "refused: smoke perf: checkout has no perf record\n"],
    [["smoke", "perf", "--rebaseline", "checkout"], "refused: smoke perf: checkout has no perf record\n"],
    [["smoke", "retire", "checkout"], "refused: smoke retire: the suite has no path checkout\n"],
    [["seed", "--issue", "12"], "refused: seed: no journey cycle is running (up --map or up first)\n"],
    [["seed", "--doc", "docs/flows.md:3-40"], "refused: seed: no journey cycle is running (up --map or up first)\n"],
    [["report"], "refused: report: no run here\n"],
    [["report", "--run", "r1"], "refused: report: --run takes a run id\n"],
  ];

  it("the usage line names every verb of spec §19.15", () => {
    const r = cli(committed(), "nonsense");
    expect(r.status).toBe(2);
    for (const alt of [
      " | smoke plan | ",
      " | smoke admit <slot>.<generation> | ",
      " | smoke run [--ids <id>,…] [--slot <n>] [--perf] [--seed <n>] | ",
      " | smoke heal <slot>.<generation> | ",
      " | smoke propose [--dry-run] | ",
      " | smoke check | ",
      " | smoke ci [--run <id>] | ",
      " | smoke baseline --from-run <id> [--ids …] [--known] | ",
      " | smoke perf (--issue|--rebaseline) <id> | ",
      " | smoke retire <id> | ",
      " | smoke workflow | ",
      " | seed (--issue <n>|--doc <file>:<a>-<b>) | ",
      " | report [--run <runId>]",
      " | slot <n> --map [--seed] | ",
    ]) expect(r.stderr, alt).toContain(alt);
  }, 30_000);

  it("each new verb reaches its lane's function: none is a stub any more", () => {
    const main = repo();
    for (const [args, answer] of VERBS) {
      const r = cli(main, ...args);
      expect(r.stderr, args.join(" ")).toBe(answer);
      expect(r.status, args.join(" ")).toBe(1);
      expect(r.stdout).toBe("");
    }
    // Propose with nothing staged and check with no suite answer on stdout, exit 0.
    for (const dry of [[], ["--dry-run"]]) expect(cli(main, "smoke", "propose", ...dry)).toMatchObject({ status: 0, stdout: "smoke propose: nothing to propose\n", stderr: "" });
    expect(cli(main, "smoke", "check")).toMatchObject({ status: 0, stdout: CHECK, stderr: "" });
    // The lane's own pass is built (Task 0.3): without a cycle it is refused as every runner is.
    expect(cli(main, "smoke", "run").stderr).toBe("refused: no journey cycle is running\n");
  }, 60_000);

  it("a committed suite needs the repo's own contract with visible traces: every smoke verb but check is refused otherwise", () => {
    const TRACE = "refused: smoke: a committed suite would leave a trace\n";
    for (const main of [repo(null), repo({ traces: "none" })]) {
      for (const [args, answer] of [...VERBS, [["smoke", "propose"], ""], [["smoke", "propose", "--dry-run"], ""]] as [string[], string][]) {
        const r = cli(main, ...args);
        expect(r.status, args.join(" ")).toBe(1);
        expect(r.stderr, args.join(" ")).toBe(args[0] === "smoke" ? TRACE : answer);
      }
      expect(cli(main, "smoke", "check")).toMatchObject({ status: 0, stdout: CHECK, stderr: "" });
    }
    const broken = repo();
    writeFileSync(join(broken, ".claude/sapu.json"), "{");
    git(broken, "add", ".");
    git(broken, "-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", "commit", "-qm", "broken");
    expect(cli(broken, "smoke", "plan").stderr).toMatch(/^refused: .*sapu\.json is not valid JSON/);
  }, 60_000);

  it("refuses a malformed line with the usage, before any lane runs", () => {
    const main = repo();
    for (const args of [
      ["smoke"],
      ["smoke", "nonsense"],
      ["smoke", "plan", "x"],
      ["smoke", "admit"],
      ["smoke", "admit", "2.1", "x"],
      ["smoke", "run", "--perf", "--perf"],
      ["smoke", "run", "--ids"],
      ["smoke", "run", "--ids", "Checkout"],
      ["smoke", "run", "--wat"],
      ["smoke", "propose", "--dry-run", "--dry-run"],
      ["smoke", "check", "--json"],
      ["smoke", "baseline"],
      ["smoke", "baseline", "--ids", "a"],
      ["smoke", "perf", "checkout"],
      ["smoke", "perf", "--issue"],
      ["smoke", "perf", "--issue", "a", "--rebaseline", "b"],
      ["smoke", "workflow", "x"],
      ["smoke", "retire"],
      ["smoke", "retire", "a", "b"],
      ["seed"],
      ["seed", "--issue", "1", "--doc", "a.md:1-2"],
      ["seed", "--issue", "x"],
      ["seed", "--issue", "0"],
      ["report", "--run"],
      ["report", "x"],
    ]) {
      const r = cli(main, ...args);
      expect(r.status, args.join(" ")).toBe(1);
      expect(r.stderr, args.join(" ")).toMatch(/^refused: usage: argus-live\.mjs /);
    }
    expect(cli(main, "smoke", "run", "--slot", "100").stderr).toBe("refused: a slot is a number from 1 to 99\n");
    expect(cli(main, "smoke", "run", "--seed", "4294967296").stderr).toBe("refused: a seed is an integer from 0 to 4294967295\n");
    expect(cli(main, "smoke", "run", "--seed", "-1").stderr).toBe("refused: a seed is an integer from 0 to 4294967295\n");
  }, 60_000);

  it("slot --map --seed is the seed lane's: it needs a cycle; --seed needs --map", () => {
    const main = repo();
    expect(cli(main, "slot", "1", "--map", "--seed").stderr).toBe("refused: no journey cycle is running\n");
    expect(cli(main, "slot", "1", "--seed").stderr).toMatch(/^refused: usage: /);
    expect(cli(main, "slot", "1", "--handoff", "--seed").stderr).toMatch(/^refused: usage: /);
  }, 30_000);
});

// ---------------------------------------------------------------------------------------------------
// Task 0.3: the DSL's path mode, the return's path and heal, the lane's smoke pass (spec §19.4, §19.9).

/** example()'s config with test ids and a seed trigger: what a smoke path may use. */
const pathLive = (): Obj => ({
  ...example(),
  test_id_attribute: "data-testid",
  triggers: { ...example().triggers, "seed-stock": { argv: ["npm", "run", "-s", "explore:seed", "--", "{1}"], args: ["^[A-Za-z0-9-]{1,64}$"], seed: true } },
});
const PATH_ACCOUNTS = { "customer.1": "buyer1@example.test", "customer.2": "buyer2@example.test", "sales.1": "sales1@example.test", "anon.1": null };
/** A path (spec §19.4): a leading seed trigger, actions by role, label and test id, the goal as the last expect. */
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

describe("the repro DSL's path mode (spec §19.4)", () => {
  const P = () => ({ accounts: PATH_ACCOUNTS, live: pathLive(), path: true });
  const refusal = (list: Obj[], opts: Obj = P()) => {
    try {
      parseRepro(list, opts);
    } catch (e) {
      return (e as Error).message;
    }
    return null;
  };
  const at = (n: number, step: Obj) => {
    const l = PATH();
    l[n] = step;
    return l;
  };

  it("takes a list ending in an expect with no final", () => {
    const { context, steps } = parseRepro(PATH(), P());
    expect(context).toEqual({ viewport: 1440, locale: "en-US", timezone: "UTC" });
    expect(steps).toHaveLength(9);
    expect(steps.at(-1)).toEqual({ n: 9, as: "sales.1", expect: "visible", target: { by: "text", value: "{{order}}" } });
    expect(steps.some((s: Obj) => s.final !== undefined)).toBe(false);
  });

  it("refuses a final anywhere, and a path that does not end with an expect", () => {
    expect(refusal([...PATH().slice(0, -1), { ...PATH().at(-1), final: "handoff" }])).toBe("refused: repro: step 9: a path has no final: it ends with an expect proving the journey's goal");
    expect(refusal(at(4, { as: "customer", expect: "visible", target: { label: "Quantity" }, final: "discoverability" }))).toBe("refused: repro: step 4: a path has no final: it ends with an expect proving the journey's goal");
    expect(refusal(PATH().slice(0, -1).concat([{ as: "sales", do: "goto", path: "/x" }]))).toBe("refused: repro: step 9: a path ends with an expect proving the journey's goal");
  });

  it("an action's target is a named role, a label, a placeholder or a test id: never text", () => {
    const ACTION_ONLY = "an action's target in a path is {role, name}, {label}, {placeholder} or {testId}";
    expect(refusal(at(5, { as: "customer", do: "click", target: { text: "Place order" } }))).toBe(`refused: repro: step 5: ${ACTION_ONLY}`);
    expect(refusal(at(5, { as: "customer", do: "click", target: { role: "button" } }))).toBe(`refused: repro: step 5: ${ACTION_ONLY}`);
    expect(refusal(at(5, { as: "customer", do: "click", target: { role: "button", name: "Place order", within: { text: "Basket" } } }))).toBe(`refused: repro: step 5: ${ACTION_ONLY}`);
    expect(refusal(at(4, { as: "customer", do: "fill", target: { placeholder: "How many" }, value: "2" }))).toBeNull();
    expect(refusal(at(5, { as: "customer", do: "click", target: { role: "button", name: "Place order", within: { role: "form", name: "Basket" } } }))).toBeNull();
    // An expectation may read text.
    expect(refusal(PATH())).toBeNull();
  });

  it("refuses a testId without live.json's test_id_attribute, in an action or an expectation", () => {
    const live = { ...pathLive() };
    delete live.test_id_attribute;
    expect(refusal(PATH(), { ...P(), live })).toBe("refused: repro: step 6: a testId target needs live.json's test_id_attribute");
    const exp = at(7, { as: "customer", expect: "visible", target: { testId: "order-number" } });
    exp[6] = { as: "customer", do: "read", target: { label: "Order" }, save: "order" };
    expect(refusal(exp, { ...P(), live })).toBe("refused: repro: step 7: a testId target needs live.json's test_id_attribute");
  });

  it("within nests one level, never two", () => {
    const twice = { role: "button", name: "Place order", within: { role: "form", name: "Basket", within: { role: "main", name: "Shop" } } };
    expect(refusal(at(5, { as: "customer", do: "click", target: twice }))).toBe("refused: repro: step 5: within nests at most one level in a path");
    expect(refusal(at(7, { as: "customer", expect: "visible", target: { text: "x", within: { label: "a", within: { label: "b" } } } }))).toBe("refused: repro: step 7: within nests at most one level in a path");
  });

  it("a trigger leads the path and is a seed trigger", () => {
    const TRIGGER = "a path's trigger leads it and is marked seed: true in live.triggers";
    expect(refusal(at(1, { as: "system", do: "trigger", name: "payment-settles", values: ["{{marker}}"] }))).toBe(`refused: repro: step 1: ${TRIGGER}`);
    const late = PATH();
    late.splice(8, 0, { as: "system", do: "trigger", name: "seed-stock", values: ["{{order}}"] }, { as: "sales", expect: "visible", target: { text: "{{order}}" } });
    expect(refusal(late)).toBe(`refused: repro: step 8: ${TRIGGER}`);
    // Two leading seed triggers, each proven.
    const two = PATH();
    two.splice(3, 0, { as: "system", do: "trigger", name: "seed-stock", values: ["second"] }, { as: "system", expect: "fact-equals", marker: "second", field: "stock", value: "5" });
    expect(refusal(two)).toBeNull();
  });

  it("keeps every rule of §10", () => {
    expect(refusal(at(5, { as: "customer", do: "click", target: { role: "button", name: "Place order" }, wait: 3 }))).toBe('refused: repro: step 5: unknown key "wait"');
    expect(refusal(at(4, { as: "customer", do: "select", target: { label: "Quantity" }, value: "2" }))).toBe("refused: repro: step 4: select changes state: an expect as customer.1 must follow before its next action");
    expect(refusal(at(4, { as: "customer", do: "fill", target: { label: "Quantity" }, value: "{{later}}" }))).toBe("refused: repro: step 4: {{later}} is used before a read saves it");
    expect(refusal(at(3, { as: "nobody", do: "goto", path: "/orders/new" }))).toBe("refused: repro: step 3: nobody is not allocated to this slot");
    expect(refusal(at(5, { as: "customer", do: "click", target: { css: "#place" } }))).toBe("refused: repro: step 5: a target names one of role, label, text, placeholder, testId");
  });

  it("candidate mode is unchanged: a text action target and a final are still its own", () => {
    const list = [...PATH().slice(0, -1), { ...PATH().at(-1), final: "handoff" }];
    list[5] = { as: "customer", do: "click", target: { text: "Place order" } };
    expect(refusal(list, { accounts: PATH_ACCOUNTS, live: pathLive() })).toBeNull();
  });

  it("suiteAccounts: a role's k-th user is <role>.<k>, a login-command role and anon are .1", () => {
    expect(suiteAccounts(example())).toEqual({ "anon.1": null, "customer.1": "buyer1@example.test", "customer.2": "buyer2@example.test", "sales.1": "sales1@example.test", "admin.1": null });
  });
});

describe("the explorer's return: path and heal (spec §19.4, §19.9)", () => {
  const checks = pathChecks({ accounts: PATH_ACCOUNTS, live: pathLive(), healMax: 3 });
  const opts = { journey: "j1", accounts: PATH_ACCOUNTS, outFiles: [], checks: () => checks };
  const ret = (extra: Obj) => ({ journey: "j1", status: "done", ...extra });

  it("takes a path parsed in path mode against the slot's accounts, kept as the explorer wrote it", () => {
    const { value, errors } = validateReturn(ret({ path: PATH() }), opts);
    expect(errors).toEqual([]);
    expect(value.path).toEqual(PATH());
    expect(validateReturn(ret({}), opts).value.path).toBeUndefined();
  });

  it("refuses a path the path mode refuses, naming the step", () => {
    const bad = [...PATH().slice(0, -1), { ...PATH().at(-1), final: "handoff" }];
    expect(validateReturn(ret({ path: bad }), opts).errors).toEqual(["path: step 9: a path has no final: it ends with an expect proving the journey's goal"]);
    expect(validateReturn(ret({ path: "x" }), opts).errors).toEqual(["path must be an array"]);
    expect(validateReturn(ret({ path: [{ as: "customer", do: "goto", path: "/", deep: [[[[[[[[["x"]]]]]]]]] }] }), opts).errors).toEqual(["path[0].deep[0][0][0][0][0][0][0] nests deeper than 8 levels"]);
  });

  it("a path or a heal is refused where it cannot be checked", () => {
    const none = { journey: "j1", accounts: PATH_ACCOUNTS, outFiles: [] };
    expect(validateReturn(ret({ path: PATH() }), none).errors).toEqual(["path: cannot be checked (.argus/live.json or .argus/smoke.json is not readable)"]);
    expect(validateReturn(ret({ heal: [], heal_reason: "blocked" }), { ...none, checks: () => null }).errors).toEqual(["heal: cannot be checked (.argus/live.json or .argus/smoke.json is not readable)"]);
    // A return with neither never reads the checks: a bad live.json blocks no other return.
    expect(validateReturn(ret({}), { ...none, checks: () => { throw new Error("never read"); } }).errors).toEqual([]);
  });

  it("takes a heal: each step's new target as a locator, parsed into the path's own target form", () => {
    const { value, errors } = validateReturn(ret({ heal: [{ step: 5, target: "getByRole('button', { name: 'Submit order' })" }, { step: 4, target: "getByLabel('Amount', { exact: true })" }] }), opts);
    expect(errors).toEqual([]);
    expect(value.heal).toEqual([{ step: 5, target: { role: "button", name: "Submit order" } }, { step: 4, target: { label: "Amount", exact: true } }]);
    expect(validateReturn(ret({ heal: [{ step: 5, target: "getByRole('form', { name: 'Basket' }).getByRole('button', { name: 'Go' }).first()" }] }), opts).value.heal).toEqual([{ step: 5, target: { role: "button", name: "Go", nth: 0, within: { role: "form", name: "Basket" } } }]);
  });

  it("refuses a heal past heal_max_steps, a step twice or out of range, and a target of another kind", () => {
    const h = (step: number, target = "getByLabel('x')") => ({ step, target });
    expect(validateReturn(ret({ heal: [h(1), h(2), h(3), h(4)] }), opts).errors).toEqual(["heal holds at most 3 entries"]);
    expect(validateReturn(ret({ heal: [h(2), h(2)] }), opts).errors).toEqual(["heal[1].step names step 2 twice"]);
    for (const step of [0, 101, 1.5, "2"]) expect(validateReturn(ret({ heal: [{ step, target: "getByLabel('x')" }] }), opts).errors, String(step)).toEqual(["heal[0].step must be a step number from 1 to 100"]);
    for (const target of ["getByText('Pay')", "locator('#pay')", "getByTitle('Pay')", "e15", "getByRole('button')", "getByTestId('pay').getByLabel('a').getByLabel('b')", "page.goto('/')", 7]) {
      expect(validateReturn(ret({ heal: [{ step: 2, target }] }), opts).errors[0], String(target)).toMatch(/^heal\[0\]\.target: /);
    }
    expect(validateReturn(ret({ heal: [{ step: 2, target: "getByLabel('x')", why: "moved" }] }), opts).errors).toEqual(['heal[0]: unknown key "why"']);
  });

  it("an empty heal names its reason: no-control, blocked or harness", () => {
    for (const heal_reason of ["no-control", "blocked", "harness"]) expect(validateReturn(ret({ heal: [], heal_reason }), opts).errors, heal_reason).toEqual([]);
    expect(validateReturn(ret({ heal: [] }), opts).errors).toEqual(["heal: [] needs heal_reason (no-control, blocked or harness)"]);
    expect(validateReturn(ret({ heal: [], heal_reason: "gave-up" }), opts).errors).toEqual(["heal_reason must be one of no-control, blocked, harness"]);
    expect(validateReturn(ret({ heal: [{ step: 2, target: "getByLabel('x')" }], heal_reason: "blocked" }), opts).errors).toEqual(["heal_reason goes only with heal: []"]);
    expect(validateReturn(ret({ heal_reason: "blocked" }), opts).errors).toEqual(["heal_reason goes only with heal: []"]);
  });
});

describe("smoke run — the lane's pass over the suite's paths (spec §19.5, §19.9)", () => {
  const runs: { main: string; runId: string }[] = [];
  afterEach(async () => {
    for (const r of runs.splice(0)) await down(r.main, { runId: r.runId, graceMs: 1000 }).catch(() => {});
  });
  /** A live cycle (lock, run.json with an instance) whose repo holds the suite's `paths` as `<dir>/journeys/<id>.json`. */
  const suiteRun = (paths: Record<string, Obj[]>, { slots = {} as Obj } = {}) => {
    const t = liveRun();
    writeFileSync(join(t.main, ".argus/live.json"), `${JSON.stringify(pathLive(), null, 2)}\n`);
    writeFileSync(join(t.main, ".argus/live.env"), "PW=pw-1\nSALES_TOTP=GEZDGNBVGY3TQOJQ\nDB_PW=db-now\n");
    const ports = { api: 41001, web: 41002, pg: 41003, redis: 41004, smtp: 41005 };
    writeRunFiles(t.main, { runId: t.runId, worktree: t.wt, home: t.home, origins: ["http://localhost:41002"], allowOrigins: [], groups: [], env: t.env, ports, instanceId: "0123456789abcdef", slots, internal: { proxy: 41009 }, browser: { channel: "chrome" } });
    runs.push({ main: t.main, runId: t.runId });
    const dir = join(t.main, "e2e/argus-smoke/journeys");
    mkdirSync(dir, { recursive: true });
    for (const [id, path] of Object.entries(paths)) writeFileSync(join(dir, `${id}.json`), `${JSON.stringify({ journey: id, path, admitted: { run: "r", head: "0".repeat(40), pathSha: "1".repeat(64), seed: 1 } }, null, 2)}\n`);
    return t;
  };
  /** A runOnce stand-in: each path id's exits in turn (default 0), recording what each call was given. */
  const stub = (exits: Record<string, number[]> = {}, broke = { step: 7, kind: "expect-failed" }) => {
    const calls: Obj[] = [];
    const once = async (_main: string, ref: string | null, opts: Obj) => {
      calls.push({ ref, ...opts });
      const id = opts.path.id;
      const k = calls.filter((c) => c.path.id === id).length;
      const code = (exits[id] ?? [])[k - 1] ?? 0;
      const last = code === 0 ? "PATH held" : code === 3 ? `PATH broke step=${broke.step} kind=${broke.kind}` : "HARNESS: step 2 system trigger exited 1";
      return { code, lines: [opts.dirty ? "dirty: instance 0123456789abcdef" : "fresh: instance 0123456789abcdef", last], result: { exit: code, step: code === 3 ? broke.step : null, kind: code === 3 ? broke.kind : null } };
    };
    return { once, calls };
  };
  const THREE = () => ({ checkout: PATH(), refund: PATH(), returns: PATH() });

  it("seededOrder is a permutation fixed by its seed", () => {
    const ids = ["a", "b", "c", "d", "e"];
    expect([...seededOrder(ids, 7)].sort()).toEqual(ids);
    expect(seededOrder(ids, 7)).toEqual(seededOrder(ids, 7));
    expect(new Set(Array.from({ length: 20 }, (_, i) => seededOrder(ids, i).join(","))).size).toBeGreaterThan(1);
    expect(ids).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("runs every path once, dirty, in the order the seed shuffles, and prints the seed", async () => {
    const t = suiteRun(THREE());
    const s = stub();
    const r = await smokeRun(t.main, { ids: null, slot: null, perf: false, seed: 11 }, { once: s.once });
    expect(r.code).toBe(0);
    const order = seededOrder(["checkout", "refund", "returns"], 11);
    expect(s.calls.map((c) => c.path.id)).toEqual(order);
    for (const c of s.calls) expect(c).toMatchObject({ ref: null, dirty: true });
    expect(s.calls[0].path.list).toEqual(PATH());
    expect(r.lines).toEqual(["seed: 11", ...order.map((id: string) => `path ${id}: held`), "smoke run: 3 held, 0 broke, 0 flaky, 0 harness"]);
    // Without a seed one is drawn, printed and used.
    const u = stub();
    const d = await smokeRun(t.main, { ids: null, slot: null, perf: false, seed: null }, { once: u.once });
    const seed = Number(/^seed: (\d+)$/.exec(d.lines[0])![1]);
    expect(seed).toBeLessThanOrEqual(4294967295);
    expect(u.calls.map((c) => c.path.id)).toEqual(seededOrder(["checkout", "refund", "returns"], seed));
    // --ids runs only those.
    const v = stub();
    await smokeRun(t.main, { ids: ["refund"], slot: null, perf: false, seed: 1 }, { once: v.once });
    expect(v.calls.map((c) => c.path.id)).toEqual(["refund"]);
  });

  it("a break is confirmed after up --fresh: broke at two of two, else flaky", async () => {
    const t = suiteRun(THREE());
    const s = stub({ refund: [3, 3], returns: [3, 0] });
    const r = await smokeRun(t.main, { ids: null, slot: null, perf: false, seed: 3 }, { once: s.once });
    expect(r.code).toBe(3);
    expect(r.lines).toContain("path refund: broke step=7 kind=expect-failed");
    expect(r.lines).toContain("path returns: flaky step=7 kind=expect-failed");
    expect(r.lines.at(-1)).toBe("smoke run: 1 held, 1 broke, 1 flaky, 0 harness");
    const of = (id: string) => s.calls.filter((c) => c.path.id === id).map((c) => c.dirty);
    expect(of("refund")).toEqual([true, false]);
    expect(of("returns")).toEqual([true, false]);
    expect(of("checkout")).toEqual([true]);
    // Each verdict is recorded for the cycle's report.
    const file = join(t.main, ".argus/live", t.runId, "smoke", "pass.jsonl");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const recs = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(recs).toContainEqual({ id: "refund", verdict: "broke", step: 7, kind: "expect-failed", seed: 3 });
    expect(recs).toContainEqual({ id: "returns", verdict: "flaky", step: 7, kind: "expect-failed", seed: 3 });
    expect(recs).toContainEqual({ id: "checkout", verdict: "held", step: null, kind: null, seed: 3 });
  });

  it("a harness failure is the harness's, never a break", async () => {
    const t = suiteRun(THREE());
    const r = await smokeRun(t.main, { ids: ["checkout"], slot: null, perf: false, seed: 1 }, { once: stub({ checkout: [2] }).once });
    expect(r.code).toBe(2);
    expect(r.lines).toEqual(["seed: 1", "path checkout: harness: step 2 system trigger exited 1", "smoke run: 0 held, 0 broke, 0 flaky, 1 harness"]);
  });

  it("a quarantined path runs twice a cycle, each run judged and recorded, so its quarantine can count two holds", async () => {
    const t = suiteRun(THREE());
    writeFileSync(join(t.main, "e2e/argus-smoke/quarantine.json"), JSON.stringify([{ id: "refund", issue: null, since: "100" }]));
    const s = stub({ refund: [0, 3, 0] });
    const r = await smokeRun(t.main, { ids: null, slot: null, perf: false, seed: 3 }, { once: s.once });
    expect(r.lines[1]).toBe("quarantined refund: run twice");
    expect(r.lines.filter((l: string) => l.startsWith("path refund: "))).toEqual(["path refund: held", "path refund: flaky step=7 kind=expect-failed"]);
    expect(s.calls.filter((c) => c.path.id === "refund").map((c) => c.dirty)).toEqual([true, true, false]);
    expect(s.calls.filter((c) => c.path.id === "checkout").map((c) => c.dirty)).toEqual([true]);
    expect(r.lines.at(-1)).toBe("smoke run: 3 held, 0 broke, 1 flaky, 0 harness");
    const recs = readFileSync(join(t.main, ".argus/live", t.runId, "smoke", "pass.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(recs.filter((x: Obj) => x.id === "refund").map((x: Obj) => x.verdict)).toEqual(["held", "flaky"]);
  });

  it("with --slot, a confirmed expectation break becomes that slot's return: one regression candidate, the path up to the broken expect", async () => {
    const t = suiteRun({ checkout: PATH() });
    const r = await smokeRun(t.main, { ids: null, slot: 4, perf: false, seed: 1 }, { once: stub({ checkout: [3, 3] }).once });
    expect(r.code).toBe(3);
    expect(r.lines).toContain("regression checkout: step 7 written as 4.1.1 (repro 4.1.1)");
    const slot = readRun(t.main).slots["4"];
    expect(slot).toEqual({ mode: "smoke", journey: "checkout", generation: 1, tokenHash: null, accounts: { "customer.1": "buyer1@example.test" }, retired: [], submitted: true });
    const file = join(t.main, ".argus/live", t.runId, "returns", "4.1.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const { candidate } = reproRef(t.main, "4.1.1");
    expect(candidate.oracle).toBe("regression");
    expect(candidate.repro).toEqual([{ context: { viewport: 1440, locale: "en-US", timezone: "UTC" } }, ...PATH().slice(1, 7), { ...PATH()[7], final: "regression" }]);
    const { steps } = parseRepro(candidate.repro, { accounts: slot.accounts, live: pathLive() });
    expect(steps.at(-1)).toMatchObject({ n: 7, expect: "visible", final: "regression" });
    // No explorer takes the slot, and its accounts still serve an explorer's slot (they browse only in slot r).
    await expect(handoffSlot(t.main, 4)).rejects.toThrow("refused: slot 4 holds the smoke pass's regression candidate: no explorer takes it");
    expect((await mintSlot(t.main, { slot: 5, journey: "checkout", accounts: { "customer.1": "buyer1@example.test" } })).accounts).toEqual({ "customer.1": "buyer1@example.test" });
  });

  it("pw submit checks a return's path and heal against the slot's accounts, live.json and smoke.json", async () => {
    const t = suiteRun({});
    const { token } = await mintSlot(t.main, { slot: 1, journey: "checkout", accounts: { "customer.1": "buyer1@example.test", "sales.1": "sales1@example.test" } });
    const submit = (ret: Obj) => pw(t.main, [token, "submit", JSON.stringify({ journey: "checkout", status: "done", ...ret })]);
    const bad = [...PATH().slice(0, -1), { ...PATH().at(-1), final: "handoff" }];
    expect((await submit({ path: bad })).out).toEqual(["refused: return: path: step 9: a path has no final: it ends with an expect proving the journey's goal"]);
    // heal_max_steps comes from smoke.json.
    writeFileSync(join(t.main, ".argus/smoke.json"), JSON.stringify({ heal_max_steps: 1 }));
    const two = [{ step: 4, target: "getByLabel('Amount')" }, { step: 5, target: "getByRole('button', { name: 'Pay' })" }];
    expect((await submit({ heal: two })).out).toEqual(["refused: return: heal holds at most 1 entries"]);
    // An unreadable smoke.json refuses a return that holds a path, never one that does not.
    writeFileSync(join(t.main, ".argus/smoke.json"), "{");
    expect((await submit({ path: PATH() })).out).toEqual(["refused: return: path: cannot be checked (.argus/live.json or .argus/smoke.json is not readable)"]);
    writeFileSync(join(t.main, ".argus/smoke.json"), "{}");
    expect((await submit({ path: PATH() })).out).toEqual(["submitted: slot 1 generation 1 status done"]);
    expect(JSON.parse(readFileSync(join(t.main, ".argus/live", t.runId, "returns", "1.1.json"), "utf8")).path).toEqual(PATH());
  });

  it("with --slot, a locator break or a flake writes nothing: a heal decides those", async () => {
    for (const [exits, broke] of [[[3, 3], { step: 5, kind: "target-missing" }], [[3, 0], { step: 7, kind: "expect-failed" }]] as [number[], Obj][]) {
      const t = suiteRun({ checkout: PATH() });
      const r = await smokeRun(t.main, { ids: null, slot: 4, perf: false, seed: 1 }, { once: stub({ checkout: exits }, broke as { step: number; kind: string }).once });
      expect(r.lines.some((l: string) => l.startsWith("regression "))).toBe(false);
      expect(readRun(t.main).slots ?? {}).toEqual({});
      expect(existsSync(join(t.main, ".argus/live", t.runId, "returns", "4.1.json"))).toBe(false);
    }
  });

  it("refuses before any run: no cycle, a slot minted already, an unknown id, no path, a path its mode refuses", async () => {
    const t = suiteRun({ checkout: PATH() }, { slots: { "4": { journey: "x", generation: 1, tokenHash: null, accounts: {}, retired: [], submitted: false } } });
    const s = stub();
    const run = (o: Obj) => smokeRun(t.main, { ids: null, slot: null, perf: false, seed: 1, ...o }, { once: s.once });
    await expect(run({ slot: 4 })).rejects.toThrow("refused: smoke run: slot 4 is minted already");
    await expect(run({ ids: ["nope"] })).rejects.toThrow("refused: smoke run: the suite has no path nope");
    writeFileSync(join(t.main, "e2e/argus-smoke/journeys/bad.json"), JSON.stringify({ journey: "bad", path: [...PATH().slice(0, -1), { ...PATH().at(-1), final: "handoff" }] }));
    await expect(run({})).rejects.toThrow("refused: smoke run: bad: step 9: a path has no final: it ends with an expect proving the journey's goal");
    writeFileSync(join(t.main, "e2e/argus-smoke/journeys/bad.json"), JSON.stringify({ journey: "other", path: PATH() }));
    await expect(run({})).rejects.toThrow("refused: smoke run: bad.json names journey other");
    expect(s.calls).toEqual([]);
    const empty = suiteRun({});
    await expect(smokeRun(empty.main, { ids: null, slot: null, perf: false, seed: 1 }, { once: s.once })).rejects.toThrow("refused: smoke run: the suite has no paths (e2e/argus-smoke/journeys)");
    await expect(smokeRun(committed(), { ids: null, slot: null, perf: false, seed: 1 }, { once: s.once })).rejects.toThrow("refused: no journey cycle is running");
  });
});
