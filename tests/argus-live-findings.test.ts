// tests/argus-live-findings.test.ts — the journey lane's findings side without a browser: the module DAG,
// origins, the session driver (the CLI shim standing in for @playwright/cli), and later the repro DSL, the
// generated test, classes, the secret ledger's matcher, scrub, the journey map, SELECT and doc drift.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { alive, ARGUS_LIVE, cleanTemps, committed, example, liveRun, makeShim, tempDir, until } from "./helpers/argus-live";
// @ts-expect-error — plain ESM script without types
import { openSession, SIGNAL_SCRIPT, slotDir } from "../plugins/sapu/scripts/argus-live-browser.mjs";
// @ts-expect-error — plain ESM script without types
import { sessionName } from "../plugins/sapu/scripts/argus-live-cli.mjs";
// @ts-expect-error — plain ESM script without types
import { CLASSES, classify } from "../plugins/sapu/scripts/argus-live-classes.mjs";
// @ts-expect-error — plain ESM script without types
import { expandConfig, loadLive } from "../plugins/sapu/scripts/argus-live-config.mjs";
// @ts-expect-error — plain ESM script without types
import { appendLedger, appendSeen, dropLedgers, highEntropy, LEDGER_CLASSES, ledgerEntries, ledgerFile, MAX_SECRET, MIN_SECRET, readLedger, readSeen, secretHits, seenFile, seenIds } from "../plugins/sapu/scripts/argus-live-ledger.mjs";
// @ts-expect-error — plain ESM script without types
import { HELPERS, loginCode } from "../plugins/sapu/scripts/argus-live-login.mjs";
// @ts-expect-error — plain ESM script without types
import { checkUrl, originOf } from "../plugins/sapu/scripts/argus-live-origin.mjs";
// @ts-expect-error — plain ESM script without types
import { startTime } from "../plugins/sapu/scripts/argus-live-proc.mjs";
// @ts-expect-error — plain ESM script without types
import { repro } from "../plugins/sapu/scripts/argus-live-repro.mjs";
// @ts-expect-error — plain ESM script without types
import { down, logsDir, readRun, updateRun, writeRunFiles } from "../plugins/sapu/scripts/argus-live-run.mjs";
// @ts-expect-error — plain ESM script without types
import { configuredUser, drainSessions, maskSecrets, sessionDriver } from "../plugins/sapu/scripts/argus-live-session.mjs";
// @ts-expect-error — plain ESM script without types
import { ORACLES } from "../plugins/sapu/scripts/argus-live-return.mjs";
// @ts-expect-error — plain ESM script without types
import { readSlotState, writeSlotState } from "../plugins/sapu/scripts/argus-live-slots.mjs";
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
  });
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
  });
});

describe("argus-live repro DSL", () => {
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
  });
});
