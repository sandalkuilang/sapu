#!/usr/bin/env node
// argus-live.mjs — the journey lane's live instance (spec §8), as a command run in the repo.
//   argus-live.mjs up            start an isolated instance (one line per step, then its summary as
//                                one line of JSON: runId, instanceId, deadline, baseUrl, origins,
//                                ports, worktree — all the orchestrator reads, never run.json)
//   argus-live.mjs up --fresh    restart its entries on a reset store (between repro runs); the same
//                                summary last
//   argus-live.mjs renew         move the cycle's deadline; the egress check and the Docker runtime gate again
//   argus-live.mjs down          tear the running cycle's instance down
//   argus-live.mjs status        the running cycle, its instance, each process group, each slot (journey,
//                                generation, calls, submitted, retired) and the number of browser sessions
//   argus-live.mjs status --json the running cycle's summary, as up prints it, and `slots`, each slot's
//                                {journey, generation, calls, max, submitted, retired} (fields null when none)
//   argus-live.mjs reap <runId>  internal: the reaper `up` starts; runs `down` at the lock's deadline
//                                unless `renew` moved it, and exits without acting when the lock names
//                                another run
//   argus-live.mjs slot <n> --journey <id> --accounts <role>.<k>=<user>|<role>.<k>,…
//                                mint slot <n>'s token for an explorer: one line of JSON {slot, token,
//                                generation, journey, accounts} (the only place a token is printed)
//   argus-live.mjs slot <n> --handoff
//                                retire slot <n>'s token and mint the next generation (fresh budget)
//   argus-live.mjs pw <token> <role>[.<k>] <command> [args] | pw <token> <code|trigger|facts|mail|submit> [args]
//                                the explorer's only way into a browser (spec §9): the page's answer in a
//                                nonce fence, then the wrapper's own lines; exit 0 ran, 1 refused or
//                                BUDGET/LOOP/DEADLINE/HARNESS, 2 failed; the token is never printed
//   argus-live.mjs intake <n>    the orchestrator's read of slot <n>'s return: per generation a summary of
//                                enums and counts, then the return whole in a RETURN nonce fence
//   argus-live.mjs repro <slot>.<generation>.<k>
//                                candidate <k>'s repro, two of two (spec §10): run 1, and run 2 only when run 1
//                                reproduced, each run's lines prefixed `run <i> `; the verdict last: REPRODUCED
//                                step=… (exit 3, both runs), NOT REPRODUCED runs=<k>/<n> (exit 0) or HARNESS:
//                                run <i>: … (exit 2); verdict.json in the candidate's records
//   argus-live.mjs repro <slot>.<generation>.<k> --once
//                                one run of candidate <k>'s repro on a fresh instance (spec §10): a line per
//                                step in the wrapper's own words, what the page showed in a nonce fence,
//                                then NOT REPRODUCED (exit 0), REPRODUCED step=… (exit 3) or HARNESS: … (exit 2)
//   argus-live.mjs repro <slot>.<generation>.<k> --minimize
//                                drop one role or step at a time from a reproduced repro, each try a run on a
//                                fresh instance (spec §10 "Minimize"): a line per try (its label and exit), the
//                                confirm run's exit, then minimized <ref>: steps <a> → <b>, runs <k>/<max>,
//                                stopped fixpoint|budget, confirmed yes|no; min.json when confirmed
//   argus-live.mjs repro <slot>.<generation>.<k> --test
//                                write the candidate's Playwright RED test (from min.json when minimize confirmed
//                                it, else its whole repro) to red.spec.ts in its records: red test: <absolute path>
//   argus-live.mjs classify --oracle <o> [--money] [--stock] [--moved-twice] [--acted-on] [--rule]
//                                a journey finding's class, labels and starting severity (spec §10's table):
//                                class <A|B(a)|heuristic> labels <l>,… severity <…> because <words>
//   argus-live.mjs proxy <runId> internal: the run's filtering proxy `up` starts; exits once the lock
//                                names another run
// Exit codes: 0 ok, 1 refused (the reason printed), 2 failed (the step and the error printed). No
// output carries a value of the env file, as it is now or as `up` read it: every line is masked with both.
import { classify } from "./argus-live-classes.mjs";
import { loadLive } from "./argus-live-config.mjs";
import { renewRun, status, statusJson, up } from "./argus-live-instance.mjs";
import { readLock } from "./argus-live-lock.mjs";
import { redact } from "./argus-live-proc.mjs";
import { serveProxy } from "./argus-live-proxy.mjs";
import { pw } from "./argus-live-pw.mjs";
import { minimize, redTestFile, repro, runOnce } from "./argus-live-repro.mjs";
import { intake } from "./argus-live-return.mjs";
import { down, reap, recordedSecrets } from "./argus-live-run.mjs";
import { drainSessions } from "./argus-live-session.mjs";
import { handoffSlot, mintSlot, parseAccounts } from "./argus-live-slots.mjs";
import { findMain, loadContract, needsOwnerLabel } from "./sapu-contract.mjs";

const [cmd, ...args] = process.argv.slice(2);
const main = findMain(process.cwd());
if (!main) {
  process.stderr.write("failed: not inside a git repository\n");
  process.exit(2);
}
// The env_file's values now, and as `up` read them (recorded in run.json): an edited env_file unmasks neither.
const live = loadLive(main);
const secrets = { ...recordedSecrets(main, live.config), ...live.secrets };
const print = (line) => process.stdout.write(`${redact(line, secrets)}\n`);
// Lines already masked where they were made (pw's fence) or holding no secret (a slot's token, ids):
// masking them again would cut a token or a fence's nonce wherever a short secret value happens to occur.
const printMasked = (line) => process.stdout.write(`${line}\n`);
const usage = "usage: argus-live.mjs up [--fresh] | renew | down | status [--json] | slot <n> --journey <id> --accounts <list> | slot <n> --handoff | pw <token> … | intake <n> | repro <slot>.<generation>.<k> [--once|--minimize|--test] | classify --oracle <o> [--money] [--stock] [--moved-twice] [--acted-on] [--rule]";
/** classify's flags → classify's facts. */
const CLASSIFY_FLAGS = { "--money": "money", "--stock": "stock", "--moved-twice": "movedTwice", "--acted-on": "actedOn", "--rule": "rule" };

try {
  // down and the reaper drain every session into the run's secret ledger before they close it.
  if (cmd === "reap" && args.length === 1) await reap(main, args[0], { drain: (records) => drainSessions(main, args[0], records) });
  else if (cmd === "proxy" && args.length === 1) await serveProxy(main, args[0]);
  else if (cmd === "pw") {
    // The explorer's call: its lines (every page byte already fenced and masked), exit 0, 1 or 2 (decision 20).
    const r = await pw(main, args);
    for (const line of r.out) printMasked(line);
    process.exit(r.code);
  } else if (cmd === "slot" && args.length >= 2) {
    const n = /^[1-9][0-9]?$/.test(args[0]) ? Number(args[0]) : NaN;
    const opts = {};
    for (let i = 1; i < args.length; i++) {
      if (args[i] === "--handoff") opts.handoff = true;
      else if ((args[i] === "--journey" || args[i] === "--accounts") && i + 1 < args.length && !Object.hasOwn(opts, args[i])) opts[args[i]] = args[++i];
      else throw new Error(`refused: ${usage}`);
    }
    if (Number.isNaN(n)) throw new Error("refused: a slot is a number from 1 to 99");
    if (opts.handoff && Object.keys(opts).length === 1) printMasked(JSON.stringify(await handoffSlot(main, n)));
    else if (!opts.handoff && opts["--journey"] !== undefined && opts["--accounts"] !== undefined) printMasked(JSON.stringify(await mintSlot(main, { slot: n, journey: opts["--journey"], accounts: parseAccounts(opts["--accounts"]) })));
    else throw new Error(`refused: ${usage}`);
  }
  else if (cmd === "intake" && args.length === 1) {
    if (!/^[1-9][0-9]?$/.test(args[0])) throw new Error("refused: a slot is a number from 1 to 99");
    // The return is fenced and masked as it is printed; masking whole lines again would cut the nonce.
    for (const line of intake(main, Number(args[0]), { secrets })) printMasked(line);
  } else if (cmd === "repro" && args.length === 2 && args[1] === "--once") {
    // Each line is printed as it is made, already in the wrapper's words or fenced and masked (decision 8).
    const r = await runOnce(main, args[0], { say: printMasked });
    process.exit(r.code);
  } else if (cmd === "repro" && args.length === 2 && args[1] === "--minimize") {
    // Only the tried labels and exits: no browser output reaches the orchestrator (spec §10 "Minimize").
    await minimize(main, args[0], { say: print });
  } else if (cmd === "repro" && args.length === 2 && args[1] === "--test") print(`red test: ${redTestFile(main, args[0])}`);
  else if (cmd === "repro" && args.length === 1) {
    // Two of two: each run's lines as they are made, prefixed with the run, then the verdict (decision 9).
    const r = await repro(main, args[0], { say: printMasked });
    process.exit(r.code);
  } else if (cmd === "classify") {
    const facts = {};
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--oracle" && i + 1 < args.length && facts.oracle === undefined) facts.oracle = args[++i];
      else if (Object.hasOwn(CLASSIFY_FLAGS, args[i]) && facts[CLASSIFY_FLAGS[args[i]]] === undefined) facts[CLASSIFY_FLAGS[args[i]]] = true;
      else throw new Error(`refused: ${usage}`);
    }
    if (facts.oracle === undefined) throw new Error(`refused: ${usage}`);
    const c = loadContract(main);
    if (!c.contract && !c.missing) throw new Error(`refused: ${c.error}`);
    const k = classify({ ...facts, needsOwner: needsOwnerLabel(c.contract ?? null) });
    print(`class ${k.cls} labels ${k.labels.join(",")} severity ${k.severity} because ${k.because}`);
  } else if (cmd === "up" && (args.length === 0 || (args.length === 1 && args[0] === "--fresh"))) print(JSON.stringify(await up(main, { fresh: args[0] === "--fresh", say: print })));
  else if (cmd === "renew" && !args.length) {
    const r = await renewRun(main, { say: print });
    print(`cycle ${r.runId} renewed until ${new Date(r.deadline * 1000).toISOString()}`);
  } else if (cmd === "down" && !args.length) {
    const lock = readLock(main);
    if (!lock) print("no journey cycle is running");
    else {
      const { report } = await down(main, { runId: lock.runId, secrets, drain: (records) => drainSessions(main, lock.runId, records) });
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
