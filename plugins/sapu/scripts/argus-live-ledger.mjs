// argus-live-ledger.mjs — the run's secret ledger and the ids its pages saw (spec §10 "Scrub"): every
// secret-like cookie, header and storage value the sessions' drains found, and the passwords of the
// accounts a journey created, appended to `logs/secrets.jsonl` (0600) — kept by `down`, so scrub never
// needs the run live, and removed by the next `up` — with a marker when anything may be missing; the ids
// (path segments, JSON values) to leave readable in an issue in `logs/seen.jsonl`; and the matcher scrub
// refuses an issue by, which says where a secret is and never what it is.
import fs from "node:fs";
import path from "node:path";
import { PatternError, secretPatterns } from "./argus-live-fence.mjs";
import { liveDir, RUN_ID } from "./argus-live-lock.mjs";
import { logsDir } from "./argus-live-run.mjs";

/** A ledger-class value shorter than this is not recorded (it would refuse every issue; `pw`'s fence still masks it). */
export const MIN_SECRET = 6;
/** Every value is cut to this many characters: a prefix still finds its own leak. */
export const MAX_SECRET = 4096;
/** A cookie, storage key or JSON key whose name says it holds a secret. */
export const SECRET_KEY = /password|passwd|secret|token|auth|session|sid|jwt|bearer|api[-_]?key|credential|sig|cookie/i;
/** A JSON key whose value is never an id the run saw, however id-like. */
export const SEEN_SKIP_KEY = /token|secret|key|pass|session|auth|csrf|cookie|bearer|value|jwt|credential|sig|signature|code|otp|nonce/i;
/** A path segment after one of these names a one-time secret (`/password-reset/<x>`, `/verify-email/<x>`), never an id. */
const SEEN_SKIP_SEGMENT = /reset|verify|invite|magic|token|confirm|activate|unsubscribe/i;
/** The classes the drains record; only theirs have the MIN_SECRET floor. */
export const LEDGER_CLASSES = ["cookie", "header", "storage"];

/** At least 16 characters, at least three of lower case, upper case, digit and other, no whitespace. */
export function highEntropy(v) {
  const s = String(v);
  if (s.length < 16 || /\s/.test(s)) return false;
  return [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(s)).length >= 3;
}

/** The run's secret ledger: `<logsDir>/secrets.jsonl`. */
export function ledgerFile(main, runId) {
  return path.join(logsDir(main, runId), "secrets.jsonl");
}

/** The ids the run's pages saw: `<logsDir>/seen.jsonl`. */
export function seenFile(main, runId) {
  return path.join(logsDir(main, runId), "seen.jsonl");
}

/** Each string leaf of a JSON object or array as `[key, value]` (an array's leaves under its own key), else null when `v` is not one. */
function jsonLeaves(v) {
  let parsed;
  try {
    parsed = JSON.parse(v);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const out = [];
  const walk = (x, key, depth) => {
    if (depth > 32) return;
    if (typeof x === "string") out.push([key, x]);
    else if (Array.isArray(x)) for (const y of x) walk(y, key, depth + 1);
    else if (x && typeof x === "object") for (const [k, y] of Object.entries(x)) walk(y, k, depth + 1);
  };
  walk(parsed, "", 0);
  return out;
}

/** `name=value; …` (a Cookie header) or `name=value; Attr; …` (a Set-Cookie value) → `{name, value}` pairs. */
const cookiePairs = (text) =>
  String(text)
    .split(";")
    .map((p) => p.trim())
    .filter((p) => p.includes("="))
    .map((p) => ({ name: p.slice(0, p.indexOf("=")).trim(), value: p.slice(p.indexOf("=") + 1).trim() }));

/**
 * A drain's values → the ledger's entries `[{c, v}]`: from `cookies` (`{name, value, httpOnly, secure}`,
 * the context's) and the `cookie` pairs of a Cookie header or the first pair of a Set-Cookie value, a
 * value whose name matches SECRET_KEY, that is flagged HttpOnly or Secure (its Set-Cookie attributes, or
 * the context's cookie of that name) or that is highEntropy; from `storage` (`{key, value}`), a value
 * whose key matches SECRET_KEY or that is highEntropy — a JSON object or array never whole, each string
 * leaf by the same rule under its own key; from `headers` (`[name, value]`), Authorization and
 * Proxy-Authorization whole and without their scheme word, every `*-token` value whole. Classes: `cookie`
 * (the context's), `header` (a header's, cookie pairs included), `storage`. Each value cut to MAX_SECRET;
 * one shorter than MIN_SECRET dropped; duplicates dropped.
 */
export function ledgerEntries({ cookies = [], storage = [], headers = [] } = {}) {
  const out = [];
  const seen = new Set();
  const add = (c, value) => {
    const v = String(value ?? "").slice(0, MAX_SECRET);
    if (v.length < MIN_SECRET || seen.has(`${c}\0${v}`)) return;
    seen.add(`${c}\0${v}`);
    out.push({ c, v });
  };
  const flagged = new Set((Array.isArray(cookies) ? cookies : []).filter((k) => k && (k.httpOnly || k.secure)).map((k) => k.name));
  const cookieLike = (name, value, flag) => SECRET_KEY.test(String(name)) || flag || flagged.has(name) || highEntropy(value);
  for (const k of Array.isArray(cookies) ? cookies : []) if (k && typeof k.value === "string" && cookieLike(k.name, k.value, k.httpOnly || k.secure)) add("cookie", k.value);
  const storageLike = (key, value) => {
    const leaves = jsonLeaves(value);
    if (leaves) {
      for (const [k, x] of leaves) storageLike(k, x);
      return;
    }
    if (SECRET_KEY.test(String(key)) || highEntropy(value)) add("storage", value);
  };
  for (const s of Array.isArray(storage) ? storage : []) if (s && typeof s.value === "string") storageLike(s.key, s.value);
  for (const h of Array.isArray(headers) ? headers : []) {
    if (!Array.isArray(h) || typeof h[1] !== "string") continue;
    const name = String(h[0]).toLowerCase();
    const value = h[1];
    if (name === "authorization" || name === "proxy-authorization") {
      add("header", value);
      const m = /^\S+\s+([\s\S]+)$/.exec(value.trim());
      if (m) add("header", m[1]);
    } else if (name === "cookie") {
      for (const p of cookiePairs(value)) if (cookieLike(p.name, p.value, false)) add("header", p.value);
    } else if (name === "set-cookie") {
      const [first] = cookiePairs(value.split(";")[0]);
      const attrs = value.split(";").slice(1).map((a) => a.trim().toLowerCase());
      if (first && cookieLike(first.name, first.value, attrs.includes("httponly") || attrs.includes("secure"))) add("header", first.value);
    } else if (/-token$/.test(name)) add("header", value);
  }
  return out;
}

/** The ledger's lines → `{c, v}` objects; a line that is not one throws (or is skipped, `lenient`). */
function parseLines(text, lenient) {
  const out = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    let e = null;
    try {
      e = JSON.parse(line);
    } catch {
      e = null;
    }
    if (e && typeof e === "object" && typeof e.c === "string" && typeof e.v === "string") out.push({ c: e.c, v: e.v });
    else if (!lenient) throw new Error("refused: scrub: the run's secret ledger is damaged");
  }
  return out;
}

/** `file`'s text, or null when it is gone. */
function readOrNull(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") return null;
    throw e;
  }
}

/** Appends `lines` (each a JSON line) to `file` (0600, created with the run's 0700 `logs/`) in one write; the file is created even with none. */
function appendLines(main, runId, file, lines) {
  fs.mkdirSync(logsDir(main, runId), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, lines.map((l) => `${l}\n`).join(""), { mode: 0o600 });
}

/**
 * Appends `entries` (`[{c, v}]`: ledgerEntries' classes, `created password`, the marker `incomplete`) to
 * run `runId`'s ledger, those not already in it and not empty, as one write (0600). The file exists
 * afterwards whatever was appended: a run whose sessions were drained has a ledger.
 */
export function appendLedger(main, runId, entries) {
  const file = ledgerFile(main, runId);
  const have = new Set(parseLines(readOrNull(file) ?? "", true).map((e) => `${e.c}\0${e.v}`));
  const lines = [];
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || typeof e.c !== "string" || typeof e.v !== "string" || e.v === "" || have.has(`${e.c}\0${e.v}`)) continue;
    have.add(`${e.c}\0${e.v}`);
    lines.push(JSON.stringify({ c: e.c, v: e.v }));
  }
  appendLines(main, runId, file, lines);
}

/**
 * Run `runId`'s ledger → `{entries: [{c, v}], incomplete: <the first marker's v> | null}` (the markers
 * among the entries), or null when the file is gone; a line that is not `{c, v}` JSON throws `refused:
 * scrub: the run's secret ledger is damaged`.
 */
export function readLedger(main, runId) {
  const text = readOrNull(ledgerFile(main, runId));
  if (text === null) return null;
  const entries = parseLines(text, false);
  const marker = entries.find((e) => e.c === "incomplete");
  return { entries, incomplete: marker ? marker.v : null };
}

/** Removes `logs/secrets.jsonl` of every run directory under `.argus/live/` but `keep`'s (the new run's): `up`'s step 1. */
export function dropLedgers(main, { keep }) {
  let names;
  try {
    names = fs.readdirSync(liveDir(main), { withFileTypes: true });
  } catch {
    return;
  }
  for (const d of names) {
    if (!d.isDirectory() || d.name === keep || !RUN_ID.test(d.name)) continue;
    fs.rmSync(ledgerFile(main, d.name), { force: true });
  }
}

/** An id's shape: 24+ characters of `[A-Za-z0-9_-]` holding a letter and a digit. */
const idShaped = (v) => typeof v === "string" && /^[A-Za-z0-9_-]{24,}$/.test(v) && /[A-Za-z]/.test(v) && /[0-9]/.test(v);

/**
 * The ids a drain's raw `paths` (`[previous segment, segment]` of the run origins' requests) and
 * `leaves` (`[key, value]` of their JSON responses) hold: id-shaped values, never one under a key
 * matching SEEN_SKIP_KEY, after a segment matching a one-time-secret route, or starting `eyJ` (a JWT or
 * other base64 JSON) → distinct values in order.
 */
export function seenIds({ paths = [], leaves = [] } = {}) {
  const out = new Set();
  for (const p of Array.isArray(paths) ? paths : []) if (Array.isArray(p) && idShaped(p[1]) && !SEEN_SKIP_SEGMENT.test(String(p[0] ?? "")) && !p[1].startsWith("eyJ")) out.add(p[1]);
  for (const l of Array.isArray(leaves) ? leaves : []) if (Array.isArray(l) && idShaped(l[1]) && !SEEN_SKIP_KEY.test(String(l[0] ?? "")) && !l[1].startsWith("eyJ")) out.add(l[1]);
  return [...out];
}

/** Appends `values` not already in run `runId`'s `seen.jsonl` (one JSON string a line, 0600). */
export function appendSeen(main, runId, values) {
  const file = seenFile(main, runId);
  const have = readSeen(main, runId);
  const lines = [];
  for (const v of Array.isArray(values) ? values : []) {
    if (typeof v !== "string" || have.has(v)) continue;
    have.add(v);
    lines.push(JSON.stringify(v));
  }
  if (lines.length) appendLines(main, runId, file, lines);
}

/** Run `runId`'s seen ids, as a Set (empty when none were kept; a line that is not a JSON string is skipped). */
export function readSeen(main, runId) {
  const out = new Set();
  for (const line of (readOrNull(seenFile(main, runId)) ?? "").split("\n")) {
    try {
      const v = JSON.parse(line);
      if (typeof v === "string") out.add(v);
    } catch {
      // not a line of ours
    }
  }
  return out;
}

/** Whitespace, punctuation, symbols and invisible format characters (a soft hyphen, U+200B, U+2060): what a value is spelled out with, and stripped of. */
const SEPARATOR = /[\s\p{P}\p{S}\p{Cf}]/u;
const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** `text` without the characters `drop` matches → `{text, at}`, `at[i]` the index in `text` of the i-th kept character. */
function stripped(text, drop) {
  let out = "";
  const at = [];
  for (let i = 0; i < text.length; i++) {
    if (drop.test(text[i])) continue;
    out += text[i];
    at.push(i);
  }
  return { text: out, at };
}

/** `text` with each run of `%HH` decoded (as UTF-8) and `+` read as a space → `{text, at}` (each decoded character placed at its run's first character). */
function urlDecoded(text) {
  let out = "";
  const at = [];
  for (let i = 0; i < text.length; ) {
    const m = /^(?:%[0-9A-Fa-f]{2})+/.exec(text.slice(i));
    if (m) {
      const s = Buffer.from(m[0].replace(/%/g, ""), "hex").toString("utf8");
      for (const ch of s) {
        out += ch;
        for (let k = 0; k < ch.length; k++) at.push(i);
      }
      i += m[0].length;
    } else {
      out += text[i] === "+" ? " " : text[i];
      at.push(i);
      i += 1;
    }
  }
  return { text: out, at };
}

/** Every index of `re`'s matches in `s`. */
function matchIndexes(re, s) {
  const out = [];
  for (const m of s.matchAll(re)) out.push(m.index);
  return out;
}

/** A short value as a whole token — not after or before a letter or digit —, raw or spelled out with separators (SEPARATOR) between its characters. */
const tokenPattern = (v) =>
  new RegExp(`(?<![\\p{L}\\p{N}])${[...v].map(reEscape).join("[\\s\\p{P}\\p{S}\\p{Cf}]*")}(?![\\p{L}\\p{N}])`, "gu");

/**
 * Where `secrets` (`[{cls, v}]`) occur in `text` → `[{line, col, cls}]` (1-based), sorted by line,
 * column and class, distinct. Empty values are ignored; a value of a class in LEDGER_CLASSES counts only
 * at MIN_SECRET or more. A value of MIN_SECRET or more is found by secretPatterns (its every encoding,
 * base64 and hex included, from its first PATTERN_CHARS characters: a prefix still finds the leak) or,
 * the text and the value each stripped of SEPARATOR, as a substring (the stripped value MIN_SECRET or
 * more; a shorter one is matched as a short value is). A shorter value is found only as a whole token:
 * raw, URL-decoded, as its base64 (padded, unpadded or URL-safe) and spelled out with SEPARATOR between
 * its characters — never as a part of a longer word. A hit in a stripped or decoded form is placed at its
 * first character in `text`. A pattern that cannot be built or run throws a PatternError `refused: scrub: a
 * <class> value could not be checked; nothing is filed` — never the engine's message, which quotes the value.
 */
export function secretHits(text, secrets) {
  const t = String(text ?? "");
  const hits = new Map();
  const place = (index, cls) => {
    const before = t.slice(0, index);
    const line = before.split("\n").length;
    const col = index - (before.lastIndexOf("\n") + 1) + 1;
    hits.set(`${line}\0${col}\0${cls}`, { line, col, cls });
  };
  const short = (v, cls) => {
    for (const i of matchIndexes(tokenPattern(v), t)) place(i, cls);
    const dec = urlDecoded(t);
    for (const i of matchIndexes(tokenPattern(v), dec.text)) place(dec.at[i], cls);
    const b64 = Buffer.from(v, "utf8").toString("base64");
    for (const form of new Set([b64, b64.replace(/=+$/, ""), Buffer.from(v, "utf8").toString("base64url")])) {
      for (const i of matchIndexes(new RegExp(`(?<![\\p{L}\\p{N}])${reEscape(form)}(?![\\p{L}\\p{N}])`, "gu"), t)) place(i, cls);
    }
  };
  const flat = stripped(t, SEPARATOR);
  for (const s of Array.isArray(secrets) ? secrets : []) {
    if (!s || typeof s.v !== "string" || s.v === "") continue;
    const v = s.v.slice(0, MAX_SECRET);
    if (LEDGER_CLASSES.includes(s.cls) && v.length < MIN_SECRET) continue;
    try {
      if (v.length < MIN_SECRET) {
        short(v, s.cls);
        continue;
      }
      for (const re of secretPatterns(v, { prefix: true })) for (const i of matchIndexes(re, t)) place(i, s.cls);
      const sv = stripped(v, SEPARATOR).text;
      if (sv.length >= MIN_SECRET) {
        for (let i = flat.text.indexOf(sv); i >= 0; i = flat.text.indexOf(sv, i + 1)) place(flat.at[i], s.cls);
      } else if (sv) short(sv, s.cls);
    } catch {
      throw new PatternError(`refused: scrub: a ${s.cls} value could not be checked; nothing is filed`);
    }
  }
  return [...hits.values()].sort((a, b) => a.line - b.line || a.col - b.col || (a.cls < b.cls ? -1 : a.cls > b.cls ? 1 : 0));
}
