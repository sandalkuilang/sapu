// tests/argus-live-repro.test.ts — the journey lane's findings side on a real Chrome-family browser
// through the pinned CLI: the in-daemon hook every session gets at its open, and later the secret
// ledger, the repro runner, minimize, screenshot verdicts and the end-to-end cycle.
// A machine without Chrome or Edge fails here, never skips: the lane cannot run there either.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { alive, browserCleanup, browserLeftovers, browserTools, pwBrowserRun, until } from "./helpers/argus-live";
// @ts-expect-error — plain ESM script without types
import { sessionName } from "../plugins/sapu/scripts/argus-live-cli.mjs";
// @ts-expect-error — plain ESM script without types
import { expandConfig, loadLive } from "../plugins/sapu/scripts/argus-live-config.mjs";
// @ts-expect-error — plain ESM script without types
import { runCode } from "../plugins/sapu/scripts/argus-live-login.mjs";
// @ts-expect-error — plain ESM script without types
import { readRun } from "../plugins/sapu/scripts/argus-live-run.mjs";
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

afterEach(browserLeftovers);
