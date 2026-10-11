// argus-live-literal.mjs — a secret written literally into `.argus/live.json` (spec §8): the file may be
// committed, and its secrets come only from `env_file` as `${NAME}`. What looks like one, in every string
// the lane hands to a process, a shell or a URL (`env` and each start entry's `env`, the shell fields, the
// argv lists, the URLs): a known credential shape (a private key block, Stripe, GitHub, GitLab, AWS, Slack,
// Google, npm, SendGrid, an `sk-` API key, a JWT), a password in a URL, a value assigned to a name that says
// it is a secret (`password=x`, `--token x`, `"api_key": "x"`, an env entry `SESSION_SECRET`), a bearer
// credential and a long random token — read raw, unescaped, URL- or entity-decoded (twice) and inside base64
// or hex. The configuration module refuses what this finds; scrub masks what a looser name test and token
// floor find. A leaf module.

/** Known credential shapes: [the words a finding uses, the pattern]. */
const SHAPES = [
  ["a private key", /-----BEGIN[A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/],
  ["a Stripe secret key", /(?<![A-Za-z0-9])[sr]k_(?:live|test)_[A-Za-z0-9]{8,}/],
  ["a GitHub token", /(?<![A-Za-z0-9])(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/],
  ["a GitLab token", /(?<![A-Za-z0-9])glpat-[A-Za-z0-9_-]{20,}/],
  ["an AWS access key", /(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])/],
  ["a Slack token", /(?<![A-Za-z0-9])xox[a-z]-[A-Za-z0-9-]{10,}/],
  ["a Google API key", /(?<![A-Za-z0-9])AIza[A-Za-z0-9_-]{30,}/],
  ["an npm token", /(?<![A-Za-z0-9])npm_[A-Za-z0-9]{30,}/],
  ["a SendGrid key", /(?<![A-Za-z0-9])SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/],
  ["an API key", /(?<![A-Za-z0-9])sk-(?:[A-Za-z]+-)?(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{20,}/],
  ["a JWT", /(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/],
];

/** The last word of a name that says its value is a secret (`DB_PASSWORD`, `PGPASSWORD`, `--token`, `apiSecret`, `MYSQL_PWD`); a short one only whole (never `bypass`). */
const SECRET_LAST = /(?:password|passwd|passphrase|secret|token|apikey|credentials?)$|^(?:pass|pwd|pin|authorization)$/;
/** The word before a last `key` that makes it a secret (`API_KEY`, `stripeSecretKey`, `APP_KEY`). */
const KEY_KIND = /^(?:api|secret|private|access|app|master|encryption|signing|auth|client|license|service|account|session|cookie|jwt|hmac|webhook|csrf)$/;
/** A name's words, split at anything but a letter or digit and where camelCase turns, lower case. */
const words = (name) =>
  String(name)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());

/**
 * A name whose last word says its value is a secret (SECRET_LAST, `<kind> key`, `key base`), unless a word
 * says it is public (`NEXT_PUBLIC_…`, `…_PUBLISHABLE_KEY`). `PASSWORD_MIN_LENGTH` and `TOKEN_TTL` say a setting.
 */
export function secretFinalName(name) {
  const w = words(name);
  if (!w.length || w.some((x) => x === "public" || x === "publishable")) return false;
  const [prev, last] = [w.at(-2), w.at(-1)];
  return SECRET_LAST.test(last) || (last === "key" && KEY_KIND.test(prev ?? "")) || (last === "base" && prev === "key");
}

const SWITCH = /^(?:true|false|yes|no|on|off|null|none|nil|undefined)$/i;
/** An authorization scheme's word: what follows it is the credential. */
const SCHEME = /^(?:bearer|basic|token|digest)$/i;
/** A URL with no user and password: an address, never a secret. */
const PLAIN_URL = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^@\s]*$/;

/**
 * A value written out: not empty, holds a letter or digit, and is no reference (`$X`, `${NAME}`, `$(…)`), no
 * placeholder (`{port:…}`, `{1}`, `{{marker}}`, `<…>`), no switch word and no option (`-…`).
 */
function literal(v) {
  const s = String(v).trim();
  return s !== "" && /[A-Za-z0-9]/.test(s) && !/^(?:[$<-]|\{(?:port:|[0-9]+\}|\{))/.test(s) && !s.includes("${") && !s.includes("{port:") && !SWITCH.test(s);
}

/** `${NAME}` and `{port:…}`: references, blanked before a text is cut into tokens. */
const PLACEHOLDERS = /\$\{[A-Za-z_][A-Za-z0-9_]*\}|\{port:[^}]*\}/g;
/** `name=value`, `name: value`, `"name": "value"` (a `--` before the name allowed): the name, the value quoted or plain. */
const ASSIGN = /(?<![A-Za-z0-9_.-])(?:--?)?([A-Za-z][A-Za-z0-9_.-]*)["']?\s*[=:]\s*(?:(["'])(.*?)\2|([^\s"'&;,|)}]+))/g;
/** `--name value` / `-name value`: an option and the word after it. */
const OPTION = /(?<![^\s"'])--?([A-Za-z][A-Za-z0-9_-]*)\s+(?:(["'])(.*?)\2|([^\s"'&;|)]+))/g;
/** A user and password in a URL: the password. */
const USERINFO = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/\s:@"']*:([^/\s@"']+)@/g;
/** `Bearer <x>` / `Basic <x>`: the credential. */
const BEARER = /(?<![A-Za-z])(?:bearer|basic)\s+([A-Za-z0-9._~+/=-]{8,})/gi;
/** A word a random token is made of: base64, base64url and hex characters. */
const TOKEN = /[A-Za-z0-9+/=_-]+/g;

const kindOf = (ch) => (/[a-z]/.test(ch) ? 0 : /[A-Z]/.test(ch) ? 1 : /[0-9]/.test(ch) ? 2 : 3);
/**
 * A random token of at least `min` characters: lower case, upper case and digits, the kind of character
 * changing at 4 of every 10 steps or more (a random base62 string changes at about 6; `resetDatabase2Fixtures`,
 * a path or an upper-case UUID do not qualify).
 */
function randomToken(w, min = 20) {
  if (w.length < min || !/[a-z]/.test(w) || !/[A-Z]/.test(w) || !/[0-9]/.test(w)) return false;
  let turns = 0;
  for (let i = 1; i < w.length; i++) if (kindOf(w[i]) !== kindOf(w[i - 1])) turns++;
  return turns >= 0.4 * (w.length - 1);
}

const cp = (n) => (n <= 0x10ffff ? String.fromCodePoint(n) : "");
const NAMED = { quot: '"', amp: "&", lt: "<", gt: ">", apos: "'" };
/** `\xHH`, `\uXXXX`, `\u{…}` and a backslash before a quote, a slash or itself, read. */
const unescaped = (s) => s.replace(/\\u\{([0-9a-fA-F]{1,6})\}|\\u([0-9a-fA-F]{4})|\\x([0-9a-fA-F]{2})|\\(["'\\/])/g, (m, a, b, c, d) => d ?? cp(parseInt(a ?? b ?? c, 16)));
/** Each `%HH` run (valid UTF-8) and HTML entity read once. */
const decodedOnce = (s) =>
  s
    .replace(/(?:%[0-9A-Fa-f]{2})+/g, (m) => {
      try {
        return decodeURIComponent(m);
      } catch {
        return m;
      }
    })
    .replace(/&(?:#([0-9]{1,7})|#[xX]([0-9A-Fa-f]{1,6})|(quot|amp|lt|gt|apos));/g, (m, d, h, n) => (n ? NAMED[n] : cp(d ? Number(d) : parseInt(h, 16))) || m);
const PRINTABLE = /^[\x20-\x7e\t\r\n]+$/;
/** The printable texts base64 (or base64url) runs and hex runs in `s` decode to. */
function embedded(s, re, decode) {
  const out = [];
  for (const [m] of s.matchAll(re)) {
    const t = decode(m);
    if (t.length >= 8 && PRINTABLE.test(t)) out.push(t);
  }
  return out;
}

/** `s` as written and in each encoding scrub reads → [[label, text]]: the label is null for the text as written. */
function views(s) {
  const out = [[null, s]];
  const add = (label, t) => {
    if (t && !out.some(([, x]) => x === t)) out.push([label, t]);
  };
  add("escaped", unescaped(s));
  const once = decodedOnce(s);
  add("URL- or entity-encoded", once);
  add("URL- or entity-encoded", decodedOnce(once));
  for (const t of embedded(s, /[A-Za-z0-9+/_-]{16,}={0,2}/g, (m) => Buffer.from(m.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"))) add("base64-encoded", t);
  for (const t of embedded(s, /(?:[0-9a-fA-F]{2}){8,}/g, (m) => Buffer.from(m, "hex").toString("utf8"))) add("hex-encoded", t);
  return out;
}

/** The strings of `c` the lane hands to a process, a shell or a URL → [{where, text, name?}] (`name`: an env entry's). */
function fields(c) {
  const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  const out = [];
  const str = (where, v) => typeof v === "string" && out.push({ where, text: v });
  // An argv list as one line: a word holding a space or a quote quoted, so an option and its value stay apart.
  const argv = (where, a) => Array.isArray(a) && a.every((x) => typeof x === "string") && out.push({ where, text: a.map((w) => (/[\s"']/.test(w) ? JSON.stringify(w) : w)).join(" ") });
  const env = (where, e) => {
    if (isObj(e)) for (const [k, v] of Object.entries(e)) if (typeof v === "string") out.push({ where: `${where}.${k}`, text: v, name: k });
  };
  if (!isObj(c)) return out;
  env("env", c.env);
  if (Array.isArray(c.setup)) c.setup.forEach((a, i) => argv(`setup[${i}]`, a));
  if (Array.isArray(c.start)) {
    c.start.forEach((e, i) => {
      if (!isObj(e)) return;
      for (const k of ["cmd", "stop"]) str(`start[${i}].${k}`, e[k]);
      env(`start[${i}].env`, e.env);
      if (isObj(e.health)) for (const k of ["url", "cmd"]) str(`start[${i}].health.${k}`, e.health[k]);
    });
  }
  for (const k of ["base_url", "login_url", "store_check", "reset"]) str(k, c[k]);
  for (const k of ["facts", "mail"]) if (isObj(c[k])) argv(`${k}.argv`, c[k].argv);
  if (isObj(c.triggers)) for (const [n, t] of Object.entries(c.triggers)) if (isObj(t)) argv(`triggers.${n}.argv`, t.argv);
  if (isObj(c.roles)) {
    for (const [n, r] of Object.entries(c.roles)) {
      if (!isObj(r)) continue;
      for (const k of ["base_url", "login_url"]) str(`roles.${n}.${k}`, r[k]);
      if (isObj(r.login)) str(`roles.${n}.login.command`, r.login.command);
    }
  }
  return out;
}

/** An assigned name as a finding shows it: its own characters, at most 40. */
const shown = (name) => name.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 40);

/** The findings of one view's text → [{kind, value, name?}]. */
function scan(text, { named, minToken }) {
  const found = [];
  const put = (kind, value, name) => found.push(name === undefined ? { kind, value } : { kind, value, name });
  for (const [kind, re] of SHAPES) for (const m of text.matchAll(new RegExp(re.source, "g"))) put(kind, m[0]);
  for (const m of text.matchAll(USERINFO)) if (literal(m[1])) put("a password in a URL", m[1]);
  for (const m of text.matchAll(BEARER)) if (literal(m[1]) && (/[0-9=]/.test(m[1]) || m[1].length >= 20)) put("a bearer credential", m[1]);
  for (const re of [ASSIGN, OPTION]) {
    for (const m of text.matchAll(re)) {
      const v = m[3] ?? m[4] ?? "";
      if (named(m[1]) && literal(v) && !SCHEME.test(v) && !PLAIN_URL.test(v)) put(`a value for "${shown(m[1])}"`, v, m[1]);
    }
  }
  // A token that starts with `/` (an absolute path, `./…`, `~/…`: `.` and `~` cut tokens) is a path, each
  // segment judged alone; any other is judged whole, so base64's `/` does not cut a key apart.
  for (const [w] of text.replace(PLACEHOLDERS, " ").matchAll(TOKEN)) {
    for (const part of w.startsWith("/") ? w.split("/") : [w]) if (randomToken(part, minToken)) put("a long random token", part);
  }
  return found;
}

/**
 * Every literal secret in config `c` → [{where, kind, value, name?}], distinct by where, kind and value: `kind`
 * names what it looks like (its encoding after it in parentheses when found only decoded), `value` is what
 * was found (scrub's, never a message's), `name` the variable or option it is assigned to. `named` decides
 * which names say a secret (default secretFinalName); `minToken` is the shortest random token (default 20).
 */
export function literalFindings(c, { named = secretFinalName, minToken = 20 } = {}) {
  const out = [];
  const seen = new Set();
  for (const f of fields(c)) {
    const hits = [];
    // An env entry whose name says secret: its whole value, unless a reference, a switch or a plain URL.
    if (f.name !== undefined && named(f.name) && literal(f.text) && !PLAIN_URL.test(f.text)) hits.push({ kind: "a value its name says is secret", value: f.text, name: f.name });
    // A kind found in an earlier view (the text as written first) is not found again decoded.
    const kinds = new Set();
    for (const [label, text] of views(f.text)) {
      const found = scan(text, { named, minToken }).filter((h) => !kinds.has(h.kind) || label === null);
      for (const h of found) hits.push({ ...h, kind: label ? `${h.kind} (${label})` : h.kind });
      for (const h of found) kinds.add(h.kind);
    }
    for (const h of hits) {
      const key = `${f.where}\0${h.kind}\0${h.value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ where: f.where, ...h });
    }
  }
  return out;
}
