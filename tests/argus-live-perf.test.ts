// tests/argus-live-perf.test.ts — `smoke run --perf` (spec §19.11): the in-page observers, a batch's medians, the
// per-journey baselines in .argus/perf.json, the regression rule and the perf issue's body. The statistic and the
// thresholds are tested with synthetic numbers (a loaded machine moves real ones); the live browser tests keep
// to loose bounds.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import vm from "node:vm";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { FIXTURE_CONTRACT } from "./fixture-contract";
import { appCycle, browserCleanup, browserLeftovers, browserTools, cleanTemps, committed, example, fixtureProcs, git, liveRun, makeShim, tempDir } from "./helpers/argus-live";
// @ts-expect-error — plain ESM script without types
import { SIGNAL_SCRIPT, slotDir } from "../plugins/sapu/scripts/argus-live-browser.mjs";
// @ts-expect-error — plain ESM script without types
import { expandConfig, loadLive } from "../plugins/sapu/scripts/argus-live-config.mjs";
// @ts-expect-error — plain ESM script without types
import { activeSink, batchMedians, collecting, confirmedRegressions, median, newSink, PERF_SCRIPT, perfCode, perfIssue, perfRebaseline, readPerf, recordDocs, regressions, runMetrics } from "../plugins/sapu/scripts/argus-live-perf.mjs";
// @ts-expect-error — plain ESM script without types
import { down, readRun, writeRunFiles } from "../plugins/sapu/scripts/argus-live-run.mjs";
// @ts-expect-error — plain ESM script without types
import { sessionDriver } from "../plugins/sapu/scripts/argus-live-session.mjs";
// @ts-expect-error — plain ESM script without types
import { seededOrder, smokeRun } from "../plugins/sapu/scripts/argus-live-smoke.mjs";

type Obj = Record<string, any>;

afterEach(cleanTemps);

// ---------------------------------------------------------------------------------------------------
// The in-page script, run in a vm with a stand-in page: synthetic entries, so the answers are exact.

/** A stand-in page: `install()` runs PERF_SCRIPT in it; `emit` delivers entries to the observers of a type. */
const standIn = (opts: { hidden?: boolean } = {}) => {
  const observers: Obj[] = [];
  const queued: Record<string, Obj[]> = {};
  class PO {
    cb: (l: Obj) => void;
    type = "";
    opts: Obj = {};
    constructor(cb: (l: Obj) => void) {
      this.cb = cb;
    }
    observe(o: Obj) {
      this.opts = o;
      this.type = o.type;
      observers.push(this);
    }
    takeRecords() {
      const q = queued[this.type] ?? [];
      queued[this.type] = [];
      return q;
    }
  }
  const listeners: Record<string, (() => void)[]> = {};
  const doc: Obj = { visibilityState: opts.hidden ? "hidden" : "visible", addEventListener: (t: string, f: () => void) => (listeners[t] ??= []).push(f) };
  const nav: Obj[] = [{ transferSize: 700 }];
  const res: Obj[] = [];
  const clock = { now: 5000 };
  const win: Obj = {
    document: doc,
    PerformanceObserver: PO,
    performance: { now: () => clock.now, getEntriesByType: (t: string) => (t === "navigation" ? nav : t === "resource" ? res : []), setResourceTimingBufferSize: () => {} },
    setTimeout,
  };
  const ctx = vm.createContext(win);
  return {
    doc,
    nav,
    res,
    clock,
    observers,
    install: () => vm.runInContext(PERF_SCRIPT, ctx),
    emit: (type: string, entries: Obj[]) => observers.filter((o) => o.type === type).forEach((o) => o.cb({ getEntries: () => entries })),
    queue: (type: string, entries: Obj[]) => (queued[type] = [...(queued[type] ?? []), ...entries]),
    hide: () => {
      doc.visibilityState = "hidden";
      (listeners.visibilitychange ?? []).forEach((f) => f());
    },
    snap: async () => JSON.parse(JSON.stringify(await doc.__argusPerf.snap(0))),
  };
};

describe("PERF_SCRIPT — the observers (spec §19.11)", () => {
  it("watches LCP, layout shifts and events (durationThreshold 16) from the buffer", () => {
    const p = standIn();
    p.install();
    expect(p.observers.map((o) => [o.type, o.opts])).toEqual([
      ["largest-contentful-paint", { type: "largest-contentful-paint", buffered: true }],
      ["layout-shift", { type: "layout-shift", buffered: true }],
      ["event", { type: "event", buffered: true, durationThreshold: 16 }],
    ]);
  });

  it("LCP is the largest candidate of the document; a candidate after the page went to the background is ignored", async () => {
    const p = standIn();
    p.install();
    p.emit("largest-contentful-paint", [{ startTime: 800 }, { startTime: 1300 }]);
    p.emit("largest-contentful-paint", [{ startTime: 1100 }]);
    expect((await p.snap()).lcp).toBe(1300);
    p.clock.now = 2000;
    p.hide();
    p.emit("largest-contentful-paint", [{ startTime: 4000 }]);
    expect((await p.snap()).lcp).toBe(1300);
    // A document that began in the background has no LCP worth reading.
    const b = standIn({ hidden: true });
    b.install();
    b.emit("largest-contentful-paint", [{ startTime: 900 }]);
    expect((await b.snap()).lcp).toBe(0);
  });

  it("CLS is the largest session window: gaps under 1 s, at most 5 s long, shifts after recent input skipped", async () => {
    const p = standIn();
    p.install();
    p.emit("layout-shift", [
      { startTime: 0, value: 0.1 },
      { startTime: 900, value: 0.1 },
      { startTime: 1800, value: 0.1 },
      { startTime: 2700, value: 0.1 },
      { startTime: 3600, value: 0.1 },
      { startTime: 4500, value: 0.1 },
    ]);
    // 5400 is 5.4 s after the window's first shift: a new window starts.
    p.emit("layout-shift", [{ startTime: 5400, value: 0.1 }, { startTime: 5500, value: 0.5, hadRecentInput: true }]);
    expect((await p.snap()).cls).toBe(0.6);
    // A gap of a second or more starts a window too; a smaller one does not outweigh the largest.
    p.emit("layout-shift", [{ startTime: 9000, value: 0.2 }]);
    expect((await p.snap()).cls).toBe(0.6);
  });

  it("INP is the worst interaction: events grouped by interactionId, those without one ignored, queued entries read at the snapshot", async () => {
    const p = standIn();
    p.install();
    p.emit("event", [
      { interactionId: 0, duration: 400 },
      { interactionId: 7, duration: 48 },
      { interactionId: 7, duration: 120 },
      { interactionId: 9, duration: 64 },
    ]);
    expect((await p.snap()).inp).toBe(120);
    p.queue("event", [{ interactionId: 11, duration: 232 }]);
    expect((await p.snap()).inp).toBe(232);
  });

  it("counts the navigation and resource entries, and sums their transfer sizes", async () => {
    const p = standIn();
    p.install();
    p.res.push({ transferSize: 1000 }, { transferSize: 0 }, { transferSize: 2300 });
    expect(await p.snap()).toMatchObject({ requests: 4, bytes: 4000 });
  });

  it("installs once per document, and a new document installs again", async () => {
    const p = standIn();
    p.install();
    p.install();
    expect(p.observers).toHaveLength(3);
    const first = (await p.snap()).doc;
    expect(first).toMatch(/^[a-z0-9]{6,40}$/);
    delete p.doc.__argusPerf;
    p.install();
    expect(p.observers).toHaveLength(6);
    expect((await p.snap()).doc).not.toBe(first);
  });

  it("answers zeros for what was not seen, and rounds", async () => {
    const p = standIn();
    p.install();
    expect(await p.snap()).toMatchObject({ lcp: 0, cls: 0, inp: 0, requests: 1, bytes: 700 });
    p.emit("largest-contentful-paint", [{ startTime: 812.6 }]);
    p.emit("layout-shift", [{ startTime: 1, value: 0.123456 }]);
    expect(await p.snap()).toMatchObject({ lcp: 813, cls: 0.1235 });
  });
});

describe("perfCode — the snapshot a step is wrapped by", () => {
  const parses = (code: string) => expect(() => new vm.Script(`(${code})`)).not.toThrow();
  it("waits for load first when asked, installs the script, and settles before it reads", () => {
    const before = perfCode({ wait: true, waitMs: 7000 });
    const after = perfCode({ wait: false, settle: 50 });
    parses(before);
    parses(after);
    expect(before).toContain('waitForLoadState("load", { timeout: 7000 })');
    expect(after).not.toContain("waitForLoadState");
    expect(after).toContain('"settle":50');
    for (const code of [before, after]) expect(code).toContain(JSON.stringify(PERF_SCRIPT));
  });
});

// ---------------------------------------------------------------------------------------------------
// The statistic and the thresholds, on synthetic numbers.

const THRESHOLDS = { lcp_ms: [0.2, 250], inp_ms: [0.25, 50], cls: [0.25, 0.05], duration_ms: [0.2, 500], requests: [0.2, 5], bytes: [0.2, 102400] };
const M = (over: Obj = {}): Obj => ({ lcp_ms: 1000, inp_ms: 100, cls: 0.02, duration_ms: 4000, requests: 20, bytes: 500000, ...over });

describe("medians and regressions", () => {
  it("median: the middle of an odd count, the mean of the middle two of an even one, any order", () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([7])).toBe(7);
    expect(median([9, 1, 1, 1, 100])).toBe(1);
  });

  it("a batch takes each metric's median over its runs, rounded", () => {
    const runs = [M({ lcp_ms: 900, cls: 0.1 }), M({ lcp_ms: 1100, cls: 0.0123 }), M({ lcp_ms: 5000, cls: 0.04 }), M({ lcp_ms: 950.4, cls: 0.0123456 }), M({ lcp_ms: 1000, cls: 0 })];
    expect(batchMedians(runs)).toEqual(M({ lcp_ms: 1000, cls: 0.0123 }));
    expect(batchMedians([M({ lcp_ms: 1000 }), M({ lcp_ms: 1001 })]).lcp_ms).toBe(1001);
  });

  it("a metric regresses when it exceeds the baseline by more than both the relative and the absolute threshold", () => {
    const base = M();
    // lcp: 20% of 1000 is 200, the absolute 250: 1240 passes the first and not the second.
    expect(regressions(base, M({ lcp_ms: 1240 }), THRESHOLDS)).toEqual([]);
    expect(regressions(base, M({ lcp_ms: 1250 }), THRESHOLDS)).toEqual([]);
    expect(regressions(base, M({ lcp_ms: 1251 }), THRESHOLDS)).toEqual([{ metric: "lcp_ms", baseline: 1000, value: 1251 }]);
    // requests: 20% of 20 is 4, the absolute 5.
    expect(regressions(base, M({ requests: 25 }), THRESHOLDS)).toEqual([]);
    expect(regressions(base, M({ requests: 26 }), THRESHOLDS)).toEqual([{ metric: "requests", baseline: 20, value: 26 }]);
    // A baseline of zero: only the absolute threshold bites.
    expect(regressions(M({ cls: 0 }), M({ cls: 0.05 }), THRESHOLDS)).toEqual([]);
    expect(regressions(M({ cls: 0 }), M({ cls: 0.06 }), THRESHOLDS)).toEqual([{ metric: "cls", baseline: 0, value: 0.06 }]);
    // Faster is never a regression.
    expect(regressions(base, M({ lcp_ms: 10, bytes: 1, duration_ms: 1 }), THRESHOLDS)).toEqual([]);
  });

  it("a threshold the owner set replaces the default for its metric", () => {
    const tight = { ...THRESHOLDS, lcp_ms: [0.05, 10] };
    expect(regressions(M(), M({ lcp_ms: 1100 }), tight)).toEqual([{ metric: "lcp_ms", baseline: 1000, value: 1100 }]);
  });

  it("a regression counts only when every batch has it", () => {
    const base = M();
    const a = M({ lcp_ms: 1600, bytes: 900000 });
    const b = M({ lcp_ms: 1700, bytes: 520000 });
    expect(confirmedRegressions(base, [a, b], THRESHOLDS)).toEqual([{ metric: "lcp_ms", baseline: 1000, values: [1600, 1700] }]);
    expect(confirmedRegressions(base, [a], THRESHOLDS).map((r: Obj) => r.metric)).toEqual(["lcp_ms", "bytes"]);
    expect(confirmedRegressions(base, [a, M()], THRESHOLDS)).toEqual([]);
  });
});

describe("a run's metrics from the documents it measured", () => {
  const doc = (over: Obj = {}) => ({ doc: "d1", lcp: 800, cls: 0.01, inp: 60, requests: 10, bytes: 1000, ...over });
  it("the largest LCP, CLS and INP of the documents; requests and bytes summed; the steps' time", () => {
    const s = newSink();
    recordDocs(s, "customer.1", { docs: [doc(), doc({ doc: "d2", lcp: 1500, cls: 0.2, inp: 30, requests: 5, bytes: 400 })], ua: "" });
    recordDocs(s, "sales.1", { docs: [doc({ doc: "d1", lcp: 300, requests: 3, bytes: 90 })], ua: "" });
    s.ms = 3210;
    expect(runMetrics(s)).toEqual({ lcp_ms: 1500, inp_ms: 60, cls: 0.2, duration_ms: 3210, requests: 18, bytes: 1490 });
  });

  it("a document seen again keeps its newest snapshot, not a sum", () => {
    const s = newSink();
    recordDocs(s, "customer.1", { docs: [doc({ requests: 4, bytes: 100 })], ua: "" });
    recordDocs(s, "customer.1", { docs: [doc({ requests: 9, bytes: 700, lcp: 900 })], ua: "" });
    expect(runMetrics(s)).toMatchObject({ lcp_ms: 900, requests: 9, bytes: 700 });
  });

  it("takes numbers only: a page that answers anything else is ignored, never stored", () => {
    const s = newSink();
    recordDocs(s, "customer.1", {
      docs: [doc({ doc: "x y" }), doc({ doc: "ok", lcp: "9" }), doc({ doc: "ok2", lcp: -5 }), doc({ doc: "ok3", requests: 1e30 }), null, "x", { doc: "ok4" }],
      ua: "Mozilla/5.0 Chrome/147.0.7727.55 Safari/537.36",
    });
    expect([...s.docs.keys()]).toEqual([]);
    expect(s.chrome).toBe("147.0.7727.55");
    const t = newSink();
    recordDocs(t, "a", { docs: [], ua: "Chrome/1.2.3.4; rm -rf" });
    expect(t.chrome).toBe("1.2.3.4");
    const u = newSink();
    recordDocs(u, "a", { docs: [], ua: "no browser here" });
    expect(u.chrome).toBe("");
  });

  it("collecting makes a sink the active one, and restores the one before it", async () => {
    expect(activeSink()).toBeNull();
    const a = newSink();
    const b = newSink();
    await collecting(a, async () => {
      expect(activeSink()).toBe(a);
      await collecting(b, async () => expect(activeSink()).toBe(b));
      expect(activeSink()).toBe(a);
    });
    expect(activeSink()).toBeNull();
    await expect(collecting(a, async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    expect(activeSink()).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------
// The session hook and the measured step.

describe("the session driver in a perf pass", () => {
  const runs: { main: string; runId: string }[] = [];
  afterEach(async () => {
    for (const r of runs.splice(0)) await down(r.main, { runId: r.runId, graceMs: 1000 }).catch(() => {});
  });
  const PORTS = { api: 41001, web: 41002, pg: 41003, redis: 41004, smtp: 41005 };
  const driverRun = () => {
    const t = liveRun();
    const c = example();
    c.roles = { anon: {}, buyer: { users: [{ user: "buyer1@example.test", password: "${PW}" }] } };
    writeFileSync(join(t.main, ".argus/live.json"), `${JSON.stringify(c, null, 2)}\n`);
    writeFileSync(join(t.main, ".argus/live.env"), "PW=pw-1\nSALES_TOTP=GEZDGNBVGY3TQOJQ\nDB_PW=db-now\n");
    const { shim, calls, queue } = makeShim();
    const js = join(tempDir(), "cli.mjs");
    writeFileSync(
      js,
      `import { spawn } from "node:child_process";
const argv = process.argv.slice(2);
const cmd = argv.find((a) => !a.startsWith("-"));
const session = (argv.find((a) => a.startsWith("-s=")) ?? "").slice(3);
if (cmd === "open") spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "/stand-in/cliDaemon.js", session], { detached: true, stdio: "ignore" }).unref();
await import(${JSON.stringify(shim)});
`,
    );
    writeRunFiles(t.main, { runId: t.runId, worktree: t.wt, home: t.home, origins: ["http://localhost:41001", "http://localhost:41002"], allowOrigins: [], groups: [], env: { ...t.env }, ports: PORTS, instanceId: "0123456789abcdef", browser: { js, channel: "chrome" } });
    runs.push({ main: t.main, runId: t.runId });
    const dir = slotDir(t.main, t.runId, 1);
    mkdirSync(join(dir, ".playwright"), { recursive: true, mode: 0o700 });
    mkdirSync(join(t.home, "browser"), { recursive: true, mode: 0o700 });
    const { config, secrets } = loadLive(t.main);
    const live = expandConfig(config, { ports: { ...PORTS }, secrets });
    const driver = () => sessionDriver({ main: t.main, runId: t.runId, slot: 1, account: "buyer.1", rec: readRun(t.main), live, envSecrets: secrets, slotRec: { journey: "x", accounts: { "buyer.1": "buyer1@example.test" } }, dir, js });
    const runCodes = () => calls().filter((x) => x.argv.includes("run-code"));
    return { ...t, calls, queue, driver, runCodes };
  };
  const hookPayload = (code: string) => JSON.parse(/const P = (.*);\n/.exec(code)![1]);

  it("the hook installs the perf script beside the signal script, and only in a perf pass", async () => {
    const plain = driverRun();
    await plain.driver().ensure();
    expect(hookPayload(plain.runCodes()[0].code).signals).toBe(SIGNAL_SCRIPT);
    const t = driverRun();
    await collecting(newSink(), () => t.driver().ensure());
    const { signals } = hookPayload(t.runCodes()[0].code);
    expect(signals).toBe(`${SIGNAL_SCRIPT};\n${PERF_SCRIPT}`);
    expect(() => new vm.Script(signals)).not.toThrow();
  }, 60_000);

  it("a step is wrapped by a snapshot after load and one after the step; its time is the step's alone", async () => {
    const t = driverRun();
    const sink = newSink();
    const d = await collecting(sink, async () => t.driver());
    const before = { docs: [{ doc: "aa11", lcp: 700, cls: 0, inp: 0, requests: 3, bytes: 300 }], ua: "Chrome/147.0.7727.55" };
    const after = { docs: [{ doc: "bb22", lcp: 1200, cls: 0.01, inp: 90, requests: 6, bytes: 900 }], ua: "Chrome/147.0.7727.55" };
    t.queue(before, { ok: true, answer: 1 }, after);
    const code = "async page => ({ ok: true })";
    expect(await d.code(code, 30_000)).toEqual({ ok: true, answer: 1 });
    const sent = t.runCodes().map((x) => x.code);
    expect(sent).toHaveLength(3);
    expect(sent[0]).toContain("waitForLoadState");
    expect(sent[1]).toBe(code);
    expect(sent[2]).not.toContain("waitForLoadState");
    expect(runMetrics(sink)).toMatchObject({ lcp_ms: 1200, inp_ms: 90, requests: 9, bytes: 1200 });
    expect(sink.steps).toBe(1);
    expect(sink.ms).toBeGreaterThanOrEqual(0);
    expect(sink.chrome).toBe("147.0.7727.55");
  }, 60_000);

  it("outside a perf pass d.code is one call, and the login stages are never measured", async () => {
    const t = driverRun();
    const d = t.driver();
    t.queue({ ok: true });
    expect(await d.code("async page => ({ ok: true })")).toEqual({ ok: true });
    expect(t.runCodes()).toHaveLength(1);
    const sink = newSink();
    const m = await collecting(sink, async () => t.driver());
    t.queue({ signals: [], loggedIn: null, url: "x", aria: "", tabs: 1, secrets: {} });
    await m.observe();
    expect(t.runCodes()).toHaveLength(2);
    expect(sink.steps).toBe(0);
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------------
// The pass: batches, baselines, regressions.

const pathLive = (): Obj => ({
  ...example(),
  test_id_attribute: "data-testid",
  triggers: { ...example().triggers, "seed-stock": { argv: ["npm", "run", "-s", "explore:seed", "--", "{1}"], args: ["^[A-Za-z0-9-]{1,64}$"], seed: true } },
});
const PATH = (): Obj[] => [
  { context: { viewport: 1440 } },
  { as: "customer", do: "goto", path: "/orders/new" },
  { as: "customer", do: "fill", target: { label: "Quantity" }, value: "2" },
  { as: "customer", do: "click", target: { role: "button", name: "Place order" } },
  { as: "customer", do: "read", target: { testId: "order-number" }, save: "order" },
  { as: "customer", expect: "visible", target: { text: "{{order}}" } },
];
const CHROME = "Mozilla/5.0 (X11; Linux x86_64) Chrome/147.0.7727.55 Safari/537.36";

describe("smoke run --perf (spec §19.11)", () => {
  const live: { main: string; runId: string }[] = [];
  afterEach(async () => {
    for (const r of live.splice(0)) await down(r.main, { runId: r.runId, graceMs: 1000 }).catch(() => {});
  });
  /** A live cycle whose repo holds the suite's `paths`, and smoke.json with `perf.runs` 2 (three runs a batch). */
  const suiteRun = (paths: Record<string, Obj[]>, { slots = {} as Obj, smoke = { perf: { runs: 2 } } as Obj } = {}) => {
    const t = liveRun();
    writeFileSync(join(t.main, ".argus/live.json"), `${JSON.stringify(pathLive(), null, 2)}\n`);
    writeFileSync(join(t.main, ".argus/live.env"), "PW=pw-1\nSALES_TOTP=GEZDGNBVGY3TQOJQ\nDB_PW=db-now\n");
    writeFileSync(join(t.main, ".argus/smoke.json"), `${JSON.stringify(smoke)}\n`);
    const ports = { api: 41001, web: 41002, pg: 41003, redis: 41004, smtp: 41005 };
    writeRunFiles(t.main, { runId: t.runId, worktree: t.wt, home: t.home, origins: ["http://localhost:41002"], allowOrigins: [], groups: [], env: t.env, ports, instanceId: "0123456789abcdef", slots, internal: { proxy: 41009 }, browser: { channel: "chrome" } });
    live.push({ main: t.main, runId: t.runId });
    const dir = join(t.main, "e2e/argus-smoke/journeys");
    mkdirSync(dir, { recursive: true });
    for (const [id, path] of Object.entries(paths)) writeFileSync(join(dir, `${id}.json`), `${JSON.stringify({ journey: id, path })}\n`);
    return t;
  };
  /**
   * A runOnce stand-in that measures like a session would: each call feeds the active sink the metrics
   * `levels(id, call)` gives (call counts from 1 per path), with the Chrome version `ua`.
   */
  const stub = (levels: (id: string, call: number) => Obj | number, { ua = CHROME } = {}) => {
    const calls: Obj[] = [];
    const once = async (_main: string, _ref: string | null, opts: Obj) => {
      calls.push(opts);
      const id = opts.path.id;
      const k = calls.filter((c) => c.path.id === id).length;
      const v = levels(id, k);
      if (typeof v === "number") return { code: v, lines: [v === 3 ? "PATH broke step=3 kind=target-missing" : "HARNESS: step 2 system trigger exited 1"], result: {} };
      const sink = activeSink();
      recordDocs(sink, "customer.1", { docs: [{ doc: "d1", lcp: v.lcp_ms, cls: v.cls, inp: v.inp_ms, requests: v.requests, bytes: v.bytes }], ua });
      sink.ms = v.duration_ms;
      sink.steps = 5;
      return { code: 0, lines: [opts.dirty ? "dirty: instance x" : "fresh: instance x", "PATH held"], result: {} };
    };
    return { once, calls };
  };
  const perf = (t: { main: string }, o: Obj, s: ReturnType<typeof stub>) => smokeRun(t.main, { ids: null, slot: null, perf: true, seed: 1, ...o }, { once: s.once });
  const store = (t: { main: string }) => JSON.parse(readFileSync(join(t.main, ".argus/perf.json"), "utf8"));

  it("a batch is one warm-up run after up --fresh, then perf.runs dirty runs; the first batch is the baseline", async () => {
    const t = suiteRun({ checkout: PATH() });
    const s = stub((_id, k) => M({ lcp_ms: [0, 9000, 1000, 1100][k] ?? 1000, bytes: 500000 + k }));
    const r = await perf(t, {}, s);
    expect(r.code).toBe(0);
    expect(s.calls.map((c) => c.dirty)).toEqual([false, true, true]);
    expect(s.calls[0].path).toEqual({ id: "checkout", list: PATH() });
    // The warm-up (call 1) is left out; the median of the two kept runs is what the baseline holds.
    const e = store(t).checkout;
    expect(e).toMatchObject({ n: 2, medians: M({ lcp_ms: 1050, bytes: 500003 }) });
    expect(e.pathSha).toMatch(/^[0-9a-f]{64}$/);
    expect(e.head).toBe(git(t.wt, "rev-parse", "HEAD"));
    expect(e.machine).toMatchObject({ chrome: "147.0.7727.55", platform: expect.stringMatching(/^[a-z0-9]+-[a-z0-9_]+$/), cores: expect.any(Number), mem_gb: expect.any(Number), cpu: expect.any(String) });
    expect(e.latest).toMatchObject({ pathSha: e.pathSha, head: e.head, n: 2, regressed: [] });
    expect(e.latest.batches).toHaveLength(1);
    expect(statSync(join(t.main, ".argus/perf.json")).mode & 0o777).toBe(0o600);
    expect(r.lines[0]).toBe("seed: 1");
    expect(r.lines[1]).toMatch(/^perf checkout: baseline set \(first batch\), 2 runs: lcp_ms=1050 /);
    expect(r.lines.at(-1)).toBe("smoke run --perf: 1 baselined, 0 ok, 0 regressed, 0 flaky, 0 not measured");
  });

  it("the report line shows web.dev's good values as lab context, never as a verdict", async () => {
    const t = suiteRun({ checkout: PATH() });
    const r = await perf(t, {}, stub(() => M({ lcp_ms: 9000, inp_ms: 900, cls: 0.9 })));
    const line = r.lines[1];
    expect(line).toContain("lcp_ms=9000 (lab context: good 2500)");
    expect(line).toContain("inp_ms=900 (lab context: good 200)");
    expect(line).toContain("cls=0.9 (lab context: good 0.1)");
    expect(line).not.toMatch(/duration_ms=\d+ \(lab/);
    expect(r.code).toBe(0);
  });

  it("within the thresholds the second pass is ok and moves nothing but the newest batch", async () => {
    const t = suiteRun({ checkout: PATH() });
    await perf(t, {}, stub(() => M()));
    const before = store(t).checkout;
    const s = stub(() => M({ lcp_ms: 1100, requests: 22 }));
    const r = await perf(t, {}, s);
    expect(r.code).toBe(0);
    expect(s.calls).toHaveLength(3);
    expect(r.lines[1]).toMatch(/^perf checkout: ok, 2 runs: lcp_ms=1100 /);
    const e = store(t).checkout;
    expect({ ...e, latest: null }).toEqual({ ...before, latest: null });
    expect(e.latest.batches).toEqual([M({ lcp_ms: 1100, requests: 22 })]);
  });

  it("a regression is confirmed by a second batch after up --fresh: both batches regress → regressed, exit 3", async () => {
    const t = suiteRun({ checkout: PATH() });
    await perf(t, {}, stub(() => M()));
    const s = stub((_id, k) => M({ lcp_ms: k <= 3 ? 1600 : 1700 }));
    const r = await perf(t, {}, s);
    expect(r.code).toBe(3);
    // Two batches, each starting on a fresh instance.
    expect(s.calls.map((c) => c.dirty)).toEqual([false, true, true, false, true, true]);
    expect(r.lines[1]).toBe("perf checkout: regressed lcp_ms 1000 -> 1600, 1700 (more than 20% and 250 ms)");
    expect(r.lines.at(-1)).toBe("smoke run --perf: 0 baselined, 0 ok, 1 regressed, 0 flaky, 0 not measured");
    const e = store(t).checkout;
    expect(e.medians).toEqual(M());
    expect(e.latest.batches).toEqual([M({ lcp_ms: 1600 }), M({ lcp_ms: 1700 })]);
    expect(e.latest.regressed).toEqual([{ metric: "lcp_ms", baseline: 1000, values: [1600, 1700] }]);
  });

  it("a regression the second batch does not repeat is a flake: exit 0, nothing filed", async () => {
    const t = suiteRun({ checkout: PATH() });
    await perf(t, {}, stub(() => M()));
    const r = await perf(t, {}, stub((_id, k) => M({ lcp_ms: k <= 3 ? 1600 : 1010 })));
    expect(r.code).toBe(0);
    expect(r.lines[1]).toBe("perf checkout: flaky lcp_ms 1000 -> 1600, 1010 (the second batch was within the thresholds)");
    expect(r.lines.at(-1)).toBe("smoke run --perf: 0 baselined, 0 ok, 0 regressed, 1 flaky, 0 not measured");
    expect(store(t).checkout.latest.regressed).toEqual([]);
  });

  it("a changed path or machine voids the baseline: this batch becomes the new one", async () => {
    const t = suiteRun({ checkout: PATH() });
    await perf(t, {}, stub(() => M()));
    // Another Chrome: the machine differs.
    const a = await perf(t, {}, stub(() => M({ lcp_ms: 5000 }), { ua: CHROME.replace("147", "148") }));
    expect(a.code).toBe(0);
    expect(a.lines[1]).toMatch(/^perf checkout: baseline set \(the machine changed\), 2 runs: lcp_ms=5000 /);
    expect(store(t).checkout.machine.chrome).toBe("148.0.7727.55");
    // Another path: its digest differs.
    const changed = PATH();
    (changed[2] as Obj).value = "3";
    writeFileSync(join(t.main, "e2e/argus-smoke/journeys/checkout.json"), `${JSON.stringify({ journey: "checkout", path: changed })}\n`);
    const before = store(t).checkout.pathSha;
    const b = await perf(t, {}, stub(() => M({ lcp_ms: 1 }), { ua: CHROME.replace("147", "148") }));
    expect(b.lines[1]).toMatch(/^perf checkout: baseline set \(the path changed\), 2 runs: lcp_ms=1 /);
    expect(store(t).checkout.pathSha).not.toBe(before);
    expect(b.code).toBe(0);
  });

  it("each path in the order the seed shuffles; --ids picks; a path that broke or the harness failed is not measured", async () => {
    const t = suiteRun({ checkout: PATH(), refund: PATH(), returns: PATH(), lost: PATH() });
    const s = stub((id) => (id === "refund" ? 3 : id === "lost" ? 2 : M()));
    const r = await perf(t, { seed: 5 }, s);
    expect([...new Set(s.calls.map((c) => c.path.id))]).toEqual(seededOrder(["checkout", "lost", "refund", "returns"], 5));
    expect(r.code).toBe(3);
    expect(r.lines).toContain("perf refund: not measured (path broke step=3 kind=target-missing)");
    expect(r.lines).toContain("perf lost: not measured (harness: step 2 system trigger exited 1)");
    expect(r.lines.at(-1)).toBe("smoke run --perf: 2 baselined, 0 ok, 0 regressed, 0 flaky, 2 not measured");
    expect(Object.keys(store(t)).sort()).toEqual(["checkout", "returns"]);
    // A path that stops at the harness gives exit 2 when nothing broke.
    const u = suiteRun({ lost: PATH() });
    expect((await perf(u, {}, stub(() => 2))).code).toBe(2);
    // --ids
    const v = stub(() => M());
    await perf(t, { ids: ["returns"] }, v);
    expect([...new Set(v.calls.map((c) => c.path.id))]).toEqual(["returns"]);
  });

  it("a run that measured no document is not measured, and writes no baseline", async () => {
    const t = suiteRun({ checkout: PATH() });
    const s = { calls: [] as Obj[], once: async () => ({ code: 0, lines: ["PATH held"], result: {} }) };
    const r = await perf(t, {}, s as any);
    expect(r.lines).toContain("perf checkout: not measured (no document was measured)");
    expect(existsSync(join(t.main, ".argus/perf.json"))).toBe(false);
  });

  it("is refused while another slot of the run is live, with --slot, and before any run", async () => {
    const live1 = { journey: "x", generation: 1, tokenHash: "a".repeat(64), accounts: {}, retired: [], submitted: false };
    const done = { journey: "y", generation: 1, tokenHash: null, accounts: {}, retired: [], submitted: true };
    const t = suiteRun({ checkout: PATH() }, { slots: { "1": live1, "2": { ...live1, journey: "z" }, "3": done } });
    const s = stub(() => M());
    await expect(perf(t, {}, s)).rejects.toThrow("refused: smoke run --perf: 2 other slot(s) live");
    await expect(perf(suiteRun({ checkout: PATH() }, { slots: { "3": done } }), { slot: 4 }, s)).rejects.toThrow("refused: smoke run --perf: it writes no regression, so it takes no --slot");
    expect(s.calls).toEqual([]);
    expect(existsSync(join(t.main, ".argus/perf.json"))).toBe(false);
    // A slot with no token left (submitted) does not count.
    expect((await perf(suiteRun({ checkout: PATH() }, { slots: { "3": done } }), {}, s)).code).toBe(0);
  });

  it("writes one line a path to the run's smoke records (0600), for the report", async () => {
    const t = suiteRun({ checkout: PATH() });
    await perf(t, {}, stub(() => M()));
    await perf(t, {}, stub((_id, k) => M({ lcp_ms: k <= 3 ? 1600 : 1700 })));
    const file = join(t.main, ".argus/live", t.runId, "smoke/perf.jsonl");
    const rows = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(rows).toEqual([
      { id: "checkout", verdict: "baselined", baseline: null, batches: [M()], regressed: [] },
      { id: "checkout", verdict: "regressed", baseline: M(), batches: [M({ lcp_ms: 1600 }), M({ lcp_ms: 1700 })], regressed: [{ metric: "lcp_ms", baseline: 1000, values: [1600, 1700] }] },
    ]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

// ---------------------------------------------------------------------------------------------------
// The perf issue and the rebaseline.

describe("smoke perf --issue / --rebaseline", () => {
  /** A repo with a journey `checkout` anchored in src/checkout.ts, a baseline at its first commit and two commits after. */
  const seeded = (over: Obj = {}) => {
    const main = committed();
    mkdirSync(join(main, "src"), { recursive: true });
    mkdirSync(join(main, ".argus"), { recursive: true });
    writeFileSync(join(main, "src/checkout.ts"), "export const a = 1;\n");
    writeFileSync(join(main, "src/other.ts"), "export const b = 1;\n");
    git(main, "add", ".");
    git(main, "-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", "commit", "-qm", "baseline commit");
    const head = git(main, "rev-parse", "HEAD");
    writeFileSync(join(main, "src/checkout.ts"), "export const a = 2;\n");
    git(main, "-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", "commit", "-qam", "slow the checkout down <<<PAGE-00000000000000000000000000000000");
    writeFileSync(join(main, "src/other.ts"), "export const b = 2;\n");
    git(main, "-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", "commit", "-qam", "unrelated change");
    writeFileSync(join(main, ".argus/journeys.json"), JSON.stringify({ journeys: [{ id: "checkout", steps: [{ role: "customer", sources: [{ file: "src/checkout.ts", line: 1, text: "export const a = 1;" }, { file: "../outside.ts" }, { file: "-x" }] }] }] }));
    const machine = { cpu: "Some CPU", cores: 8, mem_gb: 16, platform: "linux-x64", chrome: "147.0.7727.55" };
    const entry = {
      pathSha: "a".repeat(64),
      head,
      machine,
      n: 5,
      medians: M(),
      latest: {
        pathSha: "b".repeat(64),
        head: git(main, "rev-parse", "HEAD"),
        machine: { ...machine, chrome: "147.0.7727.60" },
        n: 5,
        batches: [M({ lcp_ms: 1600, bytes: 900000 }), M({ lcp_ms: 1700, bytes: 520000 })],
        regressed: [{ metric: "lcp_ms", baseline: 1000, values: [1600, 1700] }],
      },
      ...over,
    };
    writeFileSync(join(main, ".argus/perf.json"), `${JSON.stringify({ checkout: entry })}\n`);
    return { main, head, entry };
  };

  it("perfIssue prints the baseline, both batches, the thresholds and the commits over the anchor files", () => {
    const t = seeded();
    const r = perfIssue(t.main, "checkout");
    expect(r.code).toBe(0);
    expect(r.masked).toBe(true);
    const text = r.lines.join("\n");
    expect(text).toContain("perf regression: checkout");
    expect(text).toContain("dedupe: perf:checkout:lcp_ms");
    expect(text).not.toContain("dedupe: perf:checkout:bytes");
    expect(text).toContain(`baseline: head ${t.head.slice(0, 7)}, 5 runs a batch`);
    expect(text).toMatch(/lcp_ms\s+1000\s+1600\s+1700\s+20% and 250 ms\s+regressed/);
    expect(text).toMatch(/bytes\s+500000\s+900000\s+520000\s+20% and 102400\s+within/);
    expect(text).toMatch(/lab context.*never a verdict.*lcp_ms 2500.*inp_ms 200.*cls 0\.1/);
    // The commits over the anchor files only (one of the two commits since the baseline), fenced as data.
    expect(text).toMatch(/slow the checkout down/);
    expect(text).not.toContain("unrelated change");
    expect(text).toMatch(/<<<COMMITS-[0-9a-f]{32}\n[0-9a-f]{7} slow the checkout down .*\nCOMMITS-[0-9a-f]{32}>>>/);
    // The page-shaped marker in a commit subject is neutralized, so the fence cannot be forged.
    expect(text).not.toContain("<<<PAGE-0000");
    // The machine is told without its CPU model.
    expect(text).toContain("machine: 8 cores, 16 GB, linux-x64, Chrome 147.0.7727.60");
    expect(text).not.toContain("Some CPU");
  });

  it("perfIssue refuses an id that is not a journey's, a journey with no record, no batch, and no confirmed regression", () => {
    const t = seeded();
    expect(() => perfIssue(t.main, "Not An Id")).toThrow("refused: smoke perf: not a journey id");
    expect(() => perfIssue(t.main, "refund")).toThrow("refused: smoke perf: refund has no perf record");
    const u = seeded({ latest: undefined });
    expect(() => perfIssue(u.main, "checkout")).toThrow("refused: smoke perf: checkout has no batch");
    expect(() => perfIssue(committed(), "checkout")).toThrow("refused: smoke perf: checkout has no perf record");
    const v = seeded();
    const rec = JSON.parse(readFileSync(join(v.main, ".argus/perf.json"), "utf8"));
    rec.checkout.latest.regressed = [];
    writeFileSync(join(v.main, ".argus/perf.json"), JSON.stringify(rec));
    expect(() => perfIssue(v.main, "checkout")).toThrow("refused: smoke perf: checkout has no confirmed regression");
  });

  it("perfRebaseline moves the baseline to the newest batch, with the path, head, machine and runs it was measured with", () => {
    const t = seeded();
    const r = perfRebaseline(t.main, "checkout");
    expect(r.code).toBe(0);
    expect(r.lines).toEqual([`perf checkout: baseline moved to the newest batch (head ${git(t.main, "rev-parse", "--short=7", "HEAD")})`]);
    const e = JSON.parse(readFileSync(join(t.main, ".argus/perf.json"), "utf8")).checkout;
    expect(e).toMatchObject({ pathSha: "b".repeat(64), n: 5, medians: M({ lcp_ms: 1700, bytes: 520000 }), machine: { chrome: "147.0.7727.60" } });
    expect(e.head).toBe(git(t.main, "rev-parse", "HEAD"));
    expect(e.latest.regressed).toEqual([]);
    expect(statSync(join(t.main, ".argus/perf.json")).mode & 0o777).toBe(0o600);
    expect(() => perfRebaseline(t.main, "refund")).toThrow("refused: smoke perf: refund has no perf record");
    expect(() => perfRebaseline(seeded({ latest: undefined }).main, "checkout")).toThrow("refused: smoke perf: checkout has no batch");
  });

  it("readPerf: none yet is {}, a file that is not an object of journeys is refused", () => {
    const main = committed();
    expect(readPerf(main)).toEqual({});
    mkdirSync(join(main, ".argus"), { recursive: true });
    writeFileSync(join(main, ".argus/perf.json"), "[1]");
    expect(() => readPerf(main)).toThrow("refused: .argus/perf.json is not a perf record");
    writeFileSync(join(main, ".argus/perf.json"), "not json");
    expect(() => readPerf(main)).toThrow("refused: .argus/perf.json is not a perf record");
  });

  it("the CLI reaches both, behind the trace gate every smoke verb but check has", () => {
    const t = seeded();
    const run = (...args: string[]) => spawnSync(process.execPath, [join(__dirname, "../plugins/sapu/scripts/argus-live.mjs"), ...args], { cwd: t.main, encoding: "utf8" });
    expect(run("smoke", "perf", "--issue", "checkout").stderr).toBe("refused: smoke: a committed suite would leave a trace\n");
    mkdirSync(join(t.main, ".claude"), { recursive: true });
    writeFileSync(join(t.main, ".claude/sapu.json"), JSON.stringify(FIXTURE_CONTRACT));
    git(t.main, "add", ".claude");
    git(t.main, "-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", "commit", "-qm", "contract");
    const issue = run("smoke", "perf", "--issue", "checkout");
    expect(issue.status, issue.stderr).toBe(0);
    expect(issue.stdout).toContain("perf regression: checkout");
    expect(issue.stdout).toMatch(/<<<COMMITS-[0-9a-f]{32}\n/);
    const moved = run("smoke", "perf", "--rebaseline", "checkout");
    expect(moved.status, moved.stderr).toBe(0);
    expect(moved.stdout).toMatch(/^perf checkout: baseline moved to the newest batch \(head [0-9a-f]{7}\)\n$/);
    expect(run("smoke", "perf", "--issue", "refund").stderr).toBe("refused: smoke perf: refund has no perf record\n");
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------------
// A real Chrome. Bounds are loose on purpose: a loaded machine only makes a page slower.

describe("PERF_SCRIPT in Chrome", () => {
  let tools: ReturnType<typeof browserTools>;
  beforeAll(() => {
    tools = browserTools();
  }, 600_000);
  const stop: (() => Promise<unknown> | unknown)[] = [];
  afterEach(async () => {
    for (const f of stop.splice(0).reverse()) await f();
  }, 60_000);

  /** A page of text with a stylesheet and a script, that shifts its content 400 ms after load, and a button whose click blocks the thread for 140 ms. */
  const site = async () => {
    const html = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/a.css"><body><div id="top" style="height:0"></div>
<h1>A heading with enough text to be the largest paint of this page</h1><p>${"Some paragraph text. ".repeat(40)}</p><button id="b">Busy</button><script src="/a.js"></script>
<script>window.addEventListener("load", () => setTimeout(() => { document.getElementById("top").style.height = "180px"; }, 400));
document.getElementById("b").addEventListener("click", () => { const t = performance.now(); while (performance.now() - t < 140); });</script>`;
    const server = createServer((req, res) => {
      const body = req.url === "/a.css" ? `/* ${"x".repeat(3000)} */ body { margin: 8px; }` : req.url === "/a.js" ? `/* ${"y".repeat(5000)} */` : html;
      res.writeHead(200, { "content-type": req.url === "/a.css" ? "text/css" : req.url === "/a.js" ? "text/javascript" : "text/html", "cache-control": "no-store" });
      res.end(body);
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    stop.push(() => new Promise((ok) => server.close(ok)));
    return `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  };
  const launch = async () => {
    const { chromium } = createRequire(join(tools.cli.dir, "package.json"))("playwright-core");
    const browser = await chromium.launch({ executablePath: tools.chrome.path });
    stop.push(() => browser.close());
    return browser;
  };

  it("reads LCP, CLS, INP, requests and bytes from a real document", async () => {
    const url = await site();
    const browser = await launch();
    const context = await browser.newContext();
    await context.addInitScript(PERF_SCRIPT);
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "load" });
    await page.waitForTimeout(1200); // the shift at 400 ms after load
    await page.click("#b");
    await page.waitForTimeout(300);
    const snap = await page.evaluate((n: number) => (document as any).__argusPerf.snap(n), 100);
    expect(snap.lcp, JSON.stringify(snap)).toBeGreaterThan(0);
    expect(snap.cls, JSON.stringify(snap)).toBeGreaterThan(0);
    expect(snap.inp, JSON.stringify(snap)).toBeGreaterThanOrEqual(100);
    expect(snap.requests).toBeGreaterThanOrEqual(3);
    expect(snap.bytes).toBeGreaterThanOrEqual(8000);
    // The script installs once: a second evaluation changes nothing about the document's id.
    await page.evaluate(PERF_SCRIPT);
    expect((await page.evaluate(() => (document as any).__argusPerf.id)) as string).toBe(snap.doc);
  }, 120_000);

  it("a script evaluated after load still gets what the browser buffered; each document has its own id", async () => {
    const url = await site();
    const browser = await launch();
    const page = await (await browser.newContext()).newPage();
    await page.goto(url, { waitUntil: "load" });
    await page.waitForTimeout(1200);
    await page.evaluate(PERF_SCRIPT);
    const first = await page.evaluate(() => (document as any).__argusPerf.snap(0));
    expect(first.lcp, JSON.stringify(first)).toBeGreaterThan(0);
    expect(first.cls, JSON.stringify(first)).toBeGreaterThan(0);
    expect(first.requests).toBeGreaterThanOrEqual(3);
    await page.goto(url, { waitUntil: "load" });
    await page.evaluate(PERF_SCRIPT);
    expect((await page.evaluate(() => (document as any).__argusPerf.snap(0))).doc).not.toBe(first.doc);
  }, 120_000);
});

describe("smoke run --perf on the fixture app", () => {
  const MARK = "--from=argus-live-perf-tests";
  afterEach(browserCleanup, 60_000);
  afterEach(() => {
    for (const l of fixtureProcs(MARK)) {
      try {
        process.kill(Number(l.trim().split(/\s+/)[0]), "SIGKILL");
      } catch {
        // gone
      }
    }
  });
  afterEach(browserLeftovers);

  it("measures a path in a real browser: a baseline, then a second pass that moves only the newest batch", async () => {
    browserTools();
    const c = appCycle({ mark: MARK, repro: true });
    const live = join(c.main, ".argus/live.json");
    writeFileSync(live, `${JSON.stringify({ ...JSON.parse(readFileSync(live, "utf8")), test_id_attribute: "data-testid" }, null, 2)}\n`);
    execFileSync("git", ["-C", c.main, "-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", "commit", "-qam", "test ids"]);
    const { summary } = c.up();
    const journeys = join(c.main, "e2e/argus-smoke/journeys");
    mkdirSync(journeys, { recursive: true });
    const place = [
      { as: "buyer.1", do: "goto", path: "/orders/new" },
      { as: "buyer.1", do: "fill", target: { label: "Quantity" }, value: "1" },
      { as: "buyer.1", do: "click", target: { role: "button", name: "Place order" } },
      { as: "buyer.1", do: "read", target: { testId: "order-number" }, save: "order" },
      { as: "buyer.1", expect: "visible", target: { testId: "order-number" } },
    ];
    writeFileSync(join(journeys, "place-order.json"), `${JSON.stringify({ journey: "place-order", path: place })}\n`);
    writeFileSync(join(c.main, ".argus/smoke.json"), `${JSON.stringify({ perf: { runs: 1 } })}\n`);
    const first = c.cli("smoke", "run", "--perf", "--seed", "3");
    expect(first.code, `${first.out}\n${first.err}`).toBe(0);
    const lines = first.out.trimEnd().split("\n");
    expect(lines[0]).toBe("seed: 3");
    expect(lines[1]).toMatch(/^perf place-order: baseline set \(first batch\), 1 runs: lcp_ms=\d+ \(lab context: good 2500\), inp_ms=\d+ /);
    expect(lines.at(-1)).toBe("smoke run --perf: 1 baselined, 0 ok, 0 regressed, 0 flaky, 0 not measured");
    const rec = () => JSON.parse(readFileSync(join(c.main, ".argus/perf.json"), "utf8"))["place-order"];
    const base = rec();
    expect(base.n).toBe(1);
    expect(base.medians.lcp_ms).toBeGreaterThan(0);
    expect(base.medians.requests).toBeGreaterThanOrEqual(2);
    expect(base.medians.bytes).toBeGreaterThan(1000);
    expect(base.medians.duration_ms).toBeGreaterThan(0);
    expect(base.machine.chrome).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    // The path's records are the runner's: one warm-up on a fresh instance, one dirty run.
    const dir = join(c.main, ".argus/live", summary.runId, "smoke/place-order");
    expect(JSON.parse(readFileSync(join(dir, "run-1.json"), "utf8"))).toMatchObject({ exit: 0, dirty: false });
    expect(JSON.parse(readFileSync(join(dir, "run-2.json"), "utf8"))).toMatchObject({ exit: 0, dirty: true });
    // A second pass compares: whatever a loaded machine makes of it, the baseline itself does not move.
    const second = c.cli("smoke", "run", "--perf", "--seed", "3");
    expect([0, 3], `${second.out}\n${second.err}`).toContain(second.code);
    expect(second.out).toMatch(/\nperf place-order: (ok|flaky|regressed)/);
    const after = rec();
    expect({ ...after, latest: null }).toEqual({ ...base, latest: null });
    expect(after.latest.batches.length).toBeGreaterThanOrEqual(1);
    const rows = readFileSync(join(c.main, ".argus/live", summary.runId, "smoke/perf.jsonl"), "utf8").trim().split("\n");
    expect(rows).toHaveLength(2);
    // The owner's command moves the baseline to the newest batch.
    const moved = c.cli("smoke", "perf", "--rebaseline", "place-order");
    expect(moved.code, moved.err).toBe(0);
    expect(rec().medians).toEqual(after.latest.batches.at(-1));
  }, 1_200_000);
});
