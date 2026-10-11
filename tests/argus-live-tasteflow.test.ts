// tests/argus-live-tasteflow.test.ts — phase 7 integration: screens recorded as lane J's session hook records them (its
// RECORDER and payload, PAGE_INIT in every document, the real probes of lanes T1 and T2, no stand-in) run through both
// probes' rules and T2's crossRules in the judge. The point is the seam: the shape J records (`taste`, `events`, `ease`,
// the run's other screens) is the shape T1's and T2's rules read, so each probe's rows reach judge.json.
import { createServer, type Server } from "node:http";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { browserTools, cleanTemps, committed } from "./helpers/argus-live";
// @ts-expect-error — plain ESM script without types
import { PAGE_INIT } from "../plugins/sapu/scripts/argus-live-browser.mjs";
// @ts-expect-error — plain ESM script without types
import { NO_MAJORITY } from "../plugins/sapu/scripts/argus-live-ease.mjs";
// @ts-expect-error — plain ESM script without types
import { takeLock } from "../plugins/sapu/scripts/argus-live-lock.mjs";
// @ts-expect-error — plain ESM script without types
import { keepScreen, RECORDER, recorderPayload, tasteDir } from "../plugins/sapu/scripts/argus-live-session.mjs";
// @ts-expect-error — plain ESM script without types
import { confirmSink, tasteJudge } from "../plugins/sapu/scripts/argus-live-tastejudge.mjs";
// @ts-expect-error — plain ESM script without types
import { report } from "../plugins/sapu/scripts/argus-live-report.mjs";
// @ts-expect-error — plain ESM script without types
import { withTasteKey } from "../plugins/sapu/scripts/argus-live-tastecfg.mjs";

type Obj = Record<string, any>;

afterEach(cleanTemps);

const PAGES = join(__dirname, "fixtures/journey-app/pages");
/** The ease pages' placeholders, as lane T2's own test server fills them. */
const FILL: Record<string, string> = { __MODE__: "keep", __ROWS__: "4", __LANG__: "en", __SUBMIT__: "Submit", __CONFIRM__: "OK" };

let browser: any;
let server: Server;
let origin = "";

beforeAll(async () => {
  const { cli, chrome } = browserTools();
  const { chromium } = createRequire(join(cli.dir, "package.json"))("playwright-core");
  browser = await chromium.launch({ executablePath: chrome.path, headless: true });
  server = createServer((req, res) => {
    const url = new URL(String(req.url), "http://x");
    const page = /^\/(taste|ease)\/([a-z0-9-]+\.html)$/.exec(url.pathname);
    if (page) {
      // A page seen on a second route of the journey (the consistency rules count routes).
      let text = readFileSync(join(PAGES, page[1], page[2].replace(/^consist-(a|b)\1\.html$/, "consist-$1.html")), "utf8");
      for (const [mark, value] of Object.entries(FILL)) text = text.split(mark).join(mark === "__MODE__" ? (url.searchParams.get("mode") || value).replace(/[^a-z]/g, "") : value);
      res.setHeader("content-type", "text/html");
      res.end(text);
      return;
    }
    req.resume();
    const ms = Number(url.searchParams.get("ms") || 0);
    const json = (body: unknown) =>
      setTimeout(() => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(body));
      }, ms);
    if (url.pathname === "/api/wait") return json({ ms });
    if (url.pathname === "/api/items") return json([{ name: "Order one" }, { name: "Order two" }]);
    if (["/api/save", "/api/notes", "/api/prefs", "/api/check"].includes(url.pathname)) return json({ ok: true });
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}, 60_000);

afterAll(async () => {
  await browser?.close();
  server?.closeAllConnections();
  server?.close();
}, 30_000);

describe("phase 7 integration — a screen J records runs through T1's and T2's rules", () => {
  it("each probe's rows reach judge.json from real recordings: T1's census, T2's screen kind and events, T2's cross-screen split", async () => {
    const main = committed();
    const runId = takeLock(main, { maxCycleMinutes: 45 }).runId as string;
    const record = new Function(`return ${RECORDER}`)() as (page: Obj, o: Obj, T: Obj) => Promise<Obj>;
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    try {
      // The session hook's init payload, in every document from the first one on.
      await context.addInitScript({ content: PAGE_INIT });
      const page = await context.newPage();
      let n = 0;
      /** One observation's recording, kept as the driver keeps it (the payload made afresh, as each observation makes it). */
      const observe = async () => {
        n += 1;
        const T = recorderPayload({ main, runId, slot: 1, slotRec: { journey: "notes" }, prev: null, settleMs: 1000 });
        expect(T).not.toBeNull();
        const answer = await record(page, { url: page.url(), aria: `state ${n}` }, T);
        expect(answer.faults, page.url()).toEqual([]);
        keepScreen(main, runId, { slot: 1, account: "buyer.1", journey: "notes" }, answer);
        return answer;
      };
      // T1: an h2 larger than the h1 it sits under.
      await page.goto(`${origin}/taste/headings.html`);
      await observe();
      // T2's screen kind: broken copy.
      await page.goto(`${origin}/ease/copy-broken.html`);
      const copy = await observe();
      expect(copy.ease.copy.length).toBeGreaterThan(0);
      // T2's events: a 1.5 s wait with nothing shown, the action and its first change drained with the screen.
      await page.goto(`${origin}/ease/feedback.html`);
      await page.click("#silent");
      await page.getByText("silent done").waitFor({ timeout: 30_000 });
      const wait = await observe();
      expect(wait.events.some((e: Obj) => e.kind === "input")).toBe(true);
      // T2's crossRules: one endpoint saved by a "Save" button on one screen and a "Submit" link on the other.
      for (const [file, role, name] of [["consist-a.html", "button", "Save"], ["consist-aa.html", "button", "Save"], ["consist-b.html", "link", "Submit"], ["consist-bb.html", "link", "Submit"]]) {
        await page.goto(`${origin}/ease/${file}`);
        await page.getByLabel("Title").fill("Groceries");
        await page.getByLabel("Body").fill("milk");
        await page.getByRole(role, { name }).click();
        await page.getByText("Note saved.").waitFor({ timeout: 30_000 });
        await observe();
      }
    } finally {
      await context.close();
    }
    const r = await tasteJudge(main, { run: runId });
    expect(r.code).toBe(0);
    expect(r.lines.join("\n")).not.toMatch(/harness: /);
    const rows = JSON.parse(readFileSync(join(tasteDir(main, runId), "judge.json"), "utf8")).rows as Obj[];
    const of = (rule: string) => rows.filter((x) => x.rule === rule);
    expect(of("hierarchy.heading-order").map((x) => [x.screen, x.key])).toEqual([["/taste/headings.html|1280|light", "h2|Profile"]]);
    expect(of("copy.broken").length).toBeGreaterThan(0);
    expect(of("copy.broken").every((x) => x.screen === "/ease/copy-broken.html|1280|light")).toBe(true);
    const busy = of("feedback.busy");
    expect(busy.map((x) => x.screen)).toEqual(["/ease/feedback.html|1280|light"]);
    expect(busy[0].measured).toBeGreaterThanOrEqual(1400);
    // An even split (each way on two routes): every screen's row carries the one mark filing reads as needs-owner.
    const split = of("consistent.action");
    expect(split.map((x) => x.screen).sort()).toEqual(["/ease/consist-a.html|1280|light", "/ease/consist-aa.html|1280|light", "/ease/consist-b.html|1280|light", "/ease/consist-bb.html|1280|light"]);
    expect(split.every((x) => x.expected === NO_MAJORITY && x.journey === "notes")).toBe(true);
  }, 240_000);

  it("never records what a user typed: a filled password, API key, email, textarea or editable box that was clicked reaches no file of the run, no judge row and no report", async () => {
    const main = committed();
    const runId = takeLock(main, { maxCycleMinutes: 45 }).runId as string;
    const record = new Function(`return ${RECORDER}`)() as (page: Obj, o: Obj, T: Obj) => Promise<Obj>;
    const SECRETS = ["Hunter2-SuperSecret!", "sk_li\u0076e_51HxQ2eZvKYlo2C0aBcDeFgHiJkL", "buyer7@example.test", "my note 4417 private", "draft text 9031 private"];
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    try {
      await context.addInitScript({ content: PAGE_INIT });
      const page = await context.newPage();
      await page.goto(`${origin}/ease/leak.html`);
      await page.fill("#e", SECRETS[2]);
      await page.fill("#p", SECRETS[0]);
      await page.fill("#n", SECRETS[3]);
      await page.click("#c");
      await page.keyboard.type(SECRETS[4]);
      for (const id of ["#p", "#k", "#e", "#n", "#c", "#go"]) await page.click(id);
      await page.getByText("Signed in.").waitFor({ timeout: 30_000 });
      const T = recorderPayload({ main, runId, slot: 1, slotRec: { journey: "notes" }, prev: null, settleMs: 1000 });
      const answer = await record(page, { url: page.url(), aria: "state 1" }, T);
      keepScreen(main, runId, { slot: 1, account: "buyer.1", journey: "notes" }, answer);
      // The clicked fields are named by their labels, never by what they hold.
      expect(answer.ease.actions.map((a: Obj) => a.name)).toEqual(expect.arrayContaining(["Password", "API key", "Email", "Note", "Sign in"]));
    } finally {
      await context.close();
    }
    expect((await tasteJudge(main, { run: runId })).code).toBe(0);
    const said = report(main, { run: runId }).lines.join("\n");
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (!f.endsWith(".png")) files.push(readFileSync(p, "utf8"));
      }
    };
    walk(join(main, ".argus"));
    const all = [...files, said].join("\n");
    // As typed, and as the probes write page text (digit runs as #), scrub's exact match would miss.
    for (const v of SECRETS) for (const form of [v, v.replace(/[0-9]+/g, "#")]) expect(all, form).not.toContain(form);
  }, 240_000);

  it("a page that overwrites, deletes, drains or forges the recorders' records can neither force nor suppress a row", async () => {
    const judged = async (click: boolean) => {
      const main = committed();
      const runId = takeLock(main, { maxCycleMinutes: 45 }).runId as string;
      const record = new Function(`return ${RECORDER}`)() as (page: Obj, o: Obj, T: Obj) => Promise<Obj>;
      // As the lane puts them in a page: the run's key in place of the mark, which the page only guesses.
      const key = "5e".repeat(16);
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      try {
        await context.addInitScript({ content: withTasteKey(PAGE_INIT, key) });
        const page = await context.newPage();
        await page.goto(`${origin}/ease/hostile.html`);
        if (click) {
          await page.click("#silent");
          await page.getByText("silent done").waitFor({ timeout: 30_000 });
        }
        const T = JSON.parse(withTasteKey(JSON.stringify(recorderPayload({ main, runId, slot: 1, slotRec: { journey: "notes" }, prev: null, settleMs: 1000 })), key));
        keepScreen(main, runId, { slot: 1, account: "buyer.1", journey: "notes" }, await record(page, { url: page.url(), aria: "state 1" }, T));
      } finally {
        await context.close();
      }
      expect((await tasteJudge(main, { run: runId })).code).toBe(0);
      return (JSON.parse(readFileSync(join(tasteDir(main, runId), "judge.json"), "utf8")).rows as Obj[]).map((r) => r.rule);
    };
    // Forged records alone: no feedback, success or latency row.
    expect((await judged(false)).filter((r) => /^(feedback|states)\./.test(r))).toEqual([]);
    // A real 1.5 s silent wait after all that: still measured.
    expect(await judged(true)).toContain("feedback.busy");
  }, 240_000);

  it("the replay measures first what the walk never does: dark parity and reduced motion at a recorded screen not measured yet", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    try {
      const page = await context.newPage();
      const go = (path: string) => `async page => {\n  await page.goto(${JSON.stringify(`${origin}${path}`)});\n  return { ok: true };\n}\n`;
      const run = async (sink: Obj, path: string) => sink.take(await new Function(`return ${sink.wrap(go(path))}`)()(page));
      const probe = (at: string, over: Obj = {}) => ({ at, screens: [at], skip: [], target: null, ...over });
      // Dark parity: a probe of its own (no row), its screen the target; the census of both schemes, the media rules' rows.
      const DARK = "/taste/dark.html|1280|light";
      const dark = confirmSink([], { routes: [], settleMs: 5000, probe: probe(DARK) });
      expect(await run(dark, "/taste/dark.html")).toEqual({ ok: true });
      expect(dark.measured).toEqual({ rows: [] });
      expect(dark.probes).toHaveLength(1);
      expect(dark.probes[0]).toMatchObject({ key: DARK, themes: "dual" });
      expect(dark.probes[0].rows).toEqual(expect.arrayContaining([expect.objectContaining({ rule: "colour.dark-border", key: "input|Display name" }), expect.objectContaining({ rule: "colour.dark-surface", key: "div|Legacy panel" })]));
      expect(await page.evaluate("matchMedia('(prefers-color-scheme: dark)').matches")).toBe(false);
      // Twins: measured already (skip), a screen the walk never recorded, a single-theme page (no row).
      for (const p of [probe(DARK, { skip: [DARK] }), probe("/taste/other.html|1280|light", { screens: ["/taste/other.html|1280|light"] })]) {
        const s = confirmSink([], { routes: [], settleMs: 5000, probe: p });
        await run(s, "/taste/dark.html");
        expect(s.probes).toEqual([]);
      }
      const single = confirmSink([], { routes: [], settleMs: 5000, probe: probe("/taste/single.html|1280|light") });
      await run(single, "/taste/single.html");
      expect(single.probes).toEqual([{ key: "/taste/single.html|1280|light", themes: "single", rows: [] }]);
    } finally {
      await context.close();
    }
  }, 180_000);

  it("a states.recovery row is measured in the replay by the ease probe's form case (RECOVERY_SOURCE): each field the refusal lost, the values put back", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    try {
      const page = await context.newPage();
      const sink = confirmSink({ row: "t1", journey: "j", rule: "states.recovery", class: "implicit", screen: "/ease/recovery.html|1280|light", key: "Email", measured: "lost", expected: null }, { routes: [], settleMs: 5000 });
      expect(sink.arm).toBeNull();
      const step = `async page => {\n  await page.goto(${JSON.stringify(`${origin}/ease/recovery.html?mode=clear`)});\n  await page.fill("input[name=name]", "Ada");\n  await page.fill("input[name=email]", "ada@example.test");\n  await page.fill("textarea[name=notes]", "call back");\n  return { ok: true };\n}\n`;
      expect(sink.take(await new Function(`return ${sink.wrap(step)}`)()(page))).toEqual({ ok: true });
      expect(sink.measured).toEqual({ rows: [{ key: "Email", measured: "lost" }, { key: "Notes", measured: "lost" }] });
      expect(await page.inputValue("input[name=email]")).toBe("ada@example.test");
    } finally {
      await context.close();
    }
  }, 120_000);
});
