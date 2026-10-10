// argus-live-proxy.mjs — the run's filtering forward proxy (spec §8 step 9, §9 "network block"): every
// request of the run's browsers goes through it — plain HTTP in absolute form, CONNECT tunnels and
// WebSocket upgrades, loopback included (Playwright adds `<-loopback>` to Chrome's bypass list) — and it
// admits only the run's origins and `allow_origins`. It runs as `argus-live.mjs proxy <runId>`, a
// recorded process group of the run, and exits by itself once the lock no longer names its run.
import { spawn } from "node:child_process";
import dns from "node:dns";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { normHost } from "./argus-live-endpoints.mjs";
import { readLock, runIdOk } from "./argus-live-lock.mjs";
import { canonicalOrigin, exactHost } from "./argus-live-origin.mjs";
import { killGroup, sleep, startTime } from "./argus-live-proc.mjs";
import { CLI, logsDir, readRun, updateRun } from "./argus-live-run.mjs";

const defaultLookup = (h) => dns.promises.lookup(h, { all: true });

/**
 * True when `{scheme, host, port}` is allowed: `allowed` is a set of canonical origins
 * (canonicalOrigin; a host only as a run origin spells it, no loopback alias); a CONNECT target
 * (`scheme` "connect") is allowed when its http or https origin is.
 */
export function proxyAllows({ scheme, host, port }, { allowed }) {
  const h = exactHost(host);
  if (!h) return false;
  const schemes = scheme === "connect" ? ["http", "https"] : [scheme];
  return schemes.some((s) => allowed.has(`${s}://${h}:${port}`));
}

/** The origin a blocked target is logged as: CONNECT to port 443 is `https://host`, any other `http://host:port`. */
function shownOrigin(scheme, host, port) {
  const s = scheme === "connect" ? (Number(port) === 443 ? "https" : "http") : scheme;
  return new URL(`${s}://${net.isIP(host) === 6 ? `[${host}]` : host}:${port}`).origin;
}

/**
 * The filtering proxy → an `http.Server` (not listening yet). `allowed`: origins (any form; compared
 * canonically); `runHosts`: the host names of the run's origins that are not loopback by themselves —
 * such a host is connected to only when `lookup` gives it loopback addresses only at that moment, and
 * then at the address checked (no second lookup to rebind). Absolute-form `http://` requests are
 * forwarded (their Proxy-* headers dropped); origin-form requests and absolute `https://` answer 400 (it
 * is not a reverse proxy; https goes through CONNECT); CONNECT opens a tunnel; an upgrade (WebSocket)
 * is piped. Anything else answers 403 and `onBlocked(origin, kind)` — once per origin per server.
 * URLs are read with WHATWG `URL`, so `http://localhost:<p>@outside.test/` is outside.test.
 */
export function createProxy({ allowed = [], runHosts = [], lookup = defaultLookup, onBlocked = () => {}, upstream = () => null } = {}) {
  const set = new Set([...allowed].map(canonicalOrigin));
  let tracked = (sock) => sock;
  const named = new Set([...runHosts].map((h) => normHost(h)));
  const reported = new Set();
  const block = (scheme, host, port, kind) => {
    const origin = shownOrigin(scheme, host, port);
    if (reported.has(origin)) return;
    reported.add(origin);
    try {
      onBlocked(origin, kind);
    } catch {
      // a log that cannot be written never stops the proxy
    }
  };
  /**
   * Where to connect for an allowed target: a loopback address as it is; a loopback name (`localhost`,
   * `*.localhost`) at the address the run's listener on that port passed health on (`upstream(port)`),
   * never by a lookup — undefined (502) when none is recorded; a run host that is a name, at the loopback
   * address it resolves to now — null (blocked) when it resolves elsewhere.
   */
  const address = async (host, port) => {
    const h = normHost(host);
    const bare = host.replace(/^\[(.*)\]$/, "$1");
    if (h === "loopback") return net.isIP(bare) ? bare : (upstream(port) ?? undefined);
    if (!named.has(h)) return host;
    try {
      const addrs = await lookup(host);
      const ok = Array.isArray(addrs) && addrs.length > 0 && addrs.every((a) => normHost(a.address) === "loopback");
      return ok ? addrs[0].address : null;
    } catch {
      return null;
    }
  };
  /** The absolute `http://` target of a request, or null (origin form, another scheme, unparsable). */
  const absolute = (raw) => {
    if (!/^http:\/\//i.test(raw || "")) return null;
    try {
      const u = new URL(raw);
      return { u, host: u.hostname.replace(/^\[(.*)\]$/, "$1"), port: Number(u.port || 80) };
    } catch {
      return null;
    }
  };
  const headersFor = (req) => {
    const out = {};
    for (const [k, v] of Object.entries(req.headers)) if (!/^proxy-/i.test(k)) out[k] = v;
    return out;
  };
  const deny = (socket, code, text) => {
    socket.on("error", () => {});
    socket.end(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  };

  const server = http.createServer(async (req, res) => {
    const t = absolute(req.url);
    const answer = (code) => {
      res.writeHead(code, { "content-type": "text/plain", connection: "close" });
      res.end(code === 403 ? "blocked by the run's proxy\n" : code === 502 ? "no address recorded for this run listener\n" : "not a proxy request\n");
    };
    if (!t) return answer(400);
    const to = proxyAllows({ scheme: "http", host: t.host, port: t.port }, { allowed: set }) ? await address(t.host, t.port) : null;
    if (to === undefined) return answer(502);
    if (!to) {
      block("http", t.host, t.port, "http");
      return answer(403);
    }
    const up = http.request({ host: to, port: t.port, method: req.method, path: `${t.u.pathname}${t.u.search}`, headers: headersFor(req), agent: false });
    up.on("response", (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { connection: "close" });
      res.end();
    });
    req.pipe(up);
  });
  server.on("connect", async (req, socket, head) => {
    socket.on("error", () => {});
    let host;
    let port;
    try {
      const u = new URL(`http://${req.url}`);
      host = u.hostname.replace(/^\[(.*)\]$/, "$1");
      port = Number(u.port);
      if (!/:\d+$/.test(req.url) || !port || u.pathname !== "/" || u.username || u.password) throw new Error("bad target");
    } catch {
      return deny(socket, 400, "Bad Request");
    }
    const to = proxyAllows({ scheme: "connect", host, port }, { allowed: set }) ? await address(host, port) : null;
    if (to === undefined) return deny(socket, 502, "Bad Gateway");
    if (!to) {
      block("connect", host, port, "connect");
      return deny(socket, 403, "Forbidden");
    }
    const up = tracked(net.connect(port, to, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head && head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    }));
    up.on("error", () => (socket.writable ? deny(socket, 502, "Bad Gateway") : socket.destroy()));
    socket.on("close", () => up.destroy());
  });
  server.on("upgrade", async (req, socket, head) => {
    socket.on("error", () => {});
    const t = absolute(req.url);
    if (!t) return deny(socket, 400, "Bad Request");
    const to = proxyAllows({ scheme: "http", host: t.host, port: t.port }, { allowed: set }) ? await address(t.host, t.port) : null;
    if (to === undefined) return deny(socket, 502, "Bad Gateway");
    if (!to) {
      block("http", t.host, t.port, "websocket");
      return deny(socket, 403, "Forbidden");
    }
    const up = tracked(net.connect(t.port, to, () => {
      const lines = [`${req.method} ${t.u.pathname}${t.u.search} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) if (!/^proxy-/i.test(req.rawHeaders[i])) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      up.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head && head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    }));
    up.on("error", () => (socket.writable ? deny(socket, 502, "Bad Gateway") : socket.destroy()));
    socket.on("close", () => up.destroy());
  });
  server.on("clientError", (_e, socket) => (socket.writable ? deny(socket, 400, "Bad Request") : socket.destroy()));
  // Every socket either side holds, tunnels and upgrades included (the server stops tracking those).
  const sockets = new Set();
  const track = (sock) => {
    sockets.add(sock);
    sock.once("close", () => sockets.delete(sock));
    return sock;
  };
  server.on("connection", track);
  tracked = track;
  /** Closes the server and destroys every socket it or its upstreams hold → a promise. */
  server.closeAll = () =>
    new Promise((done) => {
      server.close(() => done());
      for (const sock of sockets) sock.destroy();
    });
  return server;
}

const blockedLog = (main, runId) => path.join(logsDir(main, runId), "proxy-blocked.jsonl");

/**
 * `argus-live.mjs proxy <runId>`: the run's proxy, for run.json's `origins` and `allowOrigins` (the
 * expanded `allow_origins`, recorded by `up`), connecting loopback names at run.json's `upstream`
 * (`{<port>: <address>}`: where each listener passed health; re-read every `pollMs`). Listens on 127.0.0.1:0, writes `<logs>/proxy.json`
 * `{port, pid}`, appends each blocked origin once to `<logs>/proxy-blocked.jsonl` as `{t, origin, kind}`,
 * and re-reads the lock every `pollMs`, closing once it no longer names `runId` (resolves then).
 */
export async function serveProxy(main, runId, { lookup = defaultLookup, pollMs = 2000 } = {}) {
  runIdOk(runId);
  const rec = readRun(main);
  if (!rec || rec.runId !== runId) throw new Error(`refused: run.json does not name cycle ${runId}`);
  const origins = rec.origins ?? [];
  const runHosts = origins.map((o) => new URL(o).hostname).filter((h) => normHost(h) !== "loopback");
  const logs = logsDir(main, runId);
  fs.mkdirSync(logs, { recursive: true, mode: 0o700 });
  const onBlocked = (origin, kind) => fs.appendFileSync(blockedLog(main, runId), `${JSON.stringify({ t: Date.now(), origin, kind })}\n`, { mode: 0o600 });
  // Where each run port's listener passed health (run.json `upstream`, rewritten by `up --fresh`): re-read with the lock.
  let upstream = rec.upstream ?? {};
  const server = createProxy({ allowed: [...origins, ...(rec.allowOrigins ?? [])], runHosts, lookup, onBlocked, upstream: (port) => (typeof upstream[String(port)] === "string" ? upstream[String(port)] : null) });
  await new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", ok);
  });
  const file = path.join(logs, "proxy.json");
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ port: server.address().port, pid: process.pid })}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  for (;;) {
    await sleep(pollMs);
    let lock;
    try {
      lock = readLock(main);
    } catch {
      lock = null;
    }
    if (!lock || lock.runId !== runId) break;
    try {
      const now = readRun(main);
      if (now && now.runId === runId && now.upstream && typeof now.upstream === "object") upstream = now.upstream;
    } catch {
      // keep the addresses read before
    }
  }
  await server.closeAll();
}

/**
 * Starts the run's proxy: `node <script> proxy <runId>`, detached into its own process group, in MAIN.
 * Its group `{name: "proxy", internal: true, pgid, started, cmdline}` is pushed onto `groups` at once (a
 * recording array: run.json holds it before anything waits; a push that throws kills the proxy and
 * rethrows); then it waits up to `timeoutMs` for `proxy.json` and writes run.json `internal.proxy`
 * through updateRun → {pid, port}.
 */
export async function startProxy(main, runId, { groups, script = CLI, timeoutMs = 10_000 }) {
  runIdOk(runId);
  const file = path.join(logsDir(main, runId), "proxy.json");
  fs.rmSync(file, { force: true });
  const child = spawn(process.execPath, [script, "proxy", runId], { cwd: main, detached: true, stdio: "ignore" });
  child.on("error", () => {});
  if (!child.pid) throw new Error("failed: the proxy could not start");
  child.unref();
  const pid = child.pid;
  let exited = false;
  child.once("exit", () => (exited = true));
  try {
    groups.push({ name: "proxy", internal: true, pgid: pid, started: startTime(pid), cmdline: `${process.execPath} ${script} proxy ${runId}` });
  } catch (e) {
    killGroup(pid);
    throw e;
  }
  const end = Date.now() + timeoutMs;
  let port = null;
  while (port === null) {
    try {
      const p = JSON.parse(fs.readFileSync(file, "utf8"));
      if (p.pid === pid && Number.isInteger(p.port)) port = p.port;
    } catch {
      // not written yet
    }
    if (port !== null) break;
    if (exited || Date.now() >= end) {
      killGroup(pid);
      throw new Error(`failed: the proxy ${exited ? "exited" : `did not start within ${Math.round(timeoutMs / 1000)} s`}`);
    }
    await sleep(50);
  }
  updateRun(main, runId, (prev) => (prev ? { ...prev, internal: { ...(prev.internal ?? {}), proxy: port } } : undefined), { create: false });
  return { pid, port };
}

/** The origins the proxy blocked after byte `offset` of its log → {origins, offset} (complete lines only). */
export function blockedSince(main, runId, offset = 0) {
  let buf;
  try {
    buf = fs.readFileSync(blockedLog(main, runId));
  } catch {
    return { origins: [], offset };
  }
  const text = buf.subarray(offset).toString("utf8");
  const end = text.lastIndexOf("\n") + 1;
  const origins = [];
  for (const line of text.slice(0, end).split("\n")) {
    if (!line) continue;
    try {
      const o = JSON.parse(line).origin;
      if (typeof o === "string") origins.push(o);
    } catch {
      // a torn line is skipped
    }
  }
  return { origins, offset: offset + Buffer.byteLength(text.slice(0, end)) };
}
