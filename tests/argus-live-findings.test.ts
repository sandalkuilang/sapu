// tests/argus-live-findings.test.ts — the journey lane's findings side without a browser: the module DAG,
// origins, the session driver (the CLI shim standing in for @playwright/cli), and later the repro DSL, the
// generated test, classes, the secret ledger's matcher, scrub, the journey map, SELECT and doc drift.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { alive, cleanTemps, example, liveRun, makeShim, tempDir, until } from "./helpers/argus-live";
// @ts-expect-error — plain ESM script without types
import { openSession, SIGNAL_SCRIPT, slotDir } from "../plugins/sapu/scripts/argus-live-browser.mjs";
// @ts-expect-error — plain ESM script without types
import { sessionName } from "../plugins/sapu/scripts/argus-live-cli.mjs";
// @ts-expect-error — plain ESM script without types
import { expandConfig, loadLive } from "../plugins/sapu/scripts/argus-live-config.mjs";
// @ts-expect-error — plain ESM script without types
import { appendLedger, appendSeen, dropLedgers, highEntropy, LEDGER_CLASSES, ledgerEntries, ledgerFile, MAX_SECRET, MIN_SECRET, readLedger, readSeen, secretHits, seenFile, seenIds } from "../plugins/sapu/scripts/argus-live-ledger.mjs";
// @ts-expect-error — plain ESM script without types
import { loginCode } from "../plugins/sapu/scripts/argus-live-login.mjs";
// @ts-expect-error — plain ESM script without types
import { checkUrl, originOf } from "../plugins/sapu/scripts/argus-live-origin.mjs";
// @ts-expect-error — plain ESM script without types
import { startTime } from "../plugins/sapu/scripts/argus-live-proc.mjs";
// @ts-expect-error — plain ESM script without types
import { down, logsDir, readRun, updateRun, writeRunFiles } from "../plugins/sapu/scripts/argus-live-run.mjs";
// @ts-expect-error — plain ESM script without types
import { configuredUser, drainSessions, maskSecrets, sessionDriver } from "../plugins/sapu/scripts/argus-live-session.mjs";
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
    // The ledger sits right above run.json's module: the drains above it write it, the teardown takes its drain as a parameter.
    expect([...(g.get("argus-live-ledger") ?? [])].sort()).toEqual(["argus-live-fence", "argus-live-lock", "argus-live-run"]);
    expect(reach(g, "argus-live-run").has("argus-live-session")).toBe(false);
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
