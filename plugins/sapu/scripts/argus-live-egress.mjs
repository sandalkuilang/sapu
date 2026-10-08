// argus-live-egress.mjs — the egress check of the journey lane's live instance (spec §8 step 8): what
// the run's processes connect to (lsof, ss, netstat) against what the run allows; and who holds a port.
import dns from "node:dns";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { parseEnvFile } from "./argus-live-config.mjs";
import { decodeSafe, DEFAULT_PORTS, endpointKey, endpointsOf, filePaths, normHost, service, SOCKET_NAME, splitAddr, splitEndpoints } from "./argus-live-endpoints.mjs";
import { resolveLink, run, sleep, tail, within } from "./argus-live-proc.mjs";

/** Who listens on `port`: `<command> (pid <n>)`, from `lsof`, else `ss`; `unknown` when neither tells. */
export function portHolder(port, { runner = run } = {}) {
  const fmt = (pairs) => [...new Set(pairs.map(([c, p]) => `${c} (pid ${p})`))].join(", ");
  const l = runner(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"]);
  if (!l.error && l.status === 0 && l.stdout) {
    const pairs = [];
    let pid;
    for (const line of l.stdout.split("\n")) {
      if (line.startsWith("p")) pid = line.slice(1);
      else if (line.startsWith("c") && pid) pairs.push([line.slice(1), pid]);
    }
    if (pairs.length) return fmt(pairs);
  }
  const s = runner(["ss", "-ltnpH", `sport = :${port}`]);
  if (!s.error && s.status === 0 && s.stdout) {
    const pairs = [...s.stdout.matchAll(/\("([^"]+)",pid=(\d+)/g)].map((m) => [m[1], m[2]]);
    if (pairs.length) return fmt(pairs);
  }
  return "unknown";
}

/**
 * The endpoints the run may connect to, as `host:port` (hosts as normHost writes them, names not
 * resolved): this run's `ports` on loopback; every non-loopback endpoint `env` and each start entry's
 * env name (a URL or DSN, `X_HOST` + `X_PORT`), and each non-loopback `allow_origins` origin — a
 * loopback endpoint is allowed only on the run's own ports, since the owner's dev servers listen there
 * too; and every endpoint, loopback included, named by a variable `pass_env` passes from the owner's
 * session (an `HTTPS_PROXY`), which the owner has chosen to share.
 */
export function egressAllowed({ config = {}, env = {}, ports = {} }) {
  const out = new Set(Object.values(ports).map((p) => `loopback:${p}`));
  const named = (vars) => {
    const list = splitEndpoints(vars).map((s) => `${s.host}:${s.port}`);
    for (const raw of Object.values(vars)) {
      if (raw === null || raw === undefined || filePaths(raw)) continue;
      const svc = service(raw);
      if (svc) list.push(...endpointsOf(svc.hosts));
    }
    return list;
  };
  const remote = (e) => !e.startsWith("loopback:");
  for (const vars of [env, ...(config.start ?? []).map((e) => e.env ?? {})]) named(vars).filter(remote).forEach((e) => out.add(e));
  for (const o of config.allow_origins ?? []) {
    try {
      const u = new URL(o);
      const e = `${normHost(u.hostname)}:${u.port || DEFAULT_PORTS[u.protocol.slice(0, -1)]}`;
      if (remote(e)) out.add(e);
    } catch {
      // validateLive refuses a bad origin
    }
  }
  const passed = Object.fromEntries((config.pass_env ?? []).filter((k) => env[k] !== undefined).map((k) => [k, env[k]]));
  named(passed).forEach((e) => out.add(e));
  return [...out];
}

/** lsof's verdict: exit 0, or exit 1 (nothing found, or a pid gone) with nothing but warnings on stderr. */
function lsofOk(r) {
  if (r.status === 0) return true;
  if (r.status !== 1) return false;
  return String(r.stderr || "").split("\n").every((l) => !l.trim() || /^lsof: WARNING/.test(l.trim()));
}

/** `lsof -F pcnT` output → [{pid, command, local, remote, listen}]. */
function parseLsof(out) {
  const conns = [];
  let pid;
  let command;
  let cur = null;
  for (const line of out.split("\n")) {
    const [tag, val] = [line[0], line.slice(1)];
    if (tag === "p") pid = Number(val);
    else if (tag === "c") command = val;
    else if (tag === "f") cur = null;
    else if (tag === "n") {
      const [local, remote] = val.split("->");
      cur = { pid, command, local, remote, listen: false };
      conns.push(cur);
    } else if (tag === "T" && cur && val === "ST=LISTEN") cur.listen = true;
  }
  return conns;
}

/** `ss -tanpH` output → the sockets of `want` pids, as parseLsof's. */
function parseSs(out, want) {
  const conns = [];
  for (const line of out.split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f.length < 5) continue;
    const [state, , , local, peer] = f;
    const listen = state === "LISTEN";
    for (const [, command, pid] of line.matchAll(/\("([^"]*)",pid=(\d+)/g)) {
      if (want.has(Number(pid))) conns.push({ pid: Number(pid), command, local, remote: listen || /:\*$/.test(peer) ? undefined : peer, listen });
    }
  }
  return conns;
}

/** The TCP sockets of `pids`: `lsof`, else `ss`; neither → refused. */
function tcpSockets(pids, runner) {
  const l = runner(["lsof", "-nP", "-a", "-iTCP", "-p", pids.join(","), "-FpcnT"]);
  if (!l.error) {
    if (!lsofOk(l)) throw new Error(`failed: lsof exited ${l.status ?? l.signal}: ${tail(l.stderr)}`);
    return parseLsof(l.stdout || "");
  }
  if (l.error.code !== "ENOENT") throw new Error(`failed: lsof: ${l.error.message}`);
  const s = runner(["ss", "-tanpH"]);
  if (s.error && s.error.code === "ENOENT") throw new Error("refused: neither lsof nor ss is available");
  if (s.error || s.status !== 0) throw new Error(`failed: ss: ${(s.error && s.error.message) || `exited ${s.status}: ${tail(s.stderr)}`}`);
  return parseSs(s.stdout || "", new Set(pids));
}

/**
 * `lsof -nP -U -F pcdn` over every process → the unix-socket peers of `want` pids, as [{pid, command,
 * path}]. macOS's lsof names a connected client only by its peer's address (`->0x…`), so the path comes
 * from the socket whose own address (`d`) that is.
 */
function parseLsofUnix(out, want, extra = new Map()) {
  const recs = [];
  let pid;
  let command;
  let cur = null;
  for (const line of out.split("\n")) {
    const [tag, val] = [line[0], line.slice(1)];
    if (tag === "p") pid = Number(val);
    else if (tag === "c") command = val;
    else if (tag === "f") recs.push((cur = { pid, command }));
    else if (tag === "d" && cur) cur.addr = val;
    else if (tag === "n" && cur) cur.name = val.replace(/ type=\S+$/, "");
  }
  const byAddr = new Map(extra);
  for (const r of recs) if (r.addr && r.name && r.name.startsWith("/")) byAddr.set(sockAddr(r.addr), r.name);
  const out2 = [];
  for (const r of recs) {
    if (!want.has(r.pid) || !r.name || !r.name.startsWith("->")) continue;
    const p = byAddr.get(sockAddr(r.name.slice(2)));
    if (p) out2.push({ pid: r.pid, command: r.command, path: p });
  }
  return out2;
}

/** A kernel socket address as lsof (`0x…`) and netstat (bare hex) print it, in one form. */
const sockAddr = (a) => String(a).toLowerCase().replace(/^0x/, "").replace(/^0+(?=.)/, "");

/**
 * `netstat -an -f unix` (macOS, BSD) → {address: path} for every bound socket, every user's: lsof sees
 * only the sockets of processes it may inspect, so a server another user runs is named here. Its
 * Address column is the address lsof prints (checked against lsof on macOS). On macOS a netstat that
 * fails is `failed: …` (another user's server would go unseen); elsewhere, where `-f unix` is not
 * netstat's, it maps nothing.
 */
function netstatUnix(runner) {
  const r = runner(["netstat", "-an", "-f", "unix"]);
  const map = new Map();
  if (r.error || r.status !== 0) {
    if (process.platform !== "darwin") return map;
    throw new Error(`failed: netstat -an -f unix ${r.error ? r.error.message : `exited ${r.status}: ${tail(r.stderr)}`}`);
  }
  for (const line of String(r.stdout || "").split("\n")) {
    const m = line.trim().match(/^([0-9a-f]+)\s+\S+\s+\d+\s+\d+\s+[0-9a-f]+\s+[0-9a-f]+\s+[0-9a-f]+\s+[0-9a-f]+\s+(\/.*)$/i);
    if (m) map.set(sockAddr(m[1]), m[2]);
  }
  return map;
}

/**
 * `ss -xapH` → the unix-socket peers of `want` pids: a client's peer inode is the server socket's own
 * inode, whose line names the path. Abstract names (`@…`) are not paths.
 */
function parseSsUnix(out, want) {
  const lines = [];
  for (const line of out.split("\n")) {
    const m = line.trim().replace(/^u_(str|dgr|seq)\s+/, "").match(/^(\S+)\s+\d+\s+\d+\s+(\S+)\s+(\d+)\s+(\S+)\s+(\d+)(.*)$/);
    if (m) lines.push({ local: m[2], ino: m[3], peerIno: m[5], users: [...m[6].matchAll(/\("([^"]*)",pid=(\d+)/g)].map((u) => ({ command: u[1], pid: Number(u[2]) })) });
  }
  const byIno = new Map(lines.filter((l) => l.local.startsWith("/")).map((l) => [l.ino, l.local]));
  const out2 = [];
  for (const l of lines) {
    const p = byIno.get(l.peerIno);
    if (!p) continue;
    for (const u of l.users) if (want.has(u.pid)) out2.push({ pid: u.pid, command: u.command, path: p });
  }
  return out2;
}

/** The unix-socket peers of `pids` (ss on Linux, lsof elsewhere, the other as a fallback); neither → refused. */
function unixPeers(pids, runner) {
  const want = new Set(pids);
  for (const tool of process.platform === "linux" ? ["ss", "lsof"] : ["lsof", "ss"]) {
    const r = tool === "lsof" ? runner(["lsof", "-nP", "-U", "-Fpcdn"]) : runner(["ss", "-xapH"]);
    if (r.error && r.error.code === "ENOENT") continue;
    if (r.error) throw new Error(`failed: ${tool}: ${r.error.message}`);
    if (tool === "lsof") {
      if (!lsofOk(r)) throw new Error(`failed: lsof exited ${r.status ?? r.signal}: ${tail(r.stderr)}`);
      return parseLsofUnix(r.stdout || "", want, netstatUnix(runner));
    }
    if (r.status !== 0) throw new Error(`failed: ss exited ${r.status}: ${tail(r.stderr)}`);
    return parseSsUnix(r.stdout || "", want);
  }
  throw new Error("refused: neither lsof nor ss is available");
}

/** Where local datastores keep their sockets by default. */
const DATASTORE_SOCKET_DIRS = ["/var/run/postgresql", "/run/postgresql", "/var/run/mysqld", "/run/mysqld", "/var/run/redis", "/run/redis"];

/** The directories the owner's env files name for sockets: a unix URL's or socket path's directory, a libpq socket directory. */
function ownerSocketDirs(main, contract) {
  const dirs = new Set();
  if (!main) return dirs;
  const realMain = fs.realpathSync.native(main);
  const guard = (contract && contract.guard) || {};
  for (const f of [".env", ".env.local", ...(guard.envFiles ?? [])]) {
    let text;
    try {
      text = fs.readFileSync(path.join(main, f), "utf8");
    } catch {
      continue;
    }
    for (const [k, raw] of Object.entries(parseEnvFile(text))) {
      const v = raw.trim();
      const sock = /^([a-z][a-z0-9+.-]*\+)?unix:/i.test(v) || SOCKET_NAME.test(path.basename(v.replace(/[?#].*$/, "")));
      for (const p of filePaths(v) ?? []) {
        if (sock) dirs.add(resolveLink(path.dirname(path.resolve(realMain, p))));
        else if (/HOST|SOCK/i.test(k) && p.startsWith("/")) dirs.add(resolveLink(p));
      }
      const q = v.match(/[?&]host=([^&#]+)/);
      if (q && decodeSafe(q[1]).startsWith("/")) dirs.add(resolveLink(decodeSafe(q[1])));
    }
  }
  dirs.delete(null);
  return dirs;
}

const DATASTORE_SOCKET = /^(\.s\.PGSQL\.\d+|mysql[^/]*\.sock|mysqld[^/]*\.sock|redis[^/]*\.sock|mongodb-\d+\.sock|memcached[^/]*\.sock)$/i;

/**
 * `up` step 8 (and every `renew` and `up --fresh`): sampled `samples` times, `intervalMs` apart, the
 * connections of `pids`, every process of the run's recorded groups whose identity is not someone else's
 * (runPids):
 * - TCP may reach only `allowed` (egressAllowed's endpoints; a host name stands for every address
 *   `lookup` gives it) or another listener of those processes on loopback; a connection they accepted
 *   (its local port is one they listen on) is inbound, not egress;
 * - a unix socket outside `runDirs` may not be a datastore's: a PostgreSQL, MySQL, Redis, MongoDB or
 *   memcached socket name, a socket in a datastore's default directory or in a directory the owner's env
 *   files name for a socket, or any socket inside <MAIN> (`main`; its env files read through `contract`).
 * On the first sample, when `expectListen` names ports, at least one must show as a listener of those
 * processes, or the listing is not trusted (and with no process to list at all, it is not either). Throws `refused: <process> (<pid>) connects to <host:port>`
 * or `… connects to the socket <path>`; neither lsof nor ss → `refused: neither lsof nor ss is
 * available`; an lsof that exits 1 with an error → `failed: …`. Known limits (spec §8): a process that
 * left its group or lives in a container is not listed, and a connection between two samples is not seen.
 */
export async function checkEgress({ pids, allowed = [], runner = run, lookup = (h) => dns.promises.lookup(h, { all: true }), samples = 5, intervalMs = 500, expectListen = [], runDirs = [], main, contract }) {
  const want = [...new Set((pids ?? []).filter((p) => Number.isInteger(p) && p > 0))];
  if (!want.length) {
    // Nothing to list passes everything: only right while no listener is expected.
    if (expectListen.length) throw new Error(`failed: no process of the run is left to list, yet one should serve port ${expectListen.join(", ")}; the listing cannot be trusted`);
    return;
  }
  const ok = new Set();
  for (const a of allowed) {
    const [h, p] = splitAddr(a);
    ok.add(endpointKey(h, p));
    if (h === "loopback" || net.isIP(h.replace(/^\[(.*)\]$/, "$1"))) continue;
    try {
      for (const r of await lookup(h)) ok.add(endpointKey(r.address, p));
    } catch {
      // a name that does not resolve here allows nothing more
    }
  }
  const own = runDirs.map((d) => resolveLink(d)).filter(Boolean);
  const realMain = main ? fs.realpathSync.native(main) : null;
  const dirs = new Set([...DATASTORE_SOCKET_DIRS.map(resolveLink).filter(Boolean), ...ownerSocketDirs(main, contract)]);
  const datastore = (p) => DATASTORE_SOCKET.test(path.basename(p)) || dirs.has(path.dirname(p)) || (realMain !== null && within(realMain, p));
  for (let i = 0; i < samples; i++) {
    if (i) await sleep(intervalMs);
    const sockets = tcpSockets(want, runner);
    const listening = new Set(sockets.filter((s) => s.listen).map((s) => splitAddr(s.local)[1]));
    if (i === 0 && expectListen.length && !expectListen.some((p) => listening.has(String(p)))) {
      throw new Error(`failed: the socket listing shows no listener of the run on ${expectListen.join(", ")}; it cannot be trusted`);
    }
    for (const s of sockets) {
      if (s.listen || !s.remote || listening.has(splitAddr(s.local)[1])) continue;
      const [h, p] = splitAddr(s.remote);
      const key = endpointKey(h, p);
      if (ok.has(key) || (key.startsWith("loopback:") && listening.has(p))) continue;
      throw new Error(`refused: ${s.command} (${s.pid}) connects to ${s.remote}`);
    }
    for (const u of unixPeers(want, runner)) {
      const real = resolveLink(u.path) ?? u.path;
      if (own.some((d) => within(d, real))) continue;
      if (datastore(real)) throw new Error(`refused: ${u.command} (${u.pid}) connects to the socket ${u.path}`);
    }
  }
}
