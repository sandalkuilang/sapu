// tests/argus-live-browser.test.ts — the journey lane's browser side on a real Chrome-family browser
// through the pinned CLI: sessions recorded with their daemon and browser, isolated per account, and
// the network block in layers (the run's proxy, host-resolver rules, the WebRTC flag) proven in Chrome.
// A machine without Chrome or Edge fails here, never skips: the lane cannot run there either.
import { execFileSync, spawnSync } from "node:child_process";
import { createSocket } from "node:dgram";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createNetServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { alive, cleanTemps, freePort, liveRun, tempDir, until } from "./helpers/argus-live";
// @ts-expect-error — plain ESM script without types
import { ensureCli, findChrome, openSession, slotConfig, slotDir, writeSlotConfig } from "../plugins/sapu/scripts/argus-live-browser.mjs";
// @ts-expect-error — plain ESM script without types
import { closeSessions, runCli, socketsDir } from "../plugins/sapu/scripts/argus-live-cli.mjs";
// @ts-expect-error — plain ESM script without types
import { startEntry, waitHealth } from "../plugins/sapu/scripts/argus-live-instance.mjs";
// @ts-expect-error — plain ESM script without types
import { startTime } from "../plugins/sapu/scripts/argus-live-proc.mjs";
// @ts-expect-error — plain ESM script without types
import { blockedSince, startProxy } from "../plugins/sapu/scripts/argus-live-proxy.mjs";
// @ts-expect-error — plain ESM script without types
import { down, logsDir, readRun, updateRun, writeRunFiles } from "../plugins/sapu/scripts/argus-live-run.mjs";

type Obj = Record<string, any>;

const SERVER = join(__dirname, "fixtures/journey-app/server.mjs");
const PW = 'Pa"ss\\wo:rd &+1';

let cli: { dir: string; js: string };
let chrome: { channel: string; path: string };
beforeAll(() => {
  cli = ensureCli();
  const found = findChrome();
  if (!found) throw new Error(`no Chrome-family browser: install Google Chrome, or run: node ${cli.js} install-browser chrome`);
  chrome = found;
}, 600_000);

const saved = { ...process.env };
const runIds = new Set<string>();
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) {
    try {
      await c();
    } catch {
      // the next cleanup still runs
    }
  }
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  for (const [k, v] of Object.entries(saved)) if (process.env[k] !== v) process.env[k] = v;
  cleanTemps();
}, 60_000);

/** Listens on loopback; after the test every connection it holds is destroyed (a net.Server's close would wait for them) and it closes. */
const listen = <T extends Server | HttpServer>(s: T) => {
  const sockets = new Set<Socket>();
  s.on("connection", (c: Socket) => (sockets.add(c), c.once("close", () => sockets.delete(c))));
  return new Promise<number>((ok) =>
    s.listen(0, "127.0.0.1", () => {
      cleanups.push(() => new Promise((done) => (s.close(done), sockets.forEach((c) => c.destroy()))));
      ok((s.address() as { port: number }).port);
    }),
  );
};

/**
 * A run as `up` leaves it once step 9 ran: the lock, worktree and HOME, the fixture app on `web`
 * (started with startEntry and recorded), run.json with its origins and `allowOrigins`, the run's proxy,
 * and slot 1's directory with its CLI config. `down` runs after the test.
 */
const browserRun = async ({ allowOrigins = [] as string[] } = {}) => {
  process.env.TMPDIR = tempDir();
  const r = liveRun();
  runIds.add(r.runId);
  cleanups.push(() => down(r.main, { runId: r.runId, graceMs: 2000 }));
  const cache = await listen(createNetServer((c) => c.on("error", () => {})));
  const web = await freePort();
  const data = join(tempDir(), "app_explore");
  const appEnv = { PATH: process.env.PATH!, PORT: String(web), DATA_DIR: data, APP_PW: PW, APP_TOTP: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", CONTROL_TOKEN: "control-7", CACHE_URL: `tcp://127.0.0.1:${cache}` };
  expect(spawnSync(process.execPath, [SERVER, "--reset"], { env: appEnv }).status).toBe(0);
  const groups: Obj[] = [];
  const entry = { name: "web", cmd: `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(SERVER)}`, env: appEnv, health: { url: `http://127.0.0.1:${web}/health` } };
  await waitHealth(entry, await startEntry(entry, { worktree: r.wt, env: { PATH: process.env.PATH! }, logs: logsDir(r.main, r.runId), groups }), { timeoutS: 20, worktree: r.wt, env: {} });
  const origins = [`http://localhost:${web}`];
  writeRunFiles(r.main, { runId: r.runId, worktree: r.wt, origins, allowOrigins, groups, env: r.env, browser: { js: cli.js, channel: chrome.channel } });
  // As up's recording array: each group in run.json as soon as it is pushed.
  const recorded: Obj[] = [];
  recorded.push = (g: Obj) => (updateRun(r.main, r.runId, (prev: Obj) => ({ ...prev, groups: [...prev.groups, g] })), Array.prototype.push.call(recorded, g));
  const proxy = await startProxy(r.main, r.runId, { groups: recorded });
  const home = join(r.home, "browser");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const dir = slotDir(r.main, r.runId, 1);
  writeSlotConfig(dir, slotConfig({ dir, origins, allowOrigins, proxyPort: proxy.port, live: { locale: "en-US", timezone: "UTC" }, chrome }));
  const base = origins[0];
  const call = (session: string, ...args: string[]) => runCli({ js: cli.js, session, args, cwd: dir, home });
  /** The page's text, through the wrapper's own `eval` (never the explorer's). */
  const text = async (session: string) => (await call(session, "eval", "--", "() => document.body.innerText")).stdout;
  return { ...r, web, base, home, dir, proxy, appEnv, call, text, open: (account: string, storageState: string | null = null) => openSession({ main: r.main, runId: r.runId, slot: 1, account, js: cli.js, home, storageState }) };
};

describe("argus-live browser — sessions and network layers", () => {
  it("a session opens in the slot's workspace and is recorded with its daemon and its browser, each leading its own group", async () => {
    const b = await browserRun();
    const rec = await b.open("buyer.1");
    const stored = readRun(b.main).sessions;
    expect(stored).toEqual([rec]);
    expect(rec).toMatchObject({ name: `${b.runId}-1-buyer.1`, slot: 1, account: "buyer.1", cwd: b.dir, home: b.home });
    for (const p of [rec.daemon, rec.browser]) {
      expect(alive(p.pid)).toBe(true);
      expect(startTime(p.pid)).toBe(p.started);
      expect(p.pgid).toBe(p.pid);
    }
    const ps = execFileSync("ps", ["-ww", "-o", "command=", "-p", String(rec.daemon.pid)], { encoding: "utf8" });
    expect(ps).toContain(`cliDaemon.js ${rec.name}`);
    const page = await b.call(rec.name, "goto", "--", `${b.base}/`);
    expect(page.stdout).toContain(`- Page URL: ${b.base}/`);
    await closeSessions([rec], { js: cli.js, graceMs: 3000 });
    expect(await until(() => !alive(rec.daemon.pid) && !alive(rec.browser.pid), 5000)).toBe(true);
    // The CLI leaves its sockets behind; the run's teardown removes their directory.
    expect(readdirSync(socketsDir(b.home)).length).toBeGreaterThan(0);
    await down(b.main, { runId: b.runId, graceMs: 2000 });
    expect(existsSync(socketsDir(b.home))).toBe(false);
  }, 120_000);

  it("two sessions of one slot do not share cookies; a storage state signs one in and is not left on disk", async () => {
    const b = await browserRun();
    const state = JSON.parse(spawnSync(process.execPath, [SERVER, "--login-state", "buyer1@example.test"], { env: b.appEnv, encoding: "utf8" }).stdout);
    const file = join(b.dir, ".playwright", "buyer.1.state.json");
    writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
    const one = await b.open("buyer.1", file);
    const two = await b.open("buyer.2");
    expect(readFileSync(join(b.dir, ".playwright", "cli.config.json"), "utf8")).not.toContain("storageState");
    expect(() => readFileSync(file)).toThrow();
    await b.call(one.name, "goto", "--", `${b.base}/`);
    await b.call(two.name, "goto", "--", `${b.base}/`);
    expect(await b.text(one.name)).toContain("Account");
    expect(await b.text(two.name)).toContain("You are signed out.");
    expect(readRun(b.main).sessions.map((s: Obj) => s.account)).toEqual(["buyer.1", "buyer.2"]);
  }, 120_000);

  /**
   * The leak page (fetch, WebSocket and WebRTC to an outside host; fetch and WebSocket to another loopback
   * port; a fetch from an allowed origin) in a session of a run whose slot config keeps `layers` of the
   * network block (`allowedOrigins`, `hostRules`; the proxy is always there), against a loopback server
   * counting connections, a UDP socket counting STUN packets and an allowed server.
   */
  const leak = async (layers: { allowedOrigins: boolean; hostRules: boolean }) => {
    let otherHits = 0;
    const otherServer = createHttpServer((_q, res) => res.end("x"));
    otherServer.on("connection", () => (otherHits += 1));
    const other = await listen(otherServer);
    let udpPackets = 0;
    const udp = createSocket("udp4");
    udp.on("message", () => (udpPackets += 1));
    await new Promise<void>((ok) => udp.bind(0, "127.0.0.1", ok));
    cleanups.push(() => new Promise((done) => udp.close(() => done(undefined))));
    const allowedHits: string[] = [];
    const allow = await listen(
      createHttpServer((q, res) => {
        allowedHits.push(`${q.method} ${q.url}`);
        res.writeHead(200, { "content-type": "text/css", "access-control-allow-origin": "*" });
        res.end("body{}");
      }),
    );
    const allowed = `http://127.0.0.1:${allow}`;
    const b = await browserRun({ allowOrigins: [allowed] });
    const file = join(b.dir, ".playwright/cli.config.json");
    const cfg = JSON.parse(readFileSync(file, "utf8"));
    if (!layers.allowedOrigins) delete cfg.network;
    if (!layers.hostRules) cfg.browser.launchOptions.args = cfg.browser.launchOptions.args.filter((x: string) => !x.startsWith("--host-resolver-rules="));
    writeFileSync(file, JSON.stringify(cfg));
    const s = await b.open("anon.1");
    const page = `${b.base}/leak?other=${other}&udp=${udp.address().port}&allowed=${encodeURIComponent(allowed)}`;
    expect((await b.call(s.name, "goto", "--", page)).stdout).toContain("- Page URL:");
    const lines = async () => (await b.text(s.name)).replace(/\\n/g, "\n");
    expect(await until(() => allowedHits.includes("GET /font.css"), 15_000)).toBe(true);
    let results = "";
    for (let i = 0; i < 60 && (results.match(/: /g) ?? []).length < 6; i++) {
      results = await lines();
      await new Promise((ok) => setTimeout(ok, 250));
    }
    await new Promise((ok) => setTimeout(ok, 1500)); // a late attempt would show by now
    const blocked = blockedSince(b.main, b.runId, 0).origins as string[];
    return { results, blocked, otherHits, udpPackets, other, allowed, once: (o: string) => blocked.filter((x) => x === o).length };
  };

  it("outside fetch, WebSocket and WebRTC are blocked; loopback fetch and WebSocket to another port are blocked; allow_origins is honoured", async () => {
    const r = await leak({ allowedOrigins: true, hostRules: true });
    for (const what of ["outside fetch", "outside websocket", "loopback fetch", "loopback websocket"]) expect(r.results).toContain(`${what}: blocked`);
    expect(r.results).toContain("allowed fetch: 200");
    expect(r.results).toContain("webrtc: gathered");
    expect([r.otherHits, r.udpPackets]).toEqual([0, 0]);
    // network.allowedOrigins stops the outside host before the proxy; the proxy stops the loopback port, once logged.
    expect(r.once(`http://127.0.0.1:${r.other}`)).toBe(1);
    expect(r.blocked).not.toContain(r.allowed);
  }, 120_000);

  it("the proxy alone (no allowedOrigins, no host rules) blocks the outside host and the loopback port, each logged once", async () => {
    const r = await leak({ allowedOrigins: false, hostRules: false });
    for (const what of ["outside fetch", "outside websocket", "loopback fetch", "loopback websocket"]) expect(r.results).toContain(`${what}: blocked`);
    expect([r.otherHits, r.udpPackets]).toEqual([0, 0]);
    expect([r.once("http://outside.test"), r.once(`http://127.0.0.1:${r.other}`)]).toEqual([1, 1]);
    expect(r.blocked).not.toContain(r.allowed);
  }, 120_000);

  it("the signal script records a toast that is gone before anyone looks", async () => {
    const b = await browserRun();
    const state = JSON.parse(spawnSync(process.execPath, [SERVER, "--login-state", "buyer1@example.test"], { env: b.appEnv, encoding: "utf8" }).stdout);
    const file = join(b.dir, ".playwright", "buyer.1.state.json");
    writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
    const s = await b.open("buyer.1", file);
    await b.call(s.name, "goto", "--", `${b.base}/orders/new`);
    await b.call(s.name, "fill", "--", "getByLabel('Quantity')", "2");
    await b.call(s.name, "click", "--", "getByRole('button', { name: 'Place order' })");
    await new Promise((ok) => setTimeout(ok, 1500));
    expect(await b.text(s.name)).not.toContain("Order placed");
    const signals = (await b.call(s.name, "eval", "--", "() => JSON.stringify(window.__argusSignals)")).stdout;
    expect(signals).toContain("Order placed");
    expect(signals).toContain("status");
  }, 120_000);
});

/** No CLI daemon or browser of a run of this file outlives its test (whatever the test asserted): only this file's runs' sessions. */
afterEach(() => {
  const left = execFileSync("ps", ["-A", "-ww", "-o", "pid=", "-o", "command="], { encoding: "utf8" })
    .split("\n")
    .filter((l) => [...runIds].some((id) => l.includes(`cliDaemon.js ${id}-`) || l.includes(`-${id}.home/browser/`)));
  for (const l of left) {
    try {
      process.kill(-Number(l.trim().split(/\s+/)[0]), "SIGKILL"); // a daemon and Chrome's root each lead their group
    } catch {
      // gone
    }
  }
});
