// argus-live-fence.mjs — the nonce fence around everything a page or an app command printed (spec §7
// "Untrusted content", §9 "Output"): the explorer and the orchestrator read it as data. A leaf module.
import { randomBytes } from "node:crypto";

/** The most characters of page-derived text one call prints; the rest is dropped and counted. */
export const PAGE_CAP = 24_000;

/** A fresh fence nonce: 32 lower-case hex characters. */
export function nonce() {
  return randomBytes(16).toString("hex");
}

/** U+2011, the non-breaking hyphen: `PAGE-`/`RETURN-` in fenced text become `PAGE‑`/`RETURN‑`. */
const NB_HYPHEN = "‑";

/**
 * Page-derived `text` made safe to fence: every non-empty secret value → `***` (longest first), `\r\n`
 * → `\n`, `PAGE-` and `RETURN-` → with U+2011 (so no text can open or close a fence), and every C0 or
 * C1 control (and DEL) other than `\n` and `\t` → U+FFFD (so no terminal escape survives).
 */
export function clean(text, { secrets = {} } = {}) {
  const values = [...new Set(Object.values(secrets).filter((v) => typeof v === "string" && v !== ""))].sort((a, b) => b.length - a.length);
  let out = values.reduce((t, v) => t.split(v).join("***"), String(text ?? ""));
  out = out.replace(/\r\n/g, "\n").replace(/(PAGE|RETURN)-/g, `$1${NB_HYPHEN}`);
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
