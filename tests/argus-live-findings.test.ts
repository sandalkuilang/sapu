// tests/argus-live-findings.test.ts — the journey lane's findings side without a browser: the module DAG,
// origins, the session driver (the CLI shim standing in for @playwright/cli), and later the repro DSL, the
// generated test, classes, the secret ledger's matcher, scrub, the journey map, SELECT and doc drift.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { alive, ARGUS_LIVE, cleanTemps, committed, example, fakeGh, liveRun, longSecret, makeShim, now, partsIn, setLock, tempDir, until } from "./helpers/argus-live";
// @ts-expect-error — plain ESM script without types
import { openSession, SIGNAL_SCRIPT, slotDir } from "../plugins/sapu/scripts/argus-live-browser.mjs";
// @ts-expect-error — plain ESM script without types
import { sessionName } from "../plugins/sapu/scripts/argus-live-cli.mjs";
// @ts-expect-error — plain ESM script without types
import { CLASSES, classify } from "../plugins/sapu/scripts/argus-live-classes.mjs";
// @ts-expect-error — plain ESM script without types
import { drift } from "../plugins/sapu/scripts/argus-live-drift.mjs";
// @ts-expect-error — plain ESM script without types
import { expandConfig, loadLive } from "../plugins/sapu/scripts/argus-live-config.mjs";
// @ts-expect-error — plain ESM script without types
import { appendLedger, appendSeen, dropLedgers, highEntropy, LEDGER_CLASSES, ledgerEntries, ledgerFile, MAX_SECRET, MIN_SECRET, readLedger, readSeen, secretHits, secretName, seenFile, seenIds } from "../plugins/sapu/scripts/argus-live-ledger.mjs";
// @ts-expect-error — plain ESM script without types
import { catalog, mapCheck, mergeMap, readJourneys, refreshReasons, score, selectJourneys, validateMap } from "../plugins/sapu/scripts/argus-live-map.mjs";
// @ts-expect-error — plain ESM script without types
import { renewRun, up, upMap } from "../plugins/sapu/scripts/argus-live-instance.mjs";
// @ts-expect-error — plain ESM script without types
import { readLock } from "../plugins/sapu/scripts/argus-live-lock.mjs";
// @ts-expect-error — plain ESM script without types
import { pw } from "../plugins/sapu/scripts/argus-live-pw.mjs";
// @ts-expect-error — plain ESM script without types
import { HELPERS, loginCode } from "../plugins/sapu/scripts/argus-live-login.mjs";
// @ts-expect-error — plain ESM script without types
import { checkUrl, originOf } from "../plugins/sapu/scripts/argus-live-origin.mjs";
// @ts-expect-error — plain ESM script without types
import { startTime } from "../plugins/sapu/scripts/argus-live-proc.mjs";
// @ts-expect-error — plain ESM script without types
import { minimize, repro, runOnce } from "../plugins/sapu/scripts/argus-live-repro.mjs";
// @ts-expect-error — plain ESM script without types
import { redTest } from "../plugins/sapu/scripts/argus-live-redtest.mjs";
// @ts-expect-error — plain ESM script without types
import { down, logsDir, readRun, updateRun, writeRunFiles } from "../plugins/sapu/scripts/argus-live-run.mjs";
// @ts-expect-error — plain ESM script without types
import { defang, redactIds, scrub, scrubSecrets, writeVerdict } from "../plugins/sapu/scripts/argus-live-scrub.mjs";
// @ts-expect-error — plain ESM script without types
import { configuredUser, drainSessions, maskSecrets, sessionDriver } from "../plugins/sapu/scripts/argus-live-session.mjs";
// @ts-expect-error — plain ESM script without types
import { intake, ORACLES } from "../plugins/sapu/scripts/argus-live-return.mjs";
// @ts-expect-error — plain ESM script without types
import { mintMapSlot, mintSlot, readSlotState, writeSlotState } from "../plugins/sapu/scripts/argus-live-slots.mjs";
// @ts-expect-error — plain ESM script without types
import { FINAL_KINDS, parseRepro, reductions, stepCode, substitute } from "../plugins/sapu/scripts/argus-live-steps.mjs";
// @ts-expect-error — plain ESM script without types
import { parseTarget } from "../plugins/sapu/scripts/argus-live-targets.mjs";

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
    for (const leaf of ["argus-live-fence", "argus-live-targets", "argus-live-origin", "argus-live-classes"]) expect(g.get(leaf), leaf).toEqual([]);
    expect(reach(g, "argus-live-pw").has("argus-live-instance")).toBe(false);
    expect(reach(g, "argus-live-start").has("argus-live-browser")).toBe(false);
    expect(g.has("argus-live-session")).toBe(true);
    for (const above of ["argus-live-pw", "argus-live-instance"]) expect(reach(g, "argus-live-session").has(above), above).toBe(false);
    // The ledger sits right above run.json's module: the drains above it write it, the teardown takes its drain as a parameter.
    expect([...(g.get("argus-live-ledger") ?? [])].sort()).toEqual(["argus-live-fence", "argus-live-lock", "argus-live-run"]);
    expect(reach(g, "argus-live-run").has("argus-live-session")).toBe(false);
    // The repro DSL sits beside pw, above the session driver: it reaches neither pw nor the instance.
    expect(g.has("argus-live-steps")).toBe(true);
    for (const d of g.get("argus-live-steps") ?? []) expect(["argus-live-targets", "argus-live-hooks", "argus-live-login", "argus-live-return", "argus-live-slots", "argus-live-session", "argus-live-origin"], d).toContain(d);
    for (const above of ["argus-live-pw", "argus-live-instance"]) expect(reach(g, "argus-live-steps").has(above), above).toBe(false);
    // The generated RED test reads targets and oracles only; the runner above it writes it.
    expect([...(g.get("argus-live-redtest") ?? [])].sort()).toEqual(["argus-live-return", "argus-live-targets"]);
    expect(g.get("argus-live-repro")).toContain("argus-live-redtest");
    // Scrub reads only what a down keeps: the configuration, the ledger, the lock and run.json's records; pw writes its screenshot verdicts.
    expect([...(g.get("argus-live-scrub") ?? [])].sort()).toEqual(["argus-live-config", "argus-live-endpoints", "argus-live-fence", "argus-live-ledger", "argus-live-lock", "argus-live-proc", "argus-live-run"]);
    expect(g.get("argus-live-pw")).toContain("argus-live-scrub");
    // The journey map reads the configuration and git, nothing of a run.
    expect([...(g.get("argus-live-map") ?? [])].sort()).toEqual(["argus-live-config", "argus-live-proc"]);
    expect(g.get("argus-live-return")).toContain("argus-live-map");
    // Doc drift reads git's blame and nothing else.
    expect(g.get("argus-live-drift")).toEqual(["argus-live-proc"]);
    expect(readFileSync(join(SCRIPTS, "argus-live-instance.mjs"), "utf8").split("\n").length).toBeLessThan(700);
  });

  it("the instance module's header names every module, each after the modules it imports", () => {
    const g = graph();
    const text = readFileSync(join(SCRIPTS, "argus-live-instance.mjs"), "utf8");
    const header = text.slice(0, text.indexOf("\nimport ")).replace(/^\/\/ ?/gm, "");
    const dag = header.slice(header.indexOf("argus-live-proc.mjs"), header.indexOf("Leaves:"));
    const leaves = [...header.slice(header.indexOf("Leaves:")).split(/\.\s/)[0].matchAll(/-([a-z]+)\.mjs/g)].map((m) => `argus-live-${m[1]}`);
    const order = [...dag.matchAll(/argus-live\.mjs|argus-live-[a-z]+\.mjs|-([a-z]+)\.mjs|this module/g)].map((m) => (m[0] === "this module" ? "argus-live-instance" : m[1] ? `argus-live-${m[1]}` : m[0].replace(/\.mjs$/, "")));
    const at = (m: string) => order.indexOf(m);
    for (const m of g.keys()) expect(leaves.includes(m) || at(m) >= 0, `${m} is named in the header`).toBe(true);
    for (const leaf of leaves) expect(g.get(leaf), leaf).toEqual([]);
    for (const [m, deps] of g) for (const d of deps) if (!leaves.includes(d)) expect(at(d) < at(m), `${m} imports ${d}, named after it`).toBe(true);
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
  }, 30_000);

  it("a hook that fails is told among the open's events, and the session is used all the same", async () => {
    const t = driverRun();
    t.answer("run-code", "### Error\nError: boom\n");
    const first = await t.driver().ensure();
    expect(first).toMatchObject({ opened: true, events: ["harness: hook failed"], record: { name: `${t.runId}-1-buyer.1` } });
    expect((readRun(t.main).sessions ?? []).map((x: Obj) => x.name)).toEqual([`${t.runId}-1-buyer.1`]);
    // Its headers go unrecorded from here on: the run's ledger says so, and scrub refuses the run.
    expect(readLedger(t.main, t.runId)!.incomplete).toBe(`${t.runId}-1-buyer.1 unhooked`);
    // A driver that never uses an unhooked session (the repro runner: a HARNESS at once) leaves the ledger as it is.
    const u = driverRun();
    u.answer("run-code", "### Error\nError: boom\n");
    const d = sessionDriver({ main: u.main, runId: u.runId, slot: 1, account: "buyer.1", rec: readRun(u.main), live: u.live, envSecrets: loadLive(u.main).secrets, slotRec: { journey: "order-to-cash", accounts: { "buyer.1": "buyer1@example.test" } }, dir: u.dir, js: u.js, markUnhooked: false });
    expect((await d.ensure()).events).toEqual(["harness: hook failed"]);
    expect(readLedger(u.main, u.runId)).toBeNull();
  }, 60_000);

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
  }, 30_000);

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
  }, 30_000);

  it("observe keeps the drain in the ledger and seen.jsonl and marks the account drained; a reopen after a command marks it lost", async () => {
    const t = driverRun();
    const d = t.driver();
    await d.ensure();
    const secrets = { cookies: [{ name: "sid", value: "COOKIEVALUE_abc123", httpOnly: true, secure: false }], storage: [{ key: "theme", value: "dark-mode-on" }], headers: [["authorization", "Bearer AUTHVALUE_112233"]], leaves: [["id", "01HZX3J4K5M6N7P8Q9R0S1T2V3"]], paths: [["reset", "rk7b6a5c4d3e2f1g0h9i8j7k6"]], errors: [], overflow: true };
    t.queue({ signals: [], loggedIn: true, url: `${BASE}/`, aria: "x", tabs: 1, secrets });
    d.state.drained = false;
    expect((await d.observe()).events).toEqual([]);
    expect(d.state.drained).toBe(true);
    expect(readLedger(t.main, t.runId)).toEqual({
      entries: [{ c: "cookie", v: "COOKIEVALUE_abc123" }, { c: "header", v: "Bearer AUTHVALUE_112233" }, { c: "header", v: "AUTHVALUE_112233" }, { c: "incomplete", v: `${d.name} passed ${4 * 2 ** 20} bytes` }],
      incomplete: `${d.name} passed ${4 * 2 ** 20} bytes`,
    });
    expect([...readSeen(t.main, t.runId)]).toEqual(["01HZX3J4K5M6N7P8Q9R0S1T2V3"]);
    // An observation that failed leaves the account undrained; the session then found gone was lost mid-command.
    const u = driverRun();
    const e = u.driver();
    const opened = await e.ensure();
    u.answer("run-code", "### Error\nError: boom\n");
    e.state.drained = false;
    expect((await e.observe()).events).toEqual(["harness: observation failed"]);
    expect(e.state.drained).toBe(false);
    u.answer("run-code", `### Result\n${JSON.stringify({ state: "in", status429: false, lockout: false, origins: [] })}\n`);
    expect(await e.reopen(opened.record)).toEqual(["session-reopened: buyer.1"]);
    expect(readLedger(u.main, u.runId).incomplete).toBe(`${e.name} lost before its drain`);
  }, 60_000);

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

describe("argus-live ledger", () => {
  const pairs = (entries: Obj[]) => entries.map((e) => `${e.c}:${e.v}`).sort();

  it("ledgerEntries takes only secret-like cookies and storage, and every secret header", () => {
    const got = ledgerEntries({
      cookies: [{ name: "sid", value: "COOKIEVALUE_abc123", httpOnly: true }, { name: "theme", value: "dark-mode-on" }, { name: "prefs", value: "Xy7_kq9Lm2Pz8Wv4" }, { name: "sid2", value: "abc12" }],
      storage: [{ key: "app", value: '{"jwt":"LS_TOKEN_98765","n":1,"label":"hello world"}' }, { key: "theme", value: "dark" }],
      headers: [["authorization", "Bearer AUTHVALUE_112233"], ["cookie", "sid=abcdef123456; theme=dark-mode-on"], ["set-cookie", "zz=zzzzzz999999; Path=/; HttpOnly"], ["x-csrf-token", "CSRFVAL_9988"], ["x-api-token", "T".repeat(10_000)]],
    });
    expect(pairs(got)).toEqual(
      [
        "cookie:COOKIEVALUE_abc123",
        "cookie:Xy7_kq9Lm2Pz8Wv4",
        "storage:LS_TOKEN_98765",
        "header:Bearer AUTHVALUE_112233",
        "header:AUTHVALUE_112233",
        "header:abcdef123456",
        "header:zzzzzz999999",
        "header:CSRFVAL_9988",
        `header:${"T".repeat(MAX_SECRET)}`,
      ].sort(),
    );
    expect(got.every((e: Obj) => LEDGER_CLASSES.includes(e.c))).toBe(true);
    // Duplicates dropped; the floor is the ledger classes' own.
    expect(ledgerEntries({ headers: [["x-a-token", "abcdef1"], ["x-b-token", "abcdef1"], ["x-c-token", "abcde"]] })).toEqual([{ c: "header", v: "abcdef1" }]);
    expect([MIN_SECRET, MAX_SECRET]).toEqual([6, 4096]);
    expect([highEntropy("Xy7_kq9Lm2Pz8Wv4"), highEntropy("abcdefabcdef12345678"), highEntropy("Xy7_kq9 Lm2Pz8Wv4"), highEntropy("Xy7_kq9Lm2Pz8W")]).toEqual([true, false, false, false]);
  });

  it("secretHits finds a value raw, URL-encoded, base64-encoded and split by spaces, and says where", () => {
    const auth = [{ cls: "header", v: "AUTHVALUE_112233" }];
    expect(secretHits("x AUTHVALUE_112233 y", auth)).toEqual([{ line: 1, col: 3, cls: "header" }]);
    expect(secretHits("ok\n  AUTHVALUE%5F112233", auth)).toEqual([{ line: 2, col: 3, cls: "header" }]);
    expect(Buffer.from("AUTHVALUE_112233").toString("base64url")).toBe("QVVUSFZBTFVFXzExMjIzMw");
    expect(secretHits("QVVUSFZBTFVFXzExMjIzMw", auth)).toEqual([{ line: 1, col: 1, cls: "header" }]);
    expect(secretHits("A U T H V A L U E _ 1 1 2 2 3 3", auth)).toEqual([{ line: 1, col: 1, cls: "header" }]);
    expect(secretHits("db is up", [{ cls: "header", v: "db" }])).toEqual([]);
    // Sorted by line, column and class; one value of two classes is two hits.
    expect(secretHits("a AUTHVALUE_112233\nAUTHVALUE_112233", [...auth, { cls: "env file", v: "AUTHVALUE_112233" }])).toEqual([
      { line: 1, col: 3, cls: "env file" },
      { line: 1, col: 3, cls: "header" },
      { line: 2, col: 1, cls: "env file" },
      { line: 2, col: 1, cls: "header" },
    ]);
  });

  it("a short configuration secret is matched as a whole token only", () => {
    const pw = [{ cls: "role password", v: "pw1" }];
    for (const text of ["use pw1 here", "p-w-1", "p%771", "cHcx"]) expect(secretHits(text, pw), text).toHaveLength(1);
    expect(secretHits("use pw1 here", pw)).toEqual([{ line: 1, col: 5, cls: "role password" }]);
    for (const text of ["pw123", "xpw1", "cHcxZ"]) expect(secretHits(text, pw), text).toEqual([]);
    expect(secretHits("anything", [{ cls: "env file", v: "" }])).toEqual([]);
  });

  it("seenIds keeps the ids and none of the tokens", () => {
    const ids = seenIds({
      paths: [["items", "ck9a8b7c6d5e4f3g2h1i0j9k8"], ["reset", "rk7b6a5c4d3e2f1g0h9i8j7k6"], ["verify-email", "ve1a2b3c4d5e6f7g8h9i0j1k2"]],
      leaves: [["id", "01HZX3J4K5M6N7P8Q9R0S1T2V3"], ["code", "cd4e5f6a7b8c9d0e1f2a3b4c5d"], ["nonce", "nn4e5f6a7b8c9d0e1f2a3b4c5d"], ["ref", "eyJhbGciOiJIUzI1NiJ9x1y2z3a4b5"]],
    });
    expect([...ids].sort()).toEqual(["01HZX3J4K5M6N7P8Q9R0S1T2V3", "ck9a8b7c6d5e4f3g2h1i0j9k8"]);
  });

  it("a damaged ledger refuses; a gone one is null; an incomplete one says why", () => {
    const t = liveRun();
    expect(readLedger(t.main, t.runId)).toBeNull();
    appendLedger(t.main, t.runId, [{ c: "header", v: "AUTHVALUE_112233" }, { c: "created password", v: "pw1" }]);
    appendLedger(t.main, t.runId, [{ c: "header", v: "AUTHVALUE_112233" }, { c: "cookie", v: "" }]);
    expect(ledgerFile(t.main, t.runId)).toBe(join(logsDir(t.main, t.runId), "secrets.jsonl"));
    expect(statSync(ledgerFile(t.main, t.runId)).mode & 0o777).toBe(0o600);
    expect(readLedger(t.main, t.runId)).toEqual({ entries: [{ c: "header", v: "AUTHVALUE_112233" }, { c: "created password", v: "pw1" }], incomplete: null });
    appendLedger(t.main, t.runId, [{ c: "incomplete", v: "s-1 lost before its drain" }]);
    expect(readLedger(t.main, t.runId).incomplete).toBe("s-1 lost before its drain");
    appendFileSync(ledgerFile(t.main, t.runId), "not json\n");
    expect(() => readLedger(t.main, t.runId)).toThrow("refused: scrub: the run's secret ledger is damaged");
    // seen.jsonl: the ids, once each.
    appendSeen(t.main, t.runId, ["ck9a8b7c6d5e4f3g2h1i0j9k8", "ck9a8b7c6d5e4f3g2h1i0j9k8"]);
    appendSeen(t.main, t.runId, ["ck9a8b7c6d5e4f3g2h1i0j9k8"]);
    expect([...readSeen(t.main, t.runId)]).toEqual(["ck9a8b7c6d5e4f3g2h1i0j9k8"]);
    expect(readFileSync(seenFile(t.main, t.runId), "utf8").trim().split("\n")).toHaveLength(1);
    // The next up's step 1 drops every other run's ledger, never its seen ids.
    const other = `${"1".repeat(14)}-0123abcd`;
    mkdirSync(join(t.main, ".argus/live", other, "logs"), { recursive: true });
    writeFileSync(join(t.main, ".argus/live", other, "logs", "secrets.jsonl"), "");
    dropLedgers(t.main, { keep: other });
    expect(existsSync(ledgerFile(t.main, t.runId))).toBe(false);
    expect(existsSync(seenFile(t.main, t.runId))).toBe(true);
    expect(existsSync(join(t.main, ".argus/live", other, "logs", "secrets.jsonl"))).toBe(true);
  });

  it("drainSessions marks what it could not drain", async () => {
    const t = liveRun();
    writeRunFiles(t.main, { runId: t.runId, worktree: t.wt, home: t.home, origins: [], allowOrigins: [], groups: [], env: t.env, instanceId: "0123456789abcdef" });
    const dir = slotDir(t.main, t.runId, 1);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const gone = spawnSync(process.execPath, ["-e", ""]).pid; // a pid that ran and exited
    const record = (account: string) => ({ name: `${t.runId}-1-${account}`, slot: 1, account, cwd: dir, home: join(t.home, "browser"), daemon: { pid: gone, pgid: gone, started: "gone" }, browser: null });
    writeSlotState(dir, { ...readSlotState(dir), sessions: { "buyer.1": { signedIn: true, drained: false }, "buyer.2": { signedIn: true, drained: true } } });
    await drainSessions(t.main, t.runId, [record("buyer.1"), record("buyer.2")], {});
    expect(readLedger(t.main, t.runId)).toEqual({ entries: [{ c: "incomplete", v: `${t.runId}-1-buyer.1 lost before its drain` }], incomplete: `${t.runId}-1-buyer.1 lost before its drain` });
    // down's teardown without a drain (a test's call) closes the sessions undrained, and says so.
    const u = liveRun();
    writeRunFiles(u.main, { runId: u.runId, worktree: u.wt, home: u.home, origins: [], allowOrigins: [], groups: [], env: u.env, instanceId: "0123456789abcdef" });
    const me = { pid: process.pid, pgid: process.pid, started: startTime(process.pid) };
    updateRun(u.main, u.runId, (prev: Obj) => ({ ...prev, sessions: [{ name: `${u.runId}-1-buyer.1`, slot: 1, account: "buyer.1", cwd: slotDir(u.main, u.runId, 1), home: join(u.home, "browser"), daemon: me, browser: null }] }));
    await down(u.main, { runId: u.runId, graceMs: 1000 });
    expect(readLedger(u.main, u.runId).incomplete).toBe(`${u.runId}-1-buyer.1 closed undrained`);
  }, 30_000);

  it("a drain that throws mid-way leaves the sessions it had not drained marked undrained", async () => {
    const u = liveRun();
    writeRunFiles(u.main, { runId: u.runId, worktree: u.wt, home: u.home, origins: [], allowOrigins: [], groups: [], env: u.env, instanceId: "0123456789abcdef" });
    const me = { pid: process.pid, pgid: process.pid, started: startTime(process.pid) };
    const record = (account: string) => ({ name: `${u.runId}-1-${account}`, slot: 1, account, cwd: slotDir(u.main, u.runId, 1), home: join(u.home, "browser"), daemon: me, browser: null });
    updateRun(u.main, u.runId, (prev: Obj) => ({ ...prev, sessions: [record("buyer.1"), record("buyer.2"), record("anon.1")] }));
    const drain = async (records: Obj[], { drained }: { drained: (name: string) => void }) => {
      drained(records[0].name);
      throw new Error("the CLI died");
    };
    await down(u.main, { runId: u.runId, graceMs: 1000, drain });
    expect(readLedger(u.main, u.runId)!.entries).toEqual([
      { c: "incomplete", v: `${u.runId}-1-buyer.2 closed undrained` },
      { c: "incomplete", v: `${u.runId}-1-anon.1 closed undrained` },
    ]);
  }, 30_000);
});

describe("argus-live repro sessions", () => {
  const runs: { main: string; runId: string }[] = [];
  const groups: number[] = [];
  afterEach(async () => {
    for (const r of runs.splice(0)) await down(r.main, { runId: r.runId, graceMs: 1000 }).catch(() => {});
    for (const g of groups.splice(0)) {
      try {
        process.kill(-g, "SIGKILL");
      } catch {
        // gone
      }
    }
  });
  /** A run's files (an instance id unless `instanceId` is null) with the CLI shim as its browser CLI. */
  const reproRun = (instanceId: string | null = "0123456789abcdef") => {
    const t = liveRun();
    const { shim, calls } = makeShim();
    writeRunFiles(t.main, { runId: t.runId, worktree: t.wt, home: t.home, origins: [], allowOrigins: [], groups: [], env: t.env, instanceId, browser: { js: shim, channel: "chrome" } });
    runs.push({ main: t.main, runId: t.runId });
    return { ...t, shim, calls };
  };

  it("slot r is a slot", () => {
    const t = liveRun();
    expect(slotDir(t.main, t.runId, "r")).toBe(join(t.main, ".argus/live", t.runId, "r"));
    expect(() => slotDir(t.main, t.runId, "x")).toThrow("failed: x is not a slot (a positive integer, up or r)");
    expect(sessionName(t.runId, "r", "buyer.1")).toBe(`${t.runId}-r-buyer.1`);
  });

  it("a repro session is recorded only while the run has an instance", async () => {
    const t = reproRun(null);
    mkdirSync(slotDir(t.main, t.runId, "r"), { recursive: true, mode: 0o700 });
    await expect(openSession({ main: t.main, runId: t.runId, slot: "r", account: "buyer.1", js: t.shim, home: join(t.home, "browser") })).rejects.toThrow(`refused: cycle ${t.runId} has no instance (an up --fresh is under way); the session ${t.runId}-r-buyer.1 is not recorded`);
    expect(t.calls()).toEqual([]);
    expect(readRun(t.main).sessions ?? []).toEqual([]);
  });

  it("down closes them", async () => {
    const t = reproRun();
    const dir = slotDir(t.main, t.runId, "r");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const p = spawn("sleep", ["600"], { detached: true, stdio: "ignore" });
    groups.push(p.pid!);
    const daemon = { pid: p.pid!, pgid: p.pid!, started: startTime(p.pid!) };
    const name = sessionName(t.runId, "r", "buyer.1");
    updateRun(t.main, t.runId, (prev: Obj) => ({ ...prev, sessions: [{ name, slot: "r", account: "buyer.1", cwd: dir, home: join(t.home, "browser"), daemon, browser: null }] }));
    await down(t.main, { runId: t.runId, graceMs: 1000 });
    expect(t.calls().map((c) => c.argv)).toEqual([[`-s=${name}`, "close"]]);
    expect(await until(() => !alive(p.pid!), 3000)).toBe(true);
  }, 30_000);
});

/** Spec §10's example, its context as the list's first element (decision 1). */
const EXAMPLE = () => [
  { context: { viewport: 1440, locale: "en-US", timezone: "UTC" } },
  { as: "customer", do: "goto", path: "/orders/new" },
  { as: "customer", do: "fill", target: { label: "Quantity" }, value: "2" },
  { as: "customer", do: "click", target: { role: "button", name: "Place order" } },
  { as: "customer", do: "read", target: { testId: "order-number" }, save: "order" },
  { as: "customer", expect: "visible", target: { text: "{{order}}" } },
  { as: "system", do: "trigger", name: "payment-settles", values: ["{{order}}"] },
  { as: "customer", expect: "fact-equals", marker: "{{order}}", field: "status", value: "paid" },
  { as: "sales", do: "goto", path: "/" },
  { as: "sales", expect: "visible", target: { text: "{{order}}" }, final: "handoff" },
];
const ACCOUNTS = { "customer.1": "buyer1@example.test", "customer.2": "buyer2@example.test", "sales.1": "sales1@example.test", "anon.1": null };
const at = { accounts: ACCOUNTS, live: example() };
const FINAL_EXPECT = { as: "sales", expect: "visible", target: { text: "x" }, final: "handoff" };

describe("argus-live repro DSL", () => {
  const FINAL = { as: "sales", expect: "visible", target: { text: "x" }, final: "handoff" };
  /** The refusal parseRepro throws for `list`. */
  const refusal = (list: Obj[]) => {
    try {
      parseRepro(list, at);
    } catch (e) {
      return (e as Error).message;
    }
    return "parsed";
  };
  /** The step template's own code: HELPERS left out. */
  const own = (code: string) => code.replace(HELPERS, "");
  /** Phase 3's targetCode shape (argus-live-pw.test.ts), rooted at the template's `pg`; its options may hold a JSON string with a brace. */
  const SHAPE = /^pg(\.(getBy(Role|Text|Label|Placeholder|TestId|Title|AltText)|locator)\(("(?:[^"\\]|\\.)*")(, \{(?:"(?:[^"\\]|\\.)*"|[^}"])*\})?\)|\.(first|last)\(\)|\.nth\(-?\d+\))+$/;
  const OPTS = { settleMs: 3000, runOrigins: ["http://localhost:41002"] };

  it("FINAL_KINDS holds decision 7's templates, one per oracle", () => {
    expect(Object.keys(FINAL_KINDS)).toEqual(ORACLES);
    expect(FINAL_KINDS).toMatchObject({ handoff: ["visible"], "status-coherence": ["fact-equals", "text-equals"], "dead-end": ["enabled"], reversal: ["fact-equals"], "claim-race": ["count"], "viewport-locale": ["visible", "enabled"] });
  });

  it("parseRepro reads §10's example", () => {
    const { context, steps } = parseRepro(EXAMPLE(), at);
    expect(context).toEqual({ viewport: 1440, locale: "en-US", timezone: "UTC" });
    expect(steps).toHaveLength(9);
    expect(steps.map((s: Obj) => s.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(steps[0]).toEqual({ n: 1, as: "customer.1", do: "goto", path: "/orders/new" });
    expect(steps[1].target).toEqual(parseTarget("getByLabel('Quantity')"));
    expect(steps[2].target).toEqual(parseTarget("getByRole('button', { name: 'Place order' })"));
    expect(steps[3]).toMatchObject({ do: "read", save: "order", target: parseTarget("getByTestId('order-number')") });
    expect(steps[5]).toEqual({ n: 6, as: "system", do: "trigger", name: "payment-settles", values: ["{{order}}"] });
    expect(steps[8]).toMatchObject({ as: "sales.1", expect: "visible", final: "handoff", target: { by: "text", value: "{{order}}" } });
  });

  it("the context defaults to live's viewport, locale and timezone", () => {
    const { context } = parseRepro(EXAMPLE().slice(1), { accounts: ACCOUNTS, live: { ...example(), viewports: [390, 1440], locale: "de-DE", timezone: "Europe/Berlin" } });
    expect(context).toEqual({ viewport: 390, locale: "de-DE", timezone: "Europe/Berlin" });
  });

  it("each refusal names its step", () => {
    const cases: [Obj[], string][] = [
      [[{ as: "customer", do: "goto", path: "/", colour: "red" }, FINAL], 'step 1: unknown key "colour"'],
      [[{ as: "customer", do: "teleport" }, FINAL], "step 1: unknown action"],
      [[{ as: "customer", expect: "glows", target: { text: "x" } }, FINAL], "step 1: unknown action"],
      [[{ as: "admin", do: "goto", path: "/" }, FINAL], "step 1: admin is not allocated to this slot"],
      [[{ as: "system", do: "goto", path: "/" }, FINAL], "step 1: system only triggers, reads facts and reads mail"],
      [[{ as: "customer", do: "click", target: { css: "#x" } }, FINAL], "step 1: a target names one of role, label, text, placeholder, testId"],
      [[{ as: "customer", do: "click", target: { role: "button", label: "x" } }, FINAL], "step 1: a target names one of role, label, text, placeholder, testId"],
      [[{ as: "customer", do: "click", target: { title: "x" } }, FINAL], "step 1: a target names one of role, label, text, placeholder, testId"],
      [[{ as: "customer", do: "click", target: { text: "a", within: { altText: "b" } } }, FINAL], "step 1: a target names one of role, label, text, placeholder, testId"],
      [[{ as: "customer", do: "goto", path: "http://outside.test/" }, FINAL], "step 1: goto takes a path (/…)"],
      [[{ as: "customer", do: "goto", path: "//outside.test/" }, FINAL], "step 1: goto takes a path (/…)"],
      [[{ as: "customer", expect: "visible", target: { text: "{{order}}" } }, FINAL], "step 1: {{order}} is used before a read saves it"],
      [[{ as: "sales", expect: "visible", target: { text: "x" }, final: "handoff" }, { as: "sales", do: "goto", path: "/" }], "step 1: final must be the last step"],
      [[{ as: "sales", expect: "visible", target: { text: "x" }, final: "handoff" }, FINAL], "step 2: one final only"],
      [[{ as: "sales", expect: "hidden", target: { text: "x" }, final: "handoff" }], "step 1: handoff's final is visible"],
      [[{ as: "sales", expect: "visible", target: { text: "x" }, final: "status-coherence" }], "step 1: status-coherence's final is fact-equals or text-equals"],
      [[{ as: "sales", expect: "count", target: { testId: "claim" }, value: 1, final: "claim-race" }], "step 1: claim-race needs a parallel group of two accounts of one role before its final"],
      [[{ as: "customer", do: "goto", path: "/" }, { as: "customer", expect: "count", target: { testId: "x" }, value: 1, final: "interrupted-flow" }], "step 2: interrupted-flow needs no-error right before its final"],
      [[{ as: "customer", do: "select", target: { label: "Size" }, value: "L" }, { as: "customer", do: "goto", path: "/" }], "step 1: select changes state: an expect as customer.1 must follow before its next action"],
      [[{ as: "sales", do: "check", target: { label: "Urgent" } }, { as: "customer", expect: "visible", target: { text: "x" }, final: "handoff" }], "step 1: check changes state: an expect as sales.1 must follow before its next action"],
      [[{ parallel: [{ as: "customer", do: "click", target: { text: "a" } }] }, FINAL], "step 1: a parallel group holds 2 to 8 actions of different accounts"],
      [[{ parallel: [{ as: "customer", do: "click", target: { text: "a" } }, { as: "customer.1", do: "click", target: { text: "b" } }] }, FINAL], "step 1: a parallel group holds 2 to 8 actions of different accounts"],
      [[{ parallel: [{ as: "customer", do: "click", target: { text: "a" } }, { as: "sales", expect: "visible", target: { text: "b" } }] }, FINAL], "step 1: a parallel group holds 2 to 8 actions of different accounts"],
      [[{ as: "anon.1", do: "login", user: "x@example.test", password: "pw-1" }, FINAL], "step 1: anon is never signed in"],
      [[{ as: "customer", do: "login", user: "x@example.test", password: "pw-1" }, FINAL], "step 1: login's as names an account (<role>.<k>)"],
      [[{ as: "customer.2", do: "login", user: "buyer1@example.test", password: "pw-1" }, FINAL], "step 1: login takes an account the journey created, never a configured user"],
      [[{ as: "customer.2", do: "login", user: " Sales1@Example.test", password: "pw-1" }, FINAL], "step 1: login takes an account the journey created, never a configured user"],
      [[{ as: "customer.2", do: "login", user: "x@example.test" }, FINAL], "step 1: login takes a user and a password (strings, placeholders allowed)"],
      [[{ as: "customer.2", do: "login", user: "x@example.test", password: 7 }, FINAL], "step 1: login takes a user and a password (strings, placeholders allowed)"],
      // A literal created password would be in the ledger and in the repro scrub files with the issue: never fileable.
      [[{ as: "customer.2", do: "login", user: "x@example.test", password: "pw-1" }, FINAL], "step 1: login's password holds {{marker}} (a literal password would make the finding unfileable)"],
      [[{ as: "customer.2", do: "login", user: "{{marker}}@example.test", password: "{{order}}" }, FINAL], "step 1: login's password holds {{marker}} (a literal password would make the finding unfileable)"],
      [[{ as: "system", do: "trigger", name: "nope", values: [] }, FINAL], "step 1: trigger nope is not in live.triggers"],
      [[{ as: "system", do: "trigger", name: "payment-settles", values: [] }, FINAL], "step 1: trigger payment-settles takes 1 value"],
      [[{ as: "customer", do: "fill", target: { label: "Note" }, value: "n".repeat(501) }, FINAL], "step 1: a string is at most 500 characters, without control characters"],
      [[{ as: "customer", do: "fill", target: { label: "Note" }, value: "a\u0007b" }, FINAL], "step 1: a string is at most 500 characters, without control characters"],
      [[...Array.from({ length: 100 }, () => ({ as: "customer", do: "goto", path: "/" })), FINAL], "step 101: at most 100 steps"],
    ];
    for (const [list, why] of cases) expect(refusal(list), why).toBe(`refused: repro: ${why}`);
    // The context's own faults are the context's.
    expect(refusal([{ context: { viewport: 100 } }, FINAL])).toBe("refused: repro: context: viewport must be from 200 to 4000");
    expect(refusal([{ context: { locale: "not a locale!" } }, FINAL])).toBe("refused: repro: context: locale is not a BCP 47 tag");
    expect(refusal([{ context: { timezone: "Mars/Olympus" } }, FINAL])).toBe("refused: repro: context: timezone is not one Intl knows");
    expect(refusal([{ context: { colour: "red" } }, FINAL])).toBe('refused: repro: context: unknown key "colour"');
    // §10's example passes: its read between the click and the expect is allowed.
    expect(refusal(EXAMPLE())).toBe("parsed");
  });

  it("a claim race's parallel group and an interrupted flow's no-error pass", () => {
    const race = [
      { parallel: [{ as: "customer.1", do: "click", target: { role: "button", name: "Claim" } }, { as: "customer.2", do: "click", target: { role: "button", name: "Claim" } }] },
      { as: "customer.1", expect: "visible", target: { testId: "claim", nth: 0 } },
      { as: "customer.2", expect: "visible", target: { testId: "claim", nth: 0 } },
      { as: "customer.1", expect: "count", target: { testId: "claim" }, value: 1, final: "claim-race" },
    ];
    const { steps } = parseRepro(race, at);
    expect(steps.map((s: Obj) => [s.n, s.as, s.group ?? null])).toEqual([[1, "customer.1", 1], [2, "customer.2", 1], [3, "customer.1", null], [4, "customer.2", null], [5, "customer.1", null]]);
    expect(steps[2].target).toEqual({ by: "testId", value: "claim", nth: 0 });
    expect(refusal([{ as: "customer", do: "goto", path: "/" }, { as: "customer", expect: "no-error" }, { as: "customer", expect: "count", target: { testId: "x" }, value: 1, final: "interrupted-flow" }])).toBe("parsed");
  });

  it("a login step has its shape", () => {
    const login = { as: "customer.2", do: "login", user: "{{marker}}@example.test", password: "pw-{{marker}}" };
    const { steps } = parseRepro([login, { as: "customer.2", expect: "visible", target: { text: "Signed in as" } }, FINAL], at);
    expect(steps[0]).toEqual({ n: 1, ...login });
    // A login changes state: its proving expect is the account's next expect.
    expect(refusal([login, { as: "customer.2", do: "goto", path: "/" }, FINAL])).toBe("refused: repro: step 1: login changes state: an expect as customer.2 must follow before its next action");
  });

  it("a trigger needs an expect of any account before the next state-changing step", () => {
    const trigger = { as: "system", do: "trigger", name: "payment-settles", values: ["ORD-1"] };
    expect(refusal([trigger, { as: "sales", do: "check", target: { label: "x" } }, FINAL])).toBe("refused: repro: step 1: trigger changes state: an expect must follow before the next state-changing step");
    expect(refusal([trigger, FINAL])).toBe("parsed");
    // A literal value is checked against the trigger's regex before any browser work.
    expect(refusal([{ ...trigger, values: [";id"] }, FINAL])).toMatch(/^refused: repro: step 1: value 1 of payment-settles does not match \^\[A-Za-z0-9-\]\{1,64\}\$$/);
  });

  it("every step template drains", () => {
    const { steps } = parseRepro(EXAMPLE(), at);
    for (const step of [{ ...steps[0], url: "http://localhost:41002/orders/new" }, steps[2], steps[3], steps[4], { n: 2, as: "customer.1", expect: "no-error" }]) {
      const code = stepCode(step, OPTS);
      expect(code.startsWith("async page => {\n  const P = ")).toBe(true);
      expect(code).toContain(HELPERS);
      // The step's answer, whatever it is, and a throw anywhere in it leave through finish, which drains.
      const body = own(code);
      expect(body).toMatch(/\n {2}const finish = async \(x\) => \{\n {4}const d = await drain\(ctx\);\n {4}return \{ \.\.\.x, errors: counted\(d\.errors\), drain: d \};\n {2}\};\n/);
      expect(body.endsWith(`  try {\n    return await finish(await step());\n  } catch (e) {\n    return await finish(${step.do ? '{ ok: false, why: "error", detail: failure(e) }' : '{ held: false, observed: "error", detail: failure(e) }'});\n  }\n}\n`), JSON.stringify(step)).toBe(true);
      expect(body.match(/\n {2}return /g), "no answer bypasses finish").toBeNull();
    }
    expect(() => stepCode({ n: 1, as: "customer.2", do: "login", user: "a", password: "b" }, OPTS)).toThrow(/login has no template/);
    expect(() => stepCode(steps[5], OPTS)).toThrow(/trigger has no template/);
  });

  it("stepCode embeds values only as JSON", () => {
    const value = "'); process.exit(); ('";
    const name = '"}); evil(); ({"';
    const code = stepCode({ n: 1, as: "customer.1", do: "fill", target: { by: "role", role: "textbox", name }, value }, OPTS);
    const lines = code.split("\n");
    const pLine = lines.find((l: string) => l.startsWith("  const P = "))!;
    const tLine = lines.find((l: string) => l.startsWith("  const T = "))!;
    expect(lines.filter((l: string) => l.includes("process.exit") || l.includes("evil()"))).toEqual([pLine, tLine].filter((l) => l.includes("process.exit") || l.includes("evil()")));
    expect(JSON.parse(pLine.slice("  const P = ".length, -1)).value).toBe(value);
    expect(tLine).toMatch(/^ {2}const T = \(pg\) => .*;$/);
    const t = tLine.slice("  const T = (pg) => ".length, -1);
    expect(t).toMatch(SHAPE);
    expect([...t.matchAll(/"(?:[^"\\]|\\.)*"/g)].map((m) => JSON.parse(m[0]))).toEqual(["textbox", "name", name]);
    expect(lines.filter((l: string) => l.includes("const T = "))).toEqual([tLine]);
    expect(stepCode({ n: 1, as: "customer.1", expect: "url", value: "/x" }, OPTS)).toContain("\n  const T = null;\n");
  });

  it("substitute is textual and literal", () => {
    const saved = `O'Brien "x" \\ \${y}`;
    const vars = { order: "ORD-1", note: saved, marker: "argus-0a1b2c3d" };
    const s = substitute({ n: 5, as: "customer.1", expect: "visible", target: { by: "text", value: "{{order}}", within: { by: "testId", value: "row-{{order}}" } } }, vars);
    expect(s.target).toEqual({ by: "text", value: "ORD-1", within: { by: "testId", value: "row-ORD-1" } });
    const fill = substitute({ n: 2, as: "customer.1", do: "fill", target: { by: "label", value: "Note" }, value: "{{note}} {{marker}}" }, vars);
    expect(fill.value).toBe(`${saved} argus-0a1b2c3d`);
    const p = stepCode(fill, OPTS).split("\n").find((l: string) => l.startsWith("  const P = "))!;
    expect(JSON.parse(p.slice("  const P = ".length, -1)).value).toBe(`${saved} argus-0a1b2c3d`);
    expect(substitute({ n: 6, as: "system", do: "trigger", name: "settle", values: ["{{order}}", "{{order}}x"] }, vars).values).toEqual(["ORD-1", "ORD-1x"]);
    // The step itself is unchanged.
    const step = { n: 1, as: "customer.1", do: "goto", path: "/orders/{{order}}" };
    expect(substitute(step, vars).path).toBe("/orders/ORD-1");
    expect(step.path).toBe("/orders/{{order}}");
  });

  it("reductions never offer a trigger, a final, a parallel group, a proving expect or a role's only state-changing step", () => {
    const { steps } = parseRepro(EXAMPLE(), at);
    expect(reductions(steps, { changed: [3] }).map((u: Obj) => u.label)).toEqual(["role customer", "step 8", "step 4", "step 2", "step 1"]);
    expect(reductions(steps, { changed: [3] })[0]).toEqual({ kind: "role", label: "role customer", drop: [1, 2, 3, 4, 5, 7] });
    const twice = parseRepro(
      [
        { as: "customer", do: "goto", path: "/orders/new" },
        { as: "customer", do: "click", target: { role: "button", name: "Place order" } },
        { as: "customer", expect: "visible", target: { testId: "order-number" } },
        { as: "customer", do: "click", target: { role: "button", name: "Cancel order" } },
        { as: "customer", expect: "hidden", target: { role: "button", name: "Cancel order" } },
        { as: "sales", expect: "visible", target: { text: "x" }, final: "handoff" },
      ],
      at,
    ).steps;
    const units = reductions(twice, { changed: [2, 4] });
    expect(units.map((u: Obj) => u.label)).toEqual(["role customer", "steps 4+5", "steps 2+3", "step 1"]);
    expect(units[1]).toEqual({ kind: "step", label: "steps 4+5", drop: [4, 5] });
    // Without the run's record of what changed state, a click is a plain step.
    expect(reductions(twice, { changed: [] }).map((u: Obj) => u.label)).toEqual(["role customer", "step 5", "step 4", "step 3", "step 2", "step 1"]);
    // A parallel group's members are never offered alone.
    const race = parseRepro(
      [
        { as: "customer.1", do: "goto", path: "/inbox" },
        { parallel: [{ as: "customer.1", do: "click", target: { text: "Claim" } }, { as: "customer.2", do: "click", target: { text: "Claim" } }] },
        { as: "customer.1", expect: "visible", target: { testId: "claim", nth: 0 } },
        { as: "customer.2", expect: "visible", target: { testId: "claim", nth: 0 } },
        { as: "customer.1", expect: "count", target: { testId: "claim" }, value: 1, final: "claim-race" },
      ],
      at,
    ).steps;
    expect(reductions(race, { changed: [2, 3] }).map((u: Obj) => u.label)).toEqual(["step 1"]);
  });
});

/** The cycles the repro stubs below leave: each is taken down after its test. */
const reproRuns: { main: string; runId: string }[] = [];
afterEach(async () => {
  for (const r of reproRuns.splice(0)) await down(r.main, { runId: r.runId, graceMs: 1000 }).catch(() => {});
});
/** Slot 1's allocation in the repro stubs: §10's roles and the fixture's. */
const REPRO_ACCOUNTS = { "customer.1": "buyer1@example.test", "sales.1": "sales1@example.test", "buyer.1": "buyer2@example.test", "clerk.1": "clerk1@example.test" };

/**
 * A cycle (spec §8's example as its config) whose slot 1 returned one candidate per repro of `repros`, as
 * the wrapper keeps a return → the cycle, the candidates' refs (`1.1.<k>`) and `dir(ref)`, the candidate's
 * record directory.
 */
const returned = (repros: Obj[][]) => {
  const t = liveRun();
  writeFileSync(join(t.main, ".argus/live.json"), `${JSON.stringify(example(), null, 2)}\n`);
  writeFileSync(join(t.main, ".argus/live.env"), "PW=pw-1\nSALES_TOTP=GEZDGNBVGY3TQOJQ\nDB_PW=db-now\n");
  const ports = { api: 41001, web: 41002, pg: 41003, redis: 41004, smtp: 41005 };
  writeRunFiles(t.main, { runId: t.runId, worktree: t.wt, home: t.home, origins: ["http://localhost:41002"], allowOrigins: [], groups: [], env: t.env, ports, instanceId: "0123456789abcdef", slots: { "1": { journey: "order-to-cash", accounts: REPRO_ACCOUNTS } } });
  reproRuns.push({ main: t.main, runId: t.runId });
  const returns = join(t.main, ".argus/live", t.runId, "returns");
  mkdirSync(returns, { recursive: true, mode: 0o700 });
  const candidates = repros.map((list) => ({ claim: "a seeded defect", oracle: list.at(-1)!.final, repro: list }));
  writeFileSync(join(returns, "1.1.json"), `${JSON.stringify({ journey: "order-to-cash", status: "done", candidates })}\n`);
  const dir = (ref: string) => join(t.main, ".argus/live", t.runId, "repro", ref);
  return { ...t, refs: repros.map((_, k) => `1.1.${k + 1}`), dir };
};

/** A run's answer as runOnce gives it, for exit `code`: its lines in the wrapper's words, the fence, the last line. */
const answerOf = (code: number) => {
  const last = code === 3 ? "REPRODUCED step=2 expected=visible observed=absent" : code === 0 ? "NOT REPRODUCED" : "HARNESS: step 3 missing target";
  const lines = ["fresh: instance 0123456789abcdef", "step 1 customer.1 goto: ok", ...(code === 3 ? ["<<<PAGE-0123456789abcdef0123456789abcdef\nexpected: {}\nPAGE-0123456789abcdef0123456789abcdef>>>"] : []), last];
  return { code, lines, result: { exit: code, expected: code === 3 ? "visible" : null, observed: code === 3 ? "absent" : null } };
};

describe("argus-live repro — two of two", () => {
  /** A `once` answering `exits` in turn, recording what each call was given. */
  const stub = (exits: number[]) => {
    const calls: Obj[] = [];
    const once = async (_main: string, ref: string, opts: Obj) => {
      calls.push({ ref, ...opts });
      return answerOf(exits[calls.length - 1]);
    };
    return { once, calls };
  };
  const LIST = [{ as: "customer", do: "goto", path: "/" }, { as: "customer", expect: "visible", target: { text: "x" }, final: "discoverability" }];
  const verdict = (t: ReturnType<typeof returned>) => JSON.parse(readFileSync(join(t.dir(t.refs[0]), "verdict.json"), "utf8"));

  it("3 then 3 reproduces: each run's lines prefixed, run 2's REPRODUCED line last", async () => {
    const t = returned([LIST]);
    const s = stub([3, 3]);
    const said: string[] = [];
    const r = await repro(t.main, t.refs[0], { once: s.once, say: (l: string) => said.push(l) });
    expect(r.code).toBe(3);
    expect(r.lines.at(-1)).toBe("REPRODUCED step=2 expected=visible observed=absent");
    expect(r.lines).toContain("run 1 step 1 customer.1 goto: ok");
    expect(r.lines).toContain("run 2 REPRODUCED step=2 expected=visible observed=absent");
    // A fence stays whole: its nonce lines are never prefixed.
    expect(r.lines.filter((l: string) => l.startsWith("<<<PAGE-"))).toHaveLength(2);
    expect(s.calls.map((c) => [c.ref, c.i])).toEqual([[t.refs[0], 1], [t.refs[0], 2]]);
    expect(verdict(t)).toEqual({ runs: [3, 3], verdict: "reproduced" });
    expect(statSync(join(t.dir(t.refs[0]), "verdict.json")).mode & 0o777).toBe(0o600);
  });

  it("3 then 0 is intermittent; 0 stops after one run", async () => {
    const t = returned([LIST]);
    const once30 = stub([3, 0]);
    const r = await repro(t.main, t.refs[0], { once: once30.once });
    expect([r.code, r.lines.at(-1)]).toEqual([0, "NOT REPRODUCED runs=1/2"]);
    expect(verdict(t)).toEqual({ runs: [3, 0], verdict: "intermittent" });
    const once0 = stub([0]);
    const n = await repro(t.main, t.refs[0], { once: once0.once });
    expect([n.code, n.lines.at(-1)]).toEqual([0, "NOT REPRODUCED runs=0/1"]);
    expect(once0.calls).toHaveLength(1);
    expect(verdict(t)).toEqual({ runs: [0], verdict: "not-reproduced" });
  });

  it("a harness failure stops at once and is never counted as reproduced", async () => {
    const t = returned([LIST]);
    const once2 = stub([2]);
    const h = await repro(t.main, t.refs[0], { once: once2.once });
    expect([h.code, h.lines.at(-1)]).toEqual([2, "HARNESS: run 1: step 3 missing target"]);
    expect(once2.calls).toHaveLength(1);
    expect(verdict(t)).toEqual({ runs: [2], verdict: "harness" });
    const once32 = stub([3, 2]);
    const h2 = await repro(t.main, t.refs[0], { once: once32.once });
    expect([h2.code, h2.lines.at(-1)]).toEqual([2, "HARNESS: run 2: step 3 missing target"]);
    expect(verdict(t)).toEqual({ runs: [3, 2], verdict: "harness" });
    // An exit 3 without its REPRODUCED line is the harness's (spec §10 "Exit codes").
    const bare = async () => ({ code: 3, lines: ["fresh: instance 0123456789abcdef"], result: {} });
    const b = await repro(t.main, t.refs[0], { once: bare });
    expect([b.code, b.lines.at(-1)]).toEqual([2, "HARNESS: run 1: exit 3 without its REPRODUCED line"]);
  });

  it("a run is numbered after the candidate's records, never over one", async () => {
    const t = returned([LIST]);
    mkdirSync(t.dir(t.refs[0]), { recursive: true });
    for (const i of [1, 2]) writeFileSync(join(t.dir(t.refs[0]), `run-${i}.json`), JSON.stringify({ exit: 3, reduced: i === 2 }));
    const s = stub([3, 3]);
    expect((await repro(t.main, t.refs[0], { once: s.once })).code).toBe(3);
    expect(s.calls.map((c) => c.i)).toEqual([3, 4]);
    // One run (--once) on its own: the next number too, and the records before it untouched.
    const failed = Object.assign(new Error("failed: x"), { step: "3 store" });
    const r = await runOnce(t.main, t.refs[0], { fresh: async () => Promise.reject(failed) });
    expect([r.code, r.lines.at(-1)]).toEqual([2, "HARNESS: up --fresh failed at 3 store"]);
    expect(readdirSync(t.dir(t.refs[0])).filter((f) => /^run-\d+\.json$/.test(f)).sort()).toEqual(["run-1.json", "run-2.json", "run-3.json"]);
    expect(JSON.parse(readFileSync(join(t.dir(t.refs[0]), "run-1.json"), "utf8"))).toEqual({ exit: 3, reduced: false });
  }, 30_000);

  it("repro --saved prints the values the reproducing run read, masked by scrub's rules", () => {
    const t = returned([LIST]);
    const dir = t.dir(t.refs[0]);
    mkdirSync(dir, { recursive: true });
    appendLedger(t.main, t.runId, [{ c: "cookie", v: "CookieVal_7731x" }]);
    const saved = { order: "ORD-1", token: "CookieVal_7731x", pw: "pw-1", blob: "sk_li\u0076e_51HxYzAbCdEfGh1234567890", line: "a\nb" };
    writeFileSync(join(dir, "run-1.json"), JSON.stringify({ exit: 3, saved }));
    writeFileSync(join(dir, "run-2.json"), JSON.stringify({ exit: 3, reduced: true, saved: { order: "ORD-9" } }));
    const cli = () => spawnSync(process.execPath, [ARGUS_LIVE, "repro", t.refs[0], "--saved"], { cwd: t.main, encoding: "utf8", env: { PATH: process.env.PATH! } });
    const r = cli();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe(['saved order: "ORD-1"', "saved token: *** (cookie)", "saved pw: *** (env file)", 'saved blob: "<redacted>"', 'saved line: "a\\nb"', ""].join("\n"));
    // An incomplete ledger: nothing of the run is fileable, so nothing is shown.
    appendLedger(t.main, t.runId, [{ c: "incomplete", v: "s-1 lost before its drain" }]);
    expect([cli().status, cli().stdout]).toEqual([1, "refused: scrub: the run's secret ledger is incomplete (s-1 lost before its drain); nothing from this run is filed\n"]);
    rmSync(join(dir, "run-1.json"));
    expect(cli().stderr).toBe(`refused: repro: ${t.refs[0]} has no reproducing run (repro ${t.refs[0]} first)\n`);
  }, 30_000);

  it("a candidate the return lacks is refused", async () => {
    const t = returned([LIST]);
    await expect(repro(t.main, "1.1.9", { once: stub([3]).once })).rejects.toThrow("refused: repro: return 1.1 has no candidate 9");
  });
});

describe("argus-live classes", () => {
  const BUG = ["bug", "argus", "found-by:user"];
  it("CLASSES holds one row per oracle", () => {
    expect(Object.keys(CLASSES)).toEqual(ORACLES);
    expect(() => classify({ oracle: "typo" })).toThrow("refused: classify: typo is not an oracle");
  });
  it("dead end: A, S1 on a money journey, else S2", () => {
    expect(classify({ oracle: "dead-end", money: true })).toMatchObject({ cls: "A", labels: BUG, severity: "S1" });
    expect(classify({ oracle: "dead-end", money: false })).toMatchObject({ cls: "A", labels: BUG, severity: "S2" });
  });
  it("reversal: A, S1", () => {
    expect(classify({ oracle: "reversal" })).toMatchObject({ cls: "A", labels: BUG, severity: "S1" });
  });
  it("claim race: A, S1 only when money or stock moved twice", () => {
    expect(classify({ oracle: "claim-race", movedTwice: true })).toMatchObject({ cls: "A", labels: BUG, severity: "S1" });
    expect(classify({ oracle: "claim-race", money: true, stock: true })).toMatchObject({ cls: "A", labels: BUG, severity: "S2" });
  });
  it("stale view: A, S1 on money or stock, else S2", () => {
    expect(classify({ oracle: "stale-view", money: true })).toMatchObject({ severity: "S1" });
    expect(classify({ oracle: "stale-view", stock: true })).toMatchObject({ cls: "A", labels: BUG, severity: "S1" });
    expect(classify({ oracle: "stale-view" })).toMatchObject({ cls: "A", labels: BUG, severity: "S2" });
  });
  it("status coherence: A, S2 when a role acts on the fact, else S3", () => {
    expect(classify({ oracle: "status-coherence", actedOn: true })).toMatchObject({ cls: "A", labels: BUG, severity: "S2" });
    expect(classify({ oracle: "status-coherence" })).toMatchObject({ cls: "A", labels: BUG, severity: "S3" });
  });
  it("orphaned work: A, S3", () => {
    expect(classify({ oracle: "orphaned-work", money: true })).toMatchObject({ cls: "A", labels: BUG, severity: "S3" });
  });
  it("interrupted flow and viewport/locale: A, by outcome", () => {
    for (const oracle of ["interrupted-flow", "viewport-locale"]) expect(classify({ oracle }), oracle).toMatchObject({ cls: "A", labels: BUG, severity: "by outcome" });
  });
  it("handoff, re-entry, discoverability, unreachable step: B(a) with a written rule, else heuristic and needs-owner, at most S3", () => {
    for (const oracle of ["handoff", "re-entry", "discoverability", "unreachable-step"]) {
      expect(classify({ oracle, rule: true }), oracle).toMatchObject({ cls: "B(a)", labels: ["class:business", "workflow", "argus", "found-by:user"], severity: "at most S3" });
      expect(classify({ oracle }), oracle).toMatchObject({ cls: "heuristic", labels: ["ux", "workflow", "argus:needs-owner", "argus", "found-by:user"], severity: "at most S3" });
    }
    expect(classify({ oracle: "handoff", needsOwner: "owner:rule" }).labels).toEqual(["ux", "workflow", "owner:rule", "argus", "found-by:user"]);
  });

  it("each seeded defect's class line", () => {
    const main = committed();
    const line = (...args: string[]) => {
      const r = spawnSync(process.execPath, [ARGUS_LIVE, "classify", ...args], { cwd: main, encoding: "utf8" });
      expect(r.status, r.stderr).toBe(0);
      return r.stdout;
    };
    expect(line("--oracle", "handoff")).toBe("class heuristic labels ux,workflow,argus:needs-owner,argus,found-by:user severity at most S3 because handoff signal with no written rule\n");
    expect(line("--oracle", "dead-end", "--money")).toBe("class A labels bug,argus,found-by:user severity S1 because dead end on a money journey\n");
    expect(line("--oracle", "reversal", "--stock")).toBe("class A labels bug,argus,found-by:user severity S1 because reversal: a resource not released exactly once\n");
    expect(line("--oracle", "claim-race", "--moved-twice")).toBe("class A labels bug,argus,found-by:user severity S1 because claim race that moved money or stock twice\n");
    expect(line("--oracle", "stale-view", "--stock")).toBe("class A labels bug,argus,found-by:user severity S1 because stale view on money or stock\n");
    expect(line("--oracle", "orphaned-work")).toBe("class A labels bug,argus,found-by:user severity S3 because orphaned work\n");
    expect(line("--oracle", "viewport-locale")).toBe("class A labels bug,argus,found-by:user severity by outcome because viewport or locale: rated by its outcome, as argus rates\n");
    const bad = spawnSync(process.execPath, [ARGUS_LIVE, "classify", "--oracle", "handoff", "--money", "--money"], { cwd: main, encoding: "utf8" });
    expect(bad.status).toBe(1);
  }, 30_000);
});

describe("argus-live minimize", () => {
  const S = {
    1: { as: "buyer", do: "goto", path: "/orders/new" },
    2: { as: "buyer", do: "fill", target: { label: "Quantity" }, value: "2" },
    3: { as: "buyer", do: "hover", target: { role: "heading", name: "New order" } },
    4: { as: "buyer", do: "click", target: { role: "button", name: "Place order" } },
    5: { as: "buyer", expect: "visible", target: { testId: "order-number" } },
    6: { as: "clerk", do: "goto", path: "/inbox" },
    7: { as: "clerk", do: "hover", target: { role: "heading", name: "Inbox" } },
    8: { as: "clerk", expect: "visible", target: { text: "ORD-1" }, final: "handoff" },
  } as Record<number, Obj>;
  const EIGHT = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => S[n]);
  const CONTEXT = { context: { viewport: 1440, locale: "en-US", timezone: "UTC" } };
  /** How the reproducing run failed its final: what a kept reduction must fail the same way. */
  const FAILED = { expected: "visible", observed: "absent", shownSha256: "same" };
  const has = (list: Obj[], step: Obj) => list.some((x) => JSON.stringify(x) === JSON.stringify(step));
  /** The candidate's reproducing run (run 1, exit 3, step 4 changed state), as runOnce records it. */
  const reproduced = (t: ReturnType<typeof returned>, ref: string, changed: number[]) => {
    mkdirSync(t.dir(ref), { recursive: true });
    writeFileSync(join(t.dir(ref), "run-1.json"), JSON.stringify({ exit: 3, step: 8, ...FAILED, ms: 1, saved: {}, traces: [], changed }));
  };
  /** A `once` answering 3 (failed as FAILED) exactly while steps 2 and 6 are both in its list, else 0; `force` overrides call k's exit. */
  const essential = (force: Record<number, number> = {}) => {
    const calls: Obj[] = [];
    const once = async (_main: string, _ref: string, opts: Obj) => {
      calls.push(opts);
      const code = force[calls.length] ?? (has(opts.list, S[2]) && has(opts.list, S[6]) ? 3 : 0);
      return { code, lines: ["fresh: instance 0123456789abcdef", code === 3 ? "REPRODUCED step=1 expected=visible observed=absent" : "NOT REPRODUCED"], result: { exit: code, ...(code === 3 ? FAILED : {}) } };
    };
    return { once, calls };
  };
  const json = (t: ReturnType<typeof returned>, file: string) => JSON.parse(readFileSync(join(t.dir(t.refs[0]), file), "utf8"));

  it("keeps the essential steps and every step it may not drop, to a fixpoint, and confirms", async () => {
    const t = returned([EIGHT]);
    reproduced(t, t.refs[0], [4]);
    const s = essential();
    const r = await minimize(t.main, t.refs[0], { once: s.once });
    expect(r.code).toBe(0);
    expect(json(t, "min.json")).toEqual([CONTEXT, S[2], S[4], S[5], S[6], S[8]]);
    const m = json(t, "minimize.json");
    expect(m.tried).toEqual([
      { label: "role buyer", exit: 0 },
      { label: "step 7", exit: 3 },
      { label: "step 6", exit: 0 },
      { label: "step 3", exit: 3 },
      { label: "step 2", exit: 0 },
      { label: "step 1", exit: 3 },
    ]);
    expect(m).toMatchObject({ runs: 7, max: 12, stopped: "fixpoint", from: 8, to: 5, confirmed: true });
    expect(r.lines.at(-1)).toBe(`minimized ${t.refs[0]}: steps 8 → 5, runs 7/12, stopped fixpoint, confirmed yes`);
    // Only the tried labels and exits: no browser output.
    expect(r.lines.slice(0, -1)).toEqual([...m.tried.map((x: Obj) => `try ${x.label}: exit ${x.exit}`), "confirm: exit 3"]);
    // Each try is a run of its own, numbered after the reproducing run; the confirm run is the last.
    expect(s.calls.map((c) => c.i)).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect(s.calls.at(-1)!.list).toEqual(json(t, "min.json"));
    expect(statSync(join(t.dir(t.refs[0]), "min.json")).mode & 0o777).toBe(0o600);
  });

  it("stops at its budget, one run kept for the confirm; an unconfirmed result is not written", async () => {
    const t = returned([EIGHT]);
    reproduced(t, t.refs[0], [4]);
    const s = essential();
    const r = await minimize(t.main, t.refs[0], { once: s.once, max: 3 });
    expect(json(t, "minimize.json")).toMatchObject({ runs: 3, max: 3, stopped: "budget", tried: [{ label: "role buyer", exit: 0 }, { label: "step 7", exit: 3 }], confirmed: true });
    expect(json(t, "min.json")).toEqual([CONTEXT, ...EIGHT.filter((x) => x !== S[7])]);
    expect(r.lines.at(-1)).toBe(`minimized ${t.refs[0]}: steps 8 → 7, runs 3/3, stopped budget, confirmed yes`);
    const no = essential({ 3: 0 });
    const u = await minimize(t.main, t.refs[0], { once: no.once, max: 3 });
    expect(u.lines.at(-1)).toBe(`minimized ${t.refs[0]}: steps 8 → 7, runs 3/3, stopped budget, confirmed no`);
    expect(existsSync(join(t.dir(t.refs[0]), "min.json"))).toBe(false);
  });

  it("a reduction that fails its final another way is not kept", async () => {
    const t = returned([EIGHT]);
    reproduced(t, t.refs[0], [4]);
    // Every run reproduces, but what the final saw differs from the reproducing run's (a reversal without its cancel).
    const other = async () => ({ code: 3, lines: ["REPRODUCED step=1 expected=visible observed=absent"], result: { exit: 3, ...FAILED, shownSha256: "other" } });
    const r = await minimize(t.main, t.refs[0], { once: other });
    const m = json(t, "minimize.json");
    expect(m.tried.every((x: Obj) => x.exit === 3)).toBe(true);
    expect([m.from, m.to, m.confirmed]).toEqual([8, 8, false]);
    expect(r.lines.at(-1)).toBe(`minimized ${t.refs[0]}: steps 8 → 8, runs 7/12, stopped fixpoint, confirmed no`);
  });

  it("never tries a trigger or the final; a reduction the static checks refuse costs no run", async () => {
    const example10 = [
      CONTEXT,
      { as: "customer", do: "goto", path: "/orders/new" },
      { as: "customer", do: "fill", target: { label: "Quantity" }, value: "2" },
      { as: "customer", do: "click", target: { role: "button", name: "Place order" } },
      { as: "customer", do: "read", target: { testId: "order-number" }, save: "order" },
      { as: "customer", expect: "visible", target: { text: "{{order}}" } },
      { as: "system", do: "trigger", name: "payment-settles", values: ["{{order}}"] },
      { as: "customer", expect: "fact-equals", marker: "{{order}}", field: "status", value: "paid" },
      { as: "sales", do: "goto", path: "/" },
      { as: "sales", expect: "visible", target: { text: "{{order}}" }, final: "handoff" },
    ];
    const t = returned([example10]);
    reproduced(t, t.refs[0], [3]);
    const calls: Obj[] = [];
    const always = async (_m: string, _r: string, opts: Obj) => {
      calls.push(opts);
      return { code: 3, lines: ["REPRODUCED step=1 expected=visible observed=absent"], result: { exit: 3, ...FAILED } };
    };
    const r = await minimize(t.main, t.refs[0], { once: always });
    const labels = json(t, "minimize.json").tried.map((x: Obj) => x.label);
    expect(labels).not.toContain("step 6");
    expect(labels).not.toContain("step 9");
    // Dropping customer, or the read that saves {{order}}, leaves a placeholder no read saves: skipped without a run.
    expect(json(t, "minimize.json").tried.filter((x: Obj) => x.exit === null).map((x: Obj) => x.label)).toEqual(["role customer", "step 4"]);
    expect(r.lines).toContain("try role customer: skipped (the static checks refuse it)");
    expect(calls).toHaveLength(json(t, "minimize.json").runs);
  });

  it("stops before a try once the cycle is down, or too little of its deadline is left", async () => {
    const t = returned([EIGHT]);
    reproduced(t, t.refs[0], [4]);
    const s = essential();
    // The cycle goes down after the second try: no third try, no confirm run, nothing written as minimized.
    const once = async (m: string, r: string, opts: Obj) => {
      const a = await s.once(m, r, opts);
      if (s.calls.length === 2) rmSync(join(t.main, ".argus/live/lock.json"));
      return a;
    };
    const r = await minimize(t.main, t.refs[0], { once });
    expect(r.code).toBe(2);
    expect(r.lines).toEqual(["try role buyer: exit 0", "try step 7: exit 3", `minimized ${t.refs[0]}: steps 8 → 7, runs 2/12, stopped down, confirmed no`]);
    expect(json(t, "minimize.json")).toMatchObject({ runs: 2, stopped: "down", confirmed: false });
    expect(existsSync(join(t.dir(t.refs[0]), "min.json"))).toBe(false);
    // A deadline closer than the longest run so far (a minute at least): stopped before the first try.
    const u = returned([EIGHT]);
    reproduced(u, u.refs[0], [4]);
    setLock(u.main, { ...u.lock, deadline: now() + 30 });
    const none = essential();
    const d = await minimize(u.main, u.refs[0], { once: none.once });
    expect([d.code, d.lines]).toEqual([2, [`minimized ${u.refs[0]}: steps 8 → 8, runs 0/12, stopped deadline, confirmed no`]]);
    expect(none.calls).toEqual([]);
  });

  it("refuses a candidate that never reproduced", async () => {
    const t = returned([EIGHT]);
    await expect(minimize(t.main, t.refs[0], { once: essential().once })).rejects.toThrow(`refused: repro: ${t.refs[0]} has no reproducing run (repro ${t.refs[0]} first)`);
  });
});

describe("argus-live generated RED test", () => {
  const GOLDEN = join(__dirname, "fixtures/argus-red/order-to-cash.handoff.spec.ts");
  /** The RED test of `list` as candidate 1.1.1 of journey order-to-cash, its oracle the final's. */
  const red = (list: Obj[], settleMs = 3000) => {
    const { context, steps } = parseRepro(list, at);
    return redTest({ journey: "order-to-cash", oracle: steps.at(-1).final, ref: "1.1.1", context, steps, settleMs });
  };
  /** `ts` stripped of its types and parsed by `node --check` (as an .mjs file) → its exit and stderr. */
  const check = (ts: string) => {
    const file = join(tempDir(), "red.mjs");
    writeFileSync(file, stripTypeScriptTypes(ts));
    const r = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    return { code: r.status, err: r.stderr };
  };

  it("the §10 example matches the golden file", () => {
    expect(red(EXAMPLE())).toBe(readFileSync(GOLDEN, "utf8"));
  });

  it("saved names never collide", () => {
    expect(() => parseRepro([{ as: "customer", do: "read", target: { testId: "n" }, save: "marker" }, FINAL_EXPECT], at)).toThrow("save takes a name");
    const text = red([
      { as: "customer", do: "goto", path: "/orders/new" },
      { as: "customer", do: "read", target: { testId: "order-number" }, save: "settle" },
      { as: "customer", do: "read", target: { testId: "order-number" }, save: "customer1" },
      { as: "customer", do: "read", target: { testId: "order-number" }, save: "order" },
      { as: "customer", do: "fill", target: { label: "Note" }, value: "x {{order}}" },
      { as: "sales", expect: "visible", target: { text: "{{settle}}{{customer1}}" }, final: "handoff" },
    ]);
    expect(text).toContain("  const saved_settle = await readValue(customer1.getByTestId(\"order-number\"));\n");
    expect(text).toContain("  const saved_customer1 = await readValue(customer1.getByTestId(\"order-number\"));\n");
    expect(text).toContain('  await customer1.getByLabel("Note").fill("x " + saved_order);\n');
    expect(text).toContain("  await expect(sales1.getByText(saved_settle + saved_customer1)).toBeVisible({ timeout: SETTLE });\n");
    expect(check(text).code).toBe(0);
  });

  it("the test is valid TypeScript", () => {
    expect(check(readFileSync(GOLDEN, "utf8"))).toEqual({ code: 0, err: "" });
    const race = red([
      { context: { viewport: 390, locale: "de-DE" } },
      { as: "customer.1", do: "goto", path: "/inbox" },
      { as: "customer.2", do: "goto", path: "/inbox" },
      { parallel: [{ as: "customer.1", do: "click", target: { role: "button", name: "Claim" } }, { as: "customer.2", do: "click", target: { role: "button", name: "Claim" } }] },
      { as: "customer.1", expect: "visible", target: { testId: "claim", nth: 0 } },
      { as: "customer.2", expect: "visible", target: { testId: "claim", nth: 0 } },
      { as: "customer.1", do: "reload" },
      { as: "customer.1", expect: "no-error" },
      { as: "system", expect: "mail", to: "buyer1@example.test", contains: "Claimed" },
      { as: "customer.1", expect: "count", target: { testId: "claim" }, value: 1, final: "claim-race" },
    ]);
    expect(check(race)).toEqual({ code: 0, err: "" });
    expect(race).toContain('const CONTEXT: BrowserContextOptions = {"viewport": {"width": 390, "height": 900}, "locale": "de-DE", "timezoneId": "UTC"};\n');
    expect(race).toContain('  await Promise.all([\n    customer1.getByRole("button", {"name": "Claim"}).click(),\n    customer2.getByRole("button", {"name": "Claim"}).click(),\n  ]);\n');
    // no-error: a collector on the page, cleared before the step before it, read at it.
    expect(race).toContain("  const errors_customer1 = collectErrors(customer1);\n");
    expect(race).toContain("  errors_customer1.length = 0;\n  await customer1.reload();\n");
    expect(race).toContain("  expect(errors_customer1).toEqual([]);\n");
    expect(race).toContain("  // final (claim-race): the correct behaviour, RED while the defect is there\n  await expect(customer1.getByTestId(\"claim\")).toHaveCount(1, { timeout: SETTLE });\n");
    // Every other kind, an account the run creates and anon too.
    const every = red([
      { as: "anon.1", do: "goto", path: "/signup" },
      { as: "anon.1", do: "fill", target: { placeholder: "Email" }, value: "{{marker}}@example.test" },
      { as: "anon.1", do: "press", key: "Enter" },
      { as: "anon.1", expect: "text-contains", target: { role: "status" }, value: "Welcome" },
      { as: "customer.2", do: "login", user: "{{marker}}@example.test", password: "pw-{{marker}}" },
      { as: "customer.2", expect: "url", value: "/" },
      { as: "customer.1", do: "goto", path: "/orders/new" },
      { as: "customer.1", do: "select", target: { label: "Size" }, value: "L" },
      { as: "customer.1", expect: "value-equals", target: { label: "Size" }, value: "L" },
      { as: "customer.1", do: "check", target: { label: "Gift", exact: true } },
      { as: "customer.1", expect: "enabled", target: { role: "button", name: "Place order", exact: false } },
      { as: "customer.1", do: "uncheck", target: { label: "Gift" } },
      { as: "customer.1", expect: "hidden", target: { text: "Gift wrap", within: { testId: "extras" } } },
      { as: "customer.1", do: "dblclick", target: { text: "Size" } },
      { as: "customer.1", do: "hover", target: { text: "Size" } },
      { as: "customer.1", do: "press", key: "Tab", target: { label: "Size" } },
      { as: "customer.1", do: "go-back" },
      { as: "customer.1", expect: "text-equals", target: { role: "heading" }, value: "Home" },
      { as: "customer.1", expect: "fact-equals", marker: "{{marker}}", field: "quantity", value: 2, final: "status-coherence" },
    ]);
    expect(check(every)).toEqual({ code: 0, err: "" });
    expect(every).toContain("// RED until the defect is fixed. Wire signedIn, login, trigger, fact and mail to this repo's E2E helpers.\n");
    expect(every).toContain("  const anon1 = await browser.newPage(CONTEXT);\n  const customer2 = await browser.newPage(CONTEXT);\n  const customer1 = await signedIn(browser, \"customer.1\", CONTEXT);\n");
    expect(every).toContain('  await login(customer2, marker + "@example.test", "pw-" + marker);\n');
    expect(every).toContain('  await expect(customer2).toHaveURL((u) => u.pathname + u.search === "/" || u.pathname === "/", { timeout: SETTLE });\n');
    expect(every).toContain('  await anon1.keyboard.press("Enter");\n');
    expect(every).toContain("  await expect.poll(() => fact(marker, \"quantity\"), { timeout: SETTLE }).toBe(2);\n");
  }, 30_000);

  it("strings never become code", () => {
    const value = "`${process.exit()}`";
    const name = '"); x("';
    const text = red([
      { as: "customer", do: "goto", path: "/orders/new" },
      { as: "customer", do: "fill", target: { label: "Note" }, value },
      { as: "customer", do: "click", target: { role: "button", name } },
      { as: "customer", expect: "visible", target: { text: value } },
      { as: "sales", expect: "visible", target: { text: name }, final: "handoff" },
    ]);
    expect(check(text)).toEqual({ code: 0, err: "" });
    expect(text).toContain(`.fill(${JSON.stringify(value)})`);
    expect(text).toContain(`getByRole("button", {"name": ${JSON.stringify(name)}})`);
    // Each occurrence sits inside its JSON string literal.
    for (const line of text.split("\n").filter((l) => l.includes("process.exit"))) expect(line).toContain(JSON.stringify(value));
    // The header and the title take only an id, a ref and an oracle.
    const { context, steps } = parseRepro(EXAMPLE(), at);
    expect(() => redTest({ journey: "x\nprocess.exit()", oracle: "handoff", ref: "1.1.1", context, steps, settleMs: 3000 })).toThrow("failed: redTest: a journey id is kebab-case");
  });

  it("repro --test writes red.spec.ts from the confirmed min.json, else repro.json", () => {
    const t = returned([EXAMPLE()]);
    const dir = t.dir(t.refs[0]);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "repro.json"), JSON.stringify({ ref: t.refs[0], repro: EXAMPLE() }));
    const cli = () => spawnSync(process.execPath, [ARGUS_LIVE, "repro", t.refs[0], "--test"], { cwd: t.main, encoding: "utf8" });
    // A RED test only for what reproduced two of two.
    for (const v of [null, { runs: [3, 0], verdict: "intermittent" }]) {
      if (v) writeFileSync(join(dir, "verdict.json"), JSON.stringify(v));
      const no = cli();
      expect([no.status, no.stderr]).toEqual([1, `refused: repro: ${t.refs[0]} did not reproduce two of two (${v ? v.verdict : "never run"}); repro ${t.refs[0]} first\n`]);
    }
    writeFileSync(join(dir, "verdict.json"), JSON.stringify({ runs: [3, 3], verdict: "reproduced" }));
    const r = cli();
    expect(r.status, r.stderr).toBe(0);
    const file = join(realpathSync(dir), "red.spec.ts");
    expect(r.stdout).toBe(`red test: ${file}\n`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // Spec §8's example config: settle_ms 10000.
    expect(readFileSync(file, "utf8")).toBe(readFileSync(GOLDEN, "utf8").replace("const SETTLE = 3000;", "const SETTLE = 10000;"));
    const min = [EXAMPLE()[0], ...EXAMPLE().slice(1, 6), ...EXAMPLE().slice(8)];
    writeFileSync(join(dir, "min.json"), JSON.stringify(min));
    writeFileSync(join(dir, "minimize.json"), JSON.stringify({ confirmed: false }));
    expect(cli().status).toBe(0);
    expect(readFileSync(file, "utf8")).toContain('await trigger("payment-settles"');
    writeFileSync(join(dir, "minimize.json"), JSON.stringify({ confirmed: true }));
    expect(cli().status).toBe(0);
    expect(readFileSync(file, "utf8")).not.toContain("await trigger(");
  }, 30_000);
});

// The values of each secret class scrub knows, as one run holds them (each its own, none inside another).
const SCRUB = {
  cookie: "CookieVal_7731x",
  header: "HdrVal_55821q",
  storage: "StoreVal_90412",
  made: "Made-pw-4417",
  envFile: "Env-Secret-9931",
  repoEnv: "Repo-Secret-77",
  role: "Role-pw-6620",
  totp: "JBSWY3DPEHPK3PXP",
  gh: "ghp_scrubtest123456",
  build: "Ab3$xYz9Qw2!Lm5Np",
};
/** A home directory as plain configuration holds one: lower case and slashes only, never secret-like. */
const PLAIN_HOME = ["", "home", "scrub-tester"].join("/");
const SCRUB_ENV = { GH_TOKEN: SCRUB.gh, HOME: PLAIN_HOME, BUILD_ID: SCRUB.build };
/** Each class with the value the run holds of it. */
const SCRUB_CLASSES: [string, string][] = [
  ["cookie", SCRUB.cookie],
  ["header", SCRUB.header],
  ["storage", SCRUB.storage],
  ["created password", SCRUB.made],
  ["env file", SCRUB.envFile],
  ["repo env file", SCRUB.repoEnv],
  ["role password", SCRUB.role],
  ["TOTP secret", SCRUB.totp],
  ["environment variable GH_TOKEN", SCRUB.gh],
];
/** The forms a secret is written in: raw, every byte URL-encoded, base64 and spelled out with spaces. */
const SCRUB_FORMS: Record<string, (v: string) => string> = {
  raw: (v) => v,
  url: (v) => [...Buffer.from(v)].map((b) => `%${b.toString(16).toUpperCase().padStart(2, "0")}`).join(""),
  base64: (v) => Buffer.from(v).toString("base64"),
  spaced: (v) => [...v].join(" "),
};
/** Every form a leaked value could take in what scrub printed or sent: raw, URL-encoded (both ways), base64 (all three), and with separators stripped on both sides. */
const leaked = (text: string, values: string[]) => {
  const flat = (s: string) => s.replace(/[\s\p{P}\p{S}]/gu, "");
  return values.filter((v) => {
    const b64 = Buffer.from(v).toString("base64");
    const forms = [v, encodeURIComponent(v), SCRUB_FORMS.url(v), b64, b64.replace(/=+$/, ""), Buffer.from(v).toString("base64url")];
    return forms.some((f) => text.includes(f)) || (flat(v).length >= 6 && flat(text).includes(flat(v)));
  });
};

/** A run as scrub reads it: the live config (roles with a password and a TOTP secret), its env file, a repo .env, and a ledger holding one value of each ledger class and a created password. */
const scrubRun = () => {
  const t = liveRun();
  const c = {
    start: [{ name: "web", cmd: "true" }],
    base_url: "http://localhost:{port:web}",
    login_url: "/login",
    logged_in: "getByRole('button', { name: 'Account' })",
    env_file: ".argus/live.env",
    store: "app_explore",
    store_check: "true",
    reset: "true",
    confirmed: { mocks: true, data: true },
    port_range: [41000, 41999],
    settle_ms: 5000,
    roles: { anon: {}, buyer: { users: [{ user: "buyer1@example.test", password: SCRUB.role }] }, clerk: { users: [{ user: "clerk1@example.test", password: "pw1", totp_secret: SCRUB.totp }] } },
    limits: { max_cycle_minutes: 45 },
  };
  writeFileSync(join(t.main, ".argus/live.json"), JSON.stringify(c));
  writeFileSync(join(t.main, ".argus/live.env"), `APP_SECRET=${SCRUB.envFile}\n`);
  writeFileSync(join(t.main, ".env"), `DB_PASSWORD=${SCRUB.repoEnv}\nPORT=3000\n`);
  appendLedger(t.main, t.runId, [
    { c: "cookie", v: SCRUB.cookie },
    { c: "header", v: SCRUB.header },
    { c: "storage", v: SCRUB.storage },
    { c: "created password", v: SCRUB.made },
  ]);
  const body = (text: string) => {
    const file = join(tempDir(), "body.md");
    writeFileSync(file, text);
    return file;
  };
  const run = (title: string, file: string, opts: Obj = {}, env: Obj = SCRUB_ENV) => scrub(t.main, { run: t.runId, title, bodyFile: file, ...opts }, { env, ...(opts.gh ? { gh: opts.gh } : {}) });
  return { ...t, body, run };
};

describe("argus-live scrub", () => {
  const REFUSED = (k: number) => `refused: scrub: ${k} secret(s) in the issue; nothing is filed`;

  it("each secret class is refused, raw, URL-encoded, base64-encoded and split by spaces, in the title and in the body", async () => {
    const t = scrubRun();
    expect(scrubSecrets(t.main, { runId: t.runId, env: SCRUB_ENV }).refusal).toBeNull();
    for (const [cls, v] of SCRUB_CLASSES) {
      for (const [form, encode] of Object.entries(SCRUB_FORMS)) {
        // In the title and in the body at once: one line places each.
        const text = `Summary\n\nsee ${encode(v)} here\n`;
        const held = t.body(text);
        expect(await t.run(`Order ${encode(v)} failed`, held), `${cls} ${form}`).toEqual({ code: 1, out: [`title 1:7 ${cls}`, `body 3:5 ${cls}`, REFUSED(2)] });
        expect(readFileSync(held, "utf8")).toBe(text);
      }
    }
  }, 60_000); // 36 scrubs, each reading the configuration and the contract (git): past 5 s while the suite's browser tests load the machine

  it("a refusal says where, never what", async () => {
    const t = scrubRun();
    const text = `intro line\n\nValue ${SCRUB.cookie} end\nlast words\n`;
    const file = t.body(text);
    const r = await t.run("A title", file);
    expect(r).toEqual({ code: 1, out: ["body 3:7 cookie", REFUSED(1)] });
    for (const word of ["intro", "Value", "end", "last", "words", "A title"]) expect(r.out.join("\n")).not.toContain(word);
    expect(leaked(r.out.join("\n"), Object.values(SCRUB))).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe(text);
    // Through the CLI too: neither stdout nor stderr holds any recorded secret, in any form.
    const cli = spawnSync(process.execPath, [ARGUS_LIVE, "scrub", "--run", t.runId, "--title", `T ${SCRUB.role}`, "--body", file], { cwd: t.main, encoding: "utf8", env: { ...SCRUB_ENV, PATH: process.env.PATH! } });
    expect(cli.status).toBe(1);
    expect(cli.stdout.trimEnd().split("\n")).toEqual(["title 1:3 role password", "body 3:7 cookie", REFUSED(2)]);
    expect(leaked(`${cli.stdout}\n${cli.stderr}`, Object.values(SCRUB))).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe(text);
  }, 30_000); // a spawned CLI

  it("configuration that is not secret-like is not a secret", async () => {
    const t = scrubRun();
    const kept = `port 3000, home ${PLAIN_HOME}, theme dark-mode-on\n`;
    const file = t.body(kept);
    expect(await t.run("Settings", file)).toEqual({ code: 0, out: ["scrub: ok; redacted 0, defanged 0, cut 0 line(s)", "title: Settings"] });
    expect(readFileSync(file, "utf8")).toBe(kept);
    expect(await t.run("Settings", t.body(`db ${SCRUB.repoEnv}\n`))).toEqual({ code: 1, out: ["body 1:4 repo env file", REFUSED(1)] });
    expect(await t.run("Settings", t.body(`build ${SCRUB.build}\n`))).toEqual({ code: 1, out: ["body 1:7 environment variable BUILD_ID", REFUSED(1)] });
    // A short value under a secret-like name is a flag, not a secret: those sources take the ledger's floor.
    writeFileSync(join(t.main, ".env"), `DB_PASSWORD=${SCRUB.repoEnv}\nPORT=3000\nAUTH_MODE=on\n`);
    expect(await t.run("Step 1", t.body("Quantity 1, auth on\n"), {}, { ...SCRUB_ENV, CHILD_SESSION: "1", HAS_AUTH_REFRESH: "1" })).toMatchObject({ code: 0 });
    const labels = scrubSecrets(t.main, { runId: t.runId, env: SCRUB_ENV }).secrets.map((s: Obj) => s.cls);
    expect(labels).not.toContain("environment variable HOME");
    expect(scrubSecrets(t.main, { runId: t.runId, env: SCRUB_ENV }).secrets.some((s: Obj) => s.v === "3000")).toBe(false);
  }, 30_000);

  it("a short configuration secret is refused as a whole token, never inside a word", async () => {
    const t = scrubRun();
    expect(await t.run("x", t.body("use pw1 here\n"))).toEqual({ code: 1, out: ["body 1:5 role password", REFUSED(1)] });
    expect((await t.run("x", t.body("pw123 and xpw1\n"))).code).toBe(0);
    // A ledger value under the floor is never matched: the floor is the ledger classes' own.
    appendLedger(t.main, t.runId, [{ c: "cookie", v: "abc12" }]);
    expect((await t.run("x", t.body("token abc12 here\n"))).code).toBe(0);
  });

  it("a cuid or ULID the run saw stays; an unknown long token is redacted", async () => {
    const t = scrubRun();
    appendSeen(t.main, t.runId, ["ck9a8b7c6d5e4f3g2h1i0j9k8", "01HZX3J4K5M6N7P8Q9R0S1T2V3"]);
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const text = `ids ck9a8b7c6d5e4f3g2h1i0j9k8 01HZX3J4K5M6N7P8Q9R0S1T2V3\nkey sk_li\u0076e_51HxYzAbCdEfGh1234567890\nsha ${sha}\nword abcdefghijklmnopqrstuvwxyzabcd\n`;
    expect(redactIds(text, readSeen(t.main, t.runId))).toEqual({ text: text.replace("sk_li\u0076e_51HxYzAbCdEfGh1234567890", "<redacted>"), count: 1 });
    const file = t.body(text);
    expect(await t.run("Order sk_li\u0076e_51HxYzAbCdEfGh0987654321 failed", file)).toEqual({ code: 0, out: ["scrub: ok; redacted 2, defanged 0, cut 0 line(s)", "title: Order <redacted> failed"] });
    expect(readFileSync(file, "utf8")).toBe(text.replace("sk_li\u0076e_51HxYzAbCdEfGh1234567890", "<redacted>"));
  });

  it("mentions, references and outside links are defanged outside code", async () => {
    const ts = Array.from({ length: 40 }, (_, i) => `const a${i} = "@octocat #${i}";`);
    const long = Array.from({ length: 25 }, (_, i) => `page line ${i + 1}`);
    const md = [
      "Seen by @octocat on #12 and owner/repo#3, see https://evil.example/x.",
      "Local http://localhost:3000/x and http://127.0.0.1:9/x stay; `@x` stays.",
      "```ts",
      ...ts,
      "```",
      "```text",
      ...long,
      "```",
      "~~~text",
      "```",
      "@inside",
      "~~~",
      "after @late",
    ].join("\n");
    const d = defang(md);
    const lines = d.text.split("\n");
    expect(lines[0]).toBe("Seen by `@octocat` on `#12` and `owner/repo#3`, see `https://evil.example/x`.");
    expect(lines[1]).toBe("Local http://localhost:3000/x and http://127.0.0.1:9/x stay; `@x` stays.");
    expect(lines.slice(2, 44)).toEqual(["```ts", ...ts, "```"]);
    expect(lines.slice(44, 67)).toEqual(["```text", ...long.slice(0, 20), "… 5 lines cut", "```"]);
    // A backtick fence inside a tilde fence does not close it: the mention in it is code.
    expect(lines.slice(67, 71)).toEqual(["~~~text", "```", "@inside", "~~~"]);
    expect(lines[71]).toBe("after `@late`");
    expect(d).toMatchObject({ defanged: 5, cut: 5 });
    // A backtick with no closer on its line opens no span across lines; an escaped one none at all.
    expect(defang("a `b\n@c d`").text).toBe("a \\`b\n`@c` d\\`");
    expect(defang("x \\`@y`").text).toBe("x \\``@y`\\`");
    expect(defang("cell `a | @b` end").text).toBe("cell \\`a | `@b`\\` end");
    // Through scrub: the title gets the same treatment, the body file is rewritten in place.
    const t = scrubRun();
    const file = t.body(md);
    expect(await t.run("Ping @octocat on #12", file)).toEqual({ code: 0, out: ["scrub: ok; redacted 0, defanged 7, cut 5 line(s)", "title: Ping `@octocat` on `#12`"] });
    expect(readFileSync(file, "utf8")).toBe(d.text);
  });

  it("scrub needs the run's whole ledger", async () => {
    const t = scrubRun();
    const file = t.body("clean\n");
    rmSync(ledgerFile(t.main, t.runId));
    expect(await t.run("x", file)).toEqual({ code: 1, out: ["refused: scrub: the run's secret ledger is gone (a later up removed it); nothing from this run is filed"] });
    appendLedger(t.main, t.runId, [{ c: "incomplete", v: "s-1 lost before its drain" }]);
    expect(await t.run("x", file)).toEqual({ code: 1, out: ["refused: scrub: the run's secret ledger is incomplete (s-1 lost before its drain); nothing from this run is filed"] });
    writeFileSync(ledgerFile(t.main, t.runId), "not json\n");
    expect(await t.run("x", file)).toEqual({ code: 1, out: ["refused: scrub: the run's secret ledger is damaged"] });
    expect(readFileSync(file, "utf8")).toBe("clean\n");
  });

  it("scrub works on a run that is down", async () => {
    const t = scrubRun();
    rmSync(join(t.main, ".argus/live/lock.json"));
    expect(existsSync(logsDir(t.main, t.runId))).toBe(true);
    expect((await t.run("x", t.body("a clean body\n"))).code).toBe(0);
    expect(await t.run("x", t.body(`the cookie ${SCRUB.cookie}\n`))).toEqual({ code: 1, out: ["body 1:12 cookie", REFUSED(1)] });
  });

  it("scrub checks the run it is told, never the newest: a later up's run leaves the earlier one unfileable", async () => {
    const t = scrubRun();
    const file = t.body(`the cookie ${SCRUB.cookie}\n`);
    // No run named: refused before anything is read.
    expect(await scrub(t.main, { title: "x", bodyFile: file }, { env: SCRUB_ENV })).toEqual({ code: 1, out: ["refused: scrub: name the run (--run <runId>) or the candidate (--ref <slot>.<generation>.<k>); nothing is filed"] });
    expect(await scrub(t.main, { run: "x", title: "x", bodyFile: file }, { env: SCRUB_ENV })).toEqual({ code: 1, out: ["refused: scrub: --run takes a run id; nothing is filed"] });
    expect(await scrub(t.main, { run: `${"1".repeat(14)}-0123abcd`, title: "x", bodyFile: file }, { env: SCRUB_ENV })).toEqual({ code: 1, out: [`refused: scrub: no run ${"1".repeat(14)}-0123abcd here; nothing is filed`] });
    // The next up: a newer run with a ledger of its own, this run's dropped.
    rmSync(join(t.main, ".argus/live/lock.json"));
    const later = `${"9".repeat(14)}-0123abcd`;
    appendLedger(t.main, later, [{ c: "cookie", v: "LaterCookie_4471" }]);
    dropLedgers(t.main, { keep: later });
    expect(await t.run("x", file)).toEqual({ code: 1, out: ["refused: scrub: the run's secret ledger is gone (a later up removed it); nothing from this run is filed"] });
    expect(readFileSync(file, "utf8")).toBe(`the cookie ${SCRUB.cookie}\n`);
    // The later run is checked against its own ledger only when it is named.
    expect(await t.run("x", t.body("LaterCookie_4471\n"), { run: later })).toEqual({ code: 1, out: ["body 1:1 cookie", REFUSED(1)] });
  });

  it("with --ref, scrub files only a candidate that reproduced two of two, in the run that reproduced it", async () => {
    const t = scrubRun();
    const file = t.body("clean\n");
    const verdict = (runId: string, ref: string, v: Obj | null) => {
      const dir = join(t.main, ".argus/live", runId, "repro", ref);
      mkdirSync(dir, { recursive: true });
      if (v) writeFileSync(join(dir, "verdict.json"), JSON.stringify(v));
    };
    const byRef = (ref: string, extra: Obj = {}) => scrub(t.main, { ref, title: "x", bodyFile: file, ...extra }, { env: SCRUB_ENV });
    expect(await byRef("1.1")).toEqual({ code: 1, out: ["refused: scrub: --ref takes <slot>.<generation>.<k>; nothing is filed"] });
    expect(await byRef("1.1.1")).toEqual({ code: 1, out: ["refused: scrub: no run here reproduced candidate 1.1.1; nothing is filed"] });
    verdict(t.runId, "1.1.1", null);
    expect(await byRef("1.1.1")).toEqual({ code: 1, out: [`refused: scrub: candidate 1.1.1 of run ${t.runId} did not reproduce two of two (never run); nothing is filed`] });
    for (const word of ["intermittent", "not-reproduced", "harness"]) {
      verdict(t.runId, "1.1.1", { runs: [3, 0], verdict: word });
      expect(await byRef("1.1.1"), word).toEqual({ code: 1, out: [`refused: scrub: candidate 1.1.1 of run ${t.runId} did not reproduce two of two (${word}); nothing is filed`] });
    }
    verdict(t.runId, "1.1.1", { runs: [3, 3], verdict: "reproduced" });
    expect(await byRef("1.1.1")).toMatchObject({ code: 0 });
    expect((await byRef("1.1.1", { bodyFile: t.body(`the cookie ${SCRUB.cookie}\n`) })).out).toEqual(["body 1:12 cookie", REFUSED(1)]);
    // Another run holding the same ref: the ref no longer names one run, unless --run says which.
    const other = `${"1".repeat(14)}-0123abcd`;
    verdict(other, "1.1.1", { runs: [3, 3], verdict: "reproduced" });
    expect(await byRef("1.1.1")).toEqual({ code: 1, out: ["refused: scrub: candidate 1.1.1 was reproduced in more than one run; name it with --run <runId> too; nothing is filed"] });
    expect(await byRef("1.1.1", { run: t.runId })).toMatchObject({ code: 0 });
    expect(await byRef("1.1.1", { run: other })).toEqual({ code: 1, out: ["refused: scrub: the run's secret ledger is gone (a later up removed it); nothing from this run is filed"] });
  });

  it("a ledger or env_file value thousands of characters long is refused by its class, and no output holds any part of it", async () => {
    for (const n of [3000, 4096]) {
      const t = scrubRun();
      const v = { storage: longSecret(n, "storage"), cookie: longSecret(n, "cookie"), env: longSecret(n, "env") };
      appendLedger(t.main, t.runId, [{ c: "storage", v: v.storage }, { c: "cookie", v: v.cookie }]);
      writeFileSync(join(t.main, ".argus/live.env"), `APP_SECRET=${SCRUB.envFile}\nAPP_KEY=${v.env}\n`);
      for (const [cls, value] of [["storage", v.storage], ["cookie", v.cookie], ["env file", v.env]]) {
        const file = t.body(`blob ${value} end\n`);
        const r = await t.run("A title", file);
        expect(r, `${n} ${cls}`).toEqual({ code: 1, out: [`body 1:6 ${cls}`, REFUSED(1)] });
        const cli = spawnSync(process.execPath, [ARGUS_LIVE, "scrub", "--run", t.runId, "--title", "A title", "--body", file], { cwd: t.main, encoding: "utf8", env: { ...SCRUB_ENV, PATH: process.env.PATH! } });
        expect([cli.status, cli.stdout], `${n} ${cls}`).toEqual([1, `body 1:6 ${cls}\n${REFUSED(1)}\n`]);
        for (const x of Object.values(v)) expect(partsIn(`${cli.stdout}\n${cli.stderr}\n${r.out.join("\n")}`, x)).toEqual([]);
      }
      // pw's screenshot verdict reads the same ledger: a long value fails nothing, and the verdict says secret.
      const png = join(t.main, ".argus/live", t.runId, "1/out/page-1.png");
      mkdirSync(dirname(png), { recursive: true });
      writeFileSync(png, "png");
      expect(writeVerdict(t.main, t.runId, png, { text: `page ${v.storage}` }, { env: SCRUB_ENV })).toMatchObject({ passed: false, reasons: ["secret"] });
      expect(writeVerdict(t.main, t.runId, png, { text: "a clean page" }, { env: SCRUB_ENV })).toMatchObject({ passed: true, reasons: [] });
    }
  }, 120_000); // spawned CLIs over long values

  it("a secret is refused case-folded, in hex, inside base64 at any offset, URL-decoded and split by invisible format characters", async () => {
    const t = scrubRun();
    appendLedger(t.main, t.runId, [{ c: "cookie", v: "s%3AAbc123.sig456XYZ" }]);
    const one = async (text: string, cls: string) => expect(await t.run("x", t.body(`${text}\n`)), text).toEqual({ code: 1, out: [`body 1:1 ${cls}`, REFUSED(1)] });
    await one(SCRUB.header.toUpperCase(), "header");
    await one(SCRUB.storage.toLowerCase(), "storage");
    await one(Buffer.from(SCRUB.cookie).toString("hex"), "cookie");
    await one(Buffer.from(SCRUB.made).toString("hex").toUpperCase(), "created password");
    for (const prefix of ["u", "us", "user:"]) {
      const r = await t.run("x", t.body(`Basic ${Buffer.from(`${prefix}${SCRUB.role}`).toString("base64")}\n`));
      expect(r.code, prefix).toBe(1);
      expect(r.out.at(-2), prefix).toMatch(/^body 1:\d+ role password$/);
    }
    await one("s:Abc123.sig456XYZ", "cookie");
    for (const mark of ["­", "​", "⁠"]) {
      await one(`${SCRUB.cookie.slice(0, 5)}${mark}${SCRUB.cookie.slice(5)}`, "cookie");
      // A short configuration secret split the same way, as a whole token.
      expect(await t.run("x", t.body(`use p${mark}w${mark}1 here\n`)), JSON.stringify(mark)).toEqual({ code: 1, out: ["body 1:5 role password", REFUSED(1)] });
    }
  });

  it("a long secret's middle or tail alone is refused: every part of it is looked for, not only the first", async () => {
    const t = scrubRun();
    const v = { cookie: longSecret(3000, "tail-cookie"), env: longSecret(3000, "tail-env") };
    appendLedger(t.main, t.runId, [{ c: "cookie", v: v.cookie }]);
    writeFileSync(join(t.main, ".argus/live.env"), `APP_SECRET=${SCRUB.envFile}\nAPP_KEY=${v.env}\n`);
    const url = (s: string) => [...Buffer.from(s)].map((b) => `%${b.toString(16).padStart(2, "0")}`).join("");
    for (const [cls, value] of [["cookie", v.cookie], ["env file", v.env]]) {
      for (const [where, piece] of [["middle", value.slice(1000, 1700)], ["tail", value.slice(-600)], ["middle URL-encoded", url(value.slice(1300, 1900))], ["tail upper-cased", value.slice(-600).toUpperCase()]]) {
        const r = await t.run("x", t.body(`blob ${piece} end\n`));
        expect(r.code, `${cls} ${where}`).toBe(1);
        // One hit per part the piece holds whole, each naming the class.
        expect(r.out.slice(0, -1).length, `${cls} ${where}`).toBeGreaterThan(0);
        for (const line of r.out.slice(0, -1)) expect(line, `${cls} ${where}`).toMatch(new RegExp(`^body 1:\\d+ ${cls}$`));
        expect(r.out.at(-1), `${cls} ${where}`).toBe(REFUSED(r.out.length - 1));
      }
    }
    // pw's screenshot verdict reads the same matcher.
    const png = join(t.main, ".argus/live", t.runId, "1/out/page-1.png");
    mkdirSync(dirname(png), { recursive: true });
    writeFileSync(png, "png");
    expect(writeVerdict(t.main, t.runId, png, { text: `page ${v.cookie.slice(-500)}` }, { env: SCRUB_ENV })).toMatchObject({ passed: false, reasons: ["secret"] });
  });

  it("every part of 200 ledger values of 4096 characters is checked against a 64 KB body in under 3 seconds", () => {
    const secrets = Array.from({ length: 200 }, (_, i) => ({ cls: "cookie", v: longSecret(MAX_SECRET, `bulk-${i}`) }));
    const prose = "Order 1234 failed at step 7 & retried at 50% load; see the log \\n for more.\n";
    const body = `${prose.repeat(Math.ceil(65_536 / prose.length)).slice(0, 65_536 - 700)}${secrets[137].v.slice(2000, 2700)}`;
    const start = performance.now();
    const hits = secretHits(body, secrets);
    const ms = performance.now() - start;
    expect(hits.length).toBeGreaterThan(0);
    expect(new Set(hits.map((h: Obj) => h.cls))).toEqual(new Set(["cookie"]));
    expect(ms).toBeLessThan(3000);
  }, 30_000);

  it("any run of 95 or more characters of a 4096-character secret is found wherever it starts (windows of 64 every 32)", () => {
    const v = longSecret(MAX_SECRET, "window");
    const secrets = [{ cls: "cookie", v }];
    for (const n of [95, 96, 128, 300, 494]) {
      // The head, the tail, and every alignment to the windows (32 offsets in a row) at two places in the middle.
      const offsets = [0, v.length - n, ...Array.from({ length: 32 }, (_, k) => [1000 + k, v.length - n - 600 - k]).flat()];
      const missed = offsets.filter((o) => {
        const hits = secretHits(`blob ${v.slice(o, o + n)} end`, secrets);
        return !hits.length || hits.some((h: Obj) => h.cls !== "cookie");
      });
      expect(missed, `${n} characters`).toEqual([]);
    }
  }, 30_000);

  it("a secret split by astral format characters, or URL- or entity-encoded twice, is refused", () => {
    const secrets = [{ cls: "cookie", v: SCRUB.cookie }];
    const tag = String.fromCodePoint(0xe0020);
    const pct = (s: string) => [...Buffer.from(s)].map((b) => `%${b.toString(16).padStart(2, "0")}`).join("");
    const forms: [string, string][] = [
      ["tag characters", [...SCRUB.cookie].join(tag)],
      ["one tag character", `${SCRUB.cookie.slice(0, 7)}${String.fromCodePoint(0xe0001)}${SCRUB.cookie.slice(7)}`],
      ["URL-encoded twice", pct(SCRUB.cookie).replace(/%/g, "%25")],
      ["entities twice", [...SCRUB.cookie].map((c) => `&amp;#${c.codePointAt(0)};`).join("")],
      ["URL- then entity-encoded", pct(SCRUB.cookie).replace(/%/g, "&#37;")],
    ];
    for (const [what, text] of forms) expect(secretHits(`see ${text} here`, secrets), what).toEqual([{ line: 1, col: 5, cls: "cookie" }]);
    // Decoding twice finds nothing new in a clean text.
    expect(secretHits("100%2525 &amp;amp; %41 &#65;", secrets)).toEqual([]);
  });

  it("a 6-character secret inside base64 after 4 or 5 other bytes is refused, and a near miss is not", async () => {
    const t = scrubRun();
    const short = "Qz7k2W";
    appendLedger(t.main, t.runId, [{ c: "cookie", v: short }]);
    for (const prefix of ["abc:", "abcd:", "ab:", "u:"]) {
      const r = await t.run("x", t.body(`Basic ${Buffer.from(`${prefix}${short}`).toString("base64")}\n`));
      expect(r.code, prefix).toBe(1);
      expect(r.out.at(-2), prefix).toMatch(/^body 1:\d+ cookie$/);
    }
    // Its first character off (the core holds every bit of it), or only part of the encoded core: not the secret.
    for (const prefix of ["abc:", "abcd:"]) {
      expect(await t.run("x", t.body(`Basic ${Buffer.from(`${prefix}Pz7k2W`).toString("base64")}\n`)), prefix).toMatchObject({ code: 0 });
      const core = Buffer.from(`${prefix}${short}`).toString("base64").slice(Math.ceil((8 * prefix.length) / 6), Math.ceil((8 * prefix.length) / 6) + 6);
      expect(await t.run("x", t.body(`part ${core} only\n`)), `${prefix} ${core}`).toMatchObject({ code: 0 });
    }
  });

  it("environment and repo env values: a short secret from 4 characters is refused, a switch, a short plain number and a path never", async () => {
    const t = scrubRun();
    writeFileSync(join(t.main, ".env"), `DB_PASSWORD=ab1cd\nPORT=3000\nDEBUG=true\nFEATURE=on\nAPI_TOKEN=4815162342108\n`);
    writeFileSync(join(t.main, ".argus/live.env"), `APP_SECRET=${SCRUB.envFile}\nADMIN_PIN=73914826\nAPP_PORT=4000\nVERBOSE=yes\n`);
    const place = join(t.main, "Cfg-Dir_2");
    const env = {
      ...SCRUB_ENV,
      API_TOKEN: "x9k2m",
      SESSION_COUNT: "1",
      AUTH_ENABLED: "true",
      PWD: t.main,
      OLDPWD: t.main,
      INIT_CWD: t.main,
      TMPDIR: tmpdir(),
      XDG_CONFIG_HOME: place,
      WORKSPACE_LOCATION: place,
      // Claude Code's own variables: exempt unless the name says secret.
      CLAUDE_CODE_CHILD_SESSION: "1",
      CLAUDE_CODE_ENTRYPOINT: "Xy7_kq9Lm2Pz8Wv4",
      CLAUDE_CODE_SESSION_TOKEN_HINT: "q7w8e9r0",
      CLAUDE_CODE_OAUTH_TOKEN: "oat01-Qw3rTy9Uiop2Asdf",
      CLAUDE_CODE_MESSAGING_TOKEN: "Mx81kQ0wZp4Lr7Vt",
      // A number under a secret's name, long or from 4 characters.
      SERVICE_TOKEN: "99887766554433",
      AUTH_PIN: "4815",
      // A base64 value starting with `/` is judged by entropy, not taken for a path.
      ASSET_BLOB: "/xK9mQ2vL7+pR4tW8zB1c==",
      ASSET_SEAL: "/Xk9mQ2vL7pR4tW8zB1cYd",
    };
    // Refused at the value's first character (a hit in its separator-stripped form may follow), naming only its class.
    const refused = async (value: string, cls: string) => {
      const r = await t.run("x", t.body(`v ${value} end\n`), {}, env);
      expect(r.code, value).toBe(1);
      expect(r.out[0], value).toBe(`body 1:3 ${cls}`);
      for (const line of r.out.slice(0, -1)) expect(line, value).toMatch(new RegExp(`^body 1:\\d+ ${cls}$`));
      expect(r.out.at(-1), value).toBe(REFUSED(r.out.length - 1));
    };
    await refused("ab1cd", "repo env file");
    await refused("x9k2m", "environment variable API_TOKEN");
    await refused("q7w8e9r0", "environment variable CLAUDE_CODE_SESSION_TOKEN_HINT");
    await refused(env.CLAUDE_CODE_OAUTH_TOKEN, "environment variable CLAUDE_CODE_OAUTH_TOKEN");
    await refused(env.CLAUDE_CODE_MESSAGING_TOKEN, "environment variable CLAUDE_CODE_MESSAGING_TOKEN");
    await refused("99887766554433", "environment variable SERVICE_TOKEN");
    await refused("4815", "environment variable AUTH_PIN");
    await refused("4815162342108", "repo env file");
    await refused("73914826", "env file");
    await refused(env.ASSET_BLOB, "environment variable ASSET_BLOB");
    await refused(env.ASSET_SEAL, "environment variable ASSET_SEAL");
    const kept = `Quantity 1, true, on, yes, 3000, 4000; built in ${t.main} under ${tmpdir()} by Xy7_kq9Lm2Pz8Wv4 into ${place}\n`;
    expect(await t.run("x", t.body(kept), {}, env)).toMatchObject({ code: 0 });
    const classes = scrubSecrets(t.main, { runId: t.runId, env }).secrets.map((s: Obj) => s.cls);
    for (const k of ["PWD", "OLDPWD", "INIT_CWD", "TMPDIR", "SESSION_COUNT", "AUTH_ENABLED", "XDG_CONFIG_HOME", "WORKSPACE_LOCATION", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_ENTRYPOINT"]) expect(classes, k).not.toContain(`environment variable ${k}`);
  });

  it("a number under a unit or limit name, a 0 or 1, and a name that only holds a secret word's letters are configuration; a secret stays one, in every source", async () => {
    const t = scrubRun();
    const sources: [string, (k: string, v: string) => Obj][] = [
      ["env file", (k, v) => (writeFileSync(join(t.main, ".argus/live.env"), `APP_SECRET=${SCRUB.envFile}\n${k}=${v}\n`), SCRUB_ENV)],
      ["repo env file", (k, v) => (writeFileSync(join(t.main, ".env"), `${k}=${v}\n`), SCRUB_ENV)],
      ["environment variable", (k, v) => ({ ...SCRUB_ENV, [k]: v })],
    ];
    const kept: [string, string, string?][] = [
      ["SESSION_TIMEOUT", "3600"],
      ["TOKEN_TTL", "900"],
      ["AUTH_MAX_AGE", "86400"],
      ["PASSWORD_MIN_LENGTH", "12"],
      ["SECRET_ROTATION_DAYS", "30"],
      ["JWT_EXPIRES_IN", "604800"],
      ["KEY_SIZE", "2048"],
      ["AUTH_PORT", "8080"],
      ["SESSION_COOKIE_SECURE", "1", "Step 1"],
      ["SIGNAL_TIMEOUT", "30"],
      ["AUTHOR", "jane"],
    ];
    const refused: [string, string][] = [
      ["ADMIN_PIN", "73914826"],
      ["API_TOKEN", "4815162342108"],
      ["SERVICE_TOKEN", "99887766554433"],
      ["AUTH_PIN", "4815"],
      ["CLAUDE_CODE_OAUTH_TOKEN", "oat01-Qw3rTy9Uiop2Asdf"],
      ["DB_PASSWORD", "ab1cd"],
      ["API_TOKEN", "x9k2m"],
    ];
    for (const [source, put] of sources) {
      for (const [k, v, body] of kept) {
        // The env file holds the run's own secrets: every value but a switch word or a number it reads as configuration.
        if (source === "env file" && !/^[0-9]+$/.test(v)) continue;
        const env = put(k, v);
        expect(await t.run("x", t.body(`${body ?? `took ${v} here`}\n`), {}, env), `${source} ${k}=${v}`).toMatchObject({ code: 0 });
      }
      for (const [k, v] of refused) {
        const env = put(k, v);
        const cls = source === "environment variable" ? `environment variable ${k}` : source;
        expect(await t.run("x", t.body(`v ${v} end\n`), {}, env), `${source} ${k}=${v}`).toEqual({ code: 1, out: [`body 1:3 ${cls}`, REFUSED(1)] });
      }
      writeFileSync(join(t.main, ".argus/live.env"), `APP_SECRET=${SCRUB.envFile}\n`);
      writeFileSync(join(t.main, ".env"), `DB_PASSWORD=${SCRUB.repoEnv}\n`);
    }
    // In the env file a word is a secret under any name.
    writeFileSync(join(t.main, ".argus/live.env"), `APP_SECRET=${SCRUB.envFile}\nAUTHOR=jane\n`);
    expect(await t.run("x", t.body("by jane\n"))).toEqual({ code: 1, out: ["body 1:4 env file", REFUSED(1)] });
  }, 60_000);

  it("a secret name holds a long secret word anywhere, or a short one as a whole word", () => {
    for (const n of ["DB_PASSWORD", "DBPASSWORD", "JSESSIONID", "PHPSESSID", "csrftoken", "connect.sid", "express:sess.sig", "authToken", "X-Auth", "AUTH_PIN", "ADMIN_PIN", "MYSQL_PWD", "API_KEY", "apiKey", "PRIVATE_KEY", "CLIENT_SECRET", "ACCESS_TOKEN", "SessionId", "Authorization", "OAUTH_STATE"]) expect(secretName(n), n).toBe(true);
    for (const n of ["SIGNAL_TIMEOUT", "CONSIDER_RETRIES", "AUTHOR", "SIDEBAR", "SPINNER", "KEY_SIZE", "PORT", "CLAUDE_CODE_ENTRYPOINT"]) expect(secretName(n), n).toBe(false);
  });

  it("a value under a name ending in PWD is a secret (MYSQL_PWD, DB_PWD), while the shell's PWD stays exempt", async () => {
    const t = scrubRun();
    writeFileSync(join(t.main, ".env"), "DB_PWD=hunter22\n");
    const env = { ...SCRUB_ENV, MYSQL_PWD: "Xk9_mQ2vL7pR4tW8", PWD: t.main };
    expect(await t.run("x", t.body("v Xk9_mQ2vL7pR4tW8 end\n"), {}, env)).toEqual({ code: 1, out: ["body 1:3 environment variable MYSQL_PWD", REFUSED(1)] });
    expect(await t.run("x", t.body("v hunter22 end\n"), {}, env)).toEqual({ code: 1, out: ["body 1:3 repo env file", REFUSED(1)] });
    expect(await t.run("x", t.body(`built in ${t.main}\n`), {}, env)).toMatchObject({ code: 0 });
  });

  it("protocol-relative links and images are defanged too", () => {
    const md = "a [x](//evil.test/a) b ![](//evil.test/p.png) <img src=//evil.test/i.png> <img src=\"//evil.test/q\"> <a href='//evil.test/r'>r</a>";
    const d = defang(md);
    expect(d.text).toBe("a [x](`//evil.test/a`) b ![](`//evil.test/p.png`) <img src=`//evil.test/i.png`> <img src=\"`//evil.test/q`\"> <a href='`//evil.test/r`'>r</a>");
    expect(d.defanged).toBe(5);
    // A path that is not a link stays: `a // comment`, `x//y`.
    expect(defang("a // comment and x//y").text).toBe("a // comment and x//y");
  });

  it("an angle-bracketed target, a reference definition, srcset, poster, escaped slashes and an upper-case scheme are defanged too", () => {
    const cases: [string, string][] = [
      ["a [x](<//evil.test/a>) b", "a [x](<`//evil.test/a`>) b"],
      ["[1]: //evil.test/r", "[1]: `//evil.test/r`"],
      ["[p]: //evil.test/p.png", "[p]: `//evil.test/p.png`"],
      ["  [p]: <//evil.test/p.png>", "  [p]: <`//evil.test/p.png`>"],
      ['<img srcset="//evil.test/a.png 1x, //evil.test/b.png 2x">', '<img srcset="`//evil.test/a.png` 1x, `//evil.test/b.png` 2x">'],
      ["<video poster=//evil.test/v.png>", "<video poster=`//evil.test/v.png`>"],
      ["[y](\\/\\/evil.test/y)", "[y](`\\/\\/evil.test/y`)"],
      ["<img src=\\/\\/evil.test/i.png>", "<img src=`\\/\\/evil.test/i.png`>"],
      ["see HTTPS://evil.test/z.", "see `HTTPS://evil.test/z`."],
      ["see Http://evil.test/z", "see `Http://evil.test/z`"],
      ["see https:\\/\\/evil.test/z", "see `https:\\/\\/evil.test/z`"],
      // Upper-case attribute names, entity-encoded slashes, and a target on the line after its opener.
      ["<img SRC=//evil.test/i.png>", "<img SRC=`//evil.test/i.png`>"],
      ['<a HREF="//evil.test/r">r</a>', '<a HREF="`//evil.test/r`">r</a>'],
      ['<img SrcSet="//evil.test/a.png 1x">', '<img SrcSet="`//evil.test/a.png` 1x">'],
      ["<video POSTER=//evil.test/v.png>", "<video POSTER=`//evil.test/v.png`>"],
      ["[x](&#47;&#47;evil.test/a)", "[x](`&#47;&#47;evil.test/a`)"],
      ["[x](&#x2F;&#x2f;evil.test/a)", "[x](`&#x2F;&#x2f;evil.test/a`)"],
      ["[x](&sol;&sol;evil.test/a)", "[x](`&sol;&sol;evil.test/a`)"],
      ["<img src=&#47;&#47;evil.test/i.png>", "<img src=`&#47;&#47;evil.test/i.png`>"],
      ["see https:&#47;&#47;evil.test/z", "see `https:&#47;&#47;evil.test/z`"],
      ["[x](\n//evil.test/a)", "[x](\n`//evil.test/a`)"],
      ["[x](  \n  <//evil.test/a>)", "[x](  \n  <`//evil.test/a`>)"],
      ["[1]:\n//evil.test/r", "[1]:\n`//evil.test/r`"],
      ["  [p]: \n &#47;&#47;evil.test/p.png", "  [p]: \n `&#47;&#47;evil.test/p.png`"],
    ];
    for (const [md, want] of cases) expect(defang(md), md).toEqual({ text: want, defanged: (want.match(/`/g) ?? []).length / 2, cut: 0 });
    // The run's own app stays linked, whatever the scheme's case; prose with slashes stays.
    expect(defang("open HTTP://localhost:3000/x and a [1] note: // not a link").text).toBe("open HTTP://localhost:3000/x and a [1] note: // not a link");
    // A line after one that opens no target, a slash entity in prose, and a target two lines down stay.
    expect(defang("a note\n//not-a-link\nx &#47;&#47; y\n[x](\n\n//evil.test/a)").text).toBe("a note\n//not-a-link\nx &#47;&#47; y\n[x](\n\n//evil.test/a)");
  });
});

describe("argus-live scrub — attachments and filing", () => {
  const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001", "hex");
  const URL9 = "https://github.com/o/r/issues/9";
  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  /** A run as scrub reads it, a fake gh, and `shot(rel)`: a screenshot at `rel` under the run's directory (or `abs`) with the verdict pw writes beside it. */
  const filing = () => {
    const t = scrubRun();
    const g = fakeGh();
    const shot = (rel: string, verdict: Obj | null = { passed: true, reasons: [] }, at = join(t.main, ".argus/live", t.runId, rel)) => {
      mkdirSync(dirname(at), { recursive: true });
      writeFileSync(at, PNG);
      if (verdict) writeFileSync(at.replace(/\.png$/, ".verdict.json"), JSON.stringify({ t: Date.now(), sha256: sha(PNG), ...verdict }), { mode: 0o600 });
      return at;
    };
    const file = (opts: Obj, body = "A clean body.\n") => {
      const b = t.body(body);
      return { b, done: t.run("A title", b, { create: true, gh: g.gh, ...opts }) };
    };
    return { ...t, g, shot, file, shown: (rel: string) => `.argus/live/${t.runId}/${rel}` };
  };
  const creates = (g: ReturnType<typeof fakeGh>) => g.calls().filter((c) => c.argv[0] === "issue");

  it("a screenshot whose every condition holds is attached, and gh files the rewritten body", async () => {
    const t = filing();
    const png = t.shot("1/out/page-1.png");
    const { b, done } = t.file({ attach: [png] }, "Seen by @octocat.\n");
    expect(await done).toEqual({ code: 0, out: ["scrub: ok; redacted 0, defanged 1, cut 0 line(s)", "title: A title", `attach: ${t.shown("1/out/page-1.png")}`, `filed: ${URL9}`] });
    const [c] = creates(t.g);
    expect(c.argv).toEqual(["issue", "create", "--title", "A title", "--body-file", b, "--attach", realpathSync(png)]);
    expect(c.body).toBe("Seen by `@octocat`.\n");
    expect(c.attached).toEqual([PNG.toString("latin1")]);
    expect(t.g.calls().map((x) => x.argv.slice(0, 2).join(" "))).toEqual(["--version", "repo view", "issue create"]);
  }, 30_000);

  const reasons: [string, (t: ReturnType<typeof filing>) => { file: string; shown: string }][] = [
    ["gh older than 2.99", (t) => (t.g.set({ version: "gh version 2.98.1 (stable)" }), { file: t.shot("1/out/page-1.png"), shown: t.shown("1/out/page-1.png") })],
    ["public repository", (t) => (t.g.set({ visibility: "PUBLIC" }), { file: t.shot("1/out/page-1.png"), shown: t.shown("1/out/page-1.png") })],
    [
      "traces none",
      (t) => {
        const c = JSON.parse(readFileSync(join(__dirname, "../.claude/sapu.json"), "utf8"));
        mkdirSync(join(t.main, ".claude"), { recursive: true });
        writeFileSync(join(t.main, ".claude/sapu.json"), JSON.stringify({ ...c, policy: { traces: "none" } }));
        spawnSync("git", ["-C", t.main, "add", ".claude/sapu.json"]);
        spawnSync("git", ["-C", t.main, "-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", "commit", "-qm", "contract"]);
        return { file: t.shot("1/out/page-1.png"), shown: t.shown("1/out/page-1.png") };
      },
    ],
    ["a trace, never attached", (t) => ({ file: t.shot("r/out/traces/page-1.png"), shown: t.shown("r/out/traces/page-1.png") })],
    ["not a screenshot of this run", (t) => ({ file: t.shot("", undefined, join(tempDir(), "page-1.png")), shown: "page-1.png" })],
    ["no verdict recorded", (t) => ({ file: t.shot("1/out/page-1.png", null), shown: t.shown("1/out/page-1.png") })],
    [
      "the screenshot changed after its verdict",
      (t) => {
        const file = t.shot("1/out/page-1.png");
        writeFileSync(file, Buffer.concat([PNG, Buffer.from([0])]));
        return { file, shown: t.shown("1/out/page-1.png") };
      },
    ],
    ["a secret on the page", (t) => ({ file: t.shot("1/out/page-1.png", { passed: false, reasons: ["secret"] }), shown: t.shown("1/out/page-1.png") })],
    ["a password field", (t) => ({ file: t.shot("1/out/page-1.png", { passed: false, reasons: ["password-field"] }), shown: t.shown("1/out/page-1.png") })],
    ["a one-time-code field", (t) => ({ file: t.shot("r/out/page-2.png", { passed: false, reasons: ["one-time-code-field"] }), shown: t.shown("r/out/page-2.png") })],
    ["an error page", (t) => ({ file: t.shot("1/out/page-1.png", { passed: false, reasons: ["error-page"] }), shown: t.shown("1/out/page-1.png") })],
  ];
  for (const [reason, make] of reasons) {
    it(`a screenshot is attached only when every condition holds: ${reason}`, async () => {
      const t = filing();
      const { file, shown } = make(t);
      const { b, done } = t.file({ attach: [file] });
      const r = await done;
      expect(r).toEqual({ code: 0, out: ["scrub: ok; redacted 0, defanged 0, cut 0 line(s)", "title: A title", `local: ${shown} (${reason})`, `filed: ${URL9}`] });
      expect(readFileSync(b, "utf8")).toBe(`A clean body.\n\nLocal evidence: \`${shown}\`\n`);
      expect(creates(t.g).map((c) => c.argv)).toEqual([["issue", "create", "--title", "A title", "--body-file", b]]);
    }, 30_000);
  }

  it("a non-zero gh exit after the URL counts as filed", async () => {
    const t = filing();
    t.g.set({ create: { out: `Creating issue in o/r\n\n${URL9}\n`, code: 1 } });
    expect((await t.file({}).done).out.at(-1)).toBe(`filed: ${URL9}`);
    t.g.set({ create: { out: "", code: 1 } });
    expect(await t.file({}).done).toEqual({ code: 2, out: ["scrub: ok; redacted 0, defanged 0, cut 0 line(s)", "title: A title", "failed: gh issue create exited 1 before printing an issue URL"] });
    // A comment is filed through gh issue comment, its URL told the same way.
    const { b, done } = t.file({ create: false, comment: "9" });
    expect((await done).out.at(-1)).toBe(`commented: ${URL9}#issuecomment-77`);
    expect(creates(t.g).at(-1)!.argv).toEqual(["issue", "comment", "9", "--body-file", b]);
  }, 30_000);

  it("the needs-owner label goes through create", async () => {
    const t = filing();
    expect((await t.file({ labels: ["argus:needs-owner", "bug"] }).done).code).toBe(0);
    const argv = creates(t.g)[0].argv;
    expect(argv.slice(argv.indexOf("--label"))).toEqual(["--label", "argus:needs-owner", "--label", "bug"]);
  }, 30_000);

  it("a label is checked as the title and the body are, naming where and never what, and a refused one runs no gh", async () => {
    const t = filing();
    for (const [cls, v] of SCRUB_CLASSES) {
      for (const [form, encode] of Object.entries(SCRUB_FORMS)) {
        if (form === "spaced") continue; // a label holds no whitespace (the CLI refuses it)
        const r = await t.file({ labels: ["bug", `x-${encode(v)}`] }).done;
        expect(r, `${cls} ${form}`).toEqual({ code: 1, out: [`label 2 ${cls}`, "refused: scrub: 1 secret(s) in the issue; nothing is filed"] });
        expect(leaked(r.out.join("\n"), Object.values(SCRUB))).toEqual([]);
      }
    }
    expect(t.g.calls()).toEqual([]);
  }, 60_000); // 32 scrubs, each reading the configuration and the contract (git)

  it("a body scrubbed again names its local evidence once", async () => {
    const t = filing();
    const png = t.shot("1/out/page-1.png", null);
    const b = t.body("A clean body.\n");
    for (let i = 0; i < 2; i++) expect((await t.run("A title", b, { attach: [png], gh: t.g.gh })).code).toBe(0);
    expect(readFileSync(b, "utf8")).toBe(`A clean body.\n\nLocal evidence: \`${t.shown("1/out/page-1.png")}\`\n`);
  }, 30_000);

  it("a refused scrub runs no gh", async () => {
    const t = filing();
    const png = t.shot("1/out/page-1.png");
    const r = await t.file({ attach: [png], labels: ["bug"] }, `the cookie ${SCRUB.cookie}\n`).done;
    expect(r.code).toBe(1);
    expect(t.g.calls()).toEqual([]);
  });

  it("nothing scrub printed or gave gh holds a recorded secret, in any form, through the CLI too", async () => {
    const t = filing();
    const png = t.shot("1/out/page-1.png");
    const secret = Object.values(SCRUB);
    const b = t.body(`Seen ids ck9a8b7c6d5e4f3g2h1i0j9k8 and sk_li\u0076e_51HxYzAbCdEfGh1234567890; see https://evil.example/x\n`);
    const env = { ...SCRUB_ENV, PATH: `${t.g.dir}:${process.env.PATH}` };
    const cli = spawnSync(process.execPath, [ARGUS_LIVE, "scrub", "--run", t.runId, "--title", "Order fails for @octocat", "--body", b, "--attach", png, "--create", "--label", "bug"], { cwd: t.main, encoding: "utf8", env });
    expect(cli.status, cli.stderr).toBe(0);
    expect(cli.stdout.trimEnd().split("\n")).toEqual(["scrub: ok; redacted 2, defanged 2, cut 0 line(s)", "title: Order fails for `@octocat`", `attach: ${t.shown("1/out/page-1.png")}`, `filed: ${URL9}`]);
    expect(leaked(`${cli.stdout}\n${cli.stderr}\n${JSON.stringify(t.g.calls())}`, secret)).toEqual([]);
    // A refusal through the CLI: no gh, and none of it in the output either.
    const g0 = t.g.calls().length;
    const bad = t.body(`raw ${SCRUB.header}, url ${SCRUB_FORMS.url(SCRUB.storage)}, b64 ${SCRUB_FORMS.base64(SCRUB.made)}, spaced ${SCRUB_FORMS.spaced(SCRUB.envFile)}\n`);
    const refused = spawnSync(process.execPath, [ARGUS_LIVE, "scrub", "--run", t.runId, "--title", `t ${SCRUB.gh}`, "--body", bad, "--create"], { cwd: t.main, encoding: "utf8", env });
    expect(refused.status).toBe(1);
    expect(refused.stdout.trimEnd().split("\n")).toHaveLength(6);
    expect(leaked(`${refused.stdout}\n${refused.stderr}`, secret)).toEqual([]);
    expect(t.g.calls()).toHaveLength(g0);
    // The CLI's own refusals.
    for (const args of [["--run", t.runId, "--title", "t", "--body", bad, "--label", "bug"], ["--run", t.runId, "--title", "t", "--body", bad, "--create", "--comment", "9"], ["--run", t.runId, "--title", "t", "--body", bad, "--comment", "x"], ["--title", "t", "--body", bad], ["--run", "x", "--title", "t", "--body", bad], ["--ref", "1.1", "--title", "t", "--body", bad]]) {
      expect(spawnSync(process.execPath, [ARGUS_LIVE, "scrub", ...args], { cwd: t.main, encoding: "utf8", env }).status, args.join(" ")).toBe(1);
    }
  }, 30_000); // five spawned CLIs
});

// The journey map tests' repo and journeys (map-check, map mode, select).
const gitIn = (main: string, ...args: string[]) => spawnSync("git", ["-C", main, ...args], { encoding: "utf8" }).stdout.trim();
const commitAll = (main: string, msg: string) => {
  gitIn(main, "add", "-A");
  gitIn(main, "-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", "commit", "-qm", msg);
};
const ORDERS = [
  'const router = require("express").Router();',
  'const { requireRole } = require("../auth");',
  "// the orders routes",
  "",
  'router.post("/orders/new", requireRole("buyer"), createOrder);',
  'router.get("/orders/:id", requireRole("buyer"), showOrder);',
  'router.post("/orders/:id/approve", requireRole("clerk"), approveOrder);',
  "module.exports = router;",
];
/** A step of each kind, anchored in the map repo's code. */
const BUY = { role: "buyer", route: "/orders/new", goal: "place an order", sources: [{ file: "src/routes/orders.js", line: 5, text: 'router.post("/orders/new"' }] };
const SETTLE = { role: "system", trigger: "settle", goal: "the payment settles", sources: [{ file: "src/jobs/settle.js", line: 1, text: "export function settlePayments(queue) {" }] };
const APPROVE = { role: "clerk", route: "/orders/:id/approve", goal: "approve it", sources: [{ file: "src/routes/orders.js", line: 7, text: 'router.post("/orders/:id/approve"' }] };
const journey = (id: string, steps: Obj[], extra: Obj = {}) => ({ id, domain: "sales", title: `Journey ${id}`, money: false, global: false, goal: "a goal", steps, lastCycle: null, ...extra });
/**
 * A committed repo with src/routes/orders.js (the route on line 5), src/routes/repeat.js (one line four
 * times), src/jobs/settle.js and src/lib/helper.js, and (unless `live` is false) .argus/live.json with
 * roles buyer and clerk and trigger settle; `map(journeys)` writes .argus/journeys.json at HEAD with
 * roots src/routes and src/jobs.
 */
const mapRepo = ({ live = true } = {}) => {
  const main = committed();
  mkdirSync(join(main, "src/routes"), { recursive: true });
  mkdirSync(join(main, "src/jobs"), { recursive: true });
  mkdirSync(join(main, "src/lib"), { recursive: true });
  writeFileSync(join(main, "src/routes/orders.js"), `${ORDERS.join("\n")}\n`);
  writeFileSync(join(main, "src/routes/repeat.js"), 'audit.log("an order event here");\n'.repeat(4));
  writeFileSync(join(main, "src/jobs/settle.js"), "export function settlePayments(queue) {\n  return queue.drain();\n}\n");
  writeFileSync(join(main, "src/lib/helper.js"), "export function settleHelperFunction() {}\n");
  mkdirSync(join(main, ".argus"), { recursive: true });
  if (live) writeFileSync(join(main, ".argus/live.json"), JSON.stringify({ roles: { buyer: {}, clerk: {} }, triggers: { settle: { argv: ["true"] } }, limits: { max_cycle_minutes: 30 } }));
  commitAll(main, "app");
  const file = join(main, ".argus/journeys.json");
  const map = (journeys: Obj[], extra: Obj = {}) => writeFileSync(file, `${JSON.stringify({ head: gitIn(main, "rev-parse", "HEAD"), roots: ["src/routes", "src/jobs"], dropped: [], journeys, ...extra }, null, 2)}\n`);
  const read = () => JSON.parse(readFileSync(file, "utf8"));
  const cli = (...args: string[]) => {
    const r = spawnSync(process.execPath, [ARGUS_LIVE, "map-check", ...args], { cwd: main, encoding: "utf8" });
    return { code: r.status, out: r.stdout.trimEnd().split("\n"), err: r.stderr };
  };
  return { main, file, map, read, cli };
};

describe("argus-live map-check", () => {
  const DROPS: [string, Obj, string][] = [
    ["a short anchor", { ...BUY, sources: [{ file: "src/routes/orders.js", line: 5, text: "router.post(  x" }] }, "step 1: anchor 1 has fewer than 16 non-space characters"],
    ["a missing anchor", { ...BUY, sources: [{ file: "src/routes/orders.js", line: 5, text: 'router.delete("/orders/new"' }] }, "step 1: anchor 1 is not in src/routes/orders.js at HEAD"],
    ["an anchor in a file HEAD lacks", { ...BUY, sources: [{ file: "src/routes/gone.js", line: 1, text: 'router.post("/orders/new"' }] }, "step 1: anchor 1 is not in src/routes/gone.js at HEAD"],
    ["an anchor occurring four times", { ...BUY, sources: [{ file: "src/routes/repeat.js", line: 1, text: 'audit.log("an order event here")' }] }, "step 1: anchor 1 occurs 4 times in src/routes/repeat.js (at most 3)"],
    ["a user step with no route", { role: "buyer", goal: "g", sources: BUY.sources }, "step 1: no route"],
    ["a route segment no anchor names", { ...BUY, route: "/invoices/:id" }, "step 1: no anchor in a route or permission file under roots names invoices"],
    ["a system step with an unknown trigger", { ...SETTLE, trigger: "refund" }, "step 1: trigger refund is not in live.triggers"],
    ["a system step anchored outside roots", { ...SETTLE, sources: [{ file: "src/lib/helper.js", line: 1, text: "export function settleHelperFunction" }] }, "step 1: no anchor under roots"],
    ["an unknown role", { ...BUY, role: "auditor" }, "step 1: role auditor is not in live.roles"],
  ];
  for (const [name, step, reason] of DROPS) {
    it(`drops ${name}`, () => {
      const t = mapRepo();
      t.map([journey("ok", [BUY, SETTLE, APPROVE]), journey("bad", [step])]);
      const r = mapCheck(t.main);
      expect(r.kept.map((j: Obj) => j.id)).toEqual(["ok"]);
      expect(r.dropped).toEqual([{ id: "bad", reason }]);
      expect(r.newDrops).toEqual(["bad"]);
      const after = t.read();
      expect(after.journeys.map((j: Obj) => j.id)).toEqual(["ok"]);
      expect(after.dropped).toEqual([{ id: "bad", reason, head: spawnSync("git", ["-C", t.main, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim() }]);
    });
  }

  it("drops a later duplicate id and an id that is not kebab-case; the route / needs only an anchor under roots", () => {
    const t = mapRepo();
    const home = { ...BUY, route: "/" };
    t.map([journey("ok", [BUY]), journey("ok", [APPROVE]), journey("Order_To_Cash", [BUY]), journey("home", [home]), journey("param-only", [{ ...BUY, route: "/:id" }])]);
    const r = mapCheck(t.main);
    expect(r.kept.map((j: Obj) => j.id)).toEqual(["ok", "home", "param-only"]);
    expect(r.dropped).toEqual([{ id: "ok", reason: "duplicate id" }, { id: "Order_To_Cash", reason: "id is not kebab-case" }]);
    expect(t.read().journeys[0].steps).toEqual([BUY]);
  });

  it("an anchor's file is read at HEAD, not from the working tree", () => {
    const t = mapRepo();
    t.map([journey("ok", [BUY])]);
    writeFileSync(join(t.main, "src/routes/orders.js"), "nothing here\n");
    expect(mapCheck(t.main).dropped).toEqual([]);
  });

  it("line moves to the nearest occurrence", () => {
    const t = mapRepo();
    t.map([journey("ok", [{ ...BUY, sources: [{ ...BUY.sources[0], line: 3 }] }, { ...BUY, route: "/orders/:id", sources: [{ file: "src/routes/orders.js", line: 1, text: 'requireRole("buyer")' }] }])]);
    mapCheck(t.main);
    const steps = t.read().journeys[0].steps;
    expect(steps[0].sources[0].line).toBe(5);
    // Two occurrences (lines 5 and 6): the nearest to line 1 is line 5.
    expect(steps[1].sources[0].line).toBe(5);
  });

  it("without .argus/live.json roles are unchecked", () => {
    const t = mapRepo({ live: false });
    t.map([journey("ok", [{ ...BUY, role: "auditor" }])]);
    const r = t.cli();
    expect(r.code, r.err).toBe(0);
    expect(r.out).toEqual(["catalog: 1 journeys, 0 dropped, roles unchecked", "refresh: none"]);
  }, 30_000);

  it("refresh triggers", () => {
    const t = mapRepo();
    const head = () => spawnSync("git", ["-C", t.main, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    const reasons = () => refreshReasons(t.main, { newDrops: [] });
    const rehead = () => t.map([journey("ok", [BUY, SETTLE])]);
    expect(refreshReasons(committed(), { newDrops: [] })).toEqual(["no map"]);
    rehead();
    expect(reasons()).toEqual([]);
    writeFileSync(join(t.main, "src/routes/invoices.js"), "x\n");
    commitAll(t.main, "added");
    expect(reasons()).toEqual(["roots changed: 1 file(s) added, deleted or renamed"]);
    rehead();
    rmSync(join(t.main, "src/routes/invoices.js"));
    commitAll(t.main, "deleted");
    expect(reasons()).toEqual(["roots changed: 1 file(s) added, deleted or renamed"]);
    rehead();
    gitIn(t.main, "mv", "src/routes/orders.js", "src/routes/sales.js");
    commitAll(t.main, "renamed");
    expect(reasons()).toEqual(["roots changed: 1 file(s) added, deleted or renamed"]);
    rehead();
    // Modified files under roots and files added outside them only re-run map-check.
    appendFileSync(join(t.main, "src/routes/sales.js"), "// more\n");
    writeFileSync(join(t.main, "README.md"), "docs\n");
    commitAll(t.main, "modified");
    expect(reasons()).toEqual([]);
    // A momus report newer than the map's head.
    mkdirSync(join(t.main, ".momus"));
    const report = join(t.main, ".momus/report-x.md");
    writeFileSync(report, "report\n");
    const at = Number(gitIn(t.main, "show", "-s", "--format=%ct", t.read().head));
    utimesSync(report, at - 60, at - 60);
    expect(reasons()).toEqual([]);
    utimesSync(report, at + 60, at + 60);
    expect(reasons()).toEqual(["a momus report is newer than the map"]);
    rmSync(join(t.main, ".momus"), { recursive: true });
    // A head no longer in the history.
    t.map([journey("ok", [BUY])], { head: "0123456789abcdef0123456789abcdef01234567" });
    expect(reasons()).toEqual(["the map's head is no longer in the history"]);
    expect(head()).not.toBe("0123456789abcdef0123456789abcdef01234567");
  });

  it("a new drop asks for a refresh; the same drop again at the same head does not", () => {
    const t = mapRepo();
    const bad = journey("bad", [{ ...BUY, route: "/invoices" }]);
    t.map([journey("ok", [BUY]), bad]);
    const r1 = t.cli();
    expect(r1.code, r1.err).toBe(0);
    expect(r1.out).toEqual(["dropped bad: step 1: no anchor in a route or permission file under roots names invoices", "catalog: 1 journeys, 1 dropped", "refresh: new drops: bad"]);
    // A refresh returns the journey again, at the same head: dropped again, nothing more.
    const now = t.read();
    writeFileSync(t.file, JSON.stringify({ ...now, journeys: [...now.journeys, bad] }));
    const r2 = t.cli();
    expect(r2.out).toEqual(["dropped bad: step 1: no anchor in a route or permission file under roots names invoices", "catalog: 1 journeys, 1 dropped", "refresh: none"]);
    expect(t.read().dropped).toHaveLength(1);
  }, 30_000);

  it("no journey kept is refused; a map that is not one is refused", () => {
    const t = mapRepo();
    t.map([journey("bad", [{ ...BUY, route: "/invoices" }])]);
    const r = t.cli();
    expect(r.code).toBe(1);
    expect(r.err).toBe("refused: no journey is selectable\n");
    writeFileSync(t.file, '{"journeys": 3}');
    expect(() => readJourneys(t.main)).toThrow("refused: .argus/journeys.json is not a journey map");
    expect(t.cli().err).toBe("refused: .argus/journeys.json is not a journey map\n");
    rmSync(t.file);
    expect(readJourneys(t.main)).toBeNull();
    const none = t.cli();
    expect(none.code).toBe(1);
    expect(none.out).toEqual(["catalog: 0 journeys, 0 dropped", "refresh: no map"]);
  }, 30_000);

  it("map-check starts nothing", () => {
    const t = mapRepo();
    t.map([journey("ok", [BUY, SETTLE]), journey("bad", [{ ...BUY, route: "/invoices" }])]);
    const seen: string[] = [];
    const runner = (argv: string[], opts: Obj = {}) => (seen.push(argv[0]), spawnSync(argv[0], argv.slice(1), { encoding: "utf8", ...opts }));
    const r = mapCheck(t.main, { runner });
    refreshReasons(t.main, { newDrops: r.newDrops, runner });
    expect(seen.length).toBeGreaterThan(0);
    expect([...new Set(seen)]).toEqual(["git"]);
    expect(t.cli("--list").code).toBe(0);
    expect(existsSync(join(t.main, ".argus/live"))).toBe(false);
  }, 30_000);

  it("the catalog groups by domain and lists the drops", () => {
    const t = mapRepo();
    t.map([
      journey("order-to-cash", [BUY, SETTLE, APPROVE], { title: "Order to cash", money: true, lastCycle: 4, filed: [12, 15] }),
      journey("restock", [APPROVE, APPROVE], { domain: "warehouse", title: "Restock", global: true }),
      journey("reorder", [BUY], { title: "Reorder" }),
      journey("bad", [{ ...BUY, route: "/invoices" }]),
    ]);
    const r = t.cli("--list");
    expect(r.code, r.err).toBe(0);
    expect(r.out).toEqual([
      "dropped bad: step 1: no anchor in a route or permission file under roots names invoices",
      "catalog: 3 journeys, 1 dropped",
      "refresh: new drops: bad",
      "sales:",
      "  order-to-cash — Order to cash — buyer → system → clerk money — last cycle 4, filed 2",
      "  reorder — Reorder — buyer — last cycle never, filed 0",
      "warehouse:",
      "  restock — Restock — clerk global — last cycle never, filed 0",
      "dropped:",
      "  bad: step 1: no anchor in a route or permission file under roots names invoices",
    ]);
    expect(catalog(t.main)).toEqual(r.out.slice(3));
  }, 30_000);

  it("the usage line names map-check", () => {
    const r = spawnSync(process.execPath, [ARGUS_LIVE, "nonsense"], { cwd: committed(), encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(" | map-check [--list");
  }, 30_000);
});

describe("argus-live map mode", () => {
  const runs: { main: string; runId: string }[] = [];
  afterEach(async () => {
    for (const r of runs.splice(0)) await down(r.main, { runId: r.runId, graceMs: 1000 }).catch(() => {});
  });
  /** A map that passes map-check in mapRepo's code. */
  const MAP = { roots: ["src/routes", "src/jobs"], journeys: [{ id: "order-to-cash", domain: "sales", title: "Order to cash", money: true, global: false, goal: "an order is placed and settled", steps: [BUY, SETTLE] }] };
  /** mapRepo with `up --map` run in process → its summary; down after the test. */
  const mapped = async () => {
    const t = mapRepo();
    const u = await upMap(t.main);
    runs.push({ main: t.main, runId: u.runId });
    return { ...t, u };
  };
  const spawnCli = (main: string, ...args: string[]) => {
    const r = spawnSync(process.execPath, [ARGUS_LIVE, ...args], { cwd: main, encoding: "utf8" });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };

  it("up --map takes the lock and a worktree and starts nothing", async () => {
    const t = mapRepo();
    writeFileSync(join(t.main, ".gitignore"), ".argus/live/\n");
    const u = spawnCli(t.main, "up", "--map");
    expect(u.code, u.err).toBe(0);
    const summary = JSON.parse(u.out.trim().split("\n").at(-1)!);
    runs.push({ main: t.main, runId: summary.runId });
    expect(summary).toEqual({ runId: summary.runId, mode: "map", deadline: expect.any(Number), worktree: expect.any(String) });
    const rec = readRun(t.main);
    expect(rec).toMatchObject({ runId: summary.runId, mode: "map", instanceId: null, worktree: summary.worktree, groups: [], stops: [], sessions: [] });
    expect(rec.worktreeHead).toBe(gitIn(t.main, "rev-parse", "HEAD"));
    for (const k of ["home", "env", "browser", "internal", "ports"]) expect(rec[k] ?? null, k).toEqual(k === "ports" ? {} : null);
    expect(existsSync(`${summary.worktree}.home`)).toBe(false);
    expect(existsSync(join(summary.worktree, "src/routes/orders.js"))).toBe(true);
    const s = spawnCli(t.main, "status", "--json");
    expect(JSON.parse(s.out)).toMatchObject({ runId: summary.runId, mode: "map", instanceId: null, worktree: summary.worktree, slots: {} });
    expect(spawnCli(t.main, "status").out).toContain("mode: map\n");
    // A full up is refused while the map run holds the lock.
    expect(spawnCli(t.main, "up").err).toMatch(/^refused: cycle \S+ holds the lock until /);
    const d = spawnCli(t.main, "down");
    expect(d.code, d.err).toBe(0);
    expect(existsSync(summary.worktree)).toBe(false);
    // A map run drained no session and keeps no ledger: scrub says so, after down too.
    const body = join(tempDir(), "body.md");
    writeFileSync(body, "clean\n");
    expect(spawnCli(t.main, "scrub", "--run", summary.runId, "--title", "t", "--body", body)).toMatchObject({ code: 1, out: `refused: scrub: run ${summary.runId} is a map run (up --map): it drained no session and keeps no secret ledger; nothing from it is filed\n` });
    const log = readFileSync(join(t.main, ".git/sapu-live.log"), "utf8").trim().split("\n");
    expect(log.filter((l) => l.startsWith(`${summary.runId} start `))).toHaveLength(1);
    expect(log.filter((l) => l.startsWith(`${summary.runId} end `))).toHaveLength(1);
  }, 60_000);

  it("a map slot reads code and submits a map, nothing else", async () => {
    const t = await mapped();
    const m = await mintMapSlot(t.main, { slot: 1 });
    expect(m).toEqual({ slot: 1, token: expect.stringMatching(/^[0-9a-f]{32}$/), generation: 1, mode: "map" });
    expect(readRun(t.main).slots["1"]).toEqual({ mode: "map", journey: null, generation: 1, tokenHash: expect.any(String), accounts: {}, retired: [], submitted: false });
    expect(readdirSync(slotDir(t.main, t.u.runId, 1))).toEqual(["state.json"]);
    const code = await pw(t.main, [m.token, "code", "files", "src"]);
    expect(code.code).toBe(0);
    expect(code.out[0]).toContain(join(t.u.worktree, "src/routes/orders.js"));
    expect(code.out[1]).toBe("calls 1/120");
    const goto = await pw(t.main, [m.token, "buyer", "goto", "/"]);
    expect(goto).toEqual({ code: 1, out: ["refused: a map slot takes only code and submit", "calls 2/120"] });
    expect((await pw(t.main, [m.token, "facts", "x"])).out[0]).toBe("refused: a map slot takes only code and submit");
    const bad = await pw(t.main, [m.token, "submit", JSON.stringify({ ...MAP, extra: 1 })]);
    expect(bad).toEqual({ code: 1, out: ['refused: return: the map: unknown key "extra"'] });
    const ok = await pw(t.main, [m.token, "submit", JSON.stringify(MAP)]);
    expect(ok).toEqual({ code: 0, out: ["submitted: slot 1 generation 1 map journeys 1"] });
    expect((await pw(t.main, [m.token, "code", "files"])).out).toEqual(["refused: retired token"]);
    const lines = intake(t.main, 1);
    expect(lines[0]).toBe("slot 1 generation 1 map journeys 1 roots 2");
    expect(lines[1]).toMatch(/^<<<RETURN-/);
  }, 30_000);

  it("validateMap holds the map's schema", () => {
    expect(validateMap(MAP)).toEqual({ value: MAP, errors: [] });
    const step = (x: Obj) => ({ ...MAP, journeys: [{ ...MAP.journeys[0], steps: [{ ...BUY, ...x }] }] });
    const errs = (x: Obj) => validateMap(x).errors;
    expect(errs([])).toEqual(["the map must be a JSON object"]);
    expect(errs({ ...MAP, roots: ["../x"] })).toEqual(["roots[0] must be a repo-relative path (no ..)"]);
    expect(errs({ ...MAP, journeys: [{ ...MAP.journeys[0], id: "Order" }] })).toEqual(["journeys[0].id must be kebab-case"]);
    expect(errs({ ...MAP, journeys: [{ ...MAP.journeys[0], title: "t".repeat(121) }] })).toEqual(["journeys[0].title must be a string of at most 120 characters"]);
    expect(errs({ ...MAP, journeys: [{ ...MAP.journeys[0], money: "yes" }] })).toEqual(["journeys[0].money must be true or false"]);
    expect(errs(step({ role: "Buyer" }))).toEqual(["journeys[0].steps[0].role must be a role name"]);
    expect(errs(step({ route: "orders" }))).toEqual(["journeys[0].steps[0].route must start with / (at most 200 characters)"]);
    expect(errs(step({ claim: 1 }))).toEqual(["journeys[0].steps[0].claim must be true or false"]);
    expect(errs(step({ sources: [] }))).toEqual(["journeys[0].steps[0].sources must hold 1 to 10 anchors"]);
    expect(errs(step({ sources: [{ file: "/etc/x", line: 0, text: "short" }] }))).toEqual([
      "journeys[0].steps[0].sources[0].file must be a repo-relative path (no ..)",
      "journeys[0].steps[0].sources[0].line must be a whole number from 1",
      "journeys[0].steps[0].sources[0].text must be a string of 16 to 500 characters",
    ]);
    expect(errs(step({ why: "x" }))).toEqual(['journeys[0].steps[0]: unknown key "why"']);
    expect(errs({ ...MAP, journeys: Array.from({ length: 101 }, () => MAP.journeys[0]) })).toContain("journeys holds at most 100 entries");
    // A control character (a line break, ESC) in what the catalog prints could forge its lines.
    const J = MAP.journeys[0];
    expect(errs({ ...MAP, journeys: [{ ...J, title: "Order\ndropped: x" }] })).toEqual(["journeys[0].title must hold no control character"]);
    expect(errs({ ...MAP, journeys: [{ ...J, domain: "sa\u001b[2Jles" }] })).toEqual(["journeys[0].domain must hold no control character"]);
    expect(errs({ ...MAP, journeys: [{ ...J, goal: "a\rb" }] })).toEqual(["journeys[0].goal must hold no control character"]);
    expect(errs(step({ goal: "x\u0085y" }))).toEqual(["journeys[0].steps[0].goal must hold no control character"]);
    expect(errs({ ...MAP, notes: "n\no" })).toEqual(["notes must hold no control character"]);
    // An anchor's text is code: a tab stays.
    expect(errs(step({ sources: [{ ...BUY.sources[0], text: '\trouter.post("/orders/new"' }] }))).toEqual([]);
  });

  it("a map slot can be minted while up is still starting", async () => {
    const t = liveRun();
    runs.push({ main: t.main, runId: t.runId });
    writeRunFiles(t.main, { runId: t.runId, worktree: null, groups: [] });
    await expect(mintMapSlot(t.main, { slot: 1 })).rejects.toThrow(`refused: cycle ${t.runId} has no worktree yet`);
    writeRunFiles(t.main, { runId: t.runId, worktree: t.wt, home: t.home, groups: [] });
    expect((await mintMapSlot(t.main, { slot: 1 })).mode).toBe("map");
    await expect(mintMapSlot(t.main, { slot: 1 })).rejects.toThrow("refused: slot 1 is minted already");
    writeFileSync(join(t.main, ".argus/live.json"), JSON.stringify(example()));
    await expect(mintSlot(t.main, { slot: 2, journey: "order-to-cash", accounts: { "anon.1": null } })).rejects.toThrow(`refused: cycle ${t.runId} has no instance (its up did not finish)`);
    updateRun(t.main, t.runId, (prev: Obj) => ({ ...prev, closing: true }), { sealed: true });
    await expect(mintMapSlot(t.main, { slot: 3 })).rejects.toThrow(`refused: cycle ${t.runId} is being torn down`);
  }, 30_000);

  it("map-check --merge keeps ids, lastCycle and the journeys the map did not return", () => {
    const a = journey("a", [BUY], { lastCycle: 3, lastHead: "abc1234", filed: [7] });
    const b = journey("b", [APPROVE], { lastCycle: 2 });
    const prev = { head: "old", roots: ["src"], dropped: [{ id: "z", reason: "duplicate id", head: "old" }], journeys: [a, b] };
    const back = { roots: ["src/routes"], journeys: [{ id: "a", domain: "billing", title: "A again", money: true, global: false, goal: "g2", steps: [SETTLE] }, { id: "c", domain: "sales", title: "C", money: false, global: true, goal: "g3", steps: [BUY] }] };
    expect(mergeMap(prev, back, { head: "new" })).toEqual({
      head: "new",
      roots: ["src/routes"],
      dropped: prev.dropped,
      journeys: [
        { ...a, domain: "billing", title: "A again", money: true, global: false, goal: "g2", steps: [SETTLE] },
        b,
        { ...back.journeys[1], lastCycle: null },
      ],
    });
    expect(mergeMap(null, back, { head: "new" })).toEqual({ head: "new", roots: ["src/routes"], dropped: [], journeys: back.journeys.map((j) => ({ ...j, lastCycle: null })) });
  });

  it("map-check --merge stamps the worktree's commit, not MAIN's HEAD", async () => {
    const t = await mapped();
    const built = gitIn(t.main, "rev-parse", "HEAD");
    writeFileSync(join(t.main, "later.txt"), "later\n");
    commitAll(t.main, "meanwhile");
    expect(gitIn(t.main, "rev-parse", "HEAD")).not.toBe(built);
    const m = await mintMapSlot(t.main, { slot: 1 });
    expect((await pw(t.main, [m.token, "submit", JSON.stringify(MAP)])).code).toBe(0);
    await down(t.main, { runId: t.u.runId, graceMs: 1000 });
    runs.splice(0);
    const r = spawnCli(t.main, "map-check", "--merge", "1");
    expect(r.code, r.err).toBe(0);
    expect(r.out).toBe("catalog: 1 journeys, 0 dropped\nrefresh: none\n");
    const map = t.read();
    expect(map.head).toBe(built);
    expect(map.journeys.map((j: Obj) => [j.id, j.lastCycle])).toEqual([["order-to-cash", null]]);
    // A run that recorded no worktree commit is refused, and so is a slot that returned no map.
    rmSync(join(t.main, ".argus/live", t.u.runId, "worktree.json"));
    expect(spawnCli(t.main, "map-check", "--merge", "1").err).toBe(`refused: map-check --merge: run ${t.u.runId} recorded no worktree commit\n`);
    expect(spawnCli(t.main, "map-check", "--merge", "2").err).toBe("refused: slot 2 has not submitted\n");
  }, 60_000);

  it("up --fresh and renew refuse a map run", async () => {
    const t = await mapped();
    const refusal = `refused: cycle ${t.u.runId} is a map run (up --map); run down`;
    await expect(up(t.main, { fresh: true })).rejects.toThrow(refusal);
    await expect(renewRun(t.main)).rejects.toThrow(refusal);
    expect(readLock(t.main).runId).toBe(t.u.runId);
  }, 30_000);

  it("the usage line names map mode", () => {
    const r = spawnSync(process.execPath, [ARGUS_LIVE, "nonsense"], { cwd: committed(), encoding: "utf8" });
    for (const u of ["up [--fresh|--map]", "slot <n> --map", "map-check [--list|--merge <slot>]"]) expect(r.stderr, u).toContain(u);
  }, 30_000);
});

describe("argus-live select", () => {
  const ROLES = {
    anon: {},
    buyer: { users: [{ user: "buyer1@example.test", password: "pw" }, { user: "buyer2@example.test", password: "pw" }] },
    clerk: { users: [{ user: "clerk1@example.test", password: "pw" }] },
    admin: { login: { command: "true" } },
  };
  /** mapRepo with select's .argus/live.json (buyer with two users, clerk with one, admin by login command) and `journeys` as the map. */
  const selectRepo = (journeys: Obj[], { roles = ROLES as Obj, limits = {} as Obj } = {}) => {
    const t = mapRepo();
    writeFileSync(join(t.main, ".argus/live.json"), JSON.stringify({ roles, triggers: { settle: { argv: ["true"] } }, limits: { max_cycle_minutes: 30, ...limits } }));
    t.map(journeys);
    const cli = (...args: string[]) => {
      const r = spawnSync(process.execPath, [ARGUS_LIVE, "select", ...args], { cwd: t.main, encoding: "utf8" });
      return { code: r.status, out: r.stdout.trimEnd().split("\n").filter(Boolean), err: r.stderr };
    };
    return { ...t, cli };
  };
  const ANON = { role: "anon", route: "/orders/new", goal: "look", sources: BUY.sources };

  it("the score", () => {
    expect(score({ money: true, lastCycle: 90 }, { cycle: 100, flagged: [], commits: 2 })).toBe(60);
    expect(score({ id: "b" }, { cycle: 100, flagged: [], commits: 0 })).toBe(100);
    expect(score({ id: "a", money: true, lastCycle: 90 }, { cycle: 100, flagged: ["a"], commits: 2 })).toBe(120);
    // A journey visited this cycle still counts one cycle since its visit.
    expect(score({ lastCycle: 100 }, { cycle: 100, flagged: [], commits: 0 })).toBe(1);
    const t = selectRepo([]);
    const head = gitIn(t.main, "rev-parse", "HEAD");
    t.map([journey("a", [BUY], { money: true, lastCycle: 90, lastHead: head }), journey("b", [ANON])]);
    for (const n of [1, 2]) {
      appendFileSync(join(t.main, "src/routes/orders.js"), `// change ${n}\n`);
      commitAll(t.main, `orders ${n}`);
    }
    writeFileSync(join(t.main, "README.md"), "not an anchor\n");
    commitAll(t.main, "readme");
    const r = selectJourneys(t.main, { cycle: 100 });
    expect(r.picks.map((p: Obj) => [p.id, p.score])).toEqual([["b", 100], ["a", 60]]);
    expect(selectJourneys(t.main, { cycle: 100, flagged: ["a"] }).picks.map((p: Obj) => [p.id, p.score])).toEqual([["a", 120], ["b", 100]]);
  }, 30_000);

  it("a global journey is selected alone, or waits", () => {
    const t = selectRepo([journey("g", [ANON], { global: true }), journey("n", [ANON], { lastCycle: 50 }), journey("m", [ANON], { lastCycle: 60 }), journey("o", [ANON], { lastCycle: 70 })]);
    expect(selectJourneys(t.main, { cycle: 100 })).toEqual({
      picks: [{ id: "g", score: 100, accounts: { "anon.1": null } }],
      waits: [{ id: "n", score: 50, why: "global journey selected alone" }, { id: "m", score: 40, why: "global journey selected alone" }, { id: "o", score: 30, why: "global journey selected alone" }],
      displaced: [],
    });
    t.map([journey("g", [ANON], { global: true, lastCycle: 90 }), journey("n", [ANON], { lastCycle: 50 }), journey("m", [ANON], { lastCycle: 60 }), journey("o", [ANON], { lastCycle: 70 })]);
    expect(selectJourneys(t.main, { cycle: 100 })).toEqual({
      picks: [{ id: "n", score: 50, accounts: { "anon.1": null } }, { id: "m", score: 40, accounts: { "anon.1": null } }],
      waits: [{ id: "o", score: 30, why: "limit 2 reached" }, { id: "g", score: 10, why: "a global journey waits for a cycle of its own" }],
      displaced: [],
    });
  });

  it("no account serves two journeys; a journey waits when its accounts cannot be allocated", () => {
    const t = selectRepo([journey("x", [BUY, APPROVE]), journey("y", [BUY, APPROVE])]);
    const r = t.cli("--cycle", "3");
    expect(r.code, r.err).toBe(0);
    expect(r.out).toEqual(["select x score 3 accounts buyer.1=buyer1@example.test,clerk.1=clerk1@example.test", "wait y score 3 (no free account for clerk)"]);
  }, 30_000);

  it("a claim step gets a second account when one is free", () => {
    const claim = { ...BUY, claim: true };
    const t = selectRepo([journey("c", [claim, SETTLE, ANON]), journey("d", [BUY], { lastCycle: 1 })], { limits: { max_parallel_journeys: 3 } });
    const r = selectJourneys(t.main, { cycle: 3 });
    expect(r.picks).toEqual([{ id: "c", score: 3, accounts: { "buyer.1": "buyer1@example.test", "buyer.2": "buyer2@example.test", "anon.1": null } }]);
    expect(r.waits).toEqual([{ id: "d", score: 2, why: "no free account for buyer" }]);
    // Ranked after a journey holding buyer1, the claim journey gets the one buyer left.
    t.map([journey("c", [claim], { lastCycle: 1 }), journey("d", [BUY])]);
    expect(selectJourneys(t.main, { cycle: 3 }).picks).toEqual([{ id: "d", score: 3, accounts: { "buyer.1": "buyer1@example.test" } }, { id: "c", score: 2, accounts: { "buyer.1": "buyer2@example.test" } }]);
  });

  it("a login-command role serves one journey a cycle", () => {
    const ADMIN = { ...APPROVE, role: "admin" };
    const t = selectRepo([journey("p", [ADMIN]), journey("q", [ADMIN])]);
    expect(t.cli("--cycle", "1").out).toEqual(["select p score 1 accounts admin.1", "wait q score 1 (no free account for admin)"]);
  }, 30_000);

  it("explicit ids print what they displaced", () => {
    const t = selectRepo([journey("a", [ANON]), journey("b", [ANON], { lastCycle: 1 }), journey("c", [ANON], { lastCycle: 2 })]);
    const r = t.cli("--cycle", "4", "--ids", "c,a");
    expect(r.code, r.err).toBe(0);
    expect(r.out).toEqual(["select c score 2 accounts anon.1", "select a score 4 accounts anon.1", "displaced b score 3"]);
    expect(t.cli("--cycle", "4", "--ids", "zz").err).toBe("refused: select: no journey zz in .argus/journeys.json\n");
    expect(t.cli("--cycle", "4", "--flagged", "b").out).toEqual(["select b score 6 accounts anon.1", "select a score 4 accounts anon.1", "wait c score 2 (limit 2 reached)"]);
    for (const bad of [[], ["--cycle", "0"], ["--cycle", "x"], ["--cycle", "1", "--ids"]]) expect(t.cli(...bad).code, bad.join(" ")).toBe(1);
  }, 30_000);

  it("users must be literal", () => {
    const t = selectRepo([journey("x", [BUY])], { roles: { ...ROLES, buyer: { users: [{ user: "buyer1@example.test", password: "pw" }, { user: "${BUYER_USER}", password: "pw" }] } } });
    const r = t.cli("--cycle", "1");
    expect(r.code).toBe(1);
    expect(r.out).toEqual([]);
    expect(r.err).toBe("refused: roles.buyer.users[1].user must be written literally for select\n");
  }, 30_000);

  it("no journey is selectable", () => {
    const t = selectRepo([journey("x", [{ ...BUY, role: "auditor" }])]);
    const r = t.cli("--cycle", "1");
    expect(r.code).toBe(1);
    expect(r.out).toEqual(["wait x score 1 (no free account for auditor)"]);
    expect(r.err).toBe("refused: no journey is selectable\n");
  }, 30_000);

  it("the usage line names select", () => {
    const r = spawnSync(process.execPath, [ARGUS_LIVE, "nonsense"], { cwd: committed(), encoding: "utf8" });
    expect(r.stderr).toContain(" | select --cycle <n> [--flagged <id>,…] [--ids <id>,…]");
  }, 30_000);
});

describe("argus-live doc drift", () => {
  const T1 = Math.floor(Date.now() / 1000) - 3 * 86_400;
  const T2 = T1 + 86_400;
  const T3 = T2 + 86_400;
  /** Commits every change in `main` authored at `author` and committed at `committer` (epoch seconds). */
  const commitAt = (main: string, author: number, committer = author) => {
    const env = { ...process.env, GIT_AUTHOR_DATE: `@${author} +0000`, GIT_COMMITTER_DATE: `@${committer} +0000` };
    for (const args of [["add", "-A"], ["-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", "commit", "-qm", "c"]]) expect(spawnSync("git", ["-C", main, ...args], { env, encoding: "utf8" }).status).toBe(0);
  };
  const doc = (main: string, text = "Orders ship within two days.") => writeFileSync(join(main, "guide.md"), `# Guide\n\n${text}\n`);
  const code = (main: string, days = 2) => writeFileSync(join(main, "ship.js"), `// shipping\nexport const SHIP_DAYS = ${days};\n`);
  const RANGES = { doc: "guide.md:3-3", code: ["ship.js:2-2"] };

  it("code newer than the doc, the doc newer, both in one commit", () => {
    const a = committed();
    doc(a);
    commitAt(a, T1);
    code(a);
    commitAt(a, T2);
    expect(drift(a, RANGES)).toEqual({ verdict: "code-newer" });
    const b = committed();
    code(b);
    commitAt(b, T1);
    doc(b);
    commitAt(b, T2);
    expect(drift(b, RANGES)).toEqual({ verdict: "doc-newer" });
    const c = committed();
    doc(c);
    code(c);
    commitAt(c, T2);
    expect(drift(c, RANGES)).toEqual({ verdict: "undecidable", why: "same time" });
  });

  it("the newest of every code range counts", () => {
    const m = committed();
    code(m);
    commitAt(m, T1);
    doc(m);
    commitAt(m, T2);
    writeFileSync(join(m, "rules.js"), "export const LATE = true;\n");
    commitAt(m, T3);
    expect(drift(m, { doc: "guide.md:3-3", code: ["ship.js:1-2", "rules.js:1-1"] })).toEqual({ verdict: "code-newer" });
  });

  it("uncommitted lines, a file with no history and a bad range", () => {
    const m = committed();
    doc(m);
    code(m);
    commitAt(m, T1);
    doc(m, "Orders ship within a week.");
    expect(drift(m, RANGES)).toEqual({ verdict: "undecidable", why: "uncommitted lines" });
    writeFileSync(join(m, "new.md"), "a\nb\n");
    expect(drift(m, { doc: "new.md:1-2", code: ["ship.js:2-2"] })).toEqual({ verdict: "undecidable", why: "no history" });
    expect(drift(m, { doc: "guide.md:7-9", code: ["ship.js:2-2"] })).toEqual({ verdict: "undecidable", why: "no history" });
    for (const bad of ["../guide.md:1-2", "/etc/passwd:1-2", "guide.md:2-1", "guide.md:0-1", "guide.md", "docs/../guide.md:1-1"]) {
      expect(() => drift(m, { doc: bad, code: ["ship.js:2-2"] }), bad).toThrow(`refused: drift: ${bad} is not <repo-relative file>:<a>-<b>`);
      expect(() => drift(m, { doc: "guide.md:3-3", code: [bad] }), bad).toThrow("refused: drift: ");
    }
  });

  it("author time decides, not committer time", () => {
    // The doc written at T1 but committed at T3 (as a rebase leaves it); the code written and committed at T2.
    const m = committed();
    doc(m);
    commitAt(m, T1, T3);
    code(m);
    commitAt(m, T2);
    expect(drift(m, RANGES)).toEqual({ verdict: "code-newer" });
  });

  it("the CLI's verdict lines", () => {
    const m = committed();
    doc(m);
    commitAt(m, T1);
    code(m);
    commitAt(m, T2);
    const cli = (...args: string[]) => {
      const r = spawnSync(process.execPath, [ARGUS_LIVE, "drift", ...args], { cwd: m, encoding: "utf8" });
      return { code: r.status, out: r.stdout, err: r.stderr };
    };
    expect(cli("--doc", "guide.md:3-3", "--code", "ship.js:2-2")).toEqual({ code: 0, out: "code-newer → needs-owner\n", err: "" });
    expect(cli("--doc", "ship.js:2-2", "--code", "guide.md:3-3").out).toBe("doc-newer → class B(a)\n");
    expect(cli("--doc", "guide.md:3-3", "--code", "guide.md:3-3", "--code", "ship.js:1-1").out).toBe("code-newer → needs-owner\n");
    expect(cli("--doc", "guide.md:3-3", "--code", "guide.md:3-3").out).toBe("undecidable (same time) → needs-owner\n");
    for (const bad of [["--doc", "guide.md:3-3"], ["--code", "ship.js:2-2"], ["--doc", "a:1-2", "--doc", "b:1-2", "--code", "c:1-1"], ["--doc", "../a:1-2", "--code", "c:1-1"]]) expect(cli(...bad).code, bad.join(" ")).toBe(1);
    const usage = spawnSync(process.execPath, [ARGUS_LIVE, "nonsense"], { cwd: m, encoding: "utf8" });
    expect(usage.stderr).toContain(" | drift --doc <file>:<a>-<b> --code <file>:<a>-<b> [--code …]");
  }, 30_000);
});

describe("argus-live visit", () => {
  it("visit writes a journey's lastCycle, lastHead and filed into journeys.json, and nothing else", () => {
    const t = mapRepo();
    t.map([journey("order-to-cash", [BUY]), journey("refund", [BUY], { filed: ["https://github.com/o/r/issues/3"] })]);
    const before = t.read();
    const visit = (...args: string[]) => {
      const r = spawnSync(process.execPath, [ARGUS_LIVE, "visit", ...args], { cwd: t.main, encoding: "utf8" });
      return { code: r.status, out: r.stdout, err: r.stderr };
    };
    const head = gitIn(t.main, "rev-parse", "HEAD");
    expect(visit("refund", "--cycle", "4", "--filed", "https://github.com/o/r/issues/9", "--filed", "https://github.com/o/r/issues/3")).toEqual({ code: 0, out: `visited refund: last cycle 4, last head ${head.slice(0, 12)}, filed 2\n`, err: "" });
    const after = t.read();
    expect(after.journeys[1]).toEqual({ ...before.journeys[1], lastCycle: 4, lastHead: head, filed: ["https://github.com/o/r/issues/3", "https://github.com/o/r/issues/9"] });
    expect({ ...after, journeys: [after.journeys[0]] }).toEqual({ ...before, journeys: [before.journeys[0]] });
    // A visit that filed nothing keeps what was filed before.
    expect(visit("order-to-cash", "--cycle", "5").code).toBe(0);
    expect(t.read().journeys[0]).toMatchObject({ lastCycle: 5, lastHead: head, filed: [] });
    const kept = readFileSync(t.file, "utf8");
    for (const args of [["nope", "--cycle", "1"], ["refund"], ["refund", "--cycle", "0"], ["refund", "--cycle", "x"], ["refund", "--cycle", "2", "--filed", "https://evil.test/x"], ["refund", "--cycle", "2", "--filed", "https://github.com/o/r\u001b[2J/issues/9"], ["refund", "--cycle", "2", "--filed", "https://git\u001bhub.com/o/r/issues/9"], ["refund", "--cycle", "2", "--filed", "https://github.com/o/r/issues/9\u007f"], ["refund", "--cycle", "2", "--filed", "https://git\u0085hub.com/o/r/issues/9"], ["refund", "--cycle", "2", "--filed", "https://github.com/o/r\u009b2J/issues/9"], ["refund", "--cycle", "2", "--filed", "https://github.com/o/r\u202e/issues/9"], ["refund", "--cycle", "2", "--filed", "https://git\u202ehub.com/o/r/issues/9"], ["refund", "--cycle", "2", "--cycle", "3"], ["Bad Id", "--cycle", "2"]]) {
      const r = visit(...args);
      expect(r.code, args.join(" ")).toBe(1);
      expect(r.err, args.join(" ")).toMatch(/^refused: /);
    }
    expect(readFileSync(t.file, "utf8")).toBe(kept);
  }, 30_000);
});
