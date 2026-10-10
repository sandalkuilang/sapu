// tests/argus-live-layout.test.ts — the layout, locale, link and dynamic-state checks (spec §19.7): the
// in-page oracle against fixture pages that each hold a violation and its excluded twin (the false-positive
// set is the test), the support-file wrappers run for real against a local server, and the emitted lines.
import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { browserTools, cleanTemps, example, tempDir } from "./helpers/argus-live";
// @ts-expect-error — plain ESM script without types
import { CHECKS, LAYOUT_KINDS, PAGE_FN, pageExpression } from "../plugins/sapu/scripts/argus-live-layout.mjs";
// @ts-expect-error — plain ESM script without types
import { smokeSpec, supportFile } from "../plugins/sapu/scripts/argus-live-codegen.mjs";
// @ts-expect-error — plain ESM script without types
import { validateSmoke } from "../plugins/sapu/scripts/argus-live-config.mjs";

type Obj = Record<string, any>;

afterEach(cleanTemps);

const PAGES = join(__dirname, "fixtures/journey-app/pages/layout");

// ---------------------------------------------------------------------------------------------------
// One browser and one local server for the file: the pages as files, plus the routes the link checks probe.

let browser: any;
let server: Server;
let other: Server;
let origin = "";
let otherOrigin = "";
let hits: string[] = [];
let otherHits: string[] = [];
let inflight = 0;
let maxInflight = 0;

const listen = (s: Server) => new Promise<number>((resolve) => s.listen(0, "127.0.0.1", () => resolve((s.address() as { port: number }).port)));
const STATUS: Record<string, number> = { "/missing": 404, "/gone": 410, "/boom": 500, "/private": 401, "/forbidden": 403, "/slow-down": 429 };

beforeAll(async () => {
  const { cli, chrome } = browserTools();
  const { chromium } = createRequire(join(cli.dir, "package.json"))("playwright-core");
  browser = await chromium.launch({ executablePath: chrome.path, headless: true });
  other = createServer((req, res) => {
    otherHits.push(String(req.url));
    res.end("other");
  });
  server = createServer((req, res) => {
    const url = new URL(String(req.url), origin);
    const name = url.pathname;
    if (name === "/favicon.ico") {
      res.statusCode = 204;
      res.end();
      return;
    }
    if (/^\/[a-z-]+\.html$/.test(name)) {
      res.setHeader("content-type", "text/html");
      res.end(readFileSync(join(PAGES, name.slice(1)), "utf8").replace("__OTHER__", otherOrigin));
      return;
    }
    hits.push(name);
    inflight++;
    maxInflight = Math.max(maxInflight, inflight);
    setTimeout(() => {
      inflight--;
      if (STATUS[name]) res.statusCode = STATUS[name];
      if (name === "/to-login") {
        res.statusCode = 302;
        res.setHeader("location", "/login");
      } else if (name === "/loop") {
        res.statusCode = 302;
        res.setHeader("location", "/loop");
      } else if (name === "/offsite") {
        res.statusCode = 302;
        res.setHeader("location", `${otherOrigin}/hit`);
      }
      res.end("x");
    }, 15);
  });
  origin = `http://127.0.0.1:${await listen(server)}`;
  otherOrigin = `http://127.0.0.1:${await listen(other)}`;
}, 60_000);

afterAll(async () => {
  await browser?.close();
  server?.closeAllConnections();
  other?.closeAllConnections();
  server?.close();
  other?.close();
});

const contexts: any[] = [];
/** A page of the fixture directory in a fresh context of the given size and locale. */
async function open(file: string, { width = 1000, height = 700, locale = "en-US" } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, locale });
  contexts.push(context);
  const page = await context.newPage();
  await page.goto(`${origin}/${file}`);
  return { context, page };
}
afterEach(async () => {
  for (const c of contexts.splice(0)) await c.close();
});

/** The in-page function's answer: the same source the support file embeds. */
const ask = (page: any, kind: string, opts: Obj = {}) => page.evaluate(pageExpression(kind, opts));
const keysOf = (found: Obj[], check: string) => found.filter((f) => f.check === check).map((f) => f.key).sort();

// ---------------------------------------------------------------------------------------------------
// C1.1 — the layout oracle.

describe("argus-live layout — the oracle reports each violation and none of its excluded twins", () => {
  it("page-scroll: a wide block fails, a wide table (1.4.10's two-dimensional exception) holds", async () => {
    const bad = await open("scroll-div.html");
    expect(await ask(bad.page, "layout")).toEqual([{ check: "page-scroll", key: "page-scroll", detail: expect.stringContaining("scrollWidth 2000 > innerWidth 1000") }]);
    const good = await open("scroll-table.html");
    expect(await ask(good.page, "layout")).toEqual([]);
    const narrow = await open("scroll-div.html", { width: 320 });
    expect((await ask(narrow.page, "layout"))[0].detail).toContain("WCAG 1.4.10 reflow");
  }, 60_000);

  it("clipped: cut-off text fails; an ellipsis with its title, sr-only text, a scroll container and a form field hold", async () => {
    const { page } = await open("clipped.html");
    const found = await ask(page, "layout");
    expect(found).toEqual([{ check: "clipped", key: "|A long product description that does not fit|p", detail: expect.stringContaining("scrollWidth") }]);
  }, 60_000);

  it("covered: a plain overlay fails; a fixed header and a label-covered custom checkbox hold", async () => {
    const { page } = await open("covered.html");
    const found = await ask(page, "layout", { only: ["covered"] });
    expect(found).toEqual([{ check: "covered", key: "button|Pay now|button", detail: "covered by div" }]);
  }, 60_000);

  it("covered: while a modal dialog is open only it is checked, and a covered control inside it still fails", async () => {
    const { page } = await open("modal.html");
    expect(await page.evaluate('document.getElementById("d").matches(":modal")')).toBe(true);
    // The control behind the backdrop and the two small buttons outside the dialog are out of scope; the one inside is not.
    expect(await ask(page, "layout")).toEqual([{ check: "covered", key: "button|Hidden choice|button", detail: "covered by div" }]);
  }, 60_000);

  it("target-size: two 16 px buttons 2 px apart fail; an inline link and a native checkbox hold", async () => {
    const { page } = await open("target-size.html");
    const found = await ask(page, "layout", { only: ["target-size"] });
    expect(keysOf(found, "target-size")).toEqual(["button|Delete row|button", "button|Edit row|button"]);
    expect(found[0].detail).toContain("WCAG 2.5.8");
  }, 60_000);

  it("target-size follows 2.5.8's 24 px circle: spacing of 12 px or more clears it, and a 24 px target never needs it", async () => {
    const { page } = await open("scroll-table.html");
    const html = (body: string) => page.setContent(`<!doctype html><html lang="en"><body style="margin:0"><main>${body}</main></body></html>`);
    const b = (label: string, w: number, left: number, top = 10) => `<button aria-label="${label}" style="position:absolute;left:${left}px;top:${top}px;width:${w}px;height:${w}px;padding:0;margin:0"></button>`;
    // 20 px target beside a 40 px one: the 20 px circle reaches 12 px from its centre, so a gap under 2 px fails and 4 px holds.
    await html(b("small", 20, 10) + b("big", 40, 31, 0));
    expect(keysOf(await ask(page, "layout", { only: ["target-size"] }), "target-size")).toEqual(["button|small|button"]);
    await html(b("small", 20, 10) + b("big", 40, 34, 0));
    expect(await ask(page, "layout", { only: ["target-size"] })).toEqual([]);
    // Two 24 px targets side by side are not undersized.
    await html(b("one", 24, 10) + b("two", 24, 34));
    expect(await ask(page, "layout", { only: ["target-size"] })).toEqual([]);
    // Two undersized targets: their circles (24 px across) meet when the centres are under 24 px apart.
    await html(b("left", 16, 10) + b("right", 16, 30));
    expect(keysOf(await ask(page, "layout", { only: ["target-size"] }), "target-size")).toEqual(["button|left|button", "button|right|button"]);
    await html(b("left", 16, 10) + b("right", 16, 60));
    expect(await ask(page, "layout", { only: ["target-size"] })).toEqual([]);
  }, 60_000);

  it("keys are stable: role, name with digit runs written #, tag; the same violation twice is one", async () => {
    const { page } = await open("scroll-table.html");
    const b = (n: number, left: number) => `<button aria-label="Remove item ${n}" style="position:absolute;left:${left}px;top:10px;width:16px;height:16px;padding:0;margin:0"></button>`;
    await page.setContent(`<!doctype html><html lang="en"><body style="margin:0"><main>${b(3, 10)}${b(14, 28)}</main></body></html>`);
    const first = await ask(page, "layout", { only: ["target-size"] });
    expect(first.map((f: Obj) => f.key)).toEqual(["button|Remove item #|button"]);
    expect(await ask(page, "layout", { only: ["target-size"] })).toEqual(first);
    expect(LAYOUT_KINDS).toEqual(["page-scroll", "clipped", "covered", "target-size"]);
  }, 60_000);

  it("a hidden element is never reported: display none, opacity 0, aria-hidden and inert subtrees", async () => {
    const { page } = await open("scroll-table.html");
    const small = 'style="position:absolute;left:10px;top:10px;width:16px;height:16px;padding:0;margin:0"';
    const pair = (extra: string) => `<div ${extra}><button aria-label="A" ${small}></button><button aria-label="B" style="position:absolute;left:28px;top:10px;width:16px;height:16px;padding:0;margin:0"></button></div>`;
    for (const extra of ['style="display:none"', 'style="opacity:0"', 'aria-hidden="true"', "inert"]) {
      await page.setContent(`<!doctype html><html lang="en"><body>${pair(extra)}</body></html>`);
      expect(await ask(page, "layout", { only: ["target-size"] }), extra).toEqual([]);
    }
    await page.setContent(`<!doctype html><html lang="en"><body>${pair("")}</body></html>`);
    expect((await ask(page, "layout", { only: ["target-size"] })).length).toBe(2);
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------------
// The support file's wrappers, loaded from the registry's sources and run against the pages.

/** The sources of the named checks (the first entry carries the shared core) → their exported and local names, as an object. */
function load(names: string[], scope: Obj) {
  const source = CHECKS.filter((c: Obj) => ["layout", ...names].includes(c.name)).map((c: Obj) => c.source).join("\n");
  // vitest's Function has no dynamic-import callback: the file module is the one `require` gives (the e2e suite runs the real import).
  const js = stripTypeScriptTypes(source).replace(/^export /gm, "").replace(/await import\("node:fs"\)/g, 'require("node:fs")');
  const found = [...js.matchAll(/^(?:async function|function|const) (\w+)/gm)].map((m) => m[1]);
  return new Function("require", ...Object.keys(scope), `${js}\nreturn { ${found.join(", ")} };`)(createRequire(import.meta.url), ...Object.values(scope)) as Obj;
}

/** A stand-in for Playwright's `test` whose annotations the checks write. */
const fakeTest = (project: string) => {
  const annotations: { type: string; description: string }[] = [];
  return { test: { info: () => ({ project: { name: project }, annotations }) }, annotations };
};

const env = (project: string, extra: Obj = {}) => {
  const dir = tempDir();
  const { test, annotations } = fakeTest(project);
  return { dir, annotations, scope: { test, path: { join }, REPO: dir, SETTLE: 2000, __dirname: dir, ...extra } };
};

describe("argus-live layout — known and allowed violations, the project gate", () => {
  it("a known or allowed violation is not a failure, a new one is; every kept one is annotated", async () => {
    const { dir, annotations, scope } = env("chromium");
    mkdirSync(join(dir, "known"));
    writeFileSync(join(dir, "known/j.json"), JSON.stringify([{ check: "page-scroll", key: "page-scroll" }]));
    const lib = load([], { ...scope, path: { join: (...p: string[]) => join(...p) } });
    const { page, context } = await open("scroll-div.html");
    expect(await lib.layoutStep([context], 0, 3, "j", [])).toEqual([]);
    expect(await lib.layoutStep([context], 0, 3, "other", [{ check: "page-scroll", key: "page-scroll" }])).toEqual([]);
    const kept = await lib.layoutStep([context], 0, 3, "other", []);
    expect(kept).toEqual([{ check: "page-scroll", step: 3, key: "page-scroll", detail: expect.any(String) }]);
    expect(annotations.map((a) => a.type)).toEqual(["argus-violation"]);
    expect(JSON.parse(annotations[0].description)).toMatchObject({ check: "page-scroll", step: 3, key: "page-scroll" });
    expect(page.url()).toContain("scroll-div.html");
  }, 60_000);

  it("the layout oracle runs in the viewport projects only", async () => {
    const { context } = await open("scroll-div.html");
    for (const [project, runs] of [["chromium", true], ["chromium-375", true], ["firefox", true], ["a11y", false], ["i18n", false]] as const) {
      const { scope } = env(project);
      const lib = load([], scope);
      expect((await lib.layoutStep([context], 0, 1, "j", [])).length, project).toBe(runs ? 1 : 0);
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------------
// C1.2 — locale and format checks.

describe("argus-live layout — number and date formats under each locale", () => {
  it("under de-DE, 1,234.56 fails and 1.234,56 holds; a date, an ISO date, a URL, an address, an input, code and translate=no are skipped", async () => {
    const { page } = await open("locale-de.html", { locale: "de-DE" });
    expect(await ask(page, "format", { locale: "de-DE" })).toEqual([{ check: "format", key: "number|#,#.#", detail: expect.stringContaining('"1,234.56" under de-DE') }]);
  }, 60_000);

  it("under en-US, a date proving day-first or using another separator fails; month-first, ambiguous and ISO dates hold", async () => {
    const { page } = await open("locale-en.html");
    const found = await ask(page, "format", { locale: "en-US" });
    expect(found.map((f: Obj) => f.key).sort()).toEqual(["date|#.#.#|separator", "date|#/#/#|order"]);
    expect(found.find((f: Obj) => f.key.endsWith("|order")).detail).toContain('"13/02/2026" under en-US');
    // The same dates under en-GB: day first, so the 13th reads right and the 02/13 one is the wrong one.
    const gb = await ask(page, "format", { locale: "en-GB" });
    expect(gb.map((f: Obj) => f.detail.split(" under")[0]).sort()).toEqual(['"02.13.2026"', '"02/13/2026"']);
  }, 60_000);

  it("a locale that does not write Latin digits is not judged", async () => {
    const { page } = await open("locale-de.html");
    expect(await ask(page, "format", { locale: "ar-EG" })).toEqual([]);
  }, 60_000);
});

describe("argus-live layout — localeStep (the i18n project)", () => {
  const setup = (live: Obj, project = "i18n") => {
    const e = env(project);
    mkdirSync(join(e.dir, ".argus"), { recursive: true });
    writeFileSync(join(e.dir, ".argus/live.json"), JSON.stringify(live));
    return { ...e, lib: load(["locale"], e.scope) };
  };
  const run = async (lib: Obj, file: string, { exclude = [], last = true, mutates = false } = {}) => {
    const { context } = await open(file);
    return lib.localeStep(browser, [context], 0, "buyer.1", 2, "j", origin, { width: 1000, height: 700 }, [], exclude, mutates, last);
  };

  it("a real locale runs the formats and overflow of the step's URL, and says it is only URL-addressable states", async () => {
    const { lib, annotations } = setup({ locales: ["de-DE"] });
    const found = await run(lib, "locale-de.html");
    expect(found.map((f: Obj) => [f.check, f.key])).toEqual([["locale-format", "de-DE|number|#,#.#"]]);
    expect(annotations.filter((a) => a.type === "argus-info").map((a) => a.description)).toEqual(["locale: only URL-addressable states are checked", "pseudo-localization: not done (no pseudo-locale listed)"]);
  }, 60_000);

  it("a page with lang=en under de-DE is not localized: reported manual, its formats not judged", async () => {
    const { lib, annotations } = setup({ locales: ["de-DE"] });
    expect(await run(lib, "locale-static.html")).toEqual([]);
    const manual = annotations.filter((a) => a.type === "argus-manual").map((a) => JSON.parse(a.description));
    expect(manual).toEqual([{ check: "locale", step: 2, key: "de-DE|not localized", detail: 'not localized: <html lang> is "en" under de-DE' }]);
  }, 60_000);

  it("a pseudo-locale runs only page-scroll and clipped, and counts the text its render shares with the default locale's", async () => {
    const { lib, annotations } = setup({ pseudo_locales: ["en-XA"] });
    const found = await run(lib, "pseudo.html", { exclude: ["ORDER-77"] });
    // The page holds a number that would fail format checks under a real locale; none runs here.
    expect(found.map((f: Obj) => [f.check, f.key])).toEqual([["locale-clipped", "en-XA||Clipped everywhere|p"]]);
    // Place order changed; the other four (digits-only and translate=no excluded, the typed ORDER-77 excluded) did not.
    expect(annotations.filter((a) => a.type === "argus-info").map((a) => a.description)).toContain("pseudo-localization: 4 text unchanged under en-XA (hard-coded?)");
    expect(annotations.map((a) => a.description).join("\n")).not.toContain("not done");
  }, 90_000);

  it("a pseudo-locale is never failed for its text, and a code the page ignores is counted, not failed", async () => {
    const { lib } = setup({ pseudo_locales: ["de-XA"] });
    const found = await run(lib, "pseudo.html");
    expect(found.filter((f: Obj) => f.check !== "locale-clipped")).toEqual([]);
  }, 90_000);

  it("the other projects skip it, and a repeated URL is looked at once unless the step changes state", async () => {
    const { lib } = setup({ locales: ["de-DE"] }, "chromium");
    expect(await run(lib, "locale-de.html")).toEqual([]);
    const { lib: i18n } = setup({ locales: ["de-DE"] });
    const { context } = await open("locale-de.html");
    const opened = [context];
    const call = (mutates: boolean) => i18n.localeStep(browser, opened, 0, "buyer.1", 2, "j", origin, { width: 1000, height: 700 }, [], [], mutates, true);
    expect((await call(false)).length).toBe(1);
    expect(await call(false)).toEqual([]);
    expect((await call(true)).length).toBe(1);
  }, 90_000);
});

// ---------------------------------------------------------------------------------------------------
// What the generator embeds and emits.

const LIVE = (): Obj => ({ ...example(), test_id_attribute: "data-testid" });
const SMOKE = (extra: Obj = {}): Obj => validateSmoke({ ci: { web_server: [{ command: "npm start", url: "http://localhost:4100/health" }], ports: { web: 4100 }, ...extra } }).value;
const PATH = (): Obj[] => [
  { context: { viewport: 1440, locale: "en-US", timezone: "UTC" } },
  { as: "customer", do: "goto", path: "/orders/new" },
  { as: "customer", do: "fill", target: { label: "Quantity" }, value: "2 {{marker}}" },
  { as: "customer", do: "click", target: { role: "button", name: "Place order" } },
  { as: "customer", do: "read", target: { testId: "order-number" }, save: "order" },
  { as: "customer", do: "click", target: { role: "link", name: "Continue" } },
  { as: "customer", expect: "text-contains", target: { testId: "order-number" }, value: "{{order}}" },
  { as: "system", expect: "fact-equals", marker: "{{marker}}", field: "status", value: "placed" },
];

describe("argus-live layout — the registry and its emitted lines", () => {
  it("registers the layout and locale checks, each with the shape the generator reads, and the sources parse", () => {
    expect(CHECKS.map((c: Obj) => [c.name, c.project, typeof c.source, typeof c.emit])).toEqual([
      ["layout", "viewport", "string", "function"],
      ["locale", "i18n", "string", "function"],
    ]);
    const file = join(tempDir(), "support.mjs");
    writeFileSync(file, stripTypeScriptTypes(CHECKS.map((c: Obj) => c.source).join("\n")));
    expect(spawnSync(process.execPath, ["--check", file], { encoding: "utf8" }).status).toBe(0);
    // The in-page function is plain script: it holds no backtick and no template placeholder.
    expect(PAGE_FN).not.toMatch(/`|\$\{/);
  });

  it("emit adds a soft check after every step that acts as an account, none for a system step", () => {
    const text = smokeSpec({ id: "checkout", path: PATH(), live: LIVE(), smoke: SMOKE() });
    const lines = text.split("\n").filter((l) => l.includes('(await import("./support"))'));
    const layout = lines.filter((l) => l.includes(".layoutStep("));
    expect(layout.length).toBe(6);
    expect(layout[0]).toBe('    expect.soft(await (await import("./support")).layoutStep(opened, 0, 1, "checkout", []), "layout: step 1").toEqual([]);');
    // Every check follows each of the six account steps; the last (system) step gets none.
    for (const fn of ["layoutStep", "localeStep"]) expect(lines.filter((l) => l.includes(`.${fn}(`)).length, fn).toBe(6);
    expect(text.indexOf("fact-equals")).toBeGreaterThan(text.lastIndexOf(".layoutStep("));
    expect(text).not.toContain("`");
  });

  it("the journey's allow list reaches the lines as JSON literals", () => {
    const smoke = validateSmoke({ journeys: { checkout: { allow: [{ check: "target-size", key: 'button|Edit "x"|button' }] } }, ci: { web_server: [{ command: "npm start", url: "http://localhost:4100/health" }], ports: { web: 4100 } } }).value;
    const text = smokeSpec({ id: "checkout", path: PATH(), live: LIVE(), smoke });
    expect(text).toContain('.layoutStep(opened, 0, 1, "checkout", [{"check":"target-size","key":"button|Edit \\"x\\"|button"}])');
  });

  it("locale lines pass the typed values as variables (only those read before the step), a mutating step, and the last account step", () => {
    const text = smokeSpec({ id: "checkout", path: PATH(), live: LIVE(), smoke: SMOKE() });
    const locale = text.split("\n").filter((l) => l.includes(".localeStep("));
    const tail = (l: string) => l.slice(l.indexOf("baseURL"), l.indexOf('), "locale'));
    expect(locale.map(tail)).toEqual([
      "baseURL, viewport, [], [], false, false",
      'baseURL, viewport, [], ["2 " + marker], false, false',
      'baseURL, viewport, [], ["2 " + marker], true, false',
      'baseURL, viewport, [], ["2 " + marker], false, false',
      'baseURL, viewport, [], ["2 " + marker], true, false',
      'baseURL, viewport, [], ["2 " + marker, saved_order], false, true',
    ]);
  });

  it("support.ts embeds every source once, and holds no hard wait, shell or exec", () => {
    const text = supportFile({ live: LIVE(), smoke: SMOKE(), roles: ["customer"] });
    for (const c of CHECKS) expect(text.split(c.source).length - 1, c.name).toBe(1);
    // The login template keeps its own polling; the checks add no hard wait, shell or exec of their own.
    expect(CHECKS.map((c: Obj) => c.source).join("\n")).not.toMatch(/waitForTimeout|setTimeout|sleep|shell|\bexec\(|spawn\(|\/bin\/sh/);
    expect(PAGE_FN).not.toMatch(/waitForTimeout|setTimeout|setInterval/);
  });
});

