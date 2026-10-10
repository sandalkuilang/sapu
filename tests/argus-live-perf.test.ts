// tests/argus-live-perf.test.ts — `smoke run --perf` (spec §19.11): the in-page observers, a batch's medians, the
// per-journey baselines in .argus/perf.json, the regression rule and the perf issue's body. The statistic and the
// thresholds are tested with synthetic numbers (a loaded machine moves real ones); the live browser tests keep
// to loose bounds.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import vm from "node:vm";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { FIXTURE_CONTRACT } from "./fixture-contract";
import { browserTools, cleanTemps, committed, example, git } from "./helpers/argus-live";
// @ts-expect-error — plain ESM script without types
import { activeSink, batchMedians, collecting, confirmedRegressions, median, newSink, PERF_SCRIPT, perfCode, perfIssue, perfRebaseline, readPerf, recordDocs, regressions, runMetrics } from "../plugins/sapu/scripts/argus-live-perf.mjs";
// @ts-expect-error — plain ESM script without types
import { down } from "../plugins/sapu/scripts/argus-live-run.mjs";

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
