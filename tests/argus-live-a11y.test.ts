// tests/argus-live-a11y.test.ts — the accessibility checks of the smoke suite (spec §19.7): each check's in-page
// source is run against fixture pages in the pinned runner's Chrome (a machine without one fails, never skips),
// each emitter's lines are scanned as text, and axe's results are read from recorded files (no axe runs here).
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { browserTools } from "./helpers/argus-live";
// @ts-expect-error — plain ESM script without types
import { CHECKS } from "../plugins/sapu/scripts/argus-live-a11y.mjs";
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
