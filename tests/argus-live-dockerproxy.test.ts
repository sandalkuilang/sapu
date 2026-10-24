// The run's Docker socket proxy (argus-live-dockerproxy.mjs) against a fake daemon on a unix socket: no Docker needed.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, connect, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { actionOf, dropProxySocket, reachesOf, RUN_LABEL, serve, viaDaemon } from "../plugins/sapu/scripts/argus-live-dockerproxy.mjs";
import { startTime } from "../plugins/sapu/scripts/argus-live-proc.mjs";

type Obj = Record<string, any>;
const P = "argus-run1";
const dirs: string[] = [];
const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A fake daemon: answers inspects from `objects` (path → labels), records every other request (head + body). */
async function daemon(objects: Record<string, Obj>, dir: string) {
  const seen: { head: string; body: string }[] = [];
  const sock = join(dir, "d.sock");
  const srv = createServer({ allowHalfOpen: true }, (c: Socket) => {
    let buf = "";
    c.on("data", (d) => {
      buf += d.toString("latin1");
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      const head = buf.slice(0, end);
      const cl = Number(/content-length: *(\d+)/i.exec(head)?.[1] ?? 0);
      const body = buf.slice(end + 4);
      if (body.length < cl) return;
      const [method, url] = head.split(" ");
      const o = method === "GET" ? objects[url] : undefined;
      if (method === "GET" && url in objects) {
        const json = JSON.stringify(o);
        return c.end(`HTTP/1.1 200 OK\r\nContent-Length: ${json.length}\r\n\r\n${json}`);
      }
      if (method === "GET" && /\/json$|\/volumes\/|\/networks\//.test(url) && !url.startsWith("/v1.47/_ping")) return c.end("HTTP/1.1 404 Not Found\r\nContent-Length: 2\r\n\r\n{}");
      seen.push({ head, body: Buffer.from(body, "latin1").toString("utf8") });
      if (/upgrade:/i.test(head)) return c.end(`HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\nstream:${body}`);
      c.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
    });
  });
  servers.push(srv);
  await new Promise<void>((ok) => srv.listen(sock, ok));
  return { sock, seen };
}

/** One raw request through the proxy at `sock` → the whole answer as text. */
const ask = (sock: string, raw: string) =>
  new Promise<string>((ok, fail) => {
    let out = "";
    const c = connect(sock, () => c.write(raw));
    c.on("data", (d) => (out += d.toString()));
    c.on("end", () => ok(out));
    c.on("error", fail);
  });
const req = (method: string, path: string, body = "", extra = "") => `${method} ${path} HTTP/1.1\r\nHost: docker\r\nConnection: keep-alive\r\n${extra}${body ? `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n` : ""}\r\n${body}`;

async function proxy(objects: Record<string, Obj> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dp-"));
  dirs.push(dir);
  const d = await daemon(objects, dir);
  const listen = join(dir, "p.sock");
  const log = join(dir, "log.jsonl");
  servers.push(await serve({ listen, upstream: d.sock, project: P, logFile: log }));
  return { ...d, listen, log: () => readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)), dir };
}

describe("the run's Docker proxy", () => {
  it("actionOf: creates, prunes and actions on one object; reads, images, builds and exec start pass", () => {
    expect(actionOf("POST", "/containers/create")).toEqual({ create: "containers" });
    expect(actionOf("POST", "/networks/create")).toEqual({ create: "networks" });
    expect(actionOf("POST", "/volumes/prune")).toEqual({ prune: "volumes" });
    expect(actionOf("POST", "/images/prune")).toEqual({ prune: "images" });
    expect(actionOf("POST", "/build/prune")).toEqual({ prune: "build" });
    expect(actionOf("POST", "/libpod/containers/x/start")).toEqual({ libpod: true });
    expect(actionOf("POST", "/containers/db/exec")).toEqual({ kind: "containers", id: "db", verb: "exec" });
    expect(actionOf("DELETE", "/containers/db")).toEqual({ kind: "containers", id: "db", verb: "rm" });
    expect(actionOf("PUT", "/containers/db/archive")).toEqual({ kind: "containers", id: "db", verb: "cp into", prep: true });
    expect(actionOf("HEAD", "/containers/db/archive")).toEqual({ kind: "containers", id: "db", verb: "cp out of", prep: true });
    expect(actionOf("DELETE", "/volumes/pg data")).toEqual({ kind: "volumes", id: "pg data", verb: "rm" });
    expect(actionOf("POST", "/commit", "container=owner-db&pause=1")).toEqual({ kind: "containers", id: "owner-db", verb: "commit" });
    expect(actionOf("POST", "/networks/n1/connect")).toEqual({ kind: "networks", id: "n1", verb: "connect", member: true });
    for (const [m, p] of [["GET", "/containers/db/json"], ["GET", "/containers/db/logs"], ["POST", "/exec/e1/start"], ["POST", "/build"], ["POST", "/images/create"], ["GET", "/events"], ["GET", "/volumes/v1"]]) expect(actionOf(m, p)).toBeNull();
  });

  it("refuses an action on an object that is not the run's, before the daemon sees it; passes one on the run's (its Compose project or RUN_LABEL)", async () => {
    const x = await proxy({
      "/containers/owner-db/json": { Name: "/owner-db", Config: { Labels: { "com.docker.compose.project": "owner" } } },
      "/containers/mine/json": { Name: "/mine", Config: { Labels: { [RUN_LABEL]: P } } },
      "/containers/db/json": { Name: `/${P}-db-1`, Config: { Labels: { "com.docker.compose.project": P } } },
      "/volumes/owner_pgdata": { Name: "owner_pgdata", Labels: {} },
    });
    const no = await ask(x.listen, req("POST", "/v1.47/containers/owner-db/exec", '{"Cmd":["psql"]}'));
    expect(no).toMatch(/^HTTP\/1.1 403 /);
    expect(JSON.parse(no.slice(no.indexOf("\r\n\r\n") + 4)).message).toBe(`sapu: refused: docker exec on container owner-db, which is not this run's (Compose project ${P}); the journey's instance may touch only its own containers, volumes and networks`);
    expect(await ask(x.listen, req("DELETE", "/v1.47/volumes/owner_pgdata"))).toMatch(/^HTTP\/1.1 403 [\s\S]*docker rm on volume owner_pgdata/);
    expect(await ask(x.listen, req("POST", "/v1.47/containers/prune"))).toMatch(/^HTTP\/1.1 403 [\s\S]*reaches every container on this machine/);
    expect(await ask(x.listen, req("POST", "/v1.47/build/prune"))).toMatch(/^HTTP\/1.1 403 [\s\S]*docker builder prune reaches every build cache entry/);
    expect(await ask(x.listen, req("POST", "/v4.0.0/libpod/containers/owner-db/start"))).toMatch(/^HTTP\/1.1 403 [\s\S]*the libpod API cannot be judged/);
    expect(x.seen).toEqual([]);
    for (const id of ["mine", "db"]) expect(await ask(x.listen, req("POST", `/v1.47/containers/${id}/stop`))).toMatch(/^HTTP\/1.1 200 /);
    // One the daemon does not know is the daemon's to answer.
    expect(await ask(x.listen, req("POST", "/v1.47/containers/gone/kill"))).toMatch(/^HTTP\/1.1 200 /);
    expect(x.seen.map((s) => s.head.split("\r\n")[0])).toEqual(["POST /v1.47/containers/mine/stop HTTP/1.1", "POST /v1.47/containers/db/stop HTTP/1.1", "POST /v1.47/containers/gone/kill HTTP/1.1"]);
    expect(x.log().map((l) => `${l.m} ${l.p} ${l.v}`)).toEqual(["POST /containers/owner-db/exec refused", "DELETE /volumes/owner_pgdata refused", "POST /containers/prune refused", "POST /build/prune refused", "POST /libpod/containers/owner-db/start refused", "POST /containers/mine/stop passed", "POST /containers/db/stop passed", "POST /containers/gone/kill passed"]);
  });

  it("judges a request as the daemon routes it: a %-encoded id is decoded once, an absolute-form or undecodable target refused, an Upgrade only where the daemon hijacks", async () => {
    const x = await proxy({ "/containers/owner/json": { Name: "/owner", Config: { Labels: {} } } });
    expect(await ask(x.listen, req("POST", "/v1.47/containers/%6Fwner/stop"))).toMatch(/^HTTP\/1.1 403 [\s\S]*docker stop on container owner/);
    expect(await ask(x.listen, req("POST", "http://docker/v1.47/containers/owner/stop"))).toMatch(/^HTTP\/1.1 400 [\s\S]*only an origin-form path/);
    expect(await ask(x.listen, req("POST", "/v1.47/containers/%E0%A4/stop"))).toMatch(/^HTTP\/1.1 400 /);
    expect(await ask(x.listen, req("POST", "/v1.47/containers/a%2Fb/stop"))).toMatch(/^HTTP\/1.1 400 /);
    // An Upgrade on a request that does not hijack is stripped: one request per connection, the smuggled one never sent.
    await ask(x.listen, req("GET", "/_ping", "", "Upgrade: tcp\r\n").replace("Connection: keep-alive", "Connection: Upgrade") + req("POST", "/containers/owner/stop"));
    expect(x.seen.map((r) => r.head.split("\r\n")[0])).toEqual(["GET /_ping HTTP/1.1"]);
    expect(x.seen[0].head).not.toMatch(/upgrade/i);
    expect(x.seen[0].head).toMatch(/\r\nConnection: close$/);
  });

  it("a commit of, or a network connect of, a container that is not the run's is refused; what another made during the cycle is its own", async () => {
    const recent = new Date(Date.now() + 60_000).toISOString();
    const x = await proxy({
      "/containers/owner/json": { Name: "/owner", Created: "2020-01-01T00:00:00Z", Config: { Labels: {} } },
      "/containers/side/json": { Name: "/side", Created: recent, Config: { Labels: {} } },
      "/volumes/cache": { Name: "cache", CreatedAt: recent, Labels: {} },
    });
    expect(await ask(x.listen, req("POST", "/v1.47/commit?container=owner&pause=1"))).toMatch(/^HTTP\/1.1 403 [\s\S]*docker commit on container owner/);
    expect(await ask(x.listen, req("POST", `/v1.47/networks/${P}_default/connect`, '{"Container":"owner"}'))).toMatch(/^HTTP\/1.1 403 [\s\S]*docker network connect of container owner, which is not this run's/);
    expect(x.seen).toEqual([]);
    expect(await ask(x.listen, req("POST", `/v1.47/networks/${P}_default/connect`, '{"Container":"side"}'))).toMatch(/^HTTP\/1.1 200 /);
    expect(await ask(x.listen, req("DELETE", "/v1.47/volumes/cache"))).toMatch(/^HTTP\/1.1 200 /);
    expect(await ask(x.listen, req("POST", "/v1.47/containers/side/stop"))).toMatch(/^HTTP\/1.1 200 /);
    expect(JSON.parse(x.seen[0].body)).toEqual({ Container: "side" });
  });

  it("labels what it creates (its body rewritten, Content-Length with it) and forces one request per connection", async () => {
    const x = await proxy();
    const body = JSON.stringify({ Image: "alpine:3", Labels: { keep: "1" }, Cmd: ["echo", "é"] });
    expect(await ask(x.listen, req("POST", "/v1.47/containers/create?name=a", body))).toMatch(/^HTTP\/1.1 200 /);
    expect(await ask(x.listen, req("POST", "/v1.47/volumes/create", "{}"))).toMatch(/^HTTP\/1.1 200 /);
    const [c, v] = x.seen;
    expect(JSON.parse(c.body)).toEqual({ Image: "alpine:3", Labels: { keep: "1", [RUN_LABEL]: P }, Cmd: ["echo", "é"] });
    expect(Number(/Content-Length: (\d+)/.exec(c.head)?.[1])).toBe(Buffer.byteLength(c.body));
    expect(c.head).toMatch(/\r\nConnection: close$/);
    expect(c.head).not.toMatch(/keep-alive/);
    expect(JSON.parse(v.body)).toEqual({ Labels: { [RUN_LABEL]: P } });
    expect(await ask(x.listen, req("POST", "/v1.47/networks/create", "", "Transfer-Encoding: chunked\r\n"))).toMatch(/^HTTP\/1.1 411 [\s\S]*without a Content-Length/);
    expect(await ask(x.listen, req("POST", "/v1.47/containers/create", "[1]"))).toMatch(/^HTTP\/1.1 400 [\s\S]*not a JSON object/);
    expect(x.seen.length).toBe(2);
  });

  it("an upgrade (exec start) keeps its body and its Connection header, and streams back", async () => {
    const x = await proxy();
    const out = await ask(x.listen, req("POST", "/v1.47/exec/e1/start", '{"Detach":false}', "Upgrade: tcp\r\n").replace("Connection: keep-alive", "Connection: Upgrade"));
    expect(out).toMatch(/^HTTP\/1.1 101 [\s\S]*stream:\{"Detach":false\}$/);
    expect(x.seen[0].head).toMatch(/Connection: Upgrade/);
  });

  it("a daemon that does not answer is reported as the CLI words it, so the gate reads it as no daemon", async () => {
    const x = await proxy();
    servers[0].close();
    rmSync(join(x.dir, "d.sock"), { force: true });
    expect(await ask(x.listen, req("GET", "/v1.47/containers/json"))).toMatch(/^HTTP\/1.1 502 [\s\S]*Cannot connect to the Docker daemon at unix:\/\/.*d\.sock\. Is the docker daemon running\?/);
  });

  it("a container create that takes from what is not the run's is refused before it exists; the host's namespaces always; the run's own pass", async () => {
    const x = await proxy({
      "/containers/owner-db/json": { Name: "/owner-db", Config: { Labels: {} } },
      "/containers/mine/json": { Name: "/mine", Config: { Labels: { [RUN_LABEL]: P } } },
      "/volumes/owner_pgdata": { Name: "owner_pgdata", Labels: {} },
      [`/volumes/${P}_data`]: { Name: `${P}_data`, Labels: { "com.docker.compose.project": P } },
      "/networks/owner_default": { Name: "owner_default", Labels: {} },
    });
    const create = (HostConfig: Obj, extra: Obj = {}) => ask(x.listen, req("POST", "/v1.47/containers/create", JSON.stringify({ Image: "alpine", HostConfig, ...extra })));
    for (const [hc, extra, why] of [
      [{ NetworkMode: "container:owner-db" }, {}, "shares the NetworkMode of container owner-db"],
      [{ PidMode: "container:owner-db" }, {}, "shares the PidMode of container owner-db"],
      [{ VolumesFrom: ["owner-db:ro"] }, {}, "takes the volumes of container owner-db"],
      [{ Binds: ["owner_pgdata:/var/lib/postgresql/data"] }, {}, "mounts volume owner_pgdata"],
      [{ Mounts: [{ Type: "volume", Source: "owner_pgdata", Target: "/d" }] }, {}, "mounts volume owner_pgdata"],
      [{ NetworkMode: "owner_default" }, {}, "joins network owner_default"],
      [{}, { NetworkingConfig: { EndpointsConfig: { owner_default: {} } } }, "joins network owner_default"],
    ] as [Obj, Obj, string][]) expect(await create(hc, extra), why).toMatch(new RegExp(`^HTTP/1.1 403 [\\s\\S]*a container that ${why}, which is not this run's`));
    expect(await create({ NetworkMode: "host" })).toMatch(/^HTTP\/1.1 403 [\s\S]*uses the host's Network namespace/);
    expect(x.seen).toEqual([]);
    for (const hc of [{ NetworkMode: "container:mine", Binds: [`${P}_data:/d`, "/tmp/x:/x", "fresh_vol:/f"] }, { NetworkMode: "bridge" }, {}]) expect(await create(hc)).toMatch(/^HTTP\/1.1 200 /);
    expect(x.seen.length).toBe(3);
    expect(reachesOf({ HostConfig: { NetworkMode: "default", Binds: ["/abs:/x"] } })).toEqual([]);
  });

  it("viaDaemon: a stop runs against the daemon's socket once the run's proxy no longer runs (its socket file left or not); dropProxySocket removes what is left", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sapu-docker-"));
    dirs.push(dir);
    const sock = join(dir, "docker.sock");
    writeFileSync(sock, "");
    const p = spawn("sleep", ["600"], { detached: true, stdio: "ignore" });
    p.unref();
    const g = { name: "docker-proxy", internal: true, pgid: p.pid!, started: startTime(p.pid!) };
    const rec = { dockerUpstream: "unix:///var/run/docker.sock", env: { DOCKER_HOST: `unix://${sock}` }, groups: [g] };
    const stop = { name: "down", env: { DOCKER_HOST: `unix://${sock}`, COMPOSE_PROJECT_NAME: P } };
    expect(viaDaemon(stop, rec).env.DOCKER_HOST).toBe(`unix://${sock}`);
    process.kill(-g.pgid, "SIGKILL");
    for (let i = 0; i < 50 && existsSync(`/proc/${g.pgid}`); i++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 200));
    expect(viaDaemon(stop, rec).env).toEqual({ DOCKER_HOST: "unix:///var/run/docker.sock", COMPOSE_PROJECT_NAME: P });
    expect(viaDaemon(stop, { ...rec, dockerUpstream: undefined }).env.DOCKER_HOST).toBe(`unix://${sock}`);
    dropProxySocket(rec);
    expect(existsSync(dir)).toBe(false);
  });
});
