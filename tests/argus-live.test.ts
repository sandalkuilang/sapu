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
  checkCompose,
  checkEgress,
  checkStore,
  egressAllowed,
  groupPids,
  instanceEnv,
  makeHome,
  makeWorktree,
  portFree,
  portHolder,
  readLock,
  renew,
  run,
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

  it("refuses ${NAME} in a shell field where the shell would not expand it: single quotes, a heredoc", () => {
    const single = errorsOf((c) => (c.reset = "sh -c 'psql -c \"${PW}\"'"));
    expect(single.some((e) => e.includes("reset") && e.includes("inside single quotes") && e.includes('"$ARGUS_SECRET_PW"'))).toBe(true);
    expect(errorsOf((c) => (c.start[0].cmd = "cat <<EOF > f\n${PW}\nEOF")).some((e) => e.includes("start[0].cmd") && e.includes("heredoc"))).toBe(true);
    expect(errorsOf((c) => (c.roles.admin.login.command = "x '${PW}'")).some((e) => e.includes("roles.admin.login.command"))).toBe(true);
    expect(errorsOf((c) => (c.reset = `sh -c 'echo "$ARGUS_SECRET_PW"' && echo "\${PW}" \${PW}`))).toEqual([]);
    expect(errorsOf((c) => (c.setup = [["sh", "-c", "'${PW}'"]]))).toEqual([]);
  });

  it("a heredoc ends at its delimiter line; << inside $(( )) is a shift; the advice fits the heredoc", () => {
    expect(errorsOf((c) => (c.reset = "cat <<EOF > f\nhello\nEOF\necho ${PW}"))).toEqual([]);
    expect(errorsOf((c) => (c.reset = "cat <<-EOF > f\n\thello\n\tEOF\necho ${PW}"))).toEqual([]);
    expect(errorsOf((c) => (c.reset = "echo $((1 << 2)) ${PW}"))).toEqual([]);
    const unquoted = errorsOf((c) => (c.reset = "cat <<EOF > f\n${PW}\nEOF"));
    expect(unquoted.some((e) => e.includes("heredoc") && e.includes("write $ARGUS_SECRET_PW ") && !e.includes('"$ARGUS_SECRET_PW"'))).toBe(true);
    const quoted = errorsOf((c) => (c.reset = "cat <<'EOF' > f\n${PW}\nEOF"));
    expect(quoted.some((e) => e.includes("quoted heredoc"))).toBe(true);
    expect(errorsOf((c) => (c.reset = "cat <<A <<B\na\nA\n${PW}\nB\necho ${PW}")).length).toBe(1);
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
    const groups: { cmdline: string }[] = [];
    await setup(wt, [node("process.exit(0) // hunter2")], { secrets: { PW: "hunter2" }, groups });
    expect(groups[0].cmdline).not.toContain("hunter2");
    expect(groups[0].cmdline).toContain("// ***");
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
    // store_check runs under the instance env, then under each entry's own env (backing, web).
    expect(w.events()).toEqual(["backing", "check", "check", "check", "reset"]);
    expect(readdirSync(w.data)).toEqual(["seed.json"]);
    await bringUpRest(w.ctx);
    expect(w.events()).toEqual(["backing", "check", "check", "check", "reset", "web", "check", "check", "check"]);
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
    expect(await err).toBe("refused: env.CACHE points at a service the repo's env files name (.env, .env.local); it would reach the owner's service");
    writeFileSync(join(w.main, ".env.production"), "X=redis://localhost:7000\n");
    const prod = await checkStore({ ...w.ctx, env: { ...w.ctx.env, C: "redis://localhost:7000" }, contract: { guard: { envFiles: [".env.production"], postgres: null } } }).catch((e: Error) => e.message);
    expect(prod).toMatch(/^refused: env\.C points at a service the repo's env files name/);
    await expect(checkStore(w.ctx)).resolves.toBeUndefined();
  });

  it("an env URL naming a database or port guard.postgres protects is refused", async () => {
    const w = await world();
    w.ctx.config.store_check = "echo app_explore"; // this test is about the guard, not the store
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

describe("argus-live instance — review: env of every entry, secrets in shell fields, health and store_check hygiene", () => {
  const SERVER = join(__dirname, "fixtures/journey-app/server.mjs");
  const NODE = JSON.stringify(process.execPath);
  const app = (args = "") => `${NODE} ${JSON.stringify(SERVER)}${args ? ` ${args}` : ""}`;
  const SLEEP = `${NODE} -e "setInterval(() => {}, 1 << 30)"`;
  const groups: { name: string; pgid: number; cmdline: string }[] = [];
  const pids: number[] = [];
  const servers: Server[] = [];
  afterEach(async () => {
    for (const g of groups.splice(0)) {
      try {
        process.kill(-g.pgid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    for (const p of pids.splice(0)) {
      try {
        process.kill(p, "SIGKILL");
      } catch {
        // already gone
      }
    }
    await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))));
  });
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const goneSoon = async (pid: number) => {
    for (let i = 0; i < 40 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50));
    return !alive(pid);
  };
  const freePort = () =>
    new Promise<number>((done) => {
      const s = createServer();
      s.listen(0, "127.0.0.1", () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => done(p));
      });
    });
  const ctxFor = async (over: Record<string, unknown> = {}) => {
    const wt = tempDir();
    const main = tempDir();
    const data = join(tempDir(), "app_explore");
    const web = await freePort();
    const config = {
      store: "app_explore",
      store_check: app("--which-store"),
      reset: app("--reset"),
      start: [{ name: "web", cmd: `exec ${app()}`, env: { PORT: String(web) }, health: { url: `http://127.0.0.1:${web}/health` } }],
      ...over,
    };
    return { config, env: { PATH: process.env.PATH!, DATA_DIR: data }, worktree: wt, main, contract: null as unknown, secrets: {}, logs: join(wt, "logs"), groups, timeoutS: 10, deadline: Math.floor(Date.now() / 1000) + 600 };
  };
  const message = (p: Promise<unknown>) => p.then(() => "ok", (e: Error) => e.message);

  describe("1. checkStore reads every start entry's env", () => {
    it("an entry env pointing at the owner's database is refused, naming the entry and key", async () => {
      const ctx = await ctxFor();
      writeFileSync(join(ctx.main, ".env"), "DATABASE_URL=postgres://owner:x@localhost:5432/app_dev\n");
      (ctx.config.start[0].env as Record<string, string>).DATABASE_URL = "postgres://app@127.0.0.1/app_explore";
      expect(await message(checkStore(ctx))).toBe("refused: start.web.env.DATABASE_URL points at a service the repo's env files name (.env, .env.local); it would reach the owner's service");
    });

    it("store_check runs under each entry's own env too, and must print the store there as well", async () => {
      const ctx = await ctxFor();
      (ctx.config.start[0].env as Record<string, string>).DATA_DIR = join(tempDir(), "app_dev");
      expect(await message(checkStore(ctx))).toBe('refused: store_check printed "app_dev" under the env of start entry web, not the store "app_explore"');
    });

    it("a store that guard.postgres protects is refused", async () => {
      const ctx = await ctxFor({ store: "app_dev" });
      ctx.contract = { guard: { envFiles: [], postgres: { ports: [], databases: ["app_dev"] } } };
      expect(await message(checkStore(ctx))).toBe('refused: the store "app_dev" is a database guard.postgres protects');
    });
  });

  describe("2. secrets in shell fields travel in the environment, never in the command line", () => {
    const VALUE = `a b;touch pwned $(touch pwned2) 'q\\" `;
    it("expandConfig turns ${NAME} in a shell field into a quoted variable reference, and leaves argv and env literal", () => {
      const raw = {
        store: "s",
        store_check: "echo ${PW}",
        reset: `x "${"${PW}"}" \${PW} 'lit' sh -c 'echo "$ARGUS_SECRET_PW"'`,
        setup: [["tool", "--pw", "${PW}"]],
        env: { DB: "postgres://u:${PW}@localhost/x" },
        start: [{ name: "w", cmd: "run ${PW}", stop: "stop ${PW}", env: { K: "${PW}" }, health: { cmd: "check ${PW}" } }],
        roles: { admin: { login: { command: "login ${PW}" } } },
        facts: { argv: ["facts", "${PW}"] },
      };
      const c = expandConfig(raw, { ports: {}, secrets: { PW: VALUE } });
      expect(c.store_check).toBe('echo "${ARGUS_SECRET_PW}"');
      expect(c.reset).toBe(`x "\${ARGUS_SECRET_PW}" "\${ARGUS_SECRET_PW}" 'lit' sh -c 'echo "$ARGUS_SECRET_PW"'`);
      expect(c.start[0]).toMatchObject({ cmd: 'run "${ARGUS_SECRET_PW}"', stop: 'stop "${ARGUS_SECRET_PW}"', env: { K: VALUE }, health: { cmd: 'check "${ARGUS_SECRET_PW}"' } });
      expect(c.roles.admin.login.command).toBe('login "${ARGUS_SECRET_PW}"');
      expect(c.setup[0][2]).toBe(VALUE);
      expect(c.facts.argv[1]).toBe(VALUE);
      expect(c.env.DB).toBe(`postgres://u:${VALUE}@localhost/x`);
      expect(() => expandConfig({ reset: "x ${NOPE}" }, { secrets: {} })).toThrow(/unset NOPE/);
      expect(() => expandConfig({ reset: "sh -c 'x $ARGUS_SECRET_NOPE'" }, { secrets: {} })).toThrow(/unset NOPE/);
      expect(() => expandConfig({ reset: "x '${PW}'" }, { secrets: { PW: "v" } })).toThrow(/^refused: .*inside single quotes/);
    });

    it("the shell receives the value as data: no injection, every quoting context, and no value in the recorded cmdline", async () => {
      const ctx = await ctxFor();
      const raw = { name: "w", cmd: `printf '%s' \${PW} > out1; printf '%s' "<\${PW}>" > out2; sh -c 'printf "%s" "x$ARGUS_SECRET_PW"y > out3'` };
      const entry = expandConfig({ start: [raw] }, { secrets: { PW: VALUE } }).start[0];
      const s = await startEntry(entry, { ...ctx, secrets: { PW: VALUE } });
      for (let i = 0; i < 100 && !s.exit; i++) await new Promise((r) => setTimeout(r, 20));
      expect(s.exit).toEqual({ code: 0, signal: null });
      expect(readFileSync(join(ctx.worktree, "out1"), "utf8")).toBe(VALUE);
      expect(readFileSync(join(ctx.worktree, "out2"), "utf8")).toBe(`<${VALUE}>`);
      expect(readFileSync(join(ctx.worktree, "out3"), "utf8")).toBe(`x${VALUE}y`);
      expect(existsSync(join(ctx.worktree, "pwned"))).toBe(false);
      expect(existsSync(join(ctx.worktree, "pwned2"))).toBe(false);
      expect(groups.at(-1)!.cmdline).not.toContain("pwned");
    });

    it("reset and store_check get their secrets the same way", async () => {
      const raw = { store: "app_explore", store_check: `test "\${PW}" = '${VALUE.replace(/'/g, `'\\''`)}' && ${app("--which-store")}`, reset: `printf '%s' \${PW} > reset.out && ${app("--reset")}`, start: [] };
      const ctx = await ctxFor();
      const config = expandConfig(raw, { secrets: { PW: VALUE } });
      await bringUpStore({ ...ctx, config, secrets: { PW: VALUE } });
      expect(readFileSync(join(ctx.worktree, "reset.out"), "utf8")).toBe(VALUE);
      expect(groups.map((g) => g.cmdline).join("\n")).not.toContain("pwned");
    });
  });

  it("3. a health cmd that already succeeds before start is refused, and the command never runs", async () => {
    const ctx = await ctxFor();
    await expect(startEntry({ name: "db", cmd: "touch ran", health: { cmd: "true" } }, ctx)).rejects.toThrow("refused: the health cmd of db already succeeds before it started (something else serves there)");
    expect(existsSync(join(ctx.worktree, "ran"))).toBe(false);
  });

  describe("4. env values are compared as services", () => {
    const owner = "DATABASE_URL=postgres://owner:x@localhost:5432/app_dev?sslmode=disable\nREDIS_URL=redis://localhost:6379/0\n";
    const check = async (
      v: string | Record<string, string>,
      { contract = null as unknown, files = owner, allow = [] as string[], compose = [] as string[], at = (_main: string, _wt: string) => {} } = {},
    ) => {
      const ctx = await ctxFor({ store_check: "echo app_explore", allow_origins: allow });
      writeFileSync(join(ctx.main, ".env"), typeof files === "function" ? (files as (m: string) => string)(ctx.main) : files);
      at(ctx.main, ctx.worktree);
      const vars = typeof v === "function" ? (v as (m: string) => Record<string, string>)(ctx.main) : typeof v === "string" ? { X: v } : v;
      return message(checkStore({ ...ctx, contract, composeServices: compose, env: { ...ctx.env, ...vars } }));
    };
    it.each([
      "postgresql://app:y@127.0.0.1/other",
      "postgres://app@[::1]:5432/app_explore",
      "jdbc:postgresql://localhost:5432/x",
      "host=localhost port=5432 dbname=x user=app",
      "host='127.0.0.1' dbname=x",
      "redis://127.0.0.1:6379/3",
      "redis://LOCALHOST",
      "redis://localhost.:6379",
    ])("%s reaches the owner's local service", async (v) => {
      expect(await check(v)).toMatch(/^refused: env\.X points at a service the repo's env files name/);
    });
    it.each(["postgres://app@localhost:41001/app_explore", "redis://127.0.0.1:41002", "https://fonts.example.com/css", "plain words"])("%s does not", async (v) => {
      expect(await check(v)).toBe("ok");
    });
    describe("a datastore is the same server whatever its database; http(s) keeps its path", () => {
      const remote = [
        "DATABASE_URL=postgres://u:p@db.internal.example:5432/app_dev",
        "MYSQL_URL=mysql://db.internal.example/app",
        "CACHE_URL=rediss://cache.internal.example:6379/0",
        "MONGO_URL=mongodb://mongo.internal.example/app",
        "AMQP_URL=amqp://mq.internal.example/vhost",
        "API=https://api.example.com/v1",
      ].join("\n");
      it.each([
        "postgres://app@db.internal.example:5432/app_explore",
        "postgresql://app@DB.Internal.Example.:5432/other",
        "jdbc:postgresql://db.internal.example:5432/x",
        "host=db.internal.example port=5432 dbname=x",
        "host=db.internal.example dbname=x",
        "mysql://db.internal.example:3306/other",
        "mariadb://db.internal.example/other",
        "redis://cache.internal.example:6379/2",
        "mongodb://mongo.internal.example:27017/other",
        "amqps://mq.internal.example:5672/other",
        "https://api.example.com/v1",
      ])("%s is refused", async (v) => {
        expect(await check(v, { files: remote })).toMatch(/^refused: env\.X points at a service the repo's env files name/);
      });
      it.each(["postgres://app@db2.internal.example:5432/app_dev", "https://api.example.com/v2", "redis://cache.internal.example:6380/0"])("%s is not", async (v) => {
        expect(await check(v, { files: remote })).toBe("ok");
      });
      it("an http(s) origin listed in allow_origins is the owner's explicit opt-in", async () => {
        expect(await check("https://api.example.com/v1", { files: remote, allow: ["https://api.example.com:443"] })).toBe("ok");
        expect(await check("postgres://app@db.internal.example:5432/x", { files: remote, allow: ["https://db.internal.example:5432"] })).toMatch(/^refused/);
      });
    });

    describe("host and port given apart are one endpoint", () => {
      it.each([
        [{ REDIS_HOST: "127.0.0.1", REDIS_PORT: "6379" }, "env.REDIS_HOST"],
        [{ PGHOST: "localhost" }, "env.PGHOST"],
        [{ PGHOST: "localhost.", PGPORT: "5432" }, "env.PGHOST"],
        [{ DB_HOST: "::1", DB_PORT: "5432" }, "env.DB_HOST"],
      ])("%j is refused", async (vars, key) => {
        expect(await check(vars as Record<string, string>)).toMatch(new RegExp(`^refused: ${(key as string).replace(".", "\\.")} points at a service the repo's env files name`));
      });
      it("the owner's own split variables name endpoints too", async () => {
        const files = "PGHOST=localhost\nPGPORT=55432\nCACHE_HOST=cache.internal.example\nCACHE_PORT=6390\n";
        expect(await check("postgres://app@127.0.0.1:55432/x", { files })).toMatch(/^refused: env\.X points at/);
        expect(await check("redis://cache.internal.example:6390", { files })).toMatch(/^refused: env\.X points at/);
        expect(await check({ REDIS_HOST: "127.0.0.1", REDIS_PORT: "41003" }, { files })).toBe("ok");
      });
    });

    describe("endpoints with no host or port, and file or socket paths", () => {
      it.each(["custom://localhost/x", "custom:///x", "redis+unix:///tmp/none.sock"])("%s has no host:port to match", async (v) => {
        expect(await check(v, { files: "A=custom://localhost/y\nB=custom:///y\n" })).toBe("ok");
      });
      describe("a libpq or MySQL-family value with no host names the local server on its default port", () => {
        const files = "A=postgres:///app_dev\nB=mysql://owner@/app\n";
        it.each([
          "postgres://app@localhost:5432/x",
          "postgres:///app_explore",
          "dbname=x user=app",
          "postgresql://app@/x?host=",
          "postgresql:///x?host=/var/run/postgresql",
          "postgresql+psycopg://app@localhost/x",
          "mysql://app@127.0.0.1:3306/other",
          "mariadb://app@/other",
          "mysql2:///other",
          "mysql+pymysql://app@localhost/other",
        ])("%s is refused", async (v) => {
          expect(await check(v, { files })).toMatch(/^refused: env\.X points at a service the repo's env files name/);
        });
        it.each(["postgres://app@localhost:41001/x", "postgresql:///x?host=/tmp/argus-pg&port=41001", "postgresql://app@/x?port=41001", "mysql://app@localhost:41002/x"])("%s is not", async (v) => {
          expect(await check(v, { files })).toBe("ok");
        });
      });
      it("a file or socket inside the repo is refused; one in the worktree is not", async () => {
        expect(await check((m: string) => ({ X: `sqlite:///${m}/dev.db` }) as never)).toMatch(/^refused: env\.X points into the main checkout/);
        expect(await check((m: string) => ({ X: `file:${m}/prisma/dev.db` }) as never)).toMatch(/^refused: env\.X points into the main checkout/);
        expect(await check((m: string) => ({ DATA: `${m}/data` }) as never)).toMatch(/^refused: env\.DATA points into the main checkout/);
        expect(await check("file:./dev.db", { files: "DATABASE_URL=file:./dev.db\n" })).toBe("ok");
        expect(await check("sqlite:./data/app.db")).toBe("ok");
      });
      it("sqlite:/// with three slashes is a relative path (four make it absolute), resolved in the worktree", async () => {
        expect(await check("sqlite:///./dev.db", { files: "DATABASE_URL=sqlite:///./dev.db\n" })).toBe("ok");
        expect(await check("sqlite:///dev.db", { files: "DATABASE_URL=sqlite:///dev.db\n" })).toBe("ok");
        expect(await check("sqlite+pysqlite:///db/app.sqlite3", { files: "DATABASE_URL=sqlite:///db/app.sqlite3\n" })).toBe("ok");
        const dir = realpathSync(tempDir());
        expect(await check(`sqlite:////${dir}/dev.db`, { files: `DATABASE_URL=sqlite:////${dir}/dev.db\n` })).toMatch(/^refused: env\.X points at a file or socket the repo's env files name/);
        expect(await check(`sqlite:///${dir.slice(1)}/dev.db`, { files: `DATABASE_URL=sqlite:///${dir}/dev.db\n` })).toBe("ok");
        const ctx = await ctxFor({ store_check: "echo app_explore" });
        const intoMain = relative(ctx.worktree, join(ctx.main, "dev.db"));
        expect(await message(checkStore({ ...ctx, env: { ...ctx.env, X: `sqlite:///${intoMain}` } }))).toMatch(/^refused: env\.X points into the main checkout/);
      });
      it("a socket or file the owner's env files name is refused, whatever the scheme spelling", async () => {
        const dir = realpathSync(tempDir());
        const files = `REDIS_SOCKET=unix://${dir}/redis.sock\nPGHOST=${dir}/pg\n`;
        expect(await check(`redis+unix://${dir}/redis.sock`, { files })).toMatch(/^refused: env\.X points at a file or socket the repo's env files name/);
        expect(await check({ PGHOST: `${dir}/pg` }, { files })).toMatch(/^refused: env\.PGHOST points at a file or socket/);
        expect(await check(`unix://${dir}/other.sock`, { files })).toBe("ok");
      });
    });

    describe("the instance's own Compose services", () => {
      const files = "DATABASE_URL=postgres://owner@db:5432/app_dev\nAPI_DB=postgres://owner@db.internal:5432/a\n";
      it("a single-label host that is a service of the worktree's Compose project is exempt", async () => {
        expect(await check("postgres://app@db:5432/app_explore", { files, compose: ["db", "cache"] })).toBe("ok");
        expect(await check("postgres://app@db:5432/app_explore", { files })).toMatch(/^refused: env\.X points at a service/);
        expect(await check("postgres://app@db.internal:5432/x", { files, compose: ["db.internal"] })).toMatch(/^refused/);
      });
    });

    describe("IPv6 forms and a port with no host", () => {
      it.each(["postgres://app@[0:0:0:0:0:0:0:1]:5432/x", "redis://[::ffff:127.0.0.1]:6379", "redis://127.1:6379"])("%s is loopback", async (v) => {
        expect(await check(v)).toMatch(/^refused: env\.X points at a service/);
      });
      it("a bare *PORT with no host is a loopback endpoint", async () => {
        expect(await check({ REDIS_PORT: "6379" })).toMatch(/^refused: env\.REDIS_PORT points at a service/);
        expect(await check({ REDIS_PORT: "41005" })).toBe("ok");
        // Even one only a Compose file reads (spec §8 step 6: rename it in the live env).
        expect(await check({ POSTGRES_PORT: "5432" }, { compose: ["postgres"] })).toMatch(/^refused: env\.POSTGRES_PORT points at a service/);
      });
    });

    const guard = { guard: { envFiles: [], postgres: { ports: [6543], databases: ["app_dev"] } } };
    it.each(["PGDATABASE", "MAIN_DB", "APP_DATABASE", "APP_DB_NAME", "X_DBNAME"])("a bare protected database name under %s is refused", async (key) => {
      expect(await check({ [key]: "app_dev" }, { contract: guard })).toMatch(new RegExp(`^refused: env\\.${key} names database app_dev`));
    });
    it.each(["PGUSER", "APP_NAME", "X"])("a bare app_dev under %s is not a database name", async (key) => {
      expect(await check({ [key]: "app_dev" }, { contract: guard })).toBe("ok");
    });
    it.each([
      ["jdbc:postgresql://localhost:41001/app%5Fdev", /names database app_dev/],
      ["host=localhost port=41001 dbname=app_dev", /names database app_dev/],
      ["host=localhost port=6543 dbname=x", /names port 6543/],
      ["jdbc:postgresql://localhost:6543/x", /names port 6543/],
      [{ PGHOST: "localhost", PGPORT: "6543" }, /names port 6543/],
    ])("%s is a protected database or port", async (v, why) => {
      expect(await check(v as string, { contract: guard })).toMatch(why as RegExp);
    });
  });

  describe("5 and 6. store_check and health cmds are bounded and leave no process behind", () => {
    it("store_check with a background child holding stdout returns at once, and the child is killed", async () => {
      const ctx = await ctxFor({ store_check: `(${SLEEP} & echo $! > bg.pid); ${app("--which-store")}` });
      const t0 = Date.now();
      await expect(checkStore(ctx)).resolves.toBeUndefined();
      expect(Date.now() - t0).toBeLessThan(5000);
      const bg = Number(readFileSync(join(ctx.worktree, "bg.pid"), "utf8"));
      pids.push(bg);
      expect(await goneSoon(bg)).toBe(true);
    });

    it("store_check has its own timeout (the health timeout), not the whole time to the deadline", async () => {
      const ctx = await ctxFor({ store_check: "sleep 30" });
      const t0 = Date.now();
      expect(await message(checkStore({ ...ctx, timeoutS: 1 }))).toMatch(/^failed: store_check timed out/);
      expect(Date.now() - t0).toBeLessThan(5000);
    });

    it("a health cmd's background child is killed after each try", async () => {
      const ctx = await ctxFor();
      const entry = { name: "w", cmd: `sleep 1; touch ready; exec ${SLEEP}`, health: { cmd: `(${SLEEP} & echo $! >> hc.pids); test -f ready` } };
      await waitHealth(entry, await startEntry(entry, ctx), ctx);
      const left = readFileSync(join(ctx.worktree, "hc.pids"), "utf8").trim().split("\n").map(Number);
      pids.push(...left);
      for (const p of left) expect(await goneSoon(p)).toBe(true);
    });
  });

  it("8. a process that exits while its health URL answers fails, even though the URL answered", async () => {
    const ctx = await ctxFor();
    const port = await freePort();
    const entry = { name: "w", cmd: "sleep 0.2; exit 1", health: { url: `http://127.0.0.1:${port}/health` } };
    const s = await startEntry(entry, ctx);
    const slow = createServer((c) => setTimeout(() => c.end("HTTP/1.1 200 OK\r\nconnection: close\r\ncontent-length: 0\r\n\r\n", () => c.destroy()), 600));
    await new Promise<void>((r) => slow.listen(port, "127.0.0.1", () => r()));
    servers.push(slow);
    expect(await message(waitHealth(entry, s, ctx))).toMatch(/^failed: w exited \(code 1\) before its health passed/);
  });
});

describe("argus-live instance — Compose and egress checks", () => {
  const SERVER = join(__dirname, "fixtures/journey-app/server.mjs");
  const app = (args = "") => `${JSON.stringify(process.execPath)} ${JSON.stringify(SERVER)}${args ? ` ${args}` : ""}`;
  const groups: { name: string; pgid: number; cmdline: string }[] = [];
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
  const message = (p: Promise<unknown> | (() => unknown)) =>
    typeof p === "function"
      ? (() => {
          try {
            p();
            return "ok";
          } catch (e) {
            return (e as Error).message;
          }
        })()
      : p.then(() => "ok", (e: Error) => e.message);

  describe("Compose", () => {
    const PROJECT = "argus-run1";
    /** A worktree with a Compose file, and a fake `docker` on PATH that records how it ran and prints `json`. */
    const world = (json: unknown, { file = "compose.yaml" as string | null, status = 0, stderr = "" } = {}) => {
      const wt = realpathSync(tempDir());
      const main = realpathSync(tempDir());
      const bin = tempDir();
      if (file) writeFileSync(join(wt, file), "services: {}\n");
      writeFileSync(join(bin, "out.json"), JSON.stringify(json));
      const docker = join(bin, "docker");
      writeFileSync(docker, `#!/bin/sh\nprintf '%s\\n' "$PWD" "$COMPOSE_PROJECT_NAME" "$*" > ${JSON.stringify(join(bin, "ran"))}\nprintf '%s' ${JSON.stringify(stderr)} >&2\ncat ${JSON.stringify(join(bin, "out.json"))}\nexit ${status}\n`);
      chmodSync(docker, 0o755);
      const env: Record<string, string> = { PATH: `${bin}:${process.env.PATH}`, COMPOSE_PROJECT_NAME: PROJECT };
      return { wt, main, bin, env, ran: () => (existsSync(join(bin, "ran")) ? readFileSync(join(bin, "ran"), "utf8").trim().split("\n") : null), ports: { pg: 41001, web: 41002 } };
    };
    const good = (wt = "/w"): Obj => ({
      name: PROJECT,
      services: {
        db: {
          image: "postgres:16",
          ports: [{ mode: "ingress", target: 5432, published: "41001", protocol: "tcp" }],
          volumes: [
            { type: "volume", source: "pgdata", target: "/var/lib/postgresql/data", volume: {} },
            { type: "bind", source: `${wt}/data`, target: "/x", bind: {} },
            { type: "bind", source: "/etc/hosts", target: "/h", read_only: true, bind: {} },
            { type: "tmpfs", target: "/tmp" },
          ],
          networks: { default: null },
        },
        web: { image: "nginx", ports: [{ mode: "ingress", host_ip: "127.0.0.1", target: 80, published: "41002", protocol: "tcp" }] },
        sidecar: { image: "busybox", network_mode: "service:db" },
      },
      networks: { default: { name: `${PROJECT}_default`, ipam: {} } },
      volumes: { pgdata: { name: `${PROJECT}_pgdata` } },
    });

    it("a compliant project passes, returns its service names, and docker ran in the worktree under the instance env, every profile included", () => {
      const w = world(null);
      writeFileSync(join(w.bin, "out.json"), JSON.stringify(good(w.wt)));
      expect(checkCompose({ worktree: w.wt, env: w.env, ports: w.ports, main: w.main })).toEqual(["db", "web", "sidecar"]);
      expect(w.ran()).toEqual([w.wt, PROJECT, "compose --profile * config --format json"]);
    });

    it.each(["compose.yml", "docker-compose.yaml", "docker-compose.yml"])("%s is a Compose file too", (file) => {
      const w = world(good(), { file });
      expect(message(() => checkCompose({ worktree: w.wt, env: w.env, ports: w.ports, main: w.main }))).toBe("ok");
      expect(w.ran()).not.toBeNull();
    });

    it("no Compose file: nothing to check, docker never runs", () => {
      const w = world(good(), { file: null });
      expect(checkCompose({ worktree: w.wt, env: w.env, ports: w.ports, main: w.main })).toEqual([]);
      expect(w.ran()).toBeNull();
    });

    it("COMPOSE_FILE in the env, or in a .env the worktree tracks, makes Compose read a file elsewhere: checked too", () => {
      const w = world(good(), { file: null });
      expect(checkCompose({ worktree: w.wt, env: { ...w.env, COMPOSE_FILE: "deploy/dev.yml" }, ports: w.ports, main: w.main })).toEqual(["db", "web", "sidecar"]);
      const v = world(good(), { file: null });
      writeFileSync(join(v.wt, ".env"), "COMPOSE_FILE=deploy/dev.yml\n");
      expect(checkCompose({ worktree: v.wt, env: v.env, ports: v.ports, main: v.main })).toEqual(["db", "web", "sidecar"]);
    });

    const refusals: [string, (c: Obj, main: string) => void, RegExp][] = [
      ["a host port outside the run", (c) => (c.services.db.ports[0].published = "5432"), /^refused: Compose service db publishes host port 5432, which is not one of this run's ports/],
      ["a published range reaching outside the run", (c) => (c.services.db.ports[0].published = "41001-41003"), /^refused: Compose service db publishes host port 41003/],
      ["a random host port", (c) => delete c.services.db.ports[0].published, /^refused: Compose service db publishes container port 5432 on a random host port/],
      ["a container_name", (c) => (c.services.web.container_name = "web"), /^refused: Compose service web sets container_name/],
      ["the host's network", (c) => (c.services.web.network_mode = "host"), /^refused: Compose service web uses network_mode host/],
      ["another container's network", (c) => (c.services.web.network_mode = "container:owner-db-1"), /^refused: Compose service web uses network_mode container:owner-db-1/],
      ["an external network", (c) => (c.networks.ext = { name: "owner_net", external: true }), /^refused: Compose network ext is external/],
      ["a network named outside the project", (c) => (c.networks.ext = { name: "owner_net" }), /^refused: Compose network ext is named owner_net, outside the project argus-run1/],
      ["an external volume", (c) => (c.volumes.pgdata = { name: "owner_pgdata", external: true }), /^refused: Compose volume pgdata is external/],
      ["a volume named outside the project", (c) => (c.volumes.pgdata = { name: "owner_pgdata" }), /^refused: Compose volume pgdata is named owner_pgdata, outside the project argus-run1/],
      ["a project named otherwise", (c) => (c.name = "owner"), /^refused: the Compose project is named owner, not argus-run1/],
      ["a bind mount from the main checkout", (c, main) => c.services.db.volumes.push({ type: "bind", source: `${main}/data`, target: "/y", bind: {} }), /^refused: Compose service db bind-mounts a path inside the main checkout/],
      ["the Docker socket", (c) => c.services.db.volumes.push({ type: "bind", source: "/var/run/docker.sock", target: "/var/run/docker.sock", bind: {} }), /^refused: Compose service db bind-mounts the Docker socket/],
    ];
    it.each(refusals)("refuses %s", (_what, mutate, why) => {
      const w = world(null);
      const c = good(w.wt);
      mutate(c, w.main);
      writeFileSync(join(w.bin, "out.json"), JSON.stringify(c));
      expect(message(() => checkCompose({ worktree: w.wt, env: w.env, ports: w.ports, main: w.main }))).toMatch(why);
    });

    it("docker missing or failing is a refusal (fail closed), with the DOCKER_CONFIG hint and every secret masked", () => {
      const w = world(good());
      const empty = tempDir();
      expect(message(() => checkCompose({ worktree: w.wt, env: { ...w.env, PATH: empty }, ports: w.ports, main: w.main }))).toMatch(
        /^refused: compose\.yaml is in the worktree, but docker compose config could not read it: .*DOCKER_CONFIG in pass_env/,
      );
      const f = world(good(), { status: 1, stderr: "bad interpolation near s3cret" });
      const m = message(() => checkCompose({ worktree: f.wt, env: f.env, ports: f.ports, main: f.main, secrets: { PW: "s3cret" } }));
      expect(m).toMatch(/^refused: compose\.yaml is in the worktree, but docker compose config could not read it: .*bad interpolation near \*\*\*/);
      expect(m).not.toContain("s3cret");
      const j = world("not json");
      writeFileSync(join(j.bin, "out.json"), "{oops");
      expect(message(() => checkCompose({ worktree: j.wt, env: j.env, ports: j.ports, main: j.main }))).toMatch(/^refused: .*not JSON/);
    });

    describe("Compose flags in the config's commands that would escape the check", () => {
      const cfg = (over: Obj): Obj => ({ setup: [], store_check: "true", reset: "true", start: [{ name: "backing", phase: "store", cmd: "docker compose up -d", stop: "docker compose down -v" }], ...over });
      it.each([
        [{ start: [{ name: "backing", cmd: "docker compose up -d", stop: "docker compose -p owner down -v" }] }, /^refused: start\.backing\.stop passes -p to docker compose/],
        [{ start: [{ name: "backing", cmd: "docker-compose --file=../x.yml up" }] }, /^refused: start\.backing\.cmd passes --file to docker compose/],
        [{ start: [{ name: "b", cmd: "docker compose -powner up" }] }, /^refused: start\.b\.cmd passes -p to docker compose/],
        [{ reset: "cd x && docker compose --project-directory /srv/app exec db reset" }, /^refused: reset passes --project-directory to docker compose/],
        [{ setup: [["docker", "compose", "--env-file", "/x/.env", "pull"]] }, /^refused: setup\[0\] passes --env-file to docker compose/],
        [{ start: [{ name: "b", cmd: "docker compose up -d", health: { cmd: "docker compose --project-name=o ps" } }] }, /^refused: start\.b\.health\.cmd passes --project-name to docker compose/],
      ])("%j is refused", (over, why) => {
        const w = world(good(), { file: null });
        expect(message(() => checkCompose({ worktree: w.wt, env: w.env, ports: w.ports, main: w.main, config: cfg(over as Obj) }))).toMatch(why as RegExp);
      });
      it.each(["docker compose up -d && docker compose logs -f web", "docker compose --profile dev up -d", "docker compose exec -T db pg_isready -p 5432", "tail -f log; rm -f x"])("%s passes", (cmd) => {
        const w = world(good(), { file: null });
        expect(message(() => checkCompose({ worktree: w.wt, env: w.env, ports: w.ports, main: w.main, config: cfg({ start: [{ name: "b", cmd }] }) }))).toBe("ok");
      });
    });

    it("its service names are what checkStore exempts as the instance's own hosts", async () => {
      const w = world(good());
      writeFileSync(join(w.main, ".env"), "DATABASE_URL=postgres://owner@db:5432/app_dev\n");
      const composeServices = checkCompose({ worktree: w.wt, env: w.env, ports: w.ports, main: w.main });
      const ctx = { config: { store: "app_explore", store_check: "echo app_explore", start: [] }, env: { PATH: process.env.PATH!, DATABASE_URL: "postgres://app@db:5432/app_explore" }, worktree: w.wt, main: w.main, contract: null, timeoutS: 10, deadline: Math.floor(Date.now() / 1000) + 600 };
      expect(await message(checkStore({ ...ctx, composeServices }))).toBe("ok");
      expect(await message(checkStore(ctx))).toMatch(/^refused: env\.DATABASE_URL points at a service/);
    });
  });

  describe("egress", () => {
    const freePort = () =>
      new Promise<number>((done) => {
        const s = createServer();
        s.listen(0, "127.0.0.1", () => {
          const p = (s.address() as { port: number }).port;
          s.close(() => done(p));
        });
      });
    const listen = (port = 0) =>
      new Promise<number>((done, fail) => {
        const s = createServer((c) => c.on("error", () => {}));
        s.once("error", fail);
        s.listen(port, "127.0.0.1", () => {
          servers.push(s);
          done((s.address() as { port: number }).port);
        });
      });
    /** Starts the fixture app; returns its pids (the whole process group) once healthy. */
    const startApp = async (env: Record<string, string>, args = "") => {
      const wt = tempDir();
      const web = await freePort();
      const entry = { name: "web", cmd: `exec ${app(args)}`, env: { PORT: String(web) }, health: { url: `http://127.0.0.1:${web}/health` } };
      const base = { PATH: process.env.PATH!, DATA_DIR: join(wt, "app_explore"), ...env };
      const s = await startEntry(entry, { worktree: wt, env: base, logs: join(wt, "logs"), groups });
      await waitHealth(entry, s, { worktree: wt, env: base, timeoutS: 20 });
      // Its outbound connection is made at start; give it a moment to be established.
      await new Promise((r) => setTimeout(r, 300));
      return { wt, web, pids: groupPids([s.pgid]), entry, base };
    };

    it("the fixture's cache fallback to a fixed local port is refused, naming the process and 46379", async () => {
      await listen(46379);
      const a = await startApp({});
      const allowed = egressAllowed({ config: { start: [a.entry], allow_origins: [] }, env: a.base, ports: { web: a.web } });
      expect(await message(checkEgress({ pids: a.pids, allowed }))).toMatch(/^refused: node \(\d+\) connects to 127\.0\.0\.1:46379$/);
    });

    it("CACHE_URL pointing at a run port passes (the health request it answered is inbound, not egress)", async () => {
      const cache = await listen();
      const a = await startApp({ CACHE_URL: `tcp://127.0.0.1:${cache}` });
      const allowed = egressAllowed({ config: { start: [a.entry], allow_origins: [] }, env: a.base, ports: { web: a.web, cache } });
      expect(await message(checkEgress({ pids: a.pids, allowed }))).toBe("ok");
    });

    it("an endpoint the env names is allowed even when it is not a run port; one it does not name is refused", async () => {
      const cache = await listen();
      const a = await startApp({ CACHE_URL: `tcp://localhost:${cache}` });
      expect(await message(checkEgress({ pids: a.pids, allowed: egressAllowed({ config: { start: [a.entry] }, env: a.base, ports: { web: a.web } }) }))).toBe("ok");
      expect(await message(checkEgress({ pids: a.pids, allowed: [`loopback:${a.web}`] }))).toMatch(new RegExp(`^refused: node \\(\\d+\\) connects to 127\\.0\\.0\\.1:${cache}$`));
    });

    it("every process of the run's groups is listed, a grandchild included", async () => {
      const cache = await listen();
      const wt = tempDir();
      const pidFile = join(wt, "child.pid");
      const a = await startApp({ CACHE_URL: `tcp://127.0.0.1:${cache}`, CHILD_PID_FILE: pidFile }, "--spawn-child");
      expect(a.pids).toContain(Number(readFileSync(pidFile, "utf8")));
      expect(a.pids.length).toBeGreaterThanOrEqual(2);
    });

    it("refuses when neither lsof nor ss is available", async () => {
      const empty = tempDir();
      const runner = (argv: string[], opts: Obj = {}) => run(argv, { ...opts, env: { PATH: empty } });
      expect(await message(checkEgress({ pids: [process.pid], allowed: [], runner }))).toBe("refused: neither lsof nor ss is available");
    });

    it("reads ss when lsof is missing, skipping listeners and connections to them", async () => {
      const ss = [
        'LISTEN 0 511 127.0.0.1:41002 0.0.0.0:* users:(("node",pid=700,fd=20))',
        'ESTAB 0 0 127.0.0.1:41002 127.0.0.1:53000 users:(("node",pid=700,fd=21))',
        'ESTAB 0 0 [::1]:53001 [::1]:41001 users:(("node",pid=701,fd=22))',
        'ESTAB 0 0 127.0.0.1:53002 127.0.0.1:41002 users:(("worker",pid=702,fd=9))',
        'ESTAB 0 0 10.0.0.5:53003 [::ffff:93.184.216.34]:443 users:(("node",pid=700,fd=23))',
        'SYN-SENT 0 1 127.0.0.1:53004 127.0.0.1:6379 users:(("other",pid=999,fd=3))',
      ].join("\n");
      const runner = (argv: string[]) => (argv[0] === "lsof" ? { error: Object.assign(new Error("spawn lsof ENOENT"), { code: "ENOENT" }) } : { status: 0, stdout: ss, stderr: "" });
      const lookup = async (host: string) => (host === "api.example.test" ? [{ address: "93.184.216.34", family: 4 }] : []);
      expect(await message(checkEgress({ pids: [700, 701, 702], allowed: ["loopback:41001", "api.example.test:443"], runner, lookup }))).toBe("ok");
      expect(await message(checkEgress({ pids: [700, 701, 702], allowed: ["loopback:41001"], runner, lookup }))).toBe("refused: node (700) connects to [::ffff:93.184.216.34]:443");
      const syn = ss.replace("pid=999", "pid=702");
      const r2 = (argv: string[]) => (argv[0] === "lsof" ? { error: Object.assign(new Error("ENOENT"), { code: "ENOENT" }) } : { status: 0, stdout: syn, stderr: "" });
      expect(await message(checkEgress({ pids: [702], allowed: ["loopback:41001", "loopback:41002", "api.example.test:443"], runner: r2, lookup }))).toBe("refused: other (702) connects to 127.0.0.1:6379");
    });

    it("an allow_origins origin and a URL's default port are allowed endpoints", () => {
      const allowed = egressAllowed({ config: { allow_origins: ["https://fonts.example.test"], start: [{ name: "w", env: { API: "http://[::1]:41009/x" } }] }, env: { DB: "postgres:///app_explore", REDIS_HOST: "127.0.0.1", REDIS_PORT: "41003", SQLITE: "sqlite:///x.db" }, ports: { web: 41002 } });
      expect([...allowed].sort()).toEqual(["fonts.example.test:443", "loopback:41002", "loopback:41003", "loopback:41009", "loopback:5432"].sort());
    });
  });
});
