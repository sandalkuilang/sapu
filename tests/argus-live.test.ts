// tests/argus-live.test.ts — the journey lane's live instance (argus-live*.mjs): its config
// (.argus/live.json) is validated and expanded, and the lock and live log it keeps match what
// sapu-merge.sh's live_overlap reads.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:net";
import { basename, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error — plain ESM script without types
import { expand, expandConfig, loadLive, parseEnvFile, portNames, validateLive } from "../plugins/sapu/scripts/argus-live-config.mjs";
// @ts-expect-error — plain ESM script without types
import {
  allocatePorts,
  appendEnd,
  bringUpRest,
  bringUpStore,
  checkStore,
  instanceEnv,
  makeHome,
  makeWorktree,
  portFree,
  portHolder,
  readLock,
  renew,
  runSetup,
  startEntry,
  takeLock,
  waitHealth,
} from "../plugins/sapu/scripts/argus-live-instance.mjs";

type Obj = Record<string, any>;

/** The example of spec §8, verbatim. */
const example = (): Obj => ({
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

const errorsOf = (mutate: (c: Obj) => void) => {
  const c = example();
  mutate(c);
  return validateLive(c) as string[];
};

const temps: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "argus-live-"));
  temps.push(d);
  return d;
};
afterEach(() => {
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

describe("argus-live config — validateLive", () => {
  it("accepts the spec §8 example", () => {
    expect(validateLive(example())).toEqual([]);
  });

  it("refuses a non-object", () => {
    expect(validateLive(null).length).toBeGreaterThan(0);
    expect(validateLive([]).length).toBeGreaterThan(0);
  });

  it.each(["start", "base_url", "login_url", "logged_in", "store", "store_check", "reset", "confirmed", "roles", "limits"])("names a missing %s", (key) => {
    const errs = errorsOf((c) => delete c[key]);
    expect(errs.some((e) => e.includes(key))).toBe(true);
  });

  it("names a missing limits.max_cycle_minutes and an empty start", () => {
    expect(errorsOf((c) => delete c.limits.max_cycle_minutes).some((e) => e.includes("max_cycle_minutes"))).toBe(true);
    expect(errorsOf((c) => (c.start = [])).some((e) => e.includes("start"))).toBe(true);
  });

  it("refuses unknown keys at the top level and inside known objects", () => {
    expect(errorsOf((c) => (c.base_ur = "x")).some((e) => e.includes('unknown key "base_ur"'))).toBe(true);
    expect(errorsOf((c) => (c.start[1].helth = {})).some((e) => e.includes('unknown key "helth"'))).toBe(true);
    expect(errorsOf((c) => (c.limits.max_cycles = 1)).some((e) => e.includes('unknown key "max_cycles"'))).toBe(true);
    expect(errorsOf((c) => (c.roles.sales.users[0].pass = "x")).some((e) => e.includes('unknown key "pass"'))).toBe(true);
    expect(errorsOf((c) => (c.confirmed.other = true)).some((e) => e.includes('unknown key "other"'))).toBe(true);
  });

  it("refuses a confirmed value that is not true", () => {
    expect(errorsOf((c) => (c.confirmed.mocks = false)).some((e) => e.includes("confirmed.mocks"))).toBe(true);
    expect(errorsOf((c) => delete c.confirmed.data).some((e) => e.includes("confirmed.data"))).toBe(true);
    expect(errorsOf((c) => (c.confirmed.data = "true")).some((e) => e.includes("confirmed.data"))).toBe(true);
  });

  it("refuses role names outside ^[a-z][a-z0-9_-]*$ and the reserved system", () => {
    for (const name of ["customer.2", "Sales", "1st", "system"]) {
      const errs = errorsOf((c) => (c.roles[name] = { users: [{ user: "u", password: "p" }] }));
      expect(errs.some((e) => e.includes(`roles.${name}`)), name).toBe(true);
    }
  });

  it("allows anon only as {}", () => {
    expect(errorsOf((c) => (c.roles.anon = { users: [{ user: "u", password: "p" }] })).some((e) => e.includes("roles.anon"))).toBe(true);
  });

  it("a role signs in by users or by login, exactly one", () => {
    expect(errorsOf((c) => (c.roles.admin.users = [{ user: "u", password: "p" }])).some((e) => e.includes("roles.admin"))).toBe(true);
    expect(errorsOf((c) => delete c.roles.admin.login).some((e) => e.includes("roles.admin"))).toBe(true);
    expect(errorsOf((c) => (c.roles.customer.users = [])).some((e) => e.includes("roles.customer"))).toBe(true);
    expect(errorsOf((c) => (c.roles.customer.users[0] = { user: "u" })).some((e) => e.includes("password"))).toBe(true);
  });

  it("refuses duplicate start names, a bad phase and a health with both url and cmd", () => {
    expect(errorsOf((c) => (c.start[2].name = "api")).some((e) => e.includes('duplicate start name "api"'))).toBe(true);
    expect(errorsOf((c) => (c.start[0].phase = "early")).some((e) => e.includes("phase"))).toBe(true);
    expect(errorsOf((c) => (c.start[1].health = { url: "http://localhost/", cmd: "true" })).some((e) => e.includes("health"))).toBe(true);
    expect(errorsOf((c) => delete c.start[3].cmd).some((e) => e.includes("cmd"))).toBe(true);
  });

  it("refuses a facts, mail or trigger args entry that is not a valid regex, and an empty argv", () => {
    expect(errorsOf((c) => (c.triggers["payment-settles"].args = ["("])).some((e) => e.includes("triggers.payment-settles"))).toBe(true);
    expect(errorsOf((c) => (c.facts.args = ["["])).some((e) => e.includes("facts"))).toBe(true);
    expect(errorsOf((c) => (c.mail.argv = [])).some((e) => e.includes("mail"))).toBe(true);
  });

  it("refuses a base_url that is not http(s) or names a non-loopback address", () => {
    expect(errorsOf((c) => (c.base_url = "ftp://localhost:{port:web}")).some((e) => e.includes("base_url"))).toBe(true);
    expect(errorsOf((c) => (c.base_url = "http://10.0.0.5:{port:web}")).some((e) => e.includes("base_url"))).toBe(true);
    expect(errorsOf((c) => (c.roles.sales.base_url = "http://192.168.1.2/")).some((e) => e.includes("roles.sales.base_url"))).toBe(true);
    expect(errorsOf((c) => (c.base_url = "http://127.0.0.1:{port:web}"))).toEqual([]);
    expect(errorsOf((c) => (c.base_url = "http://[::1]:{port:web}"))).toEqual([]);
  });

  it("refuses an allow_origins entry that is not a full origin", () => {
    expect(errorsOf((c) => (c.allow_origins = ["fonts.example.com"])).some((e) => e.includes("allow_origins"))).toBe(true);
    expect(errorsOf((c) => (c.allow_origins = ["https://fonts.example.com/css"])).some((e) => e.includes("allow_origins"))).toBe(true);
    expect(errorsOf((c) => (c.allow_origins = ["https://user@fonts.example.com"])).some((e) => e.includes("allow_origins"))).toBe(true);
    expect(errorsOf((c) => (c.allow_origins = ["https://fonts.example.com", "https://cdn.example.com:8443"]))).toEqual([]);
  });

  it("accepts an origin written with its default port (compared after URL normalisation)", () => {
    expect(errorsOf((c) => (c.allow_origins = ["https://fonts.example.com:443", "http://cdn.example.com:80"]))).toEqual([]);
  });

  it("bounds limits.max_cycle_minutes to a day", () => {
    expect(errorsOf((c) => (c.limits.max_cycle_minutes = 1440))).toEqual([]);
    expect(errorsOf((c) => (c.limits.max_cycle_minutes = 1441)).some((e) => e.includes("max_cycle_minutes"))).toBe(true);
    expect(errorsOf((c) => (c.limits.max_cycle_minutes = 1e300)).some((e) => e.includes("max_cycle_minutes"))).toBe(true);
  });

  it("refuses any ${ that is not a valid ${NAME}", () => {
    for (const bad of ["${ PW}", "${1PW}", "${PW", "${}", "a${PW-x}b", "${PW}${"]) {
      expect(errorsOf((c) => (c.env.X = bad)).some((e) => e.includes("env.X")), bad).toBe(true);
    }
    expect(errorsOf((c) => (c.env.X = "$PW and ${_PW_2}"))).toEqual([]);
  });

  it("requires port_range whenever a {port:<name>} is used (a fixed port alone needs none)", () => {
    expect(errorsOf((c) => delete c.port_range).some((e) => e.includes("port_range is required"))).toBe(true);
    const c = example();
    delete c.port_range;
    const at: Record<string, number> = { api: 41001, web: 41002, pg: 41003, redis: 41004, smtp: 41005 };
    const fixedOnly = JSON.parse(JSON.stringify(c).replace(/\{port:([a-z]+)\}/g, (_m: string, n: string) => `{port:${n}=${at[n]}}`));
    expect(validateLive(fixedOnly).filter((e: string) => e.includes("port_range"))).toEqual([]);
  });

  it("refuses one port fixed for two names, and one name fixed at two ports", () => {
    expect(errorsOf((c) => Object.assign(c.env, { A: "{port:db=5433}", B: "{port:cache=5433}" })).some((e) => e.includes("port 5433 is fixed for both db and cache"))).toBe(true);
    expect(errorsOf((c) => Object.assign(c.env, { A: "{port:db=5433}", B: "{port:db=5440}" })).some((e) => e.includes("port db is fixed at both 5433 and 5440"))).toBe(true);
  });

  it("refuses a bad port_range and a malformed placeholder", () => {
    expect(errorsOf((c) => (c.port_range = [42000, 41000])).some((e) => e.includes("port_range"))).toBe(true);
    expect(errorsOf((c) => (c.port_range = [0, 70000])).some((e) => e.includes("port_range"))).toBe(true);
    expect(errorsOf((c) => (c.env.X = "{port:Web}")).some((e) => e.includes("env.X"))).toBe(true);
    expect(errorsOf((c) => (c.env.X = "{port:db=99999}")).some((e) => e.includes("env.X"))).toBe(true);
  });
});

describe("argus-live config — expand", () => {
  it("substitutes an allocated port", () => {
    expect(expand("x{port:web}y", { ports: { web: 41001 } })).toBe("x41001y");
  });

  it("substitutes a fixed port and records it", () => {
    const ports: Record<string, number> = {};
    expect(expand("{port:db=5433}", { ports })).toBe("5433");
    expect(ports.db).toBe(5433);
    expect(expand("{port:db}", { ports })).toBe("5433");
  });

  it("refuses a port name that was not allocated", () => {
    expect(() => expand("{port:nope}", { ports: {} })).toThrow(/port nope/);
  });

  it("substitutes a secret, once (a value is never expanded again)", () => {
    expect(expand("${PW}", { secrets: { PW: "s" } })).toBe("s");
    expect(expand("x${PW}y", { secrets: { PW: "0" } })).toBe("x0y");
    expect(expand("a${PW}b{port:w}", { ports: { w: 1 }, secrets: { PW: "${X}{port:w}" } })).toBe("a${X}{port:w}b1");
  });

  it("an unset secret throws its name, never a value", () => {
    expect(() => expand("${NOPE}")).toThrow(/unset NOPE/);
    try {
      expand("${PW}:${NOPE}", { secrets: { PW: "hunter2" } });
      expect.unreachable();
    } catch (e) {
      expect(String((e as Error).message)).not.toContain("hunter2");
    }
  });

  it("an empty secret counts as unset", () => {
    expect(() => expand("${PW}", { secrets: { PW: "" } })).toThrow(/unset PW/);
  });

  it("expandConfig expands every string of the file, and only strings", () => {
    const ports: Record<string, number> = { api: 1, web: 2, pg: 3, redis: 4, smtp: 5 };
    const c = expandConfig(example(), { ports, secrets: { DB_PW: "d", PW: "p", SALES_TOTP: "t" } });
    expect(JSON.stringify(c)).not.toMatch(/\{port:|\$\{/);
    expect(c.start[2]).toMatchObject({ cmd: "npm run dev:web -- --port 2", env: { API_URL: "http://localhost:1" }, health: { url: "http://localhost:2/" } });
    expect(c.env.DATABASE_URL).toBe("postgres://app:d@localhost:3/app_explore");
    expect(c.roles.sales.users[0]).toEqual({ user: "sales1@example.test", password: "p", totp_secret: "t" });
    expect(c.facts.argv.at(-1)).toBe("{1}");
    expect(c.limits.max_cycle_minutes).toBe(45);
    expect(example().base_url).toBe("http://localhost:{port:web}");
  });

  it("leaves everything else alone", () => {
    expect(expand("{1} $HOME ${ not} {port:}", {})).toBe("{1} $HOME ${ not} {port:}");
  });
});

describe("argus-live config — parseEnvFile", () => {
  it("reads KEY=value lines with comments, blank lines and optional quotes", () => {
    const text = ["# a comment", "", "A=1", "  B = two  ", 'C="a b"', "D='x'", "export E=e", "F=f # trailing", 'G="h # not a comment"', 'I="q" # after', "not a line", "H="].join("\n");
    expect(parseEnvFile(text)).toEqual({ A: "1", B: "two", C: "a b", D: "x", E: "e", F: "f", G: "h # not a comment", I: "q", H: "" });
  });

  it("handles CRLF line ends", () => {
    expect(parseEnvFile("A=1\r\nB='2'\r\n")).toEqual({ A: "1", B: "2" });
  });
});

describe("argus-live config — loadLive", () => {
  const withLive = (live: unknown, env?: string) => {
    const main = tempDir();
    mkdirSync(join(main, ".argus"));
    writeFileSync(join(main, ".argus/live.json"), typeof live === "string" ? live : JSON.stringify(live));
    if (env !== undefined) writeFileSync(join(main, ".argus/live.env"), env);
    return main;
  };

  it("reads the config and its env_file", () => {
    const r = loadLive(withLive(example(), "PW=pw\nDB_PW=db\n"));
    expect(r.errors).toEqual([]);
    expect(r.config.store).toBe("app_explore");
    expect(r.secrets).toEqual({ PW: "pw", DB_PW: "db" });
  });

  it("reports a missing file, bad JSON and schema errors without throwing", () => {
    expect(loadLive(tempDir()).errors[0]).toMatch(/\.argus\/live\.json/);
    expect(loadLive(withLive("{nope")).errors[0]).toMatch(/not valid JSON/);
    expect(loadLive(withLive({ ...example(), reset: undefined }, "")).errors.some((e: string) => e.includes("reset"))).toBe(true);
  });

  it("reports a missing env_file, and one outside the repo", () => {
    expect(loadLive(withLive(example())).errors.some((e: string) => e.includes(".argus/live.env"))).toBe(true);
    for (const f of ["../live.env", "/etc/passwd", "."]) {
      expect(loadLive(withLive({ ...example(), env_file: f }, "")).errors.some((e: string) => e.includes(`env_file must be a path inside the repo: ${f}`)), f).toBe(true);
    }
  });

  it("refuses an env_file that is a symlink out of the repo, and reads one that stays inside", () => {
    const outside = tempDir();
    writeFileSync(join(outside, "live.env"), "PW=leak\n");
    const out = withLive(example());
    symlinkSync(join(outside, "live.env"), join(out, ".argus/live.env"));
    const r = loadLive(out);
    expect(r.errors.some((e: string) => e.includes("env_file") && e.includes("inside the repo"))).toBe(true);
    expect(r.secrets).toEqual({});
    const inside = withLive(example());
    writeFileSync(join(inside, ".argus/real.env"), "PW=ok\n");
    symlinkSync(join(inside, ".argus/real.env"), join(inside, ".argus/live.env"));
    expect(loadLive(inside)).toMatchObject({ errors: [], secrets: { PW: "ok" } });
  });

  it("follows a repo path reached through a symlinked parent (both sides are real paths)", () => {
    const real = withLive(example(), "PW=ok\n");
    const link = join(tempDir(), "repo-link");
    symlinkSync(real, link);
    expect(loadLive(link)).toMatchObject({ errors: [], secrets: { PW: "ok" } });
  });

  it("without env_file there are no secrets", () => {
    const c = example();
    delete c.env_file;
    const r = loadLive(withLive(c));
    expect(r.errors).toEqual([]);
    expect(r.secrets).toEqual({});
  });
});

describe("argus-live instance — lock, live log, renew", () => {
  const MAX = 45;
  const T0 = Date.UTC(2026, 9, 8, 9, 30, 0); // ms
  const S0 = T0 / 1000;
  const repo = () => {
    const main = tempDir();
    execFileSync("git", ["init", "-q", main]);
    return main;
  };
  const logOf = (main: string) => readFileSync(join(main, ".git/sapu-live.log"), "utf8");
  const lockOf = (main: string) => JSON.parse(readFileSync(join(main, ".argus/live/lock.json"), "utf8"));

  /** The awk program of sapu-merge.sh's live_overlap, read out of the script itself. */
  const overlapAwk = () => {
    const lines = readFileSync(join(__dirname, "../plugins/sapu/scripts/sapu-merge.sh"), "utf8").split("\n");
    const open = `awk -v s="$1" -v e="$2" '`;
    const at = lines.findIndex((l) => l.trim() === open);
    expect(at, "live_overlap's awk line").toBeGreaterThan(-1);
    const body: string[] = [];
    for (const l of lines.slice(at + 1)) {
      const q = l.indexOf("'");
      if (q >= 0) {
        body.push(l.slice(0, q));
        break;
      }
      body.push(l);
    }
    return body.join("\n");
  };
  const overlaps = (main: string, s: number, e: number) => {
    const awk = existsSync("/usr/bin/awk") ? "/usr/bin/awk" : "awk";
    const r = spawnSync(awk, ["-v", `s=${s}`, "-v", `e=${e}`, overlapAwk(), join(main, ".git/sapu-live.log")], { encoding: "utf8" });
    expect(r.error).toBeUndefined();
    return r.status === 0;
  };

  it("takes the lock and appends one start line before anything else", () => {
    const main = repo();
    const l = takeLock(main, { maxCycleMinutes: MAX, now: T0 });
    expect(l.runId).toMatch(/^20261008093000-[0-9a-f]{8}$/);
    expect(l.start).toBe(S0);
    expect(l.deadline).toBe(S0 + MAX * 60 + 900);
    expect(l.stale).toBeUndefined();
    expect(lockOf(main)).toEqual({ runId: l.runId, start: l.start, deadline: l.deadline });
    expect(readLock(main)).toEqual({ runId: l.runId, start: l.start, deadline: l.deadline });
    const lines = logOf(main).split("\n").filter(Boolean);
    expect(lines).toEqual([`${l.runId} start ${S0} deadline ${S0 + MAX * 60 + 900}`]);
    expect(lines[0]).toMatch(/^\d{14}-[0-9a-f]{8} start \d{9,10} deadline \d{9,10}$/);
  });

  it("run ids are unique", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const main = repo();
      ids.add(takeLock(main, { maxCycleMinutes: MAX, now: T0 }).runId);
    }
    expect(ids.size).toBe(20);
  });

  it("refuses while another cycle's deadline has not passed, naming its run and deadline", () => {
    const main = repo();
    const first = takeLock(main, { maxCycleMinutes: MAX, now: T0 });
    const until = new Date(first.deadline * 1000).toISOString();
    expect(() => takeLock(main, { maxCycleMinutes: MAX, now: T0 + 60_000 })).toThrow(`refused: cycle ${first.runId} holds the lock until ${until}`);
    expect(lockOf(main).runId).toBe(first.runId);
    expect(logOf(main).trim().split("\n")).toHaveLength(1);
  });

  /** A lock file as another run would have left it. */
  const plant = (main: string, lock: { runId: string; start: number; deadline: number }) => {
    mkdirSync(join(main, ".argus/live"), { recursive: true });
    writeFileSync(join(main, ".argus/live/lock.json"), `${JSON.stringify(lock)}\n`);
    return lock;
  };
  const OLD = { runId: "20261008080000-0badc0de", start: S0 - 7200, deadline: S0 - 60 };
  const FRESH = { runId: "20261008092900-feedf00d", start: S0 - 60, deadline: S0 + 3600 };
  const claimOf = (main: string, runId: string) => join(main, ".argus/live", `claim-${runId}.json`);
  const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid!;

  it("a lock past its deadline is returned as stale, and its claim is kept as the record for recovery", () => {
    const main = repo();
    plant(main, OLD);
    const l = takeLock(main, { maxCycleMinutes: MAX, now: T0 });
    expect(l.stale).toEqual(OLD);
    expect(lockOf(main).runId).toBe(l.runId);
    expect(JSON.parse(readFileSync(claimOf(main, OLD.runId), "utf8"))).toMatchObject({ lock: OLD, by: l.runId });
    expect(readdirLive(main)).toEqual([`claim-${OLD.runId}.json`, "lock.json"]);
    expect(logOf(main).trim().split("\n")).toEqual([`${l.runId} start ${l.start} deadline ${l.deadline}`]);
  });

  it("refuses an unreadable lock instead of recovering it", () => {
    const main = repo();
    mkdirSync(join(main, ".argus/live"), { recursive: true });
    writeFileSync(join(main, ".argus/live/lock.json"), "{half");
    expect(() => takeLock(main, { maxCycleMinutes: MAX, now: T0 })).toThrow(/refused: .*lock\.json/);
    expect(existsSync(join(main, ".git/sapu-live.log"))).toBe(false);
    expect(readdirLive(main)).toEqual(["lock.json"]);
  });

  it("refuses a lock whose times are out of range, and limits.max_cycle_minutes beyond a day", () => {
    for (const bad of [{ ...OLD, start: 1e300 }, { ...OLD, deadline: 12 }, { ...OLD, deadline: OLD.start - 1 }]) {
      const main = repo();
      plant(main, bad);
      expect(() => readLock(main)).toThrow(/^refused: /);
      expect(() => takeLock(main, { maxCycleMinutes: MAX, now: T0 })).toThrow(/^refused: /);
    }
    for (const max of [0, 1441, 1e300, 1.5]) expect(() => takeLock(repo(), { maxCycleMinutes: max, now: T0 })).toThrow(/^refused: limits\.max_cycle_minutes/);
    expect(() => takeLock(repo(), { maxCycleMinutes: MAX, now: 1e300 })).toThrow(/^refused: /);
  });

  describe("races, replayed step by step", () => {
    it("the lock vanishes between the failed link and the read: take it fresh", () => {
      const main = repo();
      plant(main, FRESH);
      const l = takeLock(main, { maxCycleMinutes: MAX, now: T0, pause: (s: string) => s === "exists" && rmSync(join(main, ".argus/live/lock.json")) });
      expect(l.stale).toBeUndefined();
      expect(lockOf(main).runId).toBe(l.runId);
    });

    it("another taker claimed the stale run and already replaced the lock: refuse, naming the new run", () => {
      const main = repo();
      plant(main, OLD);
      const pause = (s: string) => {
        if (s !== "stale") return;
        writeFileSync(claimOf(main, OLD.runId), JSON.stringify({ lock: OLD, by: FRESH.runId, pid: process.pid }));
        plant(main, FRESH);
      };
      expect(() => takeLock(main, { maxCycleMinutes: MAX, now: T0, pause })).toThrow(`refused: cycle ${FRESH.runId} holds the lock until`);
      expect(lockOf(main)).toEqual(FRESH);
    });

    it("another taker holds the claim and is still at work: refuse, never touch the lock", () => {
      const main = repo();
      plant(main, OLD);
      writeFileSync(claimOf(main, OLD.runId), JSON.stringify({ lock: OLD, by: FRESH.runId, pid: process.pid }));
      expect(() => takeLock(main, { maxCycleMinutes: MAX, now: T0 })).toThrow(new RegExp(`refused: cycle ${OLD.runId}'s lock is being changed by process ${process.pid}`));
      expect(lockOf(main)).toEqual(OLD);
    });

    it("a claim whose process is gone: refuse, naming the file to remove", () => {
      const main = repo();
      plant(main, OLD);
      const pid = deadPid();
      writeFileSync(claimOf(main, OLD.runId), JSON.stringify({ lock: OLD, by: FRESH.runId, pid }));
      expect(() => takeLock(main, { maxCycleMinutes: MAX, now: T0 })).toThrow(`interrupted (process ${pid} is gone); remove ${claimOf(main, OLD.runId)}`);
      expect(lockOf(main)).toEqual(OLD);
    });

    it("the stale lock was removed after we claimed it: drop the claim and take the lock fresh", () => {
      const main = repo();
      plant(main, OLD);
      const l = takeLock(main, { maxCycleMinutes: MAX, now: T0, pause: (s: string) => s === "claimed" && rmSync(join(main, ".argus/live/lock.json")) });
      expect(l.stale).toBeUndefined();
      expect(lockOf(main).runId).toBe(l.runId);
      expect(existsSync(claimOf(main, OLD.runId))).toBe(false);
    });

    it("the stale lock was replaced by a fresh one after we claimed it: never overwrite it", () => {
      const main = repo();
      plant(main, OLD);
      expect(() => takeLock(main, { maxCycleMinutes: MAX, now: T0, pause: (s: string) => s === "claimed" && plant(main, FRESH) })).toThrow(`refused: cycle ${FRESH.runId} holds the lock`);
      expect(lockOf(main)).toEqual(FRESH);
      expect(existsSync(claimOf(main, OLD.runId))).toBe(false);
    });

    it("the live log cannot be written: the lock is rolled back", () => {
      const main = repo();
      mkdirSync(join(main, ".git/sapu-live.log"));
      expect(() => takeLock(main, { maxCycleMinutes: MAX, now: T0 })).toThrow(/^refused: cannot append to .*sapu-live\.log/);
      expect(existsSync(join(main, ".argus/live/lock.json"))).toBe(false);
      expect(readdirLive(main)).toEqual([]);
    });
  });

  it("concurrent takers: exactly one wins, it alone gets the stale record, and no fresh lock is removed", async () => {
    const mod = join(__dirname, "../plugins/sapu/scripts/argus-live-instance.mjs");
    const code = `
      import { takeLock } from ${JSON.stringify(pathToFileURL(mod).href)};
      const [main, at] = process.argv.slice(1);
      while (Date.now() < Number(at)) {}
      try { console.log(JSON.stringify({ ok: takeLock(main, { maxCycleMinutes: 45 }) })); }
      catch (e) { console.log(JSON.stringify({ err: e.message })); }`;
    const once = (main: string, at: number) =>
      new Promise<{ ok?: { runId: string; stale?: unknown }; err?: string }>((done, fail) => {
        const p = spawn(process.execPath, ["--input-type=module", "-e", code, main, String(at)]);
        let out = "";
        p.stdout.on("data", (d) => (out += d));
        p.on("error", fail);
        p.on("close", () => done(JSON.parse(out)));
      });
    for (const n of [2, 4, 8, 8, 8]) {
      const main = repo();
      const now = Math.floor(Date.now() / 1000);
      const old = plant(main, { ...OLD, start: now - 7200, deadline: now - 1 });
      const at = Date.now() + 500;
      const results = await Promise.all(Array.from({ length: n }, () => once(main, at)));
      const won = results.filter((r) => r.ok);
      expect(won, JSON.stringify(results)).toHaveLength(1);
      expect(won[0].ok!.stale).toEqual(old);
      for (const r of results.filter((x) => !x.ok)) expect(r.err).toMatch(/^refused: /);
      expect(lockOf(main).runId).toBe(won[0].ok!.runId);
      expect(logOf(main).trim().split("\n")).toHaveLength(1);
      expect(JSON.parse(readFileSync(claimOf(main, old.runId), "utf8")).by).toBe(won[0].ok!.runId);
    }
  }, 30_000);

  it("renew moves the deadline by max_cycle_minutes, appends it, and stops at start + 3 x max + 15 min", () => {
    const main = repo();
    const l = takeLock(main, { maxCycleMinutes: MAX, now: T0 });
    const d1 = renew(main, { runId: l.runId, maxCycleMinutes: MAX, now: T0 + 60_000 });
    expect(d1).toBe(l.deadline + MAX * 60);
    expect(lockOf(main)).toEqual({ runId: l.runId, start: l.start, deadline: d1 });
    const d2 = renew(main, { runId: l.runId, maxCycleMinutes: MAX, now: T0 + 120_000 });
    expect(d2).toBe(S0 + 3 * MAX * 60 + 900);
    expect(() => renew(main, { runId: l.runId, maxCycleMinutes: MAX, now: T0 + 180_000 })).toThrow(/cap reached/);
    expect(logOf(main).trim().split("\n").slice(1)).toEqual([`${l.runId} deadline ${d1}`, `${l.runId} deadline ${d2}`]);
    expect(readdirLive(main)).toEqual(["lock.json"]);
  });

  it("a short cycle can still renew: the cap carries the same 15 min grace", () => {
    const main = repo();
    const l = takeLock(main, { maxCycleMinutes: 5, now: T0 });
    expect(renew(main, { runId: l.runId, maxCycleMinutes: 5, now: T0 + 1000 })).toBe(S0 + 300 + 900 + 300);
    expect(renew(main, { runId: l.runId, maxCycleMinutes: 5, now: T0 + 2000 })).toBe(S0 + 3 * 300 + 900);
    expect(() => renew(main, { runId: l.runId, maxCycleMinutes: 5, now: T0 + 3000 })).toThrow(/cap reached/);
  });

  it("renew refuses with no lock, once the deadline has passed, and for another run's lock", () => {
    expect(() => renew(repo(), { runId: OLD.runId, maxCycleMinutes: MAX, now: T0 })).toThrow(/no lock/);
    const main = repo();
    const l = takeLock(main, { maxCycleMinutes: MAX, now: T0 });
    expect(() => renew(main, { runId: l.runId, maxCycleMinutes: MAX, now: l.deadline * 1000 })).toThrow(/deadline .* passed/);
    expect(() => renew(main, { runId: OLD.runId, maxCycleMinutes: MAX, now: T0 + 1000 })).toThrow(`refused: the lock names cycle ${l.runId}, not ${OLD.runId}`);
    expect(lockOf(main).deadline).toBe(l.deadline);
    expect(() => renew(main, { runId: "nope", maxCycleMinutes: MAX, now: T0 })).toThrow(/run id/);
  });

  it("renew never overwrites a lock that changed under it, nor one being changed", () => {
    const main = repo();
    const l = takeLock(main, { maxCycleMinutes: MAX, now: T0 });
    const pause = (s: string) => s === "claimed" && plant(main, FRESH);
    expect(() => renew(main, { runId: l.runId, maxCycleMinutes: MAX, now: T0 + 1000, pause })).toThrow(/^refused: the lock changed/);
    expect(lockOf(main)).toEqual(FRESH);
    expect(logOf(main).trim().split("\n")).toHaveLength(1);
    expect(existsSync(claimOf(main, l.runId))).toBe(false);

    const busy = repo();
    const b = takeLock(busy, { maxCycleMinutes: MAX, now: T0 });
    writeFileSync(claimOf(busy, b.runId), JSON.stringify({ pid: process.pid }));
    expect(() => renew(busy, { runId: b.runId, maxCycleMinutes: MAX, now: T0 + 1000 })).toThrow(/being changed/);
    expect(lockOf(busy).deadline).toBe(b.deadline);
    expect(existsSync(claimOf(busy, b.runId))).toBe(true);
  });

  it("appendEnd appends an end line, and refuses a malformed run id", () => {
    const main = repo();
    const l = takeLock(main, { maxCycleMinutes: MAX, now: T0 });
    appendEnd(main, l.runId, T0 + 5_000);
    expect(logOf(main).trim().split("\n")[1]).toBe(`${l.runId} end ${S0 + 5}`);
    expect(() => appendEnd(main, "x end 1\nother", T0)).toThrow(/run id/);
  });

  it("seam: live_overlap sees a renewed run up to its latest deadline, and a run up to its end", () => {
    const main = repo();
    const l = takeLock(main, { maxCycleMinutes: MAX, now: T0 });
    const d2 = renew(main, { runId: l.runId, maxCycleMinutes: MAX, now: T0 + 60_000 });
    expect(overlaps(main, l.deadline + 10, l.deadline + 20)).toBe(true);
    expect(overlaps(main, d2 + 10, d2 + 20)).toBe(false);
    expect(overlaps(main, S0 - 20, S0 - 10)).toBe(false);
    appendEnd(main, l.runId, T0 + 120_000);
    expect(overlaps(main, S0 + 60, S0 + 70)).toBe(true);
    expect(overlaps(main, S0 + 130, S0 + 140)).toBe(false);
  });
});

const readdirLive = (main: string) => readdirSync(join(main, ".argus/live")).sort();

describe("argus-live instance — ports", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))));
  });
  /** Listen on `port` (0 = any) at `host`; the port, or null when it cannot. */
  const hold = (port: number, host = "127.0.0.1") =>
    new Promise<number | null>((done) => {
      const s = createServer();
      s.once("error", () => done(null));
      s.listen({ port, host, exclusive: true }, () => {
        servers.push(s);
        done((s.address() as { port: number }).port);
      });
    });
  const freeNow = (port: number) =>
    new Promise<boolean>((done) => {
      const s = createServer();
      s.once("error", () => done(false));
      s.listen({ port, host: "127.0.0.1", exclusive: true }, () => s.close(() => done(true)));
    });
  /** `n` consecutive ports free right now, from a high range few things use. */
  const freeRun = async (n: number) => {
    for (let base = 47000 + Math.floor(Math.random() * 1000); base < 49000; base += n) {
      const all = await Promise.all(Array.from({ length: n }, (_, i) => freeNow(base + i)));
      if (all.every(Boolean)) return base;
    }
    throw new Error("no free run of ports");
  };
  const haveTool = (t: string) => spawnSync(t, ["-v"]).error === undefined || spawnSync("which", [t]).status === 0;

  it("collects every {port:<name>} of the spec example, in order, and the fixed ones apart", () => {
    expect(portNames(example())).toEqual({ names: ["api", "web", "pg", "redis", "smtp"], fixed: {} });
    const c = example();
    c.env.PG_PORT = "{port:pg=5433}";
    expect(portNames(c)).toEqual({ names: ["api", "web", "redis", "smtp"], fixed: { pg: 5433 } });
    c.env.OTHER = "{port:pg=5440}";
    expect(() => portNames(c)).toThrow(/refused: port pg is fixed at both 5433 and 5440/);
    c.env.OTHER = "{port:cache=5433}";
    expect(() => portNames(c)).toThrow(/refused: port 5433 is fixed for both pg and cache/);
  });

  it("refuses, rather than crashing, with no range for a name, or one port fixed twice", async () => {
    await expect(allocatePorts(["web"], {})).rejects.toThrow("refused: port_range is required for {port:web}");
    const p = await freeRun(1);
    await expect(allocatePorts([], { fixed: { a: p, b: p } })).rejects.toThrow(`refused: port ${p} is fixed for both a and b`);
    expect(await allocatePorts([], { fixed: { a: p } })).toEqual({ a: p });
  });

  it("a port held by a listener, or answering on ::1 only, is not free", async () => {
    const p = (await hold(0))!;
    expect(await portFree(p)).toBe(false);
    const base = await freeRun(1);
    expect(await portFree(base)).toBe(true);
    const v6 = await hold(base, "::1");
    if (v6) expect(await portFree(base)).toBe(false);
  });

  it("allocation skips reserved ports and taken ones, and gives each name its own port", async () => {
    const base = await freeRun(4);
    await hold(base);
    const got = await allocatePorts(["web", "api"], { range: [base, base + 3], reserved: [base + 1] });
    expect(new Set(Object.values(got))).toEqual(new Set([base + 2, base + 3]));
    expect(Object.keys(got).sort()).toEqual(["api", "web"]);
  });

  it("a free fixed port is used as written; a reserved one is refused", async () => {
    const base = await freeRun(2);
    expect(await allocatePorts(["web"], { range: [base, base], fixed: { db: base + 1 } })).toEqual({ web: base, db: base + 1 });
    await expect(allocatePorts([], { range: [base, base], reserved: [base + 1], fixed: { db: base + 1 } })).rejects.toThrow(`refused: port ${base + 1} (db) is one of reserved_ports`);
  });

  it("a taken fixed port is refused, naming the process holding it", async () => {
    const p = (await hold(0))!;
    const err = allocatePorts([], { range: [p, p], fixed: { db: p } });
    if (haveTool("lsof") || haveTool("ss")) await expect(err).rejects.toThrow(new RegExp(`^refused: port ${p} \\(db\\) is taken by .*pid ${process.pid}\\b`));
    else await expect(err).rejects.toThrow(`refused: port ${p} (db) is taken by unknown`);
  });

  it("an exhausted range is refused, naming the port that found no room", async () => {
    const p = (await hold(0))!;
    await expect(allocatePorts(["web"], { range: [p, p] })).rejects.toThrow(`refused: no free port in ${p}-${p} for web`);
    await expect(allocatePorts(["web"], { range: [p + 1, p + 1], reserved: [p + 1] })).rejects.toThrow(/refused: no free port/);
  });

  it("the holder comes from lsof, else ss, else is unknown", () => {
    const lsof = (argv: string[]) => (argv[0] === "lsof" ? { status: 0, stdout: "p4242\ncpostgres\np4343\ncpostgres\n" } : { error: Object.assign(new Error("x"), { code: "ENOENT" }) });
    expect(portHolder(5432, { runner: lsof })).toBe("postgres (pid 4242), postgres (pid 4343)");
    const ss = (argv: string[]) =>
      argv[0] === "ss" ? { status: 0, stdout: 'LISTEN 0 511 127.0.0.1:5432 0.0.0.0:* users:(("redis-server",pid=77,fd=6))\n' } : { error: Object.assign(new Error("x"), { code: "ENOENT" }) };
    expect(portHolder(5432, { runner: ss })).toBe("redis-server (pid 77)");
    expect(portHolder(5432, { runner: () => ({ error: Object.assign(new Error("x"), { code: "ENOENT" }) }) })).toBe("unknown");
    expect(portHolder(5432, { runner: () => ({ status: 1, stdout: "" }) })).toBe("unknown");
  });
});

describe("argus-live instance — worktree, environment, setup", () => {
  const saved = { ...process.env };
  let tmp = "";
  beforeEach(() => {
    // Every worktree and HOME goes under $TMPDIR/sapu-live: a private TMPDIR per test.
    tmp = tempDir();
    process.env.TMPDIR = tmp;
  });
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    for (const [k, v] of Object.entries(saved)) if (process.env[k] !== v) process.env[k] = v;
  });
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  /** A repo with one commit, an ignored `.env` in its working tree. */
  const committed = () => {
    const main = tempDir();
    git(main, "init", "-q");
    writeFileSync(join(main, ".gitignore"), ".env\n");
    writeFileSync(join(main, "app.txt"), "app\n");
    git(main, "add", ".");
    git(main, "-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", "commit", "-qm", "init");
    writeFileSync(join(main, ".env"), "SECRET=owner\n");
    return main;
  };
  const runId = () => `20261008093000-${Math.random().toString(16).slice(2, 10).padEnd(8, "0")}`;
  const inside = (root: string, p: string) => {
    const r = relative(realpathSync(root), realpathSync(p));
    return r === "" || (!r.startsWith("..") && !r.startsWith("/"));
  };
  const later = (s: number) => Math.floor(Date.now() / 1000) + s;
  const PATH = () => ({ PATH: process.env.PATH! });
  const setup = (wt: string, steps: string[][], opts: Record<string, unknown> = {}) => runSetup(wt, { setup: steps }, PATH(), { deadline: later(600), ...opts });
  const node = (code: string) => [process.execPath, "-e", code];
  const link = (target: string, at: string) =>
    node(`const fs = require('fs'); fs.mkdirSync(require('path').dirname(${JSON.stringify(at)}), { recursive: true }); fs.symlinkSync(${JSON.stringify(target)}, ${JSON.stringify(at)})`);

  it("makes a detached worktree at HEAD outside the repo, without the repo's ignored files", async () => {
    const main = committed();
    const id = runId();
    const wt = makeWorktree(main, id);
    expect(wt).toBe(realpathSync(wt));
    expect(wt).toBe(join(realpathSync(tmp), "sapu-live", `${basename(main)}-${id}`));
    expect(inside(main, wt)).toBe(false);
    expect(git(wt, "rev-parse", "HEAD")).toBe(git(main, "rev-parse", "HEAD"));
    expect(readFileSync(join(wt, "app.txt"), "utf8")).toBe("app\n");
    expect(existsSync(join(wt, ".env"))).toBe(false);
    expect(statSync(join(tmp, "sapu-live")).mode & 0o777).toBe(0o700);
    expect(() => makeWorktree(main, "../x")).toThrow(/run id/);
  });

  it("tightens an existing sapu-live directory to 0700", async () => {
    mkdirSync(join(tmp, "sapu-live"), { mode: 0o755 });
    chmodSync(join(tmp, "sapu-live"), 0o755);
    makeHome(committed(), runId());
    expect(statSync(join(tmp, "sapu-live")).mode & 0o777).toBe(0o700);
  });

  it("refuses a sapu-live that is a symlink (it could lead into the repo), and a TMPDIR inside the repo", async () => {
    const main = committed();
    mkdirSync(join(main, "inside"));
    symlinkSync(join(main, "inside"), join(tmp, "sapu-live"));
    expect(() => makeWorktree(main, runId())).toThrow(/^refused: .*sapu-live is a symlink/);
    expect(() => makeHome(main, runId())).toThrow(/^refused: .*sapu-live is a symlink/);
    expect(readdirSync(join(main, "inside"))).toEqual([]);
    process.env.TMPDIR = join(main, "inside");
    expect(() => makeWorktree(main, runId())).toThrow(/^refused: .* would lie inside the repo/);
    expect(() => makeHome(main, runId())).toThrow(/^refused: .* would lie inside the repo/);
  });

  it("makes an empty per-run HOME beside the worktree, outside the repo, mode 0700", async () => {
    const main = committed();
    const id = runId();
    const home = makeHome(main, id);
    expect(home).toBe(join(realpathSync(tmp), "sapu-live", `${basename(main)}-${id}.home`));
    expect(inside(main, home)).toBe(false);
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(readdirSync(home)).toEqual([]);
    writeFileSync(join(home, ".npmrc"), "x");
    expect(() => makeHome(main, id)).toThrow(/^refused: .*\.home is not empty/);
  });

  it("refuses a HOME path that is already a symlink", async () => {
    const main = committed();
    const id = runId();
    mkdirSync(join(tmp, "sapu-live"), { mode: 0o700 });
    symlinkSync(main, join(tmp, "sapu-live", `${basename(main)}-${id}.home`));
    expect(() => makeHome(main, id)).toThrow(/^refused: .*\.home is a symlink/);
  });

  it("a setup may link into the run's own HOME", async () => {
    const main = committed();
    const id = runId();
    const wt = makeWorktree(main, id);
    const home = makeHome(main, id);
    writeFileSync(join(home, "python"), "");
    await expect(setup(wt, [link(join(home, "python"), ".venv/bin/python")])).resolves.toBeUndefined();
  });

  it("the environment holds only the listed variables, the expanded env, the run's Compose project and HOME", async () => {
    process.env.ARGUS_TEST_LEAK = "1";
    process.env.ARGUS_PASS = "passed";
    process.env.LC_ARGUS_TEST = "C";
    const id = runId();
    const config = { env: { DATABASE_URL: "postgres://app:${DB_PW}@localhost:{port:pg}/app_explore" }, pass_env: ["ARGUS_PASS", "ARGUS_NOT_SET"] };
    const env = instanceEnv({ config, ports: { pg: 41001 }, secrets: { DB_PW: "pw" }, runId: id, home: "/h" });
    const base = ["PATH", "USER", "SHELL", "TMPDIR", "LANG"].filter((k) => process.env[k] !== undefined);
    const lc = Object.keys(process.env).filter((k) => k.startsWith("LC_"));
    expect(Object.keys(env).sort()).toEqual([...base, ...lc, "ARGUS_PASS", "DATABASE_URL", "COMPOSE_PROJECT_NAME", "HOME"].sort());
    expect(env).toMatchObject({ ARGUS_PASS: "passed", DATABASE_URL: "postgres://app:pw@localhost:41001/app_explore", COMPOSE_PROJECT_NAME: `argus-${id}`, HOME: "/h", LC_ARGUS_TEST: "C" });
    expect(env.COMPOSE_PROJECT_NAME).toMatch(/^[a-z0-9_-]+$/);
    expect(env).not.toHaveProperty("ARGUS_TEST_LEAK");
  });

  it("refuses env or pass_env naming HOME or COMPOSE_PROJECT_NAME, and an unset secret", async () => {
    const args = (config: object) => ({ config, ports: {}, secrets: {}, runId: runId(), home: "/h" });
    for (const k of ["HOME", "COMPOSE_PROJECT_NAME"]) {
      expect(() => instanceEnv(args({ env: { [k]: "x" } }))).toThrow(`refused: env may not set ${k}`);
      expect(() => instanceEnv(args({ pass_env: [k] }))).toThrow(`refused: pass_env may not name ${k}`);
    }
    expect(() => instanceEnv(args({ env: { A: "${NOPE}" } }))).toThrow(/unset NOPE/);
  });

  it("setup runs each argv in the worktree under that environment, without a shell", async () => {
    process.env.ARGUS_TEST_LEAK = "1";
    const main = committed();
    const id = runId();
    const wt = makeWorktree(main, id);
    const home = makeHome(main, id);
    const env = instanceEnv({ config: {}, ports: {}, secrets: {}, runId: id, home });
    const dump = "require('fs').writeFileSync('env.json', JSON.stringify({ cwd: process.cwd(), env: process.env }))";
    await runSetup(wt, { setup: [node(dump), node("require('fs').writeFileSync('$NOT_EXPANDED', '')")] }, env, { deadline: later(600) });
    const seen = JSON.parse(readFileSync(join(wt, "env.json"), "utf8"));
    expect(seen.cwd).toBe(wt);
    expect(seen.env).toMatchObject({ COMPOSE_PROJECT_NAME: `argus-${id}`, HOME: home });
    expect(seen.env).not.toHaveProperty("ARGUS_TEST_LEAK");
    expect(existsSync(join(wt, "$NOT_EXPANDED"))).toBe(true);
  });

  it("a failing setup step is reported with its own error, every secret value masked", async () => {
    const wt = makeWorktree(committed(), runId());
    await expect(setup(wt, [node("console.error('boom'); process.exit(3)")])).rejects.toThrow(/^failed: setup .* exited 3: boom/);
    const leak = node("console.log('url postgres://app:hunter2@localhost/x'); console.error('token s3cr3t-value and hunter2'); process.exit(1)");
    let msg = "";
    try {
      await setup(wt, [[...leak.slice(0, 2), `${leak[2]} // hunter2`]], { secrets: { PW: "hunter2", TOKEN: "s3cr3t-value", EMPTY: "" } });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/^failed: setup /);
    expect(msg).not.toContain("hunter2");
    expect(msg).not.toContain("s3cr3t-value");
    expect(msg).toContain("token *** and ***");
  });

  it("a setup step is bounded by the lock's deadline", async () => {
    const wt = makeWorktree(committed(), runId());
    const t0 = Date.now();
    await expect(setup(wt, [node("setTimeout(() => {}, 20000)")], { deadline: later(2) })).rejects.toThrow(/^failed: setup .* timed out/);
    expect(Date.now() - t0).toBeLessThan(10_000);
    await expect(setup(wt, [node("require('fs').writeFileSync('ran', '')")], { deadline: later(-1) })).rejects.toThrow(/^failed: setup .* timed out/);
    expect(existsSync(join(wt, "ran"))).toBe(false);
    await expect(runSetup(wt, { setup: [] }, PATH(), {})).rejects.toThrow(/deadline/);
  });

  describe("setup in its own process group", () => {
    const gone = (pid: number) => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    };
    const settle = async (pid: number) => {
      for (let i = 0; i < 40 && !gone(pid); i++) await new Promise((r) => setTimeout(r, 50));
      return gone(pid);
    };
    const parentWithChild = (exit: string) =>
      node(`const c = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' }); require('fs').writeFileSync('child.pid', String(c.pid)); ${exit}`);

    it("a timed-out setup with a grandchild leaves no process", async () => {
      const wt = makeWorktree(committed(), runId());
      const groups: { name: string; pgid: number }[] = [];
      await expect(setup(wt, [parentWithChild("setInterval(() => {}, 1 << 30)")], { deadline: later(2), groups })).rejects.toThrow(/timed out/);
      const child = Number(readFileSync(join(wt, "child.pid"), "utf8"));
      expect(await settle(child)).toBe(true);
      expect(groups).toEqual([expect.objectContaining({ name: "setup[0]", pgid: expect.any(Number) })]);
    });

    it("a failed setup with a grandchild leaves no process", async () => {
      const wt = makeWorktree(committed(), runId());
      await expect(setup(wt, [parentWithChild("process.exit(1)")])).rejects.toThrow(/exited 1/);
      expect(await settle(Number(readFileSync(join(wt, "child.pid"), "utf8")))).toBe(true);
    });

    it("a setup that leaves a daemon in its group succeeds, and its group stays recorded for down", async () => {
      const wt = makeWorktree(committed(), runId());
      const groups: { name: string; pgid: number }[] = [];
      await setup(wt, [parentWithChild("process.exit(0)")], { groups });
      const child = Number(readFileSync(join(wt, "child.pid"), "utf8"));
      try {
        expect(gone(child)).toBe(false);
        expect(groups).toHaveLength(1);
      } finally {
        process.kill(-groups[0].pgid, "SIGKILL");
      }
      expect(await settle(child)).toBe(true);
    });

    it("a setup argv that cannot start is reported", async () => {
      const wt = makeWorktree(committed(), runId());
      await expect(setup(wt, [["/no/such/tool"]])).rejects.toThrow(/^failed: setup \/no\/such\/tool: .*ENOENT/);
    });
  });

  it("after setup, a symlink into the main checkout is refused; one inside the worktree is fine", async () => {
    const main = committed();
    const wt = makeWorktree(main, runId());
    await setup(wt, [link(join(wt, "app.txt"), "node_modules/.bin/app"), link("../../app.txt", "node_modules/.bin/rel")]);
    await expect(setup(wt, [link(join(main, "node_modules"), "deps/node_modules")])).rejects.toThrow(`refused: ${join(wt, "deps/node_modules")} points into the main checkout`);
    rmSync(join(wt, "deps"), { recursive: true });
    await expect(setup(wt, [link(main, "up")])).rejects.toThrow(/points into the main checkout/);
  });

  describe("links the check must see through", () => {
    const refusedAfter = async (make: (main: string, wt: string) => string[]) => {
      const main = committed();
      const wt = makeWorktree(main, runId());
      await expect(setup(wt, [make(main, wt)])).rejects.toThrow(/points into the main checkout/);
    };
    it("a relative link", () => refusedAfter((main, wt) => link(relative(join(wt, "a"), join(main, "app.txt")), "a/rel")));
    it("a broken link to a missing file in the repo", () => refusedAfter((main) => link(join(main, "missing/deep/file"), "broken")));
    it("a chain through a broken link outside the worktree", () =>
      refusedAfter((main) => {
        const hop = tempDir();
        symlinkSync(join(main, "missing"), join(hop, "b"));
        return link(join(hop, "b"), "chain");
      }));
    it("a chain through a symlinked directory outside the worktree", () =>
      refusedAfter((main) => {
        const hop = tempDir();
        symlinkSync(main, join(hop, "dir"));
        return link(join(hop, "dir", "not-there"), "via-dir");
      }));
    it("a link to an ancestor of the repo", () => refusedAfter((main) => link(join(main, ".."), "parent")));
    it("a link to /", () => refusedAfter(() => link("/", "root")));
    it("a long missing tail under an alias of the repo", () =>
      refusedAfter((main) => {
        const hop = tempDir();
        symlinkSync(main, join(hop, "alias"));
        return link(join(hop, "alias", ...Array.from({ length: 60 }, (_, i) => `d${i}`)), "deep");
      }));

    const unresolved = async (make: (wt: string) => string[]) => {
      const main = committed();
      const wt = makeWorktree(main, runId());
      await expect(setup(wt, [make(wt)])).rejects.toThrow(/^refused: .* could not be resolved/);
    };
    it("a link loop fails closed", () => unresolved(() => node("const fs = require('fs'); fs.symlinkSync('b', 'a'); fs.symlinkSync('a', 'b')")));
    it("a chain longer than 40 links fails closed; 30 resolve", async () => {
      const chain = (n: number) => {
        const hop = realpathSync(tempDir());
        writeFileSync(join(hop, "end"), "");
        for (let i = n; i > 0; i--) symlinkSync(join(hop, i === n ? "end" : `l${i + 1}`), join(hop, `l${i}`));
        return join(hop, "l1");
      };
      await unresolved(() => link(chain(41), "long"));
      const main = committed();
      const wt = makeWorktree(main, runId());
      await expect(setup(wt, [link(chain(30), "ok")])).resolves.toBeUndefined();
    });
  });

  it("a missing TMPDIR is refused, not a raw error", async () => {
    const main = committed();
    process.env.TMPDIR = join(tmp, "gone");
    expect(() => makeWorktree(main, runId())).toThrow(/^refused: TMPDIR .*gone does not exist/);
  });

  it("a worktree found inside the repo after git added it is removed before refusing", async () => {
    const main = committed();
    const id = runId();
    const calls: string[][] = [];
    const runner = (argv: string[]) => {
      calls.push(argv);
      if (argv[3] === "worktree" && argv[4] === "add") symlinkSync(main, argv[6]);
      return { status: 0, stdout: "", stderr: "" };
    };
    expect(() => makeWorktree(main, id, { runner })).toThrow(/^refused: the worktree .* lies inside the repo/);
    const wt = join(realpathSync(tmp), "sapu-live", `${basename(main)}-${id}`);
    expect(calls.at(-1)).toEqual(["git", "-C", main, "worktree", "remove", "--force", wt]);
  });
});

describe("argus-live instance — processes, health, store", () => {
  const SERVER = join(__dirname, "fixtures/journey-app/server.mjs");
  const app = (args = "") => `${JSON.stringify(process.execPath)} ${JSON.stringify(SERVER)}${args ? ` ${args}` : ""}`;
  const groups: { name: string; pgid: number }[] = [];
  const servers: Server[] = [];
  afterEach(async () => {
    for (const g of groups.splice(0)) {
      try {
        process.kill(-g.pgid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))));
  });
  const freePort = () =>
    new Promise<number>((done) => {
      const s = createServer();
      s.listen(0, "127.0.0.1", () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => done(p));
      });
    });
  const serve = () =>
    new Promise<number>((done) => {
      const s = createServer((c) => c.end("HTTP/1.1 200 OK\r\nconnection: close\r\ncontent-length: 0\r\n\r\n", () => c.destroy()));
      s.listen(0, "127.0.0.1", () => {
        servers.push(s);
        done((s.address() as { port: number }).port);
      });
    });
  /** A worktree stand-in, a MAIN with an env file, and an expanded config for the fixture app. */
  const world = async (over: Record<string, unknown> = {}) => {
    const wt = tempDir();
    const main = tempDir();
    const data = join(tempDir(), "app_explore");
    const [store, web] = [await freePort(), await freePort()];
    const ev = (name: string) => `echo ${name} >> events; `;
    const config = {
      store: "app_explore",
      store_check: `${ev("check")}${app("--which-store")}`,
      reset: `${ev("reset")}${app("--reset")}`,
      start: [
        { name: "web", cmd: `${ev("web")}exec ${app()}`, env: { PORT: String(web) }, health: { url: `http://127.0.0.1:${web}/health` } },
        { name: "backing", phase: "store", cmd: `${ev("backing")}exec ${app()}`, env: { PORT: String(store) }, health: { url: `http://127.0.0.1:${store}/health` } },
      ],
      ...over,
    };
    const env = { PATH: process.env.PATH!, DATA_DIR: data, CACHE_URL: `tcp://127.0.0.1:${store}` };
    const ctx = { config, env, worktree: wt, main, contract: null, secrets: {}, logs: join(wt, "logs"), groups, timeoutS: 20, deadline: Math.floor(Date.now() / 1000) + 600 };
    return { wt, main, data, ctx, events: () => (existsSync(join(wt, "events")) ? readFileSync(join(wt, "events"), "utf8").trim().split("\n") : []) };
  };

  it("brings up the store phase first, checks the store, resets, then the rest, then checks again", async () => {
    const w = await world();
    mkdirSync(w.data, { recursive: true });
    writeFileSync(join(w.data, "sentinel"), "");
    await bringUpStore(w.ctx);
    expect(w.events()).toEqual(["backing", "check", "reset"]);
    expect(readdirSync(w.data)).toEqual(["seed.json"]);
    await bringUpRest(w.ctx);
    expect(w.events()).toEqual(["backing", "check", "reset", "web", "check"]);
    expect(groups.map((g) => g.name)).toEqual(["backing", "reset", "web"]);
    expect(readFileSync(join(w.ctx.logs, "web.log"), "utf8")).toMatch(/listening on/);
  });

  it("a store_check printing another store is refused, and reset never runs", async () => {
    const w = await world();
    w.ctx.config.store_check = "echo app_dev";
    mkdirSync(w.data, { recursive: true });
    writeFileSync(join(w.data, "sentinel"), "");
    await expect(bringUpStore(w.ctx)).rejects.toThrow('refused: store_check printed "app_dev", not the store "app_explore"');
    expect(w.events()).toEqual(["backing"]);
    expect(existsSync(join(w.data, "sentinel"))).toBe(true);
  });

  it("an env URL equal to one in the repo's env files is refused, naming the key and never the value", async () => {
    const w = await world();
    writeFileSync(join(w.main, ".env"), "REDIS_URL=redis://localhost:6379/0\n");
    const env = { ...w.ctx.env, CACHE: "redis://localhost:6379/0" };
    const err = checkStore({ ...w.ctx, env }).catch((e: Error) => e.message);
    expect(await err).toBe("refused: env.CACHE equals a value in the repo's env files (.env, .env.local); it would reach the owner's service");
    writeFileSync(join(w.main, ".env.production"), "X=redis://localhost:7000\n");
    const prod = await checkStore({ ...w.ctx, env: { ...w.ctx.env, C: "redis://localhost:7000" }, contract: { guard: { envFiles: [".env.production"], postgres: null } } }).catch((e: Error) => e.message);
    expect(prod).toMatch(/^refused: env\.C equals a value in the repo's env files/);
    await expect(checkStore(w.ctx)).resolves.toBeUndefined();
  });

  it("an env URL naming a database or port guard.postgres protects is refused", async () => {
    const w = await world();
    const contract = { guard: { envFiles: [], postgres: { ports: [6543, 5432], databases: ["app_dev"] } } };
    const refused = (v: string) => checkStore({ ...w.ctx, contract, env: { ...w.ctx.env, DATABASE_URL: v } }).then(() => "ok", (e: Error) => e.message);
    expect(await refused("postgres://app:pw@localhost:6543/app_explore")).toMatch(/^refused: env\.DATABASE_URL names port 6543/);
    expect(await refused("postgresql://app@localhost:41001/app_dev")).toMatch(/^refused: env\.DATABASE_URL names database app_dev/);
    expect(await refused("postgresql://app@localhost:41001/app%5Fdev")).toMatch(/names database app_dev/);
    expect(await refused("postgresql://app@[::1]:41001,localhost:6543/x")).toMatch(/names port 6543/);
    expect(await refused("postgres://app@localhost/app_explore")).toMatch(/names port 5432/);
    expect(await refused("postgresql://app@localhost:41001/x?dbname=app_dev")).toMatch(/names database app_dev/);
    expect(await refused("postgresql://app@localhost:41001/app_explore")).toBe("ok");
    expect(await refused("pw-not-in-message")).toBe("ok");
  });

  it("a health url that already answers before start is refused, and the command never runs", async () => {
    const w = await world();
    const port = await serve();
    const entry = { name: "web", cmd: "echo ran >> events", health: { url: `http://127.0.0.1:${port}/health` } };
    await expect(startEntry(entry, { ...w.ctx, groups })).rejects.toThrow(`refused: something already serves http://127.0.0.1:${port}/health (web)`);
    expect(w.events()).toEqual([]);
  });

  it("an entry that exits before its health fails, unless it has stop", async () => {
    const w = await world();
    const quick = { name: "starter", cmd: "echo detached" };
    const s1 = await startEntry(quick, { ...w.ctx, groups });
    await expect(waitHealth(quick, s1, { ...w.ctx, aliveAfterMs: 1000 })).rejects.toThrow(/^failed: starter exited \(code 0\) before its health passed/);
    const withStop = { ...quick, stop: "true" };
    const s2 = await startEntry(withStop, { ...w.ctx, groups });
    await expect(waitHealth(withStop, s2, { ...w.ctx, aliveAfterMs: 1000 })).resolves.toBeUndefined();
    const failing = { name: "broken", cmd: "exit 4", stop: "true" };
    const s3 = await startEntry(failing, { ...w.ctx, groups });
    await expect(waitHealth(failing, s3, { ...w.ctx, aliveAfterMs: 1000 })).rejects.toThrow(/^failed: broken exited \(code 4\)/);
  });

  it("no health: alive after the wait passes; a health cmd passes once it exits 0", async () => {
    const w = await world();
    const sleeper = { name: "worker", cmd: `exec ${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 1 << 30)"` };
    await expect(waitHealth(sleeper, await startEntry(sleeper, { ...w.ctx, groups }), { ...w.ctx, aliveAfterMs: 300 })).resolves.toBeUndefined();
    const ready = { name: "ready", cmd: `sleep 1; touch ready; exec ${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 1 << 30)"`, health: { cmd: "test -f ready" } };
    await expect(waitHealth(ready, await startEntry(ready, { ...w.ctx, groups }), w.ctx)).resolves.toBeUndefined();
  });

  it("a health timeout fails, naming the entry", async () => {
    const w = await world();
    const port = await freePort();
    const never = { name: "api", cmd: `exec ${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 1 << 30)"`, health: { url: `http://127.0.0.1:${port}/health` } };
    const t0 = Date.now();
    await expect(waitHealth(never, await startEntry(never, { ...w.ctx, groups }), { ...w.ctx, timeoutS: 1 })).rejects.toThrow(/^failed: api was not healthy within 1 s/);
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it("an entry runs in its own process group, with the instance env and its own, never HOME or COMPOSE_PROJECT_NAME", async () => {
    const w = await world();
    const pidFile = join(w.wt, "child.pid");
    const port = await freePort();
    const entry = { name: "web", cmd: `exec ${app("--spawn-child")}`, env: { PORT: String(port), CHILD_PID_FILE: pidFile }, health: { url: `http://127.0.0.1:${port}/health` } };
    const s = await startEntry(entry, { ...w.ctx, groups });
    await waitHealth(entry, s, w.ctx);
    expect(s.pgid).toBe(s.pid);
    expect(groups.at(-1)).toMatchObject({ name: "web", pgid: s.pgid });
    process.kill(-s.pgid, "SIGKILL");
    const child = Number(readFileSync(pidFile, "utf8"));
    for (let i = 0; i < 40; i++) {
      try {
        process.kill(child, 0);
      } catch {
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(() => process.kill(child, 0)).toThrow();
    await expect(startEntry({ name: "x", cmd: "true", env: { HOME: "/" } }, { ...w.ctx, groups })).rejects.toThrow("refused: start entry x may not set HOME");
  });
});
