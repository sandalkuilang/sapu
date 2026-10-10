// tests/argus-live-tasteflow.test.ts — phase 7 integration: screens recorded as lane J's session hook records them (its
// RECORDER and payload, PAGE_INIT in every document, the real probes of lanes T1 and T2, no stand-in) run through both
// probes' rules and T2's crossRules in the judge. The point is the seam: the shape J records (`taste`, `events`, `ease`,
// the run's other screens) is the shape T1's and T2's rules read, so each probe's rows reach judge.json.
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
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
import { tasteJudge } from "../plugins/sapu/scripts/argus-live-tastejudge.mjs";

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
    const page = /^\/(taste|ease)\/([a-z-]+\.html)$/.exec(url.pathname);
    if (page) {
      let text = readFileSync(join(PAGES, page[1], page[2]), "utf8");
      for (const [mark, value] of Object.entries(FILL)) text = text.split(mark).join(value);
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
      for (const [file, role, name] of [["consist-a.html", "button", "Save"], ["consist-b.html", "link", "Submit"]]) {
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
    // An even split: both screens' rows carry the one mark filing reads as needs-owner.
    const split = of("consistent.action");
    expect(split.map((x) => x.screen).sort()).toEqual(["/ease/consist-a.html|1280|light", "/ease/consist-b.html|1280|light"]);
    expect(split.every((x) => x.expected === NO_MAJORITY && x.journey === "notes")).toBe(true);
  }, 240_000);
});
