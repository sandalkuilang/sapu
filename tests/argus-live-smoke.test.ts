// tests/argus-live-smoke.test.ts — phase 6's shared surfaces (spec §19): live.json's smoke keys, the
// `.argus/smoke.json` schema and its defaults, and the CLI's dispatch of every new verb (each answers
// through its lane's function; until a lane fills it, `refused: <verb>: not built yet`).
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FIXTURE_CONTRACT } from "./fixture-contract";
import { ARGUS_LIVE, cleanTemps, committed, example, git } from "./helpers/argus-live";
// @ts-expect-error — plain ESM script without types
import { loadSmoke, PERF_METRICS, SMOKE_BROWSERS, SMOKE_DEFAULTS, SMOKE_FILE, SMOKE_KEYS, validateLive, validateSmoke } from "../plugins/sapu/scripts/argus-live-config.mjs";

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
  const STUBS: [string[], string][] = [
    [["smoke", "plan"], "smoke plan"],
    [["smoke", "admit", "2.1"], "smoke admit"],
    [["smoke", "run"], "smoke run"],
    [["smoke", "run", "--ids", "checkout,refund", "--slot", "3", "--perf", "--seed", "4294967295"], "smoke run"],
    [["smoke", "heal", "2.1"], "smoke heal"],
    [["smoke", "propose"], "smoke propose"],
    [["smoke", "propose", "--dry-run"], "smoke propose"],
    [["smoke", "check"], "smoke check"],
    [["smoke", "ci"], "smoke ci"],
    [["smoke", "ci", "--run", "123456"], "smoke ci"],
    [["smoke", "baseline", "--from-run", "123456"], "smoke baseline"],
    [["smoke", "baseline", "--from-run", "123456", "--ids", "checkout"], "smoke baseline"],
    [["smoke", "perf", "--issue", "checkout"], "smoke perf"],
    [["smoke", "perf", "--rebaseline", "checkout"], "smoke perf"],
    [["smoke", "workflow"], "smoke workflow"],
    [["seed", "--issue", "12"], "seed"],
    [["seed", "--doc", "docs/flows.md:3-40"], "seed"],
    [["report"], "report"],
    [["report", "--run", "r1"], "report"],
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
      " | smoke baseline --from-run <id> [--ids …] | ",
      " | smoke perf (--issue|--rebaseline) <id> | ",
      " | smoke workflow | ",
      " | seed (--issue <n>|--doc <file>:<a>-<b>) | ",
      " | report [--run <runId>]",
      " | slot <n> --map [--seed] | ",
    ]) expect(r.stderr, alt).toContain(alt);
  }, 30_000);

  it("each new verb reaches its lane's function, which is not built yet", () => {
    const main = repo();
    for (const [args, verb] of STUBS) {
      const r = cli(main, ...args);
      expect(r.stderr, args.join(" ")).toBe(`refused: ${verb}: not built yet\n`);
      expect(r.status, args.join(" ")).toBe(1);
      expect(r.stdout).toBe("");
    }
  }, 60_000);

  it("a committed suite needs the repo's own contract with visible traces: every smoke verb but check is refused otherwise", () => {
    const TRACE = "refused: smoke: a committed suite would leave a trace\n";
    for (const main of [repo(null), repo({ traces: "none" })]) {
      for (const [args, verb] of STUBS) {
        const r = cli(main, ...args);
        expect(r.status, args.join(" ")).toBe(1);
        expect(r.stderr, args.join(" ")).toBe(args[0] === "smoke" && verb !== "smoke check" ? TRACE : `refused: ${verb}: not built yet\n`);
      }
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

  it("slot --map --seed is the seed lane's, not built yet; --seed needs --map", () => {
    const main = repo();
    expect(cli(main, "slot", "1", "--map", "--seed").stderr).toBe("refused: slot --seed: not built yet\n");
    expect(cli(main, "slot", "1", "--seed").stderr).toMatch(/^refused: usage: /);
    expect(cli(main, "slot", "1", "--handoff", "--seed").stderr).toMatch(/^refused: usage: /);
  }, 30_000);
});
