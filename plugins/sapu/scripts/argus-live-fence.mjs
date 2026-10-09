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

/**
 * `bytes` in base64 (standard and URL-safe) as they read inside a longer text, from byte offset 0, 1 and 2
 * of a group (`base64("user:" + pw)`): only the characters no byte but the value's makes; the whole value
 * padded and unpadded too.
 */
function base64Forms(bytes) {
  const out = [bytes.toString("base64"), bytes.toString("base64").replace(/=+$/, "")];
  for (const o of [0, 1, 2]) {
    const s = Buffer.concat([Buffer.alloc(o), bytes]).toString("base64");
    out.push(s.slice(Math.ceil((8 * o) / 6), Math.floor((8 * (o + bytes.length)) / 6)));
  }
  return out.flatMap((b) => [b, b.replace(/\+/g, "-").replace(/\//g, "_")]);
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
function parts(v) {
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

/**
 * The regular expressions for every form a secret value takes in what the CLI prints, whatever language
 * escaped it, one per part of it (a value of more than PATTERN_CHARS characters is matched part by part,
 * the parts overlapping: a prefix still finds the leak, and every part is masked): each character in any of
 * its encodings (charPattern: JSON from JavaScript, Go's `&`, Python's `ä`, PHP's `\/`, HTML
 * entities, URL and form encoding, either case, mixed freely), or the part in base64 (padded, unpadded,
 * URL-safe, at any byte offset: base64Forms) or in hex (either case), each at least 8 characters long; the
 * same for the value URL-decoded. `prefix`: the first part only (enough to find a leak, not to mask one).
 * A pattern that cannot be built throws a PatternError.
 */
export function secretPatterns(v, { prefix = false } = {}) {
  return variants(String(v)).flatMap((x) => (prefix ? parts(x).slice(0, 1) : parts(x))).map((p) => {
    const bytes = Buffer.from(p, "utf8");
    const literal = [...new Set(base64Forms(bytes))].filter((b) => b.length >= 8).map(reEscape);
    const hex = bytes.length >= 4 ? [[...bytes].map((b) => hexAnyCase(b, 2)).join("")] : [];
    return compile([...literal, ...hex, [...p].map(charPattern).join("")].join("|"), "g");
  });
}

/** A fence marker's shape: `PAGE-`/`RETURN-` before a 32-hex nonce, or an opening `<<<PAGE-`/`<<<RETURN-`. */
const MARKER = /(<<<(?:PAGE|RETURN))-|(PAGE|RETURN)-(?=[0-9a-f]{32}(?![0-9a-f]))/g;

/** What `clean` gives instead of a text it could not mask: never the text. */
export const WITHHELD = "*** (withheld: a secret's pattern could not be run)";

/**
 * Every match of global `re` in `text` as `[start, end)`, overlapping ones too (a periodic value's part
 * also matches inside the part before it); a pattern that fails to run throws a PatternError.
 */
function spans(re, text) {
  const out = [];
  try {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      if (m[0] !== "") out.push([m.index, m.index + m[0].length]);
      re.lastIndex = m.index + 1;
    }
  } catch {
    throw new PatternError();
  }
  return out;
}

/** `text` with every match of every value's patterns (secretPatterns) → `***`, overlapping and touching matches as one. */
function maskValues(text, values) {
  const found = values.flatMap((v) => secretPatterns(v).flatMap((re) => spans(re, text))).sort((a, b) => a[0] - b[0]);
  let out = "";
  let at = 0;
  for (let i = 0; i < found.length; ) {
    let [start, end] = found[i];
    for (i += 1; i < found.length && found[i][0] <= end; i += 1) end = Math.max(end, found[i][1]);
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
