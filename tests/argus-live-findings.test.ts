// tests/argus-live-findings.test.ts — the journey lane's findings side without a browser: the module DAG,
// origins, the session driver (the CLI shim standing in for @playwright/cli), and later the repro DSL, the
// generated test, classes, the secret ledger's matcher, scrub, the journey map, SELECT and doc drift.
import { mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanTemps, example, liveRun, makeShim, tempDir } from "./helpers/argus-live";
// @ts-expect-error — plain ESM script without types
import { SIGNAL_SCRIPT, slotDir } from "../plugins/sapu/scripts/argus-live-browser.mjs";
// @ts-expect-error — plain ESM script without types
import { expandConfig, loadLive } from "../plugins/sapu/scripts/argus-live-config.mjs";
// @ts-expect-error — plain ESM script without types
import { loginCode } from "../plugins/sapu/scripts/argus-live-login.mjs";
// @ts-expect-error — plain ESM script without types
import { checkUrl, originOf } from "../plugins/sapu/scripts/argus-live-origin.mjs";
// @ts-expect-error — plain ESM script without types
import { startTime } from "../plugins/sapu/scripts/argus-live-proc.mjs";
// @ts-expect-error — plain ESM script without types
import { down, logsDir, readRun, updateRun, writeRunFiles } from "../plugins/sapu/scripts/argus-live-run.mjs";
// @ts-expect-error — plain ESM script without types
import { configuredUser, maskSecrets, sessionDriver } from "../plugins/sapu/scripts/argus-live-session.mjs";
// @ts-expect-error — plain ESM script without types
import { readSlotState, writeSlotState } from "../plugins/sapu/scripts/argus-live-slots.mjs";

type Obj = Record<string, any>;

afterEach(cleanTemps);

const SCRIPTS = join(__dirname, "../plugins/sapu/scripts");

describe("argus-live modules — the DAG", () => {
  /** Each argus-live module (`argus-live`, `argus-live-pw`, …) → the argus-live modules it imports. */
  const graph = () => {
    const out = new Map<string, string[]>();
    for (const f of readdirSync(SCRIPTS).filter((x) => /^argus-live(-[a-z]+)?\.mjs$/.test(x))) {
      const text = readFileSync(join(SCRIPTS, f), "utf8");
      out.set(f.replace(/\.mjs$/, ""), [...text.matchAll(/from "\.\/(argus-live-[a-z]+)\.mjs"/g)].map((m) => m[1]));
    }
    return out;
  };
  /** Every module `from` reaches through its imports. */
  const reach = (g: Map<string, string[]>, from: string) => {
    const seen = new Set<string>();
    const stack = [...(g.get(from) ?? [])];
    while (stack.length) {
      const m = stack.pop()!;
      if (seen.has(m)) continue;
      seen.add(m);
      stack.push(...(g.get(m) ?? []));
    }
    return seen;
  };

  it("every argus-live module imports only modules below it", () => {
    const g = graph();
    expect(g.has("argus-live-origin")).toBe(true);
    expect(g.has("argus-live-start")).toBe(true);
    for (const [m, deps] of g) for (const d of deps) expect(g.has(d), `${m} imports ${d}`).toBe(true);
    for (const m of g.keys()) expect(reach(g, m).has(m), `${m} imports itself through its imports`).toBe(false);
    for (const leaf of ["argus-live-fence", "argus-live-targets", "argus-live-origin"]) expect(g.get(leaf), leaf).toEqual([]);
    expect(reach(g, "argus-live-pw").has("argus-live-instance")).toBe(false);
    expect(reach(g, "argus-live-start").has("argus-live-browser")).toBe(false);
    expect(g.has("argus-live-session")).toBe(true);
    for (const above of ["argus-live-pw", "argus-live-instance"]) expect(reach(g, "argus-live-session").has(above), above).toBe(false);
    expect(readFileSync(join(SCRIPTS, "argus-live-instance.mjs"), "utf8").split("\n").length).toBeLessThan(700);
  });

  it("origins are compared as the run spells them", () => {
    expect(originOf("wss://Example.test/x")).toBe("https://example.test:443");
    expect(originOf("ws://localhost:5/x")).toBe("http://localhost:5");
    expect(originOf("javascript:x")).toBeNull();
    const at = { origins: ["http://localhost:4100"], base: "http://localhost:4100/" };
    expect(checkUrl("/orders/new", at)).toBe("http://localhost:4100/orders/new");
    expect(() => checkUrl("//x.test/", at)).toThrow("refused: //x.test/ is outside the run's origins");
  });
});

describe("argus-live session driver", () => {
  const runs: { main: string; runId: string }[] = [];
  afterEach(async () => {
    for (const r of runs.splice(0)) await down(r.main, { runId: r.runId, graceMs: 1000 }).catch(() => {});
  });
  const BASE = "http://localhost:41002";
  const PORTS = { api: 41001, web: 41002, pg: 41003, redis: 41004, smtp: 41005 };

  /**
   * A run with an instance id, slot 1 holding buyer.1, and the CLI shim as the run's browser CLI behind a
   * wrapper: its `open` leaves a stand-in daemon (a process whose command names `cliDaemon.js <session>`,
   * in a group of its own), and its `goto` exits 1 once `gone` exists → helpers and `driver()`, a driver
   * for buyer.1 over run.json as it stands.
   */
  const driverRun = () => {
    const t = liveRun();
    const c = example();
    c.roles = { anon: {}, buyer: { users: [{ user: "buyer1@example.test", password: "${PW}" }] } };
    writeFileSync(join(t.main, ".argus/live.json"), `${JSON.stringify(c, null, 2)}\n`);
    writeFileSync(join(t.main, ".argus/live.env"), "PW=pw-1\nSALES_TOTP=GEZDGNBVGY3TQOJQ\nDB_PW=db-now\n");
    const { shim, calls, answer, queue } = makeShim();
    const gone = join(tempDir(), "gone");
    const js = join(tempDir(), "cli.mjs");
    writeFileSync(
      js,
      `import { spawn } from "node:child_process";
import fs from "node:fs";
const argv = process.argv.slice(2);
const cmd = argv.find((a) => !a.startsWith("-"));
const session = (argv.find((a) => a.startsWith("-s=")) ?? "").slice(3);
if (cmd === "open") spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "/stand-in/cliDaemon.js", session], { detached: true, stdio: "ignore" }).unref();
await import(${JSON.stringify(shim)});
if (cmd === "goto" && fs.existsSync(${JSON.stringify(gone)})) process.exitCode = 1;
`,
    );
    writeRunFiles(t.main, { runId: t.runId, worktree: t.wt, home: t.home, origins: ["http://localhost:41001", BASE], allowOrigins: [], groups: [], env: { ...t.env, DATABASE_URL: "postgres://app:db-then@localhost:41003/app_explore" }, ports: PORTS, instanceId: "0123456789abcdef", browser: { js, channel: "chrome" } });
    runs.push({ main: t.main, runId: t.runId });
    const dir = slotDir(t.main, t.runId, 1);
    mkdirSync(join(dir, ".playwright"), { recursive: true, mode: 0o700 });
    mkdirSync(join(t.home, "browser"), { recursive: true, mode: 0o700 });
    const { config, secrets } = loadLive(t.main);
    const live = expandConfig(config, { ports: { ...PORTS }, secrets });
    const slotRec = { journey: "order-to-cash", accounts: { "buyer.1": "buyer1@example.test" } };
    const driver = () => sessionDriver({ main: t.main, runId: t.runId, slot: 1, account: "buyer.1", rec: readRun(t.main), live, envSecrets: secrets, slotRec, dir, js });
    const cmds = () => calls().filter((x) => !x.argv.includes("run-code")).map((x) => x.argv[1]);
    const stages = () => calls().filter((x) => x.argv.includes("run-code"));
    return { ...t, config, live, dir, js, gone, calls, cmds, stages, answer, queue, driver };
  };

  it("ensure opens the session on first use and reuses the recorded one", async () => {
    const t = driverRun();
    const first = await t.driver().ensure();
    expect(first.opened).toBe(true);
    expect(first.record).toMatchObject({ name: `${t.runId}-1-buyer.1`, slot: 1, account: "buyer.1", daemon: { pid: expect.any(Number) } });
    const opens = () => t.calls().filter((x) => x.argv[1] === "open");
    expect(opens().map((x) => [x.argv[0], x.cwd])).toEqual([[`-s=${t.runId}-1-buyer.1`, realpathSync(t.dir)]]);
    // Opened and hooked (one hook stage: the run's origins, the signal script, the byte cap), never signed in by ensure: that is the caller's.
    expect(first.events).toEqual([]);
    expect(t.stages()).toHaveLength(1);
    expect(t.stages()[0].code).toContain(`const P = ${JSON.stringify({ runOrigins: ["http://localhost:41001", BASE], signals: SIGNAL_SCRIPT, capBytes: 4 * 2 ** 20 })};`);
    expect(t.stages()[0].code).toContain("ctx.__argus = {");
    const again = await t.driver().ensure();
    expect(again).toEqual({ record: first.record, opened: false, events: [] });
    expect(opens()).toHaveLength(1);
  });

  it("a hook that fails is told among the open's events, and the session is used all the same", async () => {
    const t = driverRun();
    t.answer("run-code", "### Error\nError: boom\n");
    const first = await t.driver().ensure();
    expect(first).toMatchObject({ opened: true, events: ["harness: hook failed"], record: { name: `${t.runId}-1-buyer.1` } });
    expect((readRun(t.main).sessions ?? []).map((x: Obj) => x.name)).toEqual([`${t.runId}-1-buyer.1`]);
  });

  it("a gone browser is reopened and the command is not run", async () => {
    const t = driverRun();
    const d = t.driver();
    const { record } = await d.ensure();
    // A CLI error with the daemon still running is page data, not a gone browser.
    expect(d.gone({ code: 1, stdout: "### Error\nError: boom\n", stderr: "" }, record)).toBe(false);
    writeFileSync(t.gone, "1");
    t.answer("goto", `The browser '${d.name}' is not open, please run open first\n`);
    const res = await d.cli(["goto", "--", `${BASE}/`]);
    expect(res.code).toBe(1);
    expect(d.gone(res, record)).toBe(true);
    t.queue({ installed: true }, { state: "in", status429: false, lockout: false, origins: [] });
    expect(await d.reopen(record)).toEqual(["session-reopened: buyer.1"]);
    expect(t.cmds().slice(0, 4)).toEqual(["open", "goto", "close", "open"]);
    expect(t.cmds().filter((x) => x === "goto")).toHaveLength(1);
    expect(d.state.signedIn).toBe(true);
    // The session reopened is the one run.json records now, with its new daemon.
    const now = (readRun(t.main).sessions ?? []).find((x: Obj) => x.name === d.name);
    expect(now.daemon.pid).not.toBe(record.daemon.pid);
  });

  it("relogin probes before signing in", async () => {
    const t = driverRun();
    // A session already recorded and signed in; this process stands in for its daemon (never signalled).
    const dir = t.dir;
    const me = { pid: process.pid, pgid: process.pid, started: startTime(process.pid) };
    updateRun(t.main, t.runId, (prev: Obj) => ({ ...prev, sessions: [{ name: `${t.runId}-1-buyer.1`, slot: 1, account: "buyer.1", cwd: dir, home: join(t.home, "browser"), daemon: me, browser: null }] }));
    writeSlotState(dir, { ...readSlotState(dir), sessions: { "buyer.1": { signedIn: true } } });
    const d = t.driver();
    expect(await d.ensure()).toMatchObject({ opened: false });
    t.queue({ signals: [], loggedIn: false, url: `${BASE}/no-header`, aria: "x", tabs: 1 }, { in: true, origins: [] });
    const { o, events } = await d.observe();
    expect(events).toEqual([]);
    expect(o.loggedIn).toBe(false);
    expect(d.state.lastState).toMatch(/^[0-9a-f]{64}$/);
    // The probe tab still finds logged_in: no login stage runs.
    expect(await d.relogin(o)).toEqual(["probed: buyer.1"]);
    expect(t.stages()).toHaveLength(2);
    expect(t.stages().some((x) => x.code.includes('"password"'))).toBe(false);
    // It lacks it too: one sign-in, as the allocated user.
    t.queue({ in: false, origins: [] }, { state: "in", status429: false, lockout: false, origins: [] });
    expect(await d.relogin(o)).toEqual(["probed: buyer.1", "re-logged-in: buyer.1"]);
    expect(t.stages().at(-1)!.code).toContain('"user":"buyer1@example.test"');
    const probes = readFileSync(join(logsDir(t.main, t.runId), "probes.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(probes.map((p) => [p.slot, p.account, p.url])).toEqual([[1, "buyer.1", `${BASE}/`], [1, "buyer.1", `${BASE}/`]]);
    // logged_in on the page: nothing is probed.
    expect(await d.relogin({ ...o, loggedIn: true })).toEqual([]);
  });

  it("maskSecrets holds the env file's, the roles' and the created accounts' values", () => {
    const t = driverRun();
    const c = example();
    writeFileSync(join(t.main, ".argus/live.json"), `${JSON.stringify(c, null, 2)}\n`);
    const { config, secrets } = loadLive(t.main);
    const live = expandConfig(config, { ports: { ...PORTS }, secrets });
    expect(maskSecrets(t.main, config, live, { created: { "customer.1": { user: "made9@example.test", password: "Pw-9-made" }, "customer.2": { user: "x" } } })).toEqual({
      PW: "pw-1",
      SALES_TOTP: "GEZDGNBVGY3TQOJQ",
      DB_PW: "db-now",
      "up:env.DATABASE_URL:DB_PW": "db-then",
      "role:customer.0.password": "pw-1",
      "role:customer.1.password": "pw-1",
      "role:sales.0.password": "pw-1",
      "role:sales.0.totp": "GEZDGNBVGY3TQOJQ",
      "created:customer.1": "Pw-9-made",
    });
    expect(configuredUser(live, " Buyer1@Example.TEST ")).toBe(true);
    expect(configuredUser(live, "made9@example.test")).toBe(false);
  });
});

describe("argus-live hook stage", () => {
  it("the hook's code takes its payload only as JSON", () => {
    const evil = 'http://x.test:1"); process.exit(); ("';
    const code = loginCode("hook", { runOrigins: [evil], signals: SIGNAL_SCRIPT, capBytes: 64 });
    const lines = code.split("\n").filter((l: string) => l.includes("process.exit"));
    expect(lines).toEqual([`  const P = ${JSON.stringify({ runOrigins: [evil], signals: SIGNAL_SCRIPT, capBytes: 64 })};`]);
    // Every stage's code parses: the payload never breaks out of its literal.
    expect(() => new Function(`return (${code})`)).not.toThrow();
    expect(() => new Function(`return (${loginCode("observe", { loggedIn: null })})`)).not.toThrow();
  });
});
