// argus-live-config.mjs — the journey lane's live-instance config, `.argus/live.json` (spec §8):
// load it and its `env_file`, validate its schema, expand `{port:<name>}`, `{port:<name>=<n>}` and
// `${NAME}` in its strings.
//
// JSON, not YAML: the plugin has no dependencies. Unknown keys are errors at every level (a typo must
// not silently drop a setting, as in the sapu contract). Secrets come only from `env_file`, never from
// the process environment, and no error message ever holds a secret's value.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseTarget } from "./argus-live-targets.mjs";

export const LIVE_FILE = ".argus/live.json";
/** Role names: no `.` (`<role>.<n>` names an account). */
export const ROLE_NAME = /^[a-z][a-z0-9_-]*$/;
const RESERVED_ROLES = ["anon", "system"];
/** The wrapper's commands that take no role (`pw <token> submit <json>`): never a role name. */
export const ROLE_FREE = ["submit", "code", "trigger", "facts", "mail"];
const PORT_NAME = /^[a-z][a-z0-9_-]*$/;
const START_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const SECRET = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}/;
/** A cycle longer than a day is a mistake, and keeps every epoch the lock computes in range. */
export const MAX_CYCLE_MINUTES = 1440;

export const TOP_KEYS = [
  "setup", "services", "start", "base_url", "login_url", "logged_in", "login_open", "env_file", "env", "pass_env", "store", "store_check", "reset",
  "facts", "mail", "triggers", "confirmed", "allow_origins", "port_range", "reserved_ports", "login_spacing_ms", "timezone", "locale",
  "fixtures", "roles", "viewports", "locales", "settle_ms", "prohibited", "limits", "compose_files",
];
const REQUIRED = ["start", "base_url", "login_url", "logged_in", "store", "store_check", "reset", "confirmed", "roles", "limits"];
export const LIMIT_KEYS = ["max_cycle_minutes", "max_parallel_journeys", "live_health_timeout_s", "explorer_pw_calls", "minimize_runs"];
export const START_KEYS = ["name", "cmd", "phase", "stop", "env", "health"];
export const ROLE_KEYS = ["code_role", "users", "login", "base_url", "login_url", "logged_in", "login_open"];
export const USER_KEYS = ["user", "password", "totp_secret"];

const isStr = (v) => typeof v === "string" && v.trim() !== "";
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const strArray = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");
const isInt = (v, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isInteger(v) && v >= min && v <= max;
const isPort = (v) => isInt(v, 1, 65535);
/** Inclusive ranges of the integer keys that have one (limits.<key> named with its prefix). */
const RANGES = { settle_ms: [0, 120_000], login_spacing_ms: [0, 60_000], "limits.explorer_pw_calls": [1, 10_000] };
const outOfRange = (k, v) => (isInt(v, RANGES[k][0], RANGES[k][1]) ? null : `${k} must be an integer from ${RANGES[k][0]} to ${RANGES[k][1]}`);

/**
 * `logged_in` and `login_open` (top level and per role) must be locators parseTarget reads — the getBy
 * family or `locator('<css>')`, chained, with first/last/nth; never a snapshot ref or a bare CSS string —
 * because the wrapper builds its login code from the parsed form (targetCode), so no config string ever
 * becomes code.
 */
const LOCATOR_EXAMPLE = { logged_in: "getByRole('button', { name: 'Account' })", login_open: "getByRole('button', { name: 'Sign in' })" };
function locatorKey(v, key, where, errs) {
  if (!isStr(v)) return errs.push(`${where} must be a non-empty string`);
  let t;
  try {
    t = parseTarget(v);
  } catch {
    t = null;
  }
  if (!t || t.ref !== undefined) errs.push(`${where} must be a Playwright locator such as ${LOCATOR_EXAMPLE[key]}`);
}

/** A time zone the browser accepts (Intl knows it). */
const isTimeZone = (tz) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};
/** A well-formed BCP 47 language tag. */
const isLocale = (l) => {
  try {
    return typeof l === "string" && Intl.getCanonicalLocales(l).length === 1;
  } catch {
    return false;
  }
};

const isRegex = (s) => {
  try {
    new RegExp(s);
    return typeof s === "string";
  } catch {
    return false;
  }
};

/** Every schema error in `c` (empty = valid). */
export function validateLive(c) {
  if (!isObj(c)) return [`${LIVE_FILE} must be a JSON object`];
  const errs = [];
  const need = (cond, msg) => cond || errs.push(msg);
  const unknown = (obj, where, allowed) => {
    for (const k of Object.keys(obj)) if (!allowed.includes(k)) errs.push(`${where}: unknown key "${k}"`);
  };
  /** `where` must be an object; reports and returns false when it is not. */
  const object = (v, where) => need(isObj(v), `${where} must be an object`) === true;
  const has = (k) => k in c;

  unknown(c, LIVE_FILE, TOP_KEYS);
  for (const k of REQUIRED) need(has(k), `${LIVE_FILE}: missing "${k}"`);

  if (has("setup")) need(Array.isArray(c.setup) && c.setup.every((a) => strArray(a) && a.length > 0 && isStr(a[0])), "setup must be an array of argv lists (each a non-empty array of words)");
  if (has("services") && object(c.services, "services")) {
    for (const [name, s] of Object.entries(c.services)) {
      if (!object(s, `services.${name}`)) continue;
      unknown(s, `services.${name}`, ["env"]);
      need(isStr(s.env), `services.${name}.env must name the env variable holding its address`);
    }
  }
  if (has("start")) {
    if (need(Array.isArray(c.start) && c.start.length > 0, "start must be a non-empty array of entries") === true) {
      const seen = new Set();
      c.start.forEach((e, i) => {
        const where = `start[${i}]`;
        if (!object(e, where)) return;
        unknown(e, where, START_KEYS);
        if (need(typeof e.name === "string" && START_NAME.test(e.name), `${where}.name must match ${START_NAME}`) === true) {
          need(!seen.has(e.name), `duplicate start name "${e.name}"`);
          seen.add(e.name);
        }
        need(isStr(e.cmd), `${where}.cmd must be a command`);
        if ("phase" in e) need(e.phase === "store", `${where}.phase must be "store" (or be omitted)`);
        if ("stop" in e) need(isStr(e.stop), `${where}.stop must be a command`);
        if ("env" in e) need(isObj(e.env) && Object.values(e.env).every((v) => typeof v === "string"), `${where}.env must map names to strings`);
        if ("health" in e) {
          const h = e.health;
          need(isObj(h) && Object.keys(h).length === 1 && (isStr(h.url) || isStr(h.cmd)), `${where}.health must be {"url": <url>} or {"cmd": <command>}`);
        }
      });
    }
  }
  for (const k of ["base_url", "login_url", "store", "store_check", "reset"]) if (has(k)) need(isStr(c[k]), `${k} must be a non-empty string`);
  for (const k of ["logged_in", "login_open"]) if (has(k)) locatorKey(c[k], k, k, errs);
  if (isStr(c.base_url)) localUrl(c.base_url, "base_url", errs);
  if (has("env_file")) need(isStr(c.env_file), "env_file must be a path inside the repo");
  if (has("env")) need(isObj(c.env) && Object.values(c.env).every((v) => typeof v === "string"), "env must map names to strings");
  for (const k of ["pass_env", "locales", "prohibited"]) if (has(k)) need(strArray(c[k]), `${k} must be an array of strings`);
  for (const k of ["facts", "mail"]) if (has(k)) command(c[k], k, errs);
  if (has("triggers") && object(c.triggers, "triggers")) for (const [name, t] of Object.entries(c.triggers)) command(t, `triggers.${name}`, errs);
  if (has("confirmed") && object(c.confirmed, "confirmed")) {
    unknown(c.confirmed, "confirmed", ["mocks", "data"]);
    need(c.confirmed.mocks === true, "confirmed.mocks must be true: every outbound integration runs in test or mock mode under env");
    need(c.confirmed.data === true, "confirmed.data must be true: the data reset creates is synthetic");
  }
  if (has("allow_origins")) need(strArray(c.allow_origins) && c.allow_origins.every(isOrigin), "allow_origins must be an array of full origins (scheme://host[:port])");
  if (has("port_range")) need(Array.isArray(c.port_range) && c.port_range.length === 2 && c.port_range.every(isPort) && c.port_range[0] <= c.port_range[1], "port_range must be [low, high], ports 1-65535, low <= high");
  if (has("reserved_ports")) need(Array.isArray(c.reserved_ports) && c.reserved_ports.every(isPort), "reserved_ports must be an array of ports");
  for (const k of ["login_spacing_ms", "settle_ms"]) if (has(k)) need(!outOfRange(k, c[k]), outOfRange(k, c[k]));
  for (const k of ["timezone", "locale", "fixtures"]) if (has(k)) need(isStr(c[k]), `${k} must be a non-empty string`);
  // The files `upload` may use: copied from the worktree's HEAD tree, so a path inside the repo.
  // A leading `-` or `:` would read as an option or a git pathspec magic where it is copied from HEAD.
  if (isStr(c.fixtures)) need(!path.isAbsolute(c.fixtures) && !/^[-:]/.test(c.fixtures) && !c.fixtures.includes("\\") && !c.fixtures.split("/").includes(".."), "fixtures must be a repo-relative directory (no absolute path, no .., no leading - or :)");
  if (isStr(c.timezone) && !isTimeZone(c.timezone)) errs.push(`timezone must be an IANA time zone such as UTC or Europe/Berlin: ${c.timezone}`);
  if (isStr(c.locale) && !isLocale(c.locale)) errs.push(`locale must be a BCP 47 language tag such as en-US: ${c.locale}`);
  if (strArray(c.locales)) for (const l of c.locales.filter((x) => !isLocale(x))) errs.push(`locales must be BCP 47 language tags such as en-US: ${l}`);
  if (has("compose_files")) {
    const v = c.compose_files;
    // No ":": the run joins the files into COMPOSE_FILE with it as the separator.
    const repoRelative = (p) => isStr(p) && !path.isAbsolute(p) && !p.includes("\\") && !p.includes(":") && !p.split("/").includes("..");
    need(Array.isArray(v) && v.length > 0 && v.every(repoRelative) && new Set(v).size === v.length, "compose_files must list one or more distinct repo-relative files (no absolute path, no .., no :)");
  }
  if (has("viewports")) need(Array.isArray(c.viewports) && c.viewports.every((v) => isInt(v, 200, 4000)), "viewports must be an array of widths from 200 to 4000");
  if (has("roles") && object(c.roles, "roles")) for (const [name, r] of Object.entries(c.roles)) role(name, r, errs);
  if (has("limits") && object(c.limits, "limits")) {
    unknown(c.limits, "limits", LIMIT_KEYS);
    need("max_cycle_minutes" in c.limits, 'limits: missing "max_cycle_minutes"');
    for (const k of LIMIT_KEYS) {
      if (!(k in c.limits)) continue;
      if (RANGES[`limits.${k}`]) need(!outOfRange(`limits.${k}`, c.limits[k]), outOfRange(`limits.${k}`, c.limits[k]));
      else need(isInt(c.limits[k], 1), `limits.${k} must be a positive integer`);
    }
    if (isInt(c.limits.max_cycle_minutes, 1)) need(c.limits.max_cycle_minutes <= MAX_CYCLE_MINUTES, `limits.max_cycle_minutes must be at most ${MAX_CYCLE_MINUTES}`);
  }
  placeholders(c, "", errs);
  shellFields(c, [], errs);
  try {
    if (portNames(c).names.length && !has("port_range")) errs.push("port_range is required whenever a {port:<name>} is used");
  } catch (e) {
    errs.push(e.message.replace(/^refused: /, ""));
  }
  return errs;
}

function command(v, where, errs) {
  if (!isObj(v)) return errs.push(`${where} must be {"argv": [<words>], "args": [<regex>]}`);
  for (const k of Object.keys(v)) if (!["argv", "args"].includes(k)) errs.push(`${where}: unknown key "${k}"`);
  if (!(strArray(v.argv) && v.argv.length > 0 && isStr(v.argv[0]))) errs.push(`${where}.argv must be a non-empty array of words`);
  if ("args" in v && !(Array.isArray(v.args) && v.args.every(isRegex))) errs.push(`${where}.args must be an array of valid regexes`);
}

function role(name, r, errs) {
  const where = `roles.${name}`;
  if (!ROLE_NAME.test(name)) return errs.push(`${where}: a role name must match ${ROLE_NAME} (no ".": <role>.<n> names an account)`);
  if (name === "system") return errs.push(`${where}: "system" is reserved`);
  if (ROLE_FREE.includes(name)) return errs.push(`${where}: ${name} is reserved (a wrapper command)`);
  if (!isObj(r)) return errs.push(`${where} must be an object`);
  if (name === "anon") {
    if (Object.keys(r).length) errs.push(`${where}: "anon" is reserved for the signed-out visitor and must be {}`);
    return;
  }
  for (const k of Object.keys(r)) if (!ROLE_KEYS.includes(k)) errs.push(`${where}: unknown key "${k}"`);
  if (("users" in r) === ("login" in r)) errs.push(`${where} must sign in by "users" or by "login", exactly one`);
  if ("users" in r) {
    if (!(Array.isArray(r.users) && r.users.length > 0)) errs.push(`${where}.users must be a non-empty array of {user, password, totp_secret?}`);
    else
      r.users.forEach((u, i) => {
        const w = `${where}.users[${i}]`;
        if (!isObj(u)) return errs.push(`${w} must be {user, password, totp_secret?}`);
        for (const k of Object.keys(u)) if (!USER_KEYS.includes(k)) errs.push(`${w}: unknown key "${k}"`);
        if (!isStr(u.user)) errs.push(`${w}.user must be a non-empty string`);
        if (!isStr(u.password)) errs.push(`${w}.password must be a non-empty string`);
        if ("totp_secret" in u && !isStr(u.totp_secret)) errs.push(`${w}.totp_secret must be a non-empty string`);
      });
  }
  if ("login" in r && !(isObj(r.login) && Object.keys(r.login).join() === "command" && isStr(r.login.command))) errs.push(`${where}.login must be {"command": <command>}`);
  for (const k of ["code_role", "login_url"]) if (k in r && !isStr(r[k])) errs.push(`${where}.${k} must be a non-empty string`);
  for (const k of ["logged_in", "login_open"]) if (k in r) locatorKey(r[k], k, `${where}.${k}`, errs);
  if ("base_url" in r) {
    if (!isStr(r.base_url)) errs.push(`${where}.base_url must be a non-empty string`);
    else localUrl(r.base_url, `${where}.base_url`, errs);
  }
}

/**
 * An http(s) URL whose host is not a non-loopback address. A host name is resolved by `up`, which
 * refuses one that does not resolve to loopback; here only a literal address can be judged.
 */
function localUrl(raw, where, errs) {
  let u;
  try {
    u = new URL(raw.replace(/\{port:[^}]*\}/g, "1").replace(/\$\{[^}]*\}/g, "x"));
  } catch {
    return errs.push(`${where} must be an absolute http(s) URL`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return errs.push(`${where} must be an absolute http(s) URL`);
  const h = u.hostname;
  const literal = /^\d+\.\d+\.\d+\.\d+$/.test(h) || h.startsWith("[");
  if (literal && !(/^127\./.test(h) || h === "[::1]")) errs.push(`${where} must name a loopback host (the instance never reaches another machine): ${h}`);
}

/** `scheme://host[:port]` and nothing more (a default port is fine: origins are compared as `new URL(x).origin`). */
function isOrigin(s) {
  if (!/^https?:\/\/[^/?#@\s]+$/i.test(s)) return false;
  try {
    return new URL(s).origin !== "null";
  } catch {
    return false;
  }
}

/** Every shell field's `${NAME}` must stand where the shell running it expands it. */
function shellFields(v, at, errs) {
  if (typeof v === "string") {
    if (isShellField(at)) {
      const where = at.map((k, i) => (typeof k === "number" ? `[${k}]` : i ? `.${k}` : k)).join("");
      for (const p of shellSecretProblems(v)) errs.push(`${where}: ${p}`);
    }
  } else if (Array.isArray(v)) v.forEach((x, i) => shellFields(x, [...at, i], errs));
  else if (isObj(v)) for (const [k, x] of Object.entries(v)) shellFields(x, [...at, k], errs);
}

/** Every `{port:` in every string must be `{port:<name>}` or `{port:<name>=<port>}`, every `${` a `${NAME}`. */
function placeholders(v, where, errs) {
  if (typeof v === "string") {
    for (const m of v.matchAll(/\$\{/g)) {
      if (!SECRET.test(v.slice(m.index))) errs.push(`${where || LIVE_FILE}: bad placeholder "${v.slice(m.index, m.index + 24)}" (write \${NAME}, NAME matching [A-Za-z_][A-Za-z0-9_]*)`);
    }
    for (const m of v.matchAll(/\{port:([^}]*)\}?/g)) {
      const [name, fixed] = m[1].split("=");
      const ok = m[0].endsWith("}") && PORT_NAME.test(name) && (fixed === undefined || (/^\d+$/.test(fixed) && isPort(Number(fixed))));
      if (!ok) errs.push(`${where || LIVE_FILE}: bad placeholder "${m[0]}" (write {port:<name>} or {port:<name>=<port>}, <name> matching ${PORT_NAME})`);
    }
  } else if (Array.isArray(v)) v.forEach((x, i) => placeholders(x, `${where}[${i}]`, errs));
  else if (isObj(v)) for (const [k, x] of Object.entries(v)) placeholders(x, where ? `${where}.${k}` : k, errs);
}

/**
 * `value` with `{port:<name>}` → `ports[name]`, `{port:<name>=<n>}` → n (recorded in `ports`), and
 * `${NAME}` → `secrets[NAME]`, in one pass (a substituted value is never expanded again). Anything
 * else is left as it is. Throws `unset NAME` (the name only) for an unknown or empty secret, and on a port name
 * not allocated.
 */
export function expand(value, { ports = {}, secrets = {} } = {}) {
  return value.replace(/\{port:([a-z][a-z0-9_-]*)(?:=(\d+))?\}|\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, port, fixed, secret) => {
    if (secret !== undefined) {
      if (!Object.hasOwn(secrets, secret) || secrets[secret] === "") throw new Error(`unset ${secret}`);
      return secrets[secret];
    }
    if (fixed !== undefined) {
      const n = Number(fixed);
      if (Object.hasOwn(ports, port) && ports[port] !== n) throw new Error(`port ${port} is fixed at ${n} but was given ${ports[port]}`);
      ports[port] = n;
      return String(n);
    }
    if (!Object.hasOwn(ports, port)) throw new Error(`port ${port} was not allocated`);
    return String(ports[port]);
  });
}

/** The variable a shell field reads secret `NAME` from. */
const secretVar = (name) => `ARGUS_SECRET_${name}`;

/** `["start", 0, "cmd"]`-style paths of the fields run by `/bin/sh -c`. */
function isShellField(at) {
  const k = at.join(".");
  return /^(store_check|reset|start\.\d+\.(cmd|stop|health\.cmd)|roles\.[^.]+\.login\.command)$/.test(k);
}

/** Why `${NAME}` cannot stand where it stands in a shell field, and what to write instead. */
function misplaced(name, context) {
  const v = secretVar(name);
  if (context === "'") return `\${${name}} inside single quotes is not expanded by the shell that runs this field; write "$${v}" where the inner shell reads it (and pass it into a container by name: -e ${v})`;
  if (context === "<<") return `\${${name}} in a heredoc is not quoted the way the field's other uses are; write $${v} there yourself (no quotes: they are literal in a heredoc body)`;
  return `\${${name}} in a quoted heredoc is never expanded; unquote the heredoc's delimiter and write $${v} there yourself`;
}

/**
 * Walks a shell field, tracking quotes, `$(( ))` arithmetic (where `<<` is a shift) and heredocs (from
 * the line after `<<[-]WORD` to the line holding WORD), and hands each `${NAME}` to `onSecret(name,
 * context)` — context: null outside quotes, '"' inside double quotes, "'" inside single quotes, "<<" in
 * an unquoted heredoc body, "<<'" in a quoted one — which returns its replacement. `{port:…}` is
 * expanded from `ports` (copied as it is when `ports` is null); everything else is copied.
 */
function scanShell(value, { ports = null, onSecret }) {
  const sub = (i, context) => {
    const secret = value.slice(i).match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}/);
    if (secret) return [onSecret(secret[1], context), secret[0].length];
    const port = value.slice(i).match(/^\{port:[a-z][a-z0-9_-]*(?:=\d+)?\}/);
    if (port) return [ports === null ? port[0] : expand(port[0], { ports }), port[0].length];
    return null;
  };
  let out = "";
  let quote = null;
  let arith = 0;
  const heredocs = [];
  let i = 0;
  while (i < value.length) {
    const c = value[i];
    if (c === "\n" && quote === null && heredocs.length) {
      out += c;
      i++;
      for (const h of heredocs.splice(0)) {
        while (i < value.length) {
          const nl = value.indexOf("\n", i);
          const end = nl < 0 ? value.length : nl;
          const line = value.slice(i, end);
          if ((h.dash ? line.replace(/^\t+/, "") : line) === h.word) {
            out += value.slice(i, nl < 0 ? end : nl + 1);
            i = nl < 0 ? end : nl + 1;
            break;
          }
          for (let j = i; j < end; ) {
            const r = sub(j, h.quoted ? "<<'" : "<<");
            if (r) {
              out += r[0];
              j += r[1];
            } else out += value[j++];
          }
          out += nl < 0 ? "" : "\n";
          i = nl < 0 ? end : nl + 1;
        }
      }
      continue;
    }
    if (c === "\\" && quote !== "'") {
      out += value.slice(i, i + 2);
      i += 2;
      continue;
    }
    if ((c === "'" || c === '"') && (quote === null || quote === c)) {
      quote = quote === null ? c : null;
      out += c;
      i++;
      continue;
    }
    if (quote === null && value.startsWith("$((", i)) {
      arith++;
      out += "$((";
      i += 3;
      continue;
    }
    if (quote === null && arith && value.startsWith("))", i)) {
      arith--;
      out += "))";
      i += 2;
      continue;
    }
    if (quote === null && !arith && value.startsWith("<<", i)) {
      if (value.startsWith("<<<", i)) {
        out += "<<<";
        i += 3;
        continue;
      }
      const m = value.slice(i + 2).match(/^(-?)[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/);
      if (m) {
        heredocs.push({ dash: m[1] === "-", quoted: m[2] !== "", word: m[3] });
        out += value.slice(i, i + 2 + m[0].length);
        i += 2 + m[0].length;
        continue;
      }
    }
    const r = sub(i, quote);
    if (r) {
      out += r[0];
      i += r[1];
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** The `${NAME}` placements in a shell field the shell would not expand (empty = fine). */
export function shellSecretProblems(value) {
  const problems = [];
  scanShell(value, {
    onSecret: (name, context) => {
      if (context !== null && context !== '"') problems.push(misplaced(name, context));
      return "";
    },
  });
  return problems;
}

/**
 * A shell field expanded: `{port:…}` as everywhere, but `${NAME}` becomes a reference to the variable
 * `ARGUS_SECRET_<NAME>` (`"${…}"` outside quotes, `${…}` inside double quotes), so the shell reads
 * the value as data from that command's environment (`secretEnv`) and it is never written into the
 * command text. `${NAME}` inside single quotes or a heredoc is refused (the shell running the field
 * would not expand it there). A `$ARGUS_SECRET_<NAME>` the owner wrote for an inner shell must name a
 * set secret. Throws `unset NAME` like `expand`.
 */
export function expandShell(value, { ports = {}, secrets = {} } = {}) {
  const need = (name) => {
    if (!Object.hasOwn(secrets, name) || secrets[name] === "") throw new Error(`unset ${name}`);
  };
  for (const [, name] of value.matchAll(/\$\{?ARGUS_SECRET_([A-Za-z_][A-Za-z0-9_]*)/g)) need(name);
  return scanShell(value, {
    ports,
    onSecret: (name, context) => {
      if (context !== null && context !== '"') throw new Error(`refused: ${misplaced(name, context)}`);
      need(name);
      const ref = `\${${secretVar(name)}}`;
      return context === '"' ? ref : `"${ref}"`;
    },
  });
}

/** The environment a shell field needs: `ARGUS_SECRET_<NAME>=<value>` for each secret it references. */
export function secretEnv(cmd, secrets = {}) {
  const env = {};
  for (const [, name] of String(cmd ?? "").matchAll(/\$\{?ARGUS_SECRET_([A-Za-z_][A-Za-z0-9_]*)/g)) {
    if (Object.hasOwn(secrets, name)) env[secretVar(name)] = secrets[name];
  }
  return env;
}

/**
 * A deep copy of `config` with every string expanded; `config` itself is left as it is. Shell fields
 * (`store_check`, `reset`, `start[].cmd|stop|health.cmd`, `roles.<r>.login.command`) go through
 * `expandShell`; everything else (argv lists, env values, URLs) gets the values themselves.
 */
export function expandConfig(config, { ports = {}, secrets = {} } = {}) {
  const walk = (v, at) => {
    if (typeof v === "string") return isShellField(at) ? expandShell(v, { ports, secrets }) : expand(v, { ports, secrets });
    if (Array.isArray(v)) return v.map((x, i) => walk(x, [...at, i]));
    if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, [...at, k])]));
    return v;
  };
  return walk(config, []);
}

/**
 * The `${NAME}` values `value` holds where `template` (a non-shell config string) names them, as
 * `{NAME: value}` — `{}` when the template names none, null when `value` is not an expansion of it.
 * `{port:<name>}` stands for any number. Used to recover the env_file's values as `up` read them from
 * the values run.json recorded.
 */
export function secretsIn(template, value) {
  if (typeof template !== "string" || typeof value !== "string") return null;
  const names = [];
  let re = "";
  let last = 0;
  for (const m of template.matchAll(/\{port:[a-z][a-z0-9_-]*(?:=\d+)?\}|\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
    re += template.slice(last, m.index).replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    if (m[1] === undefined) re += "\\d+";
    else if (names.includes(m[1])) re += `\\k<s${names.indexOf(m[1])}>`;
    else {
      re += `(?<s${names.length}>[\\s\\S]+?)`;
      names.push(m[1]);
    }
    last = m.index + m[0].length;
  }
  re += template.slice(last).replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const hit = new RegExp(`^${re}$`).exec(value);
  return hit ? Object.fromEntries(names.map((n, i) => [n, hit.groups[`s${i}`]])) : null;
}

/**
 * The ports the config asks for, before anything is expanded: `names` = every `{port:<name>}` in
 * every string, in order of first appearance; `fixed` = `{name: n}` for each `{port:<name>=<n>}`
 * (a fixed name is not in `names`). A name fixed at two different ports, and a port fixed for two
 * names, are refused.
 */
export function portNames(config) {
  const seen = [];
  const fixed = {};
  const walk = (v) => {
    if (typeof v === "string") {
      for (const [, name, n] of v.matchAll(/\{port:([a-z][a-z0-9_-]*)(?:=(\d+))?\}/g)) {
        if (n === undefined) {
          if (!seen.includes(name)) seen.push(name);
        } else if (Object.hasOwn(fixed, name) && fixed[name] !== Number(n)) {
          throw new Error(`refused: port ${name} is fixed at both ${fixed[name]} and ${n}`);
        } else fixed[name] = Number(n);
      }
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (isObj(v)) Object.values(v).forEach(walk);
  };
  walk(config);
  const owner = {};
  for (const [name, n] of Object.entries(fixed)) {
    if (Object.hasOwn(owner, n)) throw new Error(`refused: port ${n} is fixed for both ${owner[n]} and ${name}`);
    owner[n] = name;
  }
  return { names: seen.filter((n) => !Object.hasOwn(fixed, n)), fixed };
}

/** `KEY=value` lines; `#` comments, blank lines, `export ` and matching outer quotes allowed. */
export function parseEnvFile(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    const q = v[0];
    const close = q === '"' || q === "'" ? v.indexOf(q, 1) : -1;
    out[m[1]] = close > 0 ? v.slice(1, close) : v.replace(/(^|\s+)#.*$/, "");
  }
  return out;
}

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/**
 * {config, errors, secrets, digest} from `<main>/.argus/live.json` and `<main>/<env_file>`. `digest` =
 * {live, env_file}: the sha256 of each file's bytes as read (null when not read), so a run can tell
 * either changed since its `up`. Never throws.
 */
export function loadLive(main) {
  const file = path.join(main, LIVE_FILE);
  const digest = { live: null, env_file: null };
  let config;
  try {
    const raw = fs.readFileSync(file, "utf8");
    digest.live = sha256(raw);
    config = JSON.parse(raw);
  } catch (e) {
    const why = e && e.code === "ENOENT" ? "is missing (/sapu:init writes it)" : e instanceof SyntaxError ? `is not valid JSON: ${e.message}` : `cannot be read: ${e.message}`;
    return { config: null, errors: [`${LIVE_FILE} ${why}`], secrets: {}, digest };
  }
  const errors = validateLive(config);
  let secrets = {};
  if (isObj(config) && isStr(config.env_file)) {
    const rel = config.env_file;
    const outside = (base, p) => {
      const up = path.relative(base, p);
      return up === "" || up === ".." || up.startsWith(`..${path.sep}`) || path.isAbsolute(up);
    };
    const inside = `env_file must be a path inside the repo: ${rel}`;
    if (path.isAbsolute(rel) || outside(main, path.resolve(main, rel))) errors.push(inside);
    else {
      try {
        // Real paths on both sides: a symlink out of the repo must not pass as a file inside it.
        const real = fs.realpathSync(path.resolve(main, rel));
        if (outside(fs.realpathSync(main), real)) errors.push(inside);
        else {
          const raw = fs.readFileSync(real, "utf8");
          digest.env_file = sha256(raw);
          secrets = parseEnvFile(raw);
        }
      } catch (e) {
        errors.push(`env_file ${rel} ${e && e.code === "ENOENT" ? "is missing" : `cannot be read: ${e.message}`}`);
      }
    }
  }
  return { config, errors, secrets, digest };
}
