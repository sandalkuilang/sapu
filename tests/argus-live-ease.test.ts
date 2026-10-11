// tests/argus-live-ease.test.ts — lane T2's file: the ease probes of argus-live-ease.mjs (spec §20.2, plan lane T2).
// Every rule is shown firing on its fixture and silent on the twin that shares everything but the defect: a false
// positive costs the lane its credibility. Real Chrome (the pinned install's playwright-core) against a local server;
// the pure parts (the judge, the path's cost, the cross-screen rules) on synthetic data.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { browserTools, cleanTemps, tempDir } from "./helpers/argus-live";
// @ts-expect-error — plain ESM script without types
import { crossRules, EASE_INIT, EASE_RENDER, EASE_SOURCE, easeOf, FAULT_SOURCE, NO_MAJORITY, pathCost, RECOVERY_SOURCE, ruleExpression, rulesFor } from "../plugins/sapu/scripts/argus-live-ease.mjs";
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
    expect(EASE_INIT).toContain('Object.prototype.hasOwnProperty.call(doc, "__argusEase") || typeof doc.__argusTastePush !== "function"');
    expect(() => new Function(EASE_INIT)).not.toThrow();
    expect(typeof ease).toBe("function");
    // The in-page sources never hold a template interpolation or a word the support file's scans refuse.
    for (const src of [EASE_INIT, EASE_SOURCE, FAULT_SOURCE, RECOVERY_SOURCE]) {
      expect(src).not.toContain("${");
      expect(src).not.toMatch(/shell|\bexec\(|spawn\(/);
    }
  });

  it("ruleExpression answers only the screen rules a page can measure alone", () => {
    for (const r of ["feedback.busy", "feedback.loader-flash", "copy.broken", "copy.vague", "states.error", "states.empty-next", "states.success"]) {
      expect(ruleExpression(r)).toContain('"kind":"rule"');
    }
    expect(() => ruleExpression("consistent.action")).toThrow("refused: ruleExpression: consistent.action is not a screen rule of the ease probe");
    expect(() => ruleExpression("scale.spacing")).toThrow("is not a screen rule of the ease probe");
    expect(() => ruleExpression("states.recovery")).toThrow("refused: ruleExpression: states.recovery has no page expression: a form case drives it");
    expect(() => ruleExpression("feedback.skeleton-peers")).toThrow("it compares a screen with its peers");
    // Decision 14's AI rules are the aiux probe's (tests/argus-live-aiux.test.ts).
    expect(() => ruleExpression("ai.stop")).toThrow("refused: ruleExpression: ai.stop is not a screen rule of the ease probe");
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

  it("a focus move at once is visible feedback: the 1.5 s wait holds; its twin with nothing shown fires", async () => {
    const [moved, silent] = await Promise.all([act("focus-now", "focus-now done"), act("silent", "silent done")]);
    expect(moved.events.filter((e: Obj) => e.kind === "change")[0]).toMatchObject({ cause: "focus", attr: null });
    expect(filed(judged(moved))).toEqual([]);
    expect(one(judged(silent), "feedback.busy").measured).toBeGreaterThanOrEqual(1450);
    // The click's own focus (the button it lands on) is no feedback.
    expect(silent.events.some((e: Obj) => e.kind === "change" && e.cause === "focus")).toBe(false);
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

  it("a change inside a shadow root counts: a component that signals holds; one silent for 1.5 s fires; never blank", async () => {
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
    // What a custom element renders is out of the walker's sight: its main is never called blank.
    expect(await silent.page.evaluate(`(${EASE_SOURCE})({"kind":"error"})`)).toMatchObject({ blank: false, loader: false });
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

// ---------------------------------------------------------------------------------------------------
// T2.2 — states, copy, path cost.

const faultArm = fnOf(FAULT_SOURCE);
/** A states page loaded with its data request faulted (armed before the navigation), settled, then measured. */
async function faulted(mode: string, arm = true) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  contexts.push(context);
  const page = await context.newPage();
  const fault = arm ? await faultArm(page, origin) : null;
  await page.goto(`${origin}/states.html?mode=${mode}`);
  await page.waitForLoadState("networkidle");
  await sleep(400);
  const error = { faulted: Boolean(fault && fault.faulted()), ...(await page.evaluate(`(${EASE_SOURCE})({"kind":"error"})`)) };
  if (fault) await fault.off();
  return { page, fault, found: judged({ route: "/states.html", events: [], ease: { now: 1, requests: [], error } }) };
}

describe("argus-live ease — states: the routed fault, success, recovery, empty", () => {
  it("states.error: a blank main and an endless loader fire; a message with a retry holds; no fault, no rule", async () => {
    const before = hits.length;
    const blank = await faulted("blank");
    expect(blank.fault.faulted()).toBe("/api/items");
    expect(one(blank.found, "states.error")).toEqual({ rule: "states.error", key: "error-state", measured: "blank main", expected: "an error state with a way to retry or leave" });
    expect(one((await faulted("spin")).found, "states.error").measured).toBe("endless loader");
    expect(ids((await faulted("retry")).found)).toEqual([]);
    expect(ids((await faulted("blank", false)).found)).toEqual([]);
    // The request whose Accept does not name JSON was fetched once to read its content-type, then answered 500.
    expect(hits.slice(before).filter((h) => h === "GET /api/items")).toHaveLength(4);
  }, 60_000);

  it("the fault answers only the first same-origin JSON GET, armed before the navigation, and goes with off()", async () => {
    const { page } = await faulted("retry");
    await page.click("#retry");
    await page.getByText("Order one").waitFor({ timeout: 30_000 });
    // Armed after the navigation, the screen's request is already gone: nothing is faulted.
    const late = await open("states.html?mode=blank", { arm: false });
    await late.getByText("Order one").waitFor({ timeout: 30_000 });
    const f = await faultArm(late, origin);
    await sleep(300);
    expect(f.faulted()).toBeNull();
    await f.off();
  }, 60_000);

  it("ruleExpression(states.error) measures the page the replay faulted; the twin holds", async () => {
    const context = await browser.newContext();
    contexts.push(context);
    const page = await context.newPage();
    const f = await faultArm(page, origin);
    await page.goto(`${origin}/states.html?mode=blank`);
    await page.waitForLoadState("networkidle");
    expect(await page.evaluate(ruleExpression("states.error"))).toEqual([expect.objectContaining({ rule: "states.error", measured: "blank main" })]);
    await f.off();
    const ok = await open("states.html?mode=retry", { arm: false });
    await ok.getByText("Order one").waitFor({ timeout: 30_000 });
    expect(await ok.evaluate(ruleExpression("states.error"))).toEqual([]);
  }, 60_000);

  it("states.success: a 2xx write with nothing named within 1 s fires; one named in a status region holds", async () => {
    const quiet = await open("success.html");
    await quiet.click("#quiet");
    await sleep(1400);
    expect(one(judged(await record(quiet)), "states.success").measured).toBeGreaterThan(1000);
    const named = await open("success.html");
    await named.click("#named");
    await named.getByText("Saved.").waitFor({ timeout: 30_000 });
    await sleep(1200);
    expect(filed(judged(await record(named)))).toEqual([]);
  }, 60_000);

  it("states.success: only a change after the write answered names the new state; a disable/enable or text shown while it ran does not", async () => {
    const run = async (id: string) => {
      const p = await open("success.html");
      await p.click(`#${id}`);
      await sleep(1600);
      return filed(judged(await record(p)));
    };
    expect(await run("disable-only")).toEqual(["states.success"]);
    expect(await run("early-text")).toEqual(["states.success"]);
    expect(await run("disable-toast")).toEqual([]);
  }, 90_000);

  it("feedback.optimistic in Chrome: the late count fires on a declared route only; the early count holds", async () => {
    const cfg = { ...CFG, optimistic: ["/success.html"] };
    const late = await open("success.html");
    await late.click("#like-late");
    await late.getByText("Likes: 1").waitFor({ timeout: 30_000 });
    const l = await record(late);
    expect(filed(judged(l, cfg))).toEqual(["feedback.optimistic"]);
    expect(filed(judged(l))).toEqual([]);
    const early = await open("success.html");
    await early.click("#like-early");
    await early.getByText("Likes: 1").waitFor({ timeout: 30_000 });
    await sleep(500);
    expect(filed(judged(await record(early), cfg))).toEqual([]);
  }, 60_000);

  it("states.recovery: a refusal that clears the other fields counts each lost value, and the values go back", async () => {
    const recover = fnOf(RECOVERY_SOURCE);
    const posted = hits.length;
    const run = async (mode: string) => {
      const page = await open(`recovery.html?mode=${mode}`);
      await page.getByLabel("Name").fill("Ana");
      await page.getByLabel("Email").fill("ana@example.test");
      await page.getByLabel("Notes").fill("call after five");
      await page.getByLabel("VIP").check();
      const lost = await recover(page, page.getByRole("button", { name: "Save contact" }), ease);
      const values = await page.evaluate(() => { const f = (document.getElementById("f") as HTMLFormElement).elements as any; return [f.name.value, f.email.value, f.notes.value, f.vip.checked]; });
      return { page, lost, values };
    };
    const clear = await run("clear");
    expect(clear.lost.map((x: Obj) => x.key)).toEqual(["Email", "Notes", "VIP"]);
    expect(clear.values).toEqual(["Ana", "ana@example.test", "call after five", true]);
    const found = judged({ route: "/recovery.html", events: [], ease: { now: 1, requests: [], recovery: clear.lost } });
    expect(found.map((f: Obj) => [f.rule, f.key])).toEqual([["states.recovery", "Email"], ["states.recovery", "Notes"], ["states.recovery", "VIP"]]);
    const keep = await run("keep");
    expect(keep.lost).toEqual([]);
    expect(keep.values).toEqual(["Ana", "ana@example.test", "call after five", true]);
    // A form the browser validates itself never submits: the case is not run.
    expect((await run("native")).lost).toBeNull();
    expect(hits.slice(posted).filter((h) => h === "POST /api/save")).toEqual([]);
  }, 60_000);

  it("states.empty-next: an empty state with a message and no way on fires; with a control, or no message at all, it holds", async () => {
    const s = await record(await open("empty.html"));
    expect(judged(s).filter((f: Obj) => f.rule === "states.empty-next").map((f: Obj) => f.key)).toEqual(["table|Orders", "table|Tags"]);
  }, 60_000);

  it("states.error-exit is information: an alert with no control in its region, never one beside its retry", async () => {
    const page = await open("states.html?mode=retry");
    await page.getByText("Order one").waitFor({ timeout: 30_000 });
    await page.evaluate(() => { document.getElementById("main")!.insertAdjacentHTML("beforeend", '<section><p role="alert">Sync failed.</p></section>'); });
    const found = judged(await record(page)).filter((f: Obj) => f.rule.startsWith("states."));
    expect(found).toEqual([{ rule: "states.error-exit", key: "alert|Sync failed.", measured: "no control in its region", expected: "a way on beside the error" }]);
    expect(BAR.rules.find((r: Obj) => r.id === "states.error-exit").info).toBe(true);
  }, 60_000);
});

describe("argus-live ease — copy", () => {
  it("copy.broken: every unrendered token fires once per line, a value word only where a value stands; code, prose, docs and hidden twins hold", async () => {
    const broken = judged(await record(await open("copy-broken.html")));
    expect(broken.map((f: Obj) => f.key)).toEqual([
      "undefined|Status undefined, quantity undefined",
      "NaN|Total: NaN items",
      "[object Object]|Customer [object Object]",
      "Invalid Date|Placed Invalid Date",
      "{{|Hello {{ user.name }}",
      "%s|Shipped to %s",
      "null|Coupon: null",
      "undefined|undefined",
      "NaN|Quantity",
    ]);
    expect(broken.every((f: Obj) => f.rule === "copy.broken" && f.expected === "no unrendered value")).toBe(true);
    expect(judged(await record(await open("copy-clean.html")))).toEqual([]);
    // A value word counts only where a value stands: a reference page's prose, its table's Default column, a word
    // part (NaN-safe) and template syntax explained in a paragraph hold.
    expect(judged(await record(await open("copy-prose.html")))).toEqual([]);
  }, 60_000);

  it("copy.vague: a form's submit and a dialog's confirm named only from the list fire under a matching lang only", async () => {
    const en = judged(await record(await open("vague.html?lang=en-GB")));
    expect(en.map((f: Obj) => [f.rule, f.key, f.measured])).toEqual([["copy.vague", "dialog|OK", "OK"], ["copy.vague", "form|Submit", "Submit"]]);
    expect(judged(await record(await open("vague.html?lang=de")))).toEqual([]);
    expect(judged(await record(await open("vague.html?lang=en&submit=Save%20settings&confirm=Leave")))).toEqual([]);
    // The owner's own labels count in any language.
    const own = await record(await open("vague.html?lang=de&submit=Absenden&confirm=Leave"), { vague: ["Absenden"] });
    expect(judged(own).map((f: Obj) => f.key)).toEqual(["form|Absenden"]);
  }, 60_000);
});

describe("argus-live ease — pathCost (decision 3: KLM, Fitts)", () => {
  // Boxes: A (100,100) 100x40, B (400,500) 300x40, C (900,100) 80x30, D in a dialog.
  const A = { x: 50, y: 80, width: 100, height: 40 };
  const B = { x: 250, y: 480, width: 300, height: 40 };
  const C = { x: 860, y: 85, width: 80, height: 30 };
  const D = { x: 500, y: 300, width: 120, height: 40, dialog: "Archive note" };
  const bits = (from: Obj, to: Obj) => Math.log2(Math.hypot(to.x + to.width / 2 - (from.x + from.width / 2), to.y + to.height / 2 - (from.y + from.height / 2)) / Math.min(to.width, to.height) + 1);
  const P = (b: number) => Math.min(1.5, Math.max(0.8, b / 4.9));

  it("equals a hand KLM sum: K .28, BB .2, H .4, M 1.2, P from Fitts bounded 0.8-1.5", () => {
    const steps = [
      { do: "goto", path: "/notes" },
      { do: "click", target: { role: "button", name: "New" } },
      { do: "fill", target: { label: "Title" }, value: "Groceries" },
      { do: "press", key: "Control+Enter" },
      { do: "click", target: { role: "button", name: "Archive" } },
      { do: "click", target: { role: "button", name: "Confirm" } },
      { expect: "visible", target: { text: "Archived" } },
      { as: "system", do: "trigger", name: "x", values: [] },
    ];
    const geometry = { goals: 2, targets: [null, A, B, null, C, D, null, null] };
    const c = pathCost(steps, geometry);
    const ab = bits(A, B), bc = bits(B, C), cd = bits(C, D);
    // click A: P (first target: Kieras' mean 1.1) + BB; fill B: P(ab) + BB + H + 9 K; press: 2 K (hand on keys);
    // click C: H + P(bc) + BB; click D: P(cd) + BB; two goal steps: 2 M.
    const hand = 1.1 + 0.2 + (P(ab) + 0.2 + 0.4 + 9 * 0.28) + 2 * 0.28 + (0.4 + P(bc) + 0.2) + (P(cd) + 0.2) + 2 * 1.2;
    expect(c).toEqual({ actions: 5, typed: 9, modals: 1, fitts_bits: Math.round((ab + bc + cd) * 100) / 100, klm_s: Math.round(hand * 100) / 100 });
  });

  it("a dialog where a field is filled is no modal cost; missing geometry costs Kieras' mean and breaks the Fitts chain", () => {
    const steps = [{ do: "click", target: { label: "x" } }, { do: "fill", target: { label: "y" }, value: "ab" }, { do: "select", target: { label: "z" }, value: "1" }, { do: "hover", target: { label: "w" } }, { do: "dblclick", target: { label: "v" } }];
    const c = pathCost(steps, [D, D, null, A, B]);
    const sum = 1.1 + 0.2 + (P(bits(D, D)) + 0.2 + 0.4 + 2 * 0.28) + (0.4 + 1.1 + 0.2 + 0.8 + 0.2) + 1.1 + (P(bits(A, B)) + 0.4);
    expect(c).toEqual({ actions: 5, typed: 2, modals: 0, fitts_bits: Math.round((bits(D, D) + bits(A, B)) * 100) / 100, klm_s: Math.round(sum * 100) / 100 });
    // Without `goals`, one M per expectation of the path.
    expect(pathCost([{ do: "click", target: { label: "x" } }, { expect: "visible", target: { text: "y" } }], []).klm_s).toBe(Math.round((1.1 + 0.2 + 1.2) * 100) / 100);
    expect(() => pathCost("x", [])).toThrow("failed: pathCost: steps must be an array");
  });
});

// ---------------------------------------------------------------------------------------------------
// T2.3 — consistency across a cycle's screens.

/** Walks one consistency page: saves a note, types a theme and a handle, measures footers, then closes the dialog and probes the palette. */
async function walk(file: string) {
  const page = await open(file);
  await page.getByLabel("Title").fill("Groceries");
  await page.getByLabel("Body").fill("milk");
  await page.getByRole(file === "consist-b.html" ? "link" : "button", { name: file === "consist-b.html" ? "Submit" : "Save" }).click();
  await page.getByText("Note saved.").waitFor({ timeout: 30_000 });
  await page.getByLabel("Theme").pressSequentially("dark", { delay: 30 });
  await page.getByLabel("Handle").pressSequentially("ana", { delay: 30 });
  await sleep(500);
  const first = await record(page);
  await page.click("#cancel");
  const probe = await page.evaluate(`(${EASE_SOURCE})({"kind":"palette"})`);
  return { key: `/${file}|1280|light`, route: `/${file}`, journey: "notes", events: first.events, ease: { ...first.ease, palette: probe } };
}

describe("argus-live ease — consistency across screens (decision 13)", () => {
  it("each way of the two pages is measured as the cross rules need it", async () => {
    const [a, b] = await Promise.all([walk("consist-a.html"), walk("consist-b.html")]);
    expect(a.ease.footers).toEqual([{ kind: "dialog", position: "last", name: "Archive" }]);
    expect(b.ease.footers).toEqual([{ kind: "dialog", position: "first", name: "Archive" }]);
    expect(a.ease.palette).toEqual({ opens: true, closed: true });
    expect(b.ease.palette).toEqual({ opens: false });
    expect(a.ease.forms.map((f: Obj) => [f.key, f.submit, f.fields])).toEqual([["Note", true, ["title", "body"]], ["Preferences", true, ["theme", "handle"]]]);
    const save = (s: Obj) => s.ease.actions.filter((x: Obj) => x.name === "Save" || x.name === "Submit").map((x: Obj) => [x.role, x.name, x.region]);
    expect(save(a)).toEqual([["button", "Save", "form"]]);
    expect(save(b)).toEqual([["link", "Submit", "form"]]);
    expect(b.ease.requests.filter((r: Obj) => r.method === "PATCH").map((r: Obj) => [r.route, r.keys])[0]).toEqual(["/api/prefs", ["theme"]]);
  }, 60_000);

  /** A walked screen seen again on another route of the journey (the cross rules count routes). */
  const at = (s: Obj, route: string) => ({ ...s, key: `${route}|1280|light`, route });

  it("a two-way split with no majority marks every side needs-owner; the palette's gap is the side flagged", async () => {
    const [a, b] = await Promise.all([walk("consist-a.html"), walk("consist-b.html")]);
    // consistent.action needs each way on two routes: one screen's own control is no pattern.
    expect(crossRules([a, b], BAR, CFG).map((f: Obj) => f.rule)).not.toContain("consistent.action");
    const found = crossRules([a, at(a, "/consist-a2.html"), b, at(b, "/consist-b2.html")], BAR, CFG);
    const rows = found.filter((f: Obj) => f.rule === "consistent.action").map((f: Obj) => [f.screen.split("|")[0], f.key, f.measured, f.expected]);
    expect(rows).toEqual([
      ["/consist-a.html", 'POST /api/notes {body,title}|button|Save', 'button "Save"', NO_MAJORITY],
      ["/consist-a2.html", 'POST /api/notes {body,title}|button|Save', 'button "Save"', NO_MAJORITY],
      ["/consist-b.html", 'POST /api/notes {body,title}|link|Submit', 'link "Submit"', NO_MAJORITY],
      ["/consist-b2.html", 'POST /api/notes {body,title}|link|Submit', 'link "Submit"', NO_MAJORITY],
    ]);
    expect(crossRules([a, b], BAR, CFG).map((f: Obj) => [f.screen.split("|")[0], f.rule, f.key, f.measured, f.expected])).toEqual([
      ["/consist-a.html", "consistent.footer-order", "dialog|Archive", "primary last", NO_MAJORITY],
      ["/consist-b.html", "consistent.footer-order", "dialog|Archive", "primary first", NO_MAJORITY],
      ["/consist-b.html", "consistent.save-pattern", "Preferences", "autosave and a submit button", "one save pattern per form"],
      ["/consist-b.html", "consistent.palette", "Mod+K", "does not open", NO_MAJORITY],
    ]);
  }, 60_000);

  it("with a majority, only the deviant screen is flagged, against the majority's way; one page alone is consistent", async () => {
    const [a, b, c] = await Promise.all([walk("consist-a.html"), walk("consist-b.html"), walk("consist-c.html")]);
    expect(crossRules([a, b, c, at(a, "/consist-a2.html"), at(b, "/consist-b2.html")], BAR, CFG).filter((f: Obj) => f.rule === "consistent.action").map((f: Obj) => [f.screen.split("|")[0], f.measured, f.expected])).toEqual([
      ["/consist-b.html", 'link "Submit"', 'button "Save"'],
      ["/consist-b2.html", 'link "Submit"', 'button "Save"'],
    ]);
    const found = crossRules([a, b, c], BAR, CFG).map((f: Obj) => [f.screen.split("|")[0], f.rule, f.measured, f.expected]);
    expect(found).toEqual([
      ["/consist-b.html", "consistent.footer-order", "primary first", "primary last"],
      ["/consist-b.html", "consistent.save-pattern", "autosave and a submit button", "one save pattern per form"],
      ["/consist-b.html", "consistent.palette", "does not open", "opens, as on 2 other screens of the journey"],
    ]);
    expect(crossRules([a, c], BAR, CFG)).toEqual([]);
    expect(crossRules([a, b], BAR, { ...CFG, off: ["consistent.action", "consistent.footer-order", "consistent.save-pattern", "consistent.palette"] })).toEqual([]);
  }, 60_000);

  it("feedback.skeleton-peers: a 1-10 s load behind a spinner where a peer screen uses a skeleton fires; alone it holds", () => {
    const load = (signal: string, off: number) => [busy(100, true, signal), busy(off, false, signal)];
    const spin = { key: "/a|1280|light", route: "/a", journey: "j", events: load("spinner", 2500), ease: { now: 9000, requests: [] } };
    const skel = { key: "/b|1280|light", route: "/b", journey: "j", events: load("skeleton", 2000), ease: { now: 9000, requests: [] } };
    expect(crossRules([spin, skel], BAR, CFG)).toEqual([{ screen: "/a|1280|light", rule: "feedback.skeleton-peers", key: "load|spinner", measured: 2500, expected: "a skeleton, as /b uses" }]);
    expect(crossRules([spin], BAR, CFG)).toEqual([]);
    expect(crossRules([{ ...spin, events: load("spinner", 900) }, skel], BAR, CFG)).toEqual([]);
  });
});

describe("argus-live ease — easeOf", () => {
  it("answers the screen kind of the page it is given", async () => {
    const s = await easeOf(await open("copy-broken.html"));
    expect(s.route).toBe("/copy-broken.html");
    expect(s.copy).toHaveLength(9);
  }, 60_000);
});

describe("argus-live ease — consistent.action counts a control's role and name, never its region or an empty state's", () => {
  const screen = (route: string, action: Obj) => ({ key: `${route}|1280|light`, route, journey: "j", events: [], ease: { now: 9000, requests: [{ t: 1010, end: 1100, status: 201, method: "POST", route: "/api/projects", keys: ["name"], same: true }], actions: [{ t: 1000, ...action }] } });
  it("the same named control in a header, a form or a dialog is one way; a different one on two routes splits", () => {
    const header = { role: "button", name: "New project", region: "header" };
    const dialog = { role: "button", name: "New project", region: "dialog" };
    expect(crossRules([screen("/a", header), screen("/b", dialog), screen("/c", header), screen("/d", dialog)], BAR, CFG)).toEqual([]);
    const other = { role: "link", name: "Add project", region: "main" };
    expect(crossRules([screen("/a", header), screen("/b", header), screen("/c", other), screen("/d", other)], BAR, CFG).map((f: Obj) => f.rule)).toEqual(["consistent.action", "consistent.action", "consistent.action", "consistent.action"]);
  });

  it("an empty state's own call to action is left out (QA's projects page: the header's New project beside the empty list's Create project)", () => {
    const header = { role: "button", name: "New project", region: "header" };
    const empty = { role: "button", name: "Create project", region: "main", empty: true };
    expect(crossRules([screen("/a", header), screen("/b", header), screen("/c", empty), screen("/d", empty)], BAR, CFG)).toEqual([]);
  });

  it("in Chrome: a clicked control inside an empty state's region is marked so; the header's is not", async () => {
    const page = await open("projects.html");
    await page.click("#new");
    await page.click("#create");
    await sleep(300);
    const r = await record(page);
    expect(r.ease.actions.map((a: Obj) => [a.name, a.empty === true])).toEqual([["New project", false], ["Create project", true]]);
  }, 60_000);
});
