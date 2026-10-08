// tests/argus-live.test.ts — the journey lane's live instance (argus-live*.mjs): its config
// (.argus/live.json) is validated and expanded, and the lock and live log it keeps match what
// sapu-merge.sh's live_overlap reads.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
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
  checkDockerRuntime,
  checkEgress,
  checkStore,
  daemonNow,
  dockerEnv,
  down,
  egressAllowed,
  groupPids,
  instanceEnv,
  logsDir,
  makeHome,
  makeWorktree,
  portFree,
  portHolder,
  readLock,
  recover,
  renew,
  run,
  runSetup,
  staleRecords,
  startEntry,
  startReaper,
  takeLock,
  waitHealth,
  writeRunFiles,
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
  it("compose_files, when present, lists repo-relative files: no absolute path, no .., no \":\" (COMPOSE_FILE's separator), at least one", () => {
    expect(errorsOf((c) => (c.compose_files = ["compose.yaml", "deploy/stack.yml"]))).toEqual([]);
    for (const bad of [[], ["/srv/compose.yaml"], ["../x.yml"], ["a/../b.yml"], [""], "compose.yaml", ["a.yml", "a.yml"], ["a:b.yml"]]) {
      expect(errorsOf((c) => (c.compose_files = bad)).some((e) => e.startsWith("compose_files"))).toBe(true);
    }
  });

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
          "postgresql://%2Fvar%2Frun%2Fpostgresql/other",
        ])("%s is refused", async (v) => {
          expect(await check(v, { files })).toMatch(/^refused: env\.X points at a service the repo's env files name/);
        });
        it.each(["postgres://app@localhost:41001/x", "postgresql:///x?host=/tmp/argus-pg&port=41001", "postgresql://%2Ftmp%2Fargus-pg:41001/x", "mysql://app@localhost:41002/x"])("%s is not", async (v) => {
          expect(await check(v, { files })).toBe("ok");
        });
        it.each(["postgresql://app@/x?port=41001", "mysql://app@:41002/x", "dbname=x port=41001", "postgres:///x"])("in the instance env, %s leaves its host to the client's default and is refused", async (v) => {
          expect(await check(v, { files: "" })).toBe("refused: env.X leaves its host to the client's default (the local server); name its host and port");
        });
        it.each(["postgres://app@localhost/app_explore", "mysql://app@127.0.0.1/other", "host=localhost dbname=x"])("in the instance env, %s leaves its port to the client's default and is refused", async (v) => {
          expect(await check(v, { files: "" })).toBe("refused: env.X leaves its port to the client's default; name it");
        });
        it.each([
          [{ PGDATABASE: "app_explore" }, "PGDATABASE", "PGHOST"],
          [{ PGUSER: "app", PGPORT: "41001" }, "PGUSER", "PGHOST"],
          [{ MYSQL_PWD: "x" }, "MYSQL_PWD", "MYSQL_HOST"],
          [{ MYSQL_TCP_PORT: "41002" }, "MYSQL_TCP_PORT", "MYSQL_HOST"],
        ])("in the instance env, %j leaves the client's host to its default and is refused", async (vars, key, host) => {
          expect(await check(vars as Record<string, string>, { files: "" })).toBe(`refused: env.${key} leaves its host to the client's default (the local server); set ${host} too`);
        });
        it.each([{ PGDATABASE: "app_explore", PGHOST: "localhost", PGPORT: "41001" }, { PGUSER: "app", PGHOSTADDR: "127.0.0.1", PGPORT: "41001" }, { MYSQL_DATABASE: "app_explore", MYSQL_USER: "app" }, { PGDATA: "./pg" }])("%j is fine", async (vars) => {
          expect(await check(vars as Record<string, string>, { files: "" })).toBe("ok");
        });
      });
      it("a file or socket inside the repo is refused; one in the worktree is not", async () => {
        expect(await check((m: string) => ({ X: `sqlite:///${m}/dev.db` }) as never)).toMatch(/^refused: env\.X points into the main checkout/);
        expect(await check((m: string) => ({ X: `file:${m}/prisma/dev.db` }) as never)).toMatch(/^refused: env\.X points into the main checkout/);
        expect(await check((m: string) => ({ DATA: `${m}/data` }) as never)).toMatch(/^refused: env\.DATA points into the main checkout/);
        expect(await check("file:./dev.db", { files: "DATABASE_URL=file:./dev.db\n" })).toBe("ok");
        expect(await check("sqlite:./data/app.db")).toBe("ok");
        expect(await check((m: string) => ({ X: `jdbc:sqlite:${m}/dev.db` }) as never)).toMatch(/^refused: env\.X points into the main checkout/);
        expect(await check((m: string) => ({ X: `file://localhost${m}/dev.db` }) as never)).toMatch(/^refused: env\.X points into the main checkout/);
        expect(await check((m: string) => ({ X: `file://${m}/dev.db` }) as never)).toMatch(/^refused: env\.X points into the main checkout/);
      });
      it("sqlite:///x is read both ways (relative, as SQLAlchemy does; absolute, as others do): refused when either reading hits", async () => {
        const same = /^refused: env\.X points at a file or socket the repo's env files name/;
        expect(await check("sqlite:///./dev.db", { files: "DATABASE_URL=sqlite:///./dev.db\n" })).toMatch(same);
        expect(await check("sqlite:///dev.db", { files: "DATABASE_URL=sqlite:///dev.db\n" })).toMatch(same);
        expect(await check("sqlite+pysqlite:///db/app.sqlite3", { files: "DATABASE_URL=sqlite:///db/app.sqlite3\n" })).toMatch(same);
        const dir = realpathSync(tempDir());
        expect(await check(`sqlite:////${dir}/dev.db`, { files: `DATABASE_URL=sqlite:////${dir}/dev.db\n` })).toMatch(same);
        expect(await check(`sqlite:///${dir.slice(1)}/dev.db`, { files: `DATABASE_URL=sqlite:///${dir}/dev.db\n` })).toMatch(same);
        expect(await check("sqlite:///./dev.db", { files: "DATABASE_URL=file:./dev.db\n" })).toBe("ok");
        expect(await check("sqlite:///other.db", { files: "DATABASE_URL=sqlite:///dev.db\n" })).toBe("ok");
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
      expect(await check({ [key]: "app_dev", PGHOST: "db.example.test" }, { contract: guard })).toBe("ok");
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
    /**
     * A git worktree stand-in holding Compose files (tracked unless `untracked`), and a fake `docker` on
     * PATH that appends how it ran (cwd, project, args) to `ran` and prints `json`.
     */
    const world = (json: unknown, { files = ["compose.yaml"] as string[], untracked = [] as string[], status = 0, stderr = "", bad = null as null | { when: string; json: unknown } } = {}) => {
      const wt = realpathSync(tempDir());
      const main = realpathSync(tempDir());
      const bin = tempDir();
      execFileSync("git", ["-C", wt, "init", "-q"]);
      for (const f of [...files, ...untracked]) {
        mkdirSync(join(wt, f, ".."), { recursive: true });
        writeFileSync(join(wt, f), "services: {}\n");
      }
      if (files.length) execFileSync("git", ["-C", wt, "add", ...files]);
      writeFileSync(join(bin, "out.json"), JSON.stringify(json));
      const docker = join(bin, "docker");
      if (bad) writeFileSync(join(bin, "bad.json"), JSON.stringify(bad.json));
      const out = bad ? `case "$*" in *${bad.when}*) cat ${JSON.stringify(join(bin, "bad.json"))} ;; *) cat ${JSON.stringify(join(bin, "out.json"))} ;; esac` : `cat ${JSON.stringify(join(bin, "out.json"))}`;
      writeFileSync(docker, `#!/bin/sh\nprintf '%s|%s|%s\\n' "$PWD" "$COMPOSE_PROJECT_NAME" "$*" >> ${JSON.stringify(join(bin, "ran"))}\nprintf '%s' ${JSON.stringify(stderr)} >&2\n${out}\nexit ${status}\n`);
      chmodSync(docker, 0o755);
      const env: Record<string, string> = { PATH: `${bin}:${process.env.PATH}`, COMPOSE_PROJECT_NAME: PROJECT };
      const set = (c: unknown) => writeFileSync(join(bin, "out.json"), JSON.stringify(c));
      const ran = () => (existsSync(join(bin, "ran")) ? readFileSync(join(bin, "ran"), "utf8").trim().split("\n") : []);
      return { wt, main, bin, env, set, ran, ports: { pg: 41001, web: 41002 } };
    };
    type World = ReturnType<typeof world>;
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
          environment: { POSTGRES_DB: "app_explore", PGHOST: "localhost", PGPORT: "5432", N: null },
          command: ["postgres", "-c", "listen_addresses=*"],
          cap_add: ["CHOWN", "CAP_SETUID"],
          networks: { default: null },
        },
        web: {
          image: "nginx",
          ports: [{ mode: "ingress", host_ip: "127.0.0.1", target: 80, published: "41002", protocol: "tcp" }],
          environment: { DATABASE_URL: "postgres://app@db:5432/app_explore", API: "http://localhost:8080/", HOST_API: "http://host.docker.internal:41002/" },
          volumes_from: ["db"],
        },
        sidecar: { image: "busybox", network_mode: "service:db", pid: "service:db" },
      },
      networks: { default: { name: `${PROJECT}_default`, ipam: {} } },
      volumes: { pgdata: { name: `${PROJECT}_pgdata` }, scratch: { name: `${PROJECT}_scratch`, driver: "local", driver_opts: { type: "none", o: "bind", device: `${wt}/scratch` } } },
      secrets: { s1: { name: `${PROJECT}_s1`, file: `${wt}/secrets/s1` } },
      configs: { c1: { name: `${PROJECT}_c1`, file: `${wt}/conf/c1` } },
    });
    const compose = (w: World, over: Obj = {}) => message(() => checkCompose({ worktree: w.wt, env: w.env, ports: w.ports, main: w.main, ...over }));

    it("a compliant project passes, returns its service names, and docker ran in the worktree under the instance env, every profile included", () => {
      const w = world(null);
      w.set(good(w.wt));
      expect(checkCompose({ worktree: w.wt, env: w.env, ports: w.ports, main: w.main })).toEqual(["db", "web", "sidecar"]);
      expect(w.ran()).toEqual([`${w.wt}|${PROJECT}|compose -f compose.yaml --profile * config --format json`]);
    });

    it("every tracked Compose file is found at any depth and read per directory; an untracked one at the root too", () => {
      const w = world(good(), { files: ["compose.override.yaml", "compose.yaml", "deploy/docker-compose.dev.yml", "deploy/compose-test.yml", "composer.yaml", "docs/compose.md"], untracked: ["docker-compose.yml"] });
      expect(compose(w)).toBe("ok");
      expect(w.ran().sort()).toEqual(
        [
          `${w.wt}|${PROJECT}|compose -f compose.yaml -f docker-compose.yml -f compose.override.yaml --profile * config --format json`,
          `${w.wt}/deploy|${PROJECT}|compose -f compose-test.yml -f docker-compose.dev.yml --profile * config --format json`,
        ].sort(),
      );
    });

    describe("compose_files names the files the instance uses", () => {
      const bad = () => {
        const c = good();
        c.services.db.container_name = "fixed";
        c.networks.ext = { name: "owner_net", external: true };
        return c;
      };
      const three = ["compose.yaml", "docker-compose.prod.yml", "examples/minimal/docker-compose.yml"];
      it("listed, only those files are merged and checked (the repro: a production file with container_name and an external network beside them)", () => {
        const w = world(good(), { files: three, bad: { when: "prod", json: bad() } });
        writeFileSync(join(w.wt, "docker-compose.prod.yml"), `services:\n  db:\n    container_name: fixed\n    env_file: [${w.main}/.env]\n`);
        expect(compose(w, { config: { compose_files: ["compose.yaml"] } })).toBe("ok");
        expect(w.ran()).toEqual([`${w.wt}|${PROJECT}|compose -f compose.yaml --profile * config --format json`]);
      });
      it("unlisted, every tracked file is checked (fail closed), and the refusal says to list compose_files", () => {
        const w = world(good(), { files: three, bad: { when: "prod", json: bad() } });
        expect(compose(w)).toMatch(/^refused: Compose service db sets container_name .*; list the files the instance uses in compose_files to check only those$/);
        writeFileSync(join(w.wt, "docker-compose.prod.yml"), `services:\n  db:\n    env_file: [${w.main}/.env]\n`);
        expect(compose(w)).toMatch(/^refused: docker-compose\.prod\.yml names a path inside the main checkout .*; list the files the instance uses in compose_files to check only those$/);
      });
      it("keeps the listed order (Compose's -f order) and runs from the worktree's root", () => {
        const w = world(good(), { files: ["compose.yaml", "compose.override.yaml", "deploy/stack.yml"] });
        expect(compose(w, { config: { compose_files: ["deploy/stack.yml", "compose.yaml"] } })).toBe("ok");
        expect(w.ran()).toEqual([`${w.wt}|${PROJECT}|compose -f deploy/stack.yml -f compose.yaml --profile * config --format json`]);
      });
      it("a listed file that git does not track is refused", () => {
        const w = world(good(), { files: ["compose.yaml"], untracked: ["local.yml"] });
        expect(compose(w, { config: { compose_files: ["compose.yaml", "local.yml"] } })).toBe("refused: compose_files names local.yml, which the worktree does not track");
      });
      it("without compose_files, a COMPOSE_FILE the instance env sets is authoritative: read as Compose reads it, at the root", () => {
        const w = world(good(), { files: three, bad: { when: "prod", json: bad() } });
        writeFileSync(join(w.wt, "docker-compose.prod.yml"), `services:\n  db:\n    env_file: [${w.main}/.env]\n`);
        expect(compose({ ...w, env: { ...w.env, COMPOSE_FILE: "compose.yaml" } })).toBe("ok");
        expect(w.ran()).toEqual([`${w.wt}|${PROJECT}|compose --profile * config --format json`]);
        writeFileSync(join(w.wt, "compose.yaml"), `services:\n  db:\n    env_file: [${w.main}/.env]\n`);
        expect(compose({ ...w, env: { ...w.env, COMPOSE_FILE: "compose.yaml" } })).toMatch(/^refused: compose\.yaml names a path inside the main checkout/);
      });
    });

    it("no Compose file: nothing to check, docker never runs", () => {
      const w = world(good(), { files: ["README.md"] });
      expect(checkCompose({ worktree: w.wt, env: w.env, ports: w.ports, main: w.main })).toEqual([]);
      expect(w.ran()).toEqual([]);
    });

    it("COMPOSE_FILE in the env, or in a .env the worktree tracks, is read as Compose reads it: at the root, with no -f", () => {
      const w = world(good(), { files: [] });
      expect(checkCompose({ worktree: w.wt, env: { ...w.env, COMPOSE_FILE: "elsewhere/dev.yml" }, ports: w.ports, main: w.main })).toEqual(["db", "web", "sidecar"]);
      expect(w.ran()).toEqual([`${w.wt}|${PROJECT}|compose --profile * config --format json`]);
      const v = world(good(), { files: [] });
      writeFileSync(join(v.wt, ".env"), "COMPOSE_FILE=elsewhere/dev.yml\n");
      expect(compose(v)).toBe("ok");
      expect(v.ran()).toHaveLength(1);
    });

    it("a tracked Compose file that names a path inside the main checkout (env_file, extends, include, ...) is refused", () => {
      const w = world(good());
      writeFileSync(join(w.wt, "compose.yaml"), `services:\n  web:\n    image: x\n    env_file: [${w.main}/.env]\n`);
      expect(compose(w)).toBe("refused: compose.yaml names a path inside the main checkout (Compose would read the owner's file); list the files the instance uses in compose_files to check only those");
      writeFileSync(join(w.wt, "compose.yaml"), `services:\n  web:\n    extends: { file: "${w.main}/base.yaml", service: base }\n`);
      expect(compose(w)).toMatch(/^refused: compose\.yaml names a path inside the main checkout/);
      for (const text of [`env_file: ${"$"}{ENV_FILE:-${w.main}/.env}`, `env_file: ${"$"}{ENV_FILE-${w.main}/.env}`, `image: x${w.main}/y`, `env_file: "${"$"}{X:=${w.main}}"`]) {
        writeFileSync(join(w.wt, "compose.yaml"), `services:\n  web:\n    ${text}\n`);
        expect(compose(w)).toMatch(/^refused: compose\.yaml names a path inside the main checkout/);
      }
      writeFileSync(join(w.wt, "compose.yaml"), `services:\n  web:\n    image: x\n    volumes: [./data:/data, /var/lib/x:/y, "${"$"}{DATA:-./data}:/d"]\n    command: http://example.test/a\n    working_dir: ${w.main}-other/x\n`);
      expect(compose(w)).toBe("ok");
    });

    const SOCKETS = (home: string) => [`${home}/Library/Containers/com.docker.docker/Data/docker.raw.sock`, `${home}/.docker/run/user-analytics.otlp.grpc.sock`, `${home}/Library/Containers/com.docker.docker/Data`, "/var/run/docker.sock", "/var/run", "/run", "/", `${home}/.docker/run`, "/run/containerd/containerd.sock", "/srv/podman.sock", "/tmp/.s.PGSQL.5432", "/var/run/postgresql"];
    const refusals: [string, (c: Obj, main: string) => void, RegExp][] = [
      ["a host port outside the run", (c) => (c.services.db.ports[0].published = "5432"), /^refused: Compose service db publishes host port 5432, which is not one of this run's ports/],
      ["a published range reaching outside the run", (c) => (c.services.db.ports[0].published = "41001-41003"), /^refused: Compose service db publishes host port 41003/],
      ["a random host port", (c) => delete c.services.db.ports[0].published, /^refused: Compose service db publishes container port 5432 on a random host port/],
      ["a container_name", (c) => (c.services.web.container_name = "web"), /^refused: Compose service web sets container_name/],
      ...(["host", "bridge", "container:owner-db-1"].map((m) => [`network_mode ${m}`, (c: Obj) => (c.services.web.network_mode = m), new RegExp(`^refused: Compose service web sets network_mode ${m}`)]) as [string, (c: Obj) => void, RegExp][]),
      ...(["pid", "ipc", "cgroup", "uts", "userns_mode"].map((k) => [`${k}: host`, (c: Obj) => (c.services.web[k] = "host"), new RegExp(`^refused: Compose service web sets ${k} host`)]) as [string, (c: Obj) => void, RegExp][]),
      ...(["pid", "ipc", "cgroup"].map((k) => [`${k}: container:`, (c: Obj) => (c.services.web[k] = "container:owner"), new RegExp(`^refused: Compose service web sets ${k} container:owner`)]) as [string, (c: Obj) => void, RegExp][]),
      ["volumes_from another container", (c) => c.services.web.volumes_from.push("container:owner-db-1"), /^refused: Compose service web sets volumes_from container:owner-db-1/],
      ["privileged", (c) => (c.services.web.privileged = true), /^refused: Compose service web is privileged/],
      ["devices", (c) => (c.services.web.devices = [{ source: "/dev/fuse", target: "/dev/fuse", permissions: "rwm" }]), /^refused: Compose service web maps host devices/],
      ["cap_add outside the allowlist", (c) => c.services.db.cap_add.push("NET_ADMIN"), /^refused: Compose service db adds capability NET_ADMIN/],
      ["cap_add ALL", (c) => (c.services.web.cap_add = ["ALL"]), /^refused: Compose service web adds capability ALL/],
      ["an external network", (c) => (c.networks.ext = { name: "owner_net", external: true }), /^refused: Compose network ext is external/],
      ["a network named outside the project", (c) => (c.networks.ext = { name: "owner_net" }), /^refused: Compose network ext is named owner_net, outside the project argus-run1/],
      ["an external volume", (c) => (c.volumes.pgdata = { name: "owner_pgdata", external: true }), /^refused: Compose volume pgdata is external/],
      ["a volume named outside the project", (c) => (c.volumes.pgdata = { name: "owner_pgdata" }), /^refused: Compose volume pgdata is named owner_pgdata, outside the project argus-run1/],
      ["a project named otherwise", (c) => (c.name = "owner"), /^refused: the Compose project is named owner, not argus-run1/],
      ["a bind mount from the main checkout", (c, main) => c.services.db.volumes.push({ type: "bind", source: `${main}/data`, target: "/y", bind: {} }), /^refused: Compose service db bind-mounts a path inside the main checkout/],
      ["a bind mount of a directory holding the main checkout", (c, main) => c.services.db.volumes.push({ type: "bind", source: join(main, ".."), target: "/y", bind: {} }), /^refused: Compose service db bind-mounts a path inside the main checkout \(or one holding it\)/],
      ["a local volume bound to the main checkout", (c, main) => (c.volumes.scratch.driver_opts.device = `${main}/x`), /^refused: Compose volume scratch binds a path inside the main checkout/],
      ["a local volume bound to /var/run", (c) => (c.volumes.scratch.driver_opts = { o: "bind,rw", device: "/var/run" }), /^refused: Compose volume scratch binds a container runtime or datastore socket/],
      ["a secret file from the main checkout", (c, main) => (c.secrets.s1.file = `${main}/.env`), /^refused: Compose secret s1 reads a file inside the main checkout/],
      ["a config file from the main checkout", (c, main) => (c.configs.c1.file = `${main}/conf`), /^refused: Compose config c1 reads a file inside the main checkout/],
      ["a build context in the main checkout", (c, main) => (c.services.web.build = { context: main, dockerfile: "Dockerfile" }), /^refused: Compose service web builds from a path inside the main checkout/],
      ...(["seccomp:unconfined", "seccomp=unconfined", "apparmor:unconfined", "label:disable", "label=disable", "systempaths=unconfined"].map((o) => [`security_opt ${o}`, (c: Obj) => (c.services.web.security_opt = ["no-new-privileges:true", o]), new RegExp(`^refused: Compose service web sets security_opt ${o}`)]) as [string, (c: Obj) => void, RegExp][]),
      ["extra_hosts to the Docker host", (c) => (c.services.web.extra_hosts = ["host.docker.internal=host-gateway"]), /^refused: Compose service web maps host\.docker\.internal to the Docker host/],
      ["extra_hosts to a bridge gateway", (c) => (c.services.web.extra_hosts = ["api:172.17.0.1"]), /^refused: Compose service web maps api to the Docker host/],
    ];
    it.each(refusals)("refuses %s", (_what, mutate, why) => {
      const w = world(null);
      const c = good(w.wt);
      mutate(c, w.main);
      w.set(c);
      expect(compose(w)).toMatch(why);
    });

    it.each(SOCKETS(process.env.HOME!))("refuses a bind mount of %s (a container runtime or datastore socket, or a directory holding one)", (src) => {
      const w = world(null);
      const c = good(w.wt);
      c.services.db.volumes.push({ type: "bind", source: src, target: "/s", bind: {} });
      w.set(c);
      expect(compose(w)).toMatch(/^refused: Compose service db bind-mounts a (container runtime or datastore socket, or a directory holding one|path inside the main checkout)/);
    });

    describe("the containers' own environment, command and entrypoint are compared like the instance env", () => {
      const owner = "DATABASE_URL=postgres://owner@db.internal.example:5432/app_dev\nCACHE=redis://cache.internal.example:6379\nLOCAL=postgres://owner@localhost:5432/app_dev\n";
      const run = (mutate: (c: Obj) => void, files = owner) => {
        const w = world(null);
        writeFileSync(join(w.main, ".env"), files);
        const c = good(w.wt);
        mutate(c);
        w.set(c);
        return compose(w);
      };
      it("loopback in a container is the container's own; a service name of the project is exempt", () => {
        expect(run(() => {})).toBe("ok");
      });
      it.each([
        [(c: Obj) => (c.services.web.environment.X = "postgres://u@db.internal.example:5432/other"), /^refused: compose\.web\.environment\.X points at a service the repo's env files name/],
        [(c: Obj) => (c.services.web.command = ["--cache", "redis://cache.internal.example:6379/2"]), /^refused: compose\.web\.command\.1 points at a service/],
        [(c: Obj) => (c.services.web.entrypoint = ["run", "--db=postgres://x@db.internal.example:5432/y"]), /^refused: compose\.web\.entrypoint\.1 points at a service/],
        [(c: Obj) => (c.services.web.environment.X = "postgres://u@host.docker.internal:5432/x"), /^refused: compose\.web\.environment\.X reaches the Docker host \(host\.docker\.internal\) on a port that is not the run's/],
        [(c: Obj) => (c.services.web.environment.X = "http://172.17.0.1:3000/"), /^refused: compose\.web\.environment\.X reaches the Docker host \(172\.17\.0\.1\)/],
        [(c: Obj) => Object.assign(c.services.web.environment, { REDIS_HOST: "gateway.docker.internal", REDIS_PORT: "6379" }), /^refused: compose\.web\.environment\.REDIS_HOST reaches the Docker host/],
        [(c: Obj) => (c.services.web.environment.X = "host.docker.internal"), /^refused: compose\.web\.environment\.X reaches the Docker host/],
      ])("%#: refused", (mutate, why) => {
        expect(run(mutate as (c: Obj) => void)).toMatch(why as RegExp);
      });
    });

    it("docker missing or failing is a refusal (fail closed), every secret masked", () => {
      const w = world(good());
      const empty = tempDir();
      expect(compose({ ...w, env: { ...w.env, PATH: `${empty}:/usr/bin:/bin` } })).toMatch(/^refused: compose\.yaml is in the worktree, but docker compose config could not read it: /);
      const f = world(good(), { status: 1, stderr: "bad interpolation near s3cret" });
      const m = compose(f, { secrets: { PW: "s3cret" } });
      expect(m).toMatch(/^refused: compose\.yaml is in the worktree, but docker compose config could not read it: .*bad interpolation near \*\*\*/);
      expect(m).not.toContain("s3cret");
      const j = world(good());
      writeFileSync(join(j.bin, "out.json"), "{oops");
      expect(compose(j)).toMatch(/^refused: .*not JSON/);
    });

    describe("commands of the config that would run Docker past the check", () => {
      const cfg = (over: Obj): Obj => ({ setup: [], store_check: "true", reset: "true", start: [{ name: "backing", phase: "store", cmd: "docker compose up -d", stop: "docker compose down -v" }], ...over });
      const at = (cmd: string) => ({ start: [{ name: "b", cmd }] });
      it.each([
        [{ start: [{ name: "backing", cmd: "docker compose up -d", stop: "docker compose -p owner down -v" }] }, /^refused: start\.backing\.stop passes -p to docker compose/],
        [at("docker-compose --file=../x.yml up"), /^refused: start\.b\.cmd passes --file to docker compose/],
        [at("docker compose -powner up"), /^refused: start\.b\.cmd passes -p to docker compose/],
        [at("docker compose \\-p owner down"), /^refused: start\.b\.cmd passes -p to docker compose/],
        [at('docker compose "-p" owner down'), /^refused: start\.b\.cmd passes -p to docker compose/],
        [at("docker compose -\\-project-name=o down"), /^refused: start\.b\.cmd passes --project-name to docker compose/],
        [at("docker compose $FLAGS up"), /^refused: start\.b\.cmd passes a variable where docker compose reads its flags/],
        [at("docker compose `flags` up"), /^refused: start\.b\.cmd passes a variable where docker compose reads its flags/],
        [{ reset: "cd x && docker compose --project-directory /srv/app exec db reset" }, /^refused: reset passes --project-directory to docker compose/],
        [{ setup: [["docker", "compose", "--env-file", "/x/.env", "pull"]] }, /^refused: setup\[0\] passes --env-file to docker compose/],
        [{ start: [{ name: "b", cmd: "docker compose up -d", health: { cmd: "docker compose --project-name=o ps" } }] }, /^refused: start\.b\.health\.cmd passes --project-name to docker compose/],
        [at("COMPOSE_PROJECT_NAME=owner docker compose down -v"), /^refused: start\.b\.cmd sets COMPOSE_PROJECT_NAME/],
        [at("env COMPOSE_FILE=../x.yml docker compose up"), /^refused: start\.b\.cmd sets COMPOSE_FILE/],
        [at("export DOCKER_HOST=tcp://10.0.0.1:2375; docker compose up"), /^refused: start\.b\.cmd sets DOCKER_HOST/],
        [at("unset DOCKER_CONFIG; docker compose up"), /^refused: start\.b\.cmd unsets DOCKER_CONFIG/],
        [at("docker run --rm -v pgdata:/d busybox"), /^refused: start\.b\.cmd runs docker run; only docker compose runs under the check/],
        [at("docker volume rm owner_pgdata"), /^refused: start\.b\.cmd runs docker volume/],
        [at("docker exec owner-db psql"), /^refused: start\.b\.cmd runs docker exec/],
        [at("docker --context remote compose up"), /^refused: start\.b\.cmd runs docker --context/],
        [at("sh -c 'docker rm -f owner-db'"), /^refused: start\.b\.cmd runs docker rm/],
        [{ roles: { admin: { login: { command: "/usr/local/bin/docker exec db login" } } } }, /^refused: roles\.admin\.login\.command runs docker exec/],
        [{ facts: { argv: ["docker", "exec", "db", "facts"] } }, /^refused: facts\.argv runs docker exec/],
      ])("%j is refused", (over, why) => {
        const w = world(good(), { files: [] });
        expect(compose(w, { config: cfg(over as Obj) })).toMatch(why as RegExp);
      });
      it.each([
        "docker compose up -d && docker compose logs -f web",
        "docker compose --profile dev up -d",
        "docker compose exec -T db pg_isready -p 5432",
        "tail -f log; rm -f x",
        "npm run docker:up",
        "command -v docker && docker compose up",
        "FOO=1 docker compose up",
      ])("%s passes", (cmd) => {
        const w = world(good(), { files: [] });
        expect(compose(w, { config: cfg(at(cmd)) })).toBe("ok");
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

  describe("the run's Docker client", () => {
    const owner = () => {
      const cfg = tempDir();
      mkdirSync(join(cfg, "cli-plugins"));
      writeFileSync(join(cfg, "cli-plugins", "docker-compose"), "#!/bin/sh\n");
      writeFileSync(join(cfg, "cli-plugins", "notes.txt"), "");
      writeFileSync(join(cfg, "config.json"), JSON.stringify({ auths: { "registry.example.test": { auth: "c2VjcmV0" } }, credsStore: "desktop", currentContext: "remote", cliPluginsExtraDirs: ["/opt/docker/cli-plugins"] }));
      return cfg;
    };
    const ctxJson = (host: string) => JSON.stringify([{ Name: "desktop-linux", Endpoints: { docker: { Host: host } } }]);
    it("DOCKER_CONFIG holds only plugin links and a config without credentials; DOCKER_HOST is the context's local socket", () => {
      const cfg = owner();
      const home = tempDir();
      const calls: Obj[] = [];
      const runner = (argv: string[], opts: Obj) => (calls.push({ argv, env: opts.env }), { status: 0, stdout: ctxJson("unix:///tmp/run/docker.sock"), stderr: "" });
      const d = dockerEnv({ home, runner, ownerEnv: { HOME: "/nowhere", DOCKER_CONFIG: cfg, PATH: "/usr/bin" } });
      expect(d).toEqual({ DOCKER_CONFIG: join(home, ".docker"), DOCKER_HOST: "unix:///tmp/run/docker.sock" });
      expect(calls[0].argv).toEqual(["docker", "context", "inspect"]);
      expect(calls[0].env.DOCKER_CONFIG).toBe(cfg);
      expect(JSON.parse(readFileSync(join(home, ".docker", "config.json"), "utf8"))).toEqual({ cliPluginsExtraDirs: ["/opt/docker/cli-plugins"] });
      expect(statSync(join(home, ".docker", "config.json")).mode & 0o777).toBe(0o600);
      expect(readdirSync(join(home, ".docker", "cli-plugins"))).toEqual(["docker-compose"]);
      expect(realpathSync(join(home, ".docker", "cli-plugins", "docker-compose"))).toBe(realpathSync(join(cfg, "cli-plugins", "docker-compose")));
    });
    it.each(["tcp://10.0.0.5:2376", "ssh://user@build.example.test", "npipe:////./pipe/docker_engine"])("a context at %s is refused, naming only its scheme", (host) => {
      const runner = () => ({ status: 0, stdout: ctxJson(host), stderr: "" });
      const m = message(() => dockerEnv({ home: tempDir(), runner, ownerEnv: { HOME: tempDir() } }));
      expect(m).toBe(`refused: the docker context desktop-linux is not a local unix socket (${host.split(":")[0]}); the instance uses only this machine's daemon`);
    });
    it("without docker on PATH, only DOCKER_CONFIG; a failing context inspect is refused", () => {
      const home = tempDir();
      const missing = () => ({ error: Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" }) });
      expect(dockerEnv({ home, runner: missing, ownerEnv: { HOME: tempDir() } })).toEqual({ DOCKER_CONFIG: join(home, ".docker") });
      const failing = () => ({ status: 1, stdout: "", stderr: "context not found" });
      expect(message(() => dockerEnv({ home: tempDir(), runner: failing, ownerEnv: { HOME: tempDir() } }))).toMatch(/^refused: docker context inspect failed: context not found/);
    });
    describe("compose_files reaches the instance's own Compose commands", () => {
      const base = { ports: {}, secrets: {}, runId: "20990101000000-0123abcd", home: "/h" };
      it("COMPOSE_FILE is the listed files joined with \":\", so a tracked compose.override.yaml is not read at runtime", () => {
        const wt = realpathSync(tempDir());
        execFileSync("git", ["-C", wt, "init", "-q"]);
        writeFileSync(join(wt, "compose.yaml"), "services: {}\n");
        writeFileSync(join(wt, "compose.override.yaml"), "services: {}\n");
        execFileSync("git", ["-C", wt, "add", "."]);
        expect(instanceEnv({ ...base, config: { env: {}, pass_env: [], compose_files: ["compose.yaml"] } }).COMPOSE_FILE).toBe("compose.yaml");
        expect(instanceEnv({ ...base, config: { compose_files: ["compose.yaml", "deploy/stack.yml"] } }).COMPOSE_FILE).toBe("compose.yaml:deploy/stack.yml");
        expect(instanceEnv({ ...base, config: { env: {} } }).COMPOSE_FILE).toBeUndefined();
      });
      it("COMPOSE_PATH_SEPARATOR is \":\" with it, so a tracked .env naming another separator cannot split the list elsewhere", () => {
        expect(instanceEnv({ ...base, config: { compose_files: ["compose.yaml", "deploy/stack.yml"] } })).toMatchObject({ COMPOSE_FILE: "compose.yaml:deploy/stack.yml", COMPOSE_PATH_SEPARATOR: ":" });
        expect(instanceEnv({ ...base, config: { env: {} } }).COMPOSE_PATH_SEPARATOR).toBeUndefined();
      });
      it("compose_files together with COMPOSE_FILE or COMPOSE_PATH_SEPARATOR in env, pass_env or a start entry's env is refused", () => {
        const cf = { compose_files: ["compose.yaml"] };
        for (const k of ["COMPOSE_FILE", "COMPOSE_PATH_SEPARATOR"]) {
          expect(message(() => instanceEnv({ ...base, config: { ...cf, env: { [k]: "x" } } }))).toBe(`refused: env may not set ${k} when compose_files is set (the run sets COMPOSE_FILE from it)`);
          expect(message(() => instanceEnv({ ...base, config: { ...cf, pass_env: [k] } }))).toBe(`refused: pass_env may not name ${k} when compose_files is set (the run sets COMPOSE_FILE from it)`);
          expect(message(() => instanceEnv({ ...base, config: { ...cf, start: [{ name: "db", cmd: "x", env: { [k]: "x" } }] } }))).toBe(`refused: start entry db may not set ${k} when compose_files is set (the run sets COMPOSE_FILE from it)`);
        }
        expect(message(() => instanceEnv({ ...base, config: { env: { COMPOSE_FILE: "x.yml" } } }))).toBe("ok");
      });
    });

    it("instanceEnv carries them, and refuses DOCKER_CONFIG, DOCKER_HOST or DOCKER_CONTEXT in env or pass_env", () => {
      const base = { ports: {}, secrets: {}, runId: "20990101000000-0123abcd", home: "/h" };
      const env = instanceEnv({ ...base, config: { env: {}, pass_env: [] }, docker: { DOCKER_CONFIG: "/h/.docker", DOCKER_HOST: "unix:///s.sock" } });
      expect(env).toMatchObject({ DOCKER_CONFIG: "/h/.docker", DOCKER_HOST: "unix:///s.sock" });
      for (const k of ["DOCKER_CONFIG", "DOCKER_HOST", "DOCKER_CONTEXT"]) {
        expect(message(() => instanceEnv({ ...base, config: { env: { [k]: "x" } } }))).toBe(`refused: env may not set ${k}`);
        expect(message(() => instanceEnv({ ...base, config: { pass_env: [k] } }))).toBe(`refused: pass_env may not name ${k}`);
      }
    });
  });

  describe("the Docker runtime gate", () => {
    const P = "argus-run1";
    const LABEL = "com.docker.compose.project";
    const T0 = Date.now();
    const at = (s: number) => new Date(T0 + s * 1000).toISOString();
    const NEVER = new Date(Date.UTC(1, 0, 1)).toISOString();
    type State = { containers: Obj[]; volumes: Obj[]; networks: Obj[]; events: Obj[] };
    /** A daemon event `s` seconds after T0, as `docker events --format json` prints it. */
    const ev = (Type: string, Action: string, ID: string, Attributes: Obj = {}, s = 20) => ({ Type, Action, Actor: { ID, Attributes }, time: Math.floor(T0 / 1000) + s, timeNano: (T0 + s * 1000) * 1e6 });
    const state = (): State => ({
      containers: [{ Id: "c1", Name: `/${P}-db-1`, Created: at(10), State: { StartedAt: at(11) }, Config: { Labels: { [LABEL]: P } }, Mounts: [{ Type: "volume", Name: `${P}_pgdata` }, { Type: "volume", Name: "anon1" }], NetworkSettings: { Networks: { [`${P}_default`]: {} } } }, { Id: "c0", Name: "/owner-db", Created: at(-3600), State: { StartedAt: at(-3600) }, Config: { Labels: { [LABEL]: "owner" }, Healthcheck: { Test: ["CMD-SHELL", "pg_isready -U owner"] } }, Mounts: [], NetworkSettings: { Networks: { owner_default: {} } } }],
      events: [
        ev("container", "create", "c1", { [LABEL]: P, name: `${P}-db-1` }, 10),
        ev("container", "exec_start: pg_isready", "c1", { [LABEL]: P, name: `${P}-db-1`, execID: "e1" }, 12),
        ev("container", "exec_create: /bin/sh -c pg_isready -U owner", "c0", { [LABEL]: "owner", name: "owner-db", execID: "e2" }, 13),
        ev("container", "exec_start: /bin/sh -c pg_isready -U owner", "c0", { [LABEL]: "owner", name: "owner-db", execID: "e2" }, 13),
        ev("container", "health_status: healthy", "c0", { [LABEL]: "owner", name: "owner-db" }, 13),
        ev("volume", "create", "f".repeat(64), { driver: "local" }, 10),
        ev("volume", "destroy", "f".repeat(64), { driver: "local" }, 50),
        ev("volume", "destroy", `${P}_pgdata`, { driver: "local" }, 50),
        ev("network", "destroy", "n1", { name: `${P}_default`, type: "bridge" }, 50),
      ],
      volumes: [{ Name: `${P}_pgdata`, CreatedAt: at(10), Labels: { [LABEL]: P } }, { Name: "anon1", CreatedAt: at(10), Labels: { "com.docker.volume.anonymous": "" } }, { Name: "owner_pgdata", CreatedAt: at(-3600), Labels: { [LABEL]: "owner" } }, { Name: "old_anon", CreatedAt: at(-3600), Labels: { "com.docker.volume.anonymous": "" } }],
      networks: [{ Id: "n1", Name: `${P}_default`, Created: at(10), Labels: { [LABEL]: P } }, { Id: "n0", Name: "bridge", Created: at(-86400), Labels: {} }, { Id: "n2", Name: "none", Created: at(-86400), Labels: {} }, { Id: "n3", Name: "owner_default", Created: at(-3600), Labels: { [LABEL]: "owner" } }],
    });
    /** A fake docker over `s`: `ps`, `inspect --type container`, `volume ls|inspect`, `network ls|inspect`. */
    const fake = (s: State, calls: Obj[] = []) => (argv: string[], opts: Obj = {}) => {
      calls.push({ argv, env: opts.env });
      const a = argv.slice(1).join(" ");
      const pick = (list: Obj[], key: string) => JSON.stringify(list.filter((x) => argv.includes(x[key])));
      const ok = (stdout: string) => ({ status: 0, stdout, stderr: "" });
      if (a === "ps -aq --no-trunc") return ok(s.containers.map((c) => c.Id).join("\n"));
      if (a.startsWith("inspect --type container")) return ok(pick(s.containers, "Id"));
      if (a === "volume ls -q") return ok(s.volumes.map((v) => v.Name).join("\n"));
      if (a.startsWith("volume inspect")) return ok(pick(s.volumes, "Name"));
      if (a === "network ls -q --no-trunc") return ok(s.networks.map((n) => n.Id).join("\n"));
      if (a.startsWith("network inspect")) return ok(pick(s.networks, "Id"));
      if (a === "info --format {{json .SystemTime}}") return ok(JSON.stringify(at(60)));
      if (a.startsWith("events ")) return ok(s.events.map((e) => JSON.stringify(e)).join("\n"));
      return { status: 1, stdout: "", stderr: `unexpected ${a}` };
    };
    const gate = (s: State, over: Obj = {}) => {
      const main = realpathSync(tempDir());
      const worktree = realpathSync(tempDir());
      return message(() => checkDockerRuntime({ since: T0, env: { COMPOSE_PROJECT_NAME: P, DOCKER_HOST: "unix:///x.sock" }, main, worktree, runner: fake(s), ...over }));
    };

    it("the run's own containers, volumes (named and new anonymous ones) and networks pass; the owner's untouched ones are not looked at", () => {
      const calls: Obj[] = [];
      expect(message(() => checkDockerRuntime({ since: T0, env: { COMPOSE_PROJECT_NAME: P, DOCKER_HOST: "unix:///x.sock" }, main: tempDir(), worktree: tempDir(), runner: fake(state(), calls) }))).toBe("ok");
      expect(calls.every((c) => c.argv[0] === "docker" && c.env.DOCKER_HOST === "unix:///x.sock")).toBe(true);
    });

    it.each([
      ["a container created during the cycle outside the project", (s: State) => s.containers.push({ Id: "c2", Name: "/scratch", Created: at(20), State: { StartedAt: NEVER }, Config: { Labels: {} }, Mounts: [], NetworkSettings: { Networks: { bridge: {} } } }), /^refused: container scratch was created or started during the cycle and is not of the run's Compose project argus-run1/],
      ["an owner's container started during the cycle", (s: State) => (s.containers[1].State.StartedAt = at(30)), /^refused: container owner-db was created or started during the cycle/],
      ["a run container mounting the owner's volume", (s: State) => s.containers[0].Mounts.push({ Type: "volume", Name: "owner_pgdata" }), /^refused: container argus-run1-db-1 mounts volume owner_pgdata, which is not the run's/],
      ["a run container mounting an old anonymous volume", (s: State) => s.containers[0].Mounts.push({ Type: "volume", Name: "old_anon" }), /^refused: container argus-run1-db-1 mounts volume old_anon/],
      ["a run container on the default bridge", (s: State) => (s.containers[0].NetworkSettings.Networks.bridge = {}), /^refused: container argus-run1-db-1 joins network bridge, which is not the run's/],
      ["a run container on the owner's network", (s: State) => (s.containers[0].NetworkSettings.Networks.owner_default = {}), /^refused: container argus-run1-db-1 joins network owner_default/],
      ["a run container bind-mounting the Docker socket", (s: State) => s.containers[0].Mounts.push({ Type: "bind", Source: "/var/run/docker.sock" }), /^refused: container argus-run1-db-1 bind-mounts a container runtime or datastore socket/],
      ["a volume created during the cycle outside the project", (s: State) => s.volumes.push({ Name: "loose", CreatedAt: at(5), Labels: null }), /^refused: volume loose was created during the cycle and is not the run's/],
      ["a network created during the cycle outside the project", (s: State) => s.networks.push({ Id: "n9", Name: "loose_net", Created: at(5), Labels: {} }), /^refused: network loose_net was created during the cycle and is not the run's/],
    ])("refuses %s", (_what, mutate, why) => {
      const s = state();
      (mutate as (s: State) => void)(s);
      expect(gate(s)).toMatch(why as RegExp);
    });

    it("a run container that is privileged, or publishes a host port that is not the run's (or a random one), is refused", () => {
      const run = (hc: Obj) => {
        const s = state();
        s.containers[0].HostConfig = hc;
        return gate(s, { ports: { pg: 41001, web: 41002 } });
      };
      expect(run({ Privileged: false, PortBindings: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "41001" }] } })).toBe("ok");
      expect(run({ Privileged: true })).toMatch(/^refused: container argus-run1-db-1 is privileged$/);
      expect(run({ PortBindings: { "5432/tcp": [{ HostIp: "", HostPort: "5432" }] } })).toMatch(/^refused: container argus-run1-db-1 publishes host port 5432, which is not one of this run's ports$/);
      expect(run({ PortBindings: { "5432/tcp": [{ HostIp: "", HostPort: "" }] } })).toMatch(/^refused: container argus-run1-db-1 publishes container port 5432\/tcp on a random host port$/);
    });

    it("a run container started with -P (PublishAllPorts), or whose live bindings hold a port that is not the run's, is refused", () => {
      const run = (hc: Obj, live: Obj | undefined) => {
        const s = state();
        s.containers[0].HostConfig = hc;
        if (live !== undefined) s.containers[0].NetworkSettings.Ports = live;
        return gate(s, { ports: { pg: 41001 } });
      };
      // As the daemon reports `docker run -P`: no PortBindings, the random ports only in NetworkSettings.Ports.
      expect(run({ PublishAllPorts: true, PortBindings: {} }, { "80/tcp": [{ HostIp: "0.0.0.0", HostPort: "55002" }] })).toMatch(/^refused: container argus-run1-db-1 publishes every exposed port on a random host port \(-P\)$/);
      expect(run({ PublishAllPorts: true, PortBindings: {} }, {})).toMatch(/^refused: container argus-run1-db-1 publishes every exposed port/);
      expect(run({ PortBindings: {} }, { "80/tcp": [{ HostIp: "0.0.0.0", HostPort: "55002" }] })).toMatch(/^refused: container argus-run1-db-1 publishes host port 55002, which is not one of this run's ports$/);
      // An exposed port nothing publishes (older daemons list it as null) and the run's own binding pass.
      expect(run({ PortBindings: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "41001" }] } }, { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "41001" }], "6379/tcp": null })).toBe("ok");
    });

    it("a run container bind-mounting the main checkout is refused; one on none, or binding the worktree, passes", () => {
      const main = realpathSync(tempDir());
      const worktree = realpathSync(tempDir());
      const s = state();
      s.containers[0].NetworkSettings.Networks.none = {};
      s.containers[0].Mounts.push({ Type: "bind", Source: `${worktree}/data` });
      const run = () => message(() => checkDockerRuntime({ since: T0, env: { COMPOSE_PROJECT_NAME: P }, main, worktree, runner: fake(s) }));
      expect(run()).toBe("ok");
      s.containers[0].Mounts.push({ Type: "bind", Source: `${main}/data` });
      expect(run()).toMatch(/^refused: container argus-run1-db-1 bind-mounts a path inside the main checkout/);
    });

    it("reads the daemon's events between since and the daemon's now, for the three object types", () => {
      const calls: Obj[] = [];
      expect(message(() => checkDockerRuntime({ since: T0, env: { COMPOSE_PROJECT_NAME: P }, main: tempDir(), worktree: tempDir(), runner: fake(state(), calls) }))).toBe("ok");
      const events = calls.find((c) => c.argv[1] === "events")!.argv;
      expect(events).toEqual(["docker", "events", "--since", ((T0 - 1000) / 1000).toFixed(3), "--until", ((T0 + 60000) / 1000).toFixed(3), "--format", "{{json .}}", "--filter", "type=container", "--filter", "type=volume", "--filter", "type=network"]);
    });

    it.each([
      ["an exec into the owner's container", ev("container", "exec_create: psql -c drop", "c0", { [LABEL]: "owner", name: "owner-db" }), /^refused: during the cycle, docker exec_create hit container owner-db, which is not of the run's Compose project argus-run1$/],
      ["an exec into an unlabelled container", ev("container", "exec_start: sh", "c9", { name: "other" }), /^refused: during the cycle, docker exec_start hit container other/],
      ...(["kill", "stop", "die", "destroy"].map((a) => [`${a} on the owner's container`, ev("container", a, "c0", { [LABEL]: "owner", name: "owner-db" }), new RegExp(`^refused: during the cycle, docker ${a} hit container owner-db`)]) as [string, Obj, RegExp][]),
      ["the owner's volume destroyed", ev("volume", "destroy", "owner_pgdata", { driver: "local" }), /^refused: during the cycle, docker destroy hit volume owner_pgdata, which is not the run's$/],
      ["an old anonymous volume destroyed", ev("volume", "destroy", "e".repeat(64), { driver: "local" }), /^refused: during the cycle, docker destroy hit volume e{64}/],
      ["the owner's network destroyed", ev("network", "destroy", "n3", { name: "owner_default", type: "bridge" }), /^refused: during the cycle, docker destroy hit network owner_default, which is not the run's$/],
      ["a copy out of the owner's container (docker cp)", ev("container", "archive-path", "c0", { [LABEL]: "owner", name: "owner-db" }), /^refused: during the cycle, docker archive-path hit container owner-db/],
      ["a copy into the owner's container (docker cp)", ev("container", "extract-to-dir", "c0", { [LABEL]: "owner", name: "owner-db" }), /^refused: during the cycle, docker extract-to-dir hit container owner-db/],
    ])("refuses %s", (_what, event, why) => {
      const s = state();
      s.events.push(event as Obj);
      expect(gate(s)).toMatch(why as RegExp);
    });

    it("an exec that is the container's own healthcheck is not an action on it (CMD and CMD-SHELL forms)", () => {
      const s = state();
      s.containers[1].Config.Healthcheck = { Test: ["CMD", "pg_isready", "-U", "owner"] };
      s.events = [ev("container", "exec_start: pg_isready -U owner", "c0", { [LABEL]: "owner", name: "owner-db" })];
      expect(gate(s)).toBe("ok");
      s.events.push(ev("container", "exec_start: pg_isready -U owner; rm -rf /", "c0", { [LABEL]: "owner", name: "owner-db" }));
      expect(gate(s)).toMatch(/^refused: during the cycle, docker exec_start hit container owner-db/);
    });

    it("daemonNow reads the daemon's clock; no docker or no daemon gives null", () => {
      expect(daemonNow({ env: {}, runner: fake(state()) })).toBe(T0 + 60000);
      expect(daemonNow({ env: {}, runner: () => ({ error: Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" }) }) })).toBeNull();
      expect(daemonNow({ env: {}, runner: () => ({ status: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" }) })).toBeNull();
    });

    it("no docker, or no daemon running: nothing was created through it; any other failure is refused", () => {
      expect(gate(state(), { runner: () => ({ error: Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" }) }) })).toBe("ok");
      expect(gate(state(), { runner: () => ({ status: 1, stdout: "", stderr: "Cannot connect to the Docker daemon at unix:///x.sock. Is the docker daemon running?" }) })).toBe("ok");
      expect(gate(state(), { runner: () => ({ status: 1, stdout: "", stderr: "permission denied" }) })).toMatch(/^refused: docker ps -aq --no-trunc failed: permission denied/);
      const s = state();
      const f = fake(s);
      expect(gate(s, { runner: (argv: string[], o: Obj) => (argv[1] === "volume" && argv[2] === "inspect" ? { status: 1, stdout: "", stderr: "boom" } : f(argv, o)) })).toMatch(/^refused: docker volume inspect failed: boom/);
    });
  });

  describe("egress", () => {
    const NODE = JSON.stringify(process.execPath);
    const freePort = () =>
      new Promise<number>((done) => {
        const s = createServer();
        s.listen(0, "127.0.0.1", () => {
          const p = (s.address() as { port: number }).port;
          s.close(() => done(p));
        });
      });
    const listen = (port: number | string = 0) =>
      new Promise<number>((done, fail) => {
        const s = createServer((c) => c.on("error", () => {}));
        s.once("error", fail);
        const ready = () => {
          servers.push(s);
          done(typeof port === "string" ? 0 : (s.address() as { port: number }).port);
        };
        if (typeof port === "string") s.listen(port, ready);
        else s.listen(port, "127.0.0.1", ready);
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
    /** Starts `node -e <code>` as a run entry (alive after 300 ms); returns its pids and worktree. */
    const startNode = async (code: string) => {
      const wt = tempDir();
      const entry = { name: "client", cmd: `exec ${NODE} -e ${JSON.stringify(`${code}; setInterval(() => {}, 1 << 30)`)}` };
      const s = await startEntry(entry, { worktree: wt, env: { PATH: process.env.PATH! }, logs: join(wt, "logs"), groups });
      await waitHealth(entry, s, { worktree: wt, env: {}, timeoutS: 5, aliveAfterMs: 300 });
      return { wt, pids: groupPids([s.pgid]) };
    };

    it("the fixture's cache fallback to a fixed local port is refused, naming the process and 46379", async () => {
      await listen(46379);
      const a = await startApp({});
      const allowed = egressAllowed({ config: { start: [a.entry], allow_origins: [] }, env: a.base, ports: { web: a.web } });
      expect(await message(checkEgress({ pids: a.pids, allowed, samples: 1, expectListen: [a.web] }))).toMatch(/^refused: node \(\d+\) connects to 127\.0\.0\.1:46379$/);
    });

    it("CACHE_URL pointing at a run port passes (the health request it answered is inbound, not egress)", async () => {
      const cache = await listen();
      const a = await startApp({ CACHE_URL: `tcp://127.0.0.1:${cache}` });
      const allowed = egressAllowed({ config: { start: [a.entry], allow_origins: [] }, env: a.base, ports: { web: a.web, cache } });
      expect(await message(checkEgress({ pids: a.pids, allowed, samples: 2, intervalMs: 100, expectListen: [a.web] }))).toBe("ok");
    });

    it("a loopback endpoint the env names but the run did not allocate is refused: loopback is allowed only on the run's ports", async () => {
      const cache = await listen();
      const a = await startApp({ CACHE_URL: `tcp://localhost:${cache}` });
      const allowed = egressAllowed({ config: { start: [a.entry] }, env: a.base, ports: { web: a.web } });
      expect(await message(checkEgress({ pids: a.pids, allowed, samples: 1 }))).toMatch(new RegExp(`^refused: node \\(\\d+\\) connects to 127\\.0\\.0\\.1:${cache}$`));
    });

    it("a connection made after the first look is caught by a later sample", async () => {
      await listen(46379);
      const c = await startNode(`setTimeout(() => require("net").connect(46379, "127.0.0.1").on("error", () => {}), 800)`);
      expect(await message(checkEgress({ pids: c.pids, allowed: [], samples: 1 }))).toBe("ok");
      expect(await message(checkEgress({ pids: c.pids, allowed: [], samples: 5, intervalMs: 500 }))).toMatch(/^refused: node \(\d+\) connects to 127\.0\.0\.1:46379$/);
    });

    it("waitHealth runs the egress sample it is given while it waits", async () => {
      const wt = tempDir();
      const entry = { name: "w", cmd: `exec ${NODE} -e "setInterval(() => {}, 1 << 30)"` };
      const s = await startEntry(entry, { worktree: wt, env: { PATH: process.env.PATH! }, logs: join(wt, "logs"), groups });
      let n = 0;
      await waitHealth(entry, s, { worktree: wt, env: {}, timeoutS: 5, aliveAfterMs: 400, egress: async () => void n++ });
      expect(n).toBeGreaterThan(0);
      const t = await startEntry({ ...entry, name: "w2" }, { worktree: wt, env: { PATH: process.env.PATH! }, logs: join(wt, "logs"), groups });
      expect(await message(waitHealth({ ...entry, name: "w2" }, t, { worktree: wt, env: {}, timeoutS: 5, aliveAfterMs: 400, egress: async () => { throw new Error("refused: x (1) connects to 127.0.0.1:6379"); } }))).toBe("refused: x (1) connects to 127.0.0.1:6379");
    });

    describe("unix sockets", () => {
      it("a connection to a datastore's socket outside the run is refused, naming it; one inside the run, or to another socket, passes", async () => {
        const dir = realpathSync(tempDir());
        const pg = join(dir, ".s.PGSQL.41999");
        await listen(pg);
        const c = await startNode(`require("net").connect(${JSON.stringify(pg)})`);
        expect(await message(checkEgress({ pids: c.pids, allowed: [], samples: 1 }))).toMatch(new RegExp(`^refused: node \\(\\d+\\) connects to the socket ${pg.replace(/[.]/g, "\\.")}$`));
        expect(await message(checkEgress({ pids: c.pids, allowed: [], samples: 1, runDirs: [dir] }))).toBe("ok");
        const app = join(dir, "app.sock");
        await listen(app);
        const d = await startNode(`require("net").connect(${JSON.stringify(app)})`);
        expect(await message(checkEgress({ pids: d.pids, allowed: [], samples: 1 }))).toBe("ok");
      });

      it("any socket in a directory the owner's env files name for a socket, or inside the main checkout, is refused", async () => {
        const dir = realpathSync(tempDir());
        const main = realpathSync(tempDir());
        writeFileSync(join(main, ".env"), `REDIS_URL=unix://${dir}/redis-6379.sock\n`);
        const other = join(dir, "x.sock");
        await listen(other);
        const c = await startNode(`require("net").connect(${JSON.stringify(other)})`);
        expect(await message(checkEgress({ pids: c.pids, allowed: [], samples: 1 }))).toBe("ok");
        expect(await message(checkEgress({ pids: c.pids, allowed: [], samples: 1, main }))).toMatch(/connects to the socket .*x\.sock$/);
        const inMain = join(main, "app.sock");
        await listen(inMain);
        const d = await startNode(`require("net").connect(${JSON.stringify(inMain)})`);
        expect(await message(checkEgress({ pids: d.pids, allowed: [], samples: 1, main }))).toMatch(/connects to the socket .*app\.sock$/);
      });

      it("a server lsof cannot see (another user's) is named through netstat -an -f unix, whose addresses are lsof's", async () => {
        const lsofU = "p700\ncnode\nf21\nd0x1111\nn->0xaaaa\nf22\nd0x2222\nn->0xbbbb\n";
        const netstat = [
          "Active LOCAL (UNIX) domain sockets",
          "Address          Type   Recv-Q Send-Q            Inode             Conn             Refs          Nextref Addr",
          "aaaa stream      0      0                0 1111                0                0 /var/run/postgresql/.s.PGSQL.5432",
          "bbbb stream      0      0                0 2222                0                0",
        ].join("\n");
        const runner = (argv: string[]) =>
          argv[0] === "netstat" ? { status: 0, stdout: netstat, stderr: "" } : argv[0] === "lsof" ? { status: 0, stdout: argv.includes("-U") ? lsofU : "", stderr: "" } : { error: Object.assign(new Error("ENOENT"), { code: "ENOENT" }) };
        expect(await message(checkEgress({ pids: [700], allowed: [], samples: 1, runner }))).toBe("refused: node (700) connects to the socket /var/run/postgresql/.s.PGSQL.5432");
      });

      it("live: with the server's own lsof records hidden, netstat still names the socket", async () => {
        const dir = realpathSync(tempDir());
        const pg = join(dir, ".s.PGSQL.41998");
        await listen(pg);
        const c = await startNode(`require("net").connect(${JSON.stringify(pg)})`);
        const hide = (out: string) => out.split(/(?=^p\d+$)/m).filter((b) => !b.startsWith(`p${process.pid}\n`)).join("");
        const runner = (argv: string[], o: Obj = {}) => {
          const r = run(argv, o);
          return argv[0] === "lsof" && argv.includes("-U") ? { ...r, stdout: hide(r.stdout) } : r;
        };
        expect(await message(checkEgress({ pids: c.pids, allowed: [], samples: 1, runner }))).toMatch(new RegExp(`connects to the socket ${pg.replace(/[.]/g, "\\.")}$`));
        // A netstat that fails is reported on macOS, where it is the only way to see another user's server.
        const blind = (argv: string[], o: Obj = {}) => (argv[0] === "netstat" ? { status: 1, stdout: "", stderr: "netstat: sysctl: Operation not permitted" } : runner(argv, o));
        const said = await message(checkEgress({ pids: c.pids, allowed: [], samples: 1, runner: blind }));
        if (process.platform === "darwin") expect(said).toBe("failed: netstat -an -f unix exited 1: netstat: sysctl: Operation not permitted");
        else expect(said).toBe("ok");
      });

      it("reads ss -xp on Linux: a client's peer inode leads to the server's path", async () => {
        const ssx = [
          'u_str LISTEN 0 128 /var/run/postgresql/.s.PGSQL.5432 1000 * 0 users:(("postgres",pid=50,fd=5))',
          'u_str ESTAB 0 0 /var/run/postgresql/.s.PGSQL.5432 1002 * 1001 users:(("postgres",pid=51,fd=9))',
          'u_str ESTAB 0 0 * 1001 * 1002 users:(("node",pid=700,fd=21))',
          'u_str ESTAB 0 0 * 1003 * 1004 users:(("node",pid=700,fd=22))',
          'u_str ESTAB 0 0 @/containerd-shim/abc 1004 * 1003',
        ].join("\n");
        const runner = (argv: string[]) => (argv[0] === "lsof" ? { error: Object.assign(new Error("ENOENT"), { code: "ENOENT" }) } : argv.includes("-xapH") ? { status: 0, stdout: ssx, stderr: "" } : { status: 0, stdout: "", stderr: "" });
        expect(await message(checkEgress({ pids: [700], allowed: [], samples: 1, runner }))).toBe("refused: node (700) connects to the socket /var/run/postgresql/.s.PGSQL.5432");
        expect(await message(checkEgress({ pids: [701], allowed: [], samples: 1, runner }))).toBe("ok");
      });
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
      expect(await message(checkEgress({ pids: [process.pid], allowed: [], runner, samples: 1 }))).toBe("refused: neither lsof nor ss is available");
    });

    it("a listing that cannot be trusted fails: lsof exiting 1 with an error, or no listener of the run in it", async () => {
      const lsof = (stdout: string, status = 0, stderr = "") => (argv: string[]) => (argv[0] === "lsof" ? { status, stdout: argv.includes("-U") ? "" : stdout, stderr } : argv[0] === "netstat" ? { status: 0, stdout: "", stderr: "" } : { error: Object.assign(new Error("ENOENT"), { code: "ENOENT" }) });
      expect(await message(checkEgress({ pids: [700], allowed: [], samples: 1, runner: lsof("", 1, "lsof: unsupported option -F\n") }))).toMatch(/^failed: lsof exited 1: lsof: unsupported option/);
      expect(await message(checkEgress({ pids: [700], allowed: [], samples: 1, runner: lsof("", 1, "lsof: WARNING: can't stat() fuse file system /run/user/1/doc\n") }))).toBe("ok");
      const listing = "p700\ncnode\nf20\nn127.0.0.1:41002\nTST=LISTEN\n";
      expect(await message(checkEgress({ pids: [700], allowed: [], samples: 1, expectListen: [41002], runner: lsof(listing) }))).toBe("ok");
      expect(await message(checkEgress({ pids: [700], allowed: [], samples: 1, expectListen: [41003], runner: lsof(listing) }))).toBe("failed: the socket listing shows no listener of the run on 41003; it cannot be trusted");
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
      const ssOnly = (text: string) => (argv: string[]) => (argv[0] === "lsof" ? { error: Object.assign(new Error("spawn lsof ENOENT"), { code: "ENOENT" }) } : argv.includes("-xapH") ? { status: 0, stdout: "", stderr: "" } : { status: 0, stdout: text, stderr: "" });
      const lookup = async (host: string) => (host === "api.example.test" ? [{ address: "93.184.216.34", family: 4 }] : []);
      const opts = { samples: 1, lookup };
      expect(await message(checkEgress({ pids: [700, 701, 702], allowed: ["loopback:41001", "api.example.test:443"], runner: ssOnly(ss), ...opts }))).toBe("ok");
      expect(await message(checkEgress({ pids: [700, 701, 702], allowed: ["loopback:41001"], runner: ssOnly(ss), ...opts }))).toBe("refused: node (700) connects to [::ffff:93.184.216.34]:443");
      expect(await message(checkEgress({ pids: [702], allowed: ["loopback:41001", "loopback:41002", "api.example.test:443"], runner: ssOnly(ss.replace("pid=999", "pid=702")), ...opts }))).toBe("refused: other (702) connects to 127.0.0.1:6379");
    });

    it("allowed endpoints: the run's ports on loopback, non-loopback endpoints the env names, allow_origins, and anything pass_env names", () => {
      const allowed = egressAllowed({
        config: { allow_origins: ["https://fonts.example.test", "http://localhost:3000"], start: [{ name: "w", env: { API: "http://[::1]:41009/x", PAY: "https://pay.example.test/v1" } }], pass_env: ["HTTPS_PROXY"] },
        env: { DB: "postgres://app@localhost:5432/app_explore", REDIS_HOST: "127.0.0.1", REDIS_PORT: "41003", SQLITE: "sqlite:///x.db", MQ: "amqp://mq.example.test", HTTPS_PROXY: "http://127.0.0.1:8888" },
        ports: { web: 41002 },
      });
      expect([...allowed].sort()).toEqual(["fonts.example.test:443", "loopback:41002", "loopback:8888", "mq.example.test:5672", "pay.example.test:443"].sort());
    });
  });
});

describe("argus-live instance — run files, reaper, down, recovery", () => {
  const SERVER = join(__dirname, "fixtures/journey-app/server.mjs");
  const app = (args = "") => `${JSON.stringify(process.execPath)} ${JSON.stringify(SERVER)}${args ? ` ${args}` : ""}`;
  const saved = { ...process.env };
  /** Processes (and groups) a test started: killed after it, whatever it asserted. */
  const started: number[] = [];
  let tmp = "";
  beforeEach(() => {
    // Every worktree and HOME goes under $TMPDIR/sapu-live: a private TMPDIR per test (the reaper inherits it).
    tmp = tempDir();
    process.env.TMPDIR = tmp;
  });
  afterEach(() => {
    for (const p of started.splice(0)) {
      for (const target of [-p, p]) {
        try {
          process.kill(target, "SIGKILL");
        } catch {
          // gone already
        }
      }
    }
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    for (const [k, v] of Object.entries(saved)) if (process.env[k] !== v) process.env[k] = v;
  });
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  const committed = () => {
    const main = tempDir();
    git(main, "init", "-q");
    writeFileSync(join(main, "app.txt"), "app\n");
    git(main, "add", ".");
    git(main, "-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", "commit", "-qm", "init");
    return main;
  };
  const freePort = () =>
    new Promise<number>((done) => {
      const s = createServer();
      s.listen(0, "127.0.0.1", () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => done(p));
      });
    });
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "EPERM";
    }
  };
  const until = async (ok: () => boolean, ms: number) => {
    const end = Date.now() + ms;
    while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    return ok();
  };
  const now = () => Math.floor(Date.now() / 1000);
  const liveFiles = (main: string) => readdirSync(join(main, ".argus/live")).sort();
  const logOf = (main: string) => readFileSync(join(main, ".git/sapu-live.log"), "utf8").trim().split("\n");
  const setLock = (main: string, lock: { runId: string; start: number; deadline: number }) => writeFileSync(join(main, ".argus/live/lock.json"), `${JSON.stringify(lock)}\n`);
  const runJson = (main: string) => JSON.parse(readFileSync(join(main, ".argus/live/run.json"), "utf8"));
  /** A detached process group, as startEntry or runSetup leave one: `/bin/sh -c <cmd>`. */
  const group = (cmd: string) => {
    const p = spawn("/bin/sh", ["-c", cmd], { detached: true, stdio: "ignore" });
    started.push(p.pid!);
    return p.pid!;
  };
  /** A run as `up` leaves it before its run files: the lock, a worktree, a HOME, a setup log. */
  const liveRun = () => {
    const main = committed();
    const l = takeLock(main, { maxCycleMinutes: 45 });
    const wt = makeWorktree(main, l.runId);
    const home = makeHome(main, l.runId);
    writeFileSync(`${wt}.setup.log`, "setup output\n");
    const env = { PATH: process.env.PATH!, HOME: home, COMPOSE_PROJECT_NAME: `argus-${l.runId}` };
    return { main, runId: l.runId as string, wt, home, env, lock: l };
  };
  const SECRETS = { PW: "s3cr3t-value-9q" };

  it("writeRunFiles writes run.json (mode 0600) with the run's record; each group's command line is the one ps shows", async () => {
    const r = liveRun();
    const port = await freePort();
    const groups: Obj[] = [];
    const stops: Obj[] = [];
    const entry = { name: "app", cmd: app(), stop: "true", env: { PORT: String(port) }, health: { url: `http://127.0.0.1:${port}/health` } };
    const s = await startEntry(entry, { worktree: r.wt, env: r.env, logs: logsDir(r.main, r.runId), groups, stops });
    started.push(s.pgid);
    await waitHealth(entry, s, { timeoutS: 20, worktree: r.wt, env: r.env });
    expect(stops).toEqual([{ name: "app", cmd: "true", cwd: r.wt, env: { ...r.env, PORT: String(port) } }]);
    writeRunFiles(r.main, { runId: r.runId, instanceId: "i-1", worktree: r.wt, ports: { app: port }, origins: [`http://localhost:${port}`], groups, stops, env: r.env, since: 1 });
    const rec = runJson(r.main);
    expect(statSync(join(r.main, ".argus/live/run.json")).mode & 0o777).toBe(0o600);
    expect(rec).toMatchObject({ runId: r.runId, instanceId: "i-1", worktree: r.wt, ports: { app: port }, origins: [`http://localhost:${port}`], stops, sessions: [], since: 1 });
    expect(rec.worktree).toBe(realpathSync(r.wt));
    // `/bin/sh -c <one command>` execs it: the record holds what ps shows, so recovery can match it.
    expect(rec.groups).toEqual([{ name: "app", pgid: s.pgid, cmdline: `${process.execPath} ${SERVER}`, members: [{ pid: s.pgid, cmdline: `${process.execPath} ${SERVER}` }] }]);
    expect(logsDir(r.main, r.runId)).toBe(join(r.main, ".argus/live", r.runId, "logs"));
    await down(r.main, { runId: r.runId, graceMs: 2000 });
  });

  it("down replays each stop with its own cwd and env, kills every group (a grandchild and a setup's daemon too) and the reaper, removes worktree, HOME, setup log, run.json and lock, then appends end", async () => {
    const r = liveRun();
    const out = tempDir();
    const port = await freePort();
    const groups: Obj[] = [];
    const stops: Obj[] = [];
    const childPidFile = join(out, "child.pid");
    const entry = {
      name: "app",
      cmd: app("--spawn-child"),
      stop: 'pwd > "$OUT/stop.txt"; echo "$COMPOSE_PROJECT_NAME" >> "$OUT/stop.txt"; echo "${ARGUS_SECRET_PW}" >> "$OUT/stop.txt"',
      env: { OUT: out, CHILD_PID_FILE: childPidFile, PORT: String(port) },
      health: { url: `http://127.0.0.1:${port}/health` },
    };
    const s = await startEntry(entry, { worktree: r.wt, env: r.env, logs: logsDir(r.main, r.runId), groups, stops, secrets: SECRETS });
    started.push(s.pgid);
    await waitHealth(entry, s, { timeoutS: 20, worktree: r.wt, env: r.env });
    expect(await until(() => existsSync(childPidFile) && readFileSync(childPidFile, "utf8") !== "", 5000)).toBe(true);
    const child = Number(readFileSync(childPidFile, "utf8"));
    // A setup step that left a daemon in its group: the leader is gone, the daemon stays.
    const setupPgid = group("sleep 600 & exit 0");
    groups.push({ name: "setup[0]", pgid: setupPgid, cmdline: "sleep 600 & exit 0" });
    expect(await until(() => !alive(setupPgid), 3000)).toBe(true);
    const daemon = Number(execFileSync("ps", ["-A", "-o", "pid=", "-o", "pgid="], { encoding: "utf8" }).split("\n").map((l) => l.trim().split(/\s+/).map(Number)).find(([, g]) => g === setupPgid)![0]);
    writeRunFiles(r.main, { runId: r.runId, instanceId: "i-1", worktree: r.wt, ports: { app: port }, origins: [], groups, stops, env: r.env });
    const reaper = startReaper(r.main, r.runId);
    started.push(reaper);
    expect(runJson(r.main).reaper).toBe(reaper);
    expect(readFileSync(join(r.main, ".argus/live/run.json"), "utf8")).not.toContain(SECRETS.PW);
    expect(await until(() => execFileSync("ps", ["-ww", "-o", "command=", "-p", String(reaper)], { encoding: "utf8" }).includes(`reap ${r.runId}`), 5000)).toBe(true);

    const res = await down(r.main, { runId: r.runId, secrets: SECRETS, graceMs: 3000 });
    expect(readFileSync(join(out, "stop.txt"), "utf8").trim().split("\n")).toEqual([r.wt, `argus-${r.runId}`, SECRETS.PW]);
    expect(await until(() => ![s.pid, child, daemon, reaper].some(alive), 5000)).toBe(true);
    expect(existsSync(r.wt)).toBe(false);
    expect(git(r.main, "worktree", "list")).not.toContain(r.wt);
    expect(existsSync(r.home)).toBe(false);
    expect(existsSync(`${r.wt}.setup.log`)).toBe(false);
    expect(liveFiles(r.main)).toEqual([r.runId]); // its logs stay
    expect(logOf(r.main).at(-1)).toMatch(new RegExp(`^${r.runId} end \\d{10}$`));
    expect(JSON.stringify(res)).not.toContain(SECRETS.PW);
  });

  it("down removes only the run's own worktree: a run.json naming another path (the main checkout) leaves it, and says so", async () => {
    const r = liveRun();
    writeRunFiles(r.main, { runId: r.runId, instanceId: "i-1", worktree: realpathSync(r.main), ports: {}, origins: [], groups: [], stops: [], env: r.env });
    const res = await down(r.main, { runId: r.runId, graceMs: 500 });
    expect(readFileSync(join(r.main, "app.txt"), "utf8")).toBe("app\n");
    expect(res.report.join("\n")).toContain(`run.json names the worktree ${realpathSync(r.main)}, which is not the run's own`);
    expect(existsSync(r.wt)).toBe(false); // the run's own, by its id, still goes
    expect(existsSync(join(r.main, ".argus/live/lock.json"))).toBe(false);
  });

  it("down runs the Docker runtime gate before the stops; a finding is reported and the teardown goes on", async () => {
    const r = liveRun();
    const out = tempDir();
    const T = Date.now();
    const docker = (argv: string[]) => {
      const a = argv.slice(1).join(" ");
      const ok = (stdout: string) => ({ status: 0, stdout, stderr: "" });
      if (a === "ps -aq --no-trunc") return ok("cX");
      if (a === "volume ls -q" || a === "network ls -q --no-trunc") return ok("");
      if (a.startsWith("inspect --type container")) return ok(JSON.stringify([{ Id: "cX", Name: "/foreign", Created: new Date(T).toISOString(), State: {}, Config: { Labels: {} }, Mounts: [], NetworkSettings: {} }]));
      return { status: 1, stdout: "", stderr: `unexpected ${a}` };
    };
    const order: string[] = [];
    const runner = (argv: string[], opts: Obj) => (argv[0] === "docker" ? (order.push("gate"), docker(argv)) : run(argv, opts));
    const stops = [{ name: "db", cmd: 'echo stopped > "$OUT/stop.txt"', cwd: r.wt, env: { ...r.env, OUT: out } }];
    writeRunFiles(r.main, { runId: r.runId, instanceId: "i-1", worktree: r.wt, ports: {}, origins: [], groups: [], stops, env: r.env, since: T });
    const res = await down(r.main, { runId: r.runId, runner, graceMs: 500 });
    expect(order[0]).toBe("gate");
    expect(res.report).toContain(`docker runtime gate: refused: container foreign was created or started during the cycle and is not of the run's Compose project argus-${r.runId}`);
    expect(readFileSync(join(out, "stop.txt"), "utf8")).toBe("stopped\n");
    expect(existsSync(r.wt)).toBe(false);
    expect(logOf(r.main).at(-1)).toMatch(new RegExp(`^${r.runId} end `));
  });

  describe("claims (carried from the lock review)", () => {
    const claimOf = (main: string, runId: string) => join(main, ".argus/live", `claim-${runId}.json`);
    const age = (file: string, s: number) => utimesSync(file, now() - s, now() - s);

    it("down under a claim another process holds: the teardown is done, the lock stays, and the claim is named", async () => {
      const r = liveRun();
      writeRunFiles(r.main, { runId: r.runId, instanceId: "i-1", worktree: r.wt, ports: {}, origins: [], groups: [], stops: [], env: r.env });
      const file = claimOf(r.main, r.runId);
      writeFileSync(file, JSON.stringify({ renew: r.lock.deadline + 60, pid: process.pid }));
      await expect(down(r.main, { runId: r.runId, graceMs: 200, claimWaitMs: 300 })).rejects.toThrow(`refused: cycle ${r.runId}'s lock is being changed by process ${process.pid}; try again`);
      expect(existsSync(r.wt)).toBe(false);
      expect(existsSync(join(r.main, ".argus/live/run.json"))).toBe(false);
      expect(existsSync(join(r.main, ".argus/live/lock.json"))).toBe(true);
      expect(logOf(r.main)).toHaveLength(1); // no end while the lock names the run
      // An old claim counts as interrupted even when its pid is alive (pid reuse): the owner is told to remove it.
      age(file, 120);
      const m = await down(r.main, { runId: r.runId, graceMs: 200 }).then(() => "ok", (e: Error) => e.message);
      expect(m).toMatch(new RegExp(`^refused: a change to cycle ${r.runId}'s lock was interrupted \\(its claim is 12\\d s old; process ${process.pid} may be another program by now\\); remove `));
      expect(m.endsWith(`remove ${file} once no journey cycle is running`)).toBe(true);
      rmSync(file);
      await down(r.main, { runId: r.runId, graceMs: 200 });
      expect(existsSync(join(r.main, ".argus/live/lock.json"))).toBe(false);
      expect(logOf(r.main).at(-1)).toMatch(new RegExp(`^${r.runId} end `));
    });

    it("takeLock on a stale lock whose claim is old but whose pid is alive: refused, naming the file to remove", () => {
      const main = committed();
      const OLD = { runId: "20261008080000-0badc0de", start: now() - 7200, deadline: now() - 60 };
      mkdirSync(join(main, ".argus/live"), { recursive: true });
      setLock(main, OLD);
      const file = claimOf(main, OLD.runId);
      writeFileSync(file, JSON.stringify({ lock: OLD, by: "x", pid: process.pid }));
      age(file, 120);
      expect(() => takeLock(main, { maxCycleMinutes: 45 })).toThrow(`remove ${file} once no journey cycle is running`);
    });

    it("a takeover whose live-log append failed leaves its claim; the next takeLock returns it as stale, recover replays it and only then deletes the claim", async () => {
      const r = liveRun();
      const out = tempDir();
      const stops = [{ name: "db", cmd: 'echo old > "$OUT/stop.txt"', cwd: r.wt, env: { ...r.env, OUT: out } }];
      writeRunFiles(r.main, { runId: r.runId, instanceId: "i-1", worktree: r.wt, ports: {}, origins: [], groups: [], stops, env: r.env });
      const OLD = { runId: r.runId, start: now() - 7200, deadline: now() - 60 };
      setLock(r.main, OLD);
      const log = join(r.main, ".git/sapu-live.log");
      renameSync(log, `${log}.aside`);
      mkdirSync(log);
      expect(() => takeLock(r.main, { maxCycleMinutes: 45 })).toThrow(/^refused: cannot append to/);
      rmSync(log, { recursive: true });
      renameSync(`${log}.aside`, log);
      expect(existsSync(join(r.main, ".argus/live/lock.json"))).toBe(false);
      expect(existsSync(claimOf(r.main, r.runId))).toBe(true);
      expect(staleRecords(r.main)).toEqual([OLD]);
      const l = takeLock(r.main, { maxCycleMinutes: 45 });
      expect(l.stale).toBeUndefined();
      expect(l.staleRuns).toEqual([OLD]);
      const res = await recover(r.main, { secrets: {}, graceMs: 500 });
      expect(res.recovered).toEqual([r.runId]);
      expect(readFileSync(join(out, "stop.txt"), "utf8")).toBe("old\n");
      expect(existsSync(claimOf(r.main, r.runId))).toBe(false);
      expect(existsSync(r.wt)).toBe(false);
      expect(logOf(r.main).filter((x) => x.startsWith(`${r.runId} end `))).toHaveLength(1);
      expect(readLock(r.main).runId).toBe(l.runId);
      expect(staleRecords(r.main)).toEqual([]);
    });
  });

  it("recover replays only stops whose cwd exists and whose env names the run's project, kills a group only while its command line matches, and appends end", async () => {
    const r = liveRun();
    const out = tempDir();
    const say = (word: string) => `echo ${word} >> "$OUT/ran.txt"`;
    const stops = [
      { name: "good", cmd: say("good"), cwd: r.wt, env: { ...r.env, OUT: out } },
      { name: "cwd-gone", cmd: say("gone"), cwd: join(tmp, "gone"), env: { ...r.env, OUT: out } },
      { name: "no-project", cmd: say("noproj"), cwd: r.wt, env: { PATH: process.env.PATH!, OUT: out } },
      { name: "other-project", cmd: say("other"), cwd: r.wt, env: { ...r.env, COMPOSE_PROJECT_NAME: "argus-other", OUT: out } },
    ];
    const changed = group("sleep 600");
    const same = group("sleep 601");
    const setup = group("sleep 602 & exit 0");
    expect(await until(() => !alive(setup) && execFileSync("ps", ["-A", "-ww", "-o", "command="], { encoding: "utf8" }).includes("sleep 601"), 3000)).toBe(true);
    const groups = [{ name: "a", pgid: changed, cmdline: "" }, { name: "b", pgid: same, cmdline: "" }, { name: "setup[0]", pgid: setup, cmdline: "sleep 602 & exit 0" }];
    writeRunFiles(r.main, { runId: r.runId, instanceId: "i-1", worktree: r.wt, ports: {}, origins: [], groups, stops, env: r.env });
    const rec = runJson(r.main);
    expect(rec.groups[1].cmdline).toBe("sleep 601");
    expect(rec.groups[2].members.map((m: Obj) => m.cmdline)).toEqual(["sleep 602"]);
    // Group a's leader now runs something else than what was recorded (pid reuse, as recovery sees it).
    rec.groups[0].cmdline = "node something-else.mjs";
    rec.groups[0].members = [{ pid: changed, cmdline: "node something-else.mjs" }];
    writeFileSync(join(r.main, ".argus/live/run.json"), JSON.stringify(rec));
    setLock(r.main, { runId: r.runId, start: now() - 7200, deadline: now() - 60 });
    const l = takeLock(r.main, { maxCycleMinutes: 45 });
    expect(l.stale.runId).toBe(r.runId);
    const res = await recover(r.main, { secrets: {}, graceMs: 2000 });
    expect(readFileSync(join(out, "ran.txt"), "utf8")).toBe("good\n");
    const report = res.report.join("\n");
    expect(report).toContain(`stop cwd-gone: its cwd ${join(tmp, "gone")} is gone; journalled, not run`);
    expect(report).toContain(`stop no-project: its env does not name COMPOSE_PROJECT_NAME=argus-${r.runId}; journalled, not run`);
    expect(report).toContain(`stop other-project: its env does not name COMPOSE_PROJECT_NAME=argus-${r.runId}; journalled, not run`);
    expect(report).toContain(`process group ${changed} (a): its command line changed since it was recorded; not killed`);
    expect(await until(() => !alive(same) && !execFileSync("ps", ["-A", "-o", "pgid="], { encoding: "utf8" }).split("\n").some((g) => Number(g) === setup), 5000)).toBe(true);
    expect(alive(changed)).toBe(true);
    expect(existsSync(r.wt)).toBe(false);
    expect(existsSync(r.home)).toBe(false);
    expect(logOf(r.main).filter((x) => x.startsWith(`${r.runId} end `))).toHaveLength(1);
    expect(existsSync(join(r.main, ".argus/live/run.json"))).toBe(false);
    expect(readLock(r.main).runId).toBe(l.runId);
  });

  describe("the reaper", () => {
    it("runs down once the lock's deadline passes", async () => {
      const r = liveRun();
      const pgid = group("sleep 600");
      writeRunFiles(r.main, { runId: r.runId, instanceId: "i-1", worktree: r.wt, ports: {}, origins: [], groups: [{ name: "app", pgid, cmdline: "sleep 600" }], stops: [], env: r.env });
      setLock(r.main, { runId: r.runId, start: now() - 10, deadline: now() + 2 });
      const reaper = startReaper(r.main, r.runId);
      started.push(reaper);
      expect(await until(() => !existsSync(join(r.main, ".argus/live/lock.json")), 15000)).toBe(true);
      expect(await until(() => !alive(reaper) && !alive(pgid), 5000)).toBe(true);
      expect(existsSync(r.wt)).toBe(false);
      expect(logOf(r.main).at(-1)).toMatch(new RegExp(`^${r.runId} end `));
      expect(readFileSync(join(logsDir(r.main, r.runId), "reaper.log"), "utf8")).toMatch(/deadline passed: down/);
    }, 30000);

    it("exits without acting when the lock names another run", async () => {
      const r = liveRun();
      writeRunFiles(r.main, { runId: r.runId, instanceId: "i-1", worktree: r.wt, ports: {}, origins: [], groups: [], stops: [], env: r.env });
      const other = { runId: "20261008093000-0ddba11a", start: now() - 10, deadline: now() + 600 };
      setLock(r.main, other);
      const reaper = startReaper(r.main, r.runId);
      started.push(reaper);
      expect(await until(() => !alive(reaper), 5000)).toBe(true);
      expect(readLock(r.main)).toEqual(other);
      expect(existsSync(r.wt)).toBe(true);
      expect(logOf(r.main).some((x) => x.startsWith(`${r.runId} end `))).toBe(false);
      expect(readFileSync(join(logsDir(r.main, r.runId), "reaper.log"), "utf8")).toContain(`the lock names cycle ${other.runId}, not ${r.runId}: exiting without acting`);
      await down(r.main, { runId: r.runId, graceMs: 200 });
    });

    it("renew moves its wake-up", async () => {
      const r = liveRun();
      writeRunFiles(r.main, { runId: r.runId, instanceId: "i-1", worktree: r.wt, ports: {}, origins: [], groups: [], stops: [], env: r.env });
      setLock(r.main, { runId: r.runId, start: now() - 10, deadline: now() + 2 });
      const reaper = startReaper(r.main, r.runId);
      started.push(reaper);
      renew(r.main, { runId: r.runId, maxCycleMinutes: 1 });
      await new Promise((done) => setTimeout(done, 4000));
      expect(alive(reaper)).toBe(true);
      expect(existsSync(join(r.main, ".argus/live/lock.json"))).toBe(true);
      expect(existsSync(r.wt)).toBe(true);
      await down(r.main, { runId: r.runId, graceMs: 200 });
      expect(await until(() => !alive(reaper), 3000)).toBe(true);
    }, 20000);
  });
});
