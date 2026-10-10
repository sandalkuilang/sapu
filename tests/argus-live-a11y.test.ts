// tests/argus-live-a11y.test.ts — the accessibility checks of the smoke suite (spec §19.7): each check's in-page
// source is run against fixture pages in the pinned runner's Chrome (a machine without one fails, never skips),
// each emitter's lines are scanned as text, and axe's results are read from recorded files (no axe runs here).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { browserTools } from "./helpers/argus-live";
// @ts-expect-error — plain ESM script without types
import { ARIA_EXPECT, CHECKS } from "../plugins/sapu/scripts/argus-live-a11y.mjs";
// @ts-expect-error — plain ESM script without types
import { generateSuite } from "../plugins/sapu/scripts/argus-live-codegen.mjs";
// @ts-expect-error — plain ESM script without types
import { validateSmoke } from "../plugins/sapu/scripts/argus-live-config.mjs";
// @ts-expect-error — plain ESM script without types
import { parseRepro, suiteAccounts } from "../plugins/sapu/scripts/argus-live-steps.mjs";

type Obj = Record<string, any>;
const nodeRequire = createRequire(import.meta.url);
const PAGES = join(__dirname, "fixtures/journey-app/pages/a11y");

/** Every check's source as the suite embeds it in support.ts, evaluated here: its `export`ed and plain functions by name. */
const sourceApi = (extra: Obj = {}): Obj => {
  const text = CHECKS.map((c: Obj) => c.source)
    .join("\n")
    .replace(/^export /gm, "");
  const names = [...text.matchAll(/^(?:async )?function (a11y\w+)/gm)].map((m) => m[1]);
  const scope = { SETTLE: 2000, __dirname: "/nonexistent", require: nodeRequire, ...extra };
  return new Function(...Object.keys(scope), `${text}\nreturn { ${names.join(", ")} };`)(...Object.values(scope));
};

/** A live.json with the two accounts the emit tests act as. */
const LIVE: Obj = { base_url: "http://localhost:{port:web}", login_url: "/login", logged_in: "getByRole('button', { name: 'Account' })", settle_ms: 5000, viewports: [1280], triggers: {}, roles: { anon: {}, buyer: { users: [{ user: "a@example.test", password: "${P}" }, { user: "b@example.test", password: "${P}" }] } } };
const CONTEXT = { context: { viewport: 1280, locale: "en-US", timezone: "UTC" } };
const parse = (list: Obj[], live: Obj = LIVE) => parseRepro([CONTEXT, ...list], { accounts: suiteAccounts(live), live, path: true }).steps as Obj[];
/** All the registered emitters' lines for every step of `steps`, as the generator calls them. */
const emitted = (steps: Obj[], smoke: Obj = {}, id = "j", only: string[] | null = null) => {
  const out: Record<string, string[]> = {};
  for (const c of CHECKS as Obj[]) {
    if (only && !only.includes(c.name)) continue;
    out[c.name] = steps.flatMap((s) => c.emit(s, { id, steps, smoke }));
  }
  return out;
};
const byName = (n: string) => (CHECKS as Obj[]).find((c) => c.name === n)!;

describe("argus-live a11y — the registry", () => {
  it("each check names its project, when it runs, an in-page source and an emitter", () => {
    expect(CHECKS.length).toBeGreaterThan(0);
    for (const c of CHECKS as Obj[]) {
      expect(c.name, c.name).toMatch(/^[a-z0-9-]+$/);
      expect(c.project, c.name).toBe("a11y");
      expect(typeof c.when, c.name).toBe("string");
      expect(typeof c.source, c.name).toBe("string");
      expect(typeof c.emit, c.name).toBe("function");
    }
    const names = (CHECKS as Obj[]).map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("the sources declare no name twice, hold no template literal and reach for no CSS selector of the path", () => {
    const text = (CHECKS as Obj[]).map((c) => c.source).join("\n");
    const declared = [...text.matchAll(/^(?:export )?(?:async )?function (\w+)/gm)].map((m) => m[1]);
    expect(new Set(declared).size).toBe(declared.length);
    expect(declared.every((n) => n.startsWith("a11y"))).toBe(true);
    expect(text).not.toContain("`");
    expect(() => sourceApi()).not.toThrow();
  });
});

describe("argus-live a11y — keyboard, focus and names: the emitted lines", () => {
  const PATH = [
    { as: "buyer", do: "goto", path: "/a" },
    { as: "buyer", do: "fill", target: { label: "Quantity" }, value: "2" },
    { as: "buyer", do: "hover", target: { role: "button", name: "Help" } },
    { as: "buyer", do: "dblclick", target: { role: "button", name: "Row" } },
    { as: "buyer", do: "click", target: { role: "button", name: "Pay {{marker}}" } },
    { as: "buyer", expect: "visible", target: { text: "Paid" } },
  ];

  it("a check runs before each click, check, uncheck, select and fill of the path, in the a11y project only, never before hover or dblclick", () => {
    const lines = emitted(parse(PATH), {}, "pay", ["a11y-keyboard"])["a11y-keyboard"];
    const text = lines.join("\n");
    expect(text.match(/a11yKeyboard\(/g)).toHaveLength(2);
    expect(text).toContain('test.info().project.name === "a11y"');
    expect(text).toContain('a11yKeyboard(buyer1, {"by": "label", "value": "Quantity"}, 2)');
    expect(text).toContain('{"by": "role", "role": "button", "name": "Pay " + marker}, 5)');
    expect(text).not.toContain('"Help"');
    expect(text).not.toContain('"Row"');
    expect(text).toContain('"pay"');
  });

  it("the names check covers every action target, a hover and a dblclick included (4.1.2 does not depend on the gesture)", () => {
    const text = emitted(parse(PATH), {}, "pay", ["a11y-names"])["a11y-names"].join("\n");
    expect(text.match(/a11yNames\(/g)).toHaveLength(4);
    expect(text).toContain('"Help"');
  });

  it("every string of the path stays a JSON literal or the placeholder's variable", () => {
    const evil = 'a`b${process.exit(1)}"c\\n';
    const steps = parse([{ as: "buyer", do: "goto", path: "/a" }, { as: "buyer", do: "click", target: { role: "button", name: evil } }, { as: "buyer", expect: "visible", target: { text: "x" } }]);
    const text = emitted(steps)["a11y-keyboard"].join("\n");
    expect(text).toContain(JSON.stringify(evil));
    expect(text.replace(JSON.stringify(evil), "")).not.toContain("`");
  });

  it("a parallel group is checked before the group runs, not between its members", () => {
    const steps = parse([
      { as: "buyer", do: "goto", path: "/a" },
      { as: "buyer.2", do: "goto", path: "/a" },
      { parallel: [{ as: "buyer", do: "click", target: { role: "button", name: "Claim" } }, { as: "buyer.2", do: "click", target: { role: "button", name: "Claim" } }] },
      { as: "buyer", expect: "visible", target: { text: "Done" } },
    ]);
    const perStep = steps.map((s) => byName("a11y-keyboard").emit(s, { id: "j", steps, smoke: {} }).join("\n"));
    expect(perStep[0]).toBe("");
    expect(perStep[1]).toContain("buyer1");
    expect(perStep[1]).toContain("buyer2");
    expect(perStep[2]).toBe("");
    expect(perStep[3]).toBe("");
  });
});

// ---------------------------------------------------------------------------------------------------
// The fixture pages, in Chrome.

let server: Server;
let base = "";
let browser: Obj;
let pw: Obj;
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".json": "application/json" };

beforeAll(async () => {
  const { cli, chrome } = browserTools();
  pw = nodeRequire(join(cli.dir, "node_modules/playwright-core"));
  server = createServer((req, res) => {
    if (req.method === "POST") {
      req.resume();
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
      return;
    }
    const name = (req.url ?? "/").split("?")[0].slice(1);
    if (!readdirSync(PAGES).includes(name)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": MIME[extname(name)] ?? "text/plain" }).end(readFileSync(join(PAGES, name)));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await pw.chromium.launch({ channel: chrome.channel });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
});

/** A fresh page on `file`, at the suite's default viewport. */
const open = async (file: string) => {
  const context = await browser.newContext({ viewport: { width: 900, height: 600 } });
  const page = await context.newPage();
  await page.goto(`${base}/${file}`);
  return { page, close: () => context.close() };
};
const byTestId = (id: string) => ({ by: "testId", value: id });
const byRole = (role: string, name?: string) => ({ by: "role", role, ...(name === undefined ? {} : { name }) });
const checks = (found: Obj[]) => found.map((v) => `${v.check}${v.manual ? "?" : ""}`).sort();

describe("argus-live a11y — keyboard reach, order, focus and names (2.1.1, 2.4.3, 2.4.7, 1.4.11, 2.4.11, 4.1.2)", () => {
  it("a div with a click handler is not in the tab order (2.1.1); a button is", async () => {
    const { page, close } = await open("keys.html");
    try {
      const api = sourceApi();
      const div = await api.a11yKeyboard(page, byTestId("div-click"), 3);
      expect(div).toEqual([expect.objectContaining({ check: "keyboard-reach", step: 3, detail: expect.stringContaining("2.1.1") })]);
      expect(div[0].manual).toBeUndefined();
      expect(checks(await api.a11yKeyboard(page, byRole("button", "Save"), 4))).toEqual([]);
    } finally {
      await close();
    }
  }, 60_000);

  it("a radio in a radiogroup, a tab and a menuitem pass once Tab reaches their widget; so does a native radio of a group", async () => {
    const { page, close } = await open("composite.html");
    try {
      const api = sourceApi();
      for (const t of [byRole("radio", "Medium"), byRole("radio", "Large"), byRole("tab", "Details"), byRole("menuitem", "Archive"), byRole("radio", "Green")]) expect(checks(await api.a11yKeyboard(page, t, 1)), JSON.stringify(t)).toEqual([]);
    } finally {
      await close();
    }
  }, 60_000);

  it("a positive tabindex that jumps back in DOM order is manual (F44 needs a human), never a fail", async () => {
    const { page, close } = await open("order.html");
    try {
      const found = await sourceApi().a11yKeyboard(page, byRole("button", "Beta"), 2);
      expect(found).toEqual([expect.objectContaining({ check: "tab-order", manual: true, key: expect.stringContaining("Gamma") })]);
    } finally {
      await close();
    }
  }, 60_000);

  it("an outline-less button fails focus visible (2.4.7)", async () => {
    const { page, close } = await open("keys.html");
    try {
      const api = sourceApi();
      expect(checks(await api.a11yKeyboard(page, byRole("button", "No ring"), 1))).toEqual(["focus-visible"]);
      expect(checks(await api.a11yKeyboard(page, byRole("button", "Save"), 1))).toEqual([]);
    } finally {
      await close();
    }
  }, 60_000);

  it("a solid outline under 3:1 against the background fails 1.4.11; any other indicator is manual", async () => {
    const { page, close } = await open("keys.html");
    try {
      const api = sourceApi();
      const pale = await api.a11yKeyboard(page, byRole("button", "Pale ring"), 1);
      expect(pale).toEqual([expect.objectContaining({ check: "focus-contrast", detail: expect.stringContaining("1.4.11") })]);
      expect(pale[0].manual).toBeUndefined();
      const glow = await api.a11yKeyboard(page, byRole("button", "Glow ring"), 1);
      expect(glow).toEqual([expect.objectContaining({ check: "focus-contrast", manual: true })]);
    } finally {
      await close();
    }
  }, 60_000);

  it("a sticky footer over the focused control fails focus not obscured (2.4.11)", async () => {
    const { page, close } = await open("sticky.html");
    try {
      expect(checks(await sourceApi().a11yKeyboard(page, byRole("button", "Low button"), 5))).toEqual(["focus-not-obscured"]);
    } finally {
      await close();
    }
  }, 60_000);

  it("a target not reached within the presses is undetermined (manual), never a fail", async () => {
    const { page, close } = await open("many.html");
    try {
      const api = sourceApi();
      const short = await api.a11yKeyboard(page, byRole("button", "Item 59"), 1, 20);
      expect(short).toEqual([expect.objectContaining({ check: "keyboard-reach", manual: true, detail: expect.stringContaining("undetermined") })]);
      expect(checks(await api.a11yKeyboard(page, byRole("button", "Item 59"), 1, 100))).toEqual([]);
    } finally {
      await close();
    }
  }, 120_000);

  it("a target the page does not hold once is left to the path itself (no verdict)", async () => {
    const { page, close } = await open("keys.html");
    try {
      expect(await sourceApi().a11yKeyboard(page, byRole("button", "Nowhere"), 1)).toEqual([]);
    } finally {
      await close();
    }
  }, 60_000);

  it("a nameless icon button fails toHaveAccessibleName (4.1.2); a named one and a labelled field hold", async () => {
    const { page, close } = await open("names.html");
    try {
      const { expect: pwExpect } = nodeRequire(join(browserTools().cli.dir, "node_modules/playwright/test"));
      const api = sourceApi();
      expect(await api.a11yNames(pwExpect, page, byTestId("icon-named"), 2)).toEqual([]);
      expect(await api.a11yNames(pwExpect, page, byTestId("qty"), 2)).toEqual([]);
      expect(await api.a11yNames(pwExpect, page, byTestId("icon-nameless"), 7)).toEqual([expect.objectContaining({ check: "name", step: 7, detail: expect.stringContaining("4.1.2") })]);
    } finally {
      await close();
    }
  }, 60_000);
});

describe("argus-live a11y — the report: known violations, allowed ones, manual ones", () => {
  const fakeExpect = (soft: Obj[]) => ({ soft: (actual: unknown, message: string) => ({ toEqual: (e: unknown) => soft.push({ actual, message, e }) }) });
  const V = (check: string, key: string, extra: Obj = {}) => ({ check, step: 2, key, detail: "d", ...extra });

  it("a violation soft-fails once, a known or allowed one does not, and a manual one is an annotation", () => {
    const api = sourceApi({ require: (m: string) => (m === "node:fs" ? { readFileSync: () => JSON.stringify([{ check: "name", key: "button known" }]) } : nodeRequire(m)) });
    const soft: Obj[] = [];
    const info = { annotations: [] as Obj[] };
    api.a11yReport(fakeExpect(soft), info, [V("name", "button known"), V("name", "button new"), V("focus-visible", "button x"), V("tab-order", "a -> b", { manual: true })], "j", [{ check: "focus-visible", key: "button x" }]);
    expect(soft).toHaveLength(1);
    expect(soft[0].actual).toEqual([expect.stringContaining("name (step 2) button new")]);
    expect(soft[0].actual).toHaveLength(1);
    expect(info.annotations).toEqual([{ type: "a11y-manual", description: expect.stringContaining("tab-order (step 2) a -> b") }]);
  });

  it("an unreadable or malformed known file is no known violation", () => {
    const api = sourceApi({ require: (m: string) => (m === "node:fs" ? { readFileSync: () => "{not json" } : nodeRequire(m)) });
    const soft: Obj[] = [];
    api.a11yReport(fakeExpect(soft), { annotations: [] }, [V("name", "k")], "j", []);
    expect(soft[0].actual).toHaveLength(1);
  });
});

describe("argus-live a11y — ARIA snapshots (partial matching, one baseline per screen)", () => {
  const PATH = [
    { as: "buyer", do: "goto", path: "/a" },
    { as: "buyer", expect: "visible", target: { role: "heading", name: "Shop" } },
    { as: "buyer", expect: "visible", target: { text: "Welcome" } },
    { as: "buyer", do: "click", target: { role: "button", name: "Go" } },
    { as: "buyer", expect: "url", value: "/b" },
    { as: "buyer", do: "goto", path: "/c" },
    { as: "buyer", expect: "visible", target: { text: "Done" } },
  ];
  const aria = (steps: Obj[], smoke: Obj = {}) => emitted(steps, smoke, "shop", ["a11y-aria"])["a11y-aria"].join("\n");

  it("emit writes toMatchAriaSnapshot with a name per screen: the last expectation before the account's next action, or the path's end", () => {
    const text = aria(parse(PATH));
    expect([...text.matchAll(/name: "(\d+)\.aria\.yml"/g)].map((m) => m[1])).toEqual(["3", "5", "7"]);
    expect(text).toContain('test.info().project.name === "a11y"');
    expect(text).toContain('toMatchAriaSnapshot({ name: "3.aria.yml", timeout: SETTLE })');
    expect(text).toContain("a11yAriaRoot(buyer1)");
  });

  it("smoke.json's screens for the journey replace the derived ones", () => {
    const text = aria(parse(PATH), { journeys: { shop: { screens: [2, 7] } } });
    expect([...text.matchAll(/name: "(\d+)\.aria\.yml"/g)].map((m) => m[1])).toEqual(["2", "7"]);
  });

  it("the config the snapshots need: the __aria__ template named by the test, and no children option (probed: \"contain\" lets a missing baseline match)", () => {
    expect(ARIA_EXPECT).toEqual({ pathTemplate: "{testDir}/__aria__/{testName}/{arg}{ext}" });
  });

  it("a snapshot that cannot be compared is baseline-missing when its file is absent, else a changed line diff", () => {
    const err = new Error("expect(locator).toMatchAriaSnapshot(expected) failed\n\n- Expected\n+ Received\n\n- - heading \"Shop\"\n+ - heading \"Store\"");
    const apis = (exists: boolean) => sourceApi({ require: (m: string) => (m === "node:fs" ? { existsSync: () => exists } : nodeRequire(m)), __dirname: "/suite" });
    const info = { title: "shop" };
    expect(apis(false).a11yAriaFailure(info, err, 3)).toEqual({ check: "aria-snapshot", step: 3, key: "baseline-missing", detail: expect.stringContaining("3.aria.yml") });
    const changed = apis(true).a11yAriaFailure(info, err, 3);
    expect(changed).toMatchObject({ check: "aria-snapshot", step: 3, key: "changed" });
    expect(changed.detail).toContain('heading "Store"');
    expect(changed.detail).not.toContain("\n");
  });

  it("under the pinned runner: the baseline run writes __aria__/<test>/<n>.aria.yml, a normal run compares it, and a missing or changed file reads as such", async () => {
    const { cli } = browserTools();
    const dir = mkdtempSync(join(tmpdir(), "argus-a11y-"));
    try {
      const support = ["export const SETTLE = 3000;", ...CHECKS.map((c: Obj) => c.source)].join("\n");
      writeFileSync(join(dir, "support.ts"), support);
      const config = (aria: Obj) => writeFileSync(join(dir, "playwright.config.ts"), 'import { defineConfig } from "@playwright/test";\n\nexport default defineConfig({ testDir: ".", updateSnapshots: "none", reporter: [["json", { outputFile: "results.json" }]], expect: { toMatchAriaSnapshot: ' + JSON.stringify(aria) + ' }, use: { channel: "chrome" } });\n');
      config(ARIA_EXPECT);
      writeFileSync(join(dir, "aria-demo.spec.ts"), [
        'import { test, expect } from "@playwright/test";',
        'import { a11yAriaFailure, a11yAriaRoot, SETTLE } from "./support";',
        'test("aria-demo", async ({ page }) => {',
        '  await page.setContent(require("node:fs").readFileSync(process.env.DEMO_FILE as string, "utf8"));', // the runner blocks this process while it runs, so no page of the test's own server
        "  const found = [];",
        '  try { await expect(await a11yAriaRoot(page)).toMatchAriaSnapshot({ name: "1.aria.yml", timeout: SETTLE }); } catch (e) { found.push(a11yAriaFailure(test.info(), e, 1)); }',
        '  test.info().annotations.push({ type: "found", description: JSON.stringify(found) });',
        "});",
        "",
      ].join("\n"));
      const pinned = join(cli.dir, "node_modules");
      mkdirSync(join(dir, "node_modules/@playwright/test"), { recursive: true });
      writeFileSync(join(dir, "node_modules/@playwright/test/index.js"), 'module.exports = require("playwright/test");\n');
      for (const m of ["playwright", "playwright-core"]) symlinkSync(join(pinned, m), join(dir, "node_modules", m));
      const run = (...flags: string[]) => {
        rmSync(join(dir, "results.json"), { force: true });
        const r = spawnSync(process.execPath, [join(pinned, "playwright/cli.js"), "test", ...flags], { cwd: dir, encoding: "utf8", timeout: 120_000, env: { ...process.env, DEMO_FILE: join(PAGES, "composite.html") } });
        if (!existsSync(join(dir, "results.json"))) throw new Error(r.stdout + r.stderr);
        const all = JSON.parse(readFileSync(join(dir, "results.json"), "utf8"));
        const test = all.suites[0].specs[0].tests[0].results[0];
        const note = test.annotations?.find?.((a: Obj) => a.type === "found") ?? all.suites[0].specs[0].tests[0].annotations.find((a: Obj) => a.type === "found");
        if (!note) throw new Error(JSON.stringify(test.errors ?? test) + r.stdout.slice(0, 1500));
        return { status: r.status, out: r.stdout + r.stderr, found: JSON.parse(note.description) };
      };
      const file = join(dir, "__aria__/aria-demo/1.aria.yml");
      expect(run().found).toEqual([expect.objectContaining({ key: "baseline-missing" })]);
      expect(run("--update-snapshots=missing").found).toEqual([]);
      expect(readFileSync(file, "utf8")).toContain("radiogroup");
      expect(run().found).toEqual([]);
      writeFileSync(file, '- radiogroup "Size"\n'); // fewer lines than the screen holds still match
      expect(run().found).toEqual([]);
      writeFileSync(file, '- heading "Not here" [level=1]\n');
      expect(run().found).toEqual([expect.objectContaining({ key: "changed" })]);
      // Why ARIA_EXPECT sets no children option: with "contain" a baseline that is not there matches anything.
      rmSync(file);
      config({ ...ARIA_EXPECT, children: "contain" });
      expect(run().found).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 240_000);
});

describe("argus-live a11y — modal dialogs (APG, 2.1.2): Escape, Tab, focus return, backdrop", () => {
  const info = () => ({ annotations: [] as Obj[], title: "t" });
  /** Opens the modal behind button "open" on a fresh modals page the way a path's click would, and runs the check; the page stays for a follow-up. */
  const opened = async (page: Obj, api: Obj, open: string, i: Obj, step = 3) => {
    await api.a11yModalArm(page);
    await page.getByRole("button", { name: open }).click();
    return api.a11yModal(page, byRole("button", open), step, i);
  };

  it("a modal dialog and a modal alertdialog both Escape-close, keep Tab inside and return focus to the invoker", async () => {
    const { page, close } = await open("modals.html");
    try {
      const api = sourceApi();
      expect(await opened(page, api, "Open native", info())).toEqual([]);
      expect(await page.getByRole("dialog").isVisible()).toBe(true); // the path's control reopened it: the path goes on inside it
      const { page: p2, close: c2 } = await open("modals.html");
      try {
        expect(await opened(p2, api, "Open alert", info())).toEqual([]);
        expect(await p2.getByRole("alertdialog").isVisible()).toBe(true);
      } finally {
        await c2();
      }
    } finally {
      await close();
    }
  }, 90_000);

  it("a modal that ignores Escape fails (the APG pattern and 2.1.2)", async () => {
    const { page, close } = await open("modals.html");
    try {
      const found = await opened(page, sourceApi(), "Open sticky", info());
      expect(found).toEqual([expect.objectContaining({ check: "modal-escape", key: 'dialog "Stuck"', detail: expect.stringContaining("2.1.2") })]);
      expect(found[0].manual).toBeUndefined();
    } finally {
      await close();
    }
  }, 90_000);

  it("focus that escapes the modal on Tab fails", async () => {
    const { page, close } = await open("modals.html");
    try {
      expect(checks(await opened(page, sourceApi(), "Open leak", info()))).toEqual(["modal-focus-escape"]);
    } finally {
      await close();
    }
  }, 90_000);

  it("after Escape, focus lost to the page fails, focus elsewhere is manual, and a removed invoker is exempt", async () => {
    const api = sourceApi();
    const lost = await open("modals.html");
    try {
      expect(checks(await opened(lost.page, api, "Open lost", info()))).toEqual(["modal-focus-return"]);
    } finally {
      await lost.close();
    }
    const other = await open("modals.html");
    try {
      const found = await opened(other.page, api, "Open elsewhere", info());
      expect(found).toEqual([expect.objectContaining({ check: "modal-focus-return", manual: true })]);
    } finally {
      await other.close();
    }
    const gone = await open("modals.html");
    try {
      const found = await opened(gone.page, api, "Open gone", info());
      expect(found.filter((v: Obj) => !v.manual)).toEqual([]);
      expect(found).toEqual([expect.objectContaining({ check: "modal-escape", manual: true, detail: expect.stringContaining("not tested") })]);
      expect(await gone.page.getByRole("dialog").isVisible()).toBe(true); // nothing was closed that the path could not reopen
    } finally {
      await gone.close();
    }
  }, 120_000);

  it("a non-modal dialog is exempt from the Escape and Tab rules", async () => {
    const { page, close } = await open("modals.html");
    try {
      expect(await opened(page, sourceApi(), "Open plain", info())).toEqual([]);
    } finally {
      await close();
    }
  }, 90_000);

  it("a click that opens no modal, or a modal already open before it, is not checked", async () => {
    const { page, close } = await open("modals.html");
    try {
      const api = sourceApi();
      expect(await opened(page, api, "Somewhere else", info())).toEqual([]);
      await page.getByRole("button", { name: "Open native" }).click();
      await api.a11yModalArm(page); // the dialog is open now
      await page.getByRole("button", { name: "Close" }).first().evaluate((b: HTMLElement) => b.focus());
      expect(await api.a11yModal(page, byRole("button", "Close"), 4, info())).toEqual([]);
    } finally {
      await close();
    }
  }, 90_000);

  it("two modal dialogs with different backdrop behaviour fail consistency, on the second", async () => {
    const { page, close } = await open("modals.html");
    try {
      const api = sourceApi();
      const i = info();
      expect(await opened(page, api, "Open alert", i, 3)).toEqual([]); // a click outside closes it
      await page.getByRole("button", { name: "OK" }).click();
      const second = await opened(page, api, "Open native", i, 5); // a click outside leaves it
      expect(second).toEqual([expect.objectContaining({ check: "modal-backdrop", step: 5, detail: expect.stringContaining("Delete it?") })]);
      expect(i.annotations.filter((a) => a.type === "a11y-backdrop")).toHaveLength(2);
    } finally {
      await close();
    }
  }, 90_000);
});

const RECORDED = (name: string): Obj => JSON.parse(readFileSync(join(__dirname, "fixtures/axe-results", name), "utf8"));

describe("argus-live a11y — axe's WCAG rules at each screen [pw-a11y, axe-api]", () => {
  const PATH = [
    { as: "buyer", do: "goto", path: "/a" },
    { as: "buyer", expect: "visible", target: { role: "heading", name: "Shop" } },
    { as: "buyer", do: "click", target: { role: "button", name: "Go" } },
    { as: "buyer", expect: "url", value: "/b" },
  ];
  const axe = (steps: Obj[], smoke: Obj = {}) => emitted(steps, smoke, "shop", ["a11y-axe"])["a11y-axe"].join("\n");

  it("emit writes, at each screen, an AxeBuilder with exactly the WCAG tags, main when the page has one, and target-size off", () => {
    const text = axe(parse(PATH));
    expect(text.match(/new AxeBuilder\(/g)).toHaveLength(2);
    expect(text).toContain('const { AxeBuilder } = require("@axe-core/playwright");');
    expect(text).toContain('const base = new AxeBuilder({ page: buyer1 }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).disableRules(["target-size"]);');
    expect(text).toContain('const builder = (await a11y.a11yHasMain(buyer1)) ? base.include("main") : base;');
    expect(text).toContain("a11y.a11yAxeResults(await builder.analyze(), 2)");
    expect(text).toContain('test.info().project.name === "a11y"');
  });

  it("each violation node is {check: axe:<rule>, key: its target joined}; a repeated one is one; a shadow or iframe target keeps its levels", () => {
    const found = sourceApi().a11yAxeResults(RECORDED("shop.json"), 4).filter((v: Obj) => !v.manual);
    expect(found.map((v: Obj) => [v.check, v.key])).toEqual([
      ["axe:color-contrast", ".hint"],
      ["axe:color-contrast", "footer > a"],
      ["axe:image-alt", "img"],
      ["axe:button-name", "#host >> button.icon"],
      ["axe:button-name", "iframe.pay | button.icon"],
    ]);
    expect(found[0]).toMatchObject({ step: 4, detail: expect.stringContaining("Elements must meet minimum color contrast ratio thresholds") });
    expect(found[0].detail).toContain("1.4.3");
    expect(found[2].detail).toContain("1.1.1");
    expect(sourceApi().a11yAxeResults({ violations: [...RECORDED("shop.json").violations, ...RECORDED("shop.json").violations], incomplete: [] }, 1)).toHaveLength(found.length);
  });

  it("incomplete results are manual, never a fail (axe could not decide)", () => {
    const manual = sourceApi().a11yAxeResults(RECORDED("shop.json"), 4).filter((v: Obj) => v.manual);
    expect(manual.map((v: Obj) => [v.check, v.key])).toEqual([["axe:color-contrast", ".badge"], ["axe:aria-valid-attr-value", "input[aria-controls]"]]);
    expect(manual[0].detail).toContain("needs a human");
  });

  it("a clean page reports nothing, and a known violation is filtered by the report like every check", () => {
    const api = sourceApi({ require: (m: string) => (m === "node:fs" ? { readFileSync: () => JSON.stringify([{ check: "axe:image-alt", key: "img" }]) } : nodeRequire(m)) });
    expect(api.a11yAxeResults(RECORDED("clean.json"), 1)).toEqual([]);
    const soft: Obj[] = [];
    const reported = api.a11yReport({ soft: (actual: unknown) => ({ toEqual: () => soft.push(actual) }) }, { annotations: [] }, api.a11yAxeResults(RECORDED("shop.json"), 4), "shop", []);
    expect(reported.map((v: Obj) => v.check + " " + v.key)).not.toContain("axe:image-alt img");
    expect(soft[0]).toHaveLength(4);
  });

  it("a page has main exactly when it holds a main landmark", async () => {
    const api = sourceApi();
    const withMain = await open("keys.html");
    const without = await open("modals.html");
    try {
      expect(await api.a11yHasMain(withMain.page)).toBe(true);
      await without.page.evaluate(() => document.querySelector("main")!.removeAttribute("id"));
      await without.page.evaluate(() => document.querySelector("main")!.replaceWith(...document.querySelector("main")!.childNodes));
      expect(await api.a11yHasMain(without.page)).toBe(false);
    } finally {
      await withMain.close();
      await without.close();
    }
  }, 60_000);
});

describe("argus-live a11y — design tokens", () => {
  const fs = (live: Obj | null, files: Record<string, string> = {}) => {
    const repo = mkdtempSync(join(tmpdir(), "argus-a11y-"));
    mkdirSync(join(repo, ".argus"), { recursive: true });
    if (live) writeFileSync(join(repo, ".argus/live.json"), JSON.stringify(live));
    for (const [n, t] of Object.entries(files)) writeFileSync(join(repo, n), t);
    return repo;
  };
  const tokenFile = (n: string) => readFileSync(join(PAGES, n), "utf8");

  it("reads a CSS file's custom properties and a JSON file's string leaves and $values; a reference to another token is no value of its own", () => {
    const api = sourceApi();
    expect(api.a11yTokenValues("css", tokenFile("tokens.css")).sort()).toEqual(["#0b1b3a", "#0b5fff", "#ffffff", "#ffffff", "1rem", "Helvetica, Arial, sans-serif"].sort());
    expect(api.a11yTokenValues("json", tokenFile("tokens.json")).sort()).toEqual(["#0b1b3a", "#0b5fff", "#ffffff", "#ffffff", "1rem", "Helvetica, Arial, sans-serif"].sort());
    expect(api.a11yTokenValues("json", "{not json")).toEqual([]);
  });

  it("an off-token colour, background, font or size fails; on-token controls, transparent backgrounds and hidden ones do not", async () => {
    for (const [kind, file] of [["css", "tokens.css"], ["json", "tokens.json"]] as const) {
      const repo = fs({ tokens: { [kind]: file } }, { [file]: tokenFile(file) });
      const { page, close } = await open("tokens.html");
      try {
        const info = { annotations: [] as Obj[] };
        const found = await sourceApi({ REPO: repo }).a11yTokens(page, 6, info);
        expect(found.map((v: Obj) => v.key).sort(), kind).toEqual(['background-color button "Off background"', 'color button "Off colour"', 'font-family button "Off font"', 'font-size button "Off size"']);
        expect(found.every((v: Obj) => v.check === "design-token" && v.step === 6 && !v.manual)).toBe(true);
        expect(info.annotations).toEqual([]);
      } finally {
        await close();
        rmSync(repo, { recursive: true, force: true });
      }
    }
  }, 90_000);

  it("without tokens the page says so once and nothing is checked", async () => {
    const { page, close } = await open("tokens.html");
    const info = { annotations: [] as Obj[] };
    const repos = [fs(null), fs({ tokens: { css: "../escape.css" } }), fs({ tokens: { css: "missing.css" } })];
    try {
      for (const repo of repos) expect(await sourceApi({ REPO: repo }).a11yTokens(page, 1, info)).toEqual([]);
      const api = sourceApi({ REPO: repos[0] });
      await api.a11yTokens(page, 2, info);
      const notes = info.annotations.filter((a) => a.type === "a11y-note");
      expect(notes).toHaveLength(1);
      expect(notes[0].description).toBe("design tokens: not checked (no token source)");
    } finally {
      await close();
      for (const r of repos) rmSync(r, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("argus-live a11y — form validation cases", () => {
  const FIELDS = [
    { index: 0, key: 'textbox "Name"', type: "text", required: true, minLength: null, maxLength: null, pattern: null },
    { index: 1, key: 'textbox "Email"', type: "email", required: true, minLength: null, maxLength: null, pattern: null },
    { index: 2, key: 'textbox "Code"', type: "text", required: false, minLength: null, maxLength: 5, pattern: null },
    { index: 3, key: 'textbox "Nick"', type: "text", required: false, minLength: 3, maxLength: null, pattern: null },
    { index: 4, key: 'textbox "Ref"', type: "text", required: false, minLength: null, maxLength: null, pattern: "[A-Z]{3}" },
    { index: 5, key: 'textbox "Plain"', type: "text", required: false, minLength: null, maxLength: null, pattern: null },
    { index: 6, key: 'textbox "Age"', type: "number", required: false, minLength: null, maxLength: null, pattern: null },
  ];

  it("generates one case from each of required, type=email, maxlength, minlength and pattern, and none other, up to the cap", () => {
    const api = sourceApi();
    const cases = api.a11yCasesOf(FIELDS, 10);
    expect(cases.map((c: Obj) => [c.kind, c.index, c.value])).toEqual([
      ["required", 0, ""],
      ["required", 1, ""],
      ["email", 1, "not-an-email"],
      ["maxlength", 2, "xxxxxx"],
      ["minlength", 3, "xx"],
      ["pattern", 4, "!"],
    ]);
    expect(api.a11yCasesOf(FIELDS, 3)).toHaveLength(3);
    expect(api.a11yCasesOf(FIELDS, 0)).toEqual([]);
    // minlength 1 would be the empty value, which no minlength check refuses; a pattern every listed value meets has no case.
    expect(api.a11yCasesOf([{ ...FIELDS[3], minLength: 1 }, { ...FIELDS[4], pattern: ".*" }], 5)).toEqual([]);
  });

  const VALID: Record<string, string> = { Name: "Ada", Email: "ada@example.test", Code: "ab12", Nick: "ada", Ref: "ABC" };
  /** What a path does before its submit: fills the form's fields with valid values; then the check runs. */
  const filled = async (id: string, submit: string, max = 10) => {
    const { page, close } = await open("forms.html");
    const form = page.locator("#" + id);
    for (const [label, value] of Object.entries(VALID)) if ((await form.getByLabel(label).count()) === 1) await form.getByLabel(label).fill(value);
    const posts: string[] = [];
    page.on("request", (r: Obj) => r.method() === "POST" && posts.push(r.url()));
    return { page, close, posts, run: () => sourceApi().a11yFormCases(page, byRole("button", submit), 5, max), form };
  };

  it("native validation holds: every case is stopped by the browser, names the field, and moves focus to it; the values are put back", async () => {
    const t = await filled("native", "Save native");
    try {
      expect(await t.run()).toEqual([]);
      expect(t.posts).toEqual([]);
      expect(await t.form.getByLabel("Name").inputValue()).toBe("Ada");
      expect(await t.form.getByLabel("Code").inputValue()).toBe("ab12");
    } finally {
      await t.close();
    }
  }, 90_000);

  it("novalidate with aria-invalid and aria-describedby holds, and so does focus on an error-summary link to the field", async () => {
    for (const [id, submit] of [["custom", "Save custom"], ["summary", "Save summary"]]) {
      const t = await filled(id, submit);
      try {
        expect(await t.run(), id).toEqual([]);
        expect(t.posts, id).toEqual([]);
      } finally {
        await t.close();
      }
    }
  }, 120_000);

  it("a form that posts and gets 200 on a bad value fails hard, on the first case that submits (the report ends the test)", async () => {
    const t = await filled("loose", "Save loose");
    try {
      const found = await t.run();
      expect(found).toEqual([expect.objectContaining({ check: "form-accepts-invalid", step: 5, hard: true, detail: expect.stringContaining("200") })]);
      expect(t.posts).toHaveLength(1);
      const api = sourceApi();
      const soft: Obj[] = [];
      expect(() => api.a11yReport({ soft: (a: unknown) => ({ toEqual: () => soft.push(a) }) }, { annotations: [] }, found, "j", [])).toThrow(/accepts-invalid/);
      expect(() => api.a11yReport({ soft: () => ({ toEqual: () => 0 }) }, { annotations: [] }, found, "j", [{ check: found[0].check, key: found[0].key }])).not.toThrow();
    } finally {
      await t.close();
    }
  }, 90_000);

  it("a refusal that marks nothing invalid fails: the field is not invalid, with no error and no focus", async () => {
    const t = await filled("silent", "Save silent");
    try {
      const found = await t.run();
      expect([...new Set(found.map((v: Obj) => v.check))].sort()).toEqual(["form-case-error", "form-case-focus", "form-case-invalid"]);
      expect(found.find((v: Obj) => v.check === "form-case-invalid").detail).toContain("aria-invalid");
      expect(found.every((v: Obj) => !v.hard)).toBe(true);
      expect(t.posts).toEqual([]);
    } finally {
      await t.close();
    }
  }, 90_000);

  it("a click that is not a submit of a form with fields, or a missing target, is left alone", async () => {
    const t = await filled("native", "Save native");
    try {
      const api = sourceApi();
      expect(await api.a11yFormCases(t.page, byRole("button", "Nowhere"), 5, 6)).toEqual([]);
      expect(await api.a11yFormCases(t.page, byRole("group", "Native validation"), 5, 6)).toEqual([]);
    } finally {
      await t.close();
    }
  }, 60_000);
});

describe("argus-live a11y — the form and token emitters", () => {
  const PATH = [
    { as: "buyer", do: "goto", path: "/a" },
    { as: "buyer", do: "fill", target: { label: "Name" }, value: "Ada" },
    { as: "buyer", do: "fill", target: { label: "Email" }, value: "ada@example.test" },
    { as: "buyer", do: "click", target: { role: "button", name: "Save" } },
    { as: "buyer", do: "click", target: { role: "button", name: "Later" } },
    { as: "buyer", expect: "visible", target: { text: "Saved" } },
  ];

  it("a click right after the fills of a form runs the cases first, with the journey's cap; a click without fills, or a cap of 0, runs none", () => {
    const form = (steps: Obj[], smoke: Obj = {}) => emitted(steps, smoke, "j", ["a11y-forms"])["a11y-forms"].join("\n");
    const text = form(parse(PATH), { form_cases_max: 4 });
    expect(text.match(/a11yFormCases\(/g)).toHaveLength(1);
    expect(text).toContain('a11yFormCases(buyer1, {"by": "role", "role": "button", "name": "Save"}, 4, 4)');
    expect(form(parse(PATH), { form_cases_max: 0 })).toBe("");
    expect(form(parse(PATH.filter((s) => !s.value)))).toBe("");
  });

  it("the token check runs at each screen and reads its source in the page's own run", () => {
    const text = emitted(parse(PATH), {}, "j", ["a11y-tokens"])["a11y-tokens"].join("\n");
    expect(text).toContain("a11yTokens(buyer1, 6, test.info())");
    expect(text.match(/a11yTokens\(/g)).toHaveLength(1);
  });
});

describe("argus-live a11y — inside the generated suite", () => {
  const live = { ...LIVE, roles: { ...LIVE.roles } };
  const smoke = validateSmoke({ ci: { web_server: [{ command: "npm start", url: "http://localhost:4100/health" }], ports: { web: 4100 } } }).value;
  const PATH = [
    { as: "buyer", do: "goto", path: "/orders/new" },
    { as: "buyer", do: "fill", target: { label: "Quantity" }, value: "2" },
    { as: "buyer", do: "click", target: { role: "button", name: "Place order" } },
    { as: "buyer", expect: "visible", target: { text: "Placed" } },
  ];
  const parses = (ts: string) => {
    const file = join(mkdtempSync(join(tmpdir(), "argus-a11y-")), "x.mjs");
    writeFileSync(file, stripTypeScriptTypes(ts));
    try {
      return spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    } finally {
      rmSync(dirname(file), { recursive: true, force: true });
    }
  };

  it("the spec stays inside the generator's bans, keeps its step titles and parses; the support parses and holds every check's source once", () => {
    const files = generateSuite({ paths: [{ id: "place-order", path: PATH }], live, smoke });
    const spec = files["place-order.spec.ts"];
    expect(spec).toContain('test.info().project.name === "a11y"');
    for (const banned of ["`", "${", "waitForTimeout", "setTimeout", "sleep", ".locator(", "xpath", "css=", "describe.serial", "beforeAll", "afterAll", "test.fixme", "fixme", "test.only", "waitFor("]) expect(spec, banned).not.toContain(banned);
    expect([...spec.matchAll(/test\.step\("([^"]*)"/g)].map((m) => m[1])).toEqual(["step 1 do:goto", "step 2 do:fill", "step 3 do:click", "step 4 expect:visible"]);
    expect(parses(spec).status).toBe(0);
    const support = files["support.ts"];
    expect(parses(support).status, parses(support).stderr).toBe(0);
    for (const n of ["a11yKeyboard", "a11yNames", "a11yReport", "a11yLocate"]) expect(support.match(new RegExp(`function ${n}\\b`, "g")), n).toHaveLength(1);
    expect(support).not.toMatch(/shell|\bexec\(|spawn\(|\/bin\/sh/);
  });
});

describe("argus standards — the WCAG criteria the smoke suite's checks measure", () => {
  const text = readFileSync(join(__dirname, "../plugins/sapu/skills/argus/standards.md"), "utf8");
  const ROWS: [string, string, string, string, string][] = [
    ["2.1.1", "Keyboard", "A", "keyboard", "All functionality of the content is operable through a keyboard interface"],
    ["2.1.2", "No Keyboard Trap", "A", "no-keyboard-trap", "then focus can be moved away from that component using only a keyboard interface"],
    ["2.4.3", "Focus Order", "A", "focus-order", "focusable components receive focus in an order that preserves meaning and operability."],
    ["3.3.1", "Error Identification", "A", "error-identification", "the item that is in error is identified and the error is described to the user in text."],
    ["4.1.2", "Name, Role, Value", "A", "name-role-value", "the name and role can be programmatically determined"],
    ["4.1.3", "Status Messages", "AA", "status-messages", "status messages can be programmatically determined through role or properties"],
  ];

  it("each criterion appears in the accessibility table with its level as printed, a quoted sentence and its Understanding page", () => {
    for (const [sc, name, level, slug, quoted] of ROWS) {
      const row = text.split("\n").find((l) => l.startsWith(`| ${sc} ${name} |`));
      expect(row, sc).toBeDefined();
      expect(row, sc).toContain(`| ${level} |`);
      expect(row, sc).toContain(`https://www.w3.org/WAI/WCAG22/Understanding/${slug}.html`);
      expect(row, sc).toContain(quoted);
      expect(row, sc).not.toContain("⚠");
    }
  });

  it("the rows stay in criterion order", () => {
    const table = text.slice(text.indexOf("## Accessibility"), text.indexOf("## Usability"));
    const scs = [...table.matchAll(/^\| (\d\.\d+\.\d+) /gm)].map((m) => m[1].split(".").map(Number));
    const sorted = [...scs].sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
    expect(scs).toEqual(sorted);
  });
});
