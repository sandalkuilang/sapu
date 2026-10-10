// tests/argus-live-ease.test.ts — lane T2's file: the ease probes of argus-live-ease.mjs (spec §20.2, plan lane T2).
// Every rule is shown firing on its fixture and silent on the twin that shares everything but the defect: a false
// positive costs the lane its credibility. Real Chrome (the pinned install's playwright-core) against a local server;
// the pure parts (the judge, the path's cost, the cross-screen rules) on synthetic data.
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { browserTools, cleanTemps } from "./helpers/argus-live";
// @ts-expect-error — plain ESM script without types
import { CHECKS, EASE_INIT, EASE_RENDER, EASE_SOURCE, easeOf, pathCost, ruleExpression, rulesFor } from "../plugins/sapu/scripts/argus-live-ease.mjs";
// @ts-expect-error — plain ESM script without types
import { loadBar, RENDER_ATTRIBUTES, TASTE_BUFFER, TASTE_DRAIN, tasteEventFault, validateTaste } from "../plugins/sapu/scripts/argus-live-tastecfg.mjs";

type Obj = Record<string, any>;
const BAR = loadBar();
const CFG = validateTaste({}).value;
const TERMS = BAR.rules.find((r: Obj) => r.id === "copy.vague").terms;
const PAGES = join(__dirname, "fixtures/journey-app/pages/ease");
const fnOf = (src: string) => new Function(`return (${src});`)();
const ease = fnOf(EASE_SOURCE);

afterEach(cleanTemps);

// ---------------------------------------------------------------------------------------------------
// One browser and one local server for the file.

let browser: any;
let server: Server;
let origin = "";
const hits: string[] = [];
const listen = (s: Server) => new Promise<number>((resolve) => s.listen(0, "127.0.0.1", () => resolve((s.address() as { port: number }).port)));
const FILL: Record<string, [string, string]> = { __MODE__: ["mode", "keep"], __ROWS__: ["rows", "4"], __LANG__: ["lang", "en"], __SUBMIT__: ["submit", "Submit"], __CONFIRM__: ["confirm", "OK"] };

beforeAll(async () => {
  const { cli, chrome } = browserTools();
  const { chromium } = createRequire(join(cli.dir, "package.json"))("playwright-core");
  browser = await chromium.launch({ executablePath: chrome.path, headless: true });
  server = createServer((req, res) => {
    const url = new URL(String(req.url), origin);
    const name = url.pathname === "/consist-c.html" ? "/consist-a.html" : url.pathname;
    if (/^\/[a-z-]+\.html$/.test(name)) {
      let text = readFileSync(join(PAGES, name.slice(1)), "utf8");
      for (const [mark, [q, d]] of Object.entries(FILL)) text = text.split(mark).join((url.searchParams.get(q) || d).replace(/[<>"&]/g, ""));
      res.setHeader("content-type", "text/html");
      res.end(text);
      return;
    }
    if (name === "/favicon.ico") {
      res.statusCode = 204;
      res.end();
      return;
    }
    hits.push(`${req.method} ${name}`);
    req.resume();
    const ms = Number(url.searchParams.get("ms") || 0);
    const json = (body: unknown) => setTimeout(() => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body));
    }, ms);
    if (name === "/api/wait") return json({ ms });
    if (name === "/api/items") return json([{ name: "Order one" }, { name: "Order two" }]);
    if (["/api/save", "/api/notes", "/api/prefs", "/api/check"].includes(name)) return json({ ok: true });
    res.statusCode = 404;
    res.end("no");
  });
  origin = `http://127.0.0.1:${await listen(server)}`;
}, 60_000);

afterAll(async () => {
  await browser?.close();
  server?.closeAllConnections();
  server?.close();
}, 30_000);

const contexts: any[] = [];
afterEach(async () => {
  for (const c of contexts.splice(0)) await c.close();
}, 30_000);

/** A fixture page in a fresh context whose documents run the taste buffer and the feedback clock, as the session hook's payload does. */
async function open(file: string, { arm = true } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  contexts.push(context);
  if (arm) await context.addInitScript(`${TASTE_BUFFER};\n${EASE_INIT}`);
  const page = await context.newPage();
  await page.goto(`${origin}/${file}`);
  return page;
}

/** The screen as the lane records it: EASE_SOURCE's answer and the drained buffer, every event checked against the shared shape. */
async function record(page: any, extra: Obj = {}) {
  const answer = await page.evaluate(`(${EASE_SOURCE})(${JSON.stringify({ kind: "screen", terms: TERMS, ...extra })})`);
  const drained = await page.evaluate(TASTE_DRAIN);
  for (const e of drained.events) expect(tasteEventFault(e), JSON.stringify(e)).toBeNull();
  expect(drained.dropped).toBe(0);
  return { route: answer.route, events: drained.events, ease: answer };
}
const judged = (screen: Obj, cfg: Obj = CFG) => rulesFor(screen, BAR, cfg);
const ids = (found: Obj[]) => found.map((f) => f.rule).sort();
/** The rules that file: information rules (feedback.latency, states.error-exit, ...) are reports, and a loaded machine may stretch a 50 ms answer past 100. */
const INFO = new Set(BAR.rules.filter((r: Obj) => r.info).map((r: Obj) => r.id));
const filed = (found: Obj[]) => ids(found).filter((r) => !INFO.has(r));
const one = (found: Obj[], rule: string) => {
  const rows = found.filter((f) => f.rule === rule);
  expect(rows, `${rule} in ${JSON.stringify(found)}`).toHaveLength(1);
  return rows[0];
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------------
// The shared shapes.

describe("argus-live-ease.mjs — the shapes it shares with lane 0", () => {
  it("counts the rendering attributes -tastecfg names, and installs once a document behind the taste buffer", () => {
    expect(EASE_RENDER).toEqual([...RENDER_ATTRIBUTES]);
    expect(EASE_INIT).toContain(JSON.stringify(EASE_RENDER));
    expect(EASE_INIT).toContain("doc.__argusEase || typeof doc.__argusTastePush !== \"function\"");
    expect(() => new Function(EASE_INIT)).not.toThrow();
    expect(typeof ease).toBe("function");
    // The in-page sources never hold a template interpolation or a word the support file's scans refuse.
    for (const src of [EASE_INIT, EASE_SOURCE]) {
      expect(src).not.toContain("${");
      expect(src).not.toMatch(/shell|\bexec\(|spawn\(/);
    }
  });

  it("ruleExpression answers only the screen rules a page can measure alone", () => {
    for (const r of ["feedback.busy", "feedback.loader-flash", "feedback.optimistic", "states.success"]) {
      expect(ruleExpression(r)).toContain('"kind":"rule"');
    }
    expect(() => ruleExpression("consistent.action")).toThrow("refused: ruleExpression: consistent.action is not a screen rule of the ease probe");
    expect(() => ruleExpression("scale.spacing")).toThrow("is not a screen rule of the ease probe");
    expect(() => ruleExpression("states.recovery")).toThrow("refused: ruleExpression: states.recovery has no page expression: a form case drives it");
    expect(() => ruleExpression("feedback.skeleton-peers")).toThrow("it compares a screen with its peers");
    expect(() => ruleExpression("ai.stop")).toThrow("refused: ruleExpression: ai.stop: not built yet");
  });
});

// ---------------------------------------------------------------------------------------------------
// T2.1 — feedback and loaders, on synthetic clocks (each side of each threshold).

const input = (t: number, type = "click") => ({ kind: "input", t, type });
const change = (t: number) => ({ kind: "change", t, cause: "added", attr: null });
const busy = (t: number, on: boolean, signal: string) => ({ kind: "busy", t, on, signal });
const req = (t: number, end: number | null, method = "GET", status = 200) => ({ t, end, status, method, route: "/api/x", keys: [], same: true });
/** One click at t=1000 (its pointerdown at 995) that starts a request at 1002, judged at `now`. */
const clock = (events: Obj[], requests: Obj[], now = 60_000, cfg: Obj = CFG, route = "/orders") =>
  judged({ route, events: [input(995, "pointerdown"), input(1000), ...events], ease: { now, requests } }, cfg);

describe("argus-live ease — D10's feedback clock, each side of each threshold", () => {
  it("latency: information past 100 ms to the first visible change, measured from the pointerdown", () => {
    expect(clock([change(1080)], [req(1002, 1070)])).toEqual([]);
    expect(one(clock([change(1145)], [req(1002, 1140)]), "feedback.latency")).toEqual({ rule: "feedback.latency", key: "action", measured: 150, expected: "a visible change within 100 ms" });
  });

  it("busy: a wait past 1 s with nothing shown fires; a change within the second, or a response that came first, holds", () => {
    expect(one(clock([change(2497)], [req(1002, 2495)]), "feedback.busy").measured).toBe(1500);
    expect(ids(clock([change(1003), change(2497)], [req(1002, 2495)]))).toEqual([]);
    expect(ids(clock([change(1900)], [req(1002, 1890)]))).toEqual(["feedback.latency"]);
    // The response came at 50 ms; a change 1.5 s later is not that wait's (a refresh of its own).
    expect(ids(clock([change(2500)], [req(1002, 1045)]))).toEqual(["feedback.latency"]);
  });

  it("busy: an action that sent no request, or showed nothing before the next input, is never measured", () => {
    expect(clock([change(2500)], [])).toEqual([]);
    expect(clock([input(1600, "input"), change(2500)], [req(1002, 2400)])).toEqual([]);
    // A request that started past the action's first 100 ms is not the action's.
    expect(clock([change(2500)], [req(1200, 2400)])).toEqual([]);
    // A third-party request is not the app's wait.
    expect(clock([change(2500)], [{ ...req(1002, 2400), same: false }])).toEqual([]);
  });

  it("progress: past 10 s without a determinate progressbar fires; with one, or under 10 s, holds", () => {
    const spin = [busy(1004, true, "spinner"), change(1004), busy(13_000, false, "spinner")];
    expect(one(clock(spin, [req(1002, 12_998)]), "feedback.progress")).toMatchObject({ key: "action", measured: 12_005 });
    expect(ids(clock([busy(1004, true, "progressbar"), change(1004), busy(13_000, false, "progressbar")], [req(1002, 12_998)]))).toEqual([]);
    expect(ids(clock([busy(1004, true, "spinner"), change(1004), busy(9_990, false, "spinner")], [req(1002, 9_988)]))).toEqual([]);
  });

  it("loader-flash: shown under 300 ms, or for a wait under 1 s, fires; a loader that stays for a long wait holds", () => {
    const flash = clock([busy(1004, true, "spinner"), change(1004), busy(1124, false, "spinner")], [req(1002, 1120)]);
    expect(one(flash, "feedback.loader-flash")).toEqual({ rule: "feedback.loader-flash", key: "action|spinner", measured: 120, expected: "shown at least 300 ms, and none for a wait under 1000 ms" });
    expect(one(clock([busy(1200, true, "spinner"), change(1200), busy(1600, false, "spinner")], [req(1002, 1598)]), "feedback.loader-flash").measured).toBe(400);
    expect(filed(clock([busy(1200, true, "spinner"), change(1200), busy(2500, false, "spinner")], [req(1002, 2498)]))).toEqual([]);
    // A loader that never goes is not a flash (a decoration, or the progress rule's).
    expect(ids(clock([busy(1004, true, "skeleton"), change(1004)], [req(1002, 1300)]))).toEqual([]);
    // At load (before any input): its wait is the document's time to the loader's end.
    expect(ids(judged({ route: "/", events: [busy(100, true, "skeleton"), busy(1500, false, "skeleton")], ease: { now: 9000, requests: [] } }))).toEqual([]);
    expect(one(judged({ route: "/", events: [busy(100, true, "skeleton"), busy(700, false, "skeleton")], ease: { now: 9000, requests: [] } }), "feedback.loader-flash").key).toBe("load|skeleton");
  });

  it("skeleton-shift: a skeleton replaced by content that moved others fires; none holds", () => {
    expect(one(judged({ route: "/", events: [], ease: { now: 1, requests: [], shifts: 1 } }), "feedback.skeleton-shift")).toMatchObject({ key: "skeleton", measured: 1 });
    expect(judged({ route: "/", events: [], ease: { now: 1, requests: [], shifts: 0 } })).toEqual([]);
  });

  it("optimistic: on a declared route, a change only after the write's answer fires; before it holds; undeclared is silent", () => {
    const cfg = { ...CFG, optimistic: ["/likes/*"] };
    const late = [change(1310)];
    const writes = [req(1002, 1300, "POST")];
    expect(one(clock(late, writes, 60_000, cfg, "/likes/:id"), "feedback.optimistic")).toMatchObject({ key: "action", measured: 1 });
    expect(ids(clock([change(1003)], writes, 60_000, cfg, "/likes/:id"))).toEqual([]);
    expect(filed(clock(late, writes, 60_000, cfg, "/orders"))).toEqual([]);
  });

  it("an owner's `off` rule is never reported", () => {
    expect(ids(clock([change(2497)], [req(1002, 2495)], 60_000, { ...CFG, off: ["feedback.busy", "feedback.latency"] }))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------
// T2.1 — the same clock in Chrome: the measured time within ±50 ms of the fixture's delay.

/** Clicks `id` on a fresh feedback page and waits for the text the page shows when it is done. */
async function act(id: string, done: string) {
  const page = await open("feedback.html");
  await page.evaluate(TASTE_DRAIN);
  await page.click(`#${id}`);
  await page.getByText(done).waitFor({ timeout: 30_000 });
  return record(page);
}

describe("argus-live ease — the feedback clock in Chrome", () => {
  it("each event the clock pushes has the shared shape; an action is a pointerdown, a click and its first change", async () => {
    const s = await act("quick", "quick 50");
    const kinds = s.events.map((e: Obj) => (e.kind === "input" ? e.type : e.kind));
    expect(kinds.slice(0, 3)).toEqual(["pointerdown", "click", "change"]);
    expect(filed(judged(s))).toEqual([]);
    expect(s.ease.requests).toEqual([expect.objectContaining({ method: "GET", route: "/api/wait", status: 200, same: true, keys: [] })]);
  }, 60_000);

  it("latency and busy: 150 ms is information, 1.5 s with nothing shown fires within ±50 ms, aria-busy and a class change hold", async () => {
    const [slow, silent, signalled, classy] = await Promise.all([act("slow", "slow 150"), act("silent", "silent done"), act("busy", "busy done"), act("classy", "classy done")]);
    const lat = one(judged(slow), "feedback.latency").measured;
    expect(lat).toBeGreaterThanOrEqual(100);
    expect(lat).toBeLessThanOrEqual(200);
    const b = one(judged(silent), "feedback.busy").measured;
    expect(b).toBeGreaterThanOrEqual(1450);
    expect(b).toBeLessThanOrEqual(1550);
    expect(filed(judged(signalled))).toEqual([]);
    expect(signalled.events.filter((e: Obj) => e.kind === "busy").map((e: Obj) => [e.signal, e.on])).toEqual([["aria-busy", true], ["aria-busy", false]]);
    expect(filed(judged(classy))).toEqual([]);
  }, 60_000);

  it("a data-* attribute set at once is no feedback: the wait still fires", async () => {
    const s = await act("data", "data done");
    const b = one(judged(s), "feedback.busy").measured;
    expect(b).toBeGreaterThanOrEqual(1450);
    expect(b).toBeLessThanOrEqual(1550);
  }, 60_000);

  it("progress: 12 s behind a spinner fires within ±50 ms; behind a determinate bar it holds", async () => {
    const [spin, bar] = await Promise.all([act("long-spin", "long spin done"), act("long-bar", "long bar done")]);
    const p = one(judged(spin), "feedback.progress").measured;
    expect(p).toBeGreaterThanOrEqual(11_950);
    expect(p).toBeLessThanOrEqual(12_050);
    expect(filed(judged(bar))).toEqual([]);
  }, 60_000);

  it("loader-flash: 120 ms fires, 400 ms for a 600 ms wait fires, a delayed loader for 1.5 s holds", async () => {
    const [flash, quick, delayed] = await Promise.all([act("flash", "flash done"), act("quick-loader", "quick loader done"), act("delayed", "delayed done")]);
    const f = one(judged(flash), "feedback.loader-flash");
    expect(f.key).toBe("action|spinner");
    expect(f.measured).toBeGreaterThanOrEqual(70);
    expect(f.measured).toBeLessThanOrEqual(170);
    expect(one(judged(quick), "feedback.loader-flash").measured).toBeLessThan(600);
    expect(filed(judged(delayed))).toEqual([]);
  }, 60_000);

  it("a client-only change, and a page that changes by itself after a click into a field, are never waits", async () => {
    expect(ids(judged(await act("local", "local done")))).toEqual([]);
    const page = await open("poll.html");
    await page.click("#q");
    await sleep(1500);
    const s = await record(page);
    expect(s.events.filter((e: Obj) => e.kind === "change")).toHaveLength(1);
    expect(ids(judged(s))).toEqual([]);
  }, 60_000);

  it("skeleton-shift: a skeleton replaced by taller content fires; one replaced in place holds", async () => {
    const [moved, still] = await Promise.all([open("skeleton.html?rows=4"), open("skeleton.html?rows=1")]);
    await Promise.all([moved.getByText("Order 4").waitFor({ timeout: 30_000 }), still.getByText("Order 1").waitFor({ timeout: 30_000 })]);
    await sleep(600);
    const m = await record(moved);
    expect(m.events.filter((e: Obj) => e.kind === "busy").map((e: Obj) => [e.signal, e.on])).toEqual([["skeleton", true], ["skeleton", false]]);
    expect(ids(judged(m))).toEqual(["feedback.skeleton-shift"]);
    expect(ids(judged(await record(still)))).toEqual([]);
  }, 60_000);

  it("a change inside a shadow root counts: a component that signals holds; one silent for 1.5 s fires", async () => {
    const run = async (mode: string) => {
      const page = await open(`shadow.html?mode=${mode}`);
      await page.evaluate(TASTE_DRAIN);
      await page.getByRole("button", { name: "Save draft" }).click();
      await page.getByText("Draft saved").waitFor({ timeout: 30_000 });
      return { page, s: await record(page) };
    };
    const [signal, silent] = await Promise.all([run("signal"), run("silent")]);
    expect(filed(judged(signal.s))).toEqual([]);
    expect(signal.s.events.filter((e: Obj) => e.kind === "busy").map((e: Obj) => [e.signal, e.on])).toEqual([["progressbar", true], ["progressbar", false]]);
    const b = one(judged(silent.s), "feedback.busy").measured;
    expect(b).toBeGreaterThanOrEqual(1450);
    expect(b).toBeLessThanOrEqual(1550);
  }, 60_000);

  it("the clock is installed once a document, and not at all without the taste buffer", async () => {
    const page = await open("feedback.html");
    await page.evaluate(`${TASTE_BUFFER};\n${EASE_INIT}`);
    await page.click("#quick");
    await page.getByText("quick 50").waitFor({ timeout: 30_000 });
    const s = await record(page);
    expect(s.events.filter((e: Obj) => e.kind === "input" && e.type === "click")).toHaveLength(1);
    const bare = await open("feedback.html", { arm: false });
    await bare.evaluate(EASE_INIT);
    expect(await bare.evaluate("Boolean(document.__argusEase)")).toBe(false);
  }, 60_000);
});

describe("argus-live-ease.mjs — lane 0's stubs not built yet (T2.2 builds them)", () => {
  it("CHECKS registers no suite check yet", () => {
    expect(CHECKS).toEqual([]);
  });

  it("pathCost(steps, geometry) is not built yet", () => {
    expect(() => pathCost([], [])).toThrow("refused: pathCost: not built yet");
  });
});

describe("argus-live ease — easeOf", () => {
  it("answers the screen kind of the page it is given", async () => {
    const s = await easeOf(await open("feedback.html"));
    expect(s.route).toBe("/feedback.html");
    expect(s.requests).toEqual([]);
  }, 60_000);
});
