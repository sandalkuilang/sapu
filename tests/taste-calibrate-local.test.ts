// tests/taste-calibrate-local.test.ts — taste-calibrate's local reference corpus (`--local <manifest>`,
// scripts/taste-calibrate-local.mjs and scripts/taste-corpus-local.json): OSI-licensed, maintained OSS apps pinned to
// their latest release, fetched into a temp dir, run on loopback by the journey lane's own `up`/`down`, measured by the
// calibration's session and probes (numbers only), then deleted. Offline: GitHub's answers and docker are stand-ins;
// the end-to-end run fetches a fixture app (tests/fixtures/taste-local-app) by commit through the same code path.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cleanTemps, fakeDocker, homeWithCli, tempDir } from "./helpers/argus-live";
// @ts-expect-error — plain ESM script without types
import { main, probeDigest } from "../scripts/taste-calibrate.mjs";
// @ts-expect-error — plain ESM script without types
import { OSI_LICENSES, ROUTE_MIX, WIDTHS, appStatus, refreshManifest, themedMetrics, validateManifest } from "../scripts/taste-calibrate-local.mjs";
// @ts-expect-error — plain ESM script without types
import { BAR_FILE, validateBar } from "../plugins/sapu/scripts/argus-live-tastecfg.mjs";

type Obj = Record<string, any>;

const ROOT = join(__dirname, "..");
const MANIFEST = join(ROOT, "scripts/taste-corpus-local.json");
const FIXTURE = join(__dirname, "fixtures/taste-local-app");
const NODE = process.execPath;
/** The mark the fixture's processes carry (an argument the app ignores): this file's alone. */
const MARK = "--from=taste-calibrate-local-tests";
const OCTOBER = Date.UTC(2026, 9, 11);
const SHA = "a".repeat(40);
const DIGEST = `sha256:${"b".repeat(64)}`;

afterAll(() => cleanTemps());

/** Seven routes in the required mix. */
const ROUTES = [
  { path: "/", archetype: "app" },
  { path: "/projects", archetype: "app" },
  { path: "/activity", archetype: "app" },
  { path: "/settings/profile", archetype: "form" },
  { path: "/projects/new", archetype: "form" },
  { path: "/members", archetype: "data" },
  { path: "/invoices", archetype: "data" },
];

/** The fixture app's live.json for the lane, `variant` its spacing scale. */
const live = (variant: string): Obj => ({
  start: [{ name: "web", cmd: `${JSON.stringify(NODE)} server.mjs ${MARK}`, env: { PORT: "{port:web}", VARIANT: variant }, health: { url: "http://localhost:{port:web}/health" } }],
  base_url: "http://localhost:{port:web}",
  login_url: "/login",
  logged_in: "getByRole('button', { name: 'Account' })",
  env_file: ".argus/live.env",
  env: { APP_PW: "${APP_PW}", CANARY: "${CANARY}" },
  pass_env: [],
  store: "taste_explore",
  store_check: `${JSON.stringify(NODE)} server.mjs --which-store`,
  reset: `${JSON.stringify(NODE)} server.mjs --reset`,
  confirmed: { mocks: true, data: true },
  allow_origins: [],
  port_range: [41000, 41999],
  reserved_ports: [],
  settle_ms: 8000,
  roles: { anon: {}, member: { users: [{ user: "member@example.test", password: "${APP_PW}" }] } },
  limits: { max_cycle_minutes: 30, live_health_timeout_s: 90 },
});

/** A ready app of the manifest (git source, pinned). */
const ready = (over: Obj = {}): Obj => ({
  repo: "https://github.com/example/fixture-a",
  license: "MIT",
  note: "the test's fixture app",
  source: "git",
  release: { tag: "v1.0.0", published: "2026-09", commit: SHA },
  live: live("a"),
  env: { APP_PW: "pw-1", CANARY: "canary" },
  login: "member",
  routes: ROUTES,
  ...over,
});
/** A candidate: no live config, no routes, no release yet. */
const candidate = (over: Obj = {}): Obj => ({ repo: "https://github.com/example/cand", license: "AGPL-3.0", note: "a candidate", source: "git", release: null, live: null, env: {}, login: null, routes: [], ...over });
const manifest = (apps: Obj, over: Obj = {}): Obj => ({ coverage: "the test's corpus", max_age_months: 12, apps, ...over });

/**
 * GitHub's answers stood in: `repos` maps "<owner>/<repo>" → {tag, published (an ISO time), license, sha} or a status
 * number for the releases call. Every URL asked is logged.
 */
const fakeGitHub = (repos: Obj) => {
  const asked: string[] = [];
  const fetchJson = async (url: string) => {
    asked.push(url);
    const m = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/(releases\/latest|license|commits\/(.+))$/.exec(url);
    const r = m ? repos[m[1]] : undefined;
    if (!m || r === undefined) return { status: 404, json: null };
    if (typeof r === "number") return { status: r, json: null };
    if (m[2] === "releases/latest") return { status: 200, json: { tag_name: r.tag, published_at: r.published } };
    if (m[2] === "license") return { status: 200, json: { license: { spdx_id: r.license } } };
    return decodeURIComponent(m[3]) === r.tag ? { status: 200, json: { sha: r.sha } } : { status: 404, json: null };
  };
  return { asked, fetchJson };
};

const write = (obj: Obj, name = "manifest.json") => {
  const file = join(tempDir(), name);
  writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`);
  return file;
};
const barCopy = () => {
  const out = join(tempDir(), "taste-bar.json");
  writeFileSync(out, readFileSync(BAR_FILE, "utf8"));
  return out;
};
/** Seams that fail the test if the run fetches, starts or measures anything. */
const untouchable = () => {
  const touched: string[] = [];
  return {
    touched,
    deps: {
      openSession: async () => (touched.push("browser"), {}),
      exec: async (argv: string[]) => (touched.push(argv.join(" ")), { code: 1, stdout: "", stderr: "" }),
      git: (args: string[]) => (touched.push(`git ${args.join(" ")}`), { status: 1, stdout: "", stderr: "" }),
      runner: (argv: string[]) => (touched.push(argv.join(" ")), { status: 1, stdout: "", stderr: "" }),
      today: () => OCTOBER,
    },
  };
};

describe("the manifest — OSI licenses only, pinned releases, the route mix", () => {
  it("the shipped manifest validates and lists the candidate apps, each with an OSI license; it lives outside the plugin", () => {
    const m = JSON.parse(readFileSync(MANIFEST, "utf8"));
    expect(validateManifest(m).errors).toEqual([]);
    expect(Object.keys(m.apps).sort()).toEqual(["calcom", "documenso", "infisical", "plane", "shadcn-ui", "supabase-studio", "twenty"]);
    for (const [id, a] of Object.entries(m.apps) as [string, Obj][]) {
      expect(OSI_LICENSES, id).toContain(a.license);
      expect(a.repo, id).toMatch(/^https:\/\/github\.com\/[^/]+\/[^/]+$/);
    }
    expect(m.max_age_months).toBe(12);
    expect(existsSync(join(ROOT, "plugins/sapu/scripts/taste-calibrate-local.mjs"))).toBe(false);
    expect(existsSync(join(ROOT, "plugins/sapu/data/taste-corpus-local.json"))).toBe(false);
  });

  it("the shipped bar stays without bands: nothing was measured in this repository", () => {
    expect(JSON.parse(readFileSync(BAR_FILE, "utf8")).archetypes).toEqual({});
  });

  it("each ready app has 3 app, 2 form and 2 data routes, measured at 390 and 1440", () => {
    expect(ROUTE_MIX).toEqual({ app: 3, form: 2, data: 2 });
    expect(WIDTHS).toEqual([390, 1440]);
    expect(validateManifest(manifest({ a: ready(), b: candidate() })).errors).toEqual([]);
  });

  it("refuses a license OSI did not approve, whatever else the app holds", () => {
    for (const license of ["BUSL-1.1", "SSPL-1.0", "Elastic-2.0", "NOASSERTION", "Commons-Clause", "", "mit"]) {
      expect(validateManifest(manifest({ a: ready({ license }) })).errors, license).toContainEqual(expect.stringMatching(/^apps\.a\.license must be an OSI-approved license \(SPDX id/));
    }
  });

  it("refuses unknown keys, a repo that is not a GitHub https URL, a wrong route mix, a broken route, a broken pin, a login it cannot use", () => {
    const routes = (f: (r: Obj[]) => Obj[]) => f(structuredClone(ROUTES));
    for (const [what, m] of [
      ["unknown top key", manifest({ a: ready() }, { extra: 1 })],
      ["unknown app key", manifest({ a: ready({ title: "x" }) })],
      ["no apps", manifest({})],
      ["an app id that is not kebab-case", manifest({ App_1: ready() })],
      ["max age 0", manifest({ a: ready() }, { max_age_months: 0 })],
      ["http repo", manifest({ a: ready({ repo: "http://github.com/o/r" }) })],
      ["another host", manifest({ a: ready({ repo: "https://gitlab.com/o/r" }) })],
      ["two app routes", manifest({ a: ready({ routes: routes((r) => r.filter((x) => x.path !== "/activity")) }) })],
      ["a fourth app route", manifest({ a: ready({ routes: [...ROUTES, { path: "/more", archetype: "app" }] }) })],
      ["a docs route", manifest({ a: ready({ routes: routes((r) => (r[0].archetype = "docs", r)) }) })],
      ["a duplicate path", manifest({ a: ready({ routes: routes((r) => (r[1].path = "/", r)) }) })],
      ["a fragment", manifest({ a: ready({ routes: routes((r) => (r[1].path = "/projects#top", r)) }) })],
      ["no leading slash", manifest({ a: ready({ routes: routes((r) => (r[1].path = "projects", r)) }) })],
      ["a commit that is not 40 hex", manifest({ a: ready({ release: { tag: "v1", published: "2026-09", commit: "abc" } }) })],
      ["a day in published", manifest({ a: ready({ release: { tag: "v1", published: ["2026", "09", "01"].join("-"), commit: SHA } }) })],
      ["a digest on a git source", manifest({ a: ready({ release: { tag: "v1", published: "2026-09", commit: SHA, digest: DIGEST } }) })],
      ["an image source without its image", manifest({ a: ready({ source: "image", release: { tag: "v1", published: "2026-09", digest: DIGEST } }) })],
      ["an image release without a digest", manifest({ a: ready({ source: "image", image: "ghcr.io/o/app", release: { tag: "v1", published: "2026-09", commit: SHA } }) })],
      ["IMAGE set by hand on an image source", manifest({ a: ready({ source: "image", image: "ghcr.io/o/app", release: { tag: "v1", published: "2026-09", digest: DIGEST }, env: { IMAGE: "x" } }) })],
      ["a lower-case env name", manifest({ a: ready({ env: { app_pw: "x" } }) })],
      ["an env value with a single quote (the env file quotes values so)", manifest({ a: ready({ env: { APP_PW: "it's" } }) })],
      ["a login role with no users", manifest({ a: ready({ login: "anon" }) })],
      ["a login role the live config lacks", manifest({ a: ready({ login: "admin" }) })],
      ["a login role whose user needs a TOTP code", manifest({ a: ready({ live: { ...live("a"), roles: { member: { users: [{ user: "m@example.test", password: "${APP_PW}", totp_secret: "${TOTP}" }] } } } }) })],
      ["a live config the lane refuses (no store)", manifest({ a: ready({ live: (({ store, ...rest }) => rest)(live("a")) }) })],
      ["env values with no env_file to carry them", manifest({ a: ready({ live: (({ env_file, ...rest }) => rest)(live("a")) }) })],
    ] as [string, Obj][]) expect(validateManifest(m).errors, what).not.toEqual([]);
  });

  it("an app is ready only with a live config and a pinned release no older than max_age_months", () => {
    const at = (y: number, m: number) => Date.UTC(y, m - 1, 15);
    expect(appStatus(ready(), { now: at(2026, 10), maxAge: 12 })).toEqual({ ready: true, why: null });
    expect(appStatus(ready(), { now: at(2027, 9), maxAge: 12 })).toEqual({ ready: true, why: null });
    expect(appStatus(ready(), { now: at(2027, 10), maxAge: 12 })).toEqual({ ready: false, why: "its release v1.0.0 is from 2026-09, older than 12 months: unmaintained" });
    expect(appStatus(candidate(), { now: at(2026, 10), maxAge: 12 })).toEqual({ ready: false, why: "no live config; no routes; no release pinned (--refresh resolves the latest)" });
    expect(appStatus(ready({ release: null }), { now: at(2026, 10), maxAge: 12 })).toEqual({ ready: false, why: "no release pinned (--refresh resolves the latest)" });
  });
});

describe("--refresh — every app pinned to its latest release, or rejected", () => {
  const repos = {
    "o/fresh": { tag: "v2.1.0", published: "2026-09-20T10:00:00Z", license: "MIT", sha: "c".repeat(40) },
    "o/mixed": { tag: "v3.0.0", published: "2026-10-01T10:00:00Z", license: "NOASSERTION", sha: "d".repeat(40) },
    "o/old": { tag: "v0.9.0", published: "2025-08-30T10:00:00Z", license: "Apache-2.0", sha: "e".repeat(40) },
    "o/gone": 404,
    "o/img": { tag: "v5.0.0", published: "2026-08-02T10:00:00Z", license: "AGPL-3.0", sha: "f".repeat(40) },
  };
  const apps = () => ({
    fresh: ready({ repo: "https://github.com/o/fresh", release: { tag: "v2.0.0", published: "2026-05", commit: SHA } }),
    mixed: candidate({ repo: "https://github.com/o/mixed", license: "AGPL-3.0" }),
    old: candidate({ repo: "https://github.com/o/old", license: "Apache-2.0" }),
    gone: candidate({ repo: "https://github.com/o/gone", license: "MIT" }),
    img: candidate({ repo: "https://github.com/o/img", source: "image", image: "ghcr.io/o/img", image_tag: "{version}" }),
  });
  const docker = () => {
    const calls: string[][] = [];
    return { calls, runner: (argv: string[]) => (calls.push(argv), { status: 0, stdout: JSON.stringify({ mediaType: "x", digest: DIGEST }), stderr: "" }) };
  };

  it("pins the latest release (tag, month, commit or image digest) and rejects an unmaintained app, a license GitHub does not confirm, and an app with no release", async () => {
    const gh = fakeGitHub(repos);
    const d = docker();
    const r = await refreshManifest(manifest(apps()), { fetchJson: gh.fetchJson, runner: d.runner, now: OCTOBER });
    expect(r.manifest.apps.fresh.release).toEqual({ tag: "v2.1.0", published: "2026-09", commit: "c".repeat(40) });
    expect(r.manifest.apps.img.release).toEqual({ tag: "v5.0.0", published: "2026-08", digest: DIGEST });
    for (const id of ["mixed", "old", "gone"]) expect(r.manifest.apps[id].release, id).toBeNull();
    expect(d.calls).toEqual([["docker", "buildx", "imagetools", "inspect", "ghcr.io/o/img:5.0.0", "--format", "{{json .Manifest}}"]]);
    expect(r.lines).toEqual([
      `fresh: v2.1.0 (2026-09) commit ${"c".repeat(12)} (was v2.0.0)`,
      "rejected mixed: GitHub reads its license as NOASSERTION, not AGPL-3.0 (only an OSI license GitHub confirms is measured)",
      "rejected old: its latest release v0.9.0 is from 2025-08, older than 12 months: unmaintained",
      "rejected gone: no latest release (GitHub answered 404)",
      `img: v5.0.0 (2026-08) image ${DIGEST.slice(0, 19)} (new)`,
    ]);
    expect(validateManifest(r.manifest).errors).toEqual([]);
  });

  it("through the CLI: rewrites the manifest's pins and nothing else; a GitHub it cannot reach leaves the file as it was", async () => {
    const file = write(manifest(apps()));
    const before = readFileSync(file, "utf8");
    const r = await main(["--local", file, "--refresh"], { fetchJson: fakeGitHub(repos).fetchJson, runner: docker().runner, today: () => OCTOBER });
    expect(r.code, r.lines.join("\n")).toBe(0);
    const after = JSON.parse(readFileSync(file, "utf8"));
    expect(after.apps.fresh.release.tag).toBe("v2.1.0");
    const strip = (m: Obj) => ({ ...m, apps: Object.fromEntries(Object.entries(m.apps).map(([k, a]: [string, any]) => [k, { ...a, release: null }])) });
    expect(strip(after)).toEqual(strip(JSON.parse(before)));
    expect(r.lines.at(-1)).toBe(`wrote ${file}: 2 apps pinned, 3 rejected`);
    const broken = write(manifest(apps()));
    const was = readFileSync(broken, "utf8");
    const down = await main(["--local", broken, "--refresh"], { fetchJson: async () => { throw new Error("getaddrinfo ENOTFOUND api.github.com"); }, runner: docker().runner, today: () => OCTOBER });
    expect(down).toEqual({ code: 1, lines: ["refused: taste-calibrate: GitHub could not be reached (getaddrinfo ENOTFOUND api.github.com): the manifest is unchanged"] });
    expect(readFileSync(broken, "utf8")).toBe(was);
  });
});

describe("the CLI — --local's plan, its refusals", () => {
  it("without --network: validates the manifest and the bar and prints the plan; nothing is fetched, started or written", async () => {
    const u = untouchable();
    const out = barCopy();
    const r = await main(["--local", MANIFEST, "--out", out], u.deps);
    expect(r.code, r.lines.join("\n")).toBe(0);
    expect(r.lines[0]).toBe("taste-calibrate --local: the plan (nothing fetched: --network fetches, runs and measures, on a maintainer's machine only)");
    expect(r.lines).toContain("7 apps: 0 ready, 7 not; each ready app: 3 app, 2 form and 2 data routes at widths 390 and 1440, light and dark; a release older than 12 months is unmaintained");
    expect(r.lines.some((l: string) => /^twenty \(AGPL-3\.0, git\): not ready: no live config; no routes; /.test(l))).toBe(true);
    expect(r.lines).toContain("the bar: no band yet");
    expect(u.touched).toEqual([]);
    expect(readFileSync(out, "utf8")).toBe(readFileSync(BAR_FILE, "utf8"));
  });

  it("the plan names each ready app's routes and pin, and each archetype's calibration month, stale or not", async () => {
    const u = untouchable();
    const out = barCopy();
    const band = { n: 15, sites: 5, p10: 1, p50: 2, p90: 3, urls: ["https://github.com/o/r/releases/tag/v1"] };
    writeFileSync(out, `${JSON.stringify({ ...JSON.parse(readFileSync(BAR_FILE, "utf8")), probe: "0".repeat(64), archetypes: { app: { calibrated: "2025-09", widths: { "1440": { distinct_spacing: band } } }, data: { calibrated: "2026-09", widths: { "390": { distinct_spacing: band } } } } }, null, 2)}\n`);
    const r = await main(["--local", write(manifest({ a: ready() })), "--out", out], u.deps);
    expect(r.code, r.lines.join("\n")).toBe(0);
    expect(r.lines).toContain(`a (MIT, git): ready: v1.0.0 (2026-09), commit ${"a".repeat(12)}; 7 routes`);
    expect(r.lines).toContain("  /settings/profile (form)");
    expect(r.lines).toContain("the bar: app calibrated 2025-09 (stale: over 12 months), data calibrated 2026-09");
    expect(u.touched).toEqual([]);
  });

  it("refuses --local with --corpus, --refresh with --network or --out, --local without --out, and --diff without --network", async () => {
    const m = write(manifest({ a: ready() }));
    const out = barCopy();
    const first = async (argv: string[]) => (await main(argv, untouchable().deps)).lines[0];
    expect(await first(["--local", m, "--corpus", m, "--out", out])).toBe("refused: taste-calibrate: --local and --corpus are two corpora: name one");
    expect(await first(["--local", m, "--refresh", "--network"])).toBe("refused: taste-calibrate: --refresh only rewrites the manifest's pins: run it alone, then --network");
    expect(await first(["--local", m, "--refresh", "--out", out])).toBe("refused: taste-calibrate: --refresh only rewrites the manifest's pins: run it alone, then --network");
    expect(await first(["--local", m])).toBe("refused: taste-calibrate: --out is required (the bar the bands go into)");
    expect(await first(["--local", m, "--out", out, "--diff"])).toBe("refused: taste-calibrate: --diff compares a new calibration with the bar, so it needs --network");
    expect(await first(["--refresh"])).toBe("refused: taste-calibrate: --refresh needs --local <manifest>");
    expect((await main(["--local", write(manifest({ a: ready({ license: "BUSL-1.1" }) })), "--out", out], untouchable().deps)).lines[0]).toMatch(/^refused: taste-calibrate: the manifest is broken: apps\.a\.license must be an OSI-approved license/);
  });

  it("with --network: refuses before anything is fetched when no app is ready, or when a pin is not the app's latest release", async () => {
    const out = barCopy();
    const none = untouchable();
    expect((await main(["--local", write(manifest({ c: candidate() })), "--network", "--out", out], none.deps)).lines).toEqual(["refused: taste-calibrate: no app of the manifest is ready (a live config, 7 routes and a maintained release pinned): nothing fetched"]);
    expect(none.touched).toEqual([]);
    const behind = untouchable();
    const gh = fakeGitHub({ "example/fixture-a": { tag: "v1.1.0", published: "2026-10-02T00:00:00Z", license: "MIT", sha: "9".repeat(40) } });
    const r = await main(["--local", write(manifest({ a: ready() })), "--network", "--out", out], { ...behind.deps, fetchJson: gh.fetchJson });
    expect(r).toEqual({ code: 1, lines: ["refused: taste-calibrate: a's latest release is v1.1.0, but the manifest pins v1.0.0: run --refresh, review its diff, then measure: nothing fetched"] });
    expect(behind.touched).toEqual([]);
    expect(readFileSync(out, "utf8")).toBe(readFileSync(BAR_FILE, "utf8"));
  });
});

describe("themedMetrics — a screen's census per colour scheme", () => {
  const bar = JSON.parse(readFileSync(BAR_FILE, "utf8"));
  it("a light row and a dark row when the page answers dark, the light one alone when it does not, and never a string", () => {
    const census = (n: number) => ({ metrics: { distinct_spacing: n, primary_actions: 1 }, label: "Buy now" });
    const both = themedMetrics({ census: { media: {}, light: census(4), dark: census(5), reduce: null, themes: "dual" }, ease: { metrics: { vague_labels: 0 } } }, bar);
    expect(both).toEqual([
      { theme: "light", metrics: { distinct_spacing: 4, primary_actions: 1, vague_labels: 0 } },
      { theme: "dark", metrics: { distinct_spacing: 5, primary_actions: 1, vague_labels: 0 } },
    ]);
    expect(themedMetrics({ census: { light: census(4), dark: null, themes: "single" }, ease: {} }, bar).map((x: Obj) => x.theme)).toEqual(["light"]);
  });
});

describe("--network end to end: a fixture app fetched by commit, run by the lane's up/down, measured, deleted", () => {
  /** The fixture app committed in a repository of its own → its directory and commit. */
  const fixtureRepo = () => {
    const dir = tempDir();
    execFileSync("git", ["-C", dir, "init", "-q"]);
    cpSync(join(FIXTURE, "server.mjs"), join(dir, "server.mjs"));
    execFileSync("git", ["-C", dir, "add", "."]);
    execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"]);
    return { dir, sha: execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim() };
  };
  const fixtureProcs = () =>
    execFileSync("ps", ["-A", "-ww", "-o", "pid=", "-o", "command="], { encoding: "utf8" })
      .split("\n")
      .filter((l) => l.includes(MARK));

  it("writes per-archetype, per-width bands of numbers (light and dark), names each app by its release page, and leaves no app, process or file behind", async () => {
    const repo = fixtureRepo();
    const canary = `CANARY${"7".repeat(12)}`;
    // A password with characters an env file or a shell may mangle: it must reach the app as written.
    const app = (id: string, variant: string) => ready({ repo: `https://github.com/example/${id}`, release: { tag: "v1.0.0", published: "2026-09", commit: repo.sha }, live: live(variant), env: { APP_PW: `p"w\\ ${variant} #1&$x`, CANARY: canary } });
    const file = write(manifest({ "fixture-a": app("fixture-a", "a"), "fixture-b": app("fixture-b", "b") }));
    const out = barCopy();
    const tmp = tempDir();
    const gh = fakeGitHub(Object.fromEntries(["fixture-a", "fixture-b"].map((id) => [`example/${id}`, { tag: "v1.0.0", published: "2026-09-10T00:00:00Z", license: "MIT", sha: repo.sha }])));
    const fetched: string[] = [];
    const r = await main(["--local", file, "--network", "--diff", "--out", out], {
      fetchJson: gh.fetchJson,
      gitUrl: (a: Obj) => (fetched.push(a.repo), `file://${repo.dir}`),
      env: { PATH: `${fakeDocker()}:${process.env.PATH}`, HOME: homeWithCli() },
      tmpdir: tmp,
      today: () => OCTOBER,
    });
    const text = r.lines.join("\n");
    expect(r.code, text).toBe(0);
    expect(fetched).toEqual(["https://github.com/example/fixture-a", "https://github.com/example/fixture-b"]);
    const bar = JSON.parse(readFileSync(out, "utf8"));
    expect(validateBar(bar).errors).toEqual([]);
    expect(bar.probe).toBe(probeDigest());
    expect(Object.keys(bar.archetypes)).toEqual(["app", "form", "data"]);
    const urls = ["https://github.com/example/fixture-a/releases/tag/v1.0.0", "https://github.com/example/fixture-b/releases/tag/v1.0.0"];
    for (const a of ["app", "form", "data"]) {
      expect(bar.archetypes[a].calibrated, a).toBe("2026-10");
      expect(Object.keys(bar.archetypes[a].widths), a).toEqual(["390", "1440"]);
      // Each route at each width gives a light and a dark screen: the fixture answers prefers-color-scheme.
      const routes = a === "app" ? 3 : 2;
      for (const w of ["390", "1440"]) expect(bar.archetypes[a].widths[w].distinct_spacing, `${a} ${w}`).toMatchObject({ n: routes * 2 * 2, sites: 2, urls });
    }
    // Numbers, metric names and release pages only: no page text, no loopback address.
    for (const s of [JSON.stringify(bar), text]) {
      expect(s).not.toContain(canary);
      expect(s).not.toMatch(/localhost|127\.0\.0\.1/);
    }
    expect(text).toMatch(/^app 1440: 12 screens, 2 sites — thin \(a witness needs at least 5 sites and 15 pages\)$/m);
    for (const id of ["fixture-a", "fixture-b"]) expect(text).toMatch(new RegExp(`^${id} v1\\.0\\.0: measured 14 of 14 pages \\(28 screens\\); its instance is down and its files deleted$`, "m"));
    // Deleted: each app's temp dir gone, the lane's instance down, its processes gone.
    expect(readdirSync(tmp)).toEqual([]);
    expect(fixtureProcs()).toEqual([]);
  }, 600_000);
});
