#!/usr/bin/env node
// argus-live.mjs — the journey lane's live instance (spec §8), as a command.
//   argus-live.mjs reap <runId>   internal: the reaper `up` starts; runs `down` at the lock's deadline
//                                 unless `renew` moved it, and exits without acting when the lock
//                                 names another run
// Exit codes: 0 ok, 2 failed (usage, no repository).
import { reap } from "./argus-live-instance.mjs";
import { findMain } from "./sapu-contract.mjs";

const [cmd, ...args] = process.argv.slice(2);
const main = findMain(process.cwd());
if (!main) {
  process.stderr.write("failed: not inside a git repository\n");
  process.exit(2);
}
if (cmd === "reap" && args.length === 1) {
  await reap(main, args[0]);
  process.exit(0);
}
process.stderr.write("usage: argus-live.mjs reap <runId>\n");
process.exit(2);
