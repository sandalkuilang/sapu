// argus-live-dockerproxy.mjs — the run's Docker socket proxy (spec §8 step 3): every docker call of the
// instance goes through a unix socket of the run's own, so what the run does to the daemon is known,
// and refused before it happens when it would touch what is not the run's. What reaches the daemon any
// other way (another checkout's tests, the owner's own tools) is outside the run: the Docker runtime gate
// reports it, it does not refuse the cycle for it.
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { killGroup, sleep, startTime } from "./argus-live-proc.mjs";

/** The proxy's group in run.json (internal: `down` stops it after the stops and the other groups). */
export const DOCKER_PROXY = "docker-proxy";
/** The label the proxy puts on every container, volume and network created through it: the run's Compose project. */
export const RUN_LABEL = "sapu.run";
const PROJECT_LABEL = "com.docker.compose.project";
/** sun_path holds 104 bytes on macOS (108 on Linux), its closing NUL included. */
const SUN_PATH = 103;
const MAX_BODY = 4 * 1024 * 1024;
const MAX_HEAD = 64 * 1024;

/**
 * What a request does to the daemon (`p`: its path without the `/v1.NN` prefix and the query):
 * {create: kind} for a create the proxy labels, {prune: kind} for a prune (it reaches every object of the
 * kind), {kind, id, verb} for an action on one existing object the proxy allows only on the run's own,
 * or null (reads, images, builds, exec start and inspect, events, logs: passed as they are).
 */
export function actionOf(method, p) {
  let m = p.match(/^\/(containers|volumes|networks)\/(create|prune)$/);
  if (m && method === "POST") return m[2] === "create" ? { create: m[1] } : { prune: m[1] };
  m = p.match(/^\/containers\/([^/]+)(?:\/([a-z/]+))?$/);
  if (m) {
    const [, id, sub = ""] = m;
    if (method === "DELETE" && !sub) return { kind: "containers", id, verb: "rm" };
    if (method === "POST" && /^(exec|start|stop|restart|kill|pause|unpause|update|rename|attach)$/.test(sub)) return { kind: "containers", id, verb: sub };
    if (sub === "attach/ws" || sub === "export") return { kind: "containers", id, verb: sub };
    if (sub === "archive") return { kind: "containers", id, verb: method === "PUT" ? "cp into" : "cp out of" };
    return null;
  }
  m = p.match(/^\/(volumes|networks)\/([^/]+)(?:\/(connect|disconnect))?$/);
  if (m && ((method === "DELETE" && !m[3]) || (method === "POST" && m[3]))) return { kind: m[1], id: decodeURIComponent(m[2]), verb: m[3] ?? "rm" };
  return null;
}

/** An event's time as ISO (UTC), from its `timeNano` or `time` (epoch seconds); null when it has none. */
function eventTime(e) {
  // Rounded: a nanosecond count past 2^53 loses its last digits as a float, so a plain division can land 1 ms early.
  const ms = Number.isFinite(e.timeNano) ? Math.round(e.timeNano / 1e6) : Number.isFinite(e.time) ? e.time * 1000 : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

const SHELLS = new Set(["sh", "bash", "ash", "dash", "zsh", "ksh", "mksh"]);
const WRAPPERS = new Set(["env", "exec", "command", "nice", "timeout"]);
const WRAPPER_ARG = /^(?:-n|-i|-?\d+(?:\.\d+)?[smhd]?)$/; // env -i, nice -n 5, timeout 30s

/**
 * The program an exec runs, from the Action's text after `exec_create: ` (the daemon joins the argv with
 * spaces): the basename of the first word; for a shell run with `-c`, of the first word of the inner command,
 * after leading `NAME=value` assignments (a quoted value may hold spaces) and trivial wrappers (WRAPPERS).
 * Null when that word is no plain program name. Another process's secrets cannot be listed by shape
 * (`PASSWORD=x`, libpq `password=x`, `curl -u a:b`, `-p<value>`, a header, a JSON body …): never an argument is shown.
 */
function execProgram(action) {
  const words = action.slice(action.indexOf(":") + 1).split(/[\s\x00-\x1f\x7f]+/).filter(Boolean).map((w) => w.replace(/^["'(]+/, ""));
  const base = (w) => w.split("/").pop();
  let i = 0;
  if (SHELLS.has(base(words[0] ?? ""))) {
    let c = 1;
    while (words[c]?.startsWith("-") && !/^-[A-Za-z]*c$/.test(words[c])) c++;
    if (words[c]?.startsWith("-")) i = c + 1;
  }
  for (let wrapped = false; i < words.length; i++) {
    const w = words[i];
    if (wrapped && WRAPPER_ARG.test(w)) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
      const q = /=(["'])/.exec(w);
      if (q && !w.includes(q[1], q.index + 2)) while (++i < words.length && !words[i].endsWith(q[1]));
    } else if (WRAPPERS.has(base(w))) wrapped = true;
    else return /^[A-Za-z0-9_][A-Za-z0-9_.+-]{0,63}$/.test(base(w)) ? base(w) : null;
  }
  return null;
}

/**
 * What a refusal on an object outside the run adds after its leading text: the exec's program (`exec_*`
 * events), the event's time, and that the gate cannot tell who did it, with the follower's file (relative to `main`).
 */
export function whatHappened(e, action, { main, eventsFile, proxied }) {
  const time = eventTime(e);
  const facts = [action.startsWith("exec_") ? `exec of ${execProgram(action) ?? "an unnamed program"}` : null, time ? `at ${time}` : null].filter(Boolean);
  const file = eventsFile ? `; the docker events of this run are in ${path.relative(main, eventsFile)}` : "";
  const who = proxied ? "It did not pass the run's Docker proxy: another process on this machine did it (or one of the run's that dials the daemon's socket itself)" : "The gate cannot tell which process did it: another process on this machine, such as tests in another checkout, counts too";
  return `${facts.length ? ` (${facts.join(", ")})` : ""}. ${who}${file}`;
}

/** The labels of `kind`/`id` on the daemon at `upstream`; null when it has none such (the daemon answers that). */
function labelsOf(upstream, kind, id) {
  return new Promise((ok, fail) => {
    const req = http.get({ socketPath: upstream, path: `/${kind}/${encodeURIComponent(id)}${kind === "containers" ? "/json" : ""}`, headers: { Host: "docker" } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (d) => (body += d));
      res.on("end", () => {
        if (res.statusCode === 404) return ok(null);
        try {
          const j = JSON.parse(body);
          ok({ name: String(j.Name ?? id).replace(/^\//, ""), labels: (kind === "containers" ? j.Config && j.Config.Labels : j.Labels) ?? {} });
        } catch {
          fail(new Error(`the daemon's answer for ${kind} ${id} is not JSON (status ${res.statusCode})`));
        }
      });
    });
    req.on("error", fail);
  });
}

/** An HTTP answer the proxy gives itself, in the daemon's error form (the CLI prints `message`). */
function answer(sock, status, message) {
  const body = JSON.stringify({ message });
  sock.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
}

/**
 * The proxy itself: listens on `listen` (mode 0600), forwards to the daemon socket `upstream`, appends one
 * line per request to `logFile` ({t, m, p, v}: time, method, path without its query, verdict). Bytes pass
 * untouched, one request per connection: the head is read, `Connection: close` forced unless the request
 * upgrades (exec, attach, BuildKit's session), then both ways are piped half-open (the CLI closes its side
 * once stdin ends; the output still comes back). Node's http server is not used: it drops the body of an
 * Upgrade request, so an exec would never start. A create gets RUN_LABEL = `project` in its JSON body; an
 * action on one object (actionOf) is refused (403) unless the object's labels name `project` (its Compose
 * project or RUN_LABEL); a prune is refused. Resolves with the server once listening.
 */
export function serve({ listen, upstream, project, logFile }) {
  const log = (o) => fs.appendFileSync(logFile, `${JSON.stringify({ t: new Date().toISOString(), ...o })}\n`, { mode: 0o600 });
  const ours = (labels) => labels[PROJECT_LABEL] === project || labels[RUN_LABEL] === project;
  const server = net.createServer({ allowHalfOpen: true }, (client) => {
    let buf = Buffer.alloc(0);
    let parsed = null;
    client.on("error", () => client.destroy());
    const refuse = (status, message) => {
      client.off("data", listener);
      log({ m: parsed.method, p: parsed.p, v: "refused" });
      answer(client, status, `sapu: refused: ${message}`);
    };
    const onData = async (d) => {
      buf = Buffer.concat([buf, d]);
      if (!parsed) {
        const end = buf.indexOf("\r\n\r\n");
        if (end < 0) return buf.length > MAX_HEAD ? client.destroy() : undefined;
        const lines = buf.subarray(0, end).toString("latin1").split("\r\n");
        const [method = "", url = ""] = lines[0].split(" ");
        const header = (n) => lines.find((l) => l.toLowerCase().startsWith(`${n}:`))?.slice(n.length + 1).trim();
        parsed = { end, lines, method, p: url.split("?")[0].replace(/^\/v[\d.]+(?=\/)/, ""), header };
      }
      const { end, lines, method, p, header } = parsed;
      const act = actionOf(method, p);
      let body = buf.subarray(end + 4);
      let head = lines;
      if (act && act.create) {
        const cl = Number(header("content-length"));
        if (!Number.isInteger(cl) || header("transfer-encoding")) return refuse(411, `a create of ${act.create} without a Content-Length; the run's proxy labels what it creates`);
        if (cl > MAX_BODY) return refuse(413, `a create of ${act.create} of ${cl} bytes`);
        if (body.length < cl) return; // the rest of the body is still coming
        let j;
        try {
          j = cl ? JSON.parse(body.subarray(0, cl).toString("utf8")) : {};
        } catch {
          j = null;
        }
        if (!j || typeof j !== "object" || Array.isArray(j)) return refuse(400, `a create of ${act.create} whose body is not a JSON object`);
        j.Labels = { ...(j.Labels ?? {}), [RUN_LABEL]: project };
        const out = Buffer.from(JSON.stringify(j));
        body = Buffer.concat([out, body.subarray(cl)]);
        head = [...lines.filter((l) => !/^content-length:/i.test(l)), `Content-Length: ${out.length}`];
      }
      client.off("data", listener);
      client.pause();
      if (act && act.prune) return refuse(403, `docker ${act.prune} prune reaches every ${act.prune.replace(/s$/, "")} on this machine, not only the run's`);
      if (act && act.verb) {
        let o;
        try {
          o = await labelsOf(upstream, act.kind, act.id);
        } catch (e) {
          return refuse(502, `docker ${act.verb} on ${act.kind.replace(/s$/, "")} ${act.id}: its owner cannot be checked (${e.message})`);
        }
        if (o && !ours(o.labels)) return refuse(403, `docker ${act.verb} on ${act.kind.replace(/s$/, "")} ${o.name}, which is not this run's (Compose project ${project}); the journey's instance may touch only its own containers, volumes and networks`);
      }
      log({ m: method, p, v: "passed" });
      const upgrade = lines.some((l) => /^upgrade:/i.test(l));
      if (!upgrade) head = [...head.filter((l) => !/^connection:/i.test(l)), "Connection: close"];
      let connected = false;
      const up = net.connect({ path: upstream, allowHalfOpen: true }, () => {
        connected = true;
        up.write(`${head.join("\r\n")}\r\n\r\n`);
        if (body.length) up.write(body);
        up.pipe(client);
        client.pipe(up);
        client.resume();
      });
      up.on("error", (e) => (!connected ? answer(client, 502, `Cannot connect to the Docker daemon at unix://${upstream}. Is the docker daemon running? (${e.code || e.message})`) : client.destroy()));
      client.on("close", () => up.destroy());
    };
    const listener = (d) => onData(d).catch(() => client.destroy());
    client.on("data", listener);
  });
  return new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(listen, () => {
      fs.chmodSync(listen, 0o600);
      ok(server);
    });
  });
}

/**
 * Starts the run's Docker proxy for the daemon socket `upstream`: `node <this file> <dir>/docker.sock
 * <upstream> <project> <logs>/docker-proxy.jsonl`, detached into its own process group, its group
 * `{name: DOCKER_PROXY, internal: true, …}` pushed onto `groups` at once. The socket's directory is new,
 * private (0700) and in the OS temp dir: a run's directory under the repo can be too deep for a socket
 * path. Waits up to `timeoutMs` for the socket → {host: `unix://<socket>`, socket, log}.
 */
export async function startDockerProxy({ upstream, project, logs, groups, timeoutMs = 10_000 }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sapu-docker-"));
  const socket = path.join(dir, "docker.sock");
  if (Buffer.byteLength(socket) > SUN_PATH) throw new Error(`refused: the Docker proxy's socket path ${socket} is longer than a unix socket allows (${SUN_PATH} bytes); set TMPDIR to a shorter directory`);
  fs.mkdirSync(logs, { recursive: true, mode: 0o700 });
  const log = path.join(logs, "docker-proxy.jsonl");
  const err = fs.openSync(path.join(logs, "docker-proxy.log"), "a", 0o600);
  const script = fileURLToPath(import.meta.url);
  let child;
  try {
    child = spawn(process.execPath, [script, socket, upstream, project, log], { detached: true, stdio: ["ignore", "ignore", err] });
  } finally {
    fs.closeSync(err);
  }
  child.on("error", () => {});
  if (!child.pid) throw new Error("failed: the Docker proxy could not start");
  child.unref();
  let exited = false;
  child.once("exit", () => (exited = true));
  try {
    groups.push({ name: DOCKER_PROXY, internal: true, pgid: child.pid, started: startTime(child.pid), cmdline: `${process.execPath} ${script} ${socket}` });
  } catch (e) {
    killGroup(child.pid);
    throw e;
  }
  for (const end = Date.now() + timeoutMs; !fs.existsSync(socket); await sleep(50)) {
    if (exited || Date.now() >= end) {
      killGroup(child.pid);
      throw new Error(`failed: the Docker proxy ${exited ? "exited" : `did not start within ${Math.round(timeoutMs / 1000)} s`}; see ${path.join(logs, "docker-proxy.log")}`);
    }
  }
  return { host: `unix://${socket}`, socket, log };
}

/**
 * `env` (the instance's, its DOCKER_HOST the daemon's unix socket) with every docker call through a new
 * Docker proxy of the run (startDockerProxy) → {env, upstream: the daemon's DOCKER_HOST}. testcontainers'
 * reaper mounts DOCKER_HOST's socket into a container, and a VM's daemon (Docker Desktop, OrbStack, Colima)
 * cannot mount a socket of this host: unless `env` sets TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE, it is the
 * daemon's own socket path (on Linux the daemon's host is this one).
 */
export async function throughProxy(env, { logs, groups }) {
  const upstream = env.DOCKER_HOST;
  const sock = upstream.slice("unix://".length);
  const { host } = await startDockerProxy({ upstream: sock, project: env.COMPOSE_PROJECT_NAME, logs, groups });
  return { env: { ...env, DOCKER_HOST: host, TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE: env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE ?? (process.platform === "linux" ? sock : "/var/run/docker.sock") }, upstream };
}

/**
 * A recorded stop `s` as it can still run: when its DOCKER_HOST is the run's proxy and that socket is gone
 * (a reboot, a killed proxy), the daemon's socket behind it (`rec.dockerUpstream`), so a teardown still
 * reaches the run's containers; otherwise `s` itself.
 */
export function viaDaemon(s, rec) {
  const host = s && s.env && s.env.DOCKER_HOST;
  const p = String(host ?? "").match(/^unix:\/\/(\/.+)$/)?.[1];
  return p && rec && rec.dockerUpstream && host !== rec.dockerUpstream && !fs.existsSync(p) ? { ...s, env: { ...s.env, DOCKER_HOST: rec.dockerUpstream } } : s;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [listen, upstream, project, logFile] = process.argv.slice(2);
  const bye = () => {
    fs.rmSync(listen, { force: true });
    try {
      fs.rmdirSync(path.dirname(listen)); // its own mkdtemp directory, empty once the socket is gone
    } catch {
      // not empty, or gone already
    }
    process.exit(0);
  };
  process.on("SIGTERM", bye);
  process.on("SIGINT", bye);
  serve({ listen, upstream, project, logFile }).catch((e) => {
    process.stderr.write(`docker proxy: ${e.message}\n`);
    process.exit(1);
  });
}
