// tests/argus-live-tasteprobe.test.ts — lane T1's file: the visual probes of argus-live-taste.mjs (spec §20.2), run
// for real in Chrome against fixture pages that each hold a violation and its excluded twins: the false-positive set
// is the test. A probe that reports a twin costs the lane its credibility, so every exclusion has its page here.
import { createServer, type Server } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { browserTools, cleanTemps, tempDir } from "./helpers/argus-live";
// @ts-expect-error — plain ESM script without types
import { CHECKS, censusOf, ruleExpression, rulesFor, TASTE_INIT, TASTE_SOURCE } from "../plugins/sapu/scripts/argus-live-taste.mjs";
// @ts-expect-error — plain ESM script without types
import { loadBar, validateTaste } from "../plugins/sapu/scripts/argus-live-tastecfg.mjs";

type Obj = Record<string, any>;

afterEach(cleanTemps);

const PAGES = join(__dirname, "fixtures/journey-app/pages/taste");
const BAR = loadBar();
/** taste.json's defaults, with `extra` (J passes the owner's resolved tokens as `tokens`). */
const cfgOf = (extra: Obj = {}) => ({ ...validateTaste({}).value, ...extra });

/** `rgb(r, g, b)` as an oklch() string that resolves to the same 8-bit sRGB colour (the CSS Color 4 OKLab matrices). */
function oklch(r: number, g: number, b: number, a?: string): string {
  const lin = (v: number) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const Bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const H = ((Math.atan2(Bb, A) * 180) / Math.PI + 360) % 360;
  return `oklch(${L.toFixed(6)} ${Math.hypot(A, Bb).toFixed(6)} ${H.toFixed(4)}${a === undefined ? "" : ` / ${a}`})`;
}
/** A fixture page with every rgb()/rgba() colour written as oklch(). */
const toOklch = (html: string) => html.replace(/rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)/g, (_m, r, g, b, a) => oklch(+r, +g, +b, a));

// ---------------------------------------------------------------------------------------------------
// One browser and one local server for the file: each fixture page, and its oklch twin under /oklch/.

let browser: any;
let server: Server;
let origin = "";

beforeAll(async () => {
  const { cli, chrome } = browserTools();
  const { chromium } = createRequire(join(cli.dir, "package.json"))("playwright-core");
  browser = await chromium.launch({ executablePath: chrome.path, headless: true });
  server = createServer((req, res) => {
    const m = /^\/(oklch\/)?([a-z-]+\.html)$/.exec(new URL(String(req.url), "http://x").pathname);
    if (!m) {
      res.statusCode = 404;
      res.end();
      return;
    }
    const html = readFileSync(join(PAGES, m[2]), "utf8");
    res.setHeader("content-type", "text/html");
    res.end(m[1] ? toOklch(html) : html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}, 60_000);

afterAll(async () => {
  await browser?.close();
  server?.closeAllConnections();
  server?.close();
}, 30_000);

const contexts: any[] = [];
/** A fixture page in a fresh context (Playwright's default media: light, no reduced motion, unless given), the motion recorder installed. */
async function open(file: string, { width = 1000, height = 800, colorScheme = "light", reducedMotion = "no-preference" } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme, reducedMotion });
  contexts.push(context);
  if (TASTE_INIT) await context.addInitScript({ content: TASTE_INIT });
  const page = await context.newPage();
  await page.goto(`${origin}/${file}`);
  return page;
}
afterEach(async () => {
  for (const c of contexts.splice(0)) await c.close();
}, 30_000);

/** The rows of `rule` (or every rule) the page's census gives against the shipped bar. */
async function rowsOf(file: string, rule: string | null, cfg: Obj = cfgOf(), size = {}) {
  const screen = await censusOf(await open(file, size));
  const rows = rulesFor(screen, BAR, cfg) as Obj[];
  return rule ? rows.filter((r) => r.rule === rule) : rows;
}
const SCALE = { spacing: [4, 8, 12, 16, 20, 24, 28, 32], type: [12, 14, 16, 20, 24, 32] };

describe("argus-live-taste.mjs — the census (T1.1)", () => {
  it("TASTE_SOURCE is one self-contained in-page function: the census of the page it runs in", async () => {
    const page = await open("census.html");
    const c = await page.evaluate(`(${TASTE_SOURCE})({})`);
    expect(c.media).toEqual({ dark: false, reduce: false });
    expect(c.counts).toEqual({ spacing: expect.any(Number), type: 7, weights: 4, colours: 3, radii: 3, shadows: 2 });
  }, 60_000);

  it("counts match a hand count: eleven spacing values, and five on a 4 px scale", async () => {
    const eleven = await censusOf(await open("scale-eleven.html"));
    expect(eleven.light.counts.spacing).toBe(11);
    expect([...eleven.light.values.spacing].sort((a: number, b: number) => a - b)).toEqual([3, 5, 7, 8, 10, 13, 16, 18, 22, 26, 30]);
    const four = await censusOf(await open("scale-four.html"));
    expect(four.light.counts).toEqual({ spacing: 5, type: 3, weights: 3, colours: 0, radii: 1, shadows: 0 });
  }, 60_000);

  it("censusOf answers the page's own media, explicit, and leaves it as it found it", async () => {
    const page = await open("census.html");
    const screen = await censusOf(page);
    expect(screen.media).toEqual({ colorScheme: "light", reducedMotion: "no-preference" });
    expect(await page.evaluate('matchMedia("(prefers-color-scheme: dark)").matches')).toBe(false);
    expect(await page.evaluate('matchMedia("(prefers-reduced-motion: reduce)").matches')).toBe(false);
  }, 60_000);

  it("colours resolve through the canvas: an oklch() page scores exactly like its sRGB twin [mdn-oklch]", async () => {
    for (const file of ["census.html", "primary-three.html", "radius.html", "dark.html", "role-split.html"]) {
      const srgb = await censusOf(await open(file));
      const ok = await censusOf(await open(`oklch/${file}`));
      expect(await (await open(`oklch/${file}`)).evaluate("getComputedStyle(document.body).color"), file).toMatch(/^oklch\(/);
      expect(ok.light.counts, file).toEqual(srgb.light.counts);
      expect(ok.light.palette, file).toEqual(srgb.light.palette);
      expect(rulesFor(ok, BAR, cfgOf()), file).toEqual(rulesFor(srgb, BAR, cfgOf()));
    }
  }, 60_000);
});

describe("argus-live-taste.mjs — scale and restraint (T1.1)", () => {
  it("each count rule is one measurement row a screen for the judge (expected: peer), its witnesses being the judge's", async () => {
    const rows = await rowsOf("scale-eleven.html", null);
    const peer = rows.filter((r) => r.expected === "peer");
    expect(peer.map((r) => r.rule).sort()).toEqual(["scale.colours", "scale.radii", "scale.shadows", "scale.spacing", "scale.type", "scale.weights"]);
    expect(peer.find((r) => r.rule === "scale.spacing")).toEqual({ rule: "scale.spacing", key: "screen", measured: 11, expected: "peer" });
  }, 60_000);

  it("off-scale: each value off the owner's scale is its own row; on the scale, and with no scale at all, nothing", async () => {
    const off = await rowsOf("scale-eleven.html", "scale.off-scale", cfgOf({ tokens: SCALE }));
    expect(off.map((r) => r.key).sort()).toEqual(["spacing:10px", "spacing:13px", "spacing:18px", "spacing:22px", "spacing:26px", "spacing:30px", "spacing:3px", "spacing:5px", "spacing:7px"]);
    expect(off.find((r) => r.key === "spacing:13px")).toEqual({ rule: "scale.off-scale", key: "spacing:13px", measured: 13, expected: "on the token spacing scale" });
    expect(await rowsOf("scale-four.html", "scale.off-scale", cfgOf({ tokens: SCALE }))).toEqual([]);
    expect(await rowsOf("scale-eleven.html", "scale.off-scale")).toEqual([]);
  }, 60_000);

  it("off-scale reads a frame of the bar when the owner names one (polaris: 4 to 128 in steps of 4)", async () => {
    const off = await rowsOf("scale-eleven.html", "scale.off-scale", cfgOf({ frame: "polaris" }));
    expect(off.map((r) => r.measured).sort((a, b) => a - b)).toEqual([3, 5, 7, 10, 13, 18, 22, 26, 30]);
    expect(off[0].expected).toBe("on the polaris spacing scale");
  }, 60_000);

  it("fluid type: a clamp() size is measured per viewport and never off the scale; a fixed off-scale size is [mdn-clamp]", async () => {
    for (const width of [1000, 700]) {
      const screen = await censusOf(await open("fluid.html", { width }));
      const fluid = screen.light.values.type.filter((t: Obj) => t.fluid).map((t: Obj) => t.px);
      expect(fluid, String(width)).toEqual([width === 1000 ? 30 : 21]);
      const off = rulesFor(screen, BAR, cfgOf({ tokens: SCALE })).filter((r: Obj) => r.rule === "scale.off-scale" && r.key.startsWith("type:"));
      expect(off, String(width)).toEqual([{ rule: "scale.off-scale", key: "type:18px", measured: 18, expected: "on the token type scale" }]);
    }
  }, 60_000);

  it("cfg.off silences a rule the owner turned off", async () => {
    expect(await rowsOf("scale-eleven.html", "scale.spacing", cfgOf({ off: ["scale.spacing"] }))).toEqual([]);
  }, 60_000);
});

describe("argus-live-taste.mjs — hierarchy and rhythm (T1.1)", () => {
  it("primary actions: three filled primaries fire (bar) [m3-expressive] [lux-hick]", async () => {
    expect(await rowsOf("primary-three.html", "hierarchy.primary-actions")).toEqual([{ rule: "hierarchy.primary-actions", key: "view", measured: 3, expected: 1 }]);
  }, 60_000);

  it("primary actions: one primary beside outline, pale and disabled buttons; a row action repeated; a modal's own view: silent", async () => {
    for (const f of ["primary-one.html", "primary-rows.html", "primary-modal.html"]) expect(await rowsOf(f, "hierarchy.primary-actions"), f).toEqual([]);
  }, 60_000);

  it("heading order: an h2 larger than the h1 it sits under fires; an equal size down the levels, a smaller heading elsewhere and a visually hidden one hold", async () => {
    expect(await rowsOf("headings.html", "hierarchy.heading-order")).toEqual([{ rule: "hierarchy.heading-order", key: "h2|Profile", measured: 32, expected: "at most 24 (its parent heading)" }]);
  }, 60_000);

  it("alignment: a sibling 2 px off fires; 8 px, centred, right-aligned and side-by-side siblings hold [apple-layout]", async () => {
    expect(await rowsOf("align.html", "hierarchy.alignment")).toEqual([{ rule: "hierarchy.alignment", key: "div|Email", measured: 2, expected: "aligned, or at least 4 px apart" }]);
  }, 60_000);

  it("section gaps: a gap off the scale fires; the gaps on it, and any gap with no scale, hold", async () => {
    expect(await rowsOf("gaps.html", "hierarchy.section-gaps", cfgOf({ tokens: { spacing: [8, 16, 24, 32] } }))).toEqual([{ rule: "hierarchy.section-gaps", key: "gap:20px", measured: 20, expected: "on the token spacing scale" }]);
    expect(await rowsOf("gaps.html", "hierarchy.section-gaps")).toEqual([]);
  }, 60_000);

  it("shadow layers: five shadows on two layers fire; one a layer with a focus ring and an inset shadow holds", async () => {
    expect(await rowsOf("shadows-five.html", "hierarchy.shadow-layers")).toEqual([{ rule: "hierarchy.shadow-layers", key: "view", measured: 5, expected: "at most 2 (layers: overlay, raised)" }]);
    expect(await rowsOf("shadows-two.html", "hierarchy.shadow-layers")).toEqual([]);
    expect((await rowsOf("shadows-two.html", "scale.shadows"))[0].measured).toBe(2);
  }, 60_000);

  it("nested radius: a more rounded child flush in its parent's corner fires; inset, circular and smaller children hold [vercel-wig]", async () => {
    expect(await rowsOf("radius.html", "hierarchy.nested-radius")).toEqual([{ rule: "hierarchy.nested-radius", key: "div|Flush child", measured: 16, expected: "at most 8 (its parent's)" }]);
  }, 60_000);
});

describe("argus-live-taste.mjs — the page expression and the pure judge (T1.1)", () => {
  it("rulesFor is self-contained: its source run in the page gives the rows it gives here", async () => {
    const page = await open("headings.html");
    const screen = await censusOf(page);
    expect(await page.evaluate(`(${String(rulesFor)})(${JSON.stringify(screen)}, ${JSON.stringify(BAR)}, ${JSON.stringify(cfgOf())})`)).toEqual(rulesFor(screen, BAR, cfgOf()));
  }, 60_000);

  it("ruleExpression(rule) is a page expression giving that rule's rows on the current page", async () => {
    expect(await (await open("headings.html")).evaluate(ruleExpression("hierarchy.heading-order"))).toEqual([{ rule: "hierarchy.heading-order", key: "h2|Profile", measured: 32, expected: "at most 24 (its parent heading)" }]);
    expect(await (await open("primary-one.html")).evaluate(ruleExpression("hierarchy.primary-actions"))).toEqual([]);
    expect(await (await open("scale-eleven.html")).evaluate(ruleExpression("scale.spacing"))).toEqual([{ rule: "scale.spacing", key: "screen", measured: 11, expected: "peer" }]);
  }, 60_000);

  it("ruleExpression: with no scale, an off-scale rule lists every value it measured, so a replay re-measures a row by its key", async () => {
    const page = await open("scale-eleven.html");
    const keys = (await page.evaluate(ruleExpression("scale.off-scale"))).map((r: Obj) => r.key);
    expect(keys.filter((k: string) => k.startsWith("spacing:")).sort()).toEqual(["10px", "13px", "16px", "18px", "22px", "26px", "30px", "3px", "5px", "7px", "8px"].map((v) => `spacing:${v}`));
    expect((await page.evaluate(ruleExpression("scale.off-scale", { tokens: SCALE }))).map((r: Obj) => r.key)).not.toContain("spacing:8px");
  }, 60_000);

  it("ruleExpression refuses a rule another module measures, or one the bar lacks", () => {
    expect(() => ruleExpression("copy.broken")).toThrow("failed: ruleExpression: copy.broken is not a screen rule of the taste probe");
    expect(() => ruleExpression("scale.vibes")).toThrow("failed: ruleExpression: scale.vibes is not a screen rule of the taste probe");
  });
});

const ruleOf = (id: string) => BAR.rules.find((r: Obj) => r.id === id);
const keysOf = (rows: Obj[]) => rows.map((r) => r.key).sort();

describe("argus-live-taste.mjs — colour roles, dark parity, contrast headroom (T1.2)", () => {
  it("colour roles: one status in two colours on one screen is derived; a status link is not a badge [radix] [stripe-color]", async () => {
    expect(ruleOf("colour.role").class).toBe("derived");
    expect(await rowsOf("role-split.html", "colour.role")).toEqual([{ rule: "colour.role", key: "paid", measured: "2 values: rgb(22, 163, 74) / rgb(255, 255, 255) | rgb(37, 99, 235) / rgb(255, 255, 255)", expected: "one value" }]);
    for (const f of ["role-a.html", "role-b.html"]) expect(await rowsOf(f, "colour.role"), f).toEqual([]);
  }, 60_000);

  it("colour roles across screens: the judge joins two screens' roles, and only the status rendered two ways is a row", async () => {
    const a = await censusOf(await open("role-a.html"));
    const b = await censusOf(await open("role-b.html"));
    const joined = { ...a, light: { ...a.light, roles: [...a.light.roles, ...b.light.roles] } };
    expect(rulesFor(joined, BAR, cfgOf()).filter((r: Obj) => r.rule === "colour.role")).toEqual([{ rule: "colour.role", key: "paid", measured: "2 values: rgb(22, 163, 74) / rgb(255, 255, 255) | rgb(37, 99, 235) / rgb(255, 255, 255)", expected: "one value" }]);
  }, 60_000);

  it("dark parity: a dark-only contrast failure, a collapsed border and a surface left light are implicit; every twin holds [apple-dark]", async () => {
    for (const id of ["colour.dark-contrast", "colour.dark-border", "colour.dark-surface"]) expect(ruleOf(id).class, id).toBe("implicit");
    const screen = await censusOf(await open("dark.html"));
    expect(screen.themes).toBe("dual");
    const rows = rulesFor(screen, BAR, cfgOf());
    const of = (id: string) => rows.filter((r: Obj) => r.rule === id);
    // The legacy panel's light ink on its light surface fails only in dark too: two measured defects of one element.
    expect(keysOf(of("colour.dark-contrast"))).toEqual(["div|Legacy panel", "p|Last signed in yesterday"]);
    expect(of("colour.dark-contrast").find((r: Obj) => r.key.startsWith("p|"))).toEqual({ rule: "colour.dark-contrast", key: "p|Last signed in yesterday", measured: 1.91, expected: "at least 4.5:1, as in light (4.74:1)" });
    expect(of("colour.dark-border")).toEqual([{ rule: "colour.dark-border", key: "input|Display name", measured: 1, expected: "an edge of at least 1.1:1, as in light (1.48:1)" }]);
    expect(of("colour.dark-surface")).toEqual([{ rule: "colour.dark-surface", key: "div|Legacy panel", measured: "rgb(255, 255, 255) on rgb(10, 10, 10)", expected: "a dark surface, as the page is" }]);
  }, 60_000);

  it("censusOf reads the other theme and restores the page's own media explicitly, never by null: a dark context stays dark", async () => {
    const page = await open("dark.html", { colorScheme: "dark", reducedMotion: "reduce" });
    const sheets = await page.evaluate("document.adoptedStyleSheets.length");
    const screen = await censusOf(page);
    expect(screen.media).toEqual({ colorScheme: "dark", reducedMotion: "reduce" });
    expect(screen.light.media.dark).toBe(false);
    expect(screen.dark.media.dark).toBe(true);
    expect(await page.evaluate('[matchMedia("(prefers-color-scheme: dark)").matches, matchMedia("(prefers-reduced-motion: reduce)").matches]')).toEqual([true, true]);
    expect(await page.evaluate("document.adoptedStyleSheets.length")).toBe(sheets);
    // The base census is the page's own (dark here), and the parity rows read the same either way.
    expect(rulesFor(screen, BAR, cfgOf()).filter((r: Obj) => r.rule.startsWith("colour.dark-")).length).toBe(4);
  }, 60_000);

  it("a single-theme app is reported single theme, and no dark parity row is measured", async () => {
    const screen = await censusOf(await open("single.html"));
    expect(screen.themes).toBe("single");
    expect(screen.dark).toBe(null);
    expect(rulesFor(screen, BAR, cfgOf()).filter((r: Obj) => r.rule.startsWith("colour.dark-"))).toEqual([]);
  }, 60_000);

  it("contrast.headroom: body text that passes AA under 7:1 is a row of an information rule, never gated [apple-dark] [wcag3-wd]", async () => {
    expect(ruleOf("contrast.headroom")).toMatchObject({ info: true, threshold: { min: 7 } });
    expect(validateTaste({ gate: ["contrast.headroom"] }).errors).toEqual(["gate: contrast.headroom is information only: it cannot gate"]);
    expect(await rowsOf("single.html", "contrast.headroom")).toEqual([{ rule: "contrast.headroom", key: "rgb(115, 115, 115) on rgb(255, 255, 255)", measured: 4.74, expected: 7 }]);
    // Under 4.5:1 is axe's failure, not headroom; over a gradient is unmeasured; a disabled control is exempt.
    expect(keysOf(await rowsOf("dark.html", "contrast.headroom"))).toEqual(["rgb(115, 115, 115) on rgb(255, 255, 255)"]);
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------------
// The suite's check: the registry entry's source loaded as the support file holds it, run against the pages.

/** The taste check's source → its exported and local names (vitest's Function has no dynamic import: `require` stands in). */
function loadCheck(scope: Obj) {
  const js = stripTypeScriptTypes(CHECKS.map((c: Obj) => c.source).join("\n")).replace(/^export /gm, "").replace(/await import\("node:fs"\)/g, 'require("node:fs")');
  const found = [...js.matchAll(/^(?:async function|function|const) (\w+)/gm)].map((m) => m[1]);
  return new Function("require", ...Object.keys(scope), `${js}\nreturn { ${found.join(", ")} };`)(createRequire(import.meta.url), ...Object.values(scope)) as Obj;
}
/** A support-file scope: a stand-in `test` collecting annotations, the repo (with `taste` as its .argus/taste.json) and the suite's directory. */
function suiteEnv(taste: Obj | null = null, known: Obj[] | null = null) {
  const dir = tempDir();
  const annotations: { type: string; description: string }[] = [];
  if (taste) {
    mkdirSync(join(dir, ".argus"));
    writeFileSync(join(dir, ".argus/taste.json"), JSON.stringify(taste));
  }
  if (known) {
    mkdirSync(join(dir, "known"));
    writeFileSync(join(dir, "known/j.json"), JSON.stringify(known));
  }
  const lib = loadCheck({ test: { info: () => ({ project: { name: "taste" }, annotations }) }, path: { join }, REPO: dir, __dirname: dir });
  return { lib, annotations };
}
const ofType = (annotations: Obj[], type: string) => annotations.filter((a) => a.type === type).map((a) => a.description);

describe("argus-live-taste.mjs — the suite's taste check (T1.2)", () => {
  it("registers one check of the taste project, one soft line a step of each account, none for the system", () => {
    expect(CHECKS.map((c: Obj) => [c.name, c.project])).toEqual([["taste", "taste"]]);
    const steps = [{ n: 1, as: "customer.1", do: "goto" }, { n: 2, as: "system", do: "trigger" }, { n: 3, as: "admin.1", do: "click" }];
    expect(CHECKS[0].emit(steps[0], { id: "j", steps })).toEqual(['expect.soft(await (await import("./support")).tasteStep(opened, 0, 1, "j"), "taste: step 1").toEqual([]);']);
    expect(CHECKS[0].emit(steps[1], { id: "j", steps })).toEqual([]);
    expect(CHECKS[0].emit(steps[2], { id: "j", steps })[0]).toContain("tasteStep(opened, 1, 3,");
    expect(stripTypeScriptTypes(CHECKS[0].source)).not.toMatch(/shell|\bexec\(|spawn\(|waitForTimeout/);
  });

  it("advisory by default: rows annotate argus-taste, an information rule argus-info, a single theme one line; nothing fails", async () => {
    const { lib, annotations } = suiteEnv();
    const opened = [(await open("single.html")).context()];
    expect(await lib.tasteStep(opened, 0, 2, "j")).toEqual([]);
    expect(ofType(annotations, "argus-info")).toEqual(["taste: single theme (the app does not answer prefers-color-scheme): dark parity not judged", 'taste contrast.headroom "rgb(115, 115, 115) on rgb(255, 255, 255)": 4.74 (expected 7)']);
    expect(ofType(annotations, "argus-taste")).toEqual([]);
    // The same screen again adds nothing: each row is said once a test.
    await lib.tasteStep(opened, 0, 3, "j");
    expect(annotations.length).toBe(2);
    const dark = suiteEnv();
    expect(await dark.lib.tasteStep([(await open("dark.html")).context()], 0, 1, "j")).toEqual([]);
    const rows = ofType(dark.annotations, "argus-taste").map((d) => JSON.parse(d));
    expect(rows).toContainEqual({ rule: "colour.dark-border", step: 1, key: "input|Display name", measured: 1, expected: "an edge of at least 1.1:1, as in light (1.48:1)" });
    expect(rows.some((r) => r.expected === "peer" || r.rule === "contrast.headroom")).toBe(false);
  }, 60_000);

  it("a rule the owner gates fails as argus-violation, unless adopted in known/<id>.json", async () => {
    const gated = suiteEnv({ gate: ["colour.dark-border"] });
    const page = await open("dark.html");
    expect(await gated.lib.tasteStep([page.context()], 0, 4, "j")).toEqual([{ check: "colour.dark-border", step: 4, key: "input|Display name", detail: "1 → expected an edge of at least 1.1:1, as in light (1.48:1)" }]);
    expect(ofType(gated.annotations, "argus-violation").map((d) => JSON.parse(d).check)).toEqual(["colour.dark-border"]);
    expect(ofType(gated.annotations, "argus-taste").map((d) => JSON.parse(d).rule)).not.toContain("colour.dark-border");
    const adopted = suiteEnv({ gate: ["colour.dark-border"] }, [{ check: "colour.dark-border", key: "input|Display name" }]);
    expect(await adopted.lib.tasteStep([(await open("dark.html")).context()], 0, 4, "j")).toEqual([]);
    const off = suiteEnv({ off: ["colour.dark-border"] });
    await off.lib.tasteStep([(await open("dark.html")).context()], 0, 4, "j");
    expect(off.annotations.map((a) => a.description).join("\n")).not.toContain("dark-border");
  }, 60_000);
});

describe("argus-live-taste.mjs — lane 0's stubs not yet replaced", () => {
  it("TASTE_INIT is the init payload's motion recorder (stub: empty, so nothing is installed)", () => {
    expect(TASTE_INIT).toBe("");
  });
});
