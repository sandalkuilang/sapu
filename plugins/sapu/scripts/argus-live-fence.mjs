// argus-live-fence.mjs — the nonce fence around everything a page or an app command printed (spec §7
// "Untrusted content", §9 "Output"): the explorer and the orchestrator read it as data. A leaf module.
import { randomBytes } from "node:crypto";

/** The most characters of page-derived text one call prints; the rest is dropped and counted. */
export const PAGE_CAP = 24_000;

/** A fresh fence nonce: 32 lower-case hex characters. */
export function nonce() {
  return randomBytes(16).toString("hex");
}

/** U+2011, the non-breaking hyphen: a marker shape's `PAGE-`/`RETURN-` becomes `PAGE‑`/`RETURN‑`. */
const NB_HYPHEN = "‑";

/** `n` in hex (at least `width` digits), each letter digit as a class of both cases: `0x3c` → `3[cC]`. */
const hexAnyCase = (n, width = 0) => n.toString(16).padStart(width, "0").replace(/[a-f]/g, (d) => `[${d}${d.toUpperCase()}]`);
const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const NAMED = { '"': "quot", "&": "amp", "<": "lt", ">": "gt", "'": "apos" };
const SHORT_ESCAPES = { "\n": "n", "\t": "t", "\r": "r", "\b": "b", "\f": "f" };

/**
 * The ways one character of a secret may be printed: as is or in its other case (a value an app upper- or
 * lower-cased), after a backslash (`\"`, PHP's `\/`), as a C escape (`\n`), `\uXXXX` (any case; a
 * surrogate pair beyond U+FFFF), `\xHH`, an HTML entity (decimal, hex in any case, leading zeros, or
 * named), its UTF-8 bytes as `%HH` (any case), `+` for a space, and `/` for a backslash (a browser's URL path).
 */
function charPattern(ch) {
  const cp = ch.codePointAt(0);
  const cases = [...new Set([ch, ch.toLowerCase(), ch.toUpperCase()])].filter((c) => [...c].length === 1);
  const alts = [`\\\\?${cases.length > 1 ? `(?:${cases.map(reEscape).join("|")})` : reEscape(ch)}`];
  if (SHORT_ESCAPES[ch]) alts.push(`\\\\${SHORT_ESCAPES[ch]}`);
  const units = cp > 0xffff ? [0xd800 + ((cp - 0x10000) >> 10), 0xdc00 + ((cp - 0x10000) & 0x3ff)] : [cp];
  alts.push(units.map((u) => `\\\\u${hexAnyCase(u, 4)}`).join(""));
  if (cp <= 0xff) alts.push(`\\\\x${hexAnyCase(cp, 2)}`);
  alts.push(`&#0*${cp};`, `&#[xX]0*${hexAnyCase(cp)};`);
  if (NAMED[ch]) alts.push(`&${NAMED[ch]};`);
  alts.push([...Buffer.from(ch, "utf8")].map((b) => `%${hexAnyCase(b, 2)}`).join(""));
  if (ch === " ") alts.push("\\+");
  if (ch === "\\") alts.push("\\/");
  return `(?:${alts.join("|")})`;
}

/** The fewest characters a value's whole base64 (padded or unpadded) has to be looked for. */
const BASE64_WHOLE_MIN = 8;
/** The fewest an offset form has: a 6-byte value's core after 4 or 5 other bytes (`base64("abc:" + pw)`) is 7. */
const BASE64_CORE_MIN = 7;

/**
 * `bytes` in base64 (standard and URL-safe) as they read inside a longer text, from byte offset 0, 1 and 2
 * of a group (`base64("user:" + pw)`): only the characters no byte but the value's makes, each such core at
 * least BASE64_CORE_MIN characters; the whole value padded and unpadded too, at least BASE64_WHOLE_MIN.
 */
function base64Forms(bytes) {
  const whole = [bytes.toString("base64"), bytes.toString("base64").replace(/=+$/, "")].filter((b) => b.length >= BASE64_WHOLE_MIN);
  const cores = [0, 1, 2]
    .map((o) => Buffer.concat([Buffer.alloc(o), bytes]).toString("base64").slice(Math.ceil((8 * o) / 6), Math.floor((8 * (o + bytes.length)) / 6)))
    .filter((b) => b.length >= BASE64_CORE_MIN);
  return [...new Set([...whole, ...cores].flatMap((b) => [b, b.replace(/\+/g, "-").replace(/\//g, "_")]))];
}

/** The most characters of a value one pattern spells out: some 2700 overflow the engine's stack. */
export const PATTERN_CHARS = 256;
/** How far a long value's parts overlap: each encoding of one part meets the next part's, so a long value is masked whole. */
const PATTERN_OVERLAP = 16;

/**
 * Thrown for a secret's pattern that could not be built or run, with a fixed message: the engine's own quotes
 * the pattern, which spells the value out.
 */
export class PatternError extends Error {
  constructor(message = "failed: a secret's pattern could not be built") {
    super(message);
    this.name = "PatternError";
  }
}

/** `new RegExp(source, flags)`, or a PatternError (never the engine's message). */
function compile(source, flags) {
  try {
    return new RegExp(source, flags);
  } catch {
    throw new PatternError();
  }
}

/** `v` cut into parts of PATTERN_CHARS characters, each overlapping the next by PATTERN_OVERLAP, the last ending at `v`'s end. */
export function secretParts(v) {
  const chars = [...v];
  if (chars.length <= PATTERN_CHARS) return [v];
  const out = [];
  for (let i = 0; i + PATTERN_CHARS < chars.length; i += PATTERN_CHARS - PATTERN_OVERLAP) out.push(chars.slice(i, i + PATTERN_CHARS).join(""));
  out.push(chars.slice(-PATTERN_CHARS).join(""));
  return out;
}

/** `v` and, when it holds `%HH` that decode, `v` decoded (a cookie recorded URL-encoded, `s%3A…`, shown as `s:…`). */
function variants(v) {
  if (!/%[0-9A-Fa-f]{2}/.test(v)) return [v];
  try {
    const d = decodeURIComponent(v);
    return d && d !== v ? [v, d] : [v];
  } catch {
    return [v];
  }
}

/** `p`'s bytes in hex, either case per digit, from 4 bytes; else none. */
const hexForm = (bytes) => (bytes.length >= 4 ? [[...bytes].map((b) => hexAnyCase(b, 2)).join("")] : []);

/** The one regular expression for every form of part `p` (see secretPatterns). */
function partPattern(p) {
  const bytes = Buffer.from(p, "utf8");
  return compile([...base64Forms(bytes).map(reEscape), ...hexForm(bytes), [...p].map(charPattern).join("")].join("|"), "g");
}

/** `v`'s parts (secretParts), and those of `v` URL-decoded (variants), once each. */
const allParts = (v) => [...new Set(variants(String(v)).flatMap(secretParts))];

/**
 * The regular expressions for every form a secret value takes in what the CLI prints, whatever language
 * escaped it, one per part of it (a value of more than PATTERN_CHARS characters is matched part by part,
 * the parts overlapping, so every part is masked): each character in any of its encodings (charPattern:
 * JSON from JavaScript, Go's `\u0026`, Python's `\xe4`, PHP's `\/`, HTML entities, URL and form encoding,
 * either case, mixed freely), or the part in base64 (padded or unpadded from 8 characters, URL-safe, and at
 * any byte offset from 7: base64Forms) or in hex (either case, from 4 bytes); the same for the value
 * URL-decoded. A pattern that cannot be built throws a PatternError.
 */
export function secretPatterns(v) {
  return allParts(v).map(partPattern);
}

/** One character's single-code-point fold: equal for a character and either of its cases charPattern allows (every code point checked). */
const single = (s) => [...s].length === 1;
function fold(ch) {
  const up = single(ch.toUpperCase()) ? ch.toUpperCase() : ch;
  const low = up.toLowerCase();
  return single(low) ? low : up;
}

/** How many characters of a part one probe of the text holds: every such run of a part must be in the text for the part to be. */
const GRAM = 4;
const C_ESCAPES = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" };
const NAMED_CODES = { quot: 34, amp: 38, lt: 60, gt: 62, apos: 39 };
const U_ESCAPE = /\\u([0-9a-fA-F]{4})/y;
const X_ESCAPE = /\\x([0-9a-fA-F]{2})/y;
const ENTITY = /&(?:#([0-9]+)|#[xX]([0-9a-fA-F]+)|(quot|amp|lt|gt|apos));/y;
const PERCENTS = /(?:%[0-9a-fA-F]{2}){1,4}/y;
/** `re` (sticky) run at `i` of `t`. */
const at = (re, t, i) => {
  re.lastIndex = i;
  return re.exec(t);
};

/**
 * Every way a character of a secret may start at `t[i]`, as charPattern spells it → `[[its fold, the index
 * after it]]`: the character itself (either case), `+` as a space, `/` as a backslash, a backslash before
 * any character, a C escape, `\uXXXX` (a surrogate pair as one), `\xHH`, an HTML entity, and the UTF-8
 * bytes of one character as `%HH`.
 */
function startsAt(t, i) {
  const ch = String.fromCodePoint(t.codePointAt(i));
  const out = [[fold(ch), i + ch.length]];
  if (ch === "+") out.push([" ", i + 1]);
  else if (ch === "/") out.push(["\\", i + 1]);
  else if (ch === "\\" && i + 1 < t.length) {
    const next = String.fromCodePoint(t.codePointAt(i + 1));
    out.push([fold(next), i + 1 + next.length]);
    if (C_ESCAPES[next]) out.push([C_ESCAPES[next], i + 2]);
    const u = at(U_ESCAPE, t, i);
    if (u) {
      const hi = parseInt(u[1], 16);
      out.push([fold(String.fromCharCode(hi)), i + 6]);
      const lo = hi >= 0xd800 && hi <= 0xdbff ? at(U_ESCAPE, t, i + 6) : null;
      if (lo) out.push([fold(String.fromCharCode(hi, parseInt(lo[1], 16))), i + 12]);
    }
    const x = at(X_ESCAPE, t, i);
    if (x) out.push([fold(String.fromCharCode(parseInt(x[1], 16))), i + 4]);
  } else if (ch === "&") {
    const e = at(ENTITY, t, i);
    const cp = e ? (e[3] ? NAMED_CODES[e[3]] : e[1] ? Number(e[1]) : parseInt(e[2], 16)) : NaN;
    if (cp <= 0x10ffff) out.push([fold(String.fromCodePoint(cp)), i + e[0].length]);
  } else if (ch === "%") {
    const run = at(PERCENTS, t, i);
    for (let k = 1; run && 3 * k <= run[0].length; k += 1) {
      const bytes = Buffer.from(run[0].slice(0, 3 * k).replace(/%/g, ""), "hex");
      const d = bytes.toString("utf8");
      if (single(d) && Buffer.from(d, "utf8").equals(bytes)) out.push([fold(d), i + 3 * k]);
    }
  }
  return out;
}

/** Every run of GRAM folded characters `t` may spell, in any mix of the encodings startsAt reads, from any index. */
function spelledGrams(t) {
  const memo = new Map();
  const from = (i) => {
    if (!memo.has(i)) memo.set(i, i < t.length ? startsAt(t, i) : []);
    return memo.get(i);
  };
  const grams = new Set();
  const walk = (i, acc, k) => {
    if (k === GRAM) grams.add(acc);
    else for (const [f, j] of from(i)) walk(j, acc + f, k + 1);
  };
  for (let i = 0; i < t.length; i += 1) walk(i, "", 0);
  return grams;
}

/**
 * A finder over `text` → `(v) => [index]`: where secret `v` occurs in `text`, sorted — the start of each
 * run of matches of its parts (secretPatterns: every part, of the value and of it URL-decoded), overlapping
 * and touching ones merged (mergedSpans: a whole long value is one) — the same as running every part's
 * pattern, without compiling most of them: a part's pattern runs only when its base64 or hex is in
 * the text, or when the text may spell every GRAM characters of it (spelledGrams; a match spells all of
 * them, so a part that fails this has none), or when it is shorter than GRAM or holds a lone surrogate
 * (UTF-8 cannot carry one: charPattern's `%HH` then spells U+FFFD). A pattern that cannot be built or run
 * throws a PatternError.
 */
export function leakFinder(text) {
  const t = String(text ?? "");
  const lower = t.toLowerCase();
  let grams = null;
  const spelled = (p) => {
    const f = [...p].map(fold);
    grams ??= spelledGrams(t);
    for (let k = 0; k + GRAM <= f.length; k += 1) if (!grams.has(f.slice(k, k + GRAM).join(""))) return false;
    return true;
  };
  return (v) => {
    const found = [];
    for (const p of allParts(v)) {
      const bytes = Buffer.from(p, "utf8");
      const maybe =
        [...p].length < GRAM ||
        /[\uD800-\uDFFF]/.test(p.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "")) ||
        base64Forms(bytes).some((b) => t.includes(b)) ||
        (bytes.length >= 4 && lower.includes(bytes.toString("hex"))) ||
        spelled(p);
      if (maybe) found.push(...spans(partPattern(p), t, { overlapping: false }));
    }
    return mergedSpans(found).map(([start]) => start);
  };
}

/** A fence marker's shape: `PAGE-`/`RETURN-` before a 32-hex nonce, or an opening `<<<PAGE-`/`<<<RETURN-`. */
const MARKER = /(<<<(?:PAGE|RETURN))-|(PAGE|RETURN)-(?=[0-9a-f]{32}(?![0-9a-f]))/g;

/** What `clean` gives instead of a text it could not mask: never the text. */
export const WITHHELD = "*** (withheld: a secret's pattern could not be run)";

/**
 * Every match of global `re` in `text` as `[start, end)`, overlapping ones too (a periodic value's part
 * also matches inside the part before it) unless `overlapping` is false (each search then starts after the
 * last match, as `matchAll`); a pattern that fails to run throws a PatternError.
 */
function spans(re, text, { overlapping = true } = {}) {
  const out = [];
  try {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      if (m[0] !== "") out.push([m.index, m.index + m[0].length]);
      re.lastIndex = overlapping || m[0] === "" ? m.index + 1 : m.index + m[0].length;
    }
  } catch {
    throw new PatternError();
  }
  return out;
}

/** `[start, end)` spans sorted, overlapping and touching ones merged into one. */
export function mergedSpans(found) {
  const sorted = [...found].sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [start, end] of sorted) {
    const last = out.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

/** `text` with every match of every value's patterns (secretPatterns) → `***`, overlapping and touching matches as one. */
function maskValues(text, values) {
  let out = "";
  let at = 0;
  for (const [start, end] of mergedSpans(values.flatMap((v) => secretPatterns(v).flatMap((re) => spans(re, text))))) {
    out += `${text.slice(at, start)}***`;
    at = end;
  }
  return out + text.slice(at);
}

/**
 * Page-derived `text` made safe to fence: every non-empty secret value, in any of its forms
 * (secretPatterns), → `***` (overlapping and touching matches as one; a value inside another is masked
 * with it); `\r\n` → `\n`; a marker shape's hyphen → U+2011 (no text can open or close a fence, while a
 * business id such as `RETURN-42` stays as it is); and every C0 or C1 control (and DEL) other than `\n`
 * and `\t` → U+FFFD (no terminal escape survives). A pattern that cannot be built or run → WITHHELD.
 */
export function clean(text, { secrets = {} } = {}) {
  const values = [...new Set(Object.values(secrets).filter((v) => typeof v === "string" && v !== ""))];
  let out;
  try {
    out = maskValues(String(text ?? ""), values);
  } catch {
    return WITHHELD;
  }
  out = out.replace(/\r\n/g, "\n").replace(MARKER, (_m, open, bare) => `${open || bare}${NB_HYPHEN}`);
  return out.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "�");
}

/**
 * `text` cleaned and fenced: `<<<<label>-<n>`, the text (at most `cap` characters), `<label>-<n>>>>`
 * → {body, truncated}, `truncated` the characters dropped (the caller prints `truncated <k> characters`
 * outside the fence). A surrogate pair is never split at the cap.
 */
export function fence(text, { label = "PAGE", cap = PAGE_CAP, n = nonce(), secrets } = {}) {
  const all = clean(text, { secrets });
  let end = Math.min(all.length, cap);
  if (end < all.length && end > 0 && /[\uD800-\uDBFF]/.test(all[end - 1])) end -= 1;
  return { body: `<<<${label}-${n}\n${all.slice(0, end)}\n${label}-${n}>>>`, truncated: all.length - end };
}
