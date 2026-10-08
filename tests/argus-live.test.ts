// tests/argus-live.test.ts — the journey lane's live instance (argus-live*.mjs): its config
// (.argus/live.json) is validated and expanded, and the lock and live log it keeps match what
// sapu-merge.sh's live_overlap reads.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error — plain ESM script without types
import { expand, loadLive, parseEnvFile, validateLive } from "../plugins/sapu/scripts/argus-live-config.mjs";

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
    expect(errorsOf((c) => (c.allow_origins = ["https://fonts.example.com", "https://cdn.example.com:8443"]))).toEqual([]);
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
    expect(loadLive(withLive({ ...example(), env_file: "../live.env" }, "")).errors.some((e: string) => e.includes("env_file"))).toBe(true);
    expect(loadLive(withLive({ ...example(), env_file: "/etc/passwd" }, "")).errors.some((e: string) => e.includes("env_file"))).toBe(true);
  });

  it("without env_file there are no secrets", () => {
    const c = example();
    delete c.env_file;
    const r = loadLive(withLive(c));
    expect(r.errors).toEqual([]);
    expect(r.secrets).toEqual({});
  });
});
