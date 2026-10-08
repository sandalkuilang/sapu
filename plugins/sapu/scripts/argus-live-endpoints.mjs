// argus-live-endpoints.mjs — endpoints for the journey lane's live instance (spec §8 steps 2, 6 and 8):
// how a URL, a DSN, `X_HOST` + `X_PORT` or a path names a service, hosts in one canonical form (every
// loopback address one name), and the comparison of the instance's values with what the repo's env
// files name. No process runs here: a host name is resolved only through the `lookup` a caller passes.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { parseEnvFile } from "./argus-live-config.mjs";
import { resolveLink, within } from "./argus-live-proc.mjs";

/** Default ports, so `redis://localhost` and `redis://127.0.0.1:6379` name the same service. */
export const DEFAULT_PORTS = { postgresql: 5432, mysql: 3306, mariadb: 3306, redis: 6379, rediss: 6379, mongodb: 27017, amqp: 5672, amqps: 5671, http: 80, https: 443, smtp: 25, smtps: 465, memcached: 11211, nats: 4222 };
const HTTP = new Set(["http", "https"]);
export const decodeSafe = (x) => {
  try {
    return decodeURIComponent(x);
  } catch {
    return x;
  }
};
/**
 * A host as compared: canonical (WHATWG URL: lower case, IPv4 and IPv6 in one form), no trailing dot,
 * every loopback address one name (`127.0.0.0/8`, `::1`, `::ffff:127.x`, `localhost`, unspecified).
 * An empty host stays empty: it names no endpoint.
 */
export function normHost(h) {
  let x = decodeSafe(String(h)).trim().replace(/^\[(.*)\]$/, "$1").replace(/\.+$/, "");
  if (!x) return "";
  try {
    x = new URL(`http://${net.isIP(x) === 6 ? `[${x}]` : x}/`).hostname.replace(/^\[(.*)\]$/, "$1");
  } catch {
    x = x.toLowerCase();
  }
  const loop = x === "localhost" || x.endsWith(".localhost") || /^127\./.test(x) || x === "0.0.0.0" || x === "::" || x === "::1" || /^::ffff:(7f[0-9a-f]{2}:|127\.)/.test(x);
  return loop ? "loopback" : x;
}

/**
 * The paths a file or socket value may name (`sqlite:…`, `jdbc:sqlite:…`, `file:…`, `unix:…`,
 * `<scheme>+unix:…`, or a bare `/…`, `./…`, `../…` path), or null. `sqlite:///x` has two readings —
 * SQLAlchemy's, `x` relative (the third slash ends the empty host), and others', `/x` absolute — and
 * both are returned, so a check refuses when either hits. `file://<host>/p` is `/p` (RFC 8089).
 */
export function filePaths(raw) {
  const v = String(raw).trim().replace(/^jdbc:/i, "");
  const m = v.match(/^([a-z][a-z0-9+.-]*):(.*)$/i);
  if (m && (/^sqlite/i.test(m[1]) || /\+unix$/i.test(m[1]) || /^(file|unix)$/i.test(m[1]))) {
    const rest = m[2].replace(/[?#].*$/, "");
    let out;
    if (!rest.startsWith("//")) out = [rest];
    else if (/^sqlite/i.test(m[1])) {
      const after = rest.slice(2).replace(/^[^/]*\/?/, "");
      out = after.startsWith("/") ? [after] : [after, `/${after}`];
    } else if (/^file$/i.test(m[1])) out = [rest.slice(2).replace(/^[^/]*/, "")];
    else out = [rest.slice(2)];
    out = out.map(decodeSafe).filter((p) => p && p !== "/");
    return out.length ? out : null;
  }
  return /^(\/|\.\.?\/)/.test(v) && !v.includes(":") ? [v] : null;
}

/**
 * Schemes whose client reads a missing host as the local server (libpq: its default socket; MySQL:
 * localhost), so an empty host, or a libpq socket directory, is a loopback endpoint on the default port.
 */
const LOCAL_BY_DEFAULT = new Set(["postgresql", "mysql", "mariadb"]);

/**
 * A connection string as a service: {scheme, hosts: [{host, port}], full, ports, databases}, or null.
 * Understands URLs (`jdbc:` stripped; a `+driver` suffix dropped; `postgres` = `postgresql`, `mysql2` =
 * `mysql`) and libpq DSNs (`host=… port=… dbname=…`). Hosts are normalised (`normHost`; an empty one
 * is loopback for LOCAL_BY_DEFAULT schemes), default ports filled in, the path percent-decoded; user,
 * password and the rest of the query are not part of the service.
 */
export function service(raw) {
  const v = String(raw).trim().replace(/^jdbc:/i, "");
  const url = v.match(/^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(\?[^#]*)?/i);
  let scheme;
  let hosts;
  let databases = [];
  let extraPorts = [];
  if (url) {
    scheme = url[1].toLowerCase().replace(/\+.*$/, "").replace(/^postgres$/, "postgresql").replace(/^mysql2$/, "mysql");
    hosts = url[2].slice(url[2].lastIndexOf("@") + 1).split(",").map((h) => {
      const m = h.match(/^\[([^\]]*)\](?::(\d+))?$/) || h.match(/^([^:]*)(?::(\d+))?$/) || [null, h, undefined];
      return { host: m[1], port: m[2] ? Number(m[2]) : undefined };
    });
    const segment = url[3].split("/").filter(Boolean)[0];
    if (segment) databases.push(decodeSafe(segment));
    const q = new URLSearchParams((url[4] || "").slice(1));
    for (const k of ["dbname", "database"]) if (q.get(k)) databases.push(q.get(k));
    if (q.get("port")) extraPorts = q.get("port").split(",").map(Number);
    const qHosts = (q.get("host") || "").split(",").filter(Boolean);
    // With no host before the path, the query's host and port are the endpoint (libpq's `?host=/socket/dir`).
    if (hosts.every((h) => !h.host)) hosts = (qHosts.length ? qHosts : [""]).map((h, i) => ({ host: h, port: hosts[i]?.port ?? hosts[0].port ?? extraPorts[i] ?? extraPorts[0] }));
    else hosts.push(...qHosts.map((h) => ({ host: h, port: undefined })));
  } else if (/^[a-z_]+\s*=/i.test(v) && /\b(host|hostaddr|port|dbname)\s*=/i.test(v)) {
    const kv = {};
    for (const [, k, q1, bare] of v.matchAll(/([a-z_]+)\s*=\s*(?:'((?:[^'\\]|\\.)*)'|(\S*))/gi)) kv[k.toLowerCase()] = q1 !== undefined ? q1.replace(/\\(.)/g, "$1") : bare;
    scheme = "postgresql";
    const ports = String(kv.port ?? "").split(",");
    hosts = String(kv.host ?? kv.hostaddr ?? "").split(",").map((h, i) => ({ host: h, port: ports[i] ? Number(ports[i]) : ports[0] ? Number(ports[0]) : undefined }));
    if (kv.dbname) databases = [kv.dbname];
  } else return null;
  const bare = (h) => decodeSafe(String(h ?? "")).trim();
  const localByDefault = LOCAL_BY_DEFAULT.has(scheme);
  // A client left to its defaults: no host (the local server), or no port (the default one).
  const hostless = localByDefault && hosts.some((h) => !bare(h.host));
  const portless = localByDefault && hosts.some((h) => h.port === undefined);
  hosts = hosts.map((h) => ({ host: localByDefault && (!bare(h.host) || bare(h.host).startsWith("/")) ? "loopback" : normHost(h.host), port: h.port ?? DEFAULT_PORTS[scheme] }));
  const path = url ? decodeSafe(url[3]).replace(/\/+$/, "") : databases[0] ? `/${databases[0]}` : "";
  return {
    scheme,
    hosts,
    full: `${scheme}://${hosts.map((h) => `${h.host}:${h.port ?? ""}`).sort().join(",")}${path}`,
    ports: [...hosts.map((h) => h.port).filter((p) => p !== undefined), ...extraPorts],
    databases,
    hostless,
    portless,
    dbPath: path,
  };
}

/**
 * `svc` (from service) with each host passed through `alias` (a name that resolves only to loopback
 * becomes `loopback`), its `full` form rebuilt to match; `svc` itself when nothing changed.
 */
function aliased(svc, alias) {
  if (!svc || !svc.hosts.some((h) => alias(h.host) !== h.host)) return svc;
  const hosts = svc.hosts.map((h) => ({ ...h, host: alias(h.host) }));
  return { ...svc, hosts, full: `${svc.scheme}://${hosts.map((h) => `${h.host}:${h.port ?? ""}`).sort().join(",")}${svc.dbPath}` };
}

/** Every host name (not an address, not loopback) the values of `vars` name, as normHost writes it. */
function hostNames(vars) {
  const out = new Set(splitEndpoints(vars).map((s) => s.host));
  for (const v of Object.values(vars)) {
    if (v === null || v === undefined || filePaths(v)) continue;
    const svc = service(v);
    if (svc) svc.hosts.forEach((h) => out.add(h.host));
  }
  return [...out].filter((h) => h && h !== "loopback" && !net.isIP(h) && /[a-z]/i.test(h));
}

/** The variables of each env file of the owner's (`.env`, `.env.local`, `guard.envFiles`) that exists: [{file, vars}]. */
export function ownerEnvFiles(main, contract) {
  const guard = (contract && contract.guard) || {};
  const out = [];
  for (const f of [".env", ".env.local", ...(guard.envFiles ?? [])]) {
    try {
      out.push({ file: f, vars: parseEnvFile(fs.readFileSync(path.join(main, f), "utf8")) });
    } catch {
      // not there
    }
  }
  return out;
}

/** `host:port` for each host that has both (an endpoint without either never matches), minus `exempt`. */
export const endpointsOf = (hosts, exempt = () => false) => hosts.filter((h) => h.host && h.port !== undefined && !exempt(h.host)).map((h) => `${h.host}:${h.port}`);

/**
 * Endpoints given as separate variables sharing a prefix: `X_HOST` + `X_PORT`, `PGHOST` + `PGPORT`
 * (libpq's default 5432 when PGPORT is unset); with `barePorts`, also a `*PORT` with no host beside it
 * (a loopback endpoint) → [{key, host, port}].
 */
export function splitEndpoints(vars, { barePorts = false } = {}) {
  const out = [];
  const portOf = (raw) => (/^\d+$/.test(String(raw ?? "").trim()) ? Number(String(raw).trim()) : undefined);
  for (const [key, raw] of Object.entries(vars)) {
    const m = key.match(/^(.*?)(_?)HOST$/i);
    if (!m || !m[1]) continue;
    const host = String(raw).trim();
    if (!host || /[/=\s]/.test(host.replace(/,/g, ""))) continue;
    const port = portOf(vars[`${m[1]}${m[2]}PORT`] ?? vars[`${m[1]}${m[2] ? "" : "_"}PORT`]) ?? (/^PG$/i.test(m[1]) ? 5432 : undefined);
    if (port === undefined) continue;
    for (const h of host.split(",")) out.push({ key, host: normHost(h), port });
  }
  if (barePorts) {
    for (const [key, raw] of Object.entries(vars)) {
      const m = key.match(/^(.*?)(_?)PORT$/i);
      const port = portOf(raw);
      if (!m || port === undefined) continue;
      const hasHost = [`${m[1]}${m[2]}HOST`, `${m[1]}HOST`, `${m[1]}_HOST`].some((k) => k !== key && k in vars);
      if (!hasHost) out.push({ key, host: "loopback", port });
    }
  }
  return out;
}

/** Client variables of libpq and MySQL that take their host from another variable, or else from the local server. */
const CLIENT_DEFAULTS = [
  { host: ["PGHOST", "PGHOSTADDR"], keys: ["PGDATABASE", "PGUSER", "PGPASSWORD", "PGPORT"] },
  { host: ["MYSQL_HOST"], keys: ["MYSQL_PWD", "MYSQL_TCP_PORT"] },
];

/** Variable names that hold a database name (`PGDATABASE`, `*_DB`, `*DATABASE*`, `*_DB_NAME`, `*_DBNAME`). */
const NAMES_DATABASE = /(^PGDATABASE$|DATABASE|_DB$|_DB_NAME$|_DBNAME$)/i;

/**
 * Names and addresses by which a container reaches the Docker host, so the owner's services on it:
 * Docker Desktop's and Podman's host names, Compose's `host-gateway`, the gateway of a Docker bridge
 * network (`172.16-31.0.1`) and Docker Desktop's host network (`192.168.65.0/24`). A heuristic: a
 * custom bridge subnet escapes it (spec §8, known limits).
 */
export function dockerHost(h) {
  const x = normHost(h);
  return /^(host|gateway)\.docker\.internal$|^docker\.for\.(mac|win)\.(localhost|host\.internal)$|^host\.containers\.internal$|^host\.lima\.internal$|^host-gateway$/.test(x) || /^172\.(1[6-9]|2\d|3[01])\.0\.1$/.test(x) || /^192\.168\.65\.\d+$/.test(x);
}

/**
 * What the repo's env files name (`.env`, `.env.local`, the contract's `guard.envFiles`; read here,
 * never printed): service endpoints, full http(s) URLs, and the real paths of files and sockets.
 */
export function readOwner(main, contract, alias = (h) => h) {
  const guard = (contract && contract.guard) || {};
  const o = { realMain: fs.realpathSync.native(main), files: [".env", ".env.local", ...(guard.envFiles ?? [])], endpoints: new Set(), full: new Set(), paths: new Set(), pg: guard.postgres || { ports: [], databases: [] } };
  for (const { vars } of ownerEnvFiles(main, contract)) {
    for (const v of Object.values(vars)) {
      const files = filePaths(v);
      if (files) {
        for (const file of files) o.paths.add(resolveLink(path.resolve(o.realMain, file)));
        continue;
      }
      const svc = aliased(service(v), alias);
      if (!svc) continue;
      endpointsOf(svc.hosts).forEach((e) => o.endpoints.add(e));
      o.full.add(svc.full);
    }
    for (const s of splitEndpoints(vars)) o.endpoints.add(`${alias(s.host)}:${s.port}`);
  }
  return o;
}

/**
 * The comparison of `up` step 6 for one scope of values (refusals name `<label>.<key>`, never a value):
 * `vars` is every variable in effect, `own` the ones this scope sets (defaults to `vars`). In a
 * `container` scope (a Compose service's environment, command or entrypoint), loopback is the
 * container's own and paths are the container's, so neither is compared; a host that is the Docker
 * host (dockerHost) is refused unless on one of `runPorts`.
 */
export function scopeChecker(o, { worktree, allowOrigins = [], composeServices = [], runPorts = [], alias = (h) => h }) {
  const allowed = new Set();
  for (const x of allowOrigins) {
    try {
      allowed.add(new URL(x).origin);
    } catch {
      // validateLive refuses a bad origin
    }
  }
  const own = new Set(composeServices.map((x) => String(x).toLowerCase()));
  const exempt = (host) => !host.includes(".") && !host.includes(":") && host !== "loopback" && own.has(host);
  const reaches = `points at a service the repo's env files name (${o.files.join(", ")}); it would reach the owner's service`;
  const ports = new Set(runPorts.map(Number));
  const toHost = (key, h) => new Error(`refused: ${key} reaches the Docker host (${h}) on a port that is not the run's; the container would reach the owner's services`);
  return (label, vars, { own: mine = vars, container = false } = {}) => {
    for (const s0 of splitEndpoints(vars, { barePorts: !container })) {
      if (!(s0.key in mine)) continue;
      const s = { ...s0, host: alias(s0.host) };
      const key = `${label}.${s.key}`;
      if (container) {
        if (s.host === "loopback") continue;
        if (dockerHost(s.host) && !ports.has(s.port)) throw toHost(key, s.host);
      }
      if (endpointsOf([s], exempt).some((e) => o.endpoints.has(e))) throw new Error(`refused: ${key} ${reaches}`);
      if (!container && o.pg.ports.includes(s.port)) throw new Error(`refused: ${key} names port ${s.port}, which guard.postgres protects`);
    }
    for (const [k, raw] of Object.entries(mine)) {
      if (raw === null || raw === undefined) continue;
      const key = `${label}.${k}`;
      const v = String(raw).trim();
      if (container && dockerHost(v)) throw toHost(key, normHost(v));
      if (/^\d+$/.test(v)) {
        if (!container && o.pg.ports.includes(Number(v))) throw new Error(`refused: ${key} names port ${v}, which guard.postgres protects`);
        continue;
      }
      if (!container && NAMES_DATABASE.test(k) && o.pg.databases.includes(v)) throw new Error(`refused: ${key} names database ${v}, which guard.postgres protects`);
      const files = filePaths(v);
      if (files) {
        if (container) continue;
        for (const file of files) {
          const real = resolveLink(path.resolve(worktree, file));
          if (real === null || within(o.realMain, real)) throw new Error(`refused: ${key} points into the main checkout`);
          if (o.paths.has(real)) throw new Error(`refused: ${key} points at a file or socket the repo's env files name (${o.files.join(", ")})`);
        }
        continue;
      }
      const svc = aliased(service(v), alias);
      if (!svc) continue;
      const hosts = container ? svc.hosts.filter((h) => h.host !== "loopback") : svc.hosts;
      if (container) for (const h of hosts) if (dockerHost(h.host) && !ports.has(h.port)) throw toHost(key, h.host);
      if (HTTP.has(svc.scheme)) {
        let origin = null;
        try {
          origin = new URL(v).origin;
        } catch {
          origin = null;
        }
        const loopback = svc.hosts.length > 0 && svc.hosts.every((h) => h.host === "loopback");
        const same = container ? hosts.length > 0 && o.full.has(svc.full) : o.full.has(svc.full) || (loopback && endpointsOf(svc.hosts).some((e) => o.endpoints.has(e)));
        if (same && !allowed.has(origin)) throw new Error(`refused: ${key} ${reaches} (list its origin in allow_origins if it is meant to)`);
      } else if (endpointsOf(hosts, exempt).some((e) => o.endpoints.has(e))) throw new Error(`refused: ${key} ${reaches}`);
      if (container) continue;
      const port = svc.ports.find((p) => o.pg.ports.includes(p));
      if (port !== undefined) throw new Error(`refused: ${key} names port ${port}, which guard.postgres protects`);
      const db = svc.databases.find((d) => o.pg.databases.includes(d));
      if (db !== undefined) throw new Error(`refused: ${key} names database ${db}, which guard.postgres protects`);
      if (svc.hostless) throw new Error(`refused: ${key} leaves its host to the client's default (the local server); name its host and port`);
      if (svc.portless) throw new Error(`refused: ${key} leaves its port to the client's default; name it`);
    }
    // 3: a libpq or MySQL client variable with no host beside it (`PGDATABASE` without `PGHOST`).
    if (!container) {
      for (const g of CLIENT_DEFAULTS) {
        if (g.host.some((h) => String(vars[h] ?? "").trim())) continue;
        const k = g.keys.find((x) => x in mine);
        if (k) throw new Error(`refused: ${label}.${k} leaves its host to the client's default (the local server); set ${g.host[0]} too`);
      }
    }
  };
}

/**
 * Host names in `varsList` that `lookup` (all addresses) resolves to loopback only, as an alias
 * function (name → `loopback`): `db.localtest.me` must not slip past the loopback comparison. A name
 * that does not resolve, or reaches any other address, stays a name.
 */
export async function loopbackAliases(varsList, lookup) {
  const names = [...new Set(varsList.flatMap(hostNames))];
  const loop = new Set();
  await Promise.all(
    names.map(async (h) => {
      try {
        const addrs = await lookup(h);
        if (Array.isArray(addrs) && addrs.length && addrs.every((a) => normHost(a.address) === "loopback")) loop.add(h);
      } catch {
        // unresolved: a name compared as a name
      }
    }),
  );
  return (h) => (loop.has(h) ? "loopback" : h);
}
/** Socket names of a container runtime or a datastore, wherever they lie. */
export const SOCKET_NAME = /^((docker|containerd|podman|containerd-shim[^/]*)\.sock|\.s\.PGSQL\.\d+|mysql[^/]*\.sock|mysqld[^/]*\.sock|redis[^/]*\.sock|mongodb-\d+\.sock|memcached[^/]*\.sock)$/i;

/** `addr` (`host:port`, `[v6]:port`) split at its last colon. */
export const splitAddr = (addr) => {
  const i = String(addr).lastIndexOf(":");
  return [addr.slice(0, i), addr.slice(i + 1)];
};

/** `host:port` as the egress check compares it: normHost's form, a zone dropped, an IPv4-mapped IPv6 address read as IPv4. */
export function endpointKey(host, port) {
  let h = String(host).replace(/^\[(.*)\]$/, "$1").replace(/%.*$/, "");
  const dotted = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (dotted) h = dotted[1];
  h = normHost(h);
  const hex = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const [a, b] = [parseInt(hex[1], 16), parseInt(hex[2], 16)];
    h = `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
  }
  return `${h}:${port}`;
}

/** The host of a URL that may still hold `{port:<name>}` placeholders, or null. */
export function hostOf(raw) {
  try {
    return new URL(String(raw).replace(/\{port:[^}]*\}/g, "1")).hostname.replace(/^\[(.*)\]$/, "$1");
  } catch {
    return null;
  }
}

/** True when `host` is loopback by itself (`localhost`, `127.x`, `::1`) or every address `lookup` gives it is. */
export async function resolvesToLoopback(host, lookup) {
  if (normHost(host) === "loopback") return true;
  if (net.isIP(host)) return false;
  try {
    const addrs = await lookup(host);
    return Array.isArray(addrs) && addrs.length > 0 && addrs.every((a) => normHost(a.address) === "loopback");
  } catch {
    return false;
  }
}
