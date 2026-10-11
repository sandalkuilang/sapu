// tests/argus-live-aiux.test.ts — the AI-surface rules (decision 14: ai.stop, ai.error, ai.regenerate) of
// argus-live-aiux.mjs.
// Every rule is shown firing on its fixture and silent on the twin that differs only by the defect, and every
// exclusion (no AI surface, an undeclared route, a stream too short to stop, an answer not settled, a stopped answer,
// a failure that is not the composer's or comes before any stream, an undecided drive) beside the twin that fires. Real
// Chrome (the pinned install's playwright-core) against a local server whose assistant streams its answer chunk by
// chunk (tests/fixtures/journey-app/pages/aiux/); the judge on synthetic records.
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { browserTools, cleanTemps } from "./helpers/argus-live";
// @ts-expect-error — plain ESM script without types
import { AI_EXPECTED, AI_MARKER, AIUX_DRIVE, AIUX_FAULT, AIUX_INIT, AIUX_SOURCE, driveArg, faultArm, ruleExpression, rulesFor } from "../plugins/sapu/scripts/argus-live-aiux.mjs";
// @ts-expect-error — plain ESM script without types
import { PAGE_INIT } from "../plugins/sapu/scripts/argus-live-browser.mjs";
// @ts-expect-error — plain ESM script without types
import { TASTE_LANE_ONLY } from "../plugins/sapu/scripts/argus-live-codeproj.mjs";
// @ts-expect-error — plain ESM script without types
import { EASE_INIT, ruleExpression as easeExpression } from "../plugins/sapu/scripts/argus-live-ease.mjs";
// @ts-expect-error — plain ESM script without types
import { FAMILIES, laneOnly, loadBar, validateTaste } from "../plugins/sapu/scripts/argus-live-tastecfg.mjs";

type Obj = Record<string, any>;
const BAR = loadBar();
const AI_RULES = BAR.rules.filter((r: Obj) => r.family === "ai").map((r: Obj) => r.id);
const PAGES = join(__dirname, "fixtures/journey-app/pages/aiux");
const CFG = validateTaste({ ai: ["/chat.html", "/search.html"] }).value;
const UNDECLARED = validateTaste({}).value;
const fnOf = (src: string) => new Function(`return (${src});`)();
/** Chrome tests: generous bounds, a streamed answer takes about two seconds and an error settles in two more. */
const SLOW = 90_000;

afterEach(cleanTemps);

// ---------------------------------------------------------------------------------------------------
// One browser and one local server for the file.

let browser: any;
let server: Server;
let origin = "";
const listen = (s: Server) => new Promise<number>((resolve) => s.listen(0, "127.0.0.1", () => resolve((s.address() as { port: number }).port)));
/** The page's marks and their defaults: a good assistant (a separate Stop, Copy and Regenerate, an alert with Retry). */
const FILL: Record<string, [string, string]> = { __STOP__: ["stop", "button"], __REGEN__: ["regen", "yes"], __ERROR__: ["error", "retry"], __STREAM__: ["stream", "yes"], __LIVE__: ["live", "log"], __DOTS__: ["dots", "no"], __CITE__: ["cite", "no"], __N__: ["n", "30"] };
const WORDS = "Here is a short answer about the order you asked for with the details that matter most".split(" ");

beforeAll(async () => {
  const { cli, chrome } = browserTools();
  const { chromium } = createRequire(join(cli.dir, "package.json"))("playwright-core");
  browser = await chromium.launch({ executablePath: chrome.path, headless: true });
  server = createServer((req, res) => {
    const url = new URL(String(req.url), origin);
    if (/^\/[a-z]+\.html$/.test(url.pathname)) {
      let text = readFileSync(join(PAGES, url.pathname.slice(1)), "utf8");
      for (const [mark, [q, d]] of Object.entries(FILL)) text = text.split(mark).join((url.searchParams.get(q) || d).replace(/[^a-z0-9]/g, ""));
      res.setHeader("content-type", "text/html");
      res.end(text);
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const json = (status: number, value: unknown) => {
        res.statusCode = status;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(value));
      };
      if (url.pathname === "/api/chat") {
        if (body.includes("please fail")) return json(500, { error: "failed" });
        const n = Number(url.searchParams.get("n") || 30);
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
        let i = 0;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const next = () => {
          if (res.destroyed || i >= n) return void res.end();
          res.write(`${WORDS[i % WORDS.length]} `);
          i += 1;
          timer = setTimeout(next, 60);
        };
        res.on("close", () => timer && clearTimeout(timer));
        timer = setTimeout(next, Number(url.searchParams.get("wait") || 0));
        return;
      }
      if (url.pathname === "/api/search") return json(200, ["Order one", "Order two"]);
      if (url.pathname === "/api/rename") return json(500, { error: "failed" });
      res.statusCode = url.pathname === "/favicon.ico" ? 204 : 404;
      res.end();
    });
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

/** An assistant page (`query` its variant) in a fresh context whose documents run the lane's init payload; `fault` arms AIUX_FAULT first. */
async function open(query = "", { file = "chat.html", fault = null as string | null } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  contexts.push(context);
  await context.addInitScript({ content: PAGE_INIT });
  const page = await context.newPage();
  const armed = fault === null ? null : await fnOf(AIUX_FAULT)(page, fault);
  await page.goto(`${origin}/${file}?${query}`);
  return Object.assign(page, { armed });
}
const screenOf = (page: any): Promise<Obj> => page.evaluate(`(${AIUX_SOURCE})(${JSON.stringify({ kind: "screen" })})`);
/** The explorer's own walk: types and sends through real input, as the CLI does. */
const ask = async (page: any, text = "Hello there") => {
  await page.fill("#box", text);
  await page.click("#send");
};
/** Polls the page's record until `ok` holds (or `ms` passed) → the record. */
const until = async (page: any, ok: (s: Obj) => boolean, ms = 20_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const s = await screenOf(page);
    if (ok(s) || Date.now() > end) return s;
    await page.waitForTimeout(100);
  }
};
const lastOf = (s: Obj) => s.streams[s.streams.length - 1];
/** The walk's record once its latest answer ended (quiet past the probe's bound). */
const answered = (page: any) => until(page, (s) => s.streams.length > 0 && lastOf(s).ended);
/** The record once a failure settled. */
const failedOnce = (page: any, n = 1) => until(page, (s) => s.failures.length >= n, 15_000);
const judged = (s: Obj, cfg: Obj = CFG) => rulesFor({ route: s.route, ai: s }, BAR, cfg);
const ids = (rows: Obj[]) => rows.map((r) => r.rule).sort();
/** The confirmation's drive on `page`; `startMs` shortens its wait for an answer where none comes (no AI surface). */
const drive = (page: any, rule: string, startMs?: number) => fnOf(AIUX_DRIVE)(page, { ...driveArg(rule), ...(startMs ? { startMs } : {}) });
const row = (rule: string, measured: string, key = { "ai.stop": "stream", "ai.regenerate": "answer", "ai.error": "failed-stream" }[rule]) => ({ rule, key, measured, expected: AI_EXPECTED[rule] });

// ---------------------------------------------------------------------------------------------------
// The shapes and the seams the lane registers the rules through.

describe("argus-live-aiux.mjs — its shapes and registrations", () => {
  it("is the ai family's probe, lane-only, in the lane's init payload, with in-page sources the suite's scans accept", () => {
    expect(FAMILIES.ai.probe).toBe("aiux");
    expect(AI_RULES.sort()).toEqual(Object.keys(AI_EXPECTED).sort());
    for (const id of AI_RULES) {
      expect(laneOnly(BAR.rules.find((r: Obj) => r.id === id))).toBe("it reads the owner's declared AI surfaces");
      expect(TASTE_LANE_ONLY).toContain(id);
    }
    expect(PAGE_INIT.indexOf(AIUX_INIT)).toBeGreaterThan(PAGE_INIT.indexOf(EASE_INIT));
    for (const src of [AIUX_INIT, AIUX_SOURCE, AIUX_DRIVE, AIUX_FAULT, faultArm()]) {
      expect(src).not.toContain("${");
      expect(src).not.toContain("`");
      expect(src).not.toMatch(/shell|\bexec\(|spawn\(/);
    }
    expect(() => new Function(AIUX_INIT)).not.toThrow();
    for (const src of [AIUX_SOURCE, AIUX_DRIVE, AIUX_FAULT]) expect(typeof fnOf(src)).toBe("function");
    expect(faultArm()).toContain(JSON.stringify(AI_MARKER));
  });

  it("answers a page expression for each AI rule only; the ease probe no longer claims them", () => {
    for (const id of AI_RULES) expect(ruleExpression(id)).toContain('"kind":"rule"');
    expect(() => ruleExpression("states.error")).toThrow("refused: ruleExpression: states.error is not a screen rule of the aiux probe");
    expect(() => easeExpression("ai.stop")).toThrow("refused: ruleExpression: ai.stop is not a screen rule of the ease probe");
    expect(() => driveArg("copy.broken")).toThrow("refused: driveArg: copy.broken is not an AI rule of the bar");
    expect(driveArg("ai.stop")).toMatchObject({ rule: "ai.stop", marker: AI_MARKER, stopMs: 1000 });
  });
});

// ---------------------------------------------------------------------------------------------------
// The judge on synthetic records: each rule, each side.

const stream = (over: Obj = {}) => ({ t0: 1000, last: 3000, ticks: 30, chars: 300, stops: 1, outside: 1, tried: 0, wentOn: 0, again: false, ended: true, regen: 2, size: 300, ...over });
const record = (over: Obj = {}) => ({ v: 1, now: 9000, route: "/chat.html", surface: true, seen: 1, streams: [stream()], failures: [], ...over });

describe("argus-live aiux — the judge (pure)", () => {
  it("a good surface holds; each defect is one row with its own measurement", () => {
    expect(judged(record())).toEqual([]);
    expect(judged(record({ streams: [stream({ stops: 0 })] }))).toEqual([row("ai.stop", "no stop control while it streamed")]);
    expect(judged(record({ streams: [stream({ tried: 1, wentOn: 1800 })] }))).toEqual([row("ai.stop", "it streamed 1800 ms past a stop")]);
    expect(judged(record({ streams: [stream({ tried: 1, wentOn: 60 })] }))).toEqual([]);
    expect(judged(record({ streams: [stream({ regen: 0 })] }))).toEqual([row("ai.regenerate", "no control once the answer was complete")]);
    for (const [f, why] of [[{ busy: true, shown: true, wayOn: true }, "an endless loader"], [{ busy: false, shown: false, wayOn: true }, "nothing shown"], [{ busy: false, shown: true, wayOn: false }, "no way on"]] as const) {
      expect(judged(record({ failures: [{ t: 5000, status: 500, ...f }] }))).toEqual([row("ai.error", why)]);
    }
    expect(judged(record({ failures: [{ t: 5000, status: 500, busy: false, shown: true, wayOn: true }] }))).toEqual([]);
  });

  it("exclusions: an undeclared route, an `off` rule, no stream, a stream under the stop's bound, an answer not settled, stopped or regenerated, a failure off the surface", () => {
    const bad = record({ streams: [stream({ stops: 0, regen: 0 })], failures: [{ t: 5000, status: 500, busy: true, shown: false, wayOn: false }] });
    expect(ids(judged(bad))).toEqual(["ai.error", "ai.regenerate", "ai.stop"]);
    expect(judged(bad, UNDECLARED)).toEqual([]);
    expect(judged(bad, validateTaste({ ai: ["/other/*"] }).value)).toEqual([]);
    expect(ids(judged(bad, validateTaste({ ai: ["/chat.html"], off: ["ai.stop"] }).value))).toEqual(["ai.error", "ai.regenerate"]);
    expect(judged(record({ streams: [] }))).toEqual([]);
    expect(judged(record({ streams: [stream({ stops: 0, last: 1900 })] }))).toEqual([]);
    expect(judged(record({ streams: [stream({ stops: 0, last: 2000 })] }))).toEqual([row("ai.stop", "no stop control while it streamed")]);
    expect(judged(record({ streams: [stream({ regen: null, ended: false })] }))).toEqual([]);
    expect(judged(record({ streams: [stream({ regen: 0, tried: 1, wentOn: 0 })] }))).toEqual([]);
    expect(judged(record({ streams: [stream({ again: true }), stream({ regen: 0 })] }))).toEqual([]);
    expect(judged(record({ surface: false, failures: bad.failures }))).toEqual([]);
    // A record of another shape is no finding (the page is the app's: its record is never trusted to be well formed).
    expect(judged(record({ streams: "x", failures: [null, 3] }))).toEqual([]);
    expect(rulesFor({ route: "/chat.html" }, BAR, CFG)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------
// The explorer's walk, as the recorder reads it: each rule on its fixture, each exclusion beside its twin.

describe("argus-live aiux — the walk's record (Chrome)", () => {
  it("a good assistant: one stream, a Stop seen while it streamed, two controls after it, no row", async () => {
    const page = await open();
    await ask(page);
    const s = await answered(page);
    expect(s).toMatchObject({ route: "/chat.html", surface: true, seen: 1, failures: [] });
    expect(lastOf(s)).toMatchObject({ ended: true, tried: 0, again: false, regen: 2 });
    expect(lastOf(s).stops).toBeGreaterThanOrEqual(1);
    expect(lastOf(s).last - lastOf(s).t0).toBeGreaterThan(1000);
    expect(judged(s)).toEqual([]);
    // Counts and times only: no word of the page or the answer is in the record.
    expect(JSON.stringify(s)).not.toMatch(/Hello|answer|Stop|Regenerate/);
  }, SLOW);

  it("ai.stop: no stop control while it streams fires; a separate Stop or the send turned Stop holds", async () => {
    for (const [q, rows] of [["stop=none", [row("ai.stop", "no stop control while it streamed")]], ["stop=button", []], ["stop=swap", []]] as const) {
      const page = await open(q);
      await ask(page);
      expect(judged(await answered(page)), q).toEqual(rows);
    }
  }, SLOW);

  it("ai.stop: a Stop the walk pressed that does not stop fires; one that stops holds", async () => {
    for (const q of ["stop=broken&n=60", "stop=button&n=60"]) {
      const page = await open(q);
      await ask(page);
      await until(page, (s) => s.streams.length > 0);
      await page.click("#stop");
      const s = await answered(page);
      expect(lastOf(s).tried, q).toBe(1);
      expect(ids(judged(s)), q).toEqual(q.startsWith("stop=broken") ? ["ai.stop"] : []);
      if (q.startsWith("stop=broken")) expect(judged(s)[0].measured).toMatch(/^it streamed \d+ ms past a stop$/);
    }
  }, SLOW);

  it("exclusion: a control inside the streamed answer (a Source chip) is no stop; twin: with a real Stop it holds", async () => {
    for (const [q, rows] of [["stop=none&cite=yes", ["ai.stop"]], ["stop=button&cite=yes", []]] as const) {
      const page = await open(q);
      await ask(page);
      const s = await answered(page);
      expect(await page.locator(".cite").count(), q).toBe(1);
      expect(ids(judged(s)), q).toEqual(rows);
    }
  }, SLOW);

  it("exclusion: a stream shorter than the stop's bound is silent; twin: the same page streaming longer fires", async () => {
    for (const [q, rows] of [["stop=none&n=5", []], ["stop=none&n=30", ["ai.stop"]]] as const) {
      const page = await open(q);
      await ask(page);
      const s = await answered(page);
      expect(s.seen, q).toBe(1);
      expect(ids(judged(s)), q).toEqual(rows);
    }
  }, SLOW);

  it("exclusion, no AI surface: an answer read whole, a box neither live nor busy, a thinking indicator alone; each twin streams and fires", async () => {
    const pairs = [["stream=once", "stream=yes"], ["live=bare", "live=busy"], ["dots=yes&stream=once", "dots=yes&stream=yes"]];
    for (const [silent, fires] of pairs) {
      const quiet = await open(`stop=none&regen=none&${silent}`);
      await ask(quiet);
      await quiet.waitForTimeout(3500);
      const s = await screenOf(quiet);
      expect(s.seen, silent).toBe(0);
      expect(judged(s), silent).toEqual([]);
      const loud = await open(`stop=none&regen=none&${fires}`);
      await ask(loud);
      expect(ids(judged(await answered(loud))), fires).toEqual(["ai.regenerate", "ai.stop"]);
    }
  }, SLOW);

  it("exclusion: an undeclared route is silent; twin: the same record on a declared route fires", async () => {
    const page = await open("stop=none&regen=none");
    await ask(page);
    const s = await answered(page);
    expect(judged(s, UNDECLARED)).toEqual([]);
    expect(ids(judged(s))).toEqual(["ai.regenerate", "ai.stop"]);
  }, SLOW);

  it("exclusion: a search box with a live status is no AI surface (nothing streams, nothing fails)", async () => {
    const page = await open("", { file: "search.html" });
    await page.fill("#q", "widget");
    await page.click("button[type=submit]");
    await page.waitForFunction(() => /found/.test(document.getElementById("status")!.textContent || ""));
    await page.waitForTimeout(2500);
    const s = await screenOf(page);
    expect(s).toMatchObject({ route: "/search.html", surface: true, seen: 0, streams: [], failures: [] });
    expect(judged(s)).toEqual([]);
  }, SLOW);

  it("ai.regenerate: no control after the answer fires; a Copy alone is a candidate the walk cannot rule on (silent); Regenerate holds", async () => {
    for (const [q, rows] of [["regen=none", ["ai.regenerate"]], ["regen=copy", []], ["regen=yes", []]] as const) {
      const page = await open(q);
      await ask(page);
      expect(ids(judged(await answered(page))), q).toEqual(rows);
    }
  }, SLOW);

  it("exclusion: an answer not yet settled, or stopped, is not judged for regenerate; twin: settled and complete fires", async () => {
    const page = await open("regen=none");
    await ask(page);
    await page.waitForFunction(() => document.getElementById("log")!.getAttribute("aria-busy") === "false" && document.querySelectorAll(".answer").length === 1);
    const early = await screenOf(page);
    expect(early.now - lastOf(early).last).toBeLessThan(1500);
    expect(lastOf(early).regen).toBe(null);
    expect(judged(early)).toEqual([]);
    expect(ids(judged(await answered(page)))).toEqual(["ai.regenerate"]);
    const stopped = await open("regen=none");
    await ask(stopped);
    await until(stopped, (s) => s.streams.length > 0);
    await stopped.click("#stop");
    const s = await answered(stopped);
    expect(lastOf(s).tried).toBe(1);
    expect(judged(s)).toEqual([]);
  }, SLOW);

  it("ai.error: a failed answer with no way on, an endless loader or nothing shown fires; an alert with Retry holds", async () => {
    for (const [q, rows] of [["error=stuck", [row("ai.error", "no way on")]], ["error=endless", [row("ai.error", "an endless loader")]], ["error=silent", [row("ai.error", "nothing shown")]], ["error=retry", []]] as const) {
      const page = await open(q);
      await ask(page);
      await answered(page);
      await ask(page, "please fail");
      const s = await failedOnce(page);
      expect(s.failures, q).toHaveLength(1);
      expect(s.failures[0].status, q).toBe(500);
      expect(judged(s), q).toEqual(rows);
    }
  }, SLOW);

  it("exclusion: a failure that is not the composer's (Rename), or comes before any stream, is silent; twin: the composer's after a stream fires", async () => {
    const page = await open("error=silent");
    await ask(page, "please fail");
    await page.waitForTimeout(2600);
    expect((await screenOf(page)).failures).toEqual([]);
    await ask(page);
    await answered(page);
    await page.click("#rename");
    await page.waitForTimeout(2600);
    const s = await screenOf(page);
    expect(s.failures).toEqual([]);
    expect(judged(s)).toEqual([]);
    await ask(page, "please fail");
    expect(judged(await failedOnce(page))).toEqual([row("ai.error", "nothing shown")]);
  }, SLOW);
});

// ---------------------------------------------------------------------------------------------------
// The confirmation's drive: it acts on the surface itself (its own prompt, each candidate pressed).

describe("argus-live aiux — the confirmation's drive (Chrome)", () => {
  it("ai.stop: a working Stop or the send turned Stop holds; none fires; a Stop that does not stop fires, which the walk alone could not rule on", async () => {
    expect(await drive(await open("stop=button"), "ai.stop")).toEqual([]);
    expect(await drive(await open("stop=swap"), "ai.stop")).toEqual([]);
    expect(await drive(await open("stop=none"), "ai.stop")).toEqual([row("ai.stop", "no stop control while it streamed")]);
    const broken = await drive(await open("stop=broken&n=60"), "ai.stop");
    expect(ids(broken)).toEqual(["ai.stop"]);
    expect(broken[0].measured).toMatch(/^it streamed \d+ ms past a stop$/);
  }, SLOW);

  it("ai.regenerate: Regenerate holds (pressed after Copy); a Copy alone fires as the drive's own row; no control fires", async () => {
    const good = await open("regen=yes");
    expect(await drive(good, "ai.regenerate")).toEqual([]);
    expect(await good.locator(".actions").count()).toBe(1);
    expect(await drive(await open("regen=copy"), "ai.regenerate")).toEqual([row("ai.regenerate", "none of 1 controls shown after the answer answered again")]);
    expect(await drive(await open("regen=none"), "ai.regenerate")).toEqual([row("ai.regenerate", "no control once the answer was complete")]);
  }, SLOW);

  it("ai.error: the marked prompt failed by the fault armed before the navigation; endless fires, Retry holds", async () => {
    const endless = await open("error=endless", { fault: AI_MARKER });
    expect(await drive(endless, "ai.error")).toEqual([row("ai.error", "an endless loader")]);
    expect(endless.armed.faulted()).toBe("/api/chat");
    const good = await open("error=retry", { fault: AI_MARKER });
    expect(await drive(good, "ai.error")).toEqual([]);
    expect(good.armed.faulted()).toBe("/api/chat");
  }, SLOW);

  it("exclusion, undecided: no failure came (the fault keyed to another prompt) → null; no AI surface → no row", async () => {
    const other = await open("error=endless", { fault: "another-prompt" });
    expect(await drive(other, "ai.error", 4000)).toBe(null);
    expect(other.armed.faulted()).toBe(null);
    for (const rule of AI_RULES) expect(await drive(await open("", { file: "search.html" }), rule, 4000), rule).toEqual([]);
    expect(await drive(await open("stream=once&stop=none"), "ai.stop", 4000)).toEqual([]);
  }, SLOW);
});
