// tests/argus-live-codegen.test.ts — the smoke suite's generator (spec §19.5): every rule is pinned by scanning
// the generated text, the RED test goes through the same step builder, and the suite generated for the
// fixture app runs green under the pinned runner (a machine without Chrome fails here, never skips).
import { spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire, stripTypeScriptTypes } from "node:module";
import nodePath, { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FIXTURE_CONTRACT } from "./fixture-contract";
import { browserTools, cleanTemps, committed, example, freePort, git, PW, SERVER, tempDir, TOTP } from "./helpers/argus-live";
// @ts-expect-error — plain ESM script without types
import { authSetup, CODEGEN_VERSION, generateSuite, headerDigest, packageJson, SMOKE_AXE, SMOKE_PLAYWRIGHT, smokeConfig, smokeSpec, suiteGitignore, supportFile, TOTP_SOURCE } from "../plugins/sapu/scripts/argus-live-codegen.mjs";
// @ts-expect-error — plain ESM script without types
import { ARIA_EXPECT } from "../plugins/sapu/scripts/argus-live-a11y.mjs";
// @ts-expect-error — plain ESM script without types
import { SMOKE_DEFAULTS, validateSmoke } from "../plugins/sapu/scripts/argus-live-smokecfg.mjs";
// @ts-expect-error — plain ESM script without types
import { loginStageSource, totp } from "../plugins/sapu/scripts/argus-live-login.mjs";
// @ts-expect-error — plain ESM script without types
import { redTest } from "../plugins/sapu/scripts/argus-live-redtest.mjs";
// @ts-expect-error — plain ESM script without types
import { parseRepro } from "../plugins/sapu/scripts/argus-live-steps.mjs";
// @ts-expect-error — plain ESM script without types
import { FAMILIES, loadBar, MEDIA_READ, TASTE_BUFFER, TASTE_DRAIN } from "../plugins/sapu/scripts/argus-live-tastecfg.mjs";
// @ts-expect-error — plain ESM script without types
import { suiteProjects, TASTE_LANE_ONLY, TASTE_MEDIA_RULES, TASTE_SCALE_MARK, tasteCheckName, tasteSource, tasteTable, withHeader } from "../plugins/sapu/scripts/argus-live-codeproj.mjs";
// @ts-expect-error — plain ESM script without types
import { censusOf, rulesFor as tasteRulesFor } from "../plugins/sapu/scripts/argus-live-taste.mjs";
// @ts-expect-error — plain ESM script without types
import { smokeCheck } from "../plugins/sapu/scripts/argus-live-suite.mjs";
// @ts-expect-error — plain ESM script without types
import { smokeWorkflow, TASTE_SUMMARY } from "../plugins/sapu/scripts/argus-live-propose.mjs";
// @ts-expect-error — plain ESM script without types
import { run as runProc } from "../plugins/sapu/scripts/argus-live-proc.mjs";

type Obj = Record<string, any>;

afterEach(cleanTemps);

/** example()'s config with test ids and a seed trigger. */
const LIVE = (): Obj => ({
  ...example(),
  test_id_attribute: "data-testid",
  triggers: { ...example().triggers, "seed-stock": { argv: ["npm", "run", "-s", "explore:seed", "--", "{1}"], args: ["^[A-Za-z0-9-]{1,64}$"], seed: true } },
});
/** A path holding every shape the generator writes: a seed trigger, a fact, a read, a no-error, a parallel group, a URL. */
const PATH = (): Obj[] => [
  { context: { viewport: 1440, locale: "en-US", timezone: "UTC" } },
  { as: "system", do: "trigger", name: "seed-stock", values: ["{{marker}}"] },
  { as: "system", expect: "fact-equals", marker: "{{marker}}", field: "stock", value: "5" },
  { as: "customer", do: "goto", path: "/orders/new" },
  { as: "customer", do: "fill", target: { label: "Quantity" }, value: "2" },
  { as: "customer", do: "click", target: { role: "button", name: "Place order" } },
  { as: "customer", do: "read", target: { testId: "order-number" }, save: "order" },
  { as: "customer", expect: "visible", target: { text: "{{order}}" } },
  { as: "customer", expect: "no-error" },
  { as: "sales", do: "goto", path: "/orders/{{order}}" },
  { as: "customer.2", do: "goto", path: "/orders/{{order}}" },
  { parallel: [{ as: "sales", do: "click", target: { role: "button", name: "Claim" } }, { as: "customer.2", do: "click", target: { role: "button", name: "Claim" } }] },
  { as: "sales", expect: "url", value: "/orders/{{order}}" },
  { as: "sales", expect: "visible", target: { text: "{{order}}", within: { role: "main", name: "Order" } } },
];
const SMOKE = (): Obj => validateSmoke({ ci: { web_server: [{ command: "npm start", url: "http://localhost:4100/health" }], ports: { web: 4100 } } }).value;
const spec = (extra: Obj = {}) => smokeSpec({ id: "checkout", path: PATH(), live: LIVE(), smoke: SMOKE(), ...extra });
/** `ts` stripped of its types and parsed by `node --check` (as an .mjs file) → its exit and stderr. */
const check = (ts: string) => {
  const file = join(tempDir(), "x.mjs");
  writeFileSync(file, stripTypeScriptTypes(ts));
  const r = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  return { code: r.status, err: r.stderr };
};
/** The test's body (the text from `test(` on) with every double-quoted string literal emptied: what is code, not data. */
const codeOf = (text: string) => text.slice(text.indexOf("\ntest(")).replace(/"(?:[^"\\\n]|\\.)*"/g, '""');

describe("argus-live codegen — the RED test through the moved builder", () => {
  it("the golden RED test is byte-identical", () => {
    const at = { accounts: { "customer.1": "buyer1@example.test", "customer.2": "buyer2@example.test", "sales.1": "sales1@example.test", "anon.1": null }, live: example() };
    const list = [
      { context: { viewport: 1440, locale: "en-US", timezone: "UTC" } },
      { as: "customer", do: "goto", path: "/orders/new" },
      { as: "customer", do: "fill", target: { label: "Quantity" }, value: "2" },
      { as: "customer", do: "click", target: { role: "button", name: "Place order" } },
      { as: "customer", do: "read", target: { testId: "order-number" }, save: "order" },
      { as: "customer", expect: "visible", target: { text: "{{order}}" } },
      { as: "system", do: "trigger", name: "payment-settles", values: ["{{order}}"] },
      { as: "customer", expect: "fact-equals", marker: "{{order}}", field: "status", value: "paid" },
      { as: "sales", do: "goto", path: "/" },
      { as: "sales", expect: "visible", target: { text: "{{order}}" }, final: "handoff" },
    ];
    const { context, steps } = parseRepro(list, at);
    const text = redTest({ journey: "order-to-cash", oracle: "handoff", ref: "1.1.1", context, steps, settleMs: 3000 });
    expect(text).toBe(readFileSync(join(__dirname, "fixtures/argus-red/order-to-cash.handoff.spec.ts"), "utf8"));
  });
});

describe("argus-live codegen — smokeSpec", () => {
  it("bans hard waits, CSS and XPath, template literals, serial and shared state, and fixme", () => {
    const text = spec();
    for (const banned of ["`", "${"]) expect(codeOf(text), banned).not.toContain(banned);
    for (const banned of ["waitForTimeout", "setTimeout", "sleep", "`", "${", ".locator(", "xpath", "css=", "describe.serial", "beforeAll", "afterAll", "test.fixme", "fixme", "test.only", "waitFor("]) expect(text, banned).not.toContain(banned);
    expect(text.split("\n").filter((l) => /^(let|var)\b/.test(l))).toEqual([]);
    expect(check(text)).toEqual({ code: 0, err: "" });
  });

  it("the marker is made inside the test, and every step is one test.step titled by its number and kind", () => {
    const text = spec();
    expect(text.indexOf("const marker = newMarker();")).toBeGreaterThan(text.indexOf("\ntest("));
    expect(text.split("\n").filter((l) => l.includes("marker =")).length).toBe(1);
    const titles = [...text.matchAll(/test\.step\("([^"]*)"/g)].map((m) => m[1]);
    expect(titles).toEqual([
      "step 1 do:trigger",
      "step 2 expect:fact-equals",
      "step 3 do:goto",
      "step 4 do:fill",
      "step 5 do:click",
      "step 6 do:read",
      "step 7 expect:visible",
      "step 8 expect:no-error",
      "step 9 do:goto",
      "step 10 do:goto",
      "step 11 do:click",
      "step 12 do:click",
      "step 13 expect:url",
      "step 14 expect:visible",
    ]);
    // The title names the journey only.
    expect(text).toContain('test("checkout", {"lock": ["account:customer.1", "account:sales.1", "account:customer.2"]}, async ({ browser, baseURL, viewport }) => {');
    // Expectations wait as the runner does, never longer; a read's value is the step's.
    expect(text).toContain("await expect(customer1.getByText(saved_order)).toBeVisible({ timeout: SETTLE });");
    expect(text).toContain('const saved_order = await test.step("step 6 do:read", async () => readValue(customer1.getByTestId("order-number")));');
    expect(text).toContain('await expect.poll(async () => String(await fact(marker, "stock")), { timeout: SETTLE }).toBe(String("5"));');
    expect(text).toContain('await expect(sales1.getByRole("main", {"name": "Order"}).getByText(saved_order)).toBeVisible({ timeout: SETTLE });');
    expect(text).toContain("await Promise.all([");
    expect(text).toContain('await trigger("seed-stock", [marker]);');
  });

  it("locks each signed-in account it opens, and no other; a quarantined id is tagged", () => {
    const lockOf = (text: string) => JSON.parse(/"lock": (\[[^\]]*\])/.exec(text)![1]);
    expect(lockOf(spec())).toEqual(["account:customer.1", "account:sales.1", "account:customer.2"]);
    const anon = [{ as: "anon", do: "goto", path: "/" }, { as: "customer", do: "goto", path: "/" }, { as: "customer", expect: "visible", target: { role: "heading", name: "Shop" } }];
    expect(lockOf(spec({ path: anon }))).toEqual(["account:customer.1"]);
    expect(spec()).not.toContain("@quarantine");
    expect(spec({ quarantined: true })).toContain('test("checkout", {"tag": "@quarantine", "lock": ["account:customer.1", "account:sales.1", "account:customer.2"]}, ');
  });

  it("every string of the path is a JSON literal: backquotes, ${, quotes and backslashes come out inert", () => {
    const evil = 'a`b${process.exit(1)}"c\\n\\" + process.exit(2) + "';
    const path = [{ as: "customer", do: "goto", path: "/x" }, { as: "customer", do: "fill", target: { label: evil }, value: evil }, { as: "customer", expect: "text-equals", target: { role: "heading", name: evil }, value: `${evil}{{marker}}` }];
    const text = spec({ path });
    const literalOf = JSON.stringify(evil);
    expect(text).toContain(`customer1.getByLabel(${literalOf}).fill(${literalOf})`);
    expect(text).toContain(`.toHaveText(${literalOf} + marker, { timeout: SETTLE })`);
    expect(codeOf(text)).not.toContain("`");
    expect(codeOf(text)).not.toContain("${");
    expect(check(text)).toEqual({ code: 0, err: "" });
    // The literal evaluates back to the value.
    expect(JSON.parse(literalOf)).toBe(evil);
  });

  it("a path that types a password into a login records no trace; one without keeps the config's", () => {
    const signIn = [{ as: "customer.1", do: "login", user: "u-{{marker}}", password: "p-{{marker}}" }, { as: "customer", expect: "visible", target: { role: "heading", name: "Shop" } }];
    const text = spec({ path: signIn });
    expect(text).toContain('login(customer1, baseURL, "customer.1", "u-" + marker, "p-" + marker)');
    // A trace keeps each fill's value as typed, and the CI artifact keeps the trace.
    expect(text).toContain('\ntest.use({ trace: "off" });\n\ntest("checkout", ');
    expect(check(text)).toEqual({ code: 0, err: "" });
    expect(spec()).not.toContain("test.use(");
    // Video and screenshots are off for every project, so a failure attaches neither; toHaveScreenshot's images show a password field masked.
    expect(smokeConfig({ live: LIVE(), smoke: SMOKE() })).toContain('"trace": "on-first-retry", "video": "off", "screenshot": "off"');
  });

  it("refuses what path mode refuses, and a journey id of another shape", () => {
    expect(() => spec({ path: [...PATH(), { as: "sales", expect: "visible", target: { text: "x" }, final: "handoff" }] })).toThrow("refused: repro: step 15: a path has no final");
    expect(() => spec({ path: [{ as: "customer", do: "click", target: { text: "Pay" } }, { as: "customer", expect: "visible", target: { text: "Paid" } }] })).toThrow("refused: repro: step 1: an action's target in a path is");
    expect(() => spec({ id: "x\nprocess.exit()" })).toThrow("failed: codegen: a journey id is kebab-case");
    // A journey id equal to a project's name would match that project's every test in a baseline run's --grep.
    for (const id of ["webkit", "chromium-390", "a11y", "taste", "setup", "msedge", "i18n"]) expect(() => spec({ id }), id).toThrow(`failed: codegen: journey id ${id} is a project's name`);
  });
});

describe("argus-live codegen — config, setup, support, package", () => {
  it("smokeConfig: CI settings, the setup project's artifacts off, testIdAttribute only when configured", () => {
    const text = smokeConfig({ live: LIVE(), smoke: SMOKE() });
    for (const line of ["  fullyParallel: true,", "  forbidOnly: CI,", "  retries: CI ? 1 : 0,", "  workers: CI ? 1 : undefined,", "  globalTimeout: CI ? 3_600_000 : 0,", '  updateSnapshots: CI ? "none" : "missing",']) expect(text).toContain(line);
    expect(text).toContain('"trace": "on-first-retry"');
    expect(text).toContain('{ name: "setup", testMatch: /auth\\.setup\\.ts$/, use: { trace: "off", video: "off", screenshot: "off" } },');
    expect(text).toContain('dependencies: ["setup"]');
    expect(text).toContain('"testIdAttribute": "data-testid"');
    const without = { ...LIVE() };
    delete without.test_id_attribute;
    expect(smokeConfig({ live: without, smoke: SMOKE() })).not.toContain("testIdAttribute");
    expect(smokeConfig({ live: LIVE(), smoke: validateSmoke({ workers: 4 }).value })).toContain("  workers: CI ? 1 : 4,");
    expect(smokeConfig({ live: LIVE(), smoke: validateSmoke({ workers: "50%" }).value })).toContain('  workers: CI ? 1 : "50%",');
    expect(text).toContain('const BASE_URL = process.env.ARGUS_SMOKE_BASE_URL || "http://localhost:4100";');
    expect(text).toContain('"reuseExistingServer": false');
    expect(check(text)).toEqual({ code: 0, err: "" });
  });

  it("smokeConfig's loopback guard throws on another host", () => {
    const text = stripTypeScriptTypes(smokeConfig({ live: LIVE(), smoke: SMOKE() }));
    const dir = tempDir();
    mkdirSync(join(dir, "node_modules/@playwright/test"), { recursive: true });
    writeFileSync(join(dir, "node_modules/@playwright/test/index.js"), "module.exports = { defineConfig: (c) => c };\n");
    writeFileSync(join(dir, "playwright.config.cjs"), text.replace('import { defineConfig } from "@playwright/test";', 'const { defineConfig } = require("@playwright/test");').replace('import path from "node:path";', 'const path = require("node:path");').replace('import fs from "node:fs";', 'const fs = require("node:fs");').replace("export default defineConfig(", "module.exports = defineConfig("));
    const load = (url: string) => spawnSync(process.execPath, ["-e", 'console.log(JSON.stringify(require("./playwright.config.cjs").use.baseURL))'], { cwd: dir, encoding: "utf8", env: { ...process.env, ARGUS_SMOKE_BASE_URL: url } });
    for (const url of ["http://example.test", "http://10.0.0.5:3000", "https://localhost.example.test"]) {
      const r = load(url);
      expect(r.status, url).not.toBe(0);
      expect(r.stderr, url).toContain("argus-smoke: the base URL must name a loopback host");
    }
    for (const url of ["http://localhost:4100", "http://127.0.0.1:9", "http://[::1]:4100"]) {
      const r = load(url);
      expect([r.status, r.stdout.trim().split("\n").pop()], url).toEqual([0, JSON.stringify(url)]);
    }
  }, 30_000);

  it("authSetup: one setup per account, secrets read by their names, the storageState 0600 under .auth/", () => {
    const live = LIVE();
    const text = authSetup({ live, accounts: ["customer.1", "sales.1"] });
    expect(text).toContain('"account": "customer.1", "user": {"value": "buyer1@example.test"}, "password": "PW", "totp": null');
    expect(text).toContain('"account": "sales.1", "user": {"value": "sales1@example.test"}, "password": "PW", "totp": "SALES_TOTP"');
    expect(text).toContain("process.env[name]");
    expect(text).toContain('const AUTH = path.join(__dirname, ".auth");');
    expect(text).toContain('const file = path.join(AUTH, a.account + ".json");');
    expect(text).toContain("fs.chmodSync(file, 0o600);");
    expect(text).not.toContain("${");
    expect(check(text)).toEqual({ code: 0, err: "" });
    // A user may be a reference too; a password that is not one is refused: a committed suite holds no secret.
    live.roles.customer.users[0] = { user: "${BUYER_USER}", password: "${PW}" };
    expect(authSetup({ live, accounts: ["customer.1"] })).toContain('"user": {"env": "BUYER_USER"}');
    live.roles.customer.users[0] = { user: "buyer1@example.test", password: "hunter2-literal" };
    expect(() => authSetup({ live, accounts: ["customer.1"] })).toThrow("failed: codegen: customer.1's password is not a ${NAME} reference");
  });

  it("support: the wrapper's login template verbatim, hooks by argv with no shell and values checked, TOTP from Node's crypto", () => {
    const text = supportFile({ live: LIVE(), smoke: SMOKE(), roles: ["customer", "sales"] });
    for (const stage of ["credentials", "otp"]) expect(text, stage).toContain(loginStageSource(stage));
    expect(text).toContain("execFileSync(argv[0], argv.slice(1), {");
    expect(text).not.toMatch(/shell|\bexec\(|spawn\(|\/bin\/sh/);
    expect(text).toContain('new RegExp("^(?:" + h.args[i] + ")$")');
    expect(text).toContain('"seed-stock": {"argv": ["npm", "run", "-s", "explore:seed", "--", "{1}"], "args": ["^[A-Za-z0-9-]{1,64}$"]}');
    expect(text).toContain(TOTP_SOURCE);
    // The suite's TOTP is the wrapper's: the same code for every step.
    const suiteTotp = new Function("createHmac", "Buffer", `${stripTypeScriptTypes(TOTP_SOURCE)}\nreturn totp;`)(createHmac, Buffer);
    for (const step of [0, 1, 59_000_000, 61_234_567]) expect(suiteTotp(TOTP, step), String(step)).toBe(totp(TOTP, step));
    expect(() => suiteTotp("not base32!", 1)).toThrow("argus-smoke: a TOTP secret must be base32");
    expect(text).toContain('"customer": { url: "/login", loggedIn: (pg: Page) => pg.getByRole("button", {"name": "Account"}), open: null },');
    expect(check(text)).toEqual({ code: 0, err: "" });
    // A hook's {port:<name>} takes CI's port; one CI does not name is refused.
    const live = LIVE();
    live.triggers.settle = { argv: ["curl", "http://localhost:{port:api}/settle/{1}"] };
    expect(() => supportFile({ live, smoke: SMOKE(), roles: [] })).toThrow("failed: codegen: trigger settle names {port:api}, which smoke.json ci.ports lacks");
    expect(supportFile({ live, smoke: validateSmoke({ ci: { ports: { api: 4200 } } }).value, roles: [] })).toContain('"http://localhost:4200/settle/{1}"');
  });

  it("support's hooks in CI: ${NAME} from the job's environment at run time, {port:<name>=<n>} as CI's port or n, a failure named without its stderr", () => {
    const live = LIVE();
    live.triggers.reset = { argv: ["psql", "--password=${DB_PW}", "--port={port:db=5432}", "--api={port:api=4000}", "{1}"] };
    const text = supportFile({ live, smoke: validateSmoke({ ci: { ports: { api: 4200 } } }).value, roles: [] });
    // The file holds the name, never a value; the =<n> form takes CI's port when it names one, else n.
    expect(text).toContain('"reset": {"argv": ["psql", "--password=${DB_PW}", "--port=5432", "--api=4200", "{1}"], "args": []}');
    const js = stripTypeScriptTypes(text);
    const src = js.slice(js.indexOf("function hook("), js.indexOf("export async function trigger("));
    const calls: unknown[][] = [];
    let fail: Obj | null = null;
    const exec = (cmd: string, args: string[]) => {
      if (fail) throw fail;
      calls.push([cmd, args]);
      return "";
    };
    const hook = new Function("execFileSync", "REPO", "SETTLE", "VALUE", "process", `${src}\nreturn hook;`)(exec, "/repo", 1000, /^[A-Za-z0-9][A-Za-z0-9._@:-]{0,127}$/, { env: { DB_PW: "s3cret-{1}" } });
    hook({ argv: ["psql", "--password=${DB_PW}", "{1}"], args: [] }, ["m1"], "trigger reset");
    // Substituted in one pass: an environment value holding {1} stays as it is.
    expect(calls).toEqual([["psql", ["--password=s3cret-{1}", "m1"]]]);
    expect(() => hook({ argv: ["x", "${NOPE}"], args: [] }, [], "trigger reset")).toThrow("argus-smoke: trigger reset: the environment has no NOPE");
    // results.json is an artifact kept 7 days: a failed hook names itself and its exit, never its stderr.
    fail = Object.assign(new Error("Command failed: psql\nFATAL: password s3cret rejected"), { status: 3, stderr: "FATAL: password s3cret rejected" });
    let message = "";
    try {
      hook({ argv: ["psql"], args: [] }, [], "trigger reset");
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toBe("argus-smoke: trigger reset exited 3");
  });

  it("a login_url with {port:<name>=<n>} resolves to its path; one that is no URL is codegen's refusal, not a TypeError", () => {
    const live = { ...LIVE(), login_url: "http://localhost:{port:web=3000}/sign-in?next=/" };
    expect(supportFile({ live, smoke: SMOKE(), roles: ["customer"] })).toContain('"customer": { url: "/sign-in?next=/",');
    expect(() => supportFile({ live: { ...LIVE(), login_url: "http://[bad/x" }, smoke: SMOKE(), roles: ["customer"] })).toThrow("failed: codegen: login_url http://[bad/x is not a URL or a path");
  });

  it("package.json pins @playwright/test exactly, on the pinned CLI's minor; the suite's .gitignore lists .auth/", () => {
    const pkg = JSON.parse(packageJson());
    expect(pkg.devDependencies).toEqual({ "@axe-core/playwright": SMOKE_AXE, "@playwright/test": SMOKE_PLAYWRIGHT });
    expect(SMOKE_AXE).toMatch(/^\d+\.\d+\.\d+$/);
    expect(SMOKE_PLAYWRIGHT).toMatch(/^\d+\.\d+\.\d+$/);
    const lock = JSON.parse(readFileSync(join(__dirname, "../plugins/sapu/scripts/pw/package-lock.json"), "utf8"));
    const core = lock.packages["node_modules/playwright-core"].version as string;
    expect(SMOKE_PLAYWRIGHT.split(".").slice(0, 2)).toEqual(core.split(".").slice(0, 2));
    expect(suiteGitignore().split("\n")).toEqual(expect.arrayContaining([".auth/", "test-results/", "playwright-report/"]));
  });

  it("generation is a pure function, and every file's header digest is its body's", () => {
    const input = () => ({ paths: [{ id: "checkout", path: PATH() }, { id: "refund", path: PATH().slice(0, 8) }], live: LIVE(), smoke: SMOKE(), quarantine: ["refund"] });
    const a = generateSuite(input());
    const b = generateSuite(input());
    expect(a).toEqual(b);
    expect(Object.keys(a).sort()).toEqual([".gitignore", "auth.setup.ts", "checkout.spec.ts", "package.json", "playwright.config.ts", "refund.spec.ts", "support.ts"]);
    for (const [file, text] of Object.entries(a) as [string, string][]) {
      const h = headerDigest(text);
      expect(h.ok, file).toBe(true);
      expect(text, file).toContain(`argus-live codegen ${CODEGEN_VERSION}, taste-bar ${loadBar().version}, digest ${h.digest}`);
      expect(headerDigest(text.replace("\n", "\n// a hand edit\n")).ok, file).toBe(false);
    }
    expect(a["refund.spec.ts"]).toContain('"tag": "@quarantine"');
    expect(a["checkout.spec.ts"]).not.toContain("@quarantine");
    // The setup signs in exactly the accounts the paths open signed in.
    expect([...a["auth.setup.ts"].matchAll(/"account": "([a-z0-9.-]+)"/g)].map((m) => m[1])).toEqual(["customer.1", "customer.2", "sales.1"]);
    expect(headerDigest("no header").ok).toBe(false);
    expect(SMOKE_DEFAULTS.dir).toBe("e2e/argus-smoke");
  });
});

describe("argus-live codegen — the split into -codegen and -codeproj (phase 7, Task 0.3)", () => {
  // Every file of a suite that reaches every project, check registry and config branch, by its sha256: the split
  // moved code and changed no output. A lane that changes the output on purpose updates these digests in its
  // commit: S1 did (the taste project and core, the bar's version in every header); a probe lane's sources and
  // expressions reach support.ts, so T1's and T2's merges move it again, and so does a change to the login stage it embeds (2.32.0: the usable-field check).
  const GOLDEN: Record<string, string> = {
    ".gitignore": "5db585b9b755341b58c08d6d04a692d9626ce9d2a7c900417e9e9305535f2151",
    "auth.setup.ts": "a2af7331be220f6e5684857e5be3fe2363e2c7efcedb32dfd01f78537870ff29",
    "checkout.spec.ts": "b717da0eea94e90bf4e1baf610056ddfe9b08a36205b7b9019b2f039c83dbf0c",
    "package.json": "5da67b6735aff632b3a3e5673cad279ba4a0a80c8bf0c61a774ad7364d3db856",
    "playwright.config.ts": "e8564f300b89f2f041c93797ad54efde5df6ea363efb83a93844ea74a5836321",
    "refund.spec.ts": "0125b0b69225d90ac7fb27f00883bf49d214bb65de27336bdda05514271344ec",
    "support.ts": "cd7372d01a9ba7c6446afb211159673003b7f49acca44ae4d531861d4e3fc77a",
  };

  it("leaves every generated file byte-identical", () => {
    const smoke = validateSmoke({
      ci: { web_server: [{ command: "npm start", url: "http://localhost:4100/health" }], ports: { web: 4100 } },
      browsers: ["chromium", "firefox", "webkit", "msedge"],
      masks: ["getByTestId('clock')"],
      journeys: { refund: { browsers: ["chromium"], viewports: [1440], screens: [4, 7] }, checkout: { masks: ["getByRole('status', { name: 'Promo' })"] } },
    }).value;
    const live = { ...LIVE(), viewports: [1440, 390], locales: ["de-DE"] };
    const files = generateSuite({ paths: [{ id: "checkout", path: PATH(), routes: [{ role: "customer", route: "/orders/new" }] }, { id: "refund", path: PATH().slice(0, 8) }], live, smoke, quarantine: ["refund"] }) as Record<string, string>;
    const digests = Object.fromEntries(Object.entries(files).map(([f, t]) => [f, createHash("sha256").update(t).digest("hex")]));
    expect(digests).toEqual(GOLDEN);
  });
});

/** The generated config evaluated under a stub `@playwright/test` (its `defineConfig` the identity) → its settings (regexes as strings) and what it printed. `edge`: where msedge's executable is looked for. */
function evalConfig(text: string, { edge = ["/nonexistent/msedge"], env = {} as Record<string, string> } = {}) {
  const dir = tempDir();
  mkdirSync(join(dir, "node_modules/@playwright/test"), { recursive: true });
  writeFileSync(join(dir, "node_modules/@playwright/test/index.js"), "module.exports = { defineConfig: (c) => c };\n");
  const js = stripTypeScriptTypes(text)
    .replace('import { defineConfig } from "@playwright/test";', 'const { defineConfig } = require("@playwright/test");')
    .replace('import path from "node:path";', 'const path = require("node:path");')
    .replace('import fs from "node:fs";', 'const fs = require("node:fs");')
    .replace("export default defineConfig(", "module.exports = defineConfig(")
    .replace(/^const EDGE\s*=.*$/m, `const EDGE = ${JSON.stringify(edge)};`);
  writeFileSync(join(dir, "playwright.config.cjs"), js);
  const code = 'console.log(JSON.stringify(require("./playwright.config.cjs"), (k, v) => (v instanceof RegExp ? String(v) : v)))';
  const r = spawnSync(process.execPath, ["-e", code], { cwd: dir, encoding: "utf8", env: { ...process.env, ARGUS_SMOKE_BASE_URL: "http://localhost:4100", ...env } });
  expect(r.status, r.stderr).toBe(0);
  const lines = r.stdout.trim().split("\n");
  return { config: JSON.parse(lines[lines.length - 1]) as Obj, printed: lines.slice(0, -1) };
}
const projectNames = (c: Obj): string[] => c.projects.map((p: Obj) => p.name);

describe("argus-live codegen — projects and browsers", () => {
  it("setup, the three engines, a project per further viewport and the a11y project; i18n only with locales", () => {
    const { config } = evalConfig(smokeConfig({ live: LIVE(), smoke: SMOKE() }));
    expect(projectNames(config)).toEqual(["setup", "chromium", "firefox", "webkit", "chromium-390", "a11y", "taste"]);
    const byName = Object.fromEntries(config.projects.map((p: Obj) => [p.name, p]));
    expect(byName.firefox.use).toEqual({ browserName: "firefox" });
    expect(byName.webkit.use).toEqual({ browserName: "webkit" });
    expect(byName["chromium-390"].use).toEqual({ browserName: "chromium", viewport: { width: 390, height: 900 } });
    expect(byName.a11y.use).toEqual({ browserName: "chromium" });
    // The taste project: Chromium at the first width (the config's own viewport), on by default.
    expect(byName.taste.use).toEqual({ browserName: "chromium" });
    // The first viewport is every other project's.
    expect(config.use.viewport).toEqual({ width: 1440, height: 900 });
    for (const live of [{ ...LIVE(), locales: ["de-DE"] }, { ...LIVE(), pseudo_locales: ["en-XA"] }]) expect(projectNames(evalConfig(smokeConfig({ live, smoke: SMOKE() })).config)).toContain("i18n");
    expect(projectNames(evalConfig(smokeConfig({ live: { ...LIVE(), viewports: [1280] }, smoke: SMOKE() })).config)).toEqual(["setup", "chromium", "firefox", "webkit", "a11y", "taste"]);
  });

  it("every project but setup depends on setup, and smoke.json's browsers choose the engines", () => {
    const { config } = evalConfig(smokeConfig({ live: LIVE(), smoke: SMOKE() }));
    for (const p of config.projects.filter((x: Obj) => x.name !== "setup")) expect(p.dependencies, p.name).toEqual(["setup"]);
    const only = validateSmoke({ browsers: ["chromium", "webkit"] }).value;
    expect(projectNames(evalConfig(smokeConfig({ live: LIVE(), smoke: only })).config)).toEqual(["setup", "chromium", "webkit", "chromium-390", "a11y", "taste"]);
    // Without chromium there is no chromium-engine project either (a11y, taste, further viewports).
    const noChromium = validateSmoke({ browsers: ["firefox"] }).value;
    expect(projectNames(evalConfig(smokeConfig({ live: LIVE(), smoke: noChromium })).config)).toEqual(["setup", "firefox"]);
  });

  it("a journey's own browsers leave its spec out of the other engines' projects", () => {
    const smoke = validateSmoke({ journeys: { checkout: { browsers: ["chromium"] }, "refund-flow": { browsers: ["chromium", "msedge"] } } }).value;
    const { config } = evalConfig(smokeConfig({ live: LIVE(), smoke }), { edge: [process.execPath] });
    const ignore = Object.fromEntries(config.projects.map((p: Obj) => [p.name, p.testIgnore]));
    expect(ignore.chromium).toBeUndefined();
    expect(ignore["chromium-390"]).toBeUndefined();
    expect(ignore.a11y).toBeUndefined();
    expect(ignore.firefox).toBe("/(?:^|[\\\\/])(?:checkout|refund-flow)\\.spec\\.ts$/");
    expect(ignore.webkit).toBe(ignore.firefox);
    expect(ignore.msedge).toBe("/(?:^|[\\\\/])(?:checkout)\\.spec\\.ts$/");
    // The regex means what it says: it ignores those files and no other.
    const re = new RegExp(/\/(.*)\/$/.exec(ignore.firefox)![1]);
    expect([re.test("/s/checkout.spec.ts"), re.test("/s/refund-flow.spec.ts"), re.test("/s/checkout-2.spec.ts"), re.test("/s/x-checkout.spec.ts")]).toEqual([true, true, false, false]);
    // A journey that excludes chromium leaves the chromium-engine projects.
    const away = validateSmoke({ journeys: { checkout: { browsers: ["firefox"] } } }).value;
    const proj = Object.fromEntries(evalConfig(smokeConfig({ live: LIVE(), smoke: away })).config.projects.map((p: Obj) => [p.name, p.testIgnore]));
    for (const n of ["chromium", "chromium-390", "a11y", "taste"]) expect(proj[n], n).toBe("/(?:^|[\\\\/])(?:checkout)\\.spec\\.ts$/");
    expect(proj.firefox).toBeUndefined();
  });

  it("a journey's own viewports leave its spec out of the further widths' projects; the first width always runs", () => {
    const smoke = validateSmoke({ journeys: { checkout: { viewports: [1440] }, refund: { viewports: [1440, 390], browsers: ["chromium"] } } }).value;
    const ignore = Object.fromEntries(evalConfig(smokeConfig({ live: LIVE(), smoke })).config.projects.map((p: Obj) => [p.name, p.testIgnore]));
    expect(ignore["chromium-390"]).toBe("/(?:^|[\\\\/])(?:checkout)\\.spec\\.ts$/");
    for (const n of ["chromium", "a11y", "taste"]) expect(ignore[n], n).toBeUndefined();
    expect(ignore.firefox).toBe("/(?:^|[\\\\/])(?:refund)\\.spec\\.ts$/");
  });

  it("msedge is a project only where its executable exists, else the config says so", () => {
    const text = smokeConfig({ live: LIVE(), smoke: SMOKE() });
    const present = evalConfig(text, { edge: [process.execPath] });
    expect(projectNames(present.config)).toContain("msedge");
    expect(present.config.projects.find((p: Obj) => p.name === "msedge").use).toEqual({ browserName: "chromium", channel: "msedge" });
    expect(present.printed).toEqual([]);
    const absent = evalConfig(text, { edge: ["/nonexistent/msedge", "/also/not/there"] });
    expect(projectNames(absent.config)).not.toContain("msedge");
    expect(absent.printed).toEqual(["msedge: skipped (not installed)"]);
    // smoke.json can leave msedge out: no probe, no line.
    const off = evalConfig(smokeConfig({ live: LIVE(), smoke: validateSmoke({ browsers: ["chromium"] }).value }), { edge: [process.execPath] });
    expect(projectNames(off.config)).not.toContain("msedge");
    expect(off.printed).toEqual([]);
    // Edge's documented places for the host are the config's own.
    expect(text).toContain("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge");
    expect(text).toContain("/opt/microsoft/msedge/msedge");
  });

  it("WebKit is named as not Safari", () => {
    expect(smokeConfig({ live: LIVE(), smoke: SMOKE() })).toMatch(/\/\/ WebKit .*not Safari/);
  });

  it("a check's project gates its lines: the project it names, a group, an array; an unknown name is refused", async () => {
    const layout = await import("../plugins/sapu/scripts/argus-live-layout.mjs");
    const SHORT = [{ as: "customer", do: "goto", path: "/" }, { as: "customer", expect: "visible", target: { role: "heading", name: "Shop" } }];
    const gated = (project: unknown) => {
      layout.CHECKS.push({ name: "probe", project, when: "every step", source: "", emit: (s: Obj) => [`await probe(${s.n});`] });
      try {
        return spec({ path: SHORT });
      } finally {
        layout.CHECKS.pop(); // only the probe: the registry is the layout lane's
      }
    };
    expect(gated("a11y")).toContain('    if (inProject(["a11y"])) {\n      await probe(2);\n    }');
    expect(gated("viewport")).toContain('if (inProject(["chromium","firefox","webkit","msedge","chromium-390"])) {');
    expect(gated("browser")).toContain('if (inProject(["chromium","firefox","webkit","msedge"])) {');
    expect(gated(["i18n", "a11y"])).toContain('if (inProject(["a11y"])) {');
    expect(gated("i18n")).not.toContain("probe(");
    for (const open of ["all", undefined]) expect(gated(open)).toMatch(/\n {4}await probe\(2\);\n/);
    expect(() => gated("a11y-ish")).toThrow("failed: codegen: check probe names project a11y-ish, which the suite does not define");
  });
});

/** The shot gate every spec carries: the projects a screenshot is asserted in. */
const SHOT_PROJECTS = ["chromium", "firefox", "webkit", "chromium-390"];

describe("argus-live codegen — screenshots", () => {
  it("the path's last page step is shot after the pointer is parked: animations off, caret hidden, the dynamic content masked", () => {
    const text = spec();
    // The shot's own gate (the checks' gates name msedge, a11y or i18n too, or no engine at all).
    const shot = text.slice(text.indexOf(`    if (inProject(${JSON.stringify(SHOT_PROJECTS)})) {`));
    expect(shot.split("\n").slice(0, 4)).toEqual([
      `    if (inProject(${JSON.stringify(SHOT_PROJECTS)})) {`,
      "      await sales1.mouse.move(-1, -1);",
      '      await expect(sales1).toHaveScreenshot("14.png", {"animations": "disabled", "caret": "hide", "mask": [sales1.getByRole("time"), ...[marker, saved_order].filter((t) => t !== "").map((t) => sales1.getByText(t))]});',
      "    }",
    ]);
    expect((text.match(/toHaveScreenshot/g) ?? []).length).toBe(1);
    // A gate holds lines: a check with none at a step (a system step) leaves no empty block.
    expect(text).not.toMatch(/if \(inProject\([^\n]*\)\) \{\n\s*\}/);
    // Playwright's own tolerance: no allowance of pixels, no threshold, no full page.
    for (const banned of ["maxDiffPixels", "maxDiffPixelRatio", "threshold", "fullPage", "stylePath", "scale"]) expect(text, banned).not.toContain(banned);
    expect(check(text)).toEqual({ code: 0, err: "" });
  });

  it("smoke.json's screens name the steps; masks add the owner's locators; a value is masked only once it is read", () => {
    const smoke = validateSmoke({ masks: ["getByTestId('clock')"], journeys: { checkout: { screens: [11, 5, 7], masks: ["getByRole('status', { name: 'Promo' })"] } } }).value;
    const text = spec({ smoke });
    expect([...text.matchAll(/toHaveScreenshot\("(\d+)\.png"/g)].map((m) => m[1])).toEqual(["5", "7", "11"]);
    const shots = text.split("\n").filter((l) => l.includes("toHaveScreenshot"));
    // Step 5 comes before the read of step 6: only the marker; the clock and the promo status are the owner's.
    expect(shots[0]).toContain('"mask": [customer1.getByRole("time"), ...[marker].filter((t) => t !== "").map((t) => customer1.getByText(t)), customer1.getByTestId("clock"), customer1.getByRole("status", {"name": "Promo"})]');
    expect(shots[1]).toContain("...[marker, saved_order].filter");
    expect(shots[2]).toContain("sales1.getByRole");
    expect(check(text)).toEqual({ code: 0, err: "" });
    // A screen is a step of the path with a page: a system step or an absent one is refused, naming the key.
    for (const n of [1, 2, 99]) expect(() => spec({ smoke: validateSmoke({ journeys: { checkout: { screens: [n] } } }).value })).toThrow(`failed: codegen: smoke.json journeys.checkout.screens names step ${n}, which is not a step of the path acting on a page`);
  });

  it("every registered check is told the screens, the projects, the page variables and the map routes", async () => {
    const layout = await import("../plugins/sapu/scripts/argus-live-layout.mjs");
    const seen: Obj[] = [];
    layout.CHECKS.push({ name: "probe", source: "", emit: (_s: Obj, ctx: Obj) => (seen.push(ctx), []) });
    try {
      spec({ smoke: validateSmoke({ journeys: { checkout: { screens: [3, 5] } } }).value, routes: [{ role: "customer", route: "/orders/:id" }] });
    } finally {
      layout.CHECKS.pop(); // only the probe: the registry is the layout lane's
    }
    expect(seen[0]).toMatchObject({ id: "checkout", screens: [3, 5], projects: [...SHOT_PROJECTS.slice(0, 3), "msedge", "chromium-390", "a11y", "taste"], routes: [{ role: "customer", route: "/orders/:id" }] });
    // The page variables are the spec's own (pageVars), so a check never rebuilds the naming rule.
    expect([...seen[0].pages].map(([a, p]: [string, Obj]) => [a, p.v])).toEqual([...new Set(seen[0].steps.filter((x: Obj) => x.as !== "system").map((x: Obj) => x.as))].map((a) => [a, a.replace(".", "")]));
    // Without routes the CTA-route check has none.
    layout.CHECKS.push({ name: "probe", source: "", emit: (_s: Obj, ctx: Obj) => (seen.push(ctx), []) });
    try {
      spec();
    } finally {
      layout.CHECKS.pop(); // only the probe: the registry is the layout lane's
    }
    expect(seen.at(-1).routes).toEqual([]);
  });

  it("generateSuite hands each path's routes (its journey file's) to the CTA-route check of that spec only", () => {
    const routes = [{ role: "sales", route: "/inbox" }];
    const files = generateSuite({ paths: [{ id: "checkout", path: PATH(), routes }, { id: "other", path: PATH() }], live: LIVE(), smoke: SMOKE() }) as Record<string, string>;
    const finalOf = (f: string) => files[f].split("\n").find((l) => l.includes(".linksFinal("))!;
    expect(finalOf("checkout.spec.ts")).toContain('[{"role":"sales","route":"/inbox"}]');
    expect(finalOf("other.spec.ts")).not.toContain("/inbox");
  });

  it("the config names where baselines live and ignores them outside CI", () => {
    const text = smokeConfig({ live: LIVE(), smoke: SMOKE() });
    expect(text).toContain("  ignoreSnapshots: !CI,");
    const ci = evalConfig(text, { env: { CI: "1" } }).config;
    const local = evalConfig(text, { env: { CI: "" } }).config;
    expect(ci.snapshotPathTemplate).toBe("{testDir}/__screenshots__/{projectName}/{platform}/{testFileBaseName}/{arg}{ext}");
    expect([ci.ignoreSnapshots, local.ignoreSnapshots]).toEqual([false, true]);
    expect([ci.updateSnapshots, local.updateSnapshots]).toEqual(["none", "missing"]);
    // ARIA baselines (the a11y checks) sit beside the screenshots', one directory per spec: -a11y's ARIA_EXPECT, as is.
    expect(ci.expect.toMatchAriaSnapshot).toEqual(ARIA_EXPECT);
    expect(ci.expect.toMatchAriaSnapshot.pathTemplate).toBe("{testDir}/__aria__/{testFileBaseName}/{arg}{ext}");
    // No tolerance of the config's own either.
    expect(JSON.stringify(ci.expect)).not.toMatch(/threshold|maxDiff/);
  });
});

/** The suite for the fixture app, generated into a scratch repo beside a running app; `run` drives the pinned runner on it. */
async function fixtureSuite({ paths, smokeExtra = {}, generate = generateSuite, projects = ["chromium"] }: { paths: { id: string; path: Obj[] }[]; smokeExtra?: Obj; generate?: (x: Obj) => Obj; projects?: string[] }) {
  const { cli } = browserTools();
  const web = await freePort();
  const data = join(tempDir(), "app_explore");
  const appEnv = { PORT: String(web), DATA_DIR: data, APP_PW: PW, APP_TOTP: TOTP, CONTROL_TOKEN: "control-7", CACHE_URL: "tcp://127.0.0.1:9" };
  expect(spawnSync(process.execPath, [SERVER, "--reset"], { env: { ...process.env, ...appEnv } }).status).toBe(0);
  const live = {
    ...example(),
    base_url: "http://localhost:{port:web}",
    login_url: "/login",
    logged_in: "getByRole('button', { name: 'Account' })",
    test_id_attribute: "data-testid",
    facts: { argv: [process.execPath, SERVER, "--facts", "{1}"] },
    triggers: {},
    settle_ms: 5000,
    viewports: [1280],
    roles: { anon: {}, buyer: { users: [{ user: "buyer1@example.test", password: "${APP_PW}" }] }, clerk: { users: [{ user: "clerk1@example.test", password: "${APP_PW}", totp_secret: "${APP_TOTP}" }] } },
  };
  delete live.mail;
  // The fixture header's 64 x 21 px "Account" button under the "Home" link is a real WCAG 2.5.8 target-size
  // violation the layout oracle reports: the owner's allow entry for it, on every journey.
  const ACCOUNT = { check: "target-size", key: "button|Account|button" };
  const journeys = Object.fromEntries(paths.map(({ id }) => [id, { ...(smokeExtra.journeys?.[id] ?? {}), allow: [ACCOUNT] }]));
  const smoke = validateSmoke({ dir: "e2e/argus-smoke", ...smokeExtra, journeys, ci: { web_server: [{ command: `${JSON.stringify(process.execPath)} ${JSON.stringify(SERVER)} --from=argus-live-codegen-tests`, url: `http://localhost:${web}/health`, timeout_s: 30 }], ports: { web } } }).value;
  expect(smoke).not.toBeNull();
  const files = generate({ paths, live, smoke }) as Record<string, string>;
  const dir = join(tempDir(), "e2e/argus-smoke");
  mkdirSync(dir, { recursive: true });
  for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text);
  // @playwright/test through a scratch stub over the pinned install (never npm install).
  const pinned = join(cli.dir, "node_modules");
  mkdirSync(join(dir, "node_modules/@playwright/test"), { recursive: true });
  writeFileSync(join(dir, "node_modules/@playwright/test/index.js"), 'module.exports = require("playwright/test");\n');
  for (const m of ["playwright", "playwright-core"]) symlinkSync(join(pinned, m), join(dir, "node_modules", m));
  writeFileSync(join(dir, "wrapper.config.ts"), 'import base from "./playwright.config";\n\nexport default { ...base, projects: base.projects.map((p) => ({ ...p, use: { ...p.use, channel: "chrome" } })) };\n');
  const run = (args: string[]) => {
    const r = spawnSync(process.execPath, [join(pinned, "playwright/cli.js"), "test", "-c", "wrapper.config.ts", ...args, "--project", "setup", ...projects.flatMap((p) => ["--project", p])], { cwd: dir, encoding: "utf8", timeout: 240_000, env: { ...process.env, ...appEnv, CI: "1" } });
    const results = existsSync(join(dir, "test-results/results.json")) ? JSON.parse(readFileSync(join(dir, "test-results/results.json"), "utf8")) : null;
    return { status: r.status, out: `${r.stdout}\n${r.stderr}`, results };
  };
  return { dir, files, run };
}
const PLACE = (): Obj[] => [
  { as: "buyer", do: "goto", path: "/orders/new" },
  { as: "buyer", do: "fill", target: { label: "Quantity" }, value: "1" },
  { as: "buyer", do: "click", target: { role: "button", name: "Place order" } },
  { as: "buyer", do: "read", target: { testId: "order-number" }, save: "order" },
  { as: "buyer", expect: "visible", target: { testId: "order-number" } },
];
const titles = (s: Obj): string[] => [...(s.specs ?? []).map((x: Obj) => x.title), ...(s.suites ?? []).flatMap(titles)];
const resultsOf = (s: Obj): Obj[] => [...(s.specs ?? []).flatMap((x: Obj) => x.tests.flatMap((t: Obj) => t.results.map((r: Obj) => ({ ...r, title: x.title, test: t.status })))), ...(s.suites ?? []).flatMap(resultsOf)];

describe("argus-live codegen — the generated suite under the pinned runner", () => {
  it("runs green for the fixture app with CI=1, setup then chromium, each test holding its locks", async () => {
    const paths = [
      { id: "place-order", path: [...PLACE(), { as: "system", expect: "fact-equals", marker: "{{order}}", field: "status", value: "placed" }] },
      { id: "order-handoff", path: [...PLACE(), { as: "clerk", do: "goto", path: "/inbox" }, { as: "clerk", expect: "visible", target: { text: "{{order}}" } }] },
    ];
    const { dir, files, run } = await fixtureSuite({ paths });
    // The suite's baselines are CI's baseline run's: here the first run writes them (spec 19.8).
    const r = run(["--update-snapshots=missing"]);
    const { results } = r;
    expect(r.status, r.out).toBe(0);
    expect(results.stats).toMatchObject({ expected: 4, unexpected: 0, flaky: 0 });
    expect(results.suites.flatMap(titles).sort()).toEqual(["order-handoff", "place-order", "sign in buyer.1", "sign in clerk.1"]);
    for (const a of ["buyer.1", "clerk.1"]) expect(statSync(join(dir, ".auth", `${a}.json`)).mode & 0o777, a).toBe(0o600);
    // The steps CI names: each test's results carry its test.step titles.
    const steps = (s: Obj): string[] => [...(s.specs ?? []).flatMap((x: Obj) => x.tests.flatMap((t: Obj) => t.results.flatMap((res: Obj) => (res.steps ?? []).map((st: Obj) => st.title)))), ...(s.suites ?? []).flatMap(steps)];
    expect(results.suites.flatMap(steps)).toEqual(expect.arrayContaining(["step 3 do:click", "step 6 expect:fact-equals", "step 7 expect:visible"]));
    // No password reached the suite's files or the runner's output.
    for (const [f, text] of Object.entries(files)) expect(text.includes(PW), f).toBe(false);
    expect(r.out.includes(PW)).toBe(false);
  }, 480_000);

  it("screenshots: 'none' fails a missing one with no actual, 'missing' writes it and passes, then 'none' holds; 'changed' rewrites an ARIA baseline", async () => {
    const smokeExtra = { journeys: { "place-order": { screens: [1, 5] } } };
    const { dir, run } = await fixtureSuite({ paths: [{ id: "place-order", path: PLACE() }], smokeExtra });
    const platform = process.platform;
    const shot = (n: number) => join(dir, "__screenshots__/chromium", platform, "place-order.spec", `${n}.png`);
    // 1. A normal CI run (updateSnapshots "none"): a missing baseline fails, writes nothing and attaches no actual.
    const none = run([]);
    expect(none.status, none.out).toBe(1);
    const failed = resultsOf(none.results.suites[0]).concat(none.results.suites.slice(1).flatMap(resultsOf)).filter((r) => r.title === "place-order");
    expect(failed.length).toBeGreaterThan(0);
    for (const r of failed) {
      expect(r.test).toBe("unexpected");
      expect(r.error.message).toContain("A snapshot doesn't exist at");
      expect((r.attachments ?? []).filter((a: Obj) => /actual\.png$/.test(String(a.path ?? a.name)))).toEqual([]);
    }
    expect(existsSync(shot(1)) || existsSync(shot(5))).toBe(false);
    // 2. The baseline run's flag writes both and passes, over the config's "none".
    const missing = run(["--update-snapshots=missing"]);
    expect(missing.status, missing.out).toBe(0);
    for (const n of [1, 5]) expect(readFileSync(shot(n)).subarray(0, 8).toString("hex"), `${n}.png`).toBe("89504e470d0a1a0a");
    // 3. A normal run now holds: the dynamic content (marker, order number) is masked.
    const again = run([]);
    expect(again.status, again.out).toBe(0);
    expect(again.results.stats).toMatchObject({ unexpected: 0, flaky: 0 });
    // 4. The ARIA probe (spec 19.7, plan C3.2): a hand-written spec in the suite's own config.
    writeFileSync(join(dir, "aria-probe.spec.ts"), 'import { test, expect } from "@playwright/test";\n\ntest("aria-probe", async ({ page }) => {\n  await page.goto("/login");\n  await expect(page.getByRole("main")).toMatchAriaSnapshot({ name: "1.aria.yml" });\n});\n');
    const aria = join(dir, "__aria__/aria-probe.spec/1.aria.yml");
    const probe = (...args: string[]) => run(["aria-probe", ...args]);
    const wrote = probe("--update-snapshots=missing");
    expect(wrote.status, wrote.out).toBe(0);
    const received = readFileSync(aria, "utf8");
    expect(received).toContain('heading "Sign in"');
    writeFileSync(aria, '- main:\n  - heading "Old title" [level=1]\n');
    const stale = probe();
    expect(stale.status).toBe(1);
    expect(stale.out).toContain("toMatchAriaSnapshot");
    const changed = probe("--update-snapshots=changed");
    expect(changed.status, changed.out).toBe(0);
    expect(readFileSync(aria, "utf8")).toBe(received);
  }, 480_000);
});

// ---------------------------------------------------------------------------------------------------
// Phase 7, lane S: the taste project (S1) and the workflow's taste job (S2). The probes are lanes T1's and T2's:
// here they are stood in (tasteTable's `expression`, or the probe modules mocked for one generation).

/** Stand-in probe sources, long enough to be written once in support.ts. */
const TSRC = "(rule) => { /* stand-in for the census source: support.ts writes it once for every rule */ return [rule].filter(() => false); }";
const ESRC = "(rule) => { /* stand-in for the ease source: support.ts writes it once for every rule too */ return [rule].filter(() => false); }";
const standIn = (rule: string, probe: string) => `(${probe === "ease" ? ESRC : TSRC})(${JSON.stringify(rule)})`;
/** The dark-parity census stood in: no page call, one dark-surface row on a two-theme screen. */
const CENSUS = {
  census: 'async (page) => ({ themes: "dual", page: typeof page })',
  rules: '(screen, bar) => (screen.themes === "dual" ? bar.rules.filter((r) => r.id === "colour.dark-surface").map((r) => ({ rule: r.id, key: "card|light", measured: 1, expected: 0 })) : [])',
};
const standInTable = () => tasteTable({ expression: standIn, sources: { taste: TSRC, ease: ESRC }, census: CENSUS });

/** A Playwright page and its context stood in: each rule's expression answered by `answers(rule, media)`, the media emulated, the drains, inits and settles counted. */
function fakePage(answers: (rule: string, media: Obj) => unknown, start: Obj = { colorScheme: "light", reducedMotion: "no-preference" }) {
  const media = { ...start };
  const calls = { emulate: [] as Obj[], drains: 0, settles: 0, armed: 0, initRuns: 0, batches: 0, evaluated: [] as string[], scales: [] as string[] };
  /** One stand-in rule expression answered. */
  const single = (expr: string) => {
    const m = /^\((.*)\)\("([a-z]+\.[a-z0-9-]+)"(?:, (\{.*\}))?\)$/s.exec(expr);
    if (!m || ![TSRC, ESRC].includes(m[1])) throw new Error(`not a stand-in expression: ${expr.slice(0, 80)}`);
    if (m[3] !== undefined) calls.scales.push(m[3]);
    calls.evaluated.push(`${m[2]}@${media.colorScheme}/${media.reducedMotion}`);
    const a = answers(m[2], { ...media });
    if (a instanceof Error) throw a;
    return a;
  };
  const page = {
    evaluate: async (expr: string) => {
      // Every source reaches the page with the suite's own random key, never the mark (the app's scripts would know it).
      if (expr.includes("@@argus-taste-key@@")) throw new Error(`the taste key's mark reached the page: ${expr.slice(0, 80)}`);
      if (expr.includes("document.__argusTasteDrain(")) return void (calls.drains += 1);
      if (expr === MEDIA_READ) return { ...media };
      if (expr.includes("__argusTastePush")) return void (calls.initRuns += 1);
      if (expr.includes("getAnimations")) return void (calls.settles += 1);
      // A pass's rules in one evaluate (support.ts tasteBatch): each part is one rule's expression in its own try.
      const PART = "\n/*argus-taste-part*/\n";
      if (expr.startsWith("(async () => {\n  const out = [];")) {
        calls.batches += 1;
        return expr.split(PART).slice(1, -1).map((p) => {
          const one = p.slice("try { out.push({ rows: await (".length, p.lastIndexOf(") }); } catch (e)"));
          try {
            return { rows: single(one) };
          } catch (e) {
            return { error: (e instanceof Error ? e.message : String(e)).split("\n")[0] }; // as the page's own catch keeps it
          }
        });
      }
      return single(expr);
    },
    emulateMedia: async (m: Obj) => {
      calls.emulate.push(m);
      Object.assign(media, m);
    },
  };
  const context = { pages: () => [page], addInitScript: async (s: Obj) => void (calls.armed += s.content.includes("__argusTastePush") ? 1 : 0) };
  return { context, calls, media };
}

/** The taste core of `table` loaded as plain JS beside a scratch suite (`.argus/taste.json`, `known/checkout.json`), test.info() stood in. */
function tasteCore(table: Obj, { project = "taste", tasteJson = null as string | null, known = null as Obj[] | null, files = {} as Record<string, string> } = {}) {
  const repo = tempDir();
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(nodePath.dirname(join(repo, f)), { recursive: true });
    writeFileSync(join(repo, f), text);
  }
  const suite = join(repo, "e2e/argus-smoke");
  mkdirSync(join(suite, "known"), { recursive: true });
  if (tasteJson !== null) {
    mkdirSync(join(repo, ".argus"), { recursive: true });
    writeFileSync(join(repo, ".argus/taste.json"), tasteJson);
  }
  if (known) writeFileSync(join(suite, "known/checkout.json"), JSON.stringify(known));
  const info = { project: { name: project }, annotations: [] as Obj[] };
  const js = stripTypeScriptTypes(tasteSource(table)).replace(/await import\("node:fs"\)/g, 'require("node:fs")').replace(/^export /gm, "");
  const api = new Function("test", "path", "REPO", "__dirname", "require", `${js}\nreturn { tasteStep, tasteArm };`)({ info: () => info }, nodePath, repo, suite, createRequire(join(__dirname, "x.js")));
  const notes = (type: string) => info.annotations.filter((a) => a.type === type).map((a) => (type === "argus-info" ? a.description : JSON.parse(a.description)));
  return { api, notes };
}

/** The stand-in probes' answers: what a rule finds in each medium, a probe that throws, rows out of shape. */
const ANSWERS = (rule: string, m: Obj): unknown => {
  const dark = m.colorScheme === "dark";
  switch (rule) {
    case "copy.broken":
      return [{ rule, key: "text|undefined", measured: "undefined", expected: "no broken copy" }];
    case "states.success":
      return new Error("the stand-in broke\nat its second line");
    case "hierarchy.primary-actions":
      return [{ rule, key: "button|Save", measured: 2, expected: 1 }, ...(dark ? [{ rule, key: "button|Dark", measured: 2, expected: 1 }] : [])];
    case "colour.dark-surface":
      return dark ? [{ rule, key: "card|light", measured: 1, expected: 0 }] : new Error("measured outside dark");
    case "motion.reduced":
      return m.reducedMotion === "reduce" ? [{ rule, key: "spinner", measured: 1, expected: 0 }] : new Error("measured outside reduced motion");
    case "contrast.headroom":
      return [{ rule, key: "body", measured: 5.2, expected: 7 }];
    case "density.control-heights":
      return [{ rule, key: "two\nlines", measured: 3, expected: 2 }, { rule: "scale.spacing", key: "k", measured: 1, expected: 0 }, { rule, key: "ok", measured: { x: 1 }, expected: 2 }];
    default:
      return [];
  }
};

describe("argus-live codegen — the taste project (phase 7, S1)", () => {
  it("measures the bar's screen rules with a fixed threshold, each probe's source written once in support.ts", () => {
    const bar = loadBar();
    const t = standInTable();
    const ids = t.rules.map((r: Obj) => r.id);
    expect(ids).toEqual(bar.rules.filter((r: Obj) => FAMILIES[r.family].scope === "screen" && !("peer" in r.threshold) && !("band" in r.threshold) && !TASTE_LANE_ONLY.includes(r.id)).map((r: Obj) => r.id));
    // Peer and band thresholds compare screens, consistency and efficiency compare a cycle, the lane-only rules need peers or the owner's routes: the lane's.
    for (const id of ["scale.spacing", "scale.shadows", "consistent.action", "efficiency.klm", "states.error", "states.recovery", ...TASTE_LANE_ONLY]) expect(ids, id).not.toContain(id);
    // Every rule the suite treats by name is a rule of the bar: a renamed one would silently change its passes.
    for (const id of [...Object.keys(TASTE_MEDIA_RULES), ...TASTE_LANE_ONLY]) expect(bar.rules.some((r: Obj) => r.id === id), id).toBe(true);
    const passes = (id: string) => t.rules.find((r: Obj) => r.id === id).passes;
    expect([passes("colour.dark-surface"), passes("motion.reduced"), passes("copy.broken"), passes("hierarchy.primary-actions")]).toEqual([["parity"], ["reduce"], ["action"], ["light", "dark"]]);
    // Dark parity compares a screen's light and dark censuses: the taste probe's censusOf and rulesFor, with the parity rules alone.
    expect(t.parity).toEqual({ ...CENSUS, bar: { version: bar.version, rules: bar.rules.filter((r: Obj) => /^colour\.dark-/.test(r.id)), frames: bar.frames } });
    expect(tasteTable().parity).toMatchObject({ census: String(censusOf), rules: String(tasteRulesFor) });
    expect(t.rules.filter((r: Obj) => r.info).map((r: Obj) => r.id)).toEqual(bar.rules.filter((r: Obj) => r.info && ids.includes(r.id)).map((r: Obj) => r.id));
    const src = tasteSource(t);
    for (const s of [TSRC, ESRC]) expect(src.split(JSON.stringify(s).slice(1, -1)).length - 1, s).toBe(1);
    expect(src).toContain(`const TASTE_BAR_VERSION = ${bar.version};`);
    expect(check(src)).toEqual({ code: 0, err: "" });
  }, 60_000);

  it("leaves out a rule whose probe is not built yet, and throws any other refusal", () => {
    const one = (expression: (rule: string, probe: string) => unknown) => tasteTable({ expression, sources: { taste: TSRC, ease: ESRC } });
    const t = one((rule, probe) => {
      if (rule === "copy.broken") throw new Error("refused: ruleExpression: not built yet");
      return standIn(rule, probe);
    });
    expect(t.rules.map((r: Obj) => r.id)).not.toContain("copy.broken");
    expect(() => one((rule) => {
      if (rule === "copy.broken") throw new Error("failed: taste: no rule copy.broken");
      return "[]";
    })).toThrow("failed: taste: no rule copy.broken");
    expect(() => one(() => "  ")).toThrow(/^failed: codegen: the taste probe's expression for scale\.off-scale is not a page expression$/);
    // The plugin's own probes, whatever lanes T1 and T2 built so far: no throw.
    expect(() => tasteTable()).not.toThrow();
  });

  it("runs after each action and at each screen of an account, in the taste project only, a journey's allow entries with it", () => {
    const text = spec();
    const calls = [...text.matchAll(/tasteStep\(opened, (\d+), (\d+), "checkout", (true|false), \[\]\)/g)].map((m) => [Number(m[1]), Number(m[2]), m[3] === "true"]);
    // Not after a system step, an expectation or a read; the screen (the last page step, an expectation) is.
    expect(calls).toEqual([[0, 3, false], [0, 4, false], [0, 5, false], [1, 9, false], [2, 10, false], [1, 11, false], [2, 12, false], [1, 14, true]]);
    expect(text).toContain('    if (inProject(["taste"])) {\n      expect.soft(await (await import("./support")).tasteStep(opened, 1, 14, "checkout", true, []), "taste: step 14").toEqual([]);\n    }');
    expect(spec({ smoke: validateSmoke({ browsers: ["firefox"] }).value })).not.toContain("tasteStep");
    const allow = { check: "taste-copy-broken", key: "text|undefined" };
    expect(spec({ smoke: validateSmoke({ journeys: { checkout: { allow: [allow] } } }).value })).toContain(`tasteStep(opened, 1, 14, "checkout", true, [${JSON.stringify(allow)}])`);
    expect(check(text)).toEqual({ code: 0, err: "" });
  }, 60_000);

  it("arms the taste recorders before step 1, right after the test opened its accounts; a suite with no taste project does not", () => {
    const text = spec();
    const lines = text.split("\n");
    const ready = lines.indexOf('    if (inProject(["taste"])) await (await import("./support")).tasteReady(opened);');
    expect(ready).toBeGreaterThan(0);
    // After every account's context is open (open() or the owner's signedIn), before any step runs.
    expect(lines.slice(0, ready).filter((l) => /await (open|signedIn)\(opened/.test(l)).length).toBeGreaterThan(0);
    expect(lines.slice(ready + 1).some((l) => /await (open|signedIn)\(opened/.test(l))).toBe(false);
    expect(lines.slice(0, ready).some((l) => /tasteStep|\.goto\(/.test(l))).toBe(false);
    expect(spec({ smoke: validateSmoke({ browsers: ["firefox"] }).value })).not.toContain("tasteReady");
  }, 60_000);

  it("support.ts arms the recorders in every context open() makes in the taste project, and passes phase 6's scans", () => {
    const text = supportFile({ live: LIVE(), smoke: SMOKE(), roles: ["customer"] });
    expect(text).toContain('  opened.push(context);\n  // The taste project\'s recorders run in every document from the first one on (spec 20.4).\n  if (inProject(["taste"])) await tasteArm(context);\n  return context.newPage();');
    expect(text).toContain(JSON.stringify(TASTE_BUFFER).slice(1, -1));
    expect(text).toContain(tasteSource(tasteTable()));
    // The core waits on events only (an animation's end, a frame), never a clock, and restores media by value. The
    // recorders it installs (TASTE_INIT, one line) keep their own timers: they measure the page, they wait for nothing.
    const whole = tasteSource(standInTable());
    expect(whole.split("\n").filter((l) => l.startsWith("const TASTE_INIT = ")).length).toBe(1);
    const core = whole.split("\n").filter((l) => !l.startsWith("const TASTE_INIT = ")).join("\n");
    for (const banned of ["waitForTimeout", "setTimeout", "sleep(", "networkidle", "colorScheme: null", "reducedMotion: null"]) expect(core, banned).not.toContain(banned);
    expect(text).not.toMatch(/shell|\bexec\(|spawn\(|\/bin\/sh/);
    expect(check(text)).toEqual({ code: 0, err: "" });
  }, 60_000);

  it("the core: notes by default; after an action the action rules; at a screen the census, then reduced motion and dark, the page's media put back", async () => {
    const t = standInTable();
    const core = tasteCore(t);
    const f = fakePage(ANSWERS);
    const opened = [f.context];
    expect(await core.api.tasteStep(opened, 0, 3, "checkout", false, [])).toEqual([]);
    const ids = (pass: string) => t.rules.filter((r: Obj) => r.passes.includes(pass)).map((r: Obj) => r.id);
    expect(f.calls.evaluated).toEqual(ids("action").map((id: string) => `${id}@light/no-preference`));
    expect([f.calls.emulate, f.calls.drains, f.calls.armed, f.calls.initRuns]).toEqual([[], 1, 1, 1]);
    // The action pass's rules in one evaluate, not one a rule.
    expect(f.calls.batches).toBe(1);
    expect(core.notes("argus-taste")).toEqual([{ rule: "copy.broken", step: 3, key: "text|undefined", measured: "undefined", expected: "no broken copy" }]);
    expect(core.notes("argus-info")).toEqual(["taste states.success: the probe failed (the stand-in broke)"]);
    f.calls.evaluated.length = 0;
    expect(await core.api.tasteStep(opened, 0, 5, "checkout", true, [])).toEqual([]);
    // Armed once a context; the census once the animations ended, then each medium after its settle, the page's own media last.
    expect([f.calls.armed, f.calls.initRuns, f.calls.settles]).toEqual([1, 1, 4]);
    expect(f.calls.evaluated).toEqual([
      ...ids("action").map((id: string) => `${id}@light/no-preference`),
      ...ids("light").map((id: string) => `${id}@light/no-preference`),
      ...ids("reduce").map((id: string) => `${id}@light/reduce`),
      ...ids("dark").map((id: string) => `${id}@dark/no-preference`),
    ]);
    expect(f.calls.emulate).toEqual([{ colorScheme: "light", reducedMotion: "reduce" }, { colorScheme: "dark", reducedMotion: "no-preference" }, { colorScheme: "light", reducedMotion: "no-preference" }]);
    // Each (rule, key) once a test; a dark or reduced-motion finding's key names its medium.
    expect(core.notes("argus-taste")).toEqual([
      { rule: "copy.broken", step: 3, key: "text|undefined", measured: "undefined", expected: "no broken copy" },
      { rule: "hierarchy.primary-actions", step: 5, key: "button|Save", measured: 2, expected: 1 },
      { rule: "colour.dark-surface", step: 5, key: "card|light", measured: 1, expected: 0 },
      { rule: "motion.reduced", step: 5, key: "spinner|reduce", measured: 1, expected: 0 },
      { rule: "hierarchy.primary-actions", step: 5, key: "button|Dark|dark", measured: 2, expected: 1 },
    ]);
    // Information rules are lines, never notes; rows out of the finding shape are counted, never shown.
    expect(core.notes("argus-info").sort()).toEqual(["taste contrast.headroom step 5: body: 5.2 (expected 7)", "taste density.control-heights: 3 result(s) not in the finding shape, dropped", "taste states.success: the probe failed (the stand-in broke)"]);
    // A page that answered dark and reduced motion of its own gets exactly those back, never a null.
    const g = fakePage(ANSWERS, { colorScheme: "dark", reducedMotion: "reduce" });
    await tasteCore(t).api.tasteStep([g.context], 0, 5, "checkout", true, []);
    expect(g.calls.emulate.at(-1)).toEqual({ colorScheme: "dark", reducedMotion: "reduce" });
    expect(g.media).toEqual({ colorScheme: "dark", reducedMotion: "reduce" });
  });

  it("the core: a gated rule fails its step as phase 6's violation unless known/<id>.json or the journey's allow lists it; an information rule never gates", async () => {
    const answers = (rule: string, m: Obj): unknown =>
      rule === "hierarchy.primary-actions"
        ? ["Save", "Delete", ...(m.colorScheme === "dark" ? ["Dark"] : [])].map((n) => ({ rule, key: `button|${n}`, measured: 2, expected: 1 }))
        : rule === "contrast.headroom"
          ? [{ rule, key: "body", measured: 5.2, expected: 7 }]
          : [];
    const check = tasteCheckName("hierarchy.primary-actions");
    expect(check).toBe("taste-hierarchy-primary-actions");
    expect(check).toMatch(/^[a-z][a-z0-9-]{0,39}$/);
    const core = tasteCore(standInTable(), { tasteJson: JSON.stringify({ gate: ["hierarchy.primary-actions", "contrast.headroom"] }), known: [{ check, key: "button|Save" }] });
    const v = await core.api.tasteStep([fakePage(answers).context], 0, 5, "checkout", true, [{ check, key: "button|Dark|dark" }]);
    expect(v).toEqual([{ check, step: 5, key: "button|Delete", detail: "measured 2, expected 1" }]);
    expect(core.notes("argus-violation")).toEqual(v);
    // Only the ungated rows stay notes (the stood-in census's dark-parity row).
    expect(core.notes("argus-taste")).toEqual([{ rule: "colour.dark-surface", step: 5, key: "card|light", measured: 1, expected: 0 }]);
    expect(core.notes("argus-info")).toEqual(["taste contrast.headroom step 5: body: 5.2 (expected 7)"]);
  });

  it("the core fills each taste expression's scale when it runs: taste.json's frame and live.json's tokens in px, null without them", async () => {
    const scaled = (rule: string, probe: string) => `(${probe === "ease" ? ESRC : TSRC})(${JSON.stringify(rule)}, ${JSON.stringify(TASTE_SCALE_MARK)})`;
    const table = tasteTable({ expression: scaled, sources: { taste: TSRC, ease: ESRC }, census: CENSUS });
    // The plugin's own taste expressions hold the marks; support.ts never bakes a scale in.
    expect(tasteTable().rules.find((r: Obj) => r.id === "scale.off-scale").expr).toContain(JSON.stringify(TASTE_SCALE_MARK.tokens));
    const files = { ".argus/live.json": JSON.stringify({ tokens: { css: "design/tokens.css" } }), "design/tokens.css": ":root { --space-1: 4px; --space-2: 0.5rem; --radius-md: 6px; }" };
    const f = fakePage(() => []);
    await tasteCore(table, { tasteJson: JSON.stringify({ frame: "material" }), files }).api.tasteStep([f.context], 0, 5, "checkout", true, []);
    expect(f.calls.scales.length).toBeGreaterThan(0);
    expect(new Set(f.calls.scales)).toEqual(new Set(['{"tokens":{"spacing":[4,8],"radius":[6]},"frame":"material"}']));
    const g = fakePage(() => []);
    await tasteCore(table).api.tasteStep([g.context], 0, 5, "checkout", true, []);
    expect(new Set(g.calls.scales)).toEqual(new Set(['{"tokens":null,"frame":null}']));
  });

  it("the core: off leaves a rule unmeasured; a taste.json that is not JSON, or gates a rule the suite does not measure, fails the step by name; another project runs nothing", async () => {
    const f = fakePage(ANSWERS);
    await tasteCore(standInTable(), { tasteJson: JSON.stringify({ off: ["copy.broken"] }) }).api.tasteStep([f.context], 0, 3, "checkout", false, []);
    expect(f.calls.evaluated.length).toBeGreaterThan(0);
    expect(f.calls.evaluated.filter((e) => e.startsWith("copy.broken@"))).toEqual([]);
    const v = loadBar().version;
    for (const [json, msg] of [
      ["{not json", "argus-smoke: .argus/taste.json is not valid JSON"],
      [JSON.stringify({ gate: "copy.broken" }), `argus-smoke: .argus/taste.json gate must list rule ids of taste-bar ${v}`],
      [JSON.stringify({ gate: ["scale.spacing", "nope.rule"] }), `argus-smoke: .argus/taste.json gate names scale.spacing, nope.rule: no rule the suite measures in taste-bar ${v}`],
    ]) {
      await expect(tasteCore(standInTable(), { tasteJson: json }).api.tasteStep([fakePage(ANSWERS).context], 0, 3, "checkout", false, []), json).rejects.toThrow(msg);
    }
    const g = fakePage(ANSWERS);
    expect(await tasteCore(standInTable(), { project: "chromium" }).api.tasteStep([g.context], 0, 5, "checkout", true, [])).toEqual([]);
    expect([g.calls.armed, g.calls.initRuns, g.calls.evaluated.length, g.calls.emulate.length]).toEqual([0, 0, 0, 0]);
  });

  it("the bar's version joins every header's digest: a header naming another bar is not its body's; a header from before the bar still reads", () => {
    const v = loadBar().version;
    const text = supportFile({ live: LIVE(), smoke: SMOKE(), roles: [] });
    expect(headerDigest(text)).toMatchObject({ ok: true, bar: v });
    expect(text.split("\n")[0]).toContain(`(argus-live codegen ${CODEGEN_VERSION}, taste-bar ${v}, digest `);
    expect(headerDigest(text.replace(`taste-bar ${v},`, `taste-bar ${v + 1},`)).ok).toBe(false);
    const body = "a\nb\n";
    const before = `// Generated by sapu (argus-live codegen 1, digest ${createHash("sha256").update(body).digest("hex")}) for x: do not edit; smoke propose regenerates it.\n${body}`;
    expect(headerDigest(before)).toEqual({ digest: createHash("sha256").update(body).digest("hex"), ok: true, bar: null });
    expect(headerDigest(withHeader(body, { what: "for x", bar: v + 2 }))).toMatchObject({ ok: true, bar: v + 2 });
  });

  it("smoke check names every file of a suite generated against an older bar stale, never hand-edited", () => {
    const main = tempDir();
    const dir = join(main, "e2e/argus-smoke");
    mkdirSync(join(dir, "journeys"), { recursive: true });
    mkdirSync(join(main, ".argus"), { recursive: true });
    const smokeRaw = { ci: { web_server: [{ command: "npm start", url: "http://localhost:4100/health" }], ports: { web: 4100 } } };
    writeFileSync(join(main, ".argus/live.json"), JSON.stringify(LIVE()));
    writeFileSync(join(main, ".argus/smoke.json"), JSON.stringify(smokeRaw));
    writeFileSync(join(dir, "journeys/checkout.json"), JSON.stringify({ journey: "checkout", path: PATH(), admitted: null }));
    const files = generateSuite({ paths: [{ id: "checkout", path: PATH() }], live: LIVE(), smoke: validateSmoke(smokeRaw).value }) as Record<string, string>;
    for (const [f, t] of Object.entries(files)) writeFileSync(join(dir, f), t);
    expect(smokeCheck(main).lines).toEqual([`smoke check: ${Object.keys(files).length} generated files current`]);
    // The same suite as the bar before this one would have written it: its version in support.ts and in every header.
    const v = loadBar().version;
    for (const [f, t] of Object.entries(files)) {
      const lines = t.split("\n");
      const i = lines.findIndex((l) => l.includes("taste-bar "));
      const body = [...lines.slice(0, i), ...lines.slice(i + 1)].join("\n").replace(`const TASTE_BAR_VERSION = ${v};`, `const TASTE_BAR_VERSION = ${v - 1};`);
      const digest = createHash("sha256").update(`taste-bar ${v - 1}\n${body}`).digest("hex");
      lines[i] = lines[i].replace(/taste-bar [0-9]+, digest [0-9a-f]{64}/, `taste-bar ${v - 1}, digest ${digest}`);
      lines.splice(0, lines.length, ...[...lines.slice(0, i), lines[i], ...body.split("\n").slice(i)]);
      writeFileSync(join(dir, f), lines.join("\n"));
      expect(headerDigest(lines.join("\n")), f).toMatchObject({ ok: true, bar: v - 1 });
    }
    const r = smokeCheck(main);
    expect(r.code).toBe(1);
    expect(r.lines.slice(0, -1)).toEqual(Object.keys(files).sort().map((f) => `stale e2e/argus-smoke/${f} (its header's digest is of another generation)`));
  }, 60_000);
});

/** An in-page stand-in for both probes on the fixture app: what it finds depends on the emulated media, so a pass in the wrong one shows. */
const RSRC = `(rule) => {
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const heading = document.querySelector("h1, h2");
  if (rule === "hierarchy.primary-actions") return heading ? [{ rule, key: "heading|" + heading.textContent.trim(), measured: 2, expected: 1 }] : [];
  if (rule === "colour.dark-surface") return [{ rule, key: dark ? "main|light" : "measured-outside-dark", measured: 1, expected: 0 }];
  if (rule === "motion.reduced") return reduce ? [] : [{ rule, key: "measured-outside-reduce", measured: 1, expected: 0 }];
  if (rule === "contrast.headroom") return [{ rule, key: "body", measured: 5.5, expected: 7 }];
  if (rule === "copy.broken") return dark || reduce ? [{ rule, key: "media-left-emulated", measured: 1, expected: 0 }] : [];
  return [];
}`;
/** The dark-parity census stood in for the fixture app: dark measured in dark only, the page's own scheme put back by value. */
const DARK_CENSUS = async (page: any) => {
  const own = await page.evaluate('matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"');
  await page.emulateMedia({ colorScheme: "dark" });
  const dark = await page.evaluate('matchMedia("(prefers-color-scheme: dark)").matches && Boolean(document.querySelector("h1, h2"))');
  await page.emulateMedia({ colorScheme: own });
  return { themes: "dual", dark };
};
const DARK_RULES = (screen: any, bar: any) => (screen.dark ? bar.rules.map((r: any) => ({ rule: r.id, key: "main|light", measured: 1, expected: 0 })) : [{ rule: "colour.dark-surface", key: "measured-outside-dark", measured: 1, expected: 0 }]).filter((f: any) => f.rule === "colour.dark-surface");
/** The scorecard script as the taste job runs it: from the suite's directory, the step summary in `summary`. */
const scorecard = (dir: string, summary: string) => spawnSync(process.execPath, ["-", "test-results/results.json", "../../.argus/taste.json", "support.ts"], { cwd: dir, input: TASTE_SUMMARY, encoding: "utf8", env: { PATH: process.env.PATH, GITHUB_STEP_SUMMARY: summary } });
/** A test's notes of `type` in a Playwright JSON report, for the project `project`. */
const notesIn = (results: Obj, type: string, project = "taste"): Obj[] => {
  const tests = (s: Obj): Obj[] => [...(s.specs ?? []).flatMap((x: Obj) => x.tests), ...(s.suites ?? []).flatMap(tests)];
  return results.suites.flatMap(tests).filter((t: Obj) => t.projectName === project).flatMap((t: Obj) => t.results.at(-1).annotations ?? []).filter((a: Obj) => a.type === type).map((a: Obj) => (type === "argus-info" ? a.description : JSON.parse(a.description)));
};

describe("argus-live codegen — the taste project and its scorecard under the pinned runner", () => {
  it("advisory by default (notes, green, the media put back); a gated rule fails its step and the job; its known row passes again", async () => {
    vi.resetModules();
    const expression = (rule: string) => `(${RSRC})(${JSON.stringify(rule)})`;
    vi.doMock("../plugins/sapu/scripts/argus-live-taste.mjs", async (orig) => ({ ...(await orig<Obj>()), TASTE_SOURCE: RSRC, ruleExpression: expression, censusOf: DARK_CENSUS, rulesFor: DARK_RULES }));
    vi.doMock("../plugins/sapu/scripts/argus-live-ease.mjs", async (orig) => ({ ...(await orig<Obj>()), ruleExpression: expression }));
    let generate: (x: Obj) => Obj;
    try {
      generate = (await import("../plugins/sapu/scripts/argus-live-codegen.mjs")).generateSuite;
    } finally {
      vi.doUnmock("../plugins/sapu/scripts/argus-live-taste.mjs");
      vi.doUnmock("../plugins/sapu/scripts/argus-live-ease.mjs");
      vi.resetModules();
    }
    const path = [{ as: "anon", do: "goto", path: "/login" }, { as: "anon", do: "fill", target: { label: "Email" }, value: "taste@example.test" }, { as: "anon", expect: "visible", target: { role: "heading", name: "Sign in" } }];
    const { dir, files, run } = await fixtureSuite({ paths: [{ id: "sign-in-page", path }], smokeExtra: { journeys: { "sign-in-page": { screens: [1] } } }, generate, projects: ["taste"] });
    expect(files["support.ts"].split(JSON.stringify(RSRC).slice(1, -1)).length - 1).toBe(1);
    const summary = join(tempDir(), "summary.md");
    // 1. No .argus/taste.json: advisory notes, a green run and a green scorecard.
    const advisory = run([]);
    expect(advisory.status, advisory.out).toBe(0);
    const heading = { rule: "hierarchy.primary-actions", step: 1, key: "heading|Sign in", measured: 2, expected: 1 };
    expect(notesIn(advisory.results, "argus-taste")).toEqual([heading, { rule: "colour.dark-surface", step: 1, key: "main|light", measured: 1, expected: 0 }]);
    expect(notesIn(advisory.results, "argus-info")).toEqual(["taste contrast.headroom step 1: body: 5.5 (expected 7)"]);
    expect(notesIn(advisory.results, "argus-violation")).toEqual([]);
    // Each rule measured in its own medium only, and the step after the screen in the page's own again.
    expect(advisory.out).not.toMatch(/measured-outside|media-left-emulated/);
    expect(JSON.stringify(advisory.results)).not.toMatch(/measured-outside|media-left-emulated/);
    const s1 = scorecard(dir, summary);
    expect(s1.status, s1.stderr).toBe(0);
    expect(readFileSync(summary, "utf8")).toContain("advisory: .argus/taste.json gates no rule, so this job stays green");
    expect(readFileSync(summary, "utf8")).toContain("| `sign-in-page` | 1 | `hierarchy.primary-actions` | `heading\\|Sign in` | `2` | `1` |  |");
    // 2. The owner gates the rule: its finding is phase 6's violation, the step fails, so does the scorecard.
    mkdirSync(join(dir, "../../.argus"), { recursive: true });
    writeFileSync(join(dir, "../../.argus/taste.json"), JSON.stringify({ gate: ["hierarchy.primary-actions"] }));
    const gated = run([]);
    expect(gated.status, gated.out).toBe(1);
    const violation = { check: "taste-hierarchy-primary-actions", step: 1, key: "heading|Sign in", detail: "measured 2, expected 1" };
    expect(notesIn(gated.results, "argus-violation")).toEqual([violation]);
    expect(notesIn(gated.results, "argus-taste").map((n) => n.rule)).toEqual(["colour.dark-surface"]);
    writeFileSync(summary, "");
    const s2 = scorecard(dir, summary);
    expect(s2.status).toBe(1);
    expect(readFileSync(summary, "utf8")).toContain("**gated**");
    expect(readFileSync(summary, "utf8")).toContain("**The taste job fails:**");
    // 3. Adopted as known (phase 6's known/<id>.json): green again, under the gate.
    mkdirSync(join(dir, "known"), { recursive: true });
    writeFileSync(join(dir, "known/sign-in-page.json"), JSON.stringify([{ check: violation.check, key: violation.key }]));
    const known = run([]);
    expect(known.status, known.out).toBe(0);
    expect(notesIn(known.results, "argus-violation")).toEqual([]);
    writeFileSync(summary, "");
    const s3 = scorecard(dir, summary);
    expect(s3.status, readFileSync(summary, "utf8")).toBe(0);
    expect(readFileSync(summary, "utf8")).toContain("gating: `hierarchy.primary-actions`");
  }, 600_000);
});

describe("smoke workflow — the taste job (phase 7, S2)", () => {
  const SHAS: Record<string, string> = { "actions/checkout": "1".repeat(40), "actions/setup-node": "2".repeat(40), "actions/upload-artifact": "3".repeat(40) };
  const DIGEST = `sha256:${"d".repeat(64)}`;
  /** A repo with the contract, live.json, smoke.json (a web server, `smoke` over it) and one suite path; gh and the registry answer. */
  const flow = ({ smoke = {} as Obj, live = {} as Obj } = {}) => {
    const main = committed();
    mkdirSync(join(main, ".argus"), { recursive: true });
    mkdirSync(join(main, ".claude"), { recursive: true });
    writeFileSync(join(main, ".claude/sapu.json"), JSON.stringify(FIXTURE_CONTRACT));
    git(main, "add", ".");
    git(main, "-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", "commit", "-qm", "contract");
    writeFileSync(join(main, ".argus/live.json"), JSON.stringify({ ...LIVE(), ...live }));
    writeFileSync(join(main, ".argus/smoke.json"), JSON.stringify({ ci: { web_server: [{ command: "npm run start:ci", url: "http://localhost:3100/" }] }, ...smoke }));
    mkdirSync(join(main, "e2e/argus-smoke/journeys"), { recursive: true });
    writeFileSync(join(main, "e2e/argus-smoke/journeys/checkout.json"), JSON.stringify({ journey: "checkout", path: PATH(), admitted: null }));
    const runner = (argv: string[], opts: Obj = {}) => {
      if (argv[0] === "curl") return { status: 0, stdout: `HTTP/2 200\r\ndocker-content-digest: ${DIGEST}\r\n\r\n`, stderr: "" };
      if (argv[0] !== "gh") return runProc(argv, opts);
      const m = /^repos\/([^/]+\/[^/]+)\/commits\/(.+)$/.exec(argv[2] ?? "");
      return m ? { status: 0, stdout: `${SHAS[m[1]]}\n`, stderr: "" } : { status: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" };
    };
    return { main, lines: smokeWorkflow(main, { runner }).lines as string[] };
  };
  const job = (lines: string[], name: string) => {
    const i = lines.indexOf(`  ${name}:`);
    expect(i, name).toBeGreaterThan(-1);
    const end = lines.findIndex((l, k) => k > i && /^ {2}[a-z]/.test(l));
    return lines.slice(i, end < 0 ? undefined : end);
  };
  const stepsOf = (j: string[]) => j.slice(j.indexOf("    steps:") + 1).join("\n").split(/\n(?= {6}- )/);
  const matrix = (lines: string[], j: string) => /^ {8}project: \[(.*)\]$/.exec(job(lines, j).find((l) => l.startsWith("        project: ["))!)![1].split(", ");
  const SUITE = "hashFiles('e2e/argus-smoke/package.json') != ''";

  it("a separate taste job in the test job's container, checkout, install and env-only inputs; its run never fails the job, its secrets in that step only", () => {
    const { lines } = flow();
    const taste = job(lines, "taste");
    const test = job(lines, "test");
    for (const same of ["    if: ", "    runs-on: ", "      image: ", "      options: ", "    timeout-minutes: ", "        working-directory: "]) expect(taste.find((l) => l.startsWith(same)), same).toBe(test.find((l) => l.startsWith(same)));
    expect(taste.join("\n")).not.toContain("strategy:");
    expect(taste.slice(0, taste.indexOf("    steps:"))).toEqual(expect.arrayContaining(["    env:", "      HOME: /root"]));
    // The job itself gates: only its run step may fail without failing it.
    expect(taste).not.toContain("    continue-on-error: true");
    const steps = stepsOf(taste);
    expect(steps[0]).toMatch(/^ {6}- uses: actions\/checkout@[0-9a-f]{40} # v\d+\n {8}with:\n {10}persist-credentials: false$/);
    expect(steps[1]).toBe(`      - run: npm ci --ignore-scripts\n        if: ${SUITE}`);
    expect(steps[2].split("\n").slice(0, 3)).toEqual(["      - run: npx playwright test --grep-invert @quarantine --project setup --project taste", "        continue-on-error: true", `        if: ${SUITE}`]);
    for (const s of steps.slice(1)) expect(s, s.split("\n")[0]).toMatch(new RegExp(`\\n {8}if: (\\$\\{\\{ !cancelled\\(\\) && ${SUITE.replace(/[()'.]/g, "\\$&")} \\}\\}|${SUITE.replace(/[()'.]/g, "\\$&")})(\\n|$)`));
    // Secrets: in the step that runs the suite, never npm ci, the scorecard or an action; no input of the dispatch.
    expect(taste.slice(0, taste.indexOf("    steps:")).join("\n")).not.toContain("secrets.");
    expect(steps.filter((s) => s.includes("secrets."))).toEqual([steps[2]]);
    expect(taste.join("\n")).not.toContain("inputs.");
    // The results kept 7 days under a name outside ci.artifact's prefix (smoke ci triages the gating jobs only); never the signed-in states.
    expect(steps.at(-1)).toBe(`      - uses: actions/upload-artifact@${SHAS["actions/upload-artifact"]} # v4\n        if: \${{ !cancelled() && ${SUITE} }}\n        with:\n          name: taste-argus-smoke-results\n          path: e2e/argus-smoke/test-results/\n          retention-days: 7`);
    expect(taste.join("\n")).not.toContain(".auth");
    expect(lines.every((l) => !l.includes("\t") && !/\s$/.test(l))).toBe(true);
  }, 60_000);

  it("one project list, codegen's suiteProjects: the test and quarantine matrices leave taste to its job, the baseline run holds it; no chromium, no taste job", () => {
    for (const [smoke, live] of [[{}, {}], [{ browsers: ["firefox", "msedge"] }, { viewports: [1280, 390] }], [{ browsers: ["webkit", "chromium"] }, { locales: ["de-DE"] }]] as [Obj, Obj][]) {
      const { main, lines } = flow({ smoke, live });
      const names = suiteProjects({ live: JSON.parse(readFileSync(join(main, ".argus/live.json"), "utf8")), smoke: validateSmoke({ ...smoke }).value }).map((p: Obj) => p.name);
      expect(matrix(lines, "test"), JSON.stringify(smoke)).toEqual(names.filter((n: string) => n !== "msedge" && n !== "taste"));
      expect(matrix(lines, "quarantine")).toEqual(matrix(lines, "test"));
      expect(matrix(lines, "baseline")).toEqual(names.filter((n: string) => n !== "msedge"));
      expect(lines.includes("  taste:"), JSON.stringify(smoke)).toBe(names.includes("taste"));
    }
  }, 60_000);

  it("the scorecard step runs TASTE_SUMMARY from the suite's directory by a quoted heredoc, nothing of GitHub's expressions inside", () => {
    const { lines } = flow();
    const steps = stepsOf(job(lines, "taste"));
    const card = steps[3].split("\n");
    expect(card.slice(0, 3)).toEqual(["      - name: The taste scorecard, in the job summary", `        if: \${{ !cancelled() && ${SUITE} }}`, "        run: |"]);
    const block = card.slice(3).map((l) => (l === "" ? "" : l.slice(10)));
    expect(card.slice(3).every((l) => l === "" || l.startsWith("          "))).toBe(true);
    expect(block[0]).toBe("node - test-results/results.json ../../.argus/taste.json support.ts <<'ARGUS_TASTE'");
    expect(block.slice(1, -1).join("\n")).toBe(TASTE_SUMMARY);
    expect(block.at(-1)).toBe("ARGUS_TASTE");
    for (const banned of ["${{", "\t", "ARGUS_TASTE"]) expect(TASTE_SUMMARY, banned).not.toContain(banned);
    // The block as the runner's shell gets it: from the suite's directory, with no results yet.
    const repo = tempDir();
    const dir = join(repo, "e2e/argus-smoke");
    mkdirSync(dir, { recursive: true });
    const summary = join(repo, "summary.md");
    const r = spawnSync("bash", ["-e", "-c", block.join("\n")], { cwd: dir, encoding: "utf8", env: { PATH: process.env.PATH, GITHUB_STEP_SUMMARY: summary } });
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(summary, "utf8")).toContain("No results.json: the taste project did not run");
  }, 60_000);

  /** A suite directory holding `results` (a Playwright JSON report), support.ts's header and, unless null, taste.json. */
  const suiteWith = (results: Obj | string | null, taste: Obj | string | null = null) => {
    const repo = tempDir();
    const dir = join(repo, "e2e/argus-smoke");
    mkdirSync(join(dir, "test-results"), { recursive: true });
    if (results !== null) writeFileSync(join(dir, "test-results/results.json"), typeof results === "string" ? results : JSON.stringify(results));
    writeFileSync(join(dir, "support.ts"), `// Generated by sapu (argus-live codegen 1, taste-bar 4, digest ${"0".repeat(64)}) from x: do not edit; smoke propose regenerates it.\n`);
    if (taste !== null) {
      mkdirSync(join(repo, ".argus"), { recursive: true });
      writeFileSync(join(repo, ".argus/taste.json"), typeof taste === "string" ? taste : JSON.stringify(taste));
    }
    const summary = join(repo, "summary.md");
    const r = scorecard(dir, summary);
    return { status: r.status, text: existsSync(summary) ? readFileSync(summary, "utf8") : "", log: r.stdout };
  };
  const report = (...tests: Obj[]) => ({ suites: [{ title: "x.spec.ts", specs: tests.map(({ title, project = "taste", status = "expected", notes = [], tries = null }) => ({ title, tests: [{ projectName: project, status, results: tries ?? [{ status: status === "expected" ? "passed" : "failed", annotations: notes }] }] })) }] });
  const taste = (v: Obj) => ({ type: "argus-taste", description: JSON.stringify(v) });
  /** Markdown `md` split into its code spans' words and the text outside them (a span: a run of n backticks to the next run of exactly n). */
  const spansOf = (md: string) => {
    const spans: string[] = [];
    let outside = "";
    for (let i = 0; i < md.length; ) {
      const n = (/^`+/.exec(md.slice(i)) ?? [""])[0].length;
      if (!n) {
        outside += md[i];
        i += 1;
        continue;
      }
      const close = new RegExp(`(?<!\`)\`{${n}}(?!\`)`, "g");
      close.lastIndex = i + n;
      const end = close.exec(md);
      if (!end) throw new Error(`an unclosed code span at ${i}`);
      spans.push(md.slice(i + n, end.index).replace(/^ (.*) $/s, "$1"));
      i = end.index + n;
    }
    return { spans, outside };
  };

  it("the scorecard: findings by family and in full, the bar's version, advisory green; another project's notes and a retry's first notes left out", () => {
    const r = suiteWith(report(
      { title: "checkout", notes: [taste({ rule: "hierarchy.primary-actions", step: 5, key: "button|Save", measured: 2, expected: 1 }), taste({ rule: "copy.broken", step: 3, key: "text|undefined", measured: "undefined", expected: "no broken copy" }), { type: "argus-info", description: "taste contrast.headroom step 5: body: 5.2 (expected 7)" }, { type: "argus-info", description: "design tokens: not the taste project's" }] },
      { title: "checkout", project: "chromium", notes: [taste({ rule: "copy.broken", step: 1, key: "elsewhere", measured: 1, expected: 0 })] },
      { title: "refund", status: "flaky", tries: [{ status: "failed", annotations: [taste({ rule: "copy.broken", step: 2, key: "first-try", measured: 1, expected: 0 })] }, { status: "passed", annotations: [taste({ rule: "copy.broken", step: 2, key: "last-try", measured: 1, expected: 0 })] }] },
    ));
    expect(r.status, r.text).toBe(0);
    expect(r.log).toBe("taste: 3 finding(s), advisory\n");
    expect(r.text).toContain("## Taste and usability\n\ntaste-bar 4 · advisory: .argus/taste.json gates no rule, so this job stays green\n\n**3** finding(s) in **2** journey(s) · **0** gated · **1** information line(s) · 2 of 2 taste test(s) passed\n");
    expect(r.text).toContain("| Family | Findings |\n|---|---:|\n| `copy` | 2 |\n| `hierarchy` | 1 |\n");
    expect(r.text).toContain("| `checkout` | 5 | `hierarchy.primary-actions` | `button\\|Save` | `2` | `1` |  |");
    expect(r.text).toContain("| `refund` | 2 | `copy.broken` | `last-try` | `1` | `0` |  |");
    expect(r.text).toContain("- `checkout`: `taste contrast.headroom step 5: body: 5.2 (expected 7)`");
    for (const gone of ["elsewhere", "first-try", "design tokens"]) expect(r.text, gone).not.toContain(gone);
    expect(r.text).toContain("The taste job passes.");
  }, 60_000);

  it("the scorecard: page words inert in Markdown, one line, at most 200 characters", () => {
    const evil = "<img src=x onerror=alert(1)> @owner https://evil.example/x [link](https://evil.example) ``` | `code` \u202enoisrev\u202c\nnext line " + "k".repeat(400);
    const r = suiteWith(report({ title: "checkout", notes: [taste({ rule: "copy.broken", step: 3, key: evil, measured: evil, expected: 0 }), { type: "argus-info", description: `taste copy.vague step 3: ${evil}` }] }));
    expect(r.status).toBe(0);
    const { spans, outside } = spansOf(r.text);
    for (const live of ["<img", "@owner", "https://", "](", "\u202e", "kkkk"]) expect(outside, live).not.toContain(live);
    const long = spans.filter((w) => w.includes("onerror"));
    expect(long.length).toBe(3);
    for (const w of long) {
      expect(Array.from(w.replace(/\\\|/g, "|")).length, w).toBeLessThanOrEqual(200);
      expect(w.endsWith("…"), w).toBe(true);
      expect(w).not.toMatch(/[\u202a-\u202e]/);
    }
    // One table row a finding: the newline in the page's words did not split it.
    expect(r.text.split("\n").filter((l) => l.startsWith("| `checkout` |")).length).toBe(1);
  }, 60_000);

  it("the scorecard gates only when taste.json gates a rule: a gated violation, a taste test that did not pass, or no results fail it; a taste.json that is not JSON fails it", () => {
    const violation = { type: "argus-violation", description: JSON.stringify({ check: "taste-hierarchy-primary-actions", step: 5, key: "button|Delete", detail: "measured 2, expected 1" }) };
    const gate = { gate: ["hierarchy.primary-actions"] };
    const failed = suiteWith(report({ title: "checkout", status: "unexpected", notes: [violation] }), gate);
    expect(failed.status).toBe(1);
    expect(failed.text).toContain("gating: `hierarchy.primary-actions`");
    expect(failed.text).toContain("| `checkout` | 5 | `hierarchy.primary-actions` | `button\\|Delete` | `measured 2, expected 1` |  | **gated** |");
    expect(failed.text).toContain("**The taste job fails:** a gated rule is violated, or a taste test did not pass so a gated rule went unmeasured.");
    expect(failed.log).toBe("taste: failed\n");
    // Under a gate, a run that measured nothing fails too; an advisory one stays green whatever happened.
    expect(suiteWith(report({ title: "checkout", status: "unexpected" }), gate).status).toBe(1);
    // The suite's own refusal of taste.json is shown; any other error (it may quote the page) is not.
    const refusal = "argus-smoke: .argus/taste.json gate names ai.stop: no rule the suite measures in taste-bar 4";
    const why = suiteWith(report({ title: "checkout", status: "unexpected", tries: [{ status: "failed", annotations: [], error: { message: `${refusal}\n    at tasteConfig` } }] }, { title: "refund", status: "unexpected", tries: [{ status: "failed", annotations: [], error: { message: "expect(locator).toHaveText(expected) <b>page words</b>" } }] }), { gate: ["ai.stop"] });
    expect(why.status).toBe(1);
    expect(why.text).toContain(`- \`${refusal}\``);
    expect(why.text).not.toContain("page words");
    expect(suiteWith(report({ title: "checkout", status: "skipped" }), gate).status).toBe(1);
    expect(suiteWith(null, gate).status).toBe(1);
    expect(suiteWith(report(), gate).status).toBe(1);
    expect(suiteWith(report({ title: "checkout" }), gate).status).toBe(0);
    for (const advisory of [report({ title: "checkout", status: "unexpected", notes: [violation] }), null, "not json"]) expect(suiteWith(advisory).status, JSON.stringify(advisory)).toBe(0);
    expect(suiteWith(report({ title: "checkout", status: "unexpected" })).text).toContain("Not passed: `checkout` (`unexpected`). The test job gates the paths themselves.");
    expect(suiteWith("not json").text).toContain("results.json is not Playwright's JSON report.");
    for (const bad of ["{not json", JSON.stringify({ gate: "x" }), JSON.stringify({ gate: ["Not A Rule"] }), "[]"]) {
      const r = suiteWith(report({ title: "checkout" }), bad);
      expect(r.status, bad).toBe(1);
      expect(r.text).toContain("**.argus/taste.json is not JSON with a list of rule ids under gate: the taste job cannot tell what gates, so it fails.**");
    }
  }, 60_000);
});
