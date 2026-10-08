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
 * The ways one character of a secret may be printed: as is, after a backslash (`\"`, PHP's `\/`), as a
 * C escape (`\n`), `\uXXXX` (any case; a surrogate pair beyond U+FFFF), `\xHH`, an HTML entity (decimal,
 * hex in any case, leading zeros, or named), its UTF-8 bytes as `%HH` (any case), `+` for a space, and `/`
 * for a backslash (a browser's URL path).
 */
function charPattern(ch) {
  const cp = ch.codePointAt(0);
  const alts = [`\\\\?${reEscape(ch)}`];
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
 * One regular expression for every form a secret value takes in what the CLI prints, whatever language
 * escaped it: each character in any of its encodings (charPattern: JSON from JavaScript, Go's `&`,
 * Python's `ä`, PHP's `\/`, HTML entities, URL and form encoding, mixed freely), or the whole value
 * in base64 (padded, unpadded, URL-safe) when that is at least 8 characters long.
 */
export function secretPattern(v) {
  const b64 = Buffer.from(v, "utf8").toString("base64");
  const whole = [...new Set([b64, b64.replace(/=+$/, ""), Buffer.from(v, "utf8").toString("base64url")])].filter((b) => b.length >= 8).map(reEscape);
  return new RegExp([...whole, [...v].map(charPattern).join("")].join("|"), "g");
}

/** A fence marker's shape: `PAGE-`/`RETURN-` before a 32-hex nonce, or an opening `<<<PAGE-`/`<<<RETURN-`. */
const MARKER = /(<<<(?:PAGE|RETURN))-|(PAGE|RETURN)-(?=[0-9a-f]{32}(?![0-9a-f]))/g;

/**
 * Page-derived `text` made safe to fence: every non-empty secret value, in any of its forms
 * (secretPattern), → `***` (the longest value first); `\r\n` → `\n`; a marker shape's hyphen → U+2011 (no text can
 * open or close a fence, while a business id such as `RETURN-42` stays as it is); and every C0 or C1
 * control (and DEL) other than `\n` and `\t` → U+FFFD (no terminal escape survives).
 */
export function clean(text, { secrets = {} } = {}) {
  const values = [...new Set(Object.values(secrets).filter((v) => typeof v === "string" && v !== ""))].sort((a, b) => b.length - a.length);
  let out = values.reduce((t, v) => t.replace(secretPattern(v), "***"), String(text ?? ""));
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
