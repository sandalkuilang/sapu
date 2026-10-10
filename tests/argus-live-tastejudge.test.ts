// tests/argus-live-tastejudge.test.ts — lane J's file: the journey lane's taste pass (spec §20.4): the screens the
// session hook records (argus-live-session.mjs), the judge and its confirmation replay (argus-live-tastejudge.mjs) and
// SELECT's taste factor (argus-live-map.mjs). The probes (lanes T1, T2) are stood in for by minimal sources here, so
// these tests pin the pass, not the probes' own rules.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ARGUS_LIVE, browserCleanup, browserLeftovers, browserTools, cleanups, committed, example, git, liveContract, makeShim, pwBrowserRun, tempDir } from "./helpers/argus-live";
// @ts-expect-error — plain ESM script without types
import { slotDir } from "../plugins/sapu/scripts/argus-live-browser.mjs";
// @ts-expect-error — plain ESM script without types
import { runCli, sessionName } from "../plugins/sapu/scripts/argus-live-cli.mjs";
// @ts-expect-error — plain ESM script without types
import { takeLock } from "../plugins/sapu/scripts/argus-live-lock.mjs";
// @ts-expect-error — plain ESM script without types
import { loginCode } from "../plugins/sapu/scripts/argus-live-login.mjs";
// @ts-expect-error — plain ESM script without types
import { startTime } from "../plugins/sapu/scripts/argus-live-proc.mjs";
// @ts-expect-error — plain ESM script without types
import { pw } from "../plugins/sapu/scripts/argus-live-pw.mjs";
// @ts-expect-error — plain ESM script without types
import { down, updateRun, writeRunFiles } from "../plugins/sapu/scripts/argus-live-run.mjs";
// @ts-expect-error — plain ESM script without types
import { keepScreen, MAIN_ROWS, observeCode, PALETTE, RECORDER, routeTemplate, SHOT_READ, spendTaste, tasteDir, tasteSpent } from "../plugins/sapu/scripts/argus-live-session.mjs";
// @ts-expect-error — plain ESM script without types
import { mintSlot, readSlotState, writeSlotState } from "../plugins/sapu/scripts/argus-live-slots.mjs";
// @ts-expect-error — plain ESM script without types
import { makeHome, makeWorktree } from "../plugins/sapu/scripts/argus-live-start.mjs";
// @ts-expect-error — plain ESM script without types
import { MEDIA_READ, TASTE_BUDGET_MS, TASTE_BUFFER, TASTE_DRAIN } from "../plugins/sapu/scripts/argus-live-tastecfg.mjs";
// @ts-expect-error — plain ESM script without types
import { tasteConfirm, tasteJudge } from "../plugins/sapu/scripts/argus-live-tastejudge.mjs";

type Obj = Record<string, any>;

/** Minimal stand-ins for the probes lanes T1 and T2 build: what the pass records and judges, not what a rule measures. */
const STAND_IN = vi.hoisted(() => ({
  taste: `(arg) => ({ pass: arg.pass, elements: document.querySelectorAll("*").length, dark: matchMedia("(prefers-color-scheme: dark)").matches, reduce: matchMedia("(prefers-reduced-motion: reduce)").matches })`,
  ease: `(arg) => ({ buttons: document.querySelectorAll("button").length })`,
}));
vi.mock("../plugins/sapu/scripts/argus-live-taste.mjs", async (orig) => ({ ...((await orig()) as Obj), TASTE_SOURCE: STAND_IN.taste }));
vi.mock("../plugins/sapu/scripts/argus-live-ease.mjs", async (orig) => ({ ...((await orig()) as Obj), EASE_SOURCE: STAND_IN.ease }));

afterEach(browserCleanup, 60_000);
afterEach(browserLeftovers);

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const mode = (f: string) => statSync(f).mode & 0o777;
const lines = (f: string): Obj[] => (existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
/** An explorer's output with its fence nonces made equal: two calls are compared byte for byte otherwise. */
const sameNonce = (out: string[]) => out.map((l) => l.replace(/(<<<PAGE-|PAGE-)[0-9a-f]{32}/g, "$1N"));

/**
 * A cycle as `up` leaves it, with slot 1 minted for `order-to-cash` (buyer.1), the CLI shim as its browser CLI and
 * buyer.1's session open and signed in, so `pw` runs with no browser: each run-code answers the shim's queue.
 */
const shimRun = async () => {
  process.env.TMPDIR = tempDir();
  const main = committed();
  const c = example();
  c.roles = { anon: {}, buyer: { users: [{ user: "buyer1@example.test", password: "${PW}" }] } };
  delete c.fixtures;
  mkdirSync(join(main, ".argus"));
  writeFileSync(join(main, ".argus/live.json"), `${JSON.stringify(c, null, 2)}\n`);
  writeFileSync(join(main, ".argus/live.env"), "PW=pw-1\nSALES_TOTP=GEZDGNBVGY3TQOJQ\nDB_PW=db-pw-Kx7q\n");
  writeFileSync(join(main, ".gitignore"), ".argus/live.env\n.argus/live/\n");
  liveContract(main);
  git(main, "add", ".");
  git(main, "-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", "commit", "-qm", "live");
  const { shim, calls, queue } = makeShim();
  const l = takeLock(main, { maxCycleMinutes: 45 });
  const runId = l.runId as string;
  const home = makeHome(main, runId);
  writeRunFiles(main, { runId, worktree: makeWorktree(main, runId), home, origins: ["http://localhost:41001", "http://localhost:41002"], allowOrigins: [], groups: [], env: { PATH: process.env.PATH }, ports: { api: 41001, web: 41002, pg: 41003, redis: 41004, smtp: 41005 }, instanceId: "0123456789abcdef", internal: { proxy: 45123 }, browser: { js: shim, channel: "chrome" } });
  cleanups.push(() => down(main, { runId, graceMs: 1000 }));
  const m = await mintSlot(main, { slot: 1, journey: "order-to-cash", accounts: { "buyer.1": "buyer1@example.test" } });
  const dir = slotDir(main, runId, 1);
  const bhome = join(home, "browser");
  mkdirSync(bhome, { recursive: true, mode: 0o700 });
  // This process stands in for the daemon: the teardown never signals its own process.
  const me = { pid: process.pid, pgid: process.pid, started: startTime(process.pid) };
  updateRun(main, runId, (prev: Obj) => ({ ...prev, sessions: [{ name: sessionName(runId, 1, "buyer.1"), slot: 1, account: "buyer.1", cwd: dir, home: bhome, daemon: me, browser: null }] }));
  writeSlotState(dir, { ...readSlotState(dir), sessions: { "buyer.1": { signedIn: true } } });
  const call = (...args: string[]) => pw(main, [m.token, ...args], { cli: shim });
  const codes = () => calls().filter((x) => x.argv.includes("run-code")).map((x) => x.code as string);
  return { main, runId, dir, call, codes, queue, taste: tasteDir(main, runId) };
};

/** The observation the shim answers for a page at `path`, with the recorder's answer `taste` (undefined: none). */
const observed = (path: string, taste?: Obj) => ({ signals: [], loggedIn: true, url: `http://localhost:41002${path}`, aria: `- heading "${path}"`, tabs: 1, secrets: {}, ...(taste === undefined ? {} : { taste }) });
/** A recorder's answer for a new screen. */
const recorded = (over: Obj = {}) => ({ changed: true, route: "/orders/:id", width: 1440, theme: "light", census: { pass: "base", elements: 9 }, ease: { buttons: 1 }, rows: 0, themed: false, dark: null, reduce: { pass: "reduce", elements: 9 }, events: [{ kind: "input", t: 10, type: "click" }, { kind: "change", t: 42, cause: "added", attr: null }], dropped: 0, shots: [], faults: [], ms: 1200, ...over });

describe("argus-live taste recording — the session hook (J1)", () => {
  it("routeTemplate: the map's most literal route, else id-like segments as :id", () => {
    const routes = ["/orders/:id", "/orders/new", "/teams/{team}/members/[member]", "/a/*"];
    expect(routeTemplate("/orders/new", routes)).toBe("/orders/new");
    expect(routeTemplate("/orders/ORD-1001", routes)).toBe("/orders/:id");
    expect(routeTemplate("/teams/core/members/ana", routes)).toBe("/teams/{team}/members/[member]");
    expect(routeTemplate("/a/b", routes)).toBe("/a/*");
    expect(routeTemplate("/", routes)).toBe("/");
    expect(routeTemplate("", [])).toBe("/");
    // No route of the map: ids become :id; a version segment or a word stays.
    expect(routeTemplate("/v2/items/123/edit", [])).toBe("/v2/items/:id/edit");
    expect(routeTemplate("/x/3f2504e0-4f89-11d3-9a0c-0305e82c3301/y/0123456789abcdef0123", [])).toBe("/x/:id/y/:id");
    expect(routeTemplate("/inv/INV-2024-007/a1b2c3d4e5f6a7b8c9d0e1", [])).toBe("/inv/:id/:id");
    expect(routeTemplate("/a b/c|d", [])).toBe("/a_b/c_d");
    expect(routeTemplate(`/${"x".repeat(300)}`, []).length).toBe(200);
  });

  it("observeCode is the observe stage byte for byte when nothing records, and the stage then the bounded recorder when something does", () => {
    const payload = { loggedIn: "getByRole('button', { name: 'Account' })" };
    expect(observeCode(payload, null)).toBe(loginCode("observe", payload));
    const T = { prev: null, routes: [], taste: STAND_IN.taste, ease: STAND_IN.ease, limitMs: 5000, maxBytes: 400_000 };
    const code = observeCode(payload, T);
    expect(code.startsWith("async page => {\n  const observed = await (async page => {")).toBe(true);
    expect(code).toContain(`const T = ${JSON.stringify(T)};`);
    expect(code).toContain(`const record = ${RECORDER};`);
    expect(code).toContain('ok({ failed: "timeout" })');
    expect(code).toContain('taste = { failed: "too large" }');
    // It parses as one function of the page.
    expect(typeof new Function(`return ${code}`)()).toBe("function");
  });

  it("keepScreen keeps a new screen (0600), drops events of a shape the buffer refuses, and counts its time", () => {
    const main = committed();
    const runId = "20000101000000-0123abcd";
    const at = { slot: 1, account: "buyer.1", journey: "order-to-cash" };
    keepScreen(main, runId, at, recorded({ events: [{ kind: "input", t: 10, type: "click" }, { kind: "input", t: -1, type: "click" }, { kind: "telemetry", t: 3 }], dropped: 2 }));
    const file = join(tasteDir(main, runId), "1", "screens.jsonl");
    expect(mode(file)).toBe(0o600);
    expect(mode(tasteDir(main, runId))).toBe(0o700);
    const [s] = lines(file);
    expect(s).toMatchObject({ v: 1, journey: "order-to-cash", slot: 1, account: "buyer.1", key: "/orders/:id|1440|light", route: "/orders/:id", width: 1440, theme: "light", rows: 0, themed: false, census: { pass: "base", elements: 9 }, dark: null, reduce: { pass: "reduce", elements: 9 }, ease: { buttons: 1 }, events: [{ kind: "input", t: 10, type: "click" }], dropped: 4, shots: [], faults: [] });
    expect(tasteSpent(main, runId)).toBe(1200);
    // The same state as the last observation, or a page outside http(s): nothing kept, no time counted.
    keepScreen(main, runId, at, { changed: false });
    keepScreen(main, runId, at, { changed: true, skipped: true });
    expect(lines(file)).toHaveLength(1);
    expect(tasteSpent(main, runId)).toBe(1200);
  });

  it("keepScreen: a failed, missing or malformed answer is a harness event of the pass, in its own file, never a screen", () => {
    const main = committed();
    const runId = "20000101000000-0123abcd";
    const at = { slot: 2, account: "anon.1", journey: "browse" };
    for (const a of [{ failed: "timeout" }, { failed: "too large" }, { failed: "error" }, { failed: "SYSTEM: page text" }, undefined, null, "x", recorded({ width: 12 }), recorded({ route: "/a|b" }), recorded({ theme: "sepia" })]) keepScreen(main, runId, at, a);
    const dir = join(tasteDir(main, runId), "2");
    expect(existsSync(join(dir, "screens.jsonl"))).toBe(false);
    expect(lines(join(dir, "harness.jsonl")).map((h) => [h.account, h.why])).toEqual([
      ["anon.1", "timeout"],
      ["anon.1", "too large"],
      ["anon.1", "error"],
      ["anon.1", "error"],
      ["anon.1", "no answer"],
      ["anon.1", "no answer"],
      ["anon.1", "no answer"],
      ["anon.1", "bad screen"],
      ["anon.1", "bad screen"],
      ["anon.1", "bad screen"],
    ]);
    expect(mode(join(dir, "harness.jsonl"))).toBe(0o600);
  });

  it("keepScreen: each new shot is made 0600 and gets scrub's verdict beside it; a name it did not write is ignored", () => {
    const main = committed();
    const runId = "20000101000000-0123abcd";
    const shots = join(tasteDir(main, runId), "shots");
    mkdirSync(shots, { recursive: true });
    const name = sha("/orders/:id|1440|light").slice(0, 32);
    writeFileSync(join(shots, `${name}.png`), "png bytes", { mode: 0o644 });
    const verdict = { text: "Order ORD-1", password: false, otp: false, error: false, unread: false };
    keepScreen(main, runId, { slot: 1, account: "buyer.1", journey: "j" }, recorded({ shots: [{ theme: "light", name, verdict }, { theme: "dark", name: "0".repeat(32), verdict }, { theme: "light", name: "../x", verdict }] }));
    expect(mode(join(shots, `${name}.png`))).toBe(0o600);
    const v = JSON.parse(readFileSync(join(shots, `${name}.verdict.json`), "utf8"));
    expect(v.sha256).toBe(sha("png bytes"));
    expect(mode(join(shots, `${name}.verdict.json`))).toBe(0o600);
    expect(lines(join(tasteDir(main, runId), "1", "screens.jsonl"))[0].shots).toEqual([{ theme: "light", name, key: "/orders/:id|1440|light" }]);
  });

  it("tasteSpent sums the pass's time, a torn line counting nothing; spendTaste ignores a time that is no time", () => {
    const main = committed();
    const runId = "20000101000000-0123abcd";
    expect(tasteSpent(main, runId)).toBe(0);
    spendTaste(main, runId, "record", 250.4);
    spendTaste(main, runId, "judge", 0);
    spendTaste(main, runId, "judge", Number.NaN);
    writeFileSync(join(tasteDir(main, runId), "spent.jsonl"), '{"what":"x","ms":5}\n{"what"\n', { flag: "a" });
    spendTaste(main, runId, "confirm", 1000);
    expect(tasteSpent(main, runId)).toBe(1255);
    expect(mode(join(tasteDir(main, runId), "spent.jsonl"))).toBe(0o600);
  });

  it("pw: the explorer's output is byte for byte the same with and without recording, and the screen is kept", async () => {
    const on = await shimRun();
    on.queue(observed("/orders/7", recorded()));
    const a = await on.call("buyer.1", "goto", "/orders/7");
    const off = await shimRun();
    spendTaste(off.main, off.runId, "record", TASTE_BUDGET_MS); // past the budget: no new screen is recorded
    off.queue(observed("/orders/7", recorded()));
    const b = await off.call("buyer.1", "goto", "/orders/7");
    expect(a.code).toBe(0);
    expect(sameNonce(a.out)).toEqual(sameNonce(b.out));
    expect(a.out.join("\n")).not.toMatch(/taste|census|screens/);
    // The recording observation: the stage, then the recorder with the stand-in probes; the other the plain stage.
    const [recCode] = on.codes();
    expect(recCode).toContain("const record = async (page, o, T)");
    expect(recCode).toContain(JSON.stringify(STAND_IN.taste));
    expect(recCode).toContain(JSON.stringify(STAND_IN.ease));
    expect(recCode).toContain('"prev":null');
    expect(off.codes()).toEqual([loginCode("observe", { loggedIn: "getByRole('button', { name: 'Account' })" })]);
    expect(lines(join(on.taste, "1", "screens.jsonl")).map((s) => [s.journey, s.account, s.key])).toEqual([["order-to-cash", "buyer.1", "/orders/:id|1440|light"]]);
    expect(existsSync(join(off.taste, "1", "screens.jsonl"))).toBe(false);
    // The next observation hands the recorder this state, so a command that changed nothing records nothing.
    on.queue(observed("/orders/7", { changed: false }));
    await on.call("buyer.1", "snapshot");
    expect(on.codes()[1]).toContain(`"prev":"${sha(`http://localhost:41002/orders/7\n- heading "/orders/7"`)}"`);
    expect(lines(join(on.taste, "1", "screens.jsonl"))).toHaveLength(1);
  }, 60_000);

  it("pw: a recording that failed is a harness event of the pass; the explorer's output and exit stay as they were", async () => {
    const t = await shimRun();
    t.queue(observed("/orders/7", { failed: "timeout" }));
    const failed = await t.call("buyer.1", "goto", "/orders/7");
    const u = await shimRun();
    u.queue(observed("/orders/7", recorded()));
    const ok = await u.call("buyer.1", "goto", "/orders/7");
    expect(failed.code).toBe(0);
    expect(sameNonce(failed.out)).toEqual(sameNonce(ok.out));
    expect(lines(join(t.taste, "1", "harness.jsonl")).map((h) => h.why)).toEqual(["timeout"]);
    expect(existsSync(join(t.taste, "1", "screens.jsonl"))).toBe(false);
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------------
// The recorder in Chrome, through the pinned install's playwright-core (no run, no proxy).

const PAGES: Record<string, string> = {
  plain: `<main><h1>Orders</h1><button>New order</button></main>`,
  themed: `<style>body{background:white;color:black;transition:background-color .2s} @media (prefers-color-scheme: dark){body{background:black;color:white}}</style><main><h1>Orders</h1><button>New order</button></main>`,
  // A colour that animates forever, on a page with no theme: it differs between two reads in light, so it never tells a theme.
  pulse: `<style>@keyframes pulse{from{color:red}to{color:blue}} .p{animation:pulse .3s infinite alternate}</style><main><p class="p">pulse</p><p>still</p></main>`,
  table: `<main><table><thead><tr><th>Order</th></tr></thead><tbody>${Array.from({ length: 12 }, (_, i) => `<tr><td>ORD-${i}</td></tr>`).join("")}</tbody></table></main><aside><table>${Array.from({ length: 30 }, () => "<tr><td>x</td></tr>").join("")}</table></aside>`,
};

describe("argus-live taste recorder — in Chrome (J1)", () => {
  let server: Server;
  let base = "";
  let browser: Obj;
  const record = new Function(`return ${RECORDER}`)() as (page: Obj, o: Obj, T: Obj) => Promise<Obj>;
  beforeAll(async () => {
    const { cli, chrome } = browserTools();
    const pwc = createRequire(join(cli.dir, "package.json"))("playwright-core");
    server = createServer((req, res) => {
      const name = (req.url ?? "/").split("?")[0].split("/")[1] ?? "";
      if (!Object.hasOwn(PAGES, name)) return void res.writeHead(404).end();
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><html lang="en"><body>${PAGES[name]}</body></html>`);
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browser = await pwc.chromium.launch({ channel: chrome.channel });
  }, 600_000);
  afterAll(async () => {
    await browser?.close();
    server?.closeAllConnections();
    await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
  }, 30_000);

  /** A page on fixture `name` with the taste buffer and a stand-in motion recorder (lane T1's TASTE_INIT), and the recorder's payload. */
  const open = async (name: string, contextOptions: Obj = {}) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, ...contextOptions });
    const page = await context.newPage();
    await page.addInitScript(`${TASTE_BUFFER};document.addEventListener("transitionrun", (e) => document.__argusTastePush({ kind: "transition", t: performance.now(), phase: "run", name: String(e.propertyName), duration_ms: 0, delay_ms: 0, easing: "", target: "body" }), true);`);
    await page.goto(`${base}/${name}/1234`);
    const shots = join(tempDir(), "shots");
    mkdirSync(shots);
    // The recorder's payload as the session hook makes it, with a directory of its own for the shots.
    const T = { prev: null, routes: [], taste: STAND_IN.taste, ease: STAND_IN.ease, media: MEDIA_READ, drain: TASTE_DRAIN, rows: MAIN_ROWS, palette: PALETTE, read: SHOT_READ, shots, taken: [] as string[], limitMs: 20_000, maxBytes: 400_000, maxText: 150_000, settle: 100 };
    return { page, context, shots, T, close: () => context.close() };
  };

  it("a new screen: its key, census, ease, the rows of main's largest table, one shot per key; the same state again records nothing", async () => {
    const p = await open("table");
    try {
      const T = p.T;
      const a = await record(p.page, { url: p.page.url(), aria: "x" }, T);
      expect(a).toMatchObject({ changed: true, route: "/table/:id", width: 1280, theme: "light", census: { pass: "base", dark: false }, ease: { buttons: 0 }, rows: 12, themed: false, dark: null, reduce: { pass: "reduce", reduce: true }, faults: [] });
      const name = sha("/table/:id|1280|light").slice(0, 32);
      expect(a.shots).toEqual([{ theme: "light", name, verdict: expect.objectContaining({ password: false, otp: false, error: false, unread: false }) }]);
      expect(readdirSync(p.shots)).toEqual([`${name}.png`]);
      // A key already shot this run is not shot again; the same state (prev) records nothing at all.
      const again = await record(p.page, { url: p.page.url(), aria: "y" }, { ...T, taken: [name] });
      expect(again.shots).toEqual([]);
      expect(await record(p.page, { url: p.page.url(), aria: "x" }, { ...T, prev: sha(`${p.page.url()}\nx`) })).toEqual({ changed: false });
      // The media are back as they were: light, no preference.
      expect(await p.page.evaluate(MEDIA_READ)).toEqual({ colorScheme: "light", reducedMotion: "no-preference" });
    } finally {
      await p.close();
    }
  }, 60_000);

  it("a themed page gets a dark census and a dark shot; its twin, a page whose colour only animates, is single theme", async () => {
    const themed = await open("themed");
    const pulse = await open("pulse");
    try {
      const a = await record(themed.page, { url: themed.page.url(), aria: "x" }, themed.T);
      expect(a).toMatchObject({ themed: true, dark: { pass: "dark", dark: true }, census: { dark: false } });
      expect(a.shots.map((s: Obj) => s.theme)).toEqual(["light", "dark"]);
      expect(readdirSync(themed.shots).sort()).toEqual([`${sha("/themed/:id|1280|light").slice(0, 32)}.png`, `${sha("/themed/:id|1280|dark").slice(0, 32)}.png`].sort());
      const b = await record(pulse.page, { url: pulse.page.url(), aria: "x" }, pulse.T);
      expect(b).toMatchObject({ themed: false, dark: null });
      expect(b.shots.map((s: Obj) => s.theme)).toEqual(["light"]);
      for (const p of [themed, pulse]) expect(await p.page.evaluate(MEDIA_READ)).toEqual({ colorScheme: "light", reducedMotion: "no-preference" });
    } finally {
      await themed.close();
      await pulse.close();
    }
  }, 60_000);

  it("the media read at the start are restored explicitly (a dark, reduced context stays so); the action's events are kept, the passes' own drained", async () => {
    const dark = await open("themed", { colorScheme: "dark", reducedMotion: "reduce" });
    const light = await open("themed");
    try {
      const a = await record(dark.page, { url: dark.page.url(), aria: "x" }, dark.T);
      expect(a).toMatchObject({ theme: "dark", themed: false, dark: null, reduce: null, census: { pass: "base", dark: true, reduce: true } });
      expect(a.shots.map((s: Obj) => s.theme)).toEqual(["dark"]);
      expect(await dark.page.evaluate(MEDIA_READ)).toEqual({ colorScheme: "dark", reducedMotion: "reduce" });
      // An event of the explorer's action is in the buffer before the recorder runs; the dark pass's transition is not kept for the next one.
      await light.page.evaluate(() => (document as Obj).__argusTastePush({ kind: "input", t: performance.now(), type: "click" }));
      const b = await record(light.page, { url: light.page.url(), aria: "x" }, light.T);
      expect(b.events.map((e: Obj) => e.kind)).toEqual(["input"]);
      expect(b.themed).toBe(true);
      expect((await light.page.evaluate(TASTE_DRAIN)).events).toEqual([]);
    } finally {
      await dark.close();
      await light.close();
    }
  }, 60_000);

  it("a probe that throws is a fault of the record, never a failure; a page outside http is skipped", async () => {
    const p = await open("plain");
    try {
      const T = { ...(p.T), taste: "(arg) => { throw new Error('probe') }" };
      const a = await record(p.page, { url: p.page.url(), aria: "x" }, T);
      expect(a).toMatchObject({ changed: true, census: null, reduce: null, ease: { buttons: 1 }, faults: ["census", "reduce"] });
      await p.page.goto("about:blank");
      expect(await record(p.page, { url: "about:blank", aria: "" }, T)).toEqual({ changed: true, skipped: true });
    } finally {
      await p.close();
    }
  }, 60_000);
});

describe("argus-live taste recording — through the browser CLI (J1)", () => {
  beforeAll(() => {
    browserTools();
  }, 600_000);

  it("pw records each new screen in the daemon's own run-code: one line, one shot (0600, with its verdict), the session left light", async () => {
    const b = await pwBrowserRun();
    const first = await b.call("anon.1", "goto", "/");
    expect(first.code).toBe(0);
    expect(first.out.join("\n")).not.toMatch(/taste|census|screens|harness/);
    await b.call("anon.1", "snapshot"); // the same state: nothing new
    await b.call("anon.1", "goto", "/login");
    const dir = tasteDir(b.main, b.runId);
    expect(existsSync(join(dir, "1", "harness.jsonl"))).toBe(false);
    const screens = lines(join(dir, "1", "screens.jsonl"));
    expect(screens.map((s) => [s.journey, s.account, s.key, s.themed, s.census?.pass, s.reduce?.pass])).toEqual([
      ["order-to-cash", "anon.1", "/|1440|light", false, "base", "reduce"],
      ["order-to-cash", "anon.1", "/login|1440|light", false, "base", "reduce"],
    ]);
    for (const s of screens) {
      const [shot] = s.shots;
      expect(shot).toEqual({ theme: "light", name: sha(s.key).slice(0, 32), key: s.key });
      const png = join(dir, "shots", `${shot.name}.png`);
      expect(mode(png)).toBe(0o600);
      expect(JSON.parse(readFileSync(join(dir, "shots", `${shot.name}.verdict.json`), "utf8")).sha256).toBe(sha(readFileSync(png) as unknown as string));
    }
    expect(tasteSpent(b.main, b.runId)).toBeGreaterThan(0);
    // The recorder's passes left the session as the explorer had it.
    const media = await runCli({ js: browserTools().cli.js, session: sessionName(b.runId, 1, "anon.1"), args: ["eval", "--", `() => ${MEDIA_READ}`], cwd: b.dir, home: b.home });
    expect(media.stdout).toContain('"colorScheme": "light"');
    expect(media.stdout).toContain('"reducedMotion": "no-preference"');
  }, 120_000);
});

describe("argus-live taste judge and confirm — lane 0's stubs (lane J replaces each)", () => {
  const cli = (main: string, ...args: string[]) => spawnSync(process.execPath, [ARGUS_LIVE, ...args], { cwd: main, encoding: "utf8" });
  it("taste judge [--run] reaches tasteJudge(main, {run}), a stub", async () => {
    await expect(tasteJudge("/nowhere", { run: null })).rejects.toThrow("refused: taste judge: not built yet");
    const main = committed();
    for (const args of [["taste", "judge"], ["taste", "judge", "--run", "20000101000000-0123abcd"]]) {
      expect(cli(main, ...args), args.join(" ")).toMatchObject({ status: 1, stdout: "", stderr: "refused: taste judge: not built yet\n" });
    }
  }, 30_000);

  it("taste confirm <row> reaches tasteConfirm(main, ref), a stub", async () => {
    await expect(tasteConfirm("/nowhere", "t1")).rejects.toThrow("refused: taste confirm: not built yet");
    expect(cli(committed(), "taste", "confirm", "t1")).toMatchObject({ status: 1, stdout: "", stderr: "refused: taste confirm: not built yet\n" });
  }, 30_000);
});
