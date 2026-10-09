// tests/argus-live-repro.test.ts — the journey lane's findings side on a real Chrome-family browser
// through the pinned CLI: the in-daemon hook every session gets at its open, and later the secret
// ledger, the repro runner, minimize, screenshot verdicts and the end-to-end cycle.
// A machine without Chrome or Edge fails here, never skips: the lane cannot run there either.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { alive, appCycle, browserCleanup, browserLeftovers, browserTools, candidate, fakeGh, fixtureProcs, PW, pwBrowserRun, tempDir, until } from "./helpers/argus-live";
// @ts-expect-error — plain ESM script without types
import { sessionName } from "../plugins/sapu/scripts/argus-live-cli.mjs";
// @ts-expect-error — plain ESM script without types
import { expandConfig, loadLive } from "../plugins/sapu/scripts/argus-live-config.mjs";
// @ts-expect-error — plain ESM script without types
import { ledgerFile, readLedger, readSeen, seenFile } from "../plugins/sapu/scripts/argus-live-ledger.mjs";
// @ts-expect-error — plain ESM script without types
import { runCode } from "../plugins/sapu/scripts/argus-live-login.mjs";
// @ts-expect-error — plain ESM script without types
import { runOnce } from "../plugins/sapu/scripts/argus-live-repro.mjs";
// @ts-expect-error — plain ESM script without types
import { readRun, updateRun } from "../plugins/sapu/scripts/argus-live-run.mjs";
// @ts-expect-error — plain ESM script without types
import { sessionDriver } from "../plugins/sapu/scripts/argus-live-session.mjs";

type Obj = Record<string, any>;

let cli: { dir: string; js: string };
beforeAll(() => {
  ({ cli } = browserTools());
}, 600_000);

afterEach(browserCleanup, 60_000);

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
/** The fence's body (the first line of a pw answer) and the lines outside it. */
const fenced = (r: { out: string[] }) => r.out[0];
const outside = (r: { out: string[] }) => r.out.slice(1);
/** A target=_blank rel=opener link whose popup's toast comes 200 ms after load and goes 300 ms later: before the click's own observation can look. */
const QUICK = "getByRole('link', { name: 'Open quick details' })";

type Run = Awaited<ReturnType<typeof pwBrowserRun>>;

/** A test's own code in buyer.1's session of slot 1 (as the wrapper runs its stages) → its result. */
const inSession = (t: Run, code: string) => runCode({ js: cli.js, session: sessionName(t.runId, 1, "buyer.1"), cwd: t.dir, home: t.home, code });

/** buyer.1's session driver of slot 1, in this process, over run.json and the config as they stand. */
const driverOf = (t: Run, extra: Obj = {}) => {
  const rec = readRun(t.main);
  const { config, secrets } = loadLive(t.main);
  const live = expandConfig(config, { ports: { ...(rec.ports ?? {}) }, secrets });
  return sessionDriver({ main: t.main, runId: t.runId, slot: 1, account: "buyer.1", rec, live, envSecrets: secrets, slotRec: rec.slots["1"], dir: t.dir, js: cli.js, ...extra });
};

describe("argus-live hook — every document watched", () => {
  it("a popup a link opened is watched from its first document", async () => {
    const t = await pwBrowserRun();
    expect((await t.call("buyer.1", "goto", "/popup")).code).toBe(0);
    const clicked = await t.call("buyer.1", "click", QUICK);
    expect(clicked.code).toBe(0);
    await sleep(1000); // the toast came and went with the popup's first document
    expect(`${fenced(clicked)}\n${fenced(await t.call("buyer.1", "tab-list"))}`).toContain("signal status: Quick ready");
  }, 180_000);

  it("the hook installs once per context", async () => {
    const t = await pwBrowserRun();
    expect((await t.call("buyer.1", "goto", "/")).code).toBe(0);
    const read = () => inSession(t, `async page => {\n  const c = page.context();\n  return { request: c.listenerCount("request"), response: c.listenerCount("response"), page: c.listenerCount("page"), keys: c.__argus ? Object.keys(c.__argus) : null };\n}\n`);
    const first = await read();
    expect((await t.call("buyer.1", "goto", "/orders/new")).code).toBe(0);
    const second = await read();
    // The CLI may hold listeners of its own: only the deltas are asserted.
    for (const k of ["request", "response", "page"]) expect(second[k] - first[k], k).toBe(0);
    expect(first.keys).toEqual(["seen", "bytes", "overflow", "headers", "errors", "leaves", "paths"]);
  }, 180_000);

  it("header values are recorded once, and overflow is flagged", async () => {
    const t = await pwBrowserRun();
    const { bearers } = JSON.parse(readFileSync(join(t.appEnv.DATA_DIR, "bearer.json"), "utf8"));
    const d = driverOf(t);
    await d.ensure();
    expect((await d.signIn()).ok).toBe(true);
    const drained: string[][] = [];
    for (let i = 0; i < 2; i++) {
      expect((await d.cli(["goto", "--", `${t.base}/storage`])).code).toBe(0);
      await sleep(500);
      const { o, events } = await d.observe();
      expect(events).toEqual([]);
      drained.push(...o.secrets.headers);
    }
    expect(drained.filter(([n, v]) => n === "authorization" && v === `Bearer ${bearers[0]}`)).toHaveLength(1);
    // A context past its byte cap records nothing more and says so: the session opened again with a small one.
    const small = driverOf(t, { capBytes: 64 });
    const { record } = await small.ensure();
    expect(await small.reopen(record)).toEqual(["session-reopened: buyer.1"]);
    expect((await small.cli(["goto", "--", `${t.base}/storage`])).code).toBe(0);
    await sleep(500);
    const { o } = await small.observe();
    expect(o.secrets.overflow).toBe(true);
  }, 180_000);

  it("a reopened session gets the hook again", async () => {
    const t = await pwBrowserRun();
    expect((await t.call("buyer.1", "goto", "/")).code).toBe(0);
    const rec = readRun(t.main).sessions.find((s: Obj) => s.account === "buyer.1");
    process.kill(-rec.browser.pid, "SIGKILL");
    expect(await until(() => !alive(rec.daemon.pid), 15_000)).toBe(true);
    const r = await t.call("buyer.1", "goto", "/popup");
    expect(outside(r)).toContain("session-reopened: buyer.1");
    expect((await t.call("buyer.1", "goto", "/popup")).code).toBe(0);
    const clicked = await t.call("buyer.1", "click", QUICK);
    expect(clicked.code).toBe(0);
    await sleep(1000);
    expect(`${fenced(clicked)}\n${fenced(await t.call("buyer.1", "tab-list"))}`).toContain("signal status: Quick ready");
  }, 180_000);
});

describe("argus-live ledger in Chrome", () => {
  /** Marks this describe's fixture processes (appCycle): other test files run the fixture at the same time. */
  const MARK = "--from=argus-live-ledger-tests";
  afterEach(() => {
    for (const l of fixtureProcs(MARK)) {
      try {
        process.kill(Number(l.trim().split(/\s+/)[0]), "SIGKILL");
      } catch {
        // gone
      }
    }
  });
  const values = (main: string, runId: string) => (readLedger(main, runId)?.entries ?? []).map((e: Obj) => e.v);
  const storageOf = (data: string) => JSON.parse(readFileSync(join(data, "bearer.json"), "utf8"));

  it("observation records the HttpOnly cookie, the jwt and the bearer token, never in pw's output", async () => {
    const t = await pwBrowserRun();
    const go = await t.call("buyer.1", "goto", "/storage");
    expect(go.code).toBe(0);
    const { bearers, jwt } = storageOf(t.appEnv.DATA_DIR);
    const sessions = JSON.parse(readFileSync(join(t.appEnv.DATA_DIR, "sessions.json"), "utf8"));
    const sid = Object.keys(sessions).find((k) => sessions[k].user === "buyer1@example.test")!;
    expect(statSync(ledgerFile(t.main, t.runId)).mode & 0o777).toBe(0o600);
    const kept = values(t.main, t.runId);
    for (const v of [sid, jwt, bearers[0], `Bearer ${bearers[0]}`]) expect(kept).toContain(v);
    expect(readLedger(t.main, t.runId).entries).toContainEqual({ c: "cookie", v: sid });
    expect(kept).not.toContain("dark-mode-on");
    expect(readLedger(t.main, t.runId).incomplete).toBeNull();
    for (const v of [sid, jwt, bearers[0]]) expect(go.out.join("\n")).not.toContain(v);
  }, 180_000);

  it("the ids the run saw are kept, tokens are not", async () => {
    const t = await pwBrowserRun();
    expect((await t.call("buyer.1", "goto", "/storage")).code).toBe(0);
    expect((await t.call("buyer.1", "snapshot")).code).toBe(0);
    const seen = [...readSeen(t.main, t.runId)];
    expect(seen).toContain("ck9a8b7c6d5e4f3g2h1i0j9k8");
    for (const v of ["rk7b6a5c4d3e2f1g0h9i8j7k6", "cd4e5f6a7b8c9d0e1f2a3b4c5d", "eyJhbGciOiJIUzI1NiJ9x1y2z3a4b5"]) expect(seen).not.toContain(v);
    expect(seen.filter((v) => v.startsWith("tok_"))).toEqual([]);
    expect(statSync(seenFile(t.main, t.runId)).mode & 0o777).toBe(0o600);
  }, 180_000);

  /** A full up of the fixture app, slot 1 holding buyer.1, and `pw goto /storage` returned before the page's second bearer → the cycle, its run id and that bearer. */
  const storageCycle = () => {
    const c = appCycle({ clerk: false, mark: MARK });
    const { summary } = c.up();
    const token = c.slot(1, "buyer.1=buyer1@example.test");
    expect(c.cli("pw", token, "buyer.1", "goto", "/storage").code).toBe(0);
    const second = storageOf(c.data).bearers[1];
    // The pw call's own drain ran before the page asked with its second bearer (2000 ms after load).
    expect(values(c.main, summary.runId)).not.toContain(second);
    return { c, runId: summary.runId as string, second };
  };

  it("down drains every session before it closes it", async () => {
    const { c, runId, second } = storageCycle();
    await sleep(3000);
    const d = c.cli("down");
    expect(d.code, d.err).toBe(0);
    expect(values(c.main, runId)).toContain(second);
    expect(readLedger(c.main, runId).incomplete).toBeNull();
  }, 300_000);

  it("up --fresh drains every session it closes", async () => {
    const { c, runId, second } = storageCycle();
    await sleep(3000);
    const f = c.cli("up", "--fresh");
    expect(f.code, f.err).toBe(0);
    expect(values(c.main, runId)).toContain(second);
    expect(readLedger(c.main, runId).incomplete).toBeNull();
    expect(c.cli("down").code).toBe(0);
  }, 300_000);

  it("the ledger survives down and the next up removes it", async () => {
    const { c, runId } = storageCycle();
    expect(c.cli("down").code).toBe(0);
    expect(statSync(ledgerFile(c.main, runId)).mode & 0o777).toBe(0o600);
    expect(existsSync(seenFile(c.main, runId))).toBe(true);
    const { summary } = c.up();
    expect(summary.runId).not.toBe(runId);
    expect(existsSync(ledgerFile(c.main, runId))).toBe(false);
    expect(existsSync(seenFile(c.main, runId))).toBe(true);
    expect(c.cli("down").code).toBe(0);
  }, 300_000);

  it("a created account's password is in the ledger", async () => {
    const t = await pwBrowserRun();
    const before = readRun(t.main).loginFailed;
    const r = await t.call("buyer.1", "login", "new@example.test", "Secret-pw-1");
    expect(r.out.at(-1)).toBe("login: failed (rejected)");
    expect(readLedger(t.main, t.runId).entries).toContainEqual({ c: "created password", v: "Secret-pw-1" });
    expect(readRun(t.main).loginFailed).toEqual(before);
  }, 180_000);
});

describe("argus-live screenshot verdicts", () => {
  it("each screenshot gets a verdict at capture time, after its call's drain, over every frame, hashed, holding no page text", async () => {
    const t = await pwBrowserRun();
    const out = join(t.dir, "out");
    /** `account`'s screenshot through pw → the PNG it wrote and the verdict beside it. */
    const shoot = async (account: string) => {
      const before = new Set(existsSync(out) ? readdirSync(out) : []);
      const r = await t.call(account, "screenshot");
      expect(r.code, r.out.join("\n")).toBe(0);
      expect(r.out.join("\n")).not.toMatch(/verdict|secret|password-field/);
      const png = readdirSync(out).filter((f) => f.endsWith(".png") && !before.has(f));
      expect(png).toHaveLength(1);
      const file = join(out, png[0].replace(/\.png$/, ".verdict.json"));
      expect(statSync(file).mode & 0o777).toBe(0o600);
      return { png: join(out, png[0]), raw: readFileSync(file, "utf8"), v: JSON.parse(readFileSync(file, "utf8")) };
    };
    const shots = [];
    expect((await t.call("buyer.1", "goto", "/inject?echo=1")).code).toBe(0);
    shots.push(await shoot("buyer.1"));
    expect(shots.at(-1)!.v).toMatchObject({ passed: false, reasons: ["secret"] });
    expect((await t.call("anon.1", "goto", "/login")).code).toBe(0);
    shots.push(await shoot("anon.1"));
    expect(shots.at(-1)!.v).toMatchObject({ passed: false, reasons: ["password-field"] });
    expect((await t.call("buyer.1", "goto", "/orders/new")).code).toBe(0);
    shots.push(await shoot("buyer.1"));
    expect(shots.at(-1)!.v).toMatchObject({ passed: true, reasons: [] });
    expect(shots.at(-1)!.v.sha256).toBe(createHash("sha256").update(readFileSync(shots.at(-1)!.png)).digest("hex"));
    // The env file's value only inside an iframe: every frame is read.
    expect((await t.call("buyer.1", "goto", "/frame?echo=1")).code).toBe(0);
    shots.push(await shoot("buyer.1"));
    expect(shots.at(-1)!.v).toMatchObject({ passed: false, reasons: ["secret"] });
    // The second bearer reaches the ledger only through the screenshot call's own drain, before its verdict.
    expect((await t.call("buyer.1", "goto", "/storage?show=1")).code).toBe(0);
    const second = JSON.parse(readFileSync(join(t.appEnv.DATA_DIR, "bearer.json"), "utf8")).bearers[1];
    expect((readLedger(t.main, t.runId)?.entries ?? []).map((e: Obj) => e.v)).not.toContain(second);
    await sleep(3000);
    shots.push(await shoot("buyer.1"));
    expect(shots.at(-1)!.v).toMatchObject({ passed: false, reasons: ["secret"] });
    for (const s of shots) {
      expect(Object.keys(s.v).sort()).toEqual(["passed", "reasons", "sha256", "t"]);
      expect(s.raw).not.toContain("Quantity");
      expect(Buffer.byteLength(s.raw)).toBeLessThanOrEqual(200);
    }
  }, 300_000);
});

describe("argus-live repro — one run", () => {
  /** Marks this describe's fixture processes (appCycle): other test files run the fixture at the same time. */
  const MARK = "--from=argus-live-repro-tests";
  afterEach(() => {
    for (const l of fixtureProcs(MARK)) {
      try {
        process.kill(Number(l.trim().split(/\s+/)[0]), "SIGKILL");
      } catch {
        // gone
      }
    }
  });
  /** Every account a repro here names: clerk.1 is clerk2 (no TOTP), clerk.2 clerk1 (a TOTP code each sign-in). */
  const ACCOUNTS = "buyer.1=buyer1@example.test,buyer.2=buyer2@example.test,clerk.1=clerk2@example.test,clerk.2=clerk1@example.test,anon.1";
  /** The words a run prints outside its fence (decision 8). */
  const VOCABULARY = /^(fresh: instance [0-9a-f]+|step \d+ (system|[a-z][a-z0-9_-]*\.\d+) [a-z-]+: (ok|held|failed|changed-state)|truncated \d+ characters)$/;
  const REPRODUCED = /^REPRODUCED step=\d+ expected=[a-z-]+(:\d+)? observed=[a-z-]+(:\d+)?$/;

  /** A repro cycle (appCycle with `repro`) up, and its candidates' refs for `repros`, all in slot 1. */
  const reproCycle = async (repros: Obj[][]) => {
    const c = appCycle({ mark: MARK, repro: true });
    const { summary } = c.up();
    const refs = await candidate(c.main, { slot: 1, accounts: ACCOUNTS, repros });
    /** `repro <ref> --once` through the CLI → its exit, its lines outside the fence, the fence, its last line. */
    const repro = (ref: string) => {
      const r = c.cli("repro", ref, "--once");
      const all = r.out.trimEnd().split("\n");
      const open = all.findIndex((l) => /^<<<PAGE-[0-9a-f]{32}$/.test(l));
      const close = open < 0 ? -1 : all.findIndex((l, i) => i > open && l === `${all[open].slice(3)}>>>`);
      const fenceText = open < 0 ? null : all.slice(open + 1, close).join("\n");
      const outside = open < 0 ? all : [...all.slice(0, open), ...all.slice(close + 1)];
      return { code: r.code, err: r.err, lines: outside.slice(0, -1), last: outside.at(-1), fence: fenceText };
    };
    const record = (ref: string, i = 1) => JSON.parse(readFileSync(join(c.main, ".argus/live", summary.runId, "repro", ref, `run-${i}.json`), "utf8"));
    return { c, runId: summary.runId as string, refs, repro, record, rDir: join(c.main, ".argus/live", summary.runId, "r") };
  };
  /** buyer.1 places an order of `quantity` and saves its number as `order`. */
  const PLACE = (quantity = "1"): Obj[] => [
    { as: "buyer.1", do: "goto", path: "/orders/new" },
    { as: "buyer.1", do: "fill", target: { label: "Quantity" }, value: quantity },
    { as: "buyer.1", do: "click", target: { role: "button", name: "Place order" } },
    { as: "buyer.1", do: "read", target: { testId: "order-number" }, save: "order" },
    { as: "buyer.1", expect: "visible", target: { testId: "order-number" } },
  ];
  const CANCEL: Obj[] = [
    { as: "buyer.1", do: "click", target: { role: "button", name: "Cancel order" } },
    { as: "buyer.1", expect: "hidden", target: { role: "button", name: "Cancel order" } },
  ];
  const WELCOME = { as: "buyer.1", expect: "visible", target: { role: "heading", name: "Welcome" }, final: "discoverability" };

  /** Each oracle's repro, written from §10's templates, and the defect that breaks it. */
  const ORACLE_REPROS: [string, Obj[]][] = [
    ["missing-handoff", [...PLACE(), { as: "clerk.1", do: "goto", path: "/inbox" }, { as: "clerk.1", expect: "visible", target: { text: "{{order}}" }, final: "handoff" }]],
    ["dead-end", [...PLACE(), { as: "clerk.1", do: "goto", path: "/orders/{{order}}" }, { as: "clerk.1", do: "click", target: { role: "button", name: "Approve" } }, { as: "clerk.1", expect: "visible", target: { role: "button", name: "Ship" } }, { as: "clerk.1", expect: "enabled", target: { role: "button", name: "Ship" }, final: "dead-end" }]],
    ["double-release", [{ as: "buyer.1", do: "goto", path: "/stock" }, { as: "buyer.1", do: "read", target: { testId: "stock" }, save: "before" }, ...PLACE("2"), ...CANCEL, { as: "buyer.1", expect: "fact-equals", marker: "{{order}}", field: "stock", value: "{{before}}", final: "reversal" }]],
    [
      "claim-race",
      [
        ...PLACE(),
        { as: "clerk.1", do: "goto", path: "/inbox" },
        { as: "clerk.2", do: "goto", path: "/inbox" },
        { parallel: [{ as: "clerk.1", do: "click", target: { role: "button", name: "Claim" } }, { as: "clerk.2", do: "click", target: { role: "button", name: "Claim" } }] },
        { as: "clerk.1", expect: "visible", target: { testId: "claim", nth: 0 } },
        { as: "clerk.2", expect: "visible", target: { testId: "claim", nth: 0 } },
        { as: "clerk.1", do: "reload" },
        { as: "clerk.1", expect: "count", target: { testId: "claim" }, value: 1, final: "claim-race" },
      ],
    ],
    [
      "stale-view",
      [
        ...PLACE(),
        { as: "clerk.1", do: "goto", path: "/orders/{{order}}" },
        { as: "clerk.1", expect: "visible", target: { role: "button", name: "Approve" } },
        ...CANCEL,
        { as: "clerk.1", do: "click", target: { role: "button", name: "Approve" } },
        { as: "clerk.1", expect: "visible", target: { testId: "order-number" } },
        { as: "clerk.1", expect: "fact-equals", marker: "{{order}}", field: "status", value: "cancelled", final: "stale-view" },
      ],
    ],
    ["orphaned", [...PLACE(), ...CANCEL, { as: "clerk.1", do: "goto", path: "/inbox" }, { as: "clerk.1", expect: "hidden", target: { text: "{{order}}" }, final: "orphaned-work" }]],
  ];

  it("each seeded oracle defect reproduces, and its fixed variant does not", async () => {
    const t = await reproCycle(ORACLE_REPROS.map(([, r]) => r));
    for (const [k, [defect]] of ORACLE_REPROS.entries()) {
      t.c.defects(defect);
      const on = t.repro(t.refs[k]);
      expect(on.code, `${defect} on: ${on.lines.join(" | ")} ${on.last} ${on.err}`).toBe(3);
      expect(on.last, defect).toMatch(REPRODUCED);
      for (const l of on.lines) expect(l, defect).toMatch(VOCABULARY);
      expect(on.fence, defect).not.toBeNull();
      t.c.defects();
      const off = t.repro(t.refs[k]);
      expect(off.code, `${defect} off: ${off.lines.join(" | ")} ${off.last} ${off.err}`).toBe(0);
      expect(off.last, defect).toBe("NOT REPRODUCED");
      for (const l of off.lines) expect(l, defect).toMatch(VOCABULARY);
    }
    // What each reproduced: the oracle's final, and what the page showed in the run's words.
    expect(t.record(t.refs[0])).toMatchObject({ exit: 0, step: 7 });
    t.c.defects("claim-race");
    const race = t.repro(t.refs[3]);
    expect(race.last).toBe("REPRODUCED step=13 expected=count:1 observed=count:2");
    expect(race.lines).toContain("step 8 clerk.1 click: changed-state");
    expect(race.lines).toContain("step 9 clerk.2 click: changed-state");
  }, 1_800_000);

  it("a viewport defect reproduces at 390 and not at 1440; the delayed handoff is not a defect", async () => {
    const narrow = (viewport: number) => [{ context: { viewport } }, { as: "buyer.1", do: "goto", path: "/orders/new" }, { as: "buyer.1", expect: "visible", target: { role: "button", name: "Place order" }, final: "viewport-locale" }];
    // The clerk's inbox is open before the order is placed: the handoff lands 2000 ms later, within settle_ms.
    const delayed = [{ as: "clerk.1", do: "goto", path: "/inbox" }, ...PLACE(), { as: "clerk.1", expect: "visible", target: { text: "{{order}}" }, final: "handoff" }];
    const t = await reproCycle([narrow(390), narrow(1440), delayed]);
    t.c.defects("narrow-viewport");
    const small = t.repro(t.refs[0]);
    expect(small.code, small.lines.join(" | ")).toBe(3);
    expect(small.last).toBe("REPRODUCED step=2 expected=visible observed=absent");
    expect(t.repro(t.refs[1]).code).toBe(0);
    t.c.defects("delayed-handoff");
    const late = t.repro(t.refs[2]);
    expect(late.code, late.lines.join(" | ")).toBe(0);
    expect(late.lines).toContain("step 7 clerk.1 visible: held");
    t.c.defects("missing-handoff");
    expect(t.repro(t.refs[2]).code).toBe(3);
  }, 900_000);

  it("exit 2 on a broken target, a dropped prerequisite, a missing proving expect and an uncaught error", async () => {
    const t = await reproCycle([
      [{ as: "buyer.1", do: "goto", path: "/orders/new" }, { as: "buyer.1", do: "fill", target: { label: "Quantity" }, value: "1" }, { as: "buyer.1", do: "click", target: { testId: "nope" } }, { ...WELCOME }],
      [...PLACE(), { as: "buyer.1", expect: "fact-equals", marker: "{{order}}", field: "status", value: "paid" }, { as: "buyer.1", expect: "visible", target: { testId: "order-number" }, final: "discoverability" }],
      [{ as: "buyer.1", do: "goto", path: "/orders/new" }, { as: "buyer.1", do: "fill", target: { label: "Quantity" }, value: "1" }, { as: "buyer.1", do: "click", target: { role: "button", name: "Place order" } }, { as: "buyer.1", do: "goto", path: "/" }, { ...WELCOME }],
    ]);
    const missing = t.repro(t.refs[0]);
    expect([missing.code, missing.last]).toEqual([2, "HARNESS: step 3 missing target"]);
    const dropped = t.repro(t.refs[1]);
    expect([dropped.code, dropped.last]).toEqual([2, "HARNESS: step 6 expectation failed before the final step"]);
    expect(dropped.lines.at(-1)).toBe("step 6 buyer.1 fact-equals: failed");
    const unproved = t.repro(t.refs[2]);
    expect([unproved.code, unproved.last]).toEqual([2, "HARNESS: step 3 changed state (a POST request) with no proving expect"]);
    for (const r of [missing, dropped, unproved]) for (const l of r.lines) expect(l).toMatch(VOCABULARY);
    // Each run's record says how it ended.
    expect(t.record(t.refs[0])).toMatchObject({ exit: 2, step: 3 });
    expect(t.record(t.refs[2])).toMatchObject({ exit: 2, step: 3, changed: [3] });
    const boom = await runOnce(t.c.main, t.refs[0], { i: 2, fresh: async () => { throw new Error("boom"); } });
    expect(boom.code).toBe(2);
    expect(boom.lines).toEqual(["HARNESS: failed: boom"]);
    expect(t.record(t.refs[0], 2)).toMatchObject({ exit: 2, step: null });
  }, 900_000);

  it("a run's records are absent from the next run, and values with quotes are substituted as literals", async () => {
    const note = `O'Brien "x" \\ {{marker}}`;
    const t = await reproCycle([
      [...PLACE(), { as: "clerk.1", do: "goto", path: "/inbox" }, { as: "clerk.1", expect: "visible", target: { text: "{{order}}" }, final: "handoff" }],
      [{ as: "clerk.1", do: "goto", path: "/inbox" }, { as: "clerk.1", expect: "count", target: { testId: "inbox-item" }, value: 0 }, { as: "clerk.1", expect: "visible", target: { role: "heading", name: "Inbox" }, final: "discoverability" }],
      [
        { as: "buyer.1", do: "goto", path: "/orders/new" },
        { as: "buyer.1", do: "fill", target: { label: "Quantity" }, value: "1" },
        { as: "buyer.1", do: "fill", target: { label: "Note" }, value: note },
        { as: "buyer.1", do: "click", target: { role: "button", name: "Place order" } },
        { as: "buyer.1", do: "read", target: { testId: "order-number" }, save: "order" },
        { as: "buyer.1", expect: "visible", target: { testId: "order-number" } },
        { as: "buyer.1", expect: "text-equals", target: { testId: "note" }, value: note, final: "status-coherence" },
      ],
      [{ as: "system", do: "trigger", name: "settle", values: [";id"] }, { ...WELCOME }],
    ]);
    expect(t.repro(t.refs[0]).code).toBe(0);
    const next = t.repro(t.refs[1]);
    expect(next.code, next.lines.join(" | ")).toBe(0);
    expect(next.lines).toContain("step 2 clerk.1 count: held");
    const quoted = t.repro(t.refs[2]);
    expect(quoted.code, quoted.lines.join(" | ")).toBe(0);
    expect(quoted.lines).toContain("step 7 buyer.1 text-equals: held");
    expect(t.record(t.refs[2]).saved).toEqual({ order: "ORD-1" });
    const shell = t.repro(t.refs[3]);
    expect(shell.code).toBe(2);
    expect(shell.last).toBe("HARNESS: repro: step 1: value 1 of settle does not match ^[A-Za-z0-9][A-Za-z0-9._@:-]{0,127}$");
    expect(shell.lines).toEqual([]); // refused before any up --fresh: the hook never ran
  }, 900_000);

  it("a login step signs in an account the run created, and its failure is the run's only", async () => {
    const signUp = [
      { as: "anon.1", do: "goto", path: "/signup" },
      { as: "anon.1", do: "fill", target: { label: "Email" }, value: "{{marker}}@example.test" },
      { as: "anon.1", do: "fill", target: { label: "Password" }, value: "pw-{{marker}}" },
      { as: "anon.1", do: "click", target: { role: "button", name: "Sign up" } },
      { as: "anon.1", expect: "visible", target: { text: "Welcome {{marker}}@example.test" } },
    ];
    const t = await reproCycle([
      [...signUp, { as: "buyer.2", do: "login", user: "{{marker}}@example.test", password: "pw-{{marker}}" }, { as: "buyer.2", expect: "visible", target: { text: "Signed in as" } }, { as: "buyer.2", expect: "visible", target: { role: "heading", name: "Welcome" }, final: "discoverability" }],
      [{ as: "buyer.2", do: "login", user: "{{marker}}@example.test", password: "pw-never" }, { as: "buyer.2", expect: "visible", target: { text: "Signed in as" } }, { as: "buyer.2", expect: "visible", target: { role: "heading", name: "Welcome" }, final: "discoverability" }],
    ]);
    const ok = t.repro(t.refs[0]);
    expect(ok.code, `${ok.lines.join(" | ")} ${ok.last} ${ok.err}`).toBe(0);
    expect(ok.lines).toContain("step 6 buyer.2 login: ok");
    const passwords = (readLedger(t.c.main, t.runId)?.entries ?? []).filter((e: Obj) => e.c === "created password").map((e: Obj) => e.v);
    expect(passwords).toHaveLength(1);
    expect(passwords[0]).toMatch(/^pw-argus-[0-9a-f]{8}$/);
    const before = readRun(t.c.main).loginFailed;
    const bad = t.repro(t.refs[1]);
    expect([bad.code, bad.last]).toEqual([2, "HARNESS: step 1 buyer.2 login failed"]);
    const state = JSON.parse(readFileSync(join(t.rDir, "state.json"), "utf8"));
    expect(Object.keys(state.createdFailed)).toEqual([expect.stringMatching(/^buyer\/argus-[0-9a-f]{8}@example\.test$/)]);
    expect(readRun(t.c.main).loginFailed).toEqual(before);
  }, 900_000);

  it("an account whose login failed this cycle is never retried", async () => {
    const t = await reproCycle([[{ as: "buyer.1", do: "goto", path: "/" }, { ...WELCOME }]]);
    updateRun(t.c.main, t.runId, (prev: Obj) => ({ ...prev, loginFailed: { "buyer/buyer1@example.test": "rejected" } }));
    const logins = (await t.c.stats())["POST /login"] ?? 0;
    const r = t.repro(t.refs[0]);
    expect([r.code, r.last]).toEqual([2, "HARNESS: buyer.1 cannot sign in this cycle"]);
    expect(r.lines).toEqual([]);
    expect((await t.c.stats())["POST /login"] ?? 0).toBe(logins);
  }, 600_000);

  it("the run leaves a trace, begun after sign-in, and no session; down keeps only the traces of runs that exited 2", async () => {
    const t = await reproCycle([
      [{ as: "buyer.1", do: "goto", path: "/orders/new" }, { ...WELCOME, target: { role: "heading", name: "New order" } }],
      [{ as: "buyer.1", do: "goto", path: "/orders/new" }, { as: "buyer.1", do: "click", target: { testId: "nope" } }, { ...WELCOME }],
    ]);
    expect(t.repro(t.refs[0]).code).toBe(0);
    const ok = t.record(t.refs[0]);
    const tracesDir = join(t.rDir, "out/traces");
    expect(ok.traces.filter((f: string) => f.endsWith(".trace")).length).toBeGreaterThan(0);
    for (const f of ok.traces) expect(existsSync(join(tracesDir, f)), f).toBe(true);
    const forms = [PW, encodeURIComponent(PW), new URLSearchParams({ p: PW }).toString().slice(2), "user=buyer1%40example.test"];
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
    for (const f of files(tracesDir)) {
      const bytes = readFileSync(f, "latin1");
      for (const x of forms) expect(bytes.includes(x), `${f} holds ${x}`).toBe(false);
    }
    const ps = execFileSync("ps", ["-A", "-ww", "-o", "command="], { encoding: "utf8" });
    expect(ps).not.toContain(`cliDaemon.js ${t.runId}-r-`);
    expect((readRun(t.c.main).sessions ?? []).filter((x: Obj) => x.slot === "r")).toEqual([]);
    // An exit 2 keeps its traces for diagnosis; down prunes every other run's.
    expect(t.repro(t.refs[1]).code).toBe(2);
    const failed = t.record(t.refs[1]);
    const ownTrace = (r: Obj) => r.traces.filter((f: string) => /\.(trace|network)$/.test(f));
    expect(ownTrace(failed).length).toBeGreaterThan(0);
    expect(t.c.cli("down").code).toBe(0);
    for (const f of ownTrace(ok)) expect(existsSync(join(tracesDir, f)), f).toBe(false);
    for (const f of failed.traces) expect(existsSync(join(tracesDir, f)), f).toBe(true);
  }, 900_000);

  describe("argus-live — findings end to end", () => {
    // One cycle, every command spawned as the orchestrator and the explorer's Bash run them. The minimize
    // part is the padded reversal repro (its budget, limits.minimize_runs 6, is the repro cycle's).
    it("a candidate goes from an explorer's submit to a filed issue, and down leaves no secret outside the ledger", async () => {
      const reversal = ORACLE_REPROS.find(([d]) => d === "double-release")![1];
      // Padding after the cancel's proving expect, where minimize starts (from the last step back): a hover, a goto with its url expect, a read nobody uses.
      const padded = [
        ...reversal.slice(0, -1),
        { as: "buyer.1", do: "hover", target: { testId: "order-number" } },
        { as: "buyer.1", do: "goto", path: "/stock" },
        { as: "buyer.1", expect: "url", value: "/stock" },
        { as: "buyer.1", do: "read", target: { testId: "stock" }, save: "unused" },
        reversal.at(-1)!,
      ];
      const c = appCycle({ mark: MARK, repro: true });
      c.defects("double-release");
      const { summary } = c.up();
      const runId = summary.runId as string;
      const runDir = join(c.main, ".argus/live", runId);
      const mint = c.cli("slot", "1", "--journey", "order-to-cash", "--accounts", "buyer.1=buyer1@example.test");
      expect(mint.code, mint.err).toBe(0);
      const token = JSON.parse(mint.out).token as string;
      // The explorer: its pw calls, a screenshot, and a return whose candidate holds the reversal repro.
      const pw = (...args: string[]) => {
        const r = c.cli("pw", token, ...args);
        expect(r.code, `pw ${args.join(" ")}: ${r.out} ${r.err}`).toBe(0);
        return r;
      };
      pw("buyer.1", "goto", "/storage");
      pw("buyer.1", "goto", "/orders/new");
      pw("buyer.1", "fill", "getByLabel('Quantity')", "2");
      pw("buyer.1", "click", "getByRole('button', { name: 'Place order' })");
      const outDir = join(runDir, "1/out");
      const pngsBefore = new Set(existsSync(outDir) ? readdirSync(outDir) : []);
      pw("buyer.1", "screenshot");
      const png = readdirSync(outDir).filter((f) => f.endsWith(".png") && !pngsBefore.has(f));
      expect(png).toHaveLength(1);
      const shot = join(outDir, png[0]);
      const ret = { journey: "order-to-cash", status: "done", candidates: [{ claim: "a cancel puts the stock back twice", oracle: "reversal", repro: padded }] };
      expect(pw("submit", JSON.stringify(ret)).out.trim()).toBe("submitted: slot 1 generation 1 status done");
      // The explorer's HttpOnly sid, as the ledger recorded it (the next up --fresh resets the store).
      const ledgerOf = () => readFileSync(join(runDir, "logs/secrets.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
      const sessions = JSON.parse(readFileSync(join(c.data, "sessions.json"), "utf8"));
      const cookies = ledgerOf().filter((e: Obj) => e.c === "cookie").map((e: Obj) => e.v);
      const sid = Object.keys(sessions).find((k) => sessions[k].user === "buyer1@example.test" && cookies.includes(k))!;
      expect(sid).toMatch(/^[0-9a-f]{32}$/);

      // Two of two: run 1 and run 2 each reproduce, the verdict last.
      const ref = "1.1.1";
      const r = c.cli("repro", ref);
      expect(r.code, `${r.out} ${r.err}`).toBe(3);
      const lines = r.out.trimEnd().split("\n");
      expect(lines.some((l) => l.startsWith("run 1 step "))).toBe(true);
      expect(lines.some((l) => l.startsWith("run 2 step "))).toBe(true);
      expect(lines.at(-1)).toMatch(REPRODUCED);
      const dir = join(runDir, "repro", ref);
      const record = (i: number) => JSON.parse(readFileSync(join(dir, `run-${i}.json`), "utf8"));
      expect([record(1).exit, record(2).exit]).toEqual([3, 3]);

      // Minimize: only labels and exits; the four pads dropped; the cancel with its expect still fails the
      // final, but another way (the stock 4 under, not 4 over), so it stays.
      const m = c.cli("repro", ref, "--minimize");
      expect(m.code, m.err).toBe(0);
      expect(m.out.trimEnd().split("\n")).toEqual([
        "try step 13: exit 3",
        "try step 12: exit 3",
        "try step 11: exit 3",
        "try step 10: exit 3",
        "try steps 8+9: exit 3",
        "confirm: exit 3",
        `minimized ${ref}: steps 14 → 10, runs 6/6, stopped budget, confirmed yes`,
      ]);
      expect(JSON.parse(readFileSync(join(dir, "min.json"), "utf8"))).toEqual([{ context: { viewport: 1440, locale: "en-US", timezone: "UTC" } }, ...reversal]);
      // The minimized list on a run of its own (the confirm, run 8 after the two and five tries) fails as the reproducing run did.
      expect(record(8)).toMatchObject({ exit: 3, reduced: true, expected: "fact-equals", observed: "differs", shownSha256: record(2).shownSha256 });
      expect(record(7)).toMatchObject({ exit: 3, reduced: true });
      expect(record(7).shownSha256).not.toBe(record(2).shownSha256);
      // The candidate's own record is the whole list's, never a reduced one.
      expect(JSON.parse(readFileSync(join(dir, "repro.json"), "utf8")).repro).toEqual(padded);

      // The RED test, from the confirmed min.json.
      const red = c.cli("repro", ref, "--test");
      expect(red.code, red.err).toBe(0);
      const redFile = red.out.trim().replace(/^red test: /, "");
      expect(realpathSync(redFile)).toBe(realpathSync(join(dir, "red.spec.ts")));
      expect(() => stripTypeScriptTypes(readFileSync(redFile, "utf8"))).not.toThrow();

      const k = c.cli("classify", "--oracle", "reversal", "--stock");
      expect([k.code, k.out]).toEqual([0, "class A labels bug,argus,found-by:user severity S1 because reversal: a resource not released exactly once\n"]);

      // Scrub: the sid refuses, by place and class only; a clean body with the screenshot is filed through gh.
      const bodies = tempDir();
      const sidBody = join(bodies, "sid.md");
      writeFileSync(sidBody, `Cancelling twice.\n\nThe session was sid=${sid} then.\n`);
      const scrubSid = () => {
        const s = c.cli("scrub", "--ref", ref, "--title", "Cancel releases stock twice", "--body", sidBody);
        expect(s.code, s.err).toBe(1);
        const out = s.out.trimEnd().split("\n");
        expect(out.some((l) => /^body 3:\d+ cookie$/.test(l)), s.out).toBe(true);
        expect(out.at(-1)).toMatch(/^refused: scrub: \d+ secret\(s\) in the issue; nothing is filed$/);
        expect(`${s.out}${s.err}`).not.toContain(sid);
      };
      scrubSid();
      const gh = fakeGh();
      c.env.PATH = `${gh.dir}:${c.env.PATH}`;
      const clean = join(bodies, "clean.md");
      writeFileSync(clean, "A cancelled order puts its stock back twice.\n");
      const filed = c.cli("scrub", "--ref", ref, "--title", "Cancel releases stock twice", "--body", clean, "--attach", shot, "--create", "--label", "bug");
      expect(filed.code, `${filed.out} ${filed.err}`).toBe(0);
      expect(filed.out.trimEnd().split("\n")).toEqual(["scrub: ok; redacted 0, defanged 0, cut 0 line(s)", "title: Cancel releases stock twice", `attach: .argus/live/${runId}/1/out/${png[0]}`, "filed: https://github.com/o/r/issues/9"]);
      const create = gh.calls().find((x) => x.argv[0] === "issue")!;
      expect(create.argv).toContain("--attach");
      expect(create.argv.slice(create.argv.indexOf("--label"), create.argv.indexOf("--label") + 2)).toEqual(["--label", "bug"]);
      expect(create.argv.filter((a: string) => a.includes("traces"))).toEqual([]);
      expect(create.body).toBe("A cancelled order puts its stock back twice.\n");

      // down: the ledger and the candidate's records kept; no session file, slot state, lock or trace (every run exited 3); no process of the run.
      const d = c.cli("down");
      expect(d.code, d.err).toBe(0);
      expect(statSync(join(runDir, "logs/secrets.jsonl")).mode & 0o777).toBe(0o600);
      const files = (at: string): string[] => (existsSync(at) ? readdirSync(at, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(at, e.name)) : [join(at, e.name)])) : []);
      const left = files(runDir).map((f) => f.slice(runDir.length + 1));
      expect(left.filter((f) => /(^|\/)(\.playwright\/|state\.json$|lock$)/.test(f))).toEqual([]);
      expect(left.filter((f) => f.startsWith("r/out/traces/"))).toEqual([]);
      expect(existsSync(join(dir, "repro.json"))).toBe(true);
      expect(existsSync(join(dir, "red.spec.ts"))).toBe(true);
      const ofRun = () => execFileSync("ps", ["-A", "-ww", "-o", "command="], { encoding: "utf8" }).split("\n").filter((l) => l.includes(runId));
      expect(await until(() => ofRun().length === 0, 10_000), ofRun().join("\n")).toBe(true);

      // Scrub never needs the run live.
      scrubSid();
      const after = join(bodies, "after.md");
      writeFileSync(after, "A cancelled order puts its stock back twice.\n");
      expect(c.cli("scrub", "--ref", ref, "--title", "Cancel releases stock twice", "--body", after).code).toBe(0);

      // No stdout (but the mint's) and no file left under the run holds the role password or the slot token.
      const forms = [PW, encodeURIComponent(PW), new URLSearchParams({ p: PW }).toString().slice(2), JSON.stringify(PW).slice(1, -1)];
      const outs = c.outs.filter((o) => o !== mint.out);
      for (const o of outs) {
        for (const x of [...forms, token]) expect(o.includes(x), `an output holds ${x === token ? "the token" : "the password"}`).toBe(false);
      }
      for (const f of files(runDir)) {
        const bytes = readFileSync(f, "latin1");
        for (const x of [...forms, token]) expect(bytes.includes(x), `${f} holds ${x === token ? "the token" : "the password"}`).toBe(false);
      }
    }, 900_000);
  });
});

afterEach(browserLeftovers);
