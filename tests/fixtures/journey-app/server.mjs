#!/usr/bin/env node
// tests/fixtures/journey-app/server.mjs — the app the argus-live tests start in place of a repo's
// own (no dependencies).
//   node server.mjs                 listens on 127.0.0.1:$PORT; GET /health → 200; keeps its state
//                                   under $DATA_DIR; connects (and holds the socket) to $CACHE_URL
//                                   (tcp://127.0.0.1:<p>) or, when unset, to 127.0.0.1:46379, the
//                                   "standard local port" an egress check must catch; like a cache
//                                   client, it tries again every 500 ms until it is connected
//   node server.mjs --spawn-child   also starts a sleeping grandchild (its pid in $CHILD_PID_FILE)
//   node server.mjs --which-store   prints basename($DATA_DIR): the store its configuration names
//   node server.mjs --reset         empties $DATA_DIR and writes seed.json; refuses a store whose
//                                   name does not end in _explore
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";

const args = process.argv.slice(2);
const dataDir = process.env.DATA_DIR || "";

if (args.includes("--which-store")) {
  process.stdout.write(`${path.basename(dataDir)}\n`);
  process.exit(0);
}

if (args.includes("--reset")) {
  if (!path.basename(dataDir).endsWith("_explore")) {
    process.stderr.write(`refusing to reset ${path.basename(dataDir) || "(no DATA_DIR)"}: not an _explore store\n`);
    process.exit(2);
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "seed.json"), `${JSON.stringify({ seeded: true })}\n`);
  process.stdout.write("reset\n");
  process.exit(0);
}

if (dataDir) fs.mkdirSync(dataDir, { recursive: true });

if (args.includes("--spawn-child")) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], { stdio: "ignore" });
  if (process.env.CHILD_PID_FILE) fs.writeFileSync(process.env.CHILD_PID_FILE, String(child.pid));
}

const cache = process.env.CACHE_URL ? new URL(process.env.CACHE_URL) : { hostname: "127.0.0.1", port: "46379" };
const connect = () => {
  const socket = net.connect({ host: cache.hostname, port: Number(cache.port) });
  let retried = false;
  const again = () => {
    if (retried) return;
    retried = true;
    setTimeout(connect, 500);
  };
  socket.on("error", again);
  socket.on("close", again);
};
connect();

http
  .createServer((req, res) => {
    res.writeHead(req.url === "/health" ? 200 : 404);
    res.end(req.url === "/health" ? "ok" : "");
  })
  .listen(Number(process.env.PORT), "127.0.0.1", () => process.stdout.write(`listening on ${process.env.PORT}\n`));
