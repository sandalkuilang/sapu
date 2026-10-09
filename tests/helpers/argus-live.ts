// Helpers shared by the argus-live test files: temp directories, a committed repo, a run as `up`
// leaves it before its run files, and small process and timing helpers.
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error — plain ESM script without types
import { cliCacheRoot, cliInstallDir, ensureCli } from "../../plugins/sapu/scripts/argus-live-browser.mjs";
// @ts-expect-error — plain ESM script without types
import { makeHome, makeWorktree } from "../../plugins/sapu/scripts/argus-live-start.mjs";
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
