#!/usr/bin/env node
// argus-live.mjs — the journey lane's live instance (spec §8), as a command run in the repo.
//   argus-live.mjs up            start an isolated instance (one line per step, then its summary as
//                                one line of JSON: runId, instanceId, deadline, baseUrl, origins,
//                                ports, worktree — all the orchestrator reads, never run.json)
//   argus-live.mjs up --fresh    restart its entries on a reset store (between repro runs); the same
//                                summary last
//   argus-live.mjs renew         move the cycle's deadline; the egress check and the Docker runtime gate again
//   argus-live.mjs down          tear the running cycle's instance down
//   argus-live.mjs status        the running cycle, its instance and each process group
//   argus-live.mjs status --json the running cycle's summary, as up prints it (fields null when none)
//   argus-live.mjs reap <runId>  internal: the reaper `up` starts; runs `down` at the lock's deadline
//                                unless `renew` moved it, and exits without acting when the lock names
//                                another run
// Exit codes: 0 ok, 1 refused (the reason printed), 2 failed (the step and the error printed). No
// output carries a value of the env file: every line is masked with them.
import { loadLive } from "./argus-live-config.mjs";
import { down, readLock, reap, redact, renewRun, status, statusJson, up } from "./argus-live-instance.mjs";
import { findMain } from "./sapu-contract.mjs";

const [cmd, ...args] = process.argv.slice(2);
const main = findMain(process.cwd());
if (!main) {
  process.stderr.write("failed: not inside a git repository\n");
  process.exit(2);
}
const { secrets } = loadLive(main);
const print = (line) => process.stdout.write(`${redact(line, secrets)}\n`);
const usage = "usage: argus-live.mjs up [--fresh] | renew | down | status [--json]";

try {
  if (cmd === "reap" && args.length === 1) await reap(main, args[0]);
  else if (cmd === "up" && (args.length === 0 || (args.length === 1 && args[0] === "--fresh"))) print(JSON.stringify(await up(main, { fresh: args[0] === "--fresh", say: print })));
  else if (cmd === "renew" && !args.length) {
    const r = await renewRun(main, { say: print });
    print(`cycle ${r.runId} renewed until ${new Date(r.deadline * 1000).toISOString()}`);
  } else if (cmd === "down" && !args.length) {
    const lock = readLock(main);
    if (!lock) print("no journey cycle is running");
    else {
      const { report } = await down(main, { runId: lock.runId, secrets });
      for (const line of report) print(line);
      print(`cycle ${lock.runId} is down`);
    }
  } else if (cmd === "status" && !args.length) for (const line of await status(main)) print(line);
  else if (cmd === "status" && args.length === 1 && args[0] === "--json") print(JSON.stringify(statusJson(main)));
  else {
    process.stderr.write(`${usage}\n`);
    process.exit(2);
  }
} catch (e) {
  const msg = redact(`${e.message}${e.step ? ` (up step ${e.step})` : ""}`, secrets);
  process.stderr.write(`${msg}\n`);
  process.exit(/^(refused|cap reached): /.test(e.message) ? 1 : 2);
}
process.exit(0);
