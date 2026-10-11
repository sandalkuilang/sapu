// tests/argus-live-literal.test.ts — a literal secret in `.argus/live.json` (a value in `env`, a word of a
// command, a URL's password): validateLive refuses the clear ones, naming where and what kind, never the value,
// in every encoding scrub reads; scrub masks the borderline ones a run may still carry.
// Every credential below is built by concatenation, so no file holds one as a single literal.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanTemps, example, liveRun, tempDir } from "./helpers/argus-live";
// @ts-expect-error — plain ESM script without types
import { literalFindings, validateLive } from "../plugins/sapu/scripts/argus-live-config.mjs";
// @ts-expect-error — plain ESM script without types
import { appendLedger } from "../plugins/sapu/scripts/argus-live-ledger.mjs";
// @ts-expect-error — plain ESM script without types
import { scrub, scrubSecrets } from "../plugins/sapu/scripts/argus-live-scrub.mjs";
// @ts-expect-error — plain ESM script without types
import { liveAsWritten } from "../plugins/sapu/scripts/argus-live-suite.mjs";

type Obj = Record<string, any>;

afterEach(cleanTemps);

/** One credential of each known shape, assembled at run time. */
const KEYS: Record<string, string> = {
  "a Stripe secret key": "sk_" + "live_" + "51HxYzAbCdEfGh12",
  "a GitHub token": "gh" + "p_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8",
  "a GitLab token": "glp" + "at-" + "A1b2C3d4E5f6G7h8I9j0",
  "an AWS access key": "AK" + "IA" + "IOSFODNN7EXAMPLE",
  "a Slack token": "xo" + "xb-" + "1234567890-abcdefghij",
  "a Google API key": "AI" + "za" + "SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p",
  "an npm token": "np" + "m_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6",
  "a SendGrid key": "S" + "G." + "A1b2C3d4E5f6G7h8I9j0" + "." + "K1l2M3n4O5p6Q7r8S9t0U1v2",
  "an API key": "sk" + "-proj-" + "A1b2C3d4E5f6G7h8I9j0K1l2",
  "a JWT": "ey" + "JhbGciOiJIUzI1NiJ9" + ".ey" + "JzdWIiOiIxMjM0NTY3ODkwIn0" + ".c2lnbmF0dXJl",
  "a private key": "-----BEGIN RSA PRI" + "VATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRI" + "VATE KEY-----",
};
const STRIPE = KEYS["a Stripe secret key"];
/** A long random token of no known shape. */
const RANDOM = "Q7mZp2Lx" + "9Wk4Rt6Yb1Nc";
const PASSWORD = "hunt" + "er22";

const errorsOf = (mutate: (c: Obj) => void) => {
  const c = example();
  mutate(c);
  return validateLive(c) as string[];
};
/** The one error naming `where`, else undefined. */
const at = (errs: string[], where: string) => errs.find((e) => e.startsWith(`${where}: `));
const login = (cmd: string) => (c: Obj) => (c.roles.admin.login.command = cmd);

describe("argus-live config — literal secrets are refused", () => {
  it("the example, with every value a ${NAME}, passes", () => {
    expect(validateLive(example())).toEqual([]);
  });

  it("each known credential shape in an env value is refused, naming the field, the kind and the env file, never the value", () => {
    for (const [kind, v] of Object.entries(KEYS)) {
      const errs = errorsOf((c) => (c.env.SOME_VALUE = v));
      const e = at(errs, "env.SOME_VALUE");
      expect(e, kind).toBeDefined();
      expect(e, kind).toContain(kind);
      expect(e).toContain("env_file .argus/live.env");
      expect(e).toContain("${NAME}");
      for (const part of v.split(/[\n.]/).filter((p) => p.length >= 6 && !p.includes("-----"))) expect(errs.join("\n"), kind).not.toContain(part);
    }
  });

  it("a start entry's env, a command, an argv list and a URL are read the same way", () => {
    expect(at(errorsOf((c) => (c.start[2].env.API_KEY_X = STRIPE)), "start[2].env.API_KEY_X")).toContain("a Stripe secret key");
    expect(at(errorsOf((c) => (c.start[1].cmd = `STRIPE=${STRIPE} npm run dev`)), "start[1].cmd")).toContain("a Stripe secret key");
    expect(at(errorsOf((c) => (c.setup = [["npx", "tool", "--key", STRIPE]])), "setup[0]")).toContain("a Stripe secret key");
    expect(at(errorsOf((c) => (c.triggers["payment-settles"].argv = ["curl", "-H", `X: ${STRIPE}`])), "triggers.payment-settles.argv")).toContain("a Stripe secret key");
    expect(at(errorsOf((c) => (c.start[1].health = { url: `http://localhost:{port:api}/health?k=${STRIPE}` })), "start[1].health.url")).toContain("a Stripe secret key");
    expect(at(errorsOf((c) => (c.store_check = `npm run -s which -- ${STRIPE}`)), "store_check")).toContain("a Stripe secret key");
  });

  it("without an env_file the message says to name one", () => {
    const e = at(errorsOf((c) => {
      delete c.env_file;
      c.env.SOME_VALUE = STRIPE;
    }), "env.SOME_VALUE");
    expect(e).toContain('"env_file"');
  });

  it("login.command: a password, token or bearer credential assigned literally is refused", () => {
    const cases: [string, string][] = [
      [`curl -s -X POST http://localhost:{port:api}/session -d 'password=${PASSWORD}'`, 'a value for "password"'],
      [`curl -d '{"email":"a@example.test","password":"${PASSWORD}"}' http://localhost:{port:api}/s`, 'a value for "password"'],
      [`curl -d "{\\"password\\":\\"${PASSWORD}\\"}" http://localhost:{port:api}/s`, 'a value for "password"'],
      [`PASSWORD=${PASSWORD} npm run -s explore:login`, 'a value for "PASSWORD"'],
      [`npm run -s explore:login -- --token ${PASSWORD}`, 'a value for "token"'],
      [`npm run -s explore:login -- --api-key=${PASSWORD}`, 'a value for "api-key"'],
      [`curl -H 'Authorization: Bearer abc123def456' http://localhost:{port:api}/s`, "a bearer credential"],
      [`node login.mjs --db postgres://admin:${PASSWORD}@localhost:{port:pg}/app`, "a password in a URL"],
    ];
    for (const [cmd, kind] of cases) {
      const errs = errorsOf(login(cmd));
      const e = at(errs, "roles.admin.login.command");
      expect(e, cmd).toContain(kind);
      expect(errs.join("\n"), cmd).not.toContain(PASSWORD);
      expect(errs.join("\n"), cmd).not.toContain("abc123def456");
    }
  });

  it("login.command: references, switches and flags are no literal", () => {
    for (const cmd of [
      "npm run -s explore:login -- admin",
      'PASSWORD="$ARGUS_SECRET_PW" npm run -s explore:login',
      'npm run -s explore:login -- --password "${PW}" --token "$TOKEN"',
      "docker login --password-stdin < /dev/null",
      "npm run -s explore:login -- --password-file .argus/pw --token-ttl 60",
      'curl -H "Authorization: Bearer ${TOKEN}" http://localhost:{port:api}/s',
      "node login.mjs --remember-password=false --api-key=",
      "echo Basic authentication",
    ]) expect(errorsOf(login(cmd)), cmd).toEqual([]);
  });

  it("an env value under a name that says secret is refused unless it is a reference, a switch, a number with a unit, or a URL with no password", () => {
    for (const [k, v] of [["SESSION_SECRET", "dev-only-secret"], ["DB_PASSWORD", "postgres"], ["SMTP_PASS", "mailpw"], ["APP_KEY", "base64:abcdef"], ["stripeSecretKey", "anything"], ["ADMIN_PIN", "73914826"], ["PGPASSWORD", "postgres"], ["MYSQL_PWD", "rootpw"], ["csrftoken", "abc"], ["GOOGLE_CREDENTIALS", '{"client_id":"x9"}']]) {
      const errs = errorsOf((c) => (c.env[k] = v));
      expect(at(errs, `env.${k}`), k).toContain("a value its name says is secret");
      expect(errs.join("\n"), k).not.toContain(v);
    }
    const fine = errorsOf((c) =>
      Object.assign(c.env, {
        SESSION_SECRET: "${SESSION_SECRET}",
        JWT_EXPIRES_IN: "3600",
        PASSWORD_MIN_LENGTH: "8",
        COOKIE_SECURE: "false",
        AUTH_TOKEN: "",
        STRIPE_PUBLISHABLE_KEY: "pk_" + "test_abc",
        NEXT_PUBLIC_MAP_TOKEN: "pk.public",
        AUTH_TOKEN_URL: "http://localhost:{port:auth}/token",
        OAUTH_SECRET: "http://localhost:{port:auth}/secret",
        KEYCLOAK_TOKEN: "{port:kc}",
        BYPASS: "maintenance",
        TOKEN_TTL: "900",
      }),
    );
    expect(fine).toEqual([]);
  });

  it("a password in a URL is refused; a ${NAME} or no password passes", () => {
    const e = at(errorsOf((c) => (c.env.DATABASE_URL = `postgres://app:${PASSWORD}@localhost:{port:pg}/app_explore`)), "env.DATABASE_URL");
    expect(e).toContain("a password in a URL");
    expect(e).not.toContain(PASSWORD);
    expect(at(errorsOf((c) => (c.login_url = `/login?token=${PASSWORD}`)), "login_url")).toContain('a value for "token"');
    expect(errorsOf((c) => Object.assign(c.env, { CACHE_URL: "redis://localhost:{port:redis}/0", AMQP_URL: "amqp://guest@localhost:{port:mq}", MAIL_URL: "smtp://:${SMTP_PW}@localhost:{port:smtp}" }))).toEqual([]);
  });

  it("a JVM-style option names its secret by its last word", () => {
    expect(at(errorsOf((c) => (c.env.JAVA_OPTS = `-Dspring.datasource.password=${PASSWORD}`)), "env.JAVA_OPTS")).toContain('a value for "Dspring.datasource.password"');
  });

  it("a long random token is refused; an identifier, a hash, a UUID and a path are not", () => {
    const e = at(errorsOf((c) => (c.env.FEATURE_SEED = RANDOM)), "env.FEATURE_SEED");
    expect(e).toContain("a long random token");
    expect(e).not.toContain(RANDOM);
    // base64's "/" does not cut a key apart; an absolute path is judged a segment at a time.
    expect(at(errorsOf((c) => (c.env.BLOB = "Zq8/Lm3+Tx9Vb2Nc" + "4Wd7Rf1Hj6Kp0Gs5Ya")), "env.BLOB")).toContain("a long random token");
    expect(errorsOf((c) => (c.env.DATA_DIR = "/var/folders/zz/zyxvpxvq6csfxvn_n0000gn/T/argus-Xy7Qm2pL/app_explore"))).toEqual([]);
    expect(
      errorsOf((c) => {
        Object.assign(c.env, { APP: "resetDatabase2Fixtures", COMMIT: "9fceb02d0ae598e95dc970b74767f19372d61af8", RUN: "123E4567-E89B-12D3-A456-426614174000", SRC: "src/components/UserProfile2Card/index" });
        c.store_check = "npm run -s explore:resetDatabase2Fixtures -- --max-old-space-size=4096";
      }),
    ).toEqual([]);
  });

  it("one finding per field: a known shape is not also reported as a random token", () => {
    const errs = errorsOf((c) => (c.env.X = KEYS["a GitHub token"]));
    expect(errs.filter((x) => x.startsWith("env.X: "))).toHaveLength(1);
    expect(at(errs, "env.X")).not.toContain("a long random token");
  });

  it("is found in the encodings scrub reads: escaped, URL-encoded, entity-encoded, base64 and hex", () => {
    const pct = STRIPE.replace(/_/g, "%5F");
    const ent = STRIPE.replace(/_/g, "&#x5f;");
    const hex = Buffer.from(STRIPE).toString("hex");
    const b64 = Buffer.from("-----BEGIN PRI" + "VATE KEY-----").toString("base64");
    const esc = STRIPE.replace(/^s/, "\\x73");
    const cases: [(c: Obj) => void, string, string][] = [
      [(c) => (c.login_url = `/login?k=${pct}`), "login_url", "a Stripe secret key (URL- or entity-encoded)"],
      [(c) => (c.env.X = `pre ${ent} post`), "env.X", "a Stripe secret key (URL- or entity-encoded)"],
      [(c) => (c.env.X = hex), "env.X", "a Stripe secret key (hex-encoded)"],
      [(c) => (c.env.X = b64), "env.X", "a private key (base64-encoded)"],
      [login(`printf '${esc}' | node login.mjs`), "roles.admin.login.command", "a Stripe secret key (escaped)"],
      [(c) => (c.env.X = STRIPE.replace(/_/g, "%255F")), "env.X", "a Stripe secret key (URL- or entity-encoded)"],
    ];
    for (const [mutate, where, kind] of cases) {
      const errs = errorsOf(mutate);
      expect(at(errs, where), kind).toContain(kind);
      expect(errs.join("\n")).not.toContain(STRIPE);
    }
  });

  it("smoke check, propose and workflow refuse a committed live.json holding one (liveAsWritten)", () => {
    const c = example();
    c.env.SOME_VALUE = STRIPE;
    expect(() => liveAsWritten(JSON.stringify(c), "smoke check")).toThrow(/^refused: smoke check: \.argus\/live\.json: env\.SOME_VALUE: a Stripe secret key/);
  });

  it("literalFindings names each value, for scrub; a looser name test and token floor find more", () => {
    const c = example();
    c.env.SESSION_ID = "sess-4417-alpha";
    c.start[3].cmd = "npm run worker -- --seed Xy7_Qm2pLk9wZr4T";
    expect(validateLive(c)).toEqual([]);
    expect(literalFindings(c)).toEqual([]);
    const loose = literalFindings(c, { named: (n: string) => /session/i.test(n), minToken: 16 }) as Obj[];
    expect(loose.map((f) => [f.where, f.value])).toEqual(
      expect.arrayContaining([
        ["env.SESSION_ID", "sess-4417-alpha"],
        ["start[3].cmd", "Xy7_Qm2pLk9wZr4T"],
      ]),
    );
  });
});

describe("argus-live scrub — live.json's literal values", () => {
  /** A run whose live.json is `mutate`d from a minimal valid one; its ledger holds one cookie. */
  const run = (mutate: (c: Obj) => void) => {
    const t = liveRun();
    const c: Obj = {
      start: [{ name: "web", cmd: "true" }],
      base_url: "http://localhost:{port:web}",
      login_url: "/login",
      logged_in: "getByRole('button', { name: 'Account' })",
      store: "app_explore",
      store_check: "true",
      reset: "true",
      confirmed: { mocks: true, data: true },
      port_range: [41000, 41999],
      roles: { anon: {} },
      limits: { max_cycle_minutes: 45 },
    };
    mutate(c);
    writeFileSync(join(t.main, ".argus/live.json"), JSON.stringify(c));
    appendLedger(t.main, t.runId, [{ c: "cookie", v: "CookieVal_7731x" }]);
    const body = (text: string) => {
      const file = join(tempDir(), "body.md");
      writeFileSync(file, text);
      return file;
    };
    return { ...t, body };
  };

  it("a borderline literal a run may carry is a secret scrub refuses, named by its field", async () => {
    const t = run((c) => {
      c.env = { SESSION_ID: "sess-4417-alpha", JWT_EXPIRES_IN: "3600", SESSION_DRIVER: "redis", AUTH_PROVIDER: "credentials", OAUTH_CLIENT_ID: "123456789", SESSION_DIR: "/var/lib/app/sessions" };
      c.start[0].cmd = "true --seed Xy7_Qm2pLk9wZr4T";
    });
    const s = scrubSecrets(t.main, { runId: t.runId, env: {} });
    expect(s.refusal).toBeNull();
    const labels = s.secrets.filter((x: Obj) => x.cls === "live.json value").map((x: Obj) => x.label);
    expect(labels).toEqual(expect.arrayContaining(["live.json env.SESSION_ID", "live.json start[0].cmd"]));
    // Configuration under a name secretName knows is no secret: a unit number, a plain word, an id number, a path.
    for (const v of ["3600", "redis", "credentials", "123456789", "/var/lib/app/sessions"]) expect(s.secrets.some((x: Obj) => x.v === v), v).toBe(false);
    expect(await scrub(t.main, { run: t.runId, title: "x", bodyFile: t.body("redis credentials at /var/lib/app/sessions\n") }, { env: {} })).toMatchObject({ code: 0 });
    const refused = "refused: scrub: 1 secret(s) in the issue; nothing is filed";
    expect(await scrub(t.main, { run: t.runId, title: "x", bodyFile: t.body("see sess-4417-alpha here\n") }, { env: {} })).toEqual({ code: 1, out: ["body 1:5 live.json value", refused] });
    expect(await scrub(t.main, { run: t.runId, title: "x", bodyFile: t.body(`seed ${Buffer.from("Xy7_Qm2pLk9wZr4T").toString("base64")}\n`) }, { env: {} })).toEqual({ code: 1, out: ["body 1:6 live.json value", refused] });
  }, 30_000);

  it("a clear literal (live.json edited after up) refuses the whole scrub, naming where and never what", async () => {
    const t = run((c) => (c.env = { API_KEY_X: STRIPE }));
    const s = scrubSecrets(t.main, { runId: t.runId, env: {} });
    expect(s.refusal).toMatch(/^refused: scrub: \.argus\/live\.json: env\.API_KEY_X: a Stripe secret key .*; nothing is filed$/);
    expect(s.refusal).not.toContain(STRIPE);
    const r = await scrub(t.main, { run: t.runId, title: "x", bodyFile: t.body("plain words\n") }, { env: {} });
    expect(r.code).toBe(1);
    expect(r.out.join("\n")).not.toContain(STRIPE);
  }, 30_000);
});
