// argus-live-codegen.mjs — the smoke suite's generator (spec §19.5): the committed suite as a pure function
// of its admitted paths, `.argus/smoke.json` and `.argus/live.json`. Every string of a path reaches the
// generated code as a JSON literal or a placeholder's variable, every target through targetCode in the
// selector order path mode keeps; the support file embeds the wrapper's own login template and TOTP and the
// check sources verbatim, and reads secrets by their `${NAME}` names only. The RED test a sapu worker gets
// (argus-live-redtest.mjs) goes through the same step builder. Each file carries a digest of its body.
import { createHash } from "node:crypto";
import { CHECKS as A11Y } from "./argus-live-a11y.mjs";
import { CHECKS as LAYOUT } from "./argus-live-layout.mjs";
import { loginStageSource } from "./argus-live-login.mjs";
import { parseRepro, suiteAccounts } from "./argus-live-steps.mjs";
import { parseTarget, targetCode } from "./argus-live-targets.mjs";

/** The `@playwright/test` the suite pins (decision 4): its major.minor is the pinned CLI's `playwright-core`'s. */
export const SMOKE_PLAYWRIGHT = "1.64.0";
/** The `@axe-core/playwright` the suite pins (decision 4), exact, like SMOKE_PLAYWRIGHT. */
export const SMOKE_AXE = "4.13.0";
/** The generator's version, in every file's header: a new one regenerates the suite. */
export const CODEGEN_VERSION = "1";

const JOURNEY = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PLACEHOLDER = /(\{\{[a-z][a-z0-9_]*\}\})/;
const ENV_REF = /^\$\{([A-Z_][A-Z0-9_]*)\}$/;
export const WAIT = "{ timeout: SETTLE }";
const BROWSERS = ["chromium", "firefox", "webkit", "msedge"];
/** Every project runs at this height; its width is a `viewports` entry. */
const HEIGHT = 900;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const fail = (why) => new Error(`failed: codegen: ${why}`);

// ---------------------------------------------------------------------------------------------------
// The step builder (the RED test's and the suite's).

/** A placeholder's variable: `marker`, or `saved_<name>` (the prefix keeps a saved name from colliding with anything the test declares). */
export const variable = (name) => (name === "marker" ? "marker" : `saved_${name}`);

/** A repro string as code: a JSON literal, a placeholder's variable, or a `+` concatenation of both. */
export function str(s) {
  const parts = String(s)
    .split(PLACEHOLDER)
    .filter((p) => p !== "")
    .map((p) => (PLACEHOLDER.test(p) && /^\{\{[a-z][a-z0-9_]*\}\}$/.test(p) ? variable(p.slice(2, -2)) : JSON.stringify(p)));
  return parts.length ? parts.join(" + ") : '""';
}

/** A JSON value as code, objects spelled `{"key": value, …}` as targetCode spells its options. */
export const literal = (v) => (isObj(v) ? `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${literal(x)}`).join(", ")}}` : Array.isArray(v) ? `[${v.map(literal).join(", ")}]` : JSON.stringify(v));

/**
 * Each account `steps` act as (`<role>.<k>`, in the order it first acts) → `{v, first, errors}`: its page
 * variable (`customer.1` → `customer1`, never a name in `taken`, which grows by it), its first step, and
 * whether a `no-error` reads its errors.
 */
export function pageVars(steps, taken) {
  const pages = new Map();
  for (const s of steps) {
    if (s.as === "system" || pages.has(s.as)) continue;
    const [role, k] = s.as.split(".");
    let v = `${/^[A-Za-z_]/.test(role) ? "" : "_"}${role.replace(/[^A-Za-z0-9_]/g, "_")}${k}`;
    while (taken.has(v)) v += "_";
    taken.add(v);
    pages.set(s.as, { v, first: s, errors: false });
  }
  for (const s of steps) if (s.expect === "no-error") pages.get(s.as).errors = true;
  return pages;
}

/** The title of step `s`'s `test.step`: its number and kind only (spec §19.5). */
const stepTitle = (s) => JSON.stringify(`step ${s.n} ${s.do ? "do" : "expect"}:${s.do ?? s.expect}`);

/**
 * The statements of `steps` (parseRepro's) on the pages `pages` (pageVars) → lines, unindented. `smoke`
 * false: the RED test's (each step its statement, the final under its comment naming `oracle`); true: the
 * suite's, each step one `test.step("step <n> <do|expect>:<kind>")`, a `login` through the support's with
 * its account, a fact compared as the runner compares it (as strings), and after each step the lines every
 * registered check emits (`checks`, `ctx`), once the step's `shot` lines (a screenshot at a screen) are in.
 */
export function stepLines(steps, { pages, oracle = null, smoke = false, checks = [], ctx = {}, shot = () => [] }) {
  const loc = (s) => targetCode(s.target, pages.get(s.as).v, str);
  const call = (s) => {
    const p = s.as === "system" ? null : pages.get(s.as).v;
    switch (s.do) {
      case "goto":
        return `${p}.goto(${str(s.path)})`;
      case "go-back":
        return `${p}.goBack()`;
      case "reload":
        return `${p}.reload()`;
      case "press":
        return s.target ? `${loc(s)}.press(${JSON.stringify(s.key)})` : `${p}.keyboard.press(${JSON.stringify(s.key)})`;
      case "fill":
        return `${loc(s)}.fill(${str(s.value)})`;
      case "select":
        return `${loc(s)}.selectOption(${str(s.value)})`;
      case "read":
        return `readValue(${loc(s)})`;
      case "login":
        return smoke ? `login(${p}, baseURL, ${JSON.stringify(s.as)}, ${str(s.user)}, ${str(s.password)})` : `login(${p}, ${str(s.user)}, ${str(s.password)})`;
      case "trigger":
        return `trigger(${str(s.name)}, [${s.values.map(str).join(", ")}])`;
      default:
        return `${loc(s)}.${s.do}()`; // click, dblclick, hover, check, uncheck
    }
  };
  const expectation = (s) => {
    const p = s.as === "system" ? null : pages.get(s.as).v;
    const value = typeof s.value === "string" ? str(s.value) : JSON.stringify(s.value);
    switch (s.expect) {
      case "visible":
        return `await expect(${loc(s)}).toBeVisible(${WAIT});`;
      case "hidden":
        return `await expect(${loc(s)}).toBeHidden(${WAIT});`;
      case "enabled":
        return `await expect(${loc(s)}).toBeEnabled(${WAIT});`;
      case "text-equals":
        return `await expect(${loc(s)}).toHaveText(${value}, ${WAIT});`;
      case "text-contains":
        return `await expect(${loc(s)}).toContainText(${value}, ${WAIT});`;
      case "value-equals":
        return `await expect(${loc(s)}).toHaveValue(${value}, ${WAIT});`;
      case "count":
        return `await expect(${loc(s)}).toHaveCount(${value}, ${WAIT});`;
      case "url":
        return `await expect(${p}).toHaveURL((u) => u.pathname + u.search === ${value} || u.pathname === ${value}, ${WAIT});`;
      case "fact-equals":
        return smoke ? `await expect.poll(async () => String(await fact(${str(s.marker)}, ${str(s.field)})), ${WAIT}).toBe(String(${value}));` : `await expect.poll(() => fact(${str(s.marker)}, ${str(s.field)}), ${WAIT}).toBe(${value});`;
      case "mail":
        return `await expect.poll(async () => (await mail()).some((m) => { const x = m as Record<string, unknown>; return x.to === ${str(s.to)} && (String(x.subject) + "\\n" + String(x.text)).includes(${str(s.contains)}); }), ${WAIT}).toBe(true);`;
      default:
        return `expect(errors_${p}).toEqual([]);`; // no-error
    }
  };
  const body = [];
  // A no-error reads the account's errors since the previous step (decision 11): its collector is cleared right before that step.
  const clearBefore = new Map();
  steps.forEach((s, i) => {
    if (s.expect === "no-error" && i > 0) clearBefore.set(steps[i - 1].n, `errors_${pages.get(s.as).v}.length = 0;`);
  });
  for (let i = 0; i < steps.length; ) {
    const s = steps[i];
    const group = s.group ? steps.filter((x) => x.group === s.group) : [s];
    i += group.length;
    for (const g of group) if (clearBefore.has(g.n)) body.push(clearBefore.get(g.n));
    if (s.final !== undefined) body.push(`// final (${oracle}): the correct behaviour, RED while the defect is there`);
    const reads = group.map((g) => (g.do === "read" ? variable(g.save) : ""));
    const into = reads.some(Boolean) ? (group.length > 1 ? `const [${reads.join(", ")}] = ` : `const ${reads[0]} = `) : "";
    if (!smoke) {
      if (group.length > 1) body.push(`${into}await Promise.all([`, ...group.map((g) => `  ${call(g)},`), "]);");
      else if (s.do) body.push(`${into}await ${call(s)};`);
      else body.push(expectation(s));
      continue;
    }
    const wrapped = (g) => (g.do === "read" ? `test.step(${stepTitle(g)}, async () => ${call(g)})` : `test.step(${stepTitle(g)}, async () => {\n  await ${call(g)};\n})`);
    if (group.length > 1) body.push(`${into}await Promise.all([`, ...group.flatMap((g) => `${wrapped(g)},`.split("\n").map((l) => `  ${l}`)), "]);");
    else if (s.do) body.push(...`${into}await ${wrapped(s)};`.split("\n"));
    else body.push(`await test.step(${stepTitle(s)}, async () => {`, `  ${expectation(s)}`, "});");
    for (const g of group) body.push(...shot(g), ...checks.flatMap((c) => c.emit(g, ctx)));
  }
  return body;
}

// ---------------------------------------------------------------------------------------------------
// Headers and digests.

const MARK = `argus-live codegen ${CODEGEN_VERSION}`;
const HEADER = /argus-live codegen [0-9]+, digest ([0-9a-f]{64})/;
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/**
 * `body` (the file's text) with its header line put in at line `at`: `// <what>` (or `# <what>`, or a JSON
 * `"//"` member), naming the generator and the sha256 of the body without that line.
 */
function withHeader(body, { what, style = "//", at = 0 }) {
  const digest = sha256(body);
  const words = `Generated by sapu (${MARK}, digest ${digest}) ${what}: do not edit; smoke propose regenerates it.`;
  const line = style === "json" ? `  "//": ${JSON.stringify(words)},` : `${style} ${words}`;
  const lines = body.split("\n");
  lines.splice(at, 0, line);
  return lines.join("\n");
}

/** A generated file's text → `{digest, ok}`: the digest its header names (null without one) and whether it is its body's. */
export function headerDigest(text) {
  const lines = String(text).split("\n");
  const i = lines.findIndex((l) => HEADER.test(l));
  if (i < 0) return { digest: null, ok: false };
  const digest = HEADER.exec(lines[i])[1];
  lines.splice(i, 1);
  return { digest, ok: sha256(lines.join("\n")) === digest };
}

// ---------------------------------------------------------------------------------------------------
// The suite's files.

// ---------------------------------------------------------------------------------------------------
// Projects (spec §19.6).

/**
 * The suite's projects after `setup` → `[{name, kind, browser, width}]`: `chromium`, `firefox`, `webkit` and
 * `msedge` (kind `browser`, at the first `viewports` width; smoke.json's `browsers` choose them), then, with
 * chromium among the browsers, `chromium-<w>` for each further width (`viewport`), `a11y` and, with `locales`
 * or `pseudo_locales`, `i18n`. (`msedge` is dropped at run time by the config where Edge is not installed.)
 */
export function suiteProjects({ live, smoke }) {
  const widths = [...new Set(Array.isArray(live.viewports) && live.viewports.length ? live.viewports : [1440])];
  const at = (name, kind, browser, width) => ({ name, kind, browser, width });
  const out = BROWSERS.filter((b) => smoke.browsers.includes(b)).map((b) => at(b, "browser", b, widths[0]));
  if (!smoke.browsers.includes("chromium")) return out;
  for (const w of widths.slice(1)) out.push(at(`chromium-${w}`, "viewport", "chromium", w));
  out.push(at("a11y", "a11y", "chromium", widths[0]));
  if ((live.locales || []).length + (live.pseudo_locales || []).length > 0) out.push(at("i18n", "i18n", "chromium", widths[0]));
  return out;
}

const PROJECT_NAME = /^(?:chromium|firefox|webkit|msedge|a11y|i18n|chromium-[0-9]+)$/;

/**
 * A registered check whose `emit` lines run only in the project(s) it names: a project (`a11y`), `browser`
 * (the engines at the first width), `viewport` (those and every `chromium-<w>`), an array of these, or
 * `all` (also absent) for every project. A name the suite does not define is refused; one it defines but this
 * suite lacks (`i18n` without locales) leaves the check with no lines.
 */
function gated(check, projects) {
  const p = check.project;
  if (p === undefined || p === "all" || p === "*") return check;
  const names = new Set();
  for (const t of [].concat(p)) {
    if (t !== "browser" && t !== "viewport" && !PROJECT_NAME.test(t)) throw fail(`check ${check.name} names project ${String(t)}, which the suite does not define`);
    for (const x of projects) if (t === x.name || (t === "browser" && x.kind === "browser") || (t === "viewport" && (x.kind === "browser" || x.kind === "viewport"))) names.add(x.name);
  }
  const list = JSON.stringify([...names]);
  return { ...check, emit: (s, ctx) => (names.size ? [`if (inProject(${list})) {`, ...check.emit(s, ctx).map((l) => `  ${l}`), "}"] : []) };
}

/** What the suite takes from `live` about roles and accounts: each account the paths sign in → its user and secrets by name. */
function accountRows(live, accounts) {
  const rows = [];
  for (const a of accounts) {
    const [role, k] = a.split(".");
    const r = live.roles && live.roles[role];
    const u = r && Array.isArray(r.users) ? r.users[Number(k) - 1] : null;
    if (!u) throw fail(`${a} is not a user of live.json's roles`);
    const ref = (v, what) => {
      const m = typeof v === "string" ? ENV_REF.exec(v) : null;
      if (!m) throw fail(`${a}'s ${what} is not a \${NAME} reference: a committed suite holds no secret`);
      return m[1];
    };
    const user = ENV_REF.exec(String(u.user));
    rows.push({ account: a, user: user ? { env: user[1] } : { value: String(u.user) }, password: ref(u.password, "password"), totp: u.totp_secret === undefined ? null : ref(u.totp_secret, "totp_secret") });
  }
  return rows;
}

/** A login_url, absolute or a path, as the path the suite resolves on its base URL. */
function loginPath(u) {
  if (typeof u !== "string") throw fail("live.json names no login_url");
  if (u.startsWith("/")) return u;
  const x = new URL(u.replace(/\{port:[A-Za-z0-9_-]+\}/g, "1"));
  return `${x.pathname}${x.search}`;
}

/** `{port:<name>}` in a hook's argv → smoke.json `ci.ports`' port (CI starts the app on those). */
function ciArgv(argv, ports, what) {
  return argv.map((el) =>
    String(el).replace(/\{port:([A-Za-z0-9_-]+)\}/g, (_m, name) => {
      if (!Object.hasOwn(ports, name)) throw fail(`${what} names {port:${name}}, which smoke.json ci.ports lacks`);
      return String(ports[name]);
    }),
  );
}

/** The repo root from the suite's directory `dir` (repo-relative): one `..` a segment. */
const upTo = (dir) => dir.split("/").filter(Boolean).map(() => "..").join("/");

/** The hooks a suite runs: live.json's triggers, facts and mail, their argv with CI's ports. */
function hooksOf(live, smoke) {
  const ports = (smoke.ci && smoke.ci.ports) || {};
  const triggers = {};
  for (const [name, t] of Object.entries(live.triggers ?? {})) triggers[name] = { argv: ciArgv(t.argv, ports, `trigger ${name}`), args: Array.isArray(t.args) ? t.args : [] };
  return { triggers, facts: live.facts ? { argv: ciArgv(live.facts.argv, ports, "facts"), args: Array.isArray(live.facts.args) ? live.facts.args : [] } : null, mail: live.mail ? { argv: ciArgv(live.mail.argv, ports, "mail"), args: [] } : null };
}

/** The roles that sign in with the wrapper's login template → `{<role>: {url, loggedIn, open}}` as code. */
function loginTable(live, roles) {
  const rows = roles.map((role) => {
    const r = (live.roles && live.roles[role]) || {};
    const fn = (s) => (s === undefined || s === null ? "null" : `(pg: Page) => ${targetCode(parseTarget(s), "pg")}`);
    return `  ${JSON.stringify(role)}: { url: ${JSON.stringify(loginPath(r.login_url ?? live.login_url))}, loggedIn: ${fn(r.logged_in ?? live.logged_in)}, open: ${fn(r.login_open ?? live.login_open)} },`;
  });
  return ["const LOGIN: Record<string, { url: string; loggedIn: (pg: Page) => Locator; open: ((pg: Page) => Locator) | null }> = {", ...rows, "};"];
}

/** A stage of the wrapper's login template, verbatim, as a function of the page, its payload and its two targets. */
const stage = (name, fn) => [`const ${fn} = async (page: Page, P: Record<string, unknown>, loggedIn: (pg: Page) => Locator, opener: ((pg: Page) => Locator) | null): Promise<Record<string, any>> => {`, `${loginStageSource(name)}};`];

/**
 * RFC 6238 codes (HMAC-SHA1, 30 s steps) with Node's crypto, as argus-live-login.mjs's base32Decode and totp
 * compute them (tests/argus-live-codegen.test.ts compares the two): written out, since a function's own text
 * is not stable under a test runner's module transform.
 */
export const TOTP_SOURCE = `const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32Decode(s: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of String(s).toUpperCase().replace(/[\\s=]/g, "")) {
    const i = BASE32.indexOf(c);
    if (i < 0) throw new Error("argus-smoke: a TOTP secret must be base32 (RFC 4648)");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}
function totp(secret: string, step: number, digits = 6): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 10 ** digits).padStart(digits, "0");
}
`;

/** A page's 5xx responses, console errors and page errors (decision 11), as the RED test collects them. */
export const COLLECT = `function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("response", (r) => {
    if (r.status() >= 500) errors.push(String(r.status()) + " " + r.url());
  });
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().startsWith("Failed to load resource: the server responded with a status of ")) errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}
`;

/** What a `read` step reads: an input's, textarea's or select's value, else the element's text, trimmed, at most 500 characters. */
export const READ_VALUE = `async function readValue(target: Locator): Promise<string> {
  const v = await target.evaluate((e) => e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement || e instanceof HTMLSelectElement ? e.value : (e as HTMLElement).innerText);
  return v.trim().slice(0, 500);
}
`;

/**
 * `support.ts` (spec §19.2): SETTLE; the marker (`argus-` + the test id's hash + time + random, made in
 * the test); `open` (an account's page from its storageState, its context kept in the test's `opened` for
 * closing); the hooks (live.json's argv run with no shell from the repo's root, each value checked against
 * the hook's `args`, else the wrapper's VALUE shape); the RED test's `readValue` and error collector; TOTP
 * as the wrapper computes it (Node's crypto); the wrapper's login template verbatim and `signInPage`, which
 * takes the password and TOTP secret as values the caller read from the environment; `login` for a created
 * account; every registered check's source.
 */
export function supportFile({ live, smoke, roles }) {
  const hooks = hooksOf(live, smoke);
  const sources = [...LAYOUT, ...A11Y].map((c) => c.source);
  const body = [
    'import { test } from "@playwright/test";',
    'import type { Browser, BrowserContext, BrowserContextOptions, Locator, Page } from "@playwright/test";',
    'import { execFileSync } from "node:child_process";',
    'import { createHash, createHmac, randomBytes } from "node:crypto";',
    'import path from "node:path";',
    "",
    `export const SETTLE = ${Number.isInteger(live.settle_ms) ? live.settle_ms : 10_000};`,
    `const REPO = path.resolve(__dirname, ${JSON.stringify(upTo(smoke.dir))});`,
    `const HOOKS: { triggers: Record<string, { argv: string[]; args: string[] }>; facts: { argv: string[]; args: string[] } | null; mail: { argv: string[]; args: string[] } | null } = ${literal(hooks)};`,
    "const VALUE = /^[A-Za-z0-9][A-Za-z0-9._@:-]{0,127}$/;",
    "",
    "export function newMarker(): string {",
    '  return "argus-" + createHash("sha256").update(test.info().testId).digest("hex").slice(0, 8) + Date.now().toString(36) + randomBytes(3).toString("hex");',
    "}",
    "",
    "/** Whether the test runs in one of the projects `names`: a check that belongs to some of them only. */",
    "export function inProject(names: string[]): boolean {",
    "  return names.includes(test.info().project.name);",
    "}",
    "",
    "export async function open(opened: BrowserContext[], browser: Browser, account: string, signedIn: boolean, options: BrowserContextOptions): Promise<Page> {",
    '  const context = await browser.newContext({ ...options, ...(signedIn ? { storageState: path.join(__dirname, ".auth", account + ".json") } : {}) });',
    "  opened.push(context);",
    "  return context.newPage();",
    "}",
    "",
    "function hook(h: { argv: string[]; args: string[] }, values: string[], name: string): string {",
    "  values.forEach((v, i) => {",
    '    const re = typeof h.args[i] === "string" ? new RegExp("^(?:" + h.args[i] + ")$") : VALUE;',
    '    if (v.startsWith("-") || !re.test(v)) throw new Error("argus-smoke: value " + (i + 1) + " of " + name + " does not match its args");',
    "  });",
    "  const argv = h.argv.map((el) => el.replace(/\\{(\\d+)\\}/g, (_m, k) => values[Number(k) - 1]));",
    '  return execFileSync(argv[0], argv.slice(1), { cwd: REPO, env: process.env, encoding: "utf8", timeout: SETTLE + 30_000, stdio: ["ignore", "pipe", "pipe"] });',
    "}",
    "",
    "export async function trigger(name: string, values: string[]): Promise<void> {",
    '  if (!Object.hasOwn(HOOKS.triggers, name)) throw new Error("argus-smoke: no trigger " + name);',
    '  hook(HOOKS.triggers[name], values, "trigger " + name);',
    "}",
    "",
    "export async function fact(marker: string, field: string): Promise<unknown> {",
    '  if (!HOOKS.facts) throw new Error("argus-smoke: live.json has no facts");',
    "  try {",
    '    const v = JSON.parse(hook(HOOKS.facts, [marker], "facts"));',
    '    return v !== null && typeof v === "object" && Object.hasOwn(v, field) ? v[field] : undefined;',
    "  } catch (e) {",
    "    return undefined;",
    "  }",
    "}",
    "",
    "export async function mail(): Promise<unknown[]> {",
    '  if (!HOOKS.mail) throw new Error("argus-smoke: live.json has no mail");',
    "  try {",
    '    const v = JSON.parse(hook(HOOKS.mail, [], "mail"));',
    "    return Array.isArray(v) ? v : [];",
    "  } catch (e) {",
    "    return [];",
    "  }",
    "}",
    "",
    `export ${READ_VALUE}`,
    `export ${COLLECT}`,
    TOTP_SOURCE,
    ...loginTable(live, roles),
    ...stage("credentials", "credentialsStage"),
    ...stage("otp", "otpStage"),
    "",
    "/** Signs `account` in on `page` with the wrapper's login template; a one-time code from `totpSecret` (the next step's when under 3 s of this one remain). */",
    "export async function signInPage(page: Page, baseURL: string | undefined, account: string, user: string, password: string, totpSecret: string | null): Promise<void> {",
    '  const L = LOGIN[account.split(".")[0]];',
    '  if (!L) throw new Error("argus-smoke: " + account + " has no login");',
    "  const url = new URL(L.url, baseURL).href;",
    "  let r = await credentialsStage(page, { url, user, password, settleMs: SETTLE }, L.loggedIn, L.open);",
    '  if (r.state === "otp") {',
    '    if (!totpSecret) throw new Error("argus-smoke: " + account + " needs a TOTP secret");',
    "    const now = Date.now();",
    "    const step = Math.floor(now / 30_000) + (30_000 - (now % 30_000) < 3000 ? 1 : 0);",
    "    r = await otpStage(page, { code: totp(totpSecret, step), settleMs: SETTLE }, L.loggedIn, L.open);",
    "  }",
    '  if (r.state !== "in") throw new Error("argus-smoke: " + account + " could not sign in (" + r.state + ")");',
    "}",
    "",
    "export async function login(page: Page, baseURL: string | undefined, account: string, user: string, password: string): Promise<void> {",
    "  await signInPage(page, baseURL, account, user, password, null);",
    "}",
    ...(sources.length ? ["", ...sources] : []),
    "",
  ].join("\n");
  return withHeader(body, { what: "from .argus/live.json and .argus/smoke.json" });
}

/**
 * The screens of journey `id` (spec §19.7: "the path's screens"): the steps of `steps` that get a screenshot (and
 * the ARIA snapshot and axe run of the a11y project), ascending. smoke.json's `journeys.<id>.screens`, else the
 * last step that acts on a page (the goal's own screen). A step that is no step of the path, or is the system's,
 * has no page to shoot: refused, naming the key.
 */
export function screensOf(id, steps, smoke) {
  const withPage = steps.filter((s) => s.as !== "system").map((s) => s.n);
  const named = smoke.journeys && smoke.journeys[id] && smoke.journeys[id].screens;
  if (!named) return withPage.slice(-1);
  for (const n of named) if (!withPage.includes(n)) throw fail(`smoke.json journeys.${id}.screens names step ${n}, which is not a step of the path acting on a page`);
  return [...named].sort((a, b) => a - b);
}

/** The names a smoke test declares itself: a page variable never takes one. */
const OWN = ["SETTLE", "marker", "opened", "open", "login", "trigger", "fact", "mail", "readValue", "collectErrors", "newMarker", "inProject", "browser", "baseURL", "viewport", "test", "expect"];

/**
 * `<id>.spec.ts` (spec §19.5) of path `path` (the raw DSL list) of journey `id` → its text: one `test` titled
 * `<id>`, its details `{tag: "@quarantine"}` when `quarantined` and `lock` naming `account:<role>.<k>` for each
 * signed-in account it opens (anon has no server state of its own); the marker made inside the test; each
 * account's page opened from its storageState (a bare page for anon and an account whose first step is its
 * `login`; a login-command role's from the owner's `signedIn` in fixtures.ts), its context closed at the end;
 * each step one `test.step` (stepLines), with the registered checks' lines after it. The path is parsed in path
 * mode against the suite's accounts first: its refusal is thrown as is.
 */
export function smokeSpec({ id, path, live, smoke, quarantined = false }) {
  if (typeof id !== "string" || !JOURNEY.test(id)) throw fail("a journey id is kebab-case");
  const { context, steps } = parseRepro(path, { accounts: suiteAccounts(live), live, path: true });
  const taken = new Set([...OWN, ...steps.filter((s) => s.save).map((s) => variable(s.save))]);
  const pages = pageVars(steps, taken);
  const command = (a) => Boolean(live.roles && live.roles[a.split(".")[0]] && live.roles[a.split(".")[0]].login);
  const lock = [...pages.keys()].filter((a) => !a.startsWith("anon.")).map((a) => `account:${a}`);
  const details = { ...(quarantined ? { tag: "@quarantine" } : {}), lock };
  const options = `{ baseURL, viewport, locale: ${JSON.stringify(context.locale)}, timezoneId: ${JSON.stringify(context.timezone)} }`;
  const opens = [...pages].map(([a, { v, first }]) =>
    command(a) ? `const ${v} = await signedIn(opened, browser, ${JSON.stringify(a)}, ${options});` : `const ${v} = await open(opened, browser, ${JSON.stringify(a)}, ${!a.startsWith("anon.") && first.do !== "login"}, ${options});`,
  );
  const errors = [...pages.values()].filter((p) => p.errors).map(({ v }) => `const errors_${v} = collectErrors(${v});`);
  const projects = suiteProjects({ live, smoke });
  const checks = [...LAYOUT, ...A11Y].map((c) => gated(c, projects));
  const screens = screensOf(id, steps, smoke);
  // A screenshot is asserted by the engines and the further viewports, never in msedge (a branded channel moves with the machine).
  const shooting = JSON.stringify(projects.filter((p) => (p.kind === "browser" || p.kind === "viewport") && p.browser !== "msedge").map((p) => p.name));
  const owners = [...(smoke.masks || []), ...((smoke.journeys && smoke.journeys[id] && smoke.journeys[id].masks) || [])];
  // Masked: <time> elements, the marker, every value read so far and the owner's locators (smoke.json masks).
  const shot = (g) => {
    if (!screens.includes(g.n)) return [];
    const v = pages.get(g.as).v;
    const texts = ["marker", ...steps.filter((x) => x.save && x.n <= g.n).map((x) => variable(x.save))].join(", ");
    const mask = [`${v}.getByRole("time")`, `...[${texts}].filter((t) => t !== "").map((t) => ${v}.getByText(t))`, ...owners.map((m) => targetCode(parseTarget(m), v, str))];
    return [`if (inProject(${shooting})) {`, `  await ${v}.mouse.move(-1, -1);`, `  await expect(${v}).toHaveScreenshot(${JSON.stringify(`${g.n}.png`)}, {"animations": "disabled", "caret": "hide", "mask": [${mask.join(", ")}]});`, "}"];
  };
  const lines = stepLines(steps, { pages, smoke: true, checks, shot, ctx: { id, steps, smoke, screens, projects: projects.map((p) => p.name) } });
  const body = [
    'import { test, expect } from "@playwright/test";',
    'import type { BrowserContext } from "@playwright/test";',
    'import { collectErrors, fact, inProject, login, mail, newMarker, open, readValue, SETTLE, trigger } from "./support";',
    ...([...pages.keys()].some(command) ? ['import { signedIn } from "./fixtures";'] : []),
    "",
    `test(${JSON.stringify(id)}, ${literal(details)}, async ({ browser, baseURL, viewport }) => {`,
    "  const marker = newMarker();",
    "  const opened: BrowserContext[] = [];",
    "  try {",
    ...[...opens, ...errors, ...lines].map((l) => `    ${l}`),
    "  } finally {",
    "    for (const c of opened) await c.close();",
    "  }",
    "});",
    "",
  ].join("\n");
  return withHeader(body, { what: `from journeys/${id}.json` });
}

/**
 * `auth.setup.ts` (spec §19.5, the hybrid setup): one setup test per account the suite signs in, through
 * the support's `signInPage` (the wrapper's login template); its user a literal or an environment name, its
 * password and TOTP secret read from `process.env` by the `${NAME}` names live.json gives (never a value);
 * the context's storageState written to `.auth/<role>.<k>.json` and chmod 0600. The setup project records
 * no trace, video or screenshot (smokeConfig). A password that is not a `${NAME}` reference is refused.
 */
export function authSetup({ live, accounts }) {
  const rows = accountRows(live, accounts);
  const body = [
    'import { test as setup } from "@playwright/test";',
    'import fs from "node:fs";',
    'import path from "node:path";',
    'import { signInPage } from "./support";',
    "",
    'const AUTH = path.join(__dirname, ".auth");',
    `const ACCOUNTS: { account: string; user: { value?: string; env?: string }; password: string; totp: string | null }[] = ${literal(rows)};`,
    "",
    "function fromEnv(name: string): string {",
    "  const v = process.env[name];",
    '  if (!v) throw new Error("argus-smoke: the environment has no " + name);',
    "  return v;",
    "}",
    "",
    "for (const a of ACCOUNTS) {",
    '  setup("sign in " + a.account, async ({ browser, baseURL }) => {',
    "    const context = await browser.newContext({ baseURL });",
    "    try {",
    "      const page = await context.newPage();",
    "      await signInPage(page, baseURL, a.account, a.user.value ?? fromEnv(String(a.user.env)), fromEnv(a.password), a.totp ? fromEnv(a.totp) : null);",
    '      const file = path.join(AUTH, a.account + ".json");',
    "      fs.mkdirSync(AUTH, { recursive: true, mode: 0o700 });",
    "      await context.storageState({ path: file });",
    "      fs.chmodSync(file, 0o600);",
    "    } finally {",
    "      await context.close();",
    "    }",
    "  });",
    "}",
    "",
  ].join("\n");
  return withHeader(body, { what: "from .argus/live.json" });
}

/**
 * `playwright.config.ts` (spec §19.5, §19.6): the base URL `ARGUS_SMOKE_BASE_URL`, else smoke.json's first
 * `ci.web_server` URL, refused unless its host is loopback; `fullyParallel`; under CI `forbidOnly`,
 * `retries: 1`, `workers: 1`, `globalTimeout`, `updateSnapshots: "none"` and a JSON report in
 * `test-results/`; elsewhere no retry and smoke.json's `workers` (unset: Playwright's default); `trace:
 * "on-first-retry"`, live.json's first viewport, locale and time zone, `testIdAttribute` only with
 * `test_id_attribute`; the app started by `ci.web_server` (never reused); the `setup` project with no trace,
 * video or screenshot, and `chromium`, which depends on it.
 */
export function smokeConfig({ live, smoke }) {
  const web = (smoke.ci && smoke.ci.web_server) || [];
  const use = {
    trace: "on-first-retry",
    viewport: { width: (Array.isArray(live.viewports) && live.viewports[0]) || 1440, height: HEIGHT },
    locale: live.locale || "en-US",
    timezoneId: live.timezone || "UTC",
    ...(live.test_id_attribute ? { testIdAttribute: live.test_id_attribute } : {}),
  };
  const servers = web.map((w) => ({ command: w.command, url: w.url, timeout: (w.timeout_s ?? 120) * 1000, reuseExistingServer: false, cwd: "REPO" }));
  // A journey's own `browsers` leave its spec out of the projects of an engine it does not name (chromium-engine projects follow "chromium").
  const ignore = (browser) => {
    const ids = Object.entries(smoke.journeys || {}).filter(([, j]) => j.browsers && !j.browsers.includes(browser)).map(([id]) => id).sort();
    return ids.length ? `, testIgnore: /(?:^|[\\\\/])(?:${ids.join("|")})\\.spec\\.ts$/` : "";
  };
  const projects = suiteProjects({ live, smoke }).flatMap((p) => {
    const line = `{ name: ${JSON.stringify(p.name)}, testMatch: /\\.spec\\.ts$/${ignore(p.browser)}, use: ${literal({ browserName: p.browser === "msedge" ? "chromium" : p.browser, ...(p.browser === "msedge" ? { channel: "msedge" } : {}), ...(p.kind === "viewport" ? { viewport: { width: p.width, height: HEIGHT } } : {}) })}, dependencies: ["setup"] },`;
    if (p.name === "webkit") return ["// WebKit is the closest stand-in for Safari, not Safari.", line];
    if (p.name === "msedge") return ["// msedge runs the path and the checks and no screenshot: a branded channel moves with the machine, not with the pin.", `...(HAS_EDGE ? [${line.slice(0, -1)}] : []),`];
    return [line];
  });
  const edge = smoke.browsers.includes("msedge");
  const body = [
    'import { defineConfig } from "@playwright/test";',
    ...(edge ? ['import fs from "node:fs";'] : []),
    'import path from "node:path";',
    "",
    "const CI = Boolean(process.env.CI);",
    `const REPO = path.resolve(__dirname, ${JSON.stringify(upTo(smoke.dir))});`,
    `const BASE_URL = process.env.ARGUS_SMOKE_BASE_URL || ${JSON.stringify(web.length ? new URL(web[0].url).origin : "")};`,
    'if (!BASE_URL) throw new Error("argus-smoke: set ARGUS_SMOKE_BASE_URL, or smoke.json ci.web_server");',
    "const HOST = new URL(BASE_URL).hostname;",
    "// The suite drives loopback only: never a deployed system.",
    'if (!/^(localhost|127(\\.\\d{1,3}){3}|\\[::1\\])$/.test(HOST)) throw new Error("argus-smoke: the base URL must name a loopback host, not " + HOST);',
    ...(edge
      ? [
          "// Edge is the machine's own, never installed by the suite: the msedge project exists only where its executable does.",
          'const EDGE: string[] = ({ darwin: ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"], linux: ["/opt/microsoft/msedge/msedge"], win32: ["PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"].map((v) => path.join(process.env[v] ?? "", "Microsoft", "Edge", "Application", "msedge.exe")) } as Record<string, string[]>)[process.platform] ?? [];',
          "const HAS_EDGE = EDGE.some((f) => fs.existsSync(f));",
          'if (!HAS_EDGE) console.log("msedge: skipped (not installed)");',
        ]
      : []),
    "",
    "export default defineConfig({",
    '  testDir: ".",',
    "  fullyParallel: true,",
    "  forbidOnly: CI,",
    "  retries: CI ? 1 : 0,",
    `  workers: CI ? 1 : ${smoke.workers === null || smoke.workers === undefined ? "undefined" : JSON.stringify(smoke.workers)},`,
    "  globalTimeout: CI ? 3_600_000 : 0,",
    '  updateSnapshots: CI ? "none" : "missing",',
    "  // Baselines are the CI container's: elsewhere a screenshot is not compared.",
    "  ignoreSnapshots: !CI,",
    '  snapshotPathTemplate: "{testDir}/__screenshots__/{projectName}/{platform}/{testFileBaseName}/{arg}{ext}",',
    '  expect: { toMatchAriaSnapshot: { pathTemplate: "{testDir}/__aria__/{testFileBaseName}/{arg}{ext}" } },',
    '  reporter: CI ? [["list"], ["json", { outputFile: "test-results/results.json" }]] : "list",',
    ...(servers.length ? [`  webServer: ${literal(servers).replace(/"cwd": "REPO"/g, '"cwd": REPO')},`] : []),
    `  use: { baseURL: BASE_URL, ...${literal(use)} },`,
    "  projects: [",
    '    { name: "setup", testMatch: /auth\\.setup\\.ts$/, use: { trace: "off", video: "off", screenshot: "off" } },',
    ...projects.map((l) => `    ${l}`),
    "  ],",
    "});",
    "",
  ].join("\n");
  return withHeader(body, { what: "from .argus/smoke.json and .argus/live.json" });
}

/** The suite's `package.json`: `@playwright/test` and `@axe-core/playwright` pinned exactly (SMOKE_PLAYWRIGHT, SMOKE_AXE), private, no scripts that install. */
export function packageJson() {
  const body = `${JSON.stringify({ name: "argus-smoke", private: true, scripts: { test: "playwright test" }, devDependencies: { "@axe-core/playwright": SMOKE_AXE, "@playwright/test": SMOKE_PLAYWRIGHT } }, null, 2)}\n`;
  return withHeader(body, { what: "for the suite", style: "json", at: 1 });
}

/** The suite's `.gitignore`: the signed-in states (session cookies), the results and the report never reach the repo. */
export function suiteGitignore() {
  return withHeader(".auth/\ntest-results/\nplaywright-report/\n", { what: "for the suite", style: "#" });
}

/**
 * `fixtures.ts`, only when a path acts as a login-command role (spec §19.2): the owner's `signedIn`, a stub
 * that throws until wired. Created once, never regenerated over the owner's edit (the proposal keeps it).
 */
export const FIXTURES = `import type { Browser, BrowserContext, BrowserContextOptions, Page } from "@playwright/test";

// The owner's: sign a login-command role's account in (sapu never runs its login command in CI).
export async function signedIn(opened: BrowserContext[], browser: Browser, account: string, options: BrowserContextOptions): Promise<Page> {
  throw new Error("wire signedIn for " + account + " to this repo's E2E helpers");
}
`;

/**
 * The whole suite (spec §19.2) of `paths` (`[{id, path}]`), `live` (live.json as written: `${NAME}` references
 * unexpanded), `smoke` (validateSmoke's value) and `quarantine` (journey ids) → `{<file>: text}`, a pure
 * function: `<id>.spec.ts` per path, `auth.setup.ts` for the signed-in accounts the paths open, `support.ts`,
 * `playwright.config.ts`, `package.json`, `.gitignore`, and `fixtures.ts` when a login-command role acts.
 */
export function generateSuite({ paths, live, smoke, quarantine = [] }) {
  const files = {};
  const signed = new Set();
  const roles = new Set();
  let command = false;
  for (const { id, path } of [...paths].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    files[`${id}.spec.ts`] = smokeSpec({ id, path, live, smoke, quarantined: quarantine.includes(id) });
    const { steps } = parseRepro(path, { accounts: suiteAccounts(live), live, path: true });
    const first = new Map();
    for (const s of steps) if (s.as !== "system" && !first.has(s.as)) first.set(s.as, s);
    for (const [a, s] of first) {
      const role = a.split(".")[0];
      if (role === "anon") continue;
      if (live.roles[role].login) command = true;
      else {
        roles.add(role);
        if (s.do !== "login") signed.add(a);
      }
    }
    for (const s of steps) if (s.do === "login") roles.add(s.as.split(".")[0]);
  }
  files["auth.setup.ts"] = authSetup({ live, accounts: [...signed].sort() });
  files["support.ts"] = supportFile({ live, smoke, roles: [...roles].sort() });
  files["playwright.config.ts"] = smokeConfig({ live, smoke });
  files["package.json"] = packageJson();
  files[".gitignore"] = suiteGitignore();
  if (command) files["fixtures.ts"] = FIXTURES;
  return files;
}
