// tests/taste-calibrate.test.ts — lane K: the maintainer's calibration script (scripts/taste-calibrate.mjs, spec §20.3,
// plan decision 16) and its reference corpus (scripts/taste-corpus.json). Offline: robots.txt, pacing, percentiles,
// the numbers-only output and --diff run against fake sessions and loopback fixture pages, never the internet.
import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { createServer as createTcpServer, type Server as TcpServer } from "node:net";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { browserTools } from "./helpers/argus-live";
// @ts-expect-error — plain ESM script without types
import { AGENT, PACE_MS, WITNESS, bandsOf, calibrate, diffLines, main, metricsOf, numbersOnly, openSession, percentile, probeDigest, robotsAllows, validateCorpus } from "../scripts/taste-calibrate.mjs";
// @ts-expect-error — plain ESM script without types
import { BAR_FILE, validateBar } from "../plugins/sapu/scripts/argus-live-tastecfg.mjs";
// @ts-expect-error — plain ESM script without types
import { TASTE_SOURCE } from "../plugins/sapu/scripts/argus-live-taste.mjs";
// @ts-expect-error — plain ESM script without types
import { EASE_SOURCE } from "../plugins/sapu/scripts/argus-live-ease.mjs";

type Obj = Record<string, any>;

const ROOT = join(__dirname, "..");
const SCRIPT = join(ROOT, "scripts/taste-calibrate.mjs");
const BAR = () => JSON.parse(readFileSync(BAR_FILE, "utf8"));
const temps: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "taste-calibrate-"));
  temps.push(d);
  return d;
};
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

/** A fake clock: `sleep` moves it, nothing waits for real. */
const clock = () => {
  let t = 1_000_000;
  return { now: () => t, sleep: async (ms: number) => void (t += ms), advance: (ms: number) => void (t += ms) };
};

/** A corpus page. */
const pg = (url: string, site: string, archetype = "docs") => ({ url, site, archetype, source: "primer", terms_reviewed_by: "maintainer" });

/**
 * A fake browser session: robots.txt per origin from `robots`, each visit's census from `census` (by URL), every
 * request logged with the fake clock's time. A visit takes `visitMs` of fake time.
 */
const fakeSession = ({ robots = {}, census = {}, visitMs = 3000, c = clock() }: { robots?: Obj; census?: Obj; visitMs?: number; c?: ReturnType<typeof clock> }) => {
  const log: { kind: string; url: string; t: number }[] = [];
  return {
    c,
    log,
    session: {
      blank: async (measure: (p: Obj) => unknown) => measure({ url: "about:blank" }),
      robots: async (origin: string) => {
        log.push({ kind: "robots", url: `${origin}/robots.txt`, t: c.now() });
        c.advance(200);
        const r = robots[origin];
        return r === undefined ? { status: 404, text: "" } : typeof r === "number" ? { status: r, text: "" } : { status: 200, text: r };
      },
      visit: async (url: string, measure: (p: Obj) => unknown) => {
        log.push({ kind: "page", url, t: c.now() });
        c.advance(visitMs);
        return { status: 200, finalUrl: url, result: await measure({ url }) };
      },
      close: async () => {},
    },
  };
};
/** Stand-in probes (the real ones are lanes T1's and T2's): a census by URL, an empty ease. */
const standIn = (census: Obj) => ({ census: async (p: Obj) => census[p.url] ?? { distinct_spacing: 1 }, ease: async () => ({}) });

describe("robots.txt — honoured for * and for the script's own agent", () => {
  const url = (p: string) => `https://example.test${p}`;

  it("an empty or missing file allows everything; /robots.txt itself is always allowed", () => {
    expect(robotsAllows("", url("/a"))).toBe(true);
    expect(robotsAllows("User-agent: *\nDisallow: /\n", url("/robots.txt"))).toBe(true);
  });

  it("a Disallow in the * group is honoured", () => {
    const txt = "User-agent: *\nDisallow: /private\n";
    expect(robotsAllows(txt, url("/private/x"))).toBe(false);
    expect(robotsAllows(txt, url("/public"))).toBe(true);
  });

  it(`a Disallow in the ${"sapu-taste-calibration"} group is honoured, case-insensitively`, () => {
    expect(AGENT).toBe("sapu-taste-calibration");
    const txt = "User-agent: Googlebot\nDisallow: /\n\nUser-agent: SAPU-Taste-Calibration\nDisallow: /docs/\n";
    expect(robotsAllows(txt, url("/docs/a"))).toBe(false);
    expect(robotsAllows(txt, url("/blog"))).toBe(true);
  });

  it("both groups bind: the agent's own group does not lift a * Disallow", () => {
    const txt = "User-agent: *\nDisallow: /a\n\nUser-agent: sapu-taste-calibration\nAllow: /\n";
    expect(robotsAllows(txt, url("/a/b"))).toBe(false);
    expect(robotsAllows(txt, url("/b"))).toBe(true);
  });

  it("the longest match wins, Allow on a tie; * and $ are wildcards; the query is part of the path", () => {
    const txt = "User-agent: *\nDisallow: /docs\nAllow: /docs/public\nDisallow: /*.json$\nDisallow: /search?\nAllow: /tie\nDisallow: /tie\n";
    expect(robotsAllows(txt, url("/docs/x"))).toBe(false);
    expect(robotsAllows(txt, url("/docs/public/x"))).toBe(true);
    expect(robotsAllows(txt, url("/data/a.json"))).toBe(false);
    expect(robotsAllows(txt, url("/data/a.json?x=1"))).toBe(true);
    expect(robotsAllows(txt, url("/search?q=1"))).toBe(false);
    expect(robotsAllows(txt, url("/search"))).toBe(true);
    expect(robotsAllows(txt, url("/tie"))).toBe(true);
  });

  it("groups merge across a file, comments and blank lines are ignored, an empty Disallow allows", () => {
    const txt = "# hello\nUser-agent: a\nUser-agent: *   # both\nDisallow:\n\nUser-agent: *\nDisallow: /x # no\nSitemap: https://example.test/s.xml\n";
    expect(robotsAllows(txt, url("/x"))).toBe(false);
    expect(robotsAllows(txt, url("/y"))).toBe(true);
  });

  it("calibrate never requests a disallowed page and records why; a robots.txt it cannot read skips the origin", async () => {
    const f = fakeSession({
      robots: { "https://a.test": "User-agent: *\nDisallow: /no\n", "https://b.test": "User-agent: sapu-taste-calibration\nDisallow: /\n", "https://c.test": 503 },
    });
    const pages = [pg("https://a.test/yes", "a"), pg("https://a.test/no", "a"), pg("https://b.test/x", "b"), pg("https://c.test/x", "c")];
    const r = await calibrate({ pages, bar: BAR(), session: f.session, probes: standIn({}), now: f.c.now, sleep: f.c.sleep });
    expect(f.log.filter((e) => e.kind === "page").map((e) => e.url)).toEqual(["https://a.test/yes"]);
    expect([...r.skipped].sort((x: Obj, y: Obj) => x.url.localeCompare(y.url))).toEqual([
      { url: "https://a.test/no", reason: "robots.txt disallows it for *" },
      { url: "https://b.test/x", reason: `robots.txt disallows it for ${AGENT}` },
      { url: "https://c.test/x", reason: "robots.txt could not be read (HTTP 503): the origin is skipped" },
    ]);
  });
});

describe("pace — one request at a time, at most one page per site every 10 s", () => {
  it("every request to a site, robots.txt included, starts at least 10 s after the last one ended", async () => {
    expect(PACE_MS).toBe(10_000);
    const f = fakeSession({ visitMs: 2500 });
    const pages = [1, 2, 3, 4].map((i) => pg(`https://a.test/${i}`, "a")).concat([1, 2].map((i) => pg(`https://b.test/${i}`, "b")));
    await calibrate({ pages, bar: BAR(), session: f.session, probes: standIn({}), now: f.c.now, sleep: f.c.sleep });
    for (const site of ["a", "b"]) {
      const times = f.log.filter((e) => e.url.startsWith(`https://${site}.test`)).map((e) => e.t);
      expect(times).toHaveLength(site === "a" ? 5 : 3);
      // A visit lasts 2.5 s (robots 0.2 s): the next one may start only 10 s after it ended.
      for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1], `${site} request ${i}`).toBeGreaterThanOrEqual(PACE_MS + 200);
    }
    // Sites interleave: b's first page is not held behind all of a's.
    const order = f.log.filter((e) => e.kind === "page").map((e) => e.url);
    expect(order.indexOf("https://b.test/1")).toBeLessThan(order.indexOf("https://a.test/2"));
  });
});

describe("bands — percentiles, sites, the cut", () => {
  it("percentile is the nearest rank, exact on a known set", () => {
    const s = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect([percentile(s, 0.1), percentile(s, 0.5), percentile(s, 0.9)]).toEqual([1, 5, 9]);
    const t = [4, 4, 6, 7, 9, 11, 12, 15, 15, 16, 18, 20, 21, 24, 30];
    expect([percentile(t, 0.1), percentile(t, 0.5), percentile(t, 0.9)]).toEqual([4, 15, 24]);
    expect([percentile([7], 0.1), percentile([7], 0.9)]).toEqual([7, 7]);
  });

  it("a band holds n, sites, p10/p50/p90 and the URLs measured, per archetype and metric", () => {
    const m = (url: string, site: string, v: number, archetype = "docs") => ({ url, site, archetype, metrics: { distinct_spacing: v } });
    const measured = [m("https://a.test/1", "a", 3), m("https://a.test/2", "a", 9), m("https://b.test/1", "b", 5), m("https://c.test/1", "c", 7), m("https://d.test/1", "d", 4, "marketing")];
    const { archetypes, cut } = bandsOf(measured);
    expect(archetypes).toEqual({ docs: { distinct_spacing: { n: 4, sites: 3, p10: 3, p50: 5, p90: 9, urls: ["https://a.test/1", "https://a.test/2", "https://b.test/1", "https://c.test/1"] } } });
    expect(cut).toEqual([{ archetype: "marketing", metric: "distinct_spacing", why: "one site gives it all" }]);
  });

  it("a band driven by one site is cut: one site, or one site giving more than half the pages", () => {
    const m = (i: number, site: string) => ({ url: `https://${site}.test/${i}`, site, archetype: "data", metrics: { distinct_spacing: i } });
    const { archetypes, cut } = bandsOf([m(1, "a"), m(2, "a"), m(3, "a"), m(4, "b")]);
    expect(archetypes).toEqual({});
    expect(cut).toEqual([{ archetype: "data", metric: "distinct_spacing", why: "one site gives more than half its pages" }]);
  });

  it("metricsOf takes the bar's screen metrics as finite numbers wherever the probes put them, and nothing else", () => {
    const bar = BAR();
    const screen = { census: { scale: { distinct_spacing: 7, distinct_type: "9" }, label: "x", hierarchy: { primary_actions: 1 } }, ease: { first_change_ms: Infinity, broken_tokens: 0, actions: 4 } };
    // `actions` is a cycle rule's metric (efficiency): only the judge compares paths, so it has no band.
    expect(metricsOf(screen, bar)).toEqual({ distinct_spacing: 7, primary_actions: 1, broken_tokens: 0 });
  });

  it("the witness threshold is decision 16's: at least 5 sites and 15 pages", () => {
    expect(WITNESS).toEqual({ sites: 5, pages: 15 });
  });
});

describe("numbers only — no string but URLs and metric names reaches the output", () => {
  it("numbersOnly passes bands and refuses any other string, without echoing it", () => {
    const band = { n: 2, sites: 2, p10: 1, p50: 2, p90: 3, urls: ["https://a.test/1", "https://b.test/1"] };
    expect(numbersOnly({ docs: { distinct_spacing: band } })).toBeNull();
    const secret = ["sk", "live", "x".repeat(24)].join("_");
    for (const bad of [
      { docs: { distinct_spacing: { ...band, p50: secret } } },
      { docs: { distinct_spacing: { ...band, urls: [secret] } } },
      { docs: { distinct_spacing: { ...band, note: secret } } },
      { docs: { [secret]: band } },
      { [secret]: { distinct_spacing: band } },
      { docs: { distinct_spacing: { ...band, p90: [secret] } } },
      { docs: { distinct_spacing: band }, form: secret },
    ]) {
      const why = numbersOnly(bad);
      expect(why).toMatch(/^archetypes/);
      expect(why).not.toContain(secret);
    }
  });

  it("a page whose census returns its text leaks nothing into the bands", async () => {
    const secret = ["ghp", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join("_");
    const f = fakeSession({});
    const pages = ["a", "b"].map((s) => pg(`https://${s}.test/x`, s));
    const census = Object.fromEntries(pages.map((p) => [p.url, { distinct_spacing: 4, text: `token ${secret}`, scale: { distinct_type: secret } }]));
    const r = await calibrate({ pages, bar: BAR(), session: f.session, probes: standIn(census), now: f.c.now, sleep: f.c.sleep });
    expect(JSON.stringify(r)).not.toContain(secret);
    expect(r.archetypes.docs.distinct_spacing).toMatchObject({ n: 2, sites: 2, p50: 4 });
  });
});

describe("--diff — each band's change", () => {
  const band = (p: number[], n: number, sites: number) => ({ n, sites, p10: p[0], p50: p[1], p90: p[2], urls: ["https://a.test/1"] });
  it("prints every band: changed, unchanged, new and gone", () => {
    const before = { docs: { distinct_spacing: band([3, 5, 9], 16, 5), distinct_radii: band([1, 2, 3], 16, 5), distinct_type: band([2, 4, 6], 15, 5) } };
    const after = { docs: { distinct_spacing: band([3, 6, 11], 18, 6), distinct_radii: band([1, 2, 3], 16, 5) }, marketing: { distinct_spacing: band([4, 8, 12], 15, 6) } };
    expect(diffLines(before, after)).toEqual([
      "docs.distinct_radii: unchanged 1/2/3 (n 16, sites 5)",
      "docs.distinct_spacing: p10/p50/p90 3/5/9 → 3/6/11, n 16 → 18, sites 5 → 6",
      "docs.distinct_type: gone (was 2/4/6, n 15, sites 5)",
      "marketing.distinct_spacing: new 4/8/12 (n 15, sites 6)",
    ]);
  });
});

describe("the CLI", () => {
  const tmpBar = (archetypes: Obj = {}) => {
    const d = temp();
    const out = join(d, "taste-bar.json");
    writeFileSync(out, `${JSON.stringify({ ...BAR(), archetypes }, null, 2)}\n`);
    return out;
  };
  const tmpCorpus = (pages: Obj[], extra: Obj = {}) => {
    const d = temp();
    const file = join(d, "corpus.json");
    const sites = Object.fromEntries([...new Set(pages.map((p) => p.site))].map((s) => [s, { terms: `https://${s}.test/terms`, note: "public pages, no login" }]));
    writeFileSync(file, JSON.stringify({ coverage: "fixture", sites, pages, skipped: [], ...extra }));
    return file;
  };

  it("without --network nothing is fetched: it validates the corpus and prints the plan", async () => {
    let connections = 0;
    const tcp: TcpServer = createTcpServer((s) => {
      connections += 1;
      s.destroy();
    });
    await new Promise<void>((r) => tcp.listen(0, "127.0.0.1", r));
    const port = (tcp.address() as Obj).port;
    try {
      const pages = [pg(`https://127.0.0.1:${port}/a`, "a"), pg(`https://127.0.0.1:${port}/b`, "b", "marketing")];
      const corpus = tmpCorpus(pages);
      const out = tmpBar();
      const before = readFileSync(out, "utf8");
      const r = spawnSync(process.execPath, [SCRIPT, "--corpus", corpus, "--out", out], { encoding: "utf8", timeout: 30_000 });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain("nothing fetched");
      expect(r.stdout).toContain(`https://127.0.0.1:${port}/a`);
      expect(r.stdout).toMatch(/docs: 1 page, 1 site/);
      expect(readFileSync(out, "utf8")).toBe(before);
      expect(connections).toBe(0);
    } finally {
      tcp.close();
    }
  }, 30_000);

  it("refuses a broken corpus, an unknown flag, --diff without --network, and a missing --out", async () => {
    const out = tmpBar();
    const good = tmpCorpus([pg("https://a.test/1", "a")]);
    const bad = tmpCorpus([{ ...pg("https://a.test/1", "a"), archetype: "dashboard" }]);
    expect((await main(["--corpus", bad, "--out", out])).lines.join("\n")).toMatch(/^refused: taste-calibrate: the corpus is broken: pages\[0\]\.archetype/m);
    expect((await main(["--corpus", good, "--out", out, "--fast"])).code).toBe(1);
    expect((await main(["--corpus", good, "--out", out, "--diff"])).lines[0]).toBe("refused: taste-calibrate: --diff compares a new calibration with the bar, so it needs --network");
    expect((await main(["--corpus", good])).code).toBe(1);
  });

  it("with --network: refuses before any request while the probes are not built, nothing written", async () => {
    const out = tmpBar();
    const before = readFileSync(out, "utf8");
    const f = fakeSession({});
    const stub = { census: async () => { throw new Error("refused: censusOf: not built yet"); }, ease: async () => ({}) };
    const r = await main(["--network", "--corpus", tmpCorpus([pg("https://a.test/1", "a")]), "--out", out], { openSession: async () => f.session, probes: stub, now: f.c.now, sleep: f.c.sleep });
    expect(r.code).toBe(1);
    expect(r.lines[0]).toBe("refused: taste-calibrate: the probes cannot measure a blank page (refused: censusOf: not built yet): nothing was fetched");
    expect(f.log).toEqual([]);
    expect(readFileSync(out, "utf8")).toBe(before);
  });

  it("with --network --diff: writes the bands and the probe digest into the bar, keeps everything else, prints the diff and the witness summary", async () => {
    const old = { docs: { distinct_spacing: { n: 15, sites: 5, p10: 2, p50: 4, p90: 6, urls: ["https://old.test/1"] } } };
    const out = tmpBar(old);
    const sites = ["a", "b", "c", "d", "e"];
    const pages = sites.flatMap((s) => [1, 2, 3].map((i) => pg(`https://${s}.test/${i}`, s))).concat([pg("https://a.test/m", "a", "marketing"), pg("https://b.test/m", "b", "marketing")]);
    const census = Object.fromEntries(pages.map((p, i) => [p.url, { distinct_spacing: (i % 7) + 2 }]));
    const f = fakeSession({ visitMs: 1000 });
    const r = await main(["--network", "--diff", "--corpus", tmpCorpus(pages), "--out", out], { openSession: async () => f.session, probes: standIn(census), now: f.c.now, sleep: f.c.sleep });
    expect(r.code, r.lines.join("\n")).toBe(0);
    const written = JSON.parse(readFileSync(out, "utf8"));
    expect(validateBar(written).errors).toEqual([]);
    const { archetypes, probe, ...rest } = written;
    const { archetypes: _a, probe: _p, ...was } = BAR();
    expect(rest).toEqual(was);
    expect(probe).toBe(probeDigest());
    expect(Object.keys(archetypes).sort()).toEqual(["docs", "marketing"]);
    expect(archetypes.docs.distinct_spacing).toMatchObject({ n: 15, sites: 5 });
    const text = r.lines.join("\n");
    expect(text).toMatch(/^docs\.distinct_spacing: p10\/p50\/p90 2\/4\/6 → /m);
    expect(text).toMatch(/^docs: 15 pages, 5 sites — a witness$/m);
    expect(text).toMatch(/^marketing: 2 pages, 2 sites — thin \(a witness needs at least 5 sites and 15 pages\)$/m);
    expect(text).toMatch(/^form: no page measured — thin$/m);
    expect(text).toMatch(/taste-bar 1 stays: a calibration after a release raises it by one/);
  });

  it("rewrites only the bar's probe and archetypes lines: the rest of the shipped file stays byte for byte", async () => {
    const d = temp();
    const out = join(d, "taste-bar.json");
    const original = readFileSync(BAR_FILE, "utf8");
    writeFileSync(out, original);
    const pages = ["a", "b", "c"].map((s) => pg(`https://${s}.test/1`, s));
    const f = fakeSession({});
    const r = await main(["--network", "--corpus", tmpCorpus(pages), "--out", out], { openSession: async () => f.session, probes: standIn({}), now: f.c.now, sleep: f.c.sleep });
    expect(r.code, r.lines.join("\n")).toBe(0);
    const written = readFileSync(out, "utf8");
    const head = (t: string) => t.slice(0, t.indexOf('\n  "archetypes": '));
    expect(head(written).replace(/^ {2}"probe": .*$/m, "")).toBe(head(original).replace(/^ {2}"probe": .*$/m, ""));
    expect(written).toMatch(/^ {2}"probe": "[0-9a-f]{64}",$/m);
    expect(written).toContain('\n  "archetypes": {\n    "docs": {\n      "distinct_spacing": { "n": 3, "sites": 3, "p10": 1, "p50": 1, "p90": 1, "urls": ["https://a.test/1", "https://b.test/1", "https://c.test/1"] }\n    }\n  }\n}\n');
    expect(validateBar(JSON.parse(written)).errors).toEqual([]);
  });

  it("probeDigest is the sha256 of the probe sources the run measured with", () => {
    expect(probeDigest()).toMatch(/^[0-9a-f]{64}$/);
    expect(probeDigest([TASTE_SOURCE, EASE_SOURCE])).toBe(probeDigest());
    expect(probeDigest(["a", "b"])).not.toBe(probeDigest());
  });
});

describe("in Chrome, against loopback fixture pages", () => {
  let server: Server;
  let base = "";
  const hits: { path: string; ua: string }[] = [];
  let robots = "";
  let session: Obj;
  const secret = () => ["sk", "test", "4eC39HqLyjWDarjtT1zdp7dc"].join("_");

  beforeAll(async () => {
    server = createServer((req, res) => {
      hits.push({ path: req.url ?? "", ua: String(req.headers["user-agent"] ?? "") });
      if (req.url === "/robots.txt") return void res.writeHead(200, { "content-type": "text/plain" }).end(robots);
      const page = `<!doctype html><html lang="en"><head><title>fixture</title></head><body><main style="padding:8px"><h1 style="margin:16px">Fixture</h1><p style="margin:24px">key ${secret()}</p></main></body></html>`;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as Obj).port}`;
    const { cli, chrome } = browserTools();
    session = await openSession({ cli, chrome });
  }, 60_000);
  afterAll(async () => {
    await session?.close();
    await new Promise((r) => server?.close(r));
  }, 60_000);

  // A stand-in census that runs in the page (the real one is lane T1's): it counts distinct margins and paddings, and
  // also hands back the page's text, which must never reach the output.
  const inPage = {
    census: (page: Obj) =>
      page.evaluate(() => {
        const values = new Set<string>();
        for (const el of Array.from(document.querySelectorAll("body *"))) {
          const s = getComputedStyle(el);
          for (const v of [s.marginTop, s.paddingTop]) if (v !== "0px") values.add(v);
        }
        return { distinct_spacing: values.size, text: document.body.innerText };
      }),
    ease: async () => ({}),
  };

  it("measures the allowed pages under its own agent, never requests a disallowed one, and keeps no page text", async () => {
    robots = "User-agent: *\nDisallow: /private\n\nUser-agent: sapu-taste-calibration\nDisallow: /agent-only\n";
    hits.length = 0;
    const c = clock();
    const pages = [pg(`${base}/a`, "a"), pg(`${base}/private/x`, "a"), pg(`${base}/agent-only/y`, "b"), pg(`${base}/b`, "b")];
    const r = await calibrate({ pages, bar: BAR(), session, probes: inPage, now: c.now, sleep: c.sleep });
    const paths = hits.map((h) => h.path);
    expect(paths).toContain("/robots.txt");
    expect(paths).toContain("/a");
    expect(paths).toContain("/b");
    expect(paths.some((p) => p.startsWith("/private") || p.startsWith("/agent-only"))).toBe(false);
    expect(hits.every((h) => h.ua.includes(AGENT))).toBe(true);
    expect(r.skipped.map((s: Obj) => s.url).sort()).toEqual([`${base}/agent-only/y`, `${base}/private/x`]);
    expect(r.archetypes.docs.distinct_spacing).toEqual({ n: 2, sites: 2, p10: 3, p50: 3, p90: 3, urls: [`${base}/a`, `${base}/b`] });
    expect(JSON.stringify(r)).not.toContain(secret());
  }, 60_000);

  it("the blank-page check runs the probes with no request at all", async () => {
    hits.length = 0;
    expect(await session.blank(inPage.census)).toMatchObject({ distinct_spacing: expect.any(Number) });
    expect(hits).toEqual([]);
  }, 60_000);
});

describe("the corpus validator", () => {
  it("the corpus validator refuses unknown keys, a duplicate or non-https URL, a site it does not describe, and a missing review", () => {
    const ok = { coverage: "x", sites: { a: { terms: "https://a.test/terms", note: "n" } }, pages: [pg("https://a.test/1", "a")], skipped: [] };
    expect(validateCorpus(ok).errors).toEqual([]);
    for (const [what, bad] of [
      ["unknown key", { ...ok, extra: 1 }],
      ["duplicate", { ...ok, pages: [pg("https://a.test/1", "a"), pg("https://a.test/1", "a")] }],
      ["http", { ...ok, pages: [pg("http://a.test/1", "a")] }],
      ["credentials", { ...ok, pages: [pg("https://u:p@a.test/1", "a")] }],
      ["fragment", { ...ok, pages: [pg("https://a.test/1#x", "a")] }],
      ["site", { ...ok, pages: [pg("https://a.test/1", "b")] }],
      ["review", { ...ok, pages: [{ ...pg("https://a.test/1", "a"), terms_reviewed_by: "" }] }],
      ["page key", { ...ok, pages: [{ ...pg("https://a.test/1", "a"), title: "x" }] }],
      ["skipped reason", { ...ok, skipped: [{ url: "https://a.test/2", site: "a", archetype: "docs" }] }],
      ["no pages", { ...ok, pages: [] }],
    ] as [string, Obj][]) expect(validateCorpus(bad).errors, what).not.toEqual([]);
  });
});
