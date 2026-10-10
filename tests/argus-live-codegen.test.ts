// tests/argus-live-codegen.test.ts — the smoke suite's generator (spec §19.5): every rule is pinned by scanning
// the generated text, the RED test goes through the same step builder, and the suite generated for the
// fixture app runs green under the pinned runner (a machine without Chrome fails here, never skips).
import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { browserTools, cleanTemps, example, freePort, PW, SERVER, tempDir, TOTP } from "./helpers/argus-live";
// @ts-expect-error — plain ESM script without types
import { authSetup, CODEGEN_VERSION, generateSuite, headerDigest, packageJson, SMOKE_AXE, SMOKE_PLAYWRIGHT, smokeConfig, smokeSpec, suiteGitignore, supportFile, TOTP_SOURCE } from "../plugins/sapu/scripts/argus-live-codegen.mjs";
// @ts-expect-error — plain ESM script without types
import { SMOKE_DEFAULTS, validateSmoke } from "../plugins/sapu/scripts/argus-live-config.mjs";
// @ts-expect-error — plain ESM script without types
import { loginStageSource, totp } from "../plugins/sapu/scripts/argus-live-login.mjs";
// @ts-expect-error — plain ESM script without types
import { redTest } from "../plugins/sapu/scripts/argus-live-redtest.mjs";
// @ts-expect-error — plain ESM script without types
import { parseRepro } from "../plugins/sapu/scripts/argus-live-steps.mjs";

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

  it("refuses what path mode refuses, and a journey id of another shape", () => {
    expect(() => spec({ path: [...PATH(), { as: "sales", expect: "visible", target: { text: "x" }, final: "handoff" }] })).toThrow("refused: repro: step 15: a path has no final");
    expect(() => spec({ path: [{ as: "customer", do: "click", target: { text: "Pay" } }, { as: "customer", expect: "visible", target: { text: "Paid" } }] })).toThrow("refused: repro: step 1: an action's target in a path is");
    expect(() => spec({ id: "x\nprocess.exit()" })).toThrow("failed: codegen: a journey id is kebab-case");
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
      expect(text, file).toContain(`argus-live codegen ${CODEGEN_VERSION}, digest ${h.digest}`);
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
    expect(projectNames(config)).toEqual(["setup", "chromium", "firefox", "webkit", "chromium-390", "a11y"]);
    const byName = Object.fromEntries(config.projects.map((p: Obj) => [p.name, p]));
    expect(byName.firefox.use).toEqual({ browserName: "firefox" });
    expect(byName.webkit.use).toEqual({ browserName: "webkit" });
    expect(byName["chromium-390"].use).toEqual({ browserName: "chromium", viewport: { width: 390, height: 900 } });
    expect(byName.a11y.use).toEqual({ browserName: "chromium" });
    // The first viewport is every other project's.
    expect(config.use.viewport).toEqual({ width: 1440, height: 900 });
    for (const live of [{ ...LIVE(), locales: ["de-DE"] }, { ...LIVE(), pseudo_locales: ["en-XA"] }]) expect(projectNames(evalConfig(smokeConfig({ live, smoke: SMOKE() })).config)).toContain("i18n");
    expect(projectNames(evalConfig(smokeConfig({ live: { ...LIVE(), viewports: [1280] }, smoke: SMOKE() })).config)).toEqual(["setup", "chromium", "firefox", "webkit", "a11y"]);
  });

  it("every project but setup depends on setup, and smoke.json's browsers choose the engines", () => {
    const { config } = evalConfig(smokeConfig({ live: LIVE(), smoke: SMOKE() }));
    for (const p of config.projects.filter((x: Obj) => x.name !== "setup")) expect(p.dependencies, p.name).toEqual(["setup"]);
    const only = validateSmoke({ browsers: ["chromium", "webkit"] }).value;
    expect(projectNames(evalConfig(smokeConfig({ live: LIVE(), smoke: only })).config)).toEqual(["setup", "chromium", "webkit", "chromium-390", "a11y"]);
    // Without chromium there is no chromium-engine project either (a11y, further viewports).
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
    for (const n of ["chromium", "chromium-390", "a11y"]) expect(proj[n], n).toBe("/(?:^|[\\\\/])(?:checkout)\\.spec\\.ts$/");
    expect(proj.firefox).toBeUndefined();
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
        layout.CHECKS.length = 0;
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

describe("argus-live codegen — the generated suite under the pinned runner", () => {
  it("runs green for the fixture app with CI=1, setup then chromium, each test holding its locks", async () => {
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
    const smoke = validateSmoke({ dir: "e2e/argus-smoke", ci: { web_server: [{ command: `${JSON.stringify(process.execPath)} ${JSON.stringify(SERVER)} --from=argus-live-codegen-tests`, url: `http://localhost:${web}/health`, timeout_s: 30 }], ports: { web } } }).value;
    expect(smoke).not.toBeNull();
    const PLACE = [
      { as: "buyer", do: "goto", path: "/orders/new" },
      { as: "buyer", do: "fill", target: { label: "Quantity" }, value: "1" },
      { as: "buyer", do: "click", target: { role: "button", name: "Place order" } },
      { as: "buyer", do: "read", target: { testId: "order-number" }, save: "order" },
      { as: "buyer", expect: "visible", target: { testId: "order-number" } },
    ];
    const paths = [
      { id: "place-order", path: [...PLACE, { as: "system", expect: "fact-equals", marker: "{{order}}", field: "status", value: "placed" }] },
      { id: "order-handoff", path: [...PLACE, { as: "clerk", do: "goto", path: "/inbox" }, { as: "clerk", expect: "visible", target: { text: "{{order}}" } }] },
    ];
    const files = generateSuite({ paths, live, smoke });
    const repo = tempDir();
    const dir = join(repo, "e2e/argus-smoke");
    mkdirSync(dir, { recursive: true });
    for (const [f, text] of Object.entries(files) as [string, string][]) writeFileSync(join(dir, f), text);
    // @playwright/test through a scratch stub over the pinned install (never npm install).
    const pinned = join(cli.dir, "node_modules");
    mkdirSync(join(dir, "node_modules/@playwright/test"), { recursive: true });
    writeFileSync(join(dir, "node_modules/@playwright/test/index.js"), 'module.exports = require("playwright/test");\n');
    for (const m of ["playwright", "playwright-core"]) symlinkSync(join(pinned, m), join(dir, "node_modules", m));
    writeFileSync(join(dir, "wrapper.config.ts"), 'import base from "./playwright.config";\n\nexport default { ...base, projects: base.projects.map((p) => ({ ...p, use: { ...p.use, channel: "chrome" } })) };\n');
    const r = spawnSync(process.execPath, [join(pinned, "playwright/cli.js"), "test", "-c", "wrapper.config.ts", "--project", "setup", "--project", "chromium"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 240_000,
      env: { ...process.env, ...appEnv, CI: "1" },
    });
    const results = JSON.parse(readFileSync(join(dir, "test-results/results.json"), "utf8"));
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(results.stats).toMatchObject({ expected: 4, unexpected: 0, flaky: 0 });
    const titles = (s: Obj): string[] => [...(s.specs ?? []).map((x: Obj) => x.title), ...(s.suites ?? []).flatMap(titles)];
    expect(results.suites.flatMap(titles).sort()).toEqual(["order-handoff", "place-order", "sign in buyer.1", "sign in clerk.1"]);
    for (const a of ["buyer.1", "clerk.1"]) expect(statSync(join(dir, ".auth", `${a}.json`)).mode & 0o777, a).toBe(0o600);
    // The steps CI names: each test's results carry its test.step titles.
    const steps = (s: Obj): string[] => [...(s.specs ?? []).flatMap((x: Obj) => x.tests.flatMap((t: Obj) => t.results.flatMap((res: Obj) => (res.steps ?? []).map((st: Obj) => st.title)))), ...(s.suites ?? []).flatMap(steps)];
    expect(results.suites.flatMap(steps)).toEqual(expect.arrayContaining(["step 3 do:click", "step 6 expect:fact-equals", "step 7 expect:visible"]));
    // No password reached the suite's files or the runner's output.
    for (const [f, text] of Object.entries(files) as [string, string][]) expect(text.includes(PW), f).toBe(false);
    expect(`${r.stdout}${r.stderr}`.includes(PW)).toBe(false);
  }, 300_000);
});
