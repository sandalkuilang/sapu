// tests/argus-live-findings.test.ts — the journey lane's findings side without a browser: the module DAG,
// origins, the session driver (the CLI shim standing in for @playwright/cli), and later the repro DSL, the
// generated test, classes, the secret ledger's matcher, scrub, the journey map, SELECT and doc drift.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { alive, ARGUS_LIVE, cleanTemps, committed, example, fakeGh, liveRun, makeShim, tempDir, until } from "./helpers/argus-live";
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
import { minimize, repro } from "../plugins/sapu/scripts/argus-live-repro.mjs";
// @ts-expect-error — plain ESM script without types
import { redTest } from "../plugins/sapu/scripts/argus-live-redtest.mjs";
// @ts-expect-error — plain ESM script without types
import { down, logsDir, readRun, updateRun, writeRunFiles } from "../plugins/sapu/scripts/argus-live-run.mjs";
// @ts-expect-error — plain ESM script without types
import { defang, redactIds, scrub, scrubSecrets } from "../plugins/sapu/scripts/argus-live-scrub.mjs";
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
    // The generated RED test reads targets and oracles only; the runner above it writes it.
    expect([...(g.get("argus-live-redtest") ?? [])].sort()).toEqual(["argus-live-return", "argus-live-targets"]);
    expect(g.get("argus-live-repro")).toContain("argus-live-redtest");
    // Scrub reads only what a down keeps: the configuration, the ledger, the lock and run.json's records; pw writes its screenshot verdicts.
    expect([...(g.get("argus-live-scrub") ?? [])].sort()).toEqual(["argus-live-config", "argus-live-endpoints", "argus-live-ledger", "argus-live-lock", "argus-live-proc", "argus-live-run"]);
    expect(g.get("argus-live-pw")).toContain("argus-live-scrub");
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
  });

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
  });
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
  const run = (title: string, file: string, opts: Obj = {}, env: Obj = SCRUB_ENV) => scrub(t.main, { title, bodyFile: file, ...opts }, { env, ...(opts.gh ? { gh: opts.gh } : {}) });
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
    const cli = spawnSync(process.execPath, [ARGUS_LIVE, "scrub", "--title", `T ${SCRUB.role}`, "--body", file], { cwd: t.main, encoding: "utf8", env: { ...SCRUB_ENV, PATH: process.env.PATH! } });
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
  });

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
  });

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
    });
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
  });

  it("the needs-owner label goes through create", async () => {
    const t = filing();
    expect((await t.file({ labels: ["argus:needs-owner", "bug"] }).done).code).toBe(0);
    const argv = creates(t.g)[0].argv;
    expect(argv.slice(argv.indexOf("--label"))).toEqual(["--label", "argus:needs-owner", "--label", "bug"]);
  });

  it("a body scrubbed again names its local evidence once", async () => {
    const t = filing();
    const png = t.shot("1/out/page-1.png", null);
    const b = t.body("A clean body.\n");
    for (let i = 0; i < 2; i++) expect((await t.run("A title", b, { attach: [png], gh: t.g.gh })).code).toBe(0);
    expect(readFileSync(b, "utf8")).toBe(`A clean body.\n\nLocal evidence: \`${t.shown("1/out/page-1.png")}\`\n`);
  });

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
    const cli = spawnSync(process.execPath, [ARGUS_LIVE, "scrub", "--title", "Order fails for @octocat", "--body", b, "--attach", png, "--create", "--label", "bug"], { cwd: t.main, encoding: "utf8", env });
    expect(cli.status, cli.stderr).toBe(0);
    expect(cli.stdout.trimEnd().split("\n")).toEqual(["scrub: ok; redacted 2, defanged 2, cut 0 line(s)", "title: Order fails for `@octocat`", `attach: ${t.shown("1/out/page-1.png")}`, `filed: ${URL9}`]);
    expect(leaked(`${cli.stdout}\n${cli.stderr}\n${JSON.stringify(t.g.calls())}`, secret)).toEqual([]);
    // A refusal through the CLI: no gh, and none of it in the output either.
    const g0 = t.g.calls().length;
    const bad = t.body(`raw ${SCRUB.header}, url ${SCRUB_FORMS.url(SCRUB.storage)}, b64 ${SCRUB_FORMS.base64(SCRUB.made)}, spaced ${SCRUB_FORMS.spaced(SCRUB.envFile)}\n`);
    const refused = spawnSync(process.execPath, [ARGUS_LIVE, "scrub", "--title", `t ${SCRUB.gh}`, "--body", bad, "--create"], { cwd: t.main, encoding: "utf8", env });
    expect(refused.status).toBe(1);
    expect(refused.stdout.trimEnd().split("\n")).toHaveLength(6);
    expect(leaked(`${refused.stdout}\n${refused.stderr}`, secret)).toEqual([]);
    expect(t.g.calls()).toHaveLength(g0);
    // The CLI's own refusals.
    for (const args of [["--title", "t", "--body", bad, "--label", "bug"], ["--title", "t", "--body", bad, "--create", "--comment", "9"], ["--title", "t", "--body", bad, "--comment", "x"]]) {
      expect(spawnSync(process.execPath, [ARGUS_LIVE, "scrub", ...args], { cwd: t.main, encoding: "utf8", env }).status, args.join(" ")).toBe(1);
    }
  }, 30_000); // five spawned CLIs
});
