// Helpers shared by the argus-live test files: temp directories, a committed repo, a run as `up`
// leaves it before its run files, small process and timing helpers, and the runs the Chrome suites
// drive (the fixture app, the run's proxy, slot 1) with the cleanup each of their tests ends with.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { type Server as HttpServer } from "node:http";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
// @ts-expect-error — plain ESM script without types
import { cliCacheRoot, cliInstallDir, ensureCli, findChrome, openSession, slotConfig, slotDir, writeSlotConfig } from "../../plugins/sapu/scripts/argus-live-browser.mjs";
// @ts-expect-error — plain ESM script without types
import { runCli } from "../../plugins/sapu/scripts/argus-live-cli.mjs";
// @ts-expect-error — plain ESM script without types
import { startProxy } from "../../plugins/sapu/scripts/argus-live-proxy.mjs";
// @ts-expect-error — plain ESM script without types
import { pw } from "../../plugins/sapu/scripts/argus-live-pw.mjs";
// @ts-expect-error — plain ESM script without types
import { down, logsDir, updateRun, writeRunFiles } from "../../plugins/sapu/scripts/argus-live-run.mjs";
// @ts-expect-error — plain ESM script without types
import { mintSlot } from "../../plugins/sapu/scripts/argus-live-slots.mjs";
// @ts-expect-error — plain ESM script without types
import { makeHome, makeWorktree, startEntry, waitHealth } from "../../plugins/sapu/scripts/argus-live-start.mjs";
// @ts-expect-error — plain ESM script without types
import { takeLock } from "../../plugins/sapu/scripts/argus-live-lock.mjs";

/** The example of spec §8, verbatim. */
export const example = (): Record<string, any> => ({
  setup: [["npm", "ci"]],
  services: { db: { env: "DATABASE_URL" }, cache: { env: "REDIS_URL" }, mail: { env: "SMTP_URL" } },
  start: [
    { name: "backing", phase: "store", cmd: "docker compose up postgres redis mailpit", stop: "docker compose down -v", health: { cmd: "docker compose exec -T postgres pg_isready" } },
    { name: "api", cmd: "npm run dev -- --port {port:api}", health: { url: "http://localhost:{port:api}/health" } },
    { name: "web", cmd: "npm run dev:web -- --port {port:web}", env: { API_URL: "http://localhost:{port:api}" }, health: { url: "http://localhost:{port:web}/" } },
    { name: "worker", cmd: "npm run worker" },
  ],
  base_url: "http://localhost:{port:web}",
  login_url: "/login",
  logged_in: "getByRole('button', { name: 'Account' })",
  env_file: ".argus/live.env",
  env: {
    DATABASE_URL: "postgres://app:${DB_PW}@localhost:{port:pg}/app_explore",
    REDIS_URL: "redis://localhost:{port:redis}",
    SMTP_URL: "smtp://localhost:{port:smtp}",
    PG_PORT: "{port:pg}",
    REDIS_PORT: "{port:redis}",
    SMTP_PORT: "{port:smtp}",
  },
  pass_env: [],
  store: "app_explore",
  store_check: "npm run -s explore:which-db",
  reset: "npm run -s db:reset:explore",
  facts: { argv: ["npm", "run", "-s", "explore:facts", "--", "{1}"], args: ["^[A-Za-z0-9._:-]{1,128}$"] },
  mail: { argv: ["npm", "run", "-s", "explore:mail"] },
  triggers: { "payment-settles": { argv: ["npm", "run", "-s", "explore:settle", "--", "{1}"], args: ["^[A-Za-z0-9-]{1,64}$"] } },
  confirmed: { mocks: true, data: true },
  allow_origins: [],
  port_range: [41000, 41999],
  reserved_ports: [3000, 4000, 5432, 6379],
  login_spacing_ms: 0,
  timezone: "UTC",
  locale: "en-US",
  fixtures: "test/fixtures/explore",
  roles: {
    anon: {},
    customer: { code_role: "partner", users: [{ user: "buyer1@example.test", password: "${PW}" }, { user: "buyer2@example.test", password: "${PW}" }] },
    sales: { code_role: "sales", users: [{ user: "sales1@example.test", password: "${PW}", totp_secret: "${SALES_TOTP}" }] },
    admin: { code_role: "admin", login: { command: "npm run -s explore:login -- admin" } },
  },
  viewports: [1440, 390],
  locales: [],
  settle_ms: 10000,
  prohibited: [],
  limits: { max_cycle_minutes: 45, max_parallel_journeys: 2, live_health_timeout_s: 120, explorer_pw_calls: 120, minimize_runs: 12 },
});

const temps: string[] = [];

/** A fresh directory under the OS temp dir; removed by cleanTemps (each test file calls it afterEach). */
export const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "argus-live-"));
  temps.push(d);
  return d;
};

export const cleanTemps = () => {
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
};

export const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

/** A repo with one commit (`app.txt`). */
export const committed = () => {
  const main = tempDir();
  git(main, "init", "-q");
  writeFileSync(join(main, "app.txt"), "app\n");
  git(main, "add", ".");
  git(main, "-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", "commit", "-qm", "init");
  return main;
};

/** A loopback port free at the moment of the call. */
export const freePort = () =>
  new Promise<number>((done) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => done(p));
    });
  });

/** The process runs (one of another user's counts as running). */
export const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Polls `ok` every 50 ms for up to `ms`; its last answer. */
export const until = async (ok: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  return ok();
};

/** Now in epoch seconds, as the lock records times. */
export const now = () => Math.floor(Date.now() / 1000);

export const setLock = (main: string, lock: { runId: string; start: number; deadline: number }) => writeFileSync(join(main, ".argus/live/lock.json"), `${JSON.stringify(lock)}\n`);

/** A docker whose context is a local socket and whose daemon is not running: a run's Docker steps have nothing to look at. */
export const fakeDocker = () => {
  const bin = tempDir();
  writeFileSync(
    join(bin, "docker"),
    `#!/bin/sh\nif [ "$1" = context ]; then echo '[{"Name":"default","Endpoints":{"docker":{"Host":"unix:///nonexistent/docker.sock"}}}]'; exit 0; fi\necho "Cannot connect to the Docker daemon at unix:///nonexistent/docker.sock. Is the docker daemon running?" >&2\nexit 1\n`,
  );
  chmodSync(join(bin, "docker"), 0o755);
  return bin;
};

/**
 * A fresh HOME for a spawned `argus-live.mjs up`, holding a copy of the pinned CLI where ensureCli looks
 * under it (cliCacheRoot): step 2 finds it intact instead of installing it again from an empty npm cache.
 */
export const homeWithCli = () => {
  const home = tempDir();
  const root = cliCacheRoot({ home, env: {} });
  mkdirSync(root, { recursive: true, mode: 0o700 });
  cpSync(ensureCli().dir, cliInstallDir({ root }), { recursive: true, verbatimSymlinks: true });
  return home;
};

/** A run as `up` leaves it before its run files: the lock, a worktree, a HOME, a setup log. */
export const liveRun = () => {
  const main = committed();
  const l = takeLock(main, { maxCycleMinutes: 45 });
  const wt = makeWorktree(main, l.runId);
  const home = makeHome(main, l.runId);
  writeFileSync(`${wt}.setup.log`, "setup output\n");
  const env = { PATH: process.env.PATH!, HOME: home, COMPOSE_PROJECT_NAME: `argus-${l.runId}` };
  return { main, runId: l.runId as string, wt, home, env, lock: l };
};

/**
 * The CLI shim: a Node script standing in for playwright-cli.js. Each call appends `{argv, cwd, env}` as
 * one JSON line to `<shim>.calls`; a command named in `<shim>.answers` (`answer(cmd, text)`) prints that
 * text; else `goto` answers a page, `run-code` the next line of `<shim>.queue` (`queue(value)`), anything
 * else a fixed line.
 */
export const makeShim = (dir = tempDir()) => {
  const shim = join(dir, "shim.mjs");
  writeFileSync(
    shim,
    `import fs from "node:fs";
const self = new URL(import.meta.url).pathname;
const argv = process.argv.slice(2);
const file = (argv.find((a) => a.startsWith("--filename=")) ?? "").slice(11);
const code = file && fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined;
fs.appendFileSync(self + ".calls", JSON.stringify({ argv, cwd: process.cwd(), env: process.env, code }) + "\\n");
const cmd = argv.find((a) => !a.startsWith("-"));
const answers = fs.existsSync(self + ".answers") ? JSON.parse(fs.readFileSync(self + ".answers", "utf8")) : {};
if (Object.hasOwn(answers, cmd)) {
  process.stdout.write(answers[cmd]);
} else if (cmd === "goto") {
  const url = argv[argv.indexOf("--") + 1];
  process.stdout.write("### Page\\n- Page URL: " + url + "\\n");
} else if (cmd === "run-code") {
  const q = self + ".queue";
  const lines = fs.existsSync(q) ? fs.readFileSync(q, "utf8").split("\\n").filter(Boolean) : [];
  process.stdout.write("### Result\\n" + (lines.shift() ?? "null") + "\\n");
  fs.writeFileSync(q, lines.map((l) => l + "\\n").join(""));
} else {
  process.stdout.write("ok " + cmd + "\\n");
}
`,
  );
  const calls = (): Record<string, any>[] => (existsSync(`${shim}.calls`) ? readFileSync(`${shim}.calls`, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const answer = (cmd: string, text: string) => {
    const file = `${shim}.answers`;
    const all = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    writeFileSync(file, JSON.stringify({ ...all, [cmd]: text }));
  };
  const queue = (...values: unknown[]) => writeFileSync(`${shim}.queue`, values.map((v) => `${JSON.stringify(v)}\n`).join(""), { flag: "a" });
  return { shim, calls, answer, queue };
};

// ---------------------------------------------------------------------------------------------------
// The Chrome suites' runs (argus-live-browser.test.ts, argus-live-repro.test.ts). Each such file calls
// browserTools() in its beforeAll and registers browserCleanup and browserLeftovers as its afterEach.

type Obj = Record<string, any>;

export const SERVER = join(__dirname, "../fixtures/journey-app/server.mjs");
/** The fixture app's password for every account: quotes, a backslash, a colon, an ampersand and a plus, as a page or a CLI may encode them. */
export const PW = 'Pa"ss\\wo:rd &+1';

let tools: { cli: { dir: string; js: string }; chrome: { channel: string; path: string } } | null = null;
/** The pinned CLI (installed once) and the local Chrome-family browser; a machine without one fails, never skips. */
export const browserTools = () => {
  if (tools) return tools;
  const cli = ensureCli();
  const chrome = findChrome();
  if (!chrome) throw new Error(`no Chrome-family browser: install Google Chrome, or run: node ${cli.js} install-browser chrome`);
  tools = { cli, chrome };
  return tools;
};

const savedEnv = { ...process.env };
/** The runs a test started: no CLI daemon or browser of theirs may outlive it (browserLeftovers). */
export const runIds = new Set<string>();
/** What a test started, undone after it in reverse order (a run's down, a server's close). */
export const cleanups: (() => unknown)[] = [];
/** The fixture app's process groups the tests started: each must be gone once its run's `down` ran. */
export const apps: number[] = [];

/** The afterEach of a Chrome suite: every cleanup, then a fixture app still running fails the test (and is killed); the environment and temp directories restored. */
export const browserCleanup = async () => {
  const errors: string[] = [];
  for (const c of cleanups.splice(0).reverse()) {
    try {
      await c();
    } catch (e) {
      errors.push((e as Error).message); // the next cleanup still runs
    }
  }
  const groupAlive = (g: number) => {
    try {
      process.kill(-g, 0);
      return true;
    } catch {
      return false;
    }
  };
  const left = apps.splice(0).filter(groupAlive);
  for (const g of left) process.kill(-g, "SIGKILL");
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  for (const [k, v] of Object.entries(savedEnv)) if (process.env[k] !== v) process.env[k] = v;
  cleanTemps();
  if (left.length || errors.length) throw new Error(`the run's down left the fixture app running (groups ${left.join(", ")}): ${errors.join("; ") || "no cleanup failed"}`);
};

/** No CLI daemon or browser of a run of this file outlives its test (whatever the test asserted): only this file's runs' sessions. */
export const browserLeftovers = () => {
  const left = execFileSync("ps", ["-A", "-ww", "-o", "pid=", "-o", "command="], { encoding: "utf8" })
    .split("\n")
    .filter((l) => [...runIds].some((id) => l.includes(`cliDaemon.js ${id}-`) || l.includes(`-${id}.home/browser/`)));
  for (const l of left) {
    try {
      process.kill(-Number(l.trim().split(/\s+/)[0]), "SIGKILL"); // a daemon and Chrome's root each lead their group
    } catch {
      // gone
    }
  }
};

/** Listens on loopback; after the test every connection it holds is destroyed (a net.Server's close would wait for them) and it closes. */
export const listen = <T extends Server | HttpServer>(s: T) => {
  const sockets = new Set<Socket>();
  s.on("connection", (c: Socket) => (sockets.add(c), c.once("close", () => sockets.delete(c))));
  return new Promise<number>((ok) =>
    s.listen(0, "127.0.0.1", () => {
      cleanups.push(() => new Promise((done) => (s.close(done), sockets.forEach((c) => c.destroy()))));
      ok((s.address() as { port: number }).port);
    }),
  );
};

/**
 * A run as `up` leaves it once step 9 ran: the lock, worktree and HOME, the fixture app on `web`
 * (started with startEntry and recorded), run.json with its origins and `allowOrigins`, the run's proxy,
 * and slot 1's directory with its CLI config; run.json holds an instance id, as once `up` finished (an
 * explorer slot's session is recorded only then). `down` runs after the test.
 */
export const browserRun = async ({ allowOrigins = [] as string[], app = {} as Record<string, string> } = {}) => {
  const { cli, chrome } = browserTools();
  process.env.TMPDIR = tempDir();
  const r = liveRun();
  runIds.add(r.runId);
  cleanups.push(() => down(r.main, { runId: r.runId, graceMs: 2000 }));
  const cache = await listen(createServer((c) => c.on("error", () => {})));
  const web = await freePort();
  const data = join(tempDir(), "app_explore");
  const appEnv = { PATH: process.env.PATH!, PORT: String(web), DATA_DIR: data, APP_PW: PW, APP_TOTP: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", CONTROL_TOKEN: "control-7", CACHE_URL: `tcp://127.0.0.1:${cache}`, ...app };
  expect(spawnSync(process.execPath, [SERVER, "--reset"], { env: appEnv }).status).toBe(0);
  const groups: Obj[] = [];
  const upstream: Record<string, string> = {};
  const entry = { name: "web", cmd: `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(SERVER)}`, env: appEnv, health: { url: `http://localhost:${web}/health` } };
  const started = await startEntry(entry, { worktree: r.wt, env: { PATH: process.env.PATH! }, logs: logsDir(r.main, r.runId), groups });
  apps.push(groups[0].pgid);
  await waitHealth(entry, started, { timeoutS: 20, worktree: r.wt, env: {}, upstream });
  expect(upstream).toEqual({ [String(web)]: "127.0.0.1" });
  const origins = [`http://localhost:${web}`];
  writeRunFiles(r.main, { runId: r.runId, worktree: r.wt, home: r.home, origins, allowOrigins, upstream, groups, env: r.env, browser: { js: cli.js, channel: chrome.channel }, instanceId: "0123456789abcdef" });
  // As up's recording array: each group in run.json as soon as it is pushed.
  const recorded: Obj[] = [];
  recorded.push = (g: Obj) => (updateRun(r.main, r.runId, (prev: Obj) => ({ ...prev, groups: [...prev.groups, g] })), Array.prototype.push.call(recorded, g));
  const proxy = await startProxy(r.main, r.runId, { groups: recorded });
  const home = join(r.home, "browser");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const dir = slotDir(r.main, r.runId, 1);
  writeSlotConfig(dir, slotConfig({ dir, origins, allowOrigins, proxyPort: proxy.port, live: { locale: "en-US", timezone: "UTC" }, chrome }));
  const base = origins[0];
  const call = (session: string, ...args: string[]) => runCli({ js: cli.js, session, args, cwd: dir, home });
  /** The page's text, through the wrapper's own `eval` (never the explorer's). */
  const text = async (session: string) => (await call(session, "eval", "--", "() => document.body.innerText")).stdout;
  return { ...r, web, base, home, dir, proxy, appEnv, call, text, open: (account: string, storageState: string | null = null) => openSession({ main: r.main, runId: r.runId, slot: 1, account, js: cli.js, home, storageState }) };
};

/** browserRun plus what `up` leaves for the wrapper: .argus/live.json and its env file, the instance id and ports in run.json, slot 1 minted. */
export const pwBrowserRun = async () => {
  const b = await browserRun();
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
    roles: { anon: {}, buyer: { users: [{ user: "buyer1@example.test", password: "${PW}" }, { user: "buyer2@example.test", password: "${PW}" }] }, clerk: { users: [{ user: "clerk1@example.test", password: "${PW}", totp_secret: "${TOTP}" }] } },
    limits: { max_cycle_minutes: 45 },
  };
  mkdirSync(join(b.main, ".argus"), { recursive: true });
  writeFileSync(join(b.main, ".argus/live.json"), JSON.stringify(c));
  writeFileSync(join(b.main, ".argus/live.env"), `PW='${PW}'\nTOTP=${b.appEnv.APP_TOTP}\n`);
  updateRun(b.main, b.runId, (prev: Obj) => ({ ...prev, instanceId: "0123456789abcdef", ports: { web: b.web } }));
  const m = await mintSlot(b.main, { slot: 1, journey: "order-to-cash", accounts: { "buyer.1": "buyer1@example.test", "clerk.1": "clerk1@example.test", "anon.1": null } });
  const call = (...args: string[]) => pw(b.main, [m.token, ...args]);
  const stats = async () => (await (await fetch(`${b.base}/__test/stats`, { headers: { "x-test-control": "control-7" } })).json()).requests as Record<string, number>;
  return { ...b, token: m.token, call, stats };
};
