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

/**
 * Every form a secret value takes in what the CLI prints: as is, JSON/YAML-escaped (a snapshot's or a
 * body's string), URL-encoded (a request URL) and form-encoded (a form body: space as `+`).
 */
export function secretForms(v) {
  return [v, JSON.stringify(v).slice(1, -1), encodeURIComponent(v), new URLSearchParams({ v }).toString().slice(2)];
}

/** A fence marker's shape: `PAGE-`/`RETURN-` before a 32-hex nonce, or an opening `<<<PAGE-`/`<<<RETURN-`. */
const MARKER = /(<<<(?:PAGE|RETURN))-|(PAGE|RETURN)-(?=[0-9a-f]{32}(?![0-9a-f]))/g;

/**
 * Page-derived `text` made safe to fence: every non-empty secret value, in each of its forms
 * (secretForms), → `***` (longest first); `\r\n` → `\n`; a marker shape's hyphen → U+2011 (no text can
 * open or close a fence, while a business id such as `RETURN-42` stays as it is); and every C0 or C1
 * control (and DEL) other than `\n` and `\t` → U+FFFD (no terminal escape survives).
 */
export function clean(text, { secrets = {} } = {}) {
  const values = Object.values(secrets).filter((v) => typeof v === "string" && v !== "");
  const forms = [...new Set(values.flatMap(secretForms))].sort((a, b) => b.length - a.length);
  let out = forms.reduce((t, v) => t.split(v).join("***"), String(text ?? ""));
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
