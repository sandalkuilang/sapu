// The run's Docker socket proxy (argus-live-dockerproxy.mjs) against a fake daemon on a unix socket: no Docker needed.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, connect, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { actionOf, RUN_LABEL, serve, viaDaemon } from "../plugins/sapu/scripts/argus-live-dockerproxy.mjs";

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
    expect(actionOf("POST", "/containers/db/exec")).toEqual({ kind: "containers", id: "db", verb: "exec" });
    expect(actionOf("DELETE", "/containers/db")).toEqual({ kind: "containers", id: "db", verb: "rm" });
    expect(actionOf("PUT", "/containers/db/archive")).toEqual({ kind: "containers", id: "db", verb: "cp into" });
    expect(actionOf("HEAD", "/containers/db/archive")).toEqual({ kind: "containers", id: "db", verb: "cp out of" });
    expect(actionOf("DELETE", "/volumes/pg%20data")).toEqual({ kind: "volumes", id: "pg data", verb: "rm" });
    expect(actionOf("POST", "/networks/n1/connect")).toEqual({ kind: "networks", id: "n1", verb: "connect" });
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
    expect(x.seen).toEqual([]);
    for (const id of ["mine", "db"]) expect(await ask(x.listen, req("POST", `/v1.47/containers/${id}/stop`))).toMatch(/^HTTP\/1.1 200 /);
    // One the daemon does not know is the daemon's to answer.
    expect(await ask(x.listen, req("POST", "/v1.47/containers/gone/kill"))).toMatch(/^HTTP\/1.1 200 /);
    expect(x.seen.map((s) => s.head.split("\r\n")[0])).toEqual(["POST /v1.47/containers/mine/stop HTTP/1.1", "POST /v1.47/containers/db/stop HTTP/1.1", "POST /v1.47/containers/gone/kill HTTP/1.1"]);
    expect(x.log().map((l) => `${l.m} ${l.p} ${l.v}`)).toEqual(["POST /containers/owner-db/exec refused", "DELETE /volumes/owner_pgdata refused", "POST /containers/prune refused", "POST /containers/mine/stop passed", "POST /containers/db/stop passed", "POST /containers/gone/kill passed"]);
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

  it("viaDaemon: a stop whose proxy socket is gone runs against the daemon's socket; any other stays as it is", () => {
    const dir = mkdtempSync(join(tmpdir(), "dp-"));
    dirs.push(dir);
    const live = join(dir, "docker.sock");
    writeFileSync(live, "");
    const rec = { dockerUpstream: "unix:///var/run/docker.sock" };
    const stop = (host: string) => ({ name: "down", env: { DOCKER_HOST: host, COMPOSE_PROJECT_NAME: P } });
    expect(viaDaemon(stop(`unix://${join(dir, "gone.sock")}`), rec).env).toEqual({ DOCKER_HOST: "unix:///var/run/docker.sock", COMPOSE_PROJECT_NAME: P });
    expect(existsSync(live) && viaDaemon(stop(`unix://${live}`), rec).env.DOCKER_HOST).toBe(`unix://${live}`);
    expect(viaDaemon(stop(`unix://${join(dir, "gone.sock")}`), {}).env.DOCKER_HOST).toBe(`unix://${join(dir, "gone.sock")}`);
  });
});
