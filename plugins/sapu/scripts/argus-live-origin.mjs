// argus-live-origin.mjs — how the journey lane spells and compares origins (spec §8 "origins", §9 "The
// wrapper"): a host as a URL spells it, the one form origins are compared in, Chrome's errors for a request
// the run's layers stopped, and the check every URL an explorer names passes. A leaf: it imports no other
// argus-live module, so the proxy, the logins, `pw` and the repro runner all share it.
import net from "node:net";

/** The default port of each scheme an origin of the run may have. */
const DEFAULT_PORTS = { http: 80, https: 443, ws: 80, wss: 443 };

/**
 * A host as a URL spells it: lower case, IPv4 and IPv6 in WHATWG URL's one form, without brackets or a
 * trailing dot. Unlike normHost, loopback spellings stay apart: `localhost`, `127.0.0.1` and `::1` may be
 * different listeners (an IPv4 and an IPv6 socket on one port).
 */
export function exactHost(h) {
  const x = String(h).trim().replace(/^\[(.*)\]$/, "$1");
  if (!x) return "";
  try {
    return new URL(`http://${net.isIP(x) === 6 ? `[${x}]` : x}/`).hostname.replace(/^\[(.*)\]$/, "$1").replace(/\.+$/, "");
  } catch {
    return "";
  }
}

/** `http(s)://<exactHost>:<port>` — the form origins are compared in (a host as the run's origin spells it, default ports filled). */
export function canonicalOrigin(origin) {
  const u = new URL(origin);
  const scheme = u.protocol.replace(/:$/, "");
  return `${scheme}://${exactHost(u.hostname)}:${u.port || DEFAULT_PORTS[scheme]}`;
}

/** A URL's origin in the form origins are compared in (canonicalOrigin; ws: as http:, wss: as https:), or null. */
export function originOf(u) {
  try {
    const x = new URL(u);
    const scheme = x.protocol === "ws:" ? "http:" : x.protocol === "wss:" ? "https:" : x.protocol;
    if (scheme !== "http:" && scheme !== "https:") return null;
    return canonicalOrigin(`${scheme}//${x.host}`);
  } catch {
    return null;
  }
}

/** Chrome's errors for a request the run's layers stopped: Playwright's allowedOrigins, the proxy, the host rules. */
export const BLOCKED_ERROR = /ERR_BLOCKED_BY_CLIENT|ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED|tunnel via proxy server failed/i;

/** How a refusal shows an explorer's argument: as given when it is short printable ASCII, else not at all. */
export const shown = (s) => (typeof s === "string" && /^[\x20-\x7e]{1,200}$/.test(s) ? s : "that argument");

/**
 * A `goto`/`tab-new` argument → the absolute URL to open: a path (`^/(?![/\\])`, no control characters)
 * resolved on `base` (the account's role's base_url), or an `http:`/`https:` URL without credentials;
 * either way its origin, serialised (WHATWG), must be one of `origins` as they serialise: a host spelled
 * otherwise (`localhost.`, `127.0.0.1` for `localhost`) is refused. Else
 * `refused: <arg> is outside the run's origins` — so `//host`, `/\host`, `javascript:`, `data:`,
 * `file:`, `view-source:` and `http://localhost:<port>@host` are refused.
 */
export function checkUrl(arg, { origins, base }) {
  const refuse = () => new Error(`refused: ${shown(arg)} is outside the run's origins`);
  // Controls are refused first: a URL parser drops tabs and newlines, so `/<tab>/host` would become `//host`.
  if (typeof arg !== "string" || arg === "" || arg.length > 4000 || /[\u0000-\u001f\u007f-\u009f]/.test(arg)) throw refuse();
  let u;
  try {
    if (arg.startsWith("/")) {
      if (!/^\/(?![/\\])/.test(arg)) throw refuse();
      u = new URL(arg, base);
    } else u = new URL(arg);
  } catch {
    throw refuse();
  }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password) throw refuse();
  // Spelled as a run origin spells it (WHATWG's serialisation: lower case, one form of an IP, a trailing dot kept), not merely the same host.
  const allowed = new Set(origins.map((o) => new URL(o).origin));
  if (!allowed.has(u.origin)) throw refuse();
  return u.href;
}
