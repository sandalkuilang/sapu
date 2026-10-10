#!/usr/bin/env node
// argus-live.mjs — the journey lane's live instance (spec §8), as a command run in the repo.
//   argus-live.mjs up            start an isolated instance (one line per step, then its summary as
//                                one line of JSON: runId, instanceId, deadline, baseUrl, origins,
//                                ports, worktree — all the orchestrator reads, never run.json)
//   argus-live.mjs up --fresh    restart its entries on a reset store (between repro runs); the same
//                                summary last
//   argus-live.mjs up --map      map mode (decision 20): the lock and a worktree at HEAD, nothing started (no
//                                setup, store, app, proxy, HOME or logins); its summary {runId, mode, deadline,
//                                worktree} last. up --fresh and renew refuse it
//   argus-live.mjs check         verify .argus/live.json as up would before it touches anything (configProblems:
//                                the schema, every unset ${NAME} by name, base URLs resolving to loopback only, a services
//                                variable the instance env does not set, a protected store, a literal password or TOTP
//                                secret, a tracked env_file), and that the contract's guard.envFiles
//                                covers its env_file (as the guard matches it): one refused: … line per fault (exit
//                                1), else live: ok — <r> roles, <a> accounts, <s> start entries. Reads the working
//                                tree's contract (an init draft); takes no lock, starts and writes nothing, prints
//                                no value
//   argus-live.mjs show          the browser CLI's dashboard on the running cycle's sessions, for an owner who
//                                wants to watch (showDashboard): its URL printed, blocking until Ctrl-C; refused:
//                                no journey cycle is running without a cycle whose browser is up, and on a lock past
//                                its deadline; a missing run directory is named. SIGINT, SIGTERM and SIGHUP end the
//                                CLI's whole process group (its dashboard too). Writes nothing
//   argus-live.mjs renew         move the cycle's deadline; the egress check and the Docker runtime gate again
//   argus-live.mjs down          tear the running cycle's instance down
//   argus-live.mjs status        the running cycle, its instance, each process group, each slot (journey,
//                                generation, calls, submitted, retired) and the number of browser sessions
//   argus-live.mjs status --json the running cycle's summary, as up prints it, and `slots`, each slot's
//                                {journey, generation, calls, max, submitted, retired} (fields null when none);
//                                stale: true once the lock's deadline passed (the next up takes it over)
//   argus-live.mjs reap <runId>  internal: the reaper `up` starts; runs `down` at the lock's deadline
//                                unless `renew` moved it, and exits without acting when the lock names
//                                another run
//   argus-live.mjs slot <n> --journey <id> --accounts <role>.<k>=<user>|<role>.<k>,…
//                                mint slot <n>'s token for an explorer: one line of JSON {slot, token,
//                                generation, journey, accounts} (the only place a token is printed)
//   argus-live.mjs slot <n> --map [--seed]
//                                mint map slot <n>'s token, in any run with a worktree (a map run, or an up still
//                                starting): {slot, token, generation, mode}; it takes only pw <token> code and submit
//                                (--seed: a seed map slot, whose token also takes pw <token> source; spec §19.12)
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
//                                stopped fixpoint|budget|down|deadline, confirmed yes|no; min.json when
//                                confirmed; exit 2 when the cycle went down or its deadline came too near
//   argus-live.mjs repro <slot>.<generation>.<k> --test
//                                write the candidate's Playwright RED test (from min.json when minimize confirmed
//                                it, else its whole repro) to red.spec.ts in its records: red test: <absolute path>;
//                                refused unless its verdict.json says reproduced (two of two)
//   argus-live.mjs repro <slot>.<generation>.<k> --saved
//                                the values the candidate's reproducing run read (`save`), as scrub would let them
//                                leave: saved <name>: <JSON string>, or *** (<class>) for one holding a secret
//   argus-live.mjs classify --oracle <o> [--money] [--stock] [--moved-twice] [--acted-on] [--rule]
//                                a journey finding's class, labels and starting severity (spec §10's table):
//                                class <A|B(a)|heuristic> labels <l>,… severity <…> because <words>
//   argus-live.mjs scrub (--run <runId> | --ref <slot>.<generation>.<k> | both) --title <t> --body <file> [--attach <png>…]
//                   [--create [--label <l>…] | --comment <n>]
//                                the last check before an issue is filed (spec §10 "Scrub"), against the run named
//                                (--ref: the run whose candidate reproduced two of two; refused otherwise, and for a
//                                map run or a run whose ledger is gone, incomplete or damaged): a secret the run saw
//                                or the configuration holds, in any encoding, refuses it — one <title|body>
//                                <line>:<col> <class> or label <i> <class> line per hit, never the value (exit 1,
//                                no gh run); else long tokens the run never saw redacted, mentions, references and
//                                outside links defanged: scrub: ok; redacted <n>, defanged <n>, cut <n> line(s) and
//                                title: …; each screenshot attach: <name> or local: <name> (<reason>) (its verdict,
//                                gh, the repo, the policy), the local ones in a Local evidence: line; the body file
//                                rewritten; with --create or --comment, filed through gh: filed|commented: <url>
//                                (exit 0, whatever gh's exit), or failed: … before printing an issue URL (exit 2)
//   argus-live.mjs map-check [--list]
//                                keep only the journeys of .argus/journeys.json whose every step is anchored in
//                                HEAD's code (spec §6), rewriting it: dropped <id>: <reason> per journey dropped
//                                now, catalog: <n> journeys, <k> dropped[, roles unchecked], refresh: <reason>; …
//                                or refresh: none; with --list the catalog after them; exit 1 refused: no journey
//                                is selectable when none is kept. Takes no lock and starts nothing
//   argus-live.mjs map-check --merge <slot>
//                                merge the newest map map slot <slot> returned (the lock's run, else the newest run
//                                directory) into .argus/journeys.json, stamped with the commit that run's worktree
//                                was built at (after down too), then map-check as above
//   argus-live.mjs select --cycle <n> [--flagged <id>,…] [--ids <id>,…]
//                                SELECT (spec §6): the journeys ranked by score for argus's cycle <n> (--flagged: the
//                                ids the newest momus report flagged), or the --ids given, in order: select <id>
//                                score <s> accounts <the list slot --accounts takes>, wait <id> score <s> (<why>),
//                                displaced <id> score <s>; exit 1 refused: no journey is selectable with no pick
//   argus-live.mjs visit <journeyId> --cycle <n> [--filed <issue url>…]
//                                PERSIST (spec §6): the journey's lastCycle <n>, lastHead HEAD's commit and the URLs
//                                filed added to its filed, written into .argus/journeys.json (never edited by hand):
//                                visited <id>: last cycle <n>, last head <sha12>, filed <k>
//   argus-live.mjs drift --doc <file>:<a>-<b> --code <file>:<a>-<b> [--code …]
//                                doc drift (spec §5) by the lines' newest author time: code-newer → needs-owner,
//                                doc-newer → class B(a), or undecidable (<why>) → needs-owner
//   argus-live.mjs proxy <runId> internal: the run's filtering proxy `up` starts; exits once the lock
//                                names another run
// The smoke suite's verbs (spec §19.15), all the orchestrator's but smoke check (a read: it writes nothing).
// Each is its lane's function, returning {code, lines[, masked]}: the lines printed (masked with the env
// file's values unless the function masked them itself, masked: true), the code the exit. Every smoke verb
// but check needs the repo's own committed contract with traces "visible" (spec §19.2):
//   argus-live.mjs smoke plan    the catalog ranked into the suite's members (-suite.mjs smokePlan)
//   argus-live.mjs smoke admit <slot>.<generation>
//                                stage the return's path once it held fresh and dirty (-suite.mjs smokeAdmit)
//   argus-live.mjs smoke run [--ids <id>,…] [--slot <n>] [--perf] [--seed <n>]
//                                the lane's pass over the suite's paths (-smoke.mjs smokeRun)
//   argus-live.mjs smoke heal <slot>.<generation>
//                                a heal-mode return judged by the decision table (-heal.mjs smokeHeal)
//   argus-live.mjs smoke propose [--dry-run]
//                                the staged changes as a pull request (-propose.mjs smokePropose)
//   argus-live.mjs smoke check   every hand-edited or stale suite file named; writes nothing (-suite.mjs smokeCheck)
//   argus-live.mjs smoke ci [--run <id>]
//                                a CI run triaged, flakes quarantined (-ci.mjs smokeCi)
//   argus-live.mjs smoke baseline --from-run <id> [--ids …]
//                                CI's screenshots, ARIA snapshots and violations adopted (-baseline.mjs smokeBaseline)
//   argus-live.mjs smoke perf (--issue|--rebaseline) <id>
//                                a perf issue's body, or a moved baseline (-perf.mjs perfIssue, perfRebaseline)
//   argus-live.mjs smoke workflow
//                                the CI workflow init writes (-propose.mjs smokeWorkflow)
//   argus-live.mjs seed (--issue <n>|--doc <file>:<a>-<b>)
//                                a seed map slot's source text (-seed.mjs seed)
//   argus-live.mjs report [--run <runId>]
//                                the cycle's scrubbed report (-report.mjs report)
// Exit codes: 0 ok, 1 refused (the reason printed), 2 failed (the step and the error printed). No
// output carries a value of the env file, as it is now or as `up` read it: every line is masked with both.
import fs from "node:fs";
import path from "node:path";
import { smokeBaseline } from "./argus-live-baseline.mjs";
import { smokeCi } from "./argus-live-ci.mjs";
import { classify } from "./argus-live-classes.mjs";
import { showDashboard } from "./argus-live-cli.mjs";
import { loadLive } from "./argus-live-config.mjs";
import { drift } from "./argus-live-drift.mjs";
import { catalog, mapCheck, mergeMap, readJourneys, refreshReasons, selectJourneys, visitJourney, writeJourneys } from "./argus-live-map.mjs";
import { smokeHeal } from "./argus-live-heal.mjs";
import { configProblems, guardsEnvFile, renewRun, status, statusJson, up, upMap } from "./argus-live-instance.mjs";
import { liveDir, readLock } from "./argus-live-lock.mjs";
import { perfIssue, perfRebaseline } from "./argus-live-perf.mjs";
import { redact, run } from "./argus-live-proc.mjs";
import { smokePropose, smokeWorkflow } from "./argus-live-propose.mjs";
import { serveProxy } from "./argus-live-proxy.mjs";
import { pw } from "./argus-live-pw.mjs";
import { report } from "./argus-live-report.mjs";
import { minimize, redTestFile, savedValues } from "./argus-live-minimize.mjs";
import { apiLevelHint, repro, runOnce } from "./argus-live-repro.mjs";
import { intake, mapReturn } from "./argus-live-return.mjs";
import { browserHome, down, readRun, reap, recordedSecrets } from "./argus-live-run.mjs";
import { scrub } from "./argus-live-scrub.mjs";
import { seed, seedsOf } from "./argus-live-seed.mjs";
import { drainSessions } from "./argus-live-session.mjs";
import { handoffSlot, mintMapSlot, mintSlot, parseAccounts } from "./argus-live-slots.mjs";
import { smokeRun } from "./argus-live-smoke.mjs";
import { smokeAdmit, smokeCheck, smokePlan } from "./argus-live-suite.mjs";
import { findMain, loadContract, needsOwnerLabel, resolvePolicy } from "./sapu-contract.mjs";

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
const usage = "usage: argus-live.mjs up [--fresh|--map] | check | show | renew | down | status [--json] | slot <n> --journey <id> --accounts <list> | slot <n> --handoff | slot <n> --map [--seed] | pw <token> … | intake <n> | repro <slot>.<generation>.<k> [--once|--minimize|--test|--saved] | classify --oracle <o> [--money] [--stock] [--moved-twice] [--acted-on] [--rule] | scrub (--run <runId> | --ref <slot>.<generation>.<k> | both) --title <t> --body <file> [--attach <png>…] [--create [--label <l>…] | --comment <n>] | map-check [--list|--merge <slot>] | select --cycle <n> [--flagged <id>,…] [--ids <id>,…] | visit <journeyId> --cycle <n> [--filed <url>…] | drift --doc <file>:<a>-<b> --code <file>:<a>-<b> [--code …] | smoke plan | smoke admit <slot>.<generation> | smoke run [--ids <id>,…] [--slot <n>] [--perf] [--seed <n>] | smoke heal <slot>.<generation> | smoke propose [--dry-run] | smoke check | smoke ci [--run <id>] | smoke baseline --from-run <id> [--ids …] | smoke perf (--issue|--rebaseline) <id> | smoke workflow | seed (--issue <n>|--doc <file>:<a>-<b>) | report [--run <runId>]";
/** classify's flags → classify's facts. */
const CLASSIFY_FLAGS = { "--money": "money", "--stock": "stock", "--moved-twice": "movedTwice", "--acted-on": "actedOn", "--rule": "rule" };
/** Journey ids, comma-separated. */
const IDS = /^[a-z0-9]+(-[a-z0-9]+)*(,[a-z0-9]+(-[a-z0-9]+)*)*$/;
const refuseUsage = () => {
  throw new Error(`refused: ${usage}`);
};
/** A flag's value read by its kind (a bare flag is "flag"); a malformed one refused. */
const VALUES = {
  ids: (v) => (IDS.test(v) ? v.split(",") : refuseUsage()),
  slot: (v) => (/^[1-9][0-9]?$/.test(v) ? Number(v) : refuseWith("a slot is a number from 1 to 99")),
  seed: (v) => (/^(0|[1-9][0-9]{0,9})$/.test(v) && Number(v) <= 0xffffffff ? Number(v) : refuseWith("a seed is an integer from 0 to 4294967295")),
  issue: (v) => (/^[1-9][0-9]{0,9}$/.test(v) ? Number(v) : refuseUsage()),
  text: (v) => v,
};
function refuseWith(why) {
  throw new Error(`refused: ${why}`);
}
/** `words` read as flags of `spec` ({flag: kind}), each at most once → {flag: value}; anything else refused with the usage. */
function options(words, spec) {
  const out = {};
  for (let i = 0; i < words.length; i++) {
    const f = words[i];
    const kind = Object.hasOwn(spec, f) && !Object.hasOwn(out, f) ? spec[f] : null;
    if (kind === "flag") out[f] = true;
    else if (kind && i + 1 < words.length) out[f] = VALUES[kind](words[++i]);
    else refuseUsage();
  }
  return out;
}

/** Spec §19.2: a committed suite is a trace in the repo, so it needs the repo's own contract with traces "visible". */
function smokeGate() {
  const c = loadContract(main);
  if (!c.contract && !c.missing) throw new Error(`refused: ${c.error}`);
  if (!c.contract || c.home?.mode === "local" || resolvePolicy(c.contract).traces !== "visible") throw new Error("refused: smoke: a committed suite would leave a trace");
}

/**
 * `smoke <verb> …`, `seed …` or `report …` → its lane's `{code, lines[, masked]}`. The line is read whole
 * first: a malformed one is refused with the usage before the trace gate or any lane runs.
 */
async function laneCommand(cmd, args) {
  if (cmd === "seed") {
    const f = options(args, { "--issue": "issue", "--doc": "text" });
    if ((f["--issue"] === undefined) === (f["--doc"] === undefined)) refuseUsage();
    return seed(main, { issue: f["--issue"] ?? null, doc: f["--doc"] ?? null });
  }
  if (cmd === "report") return report(main, { run: options(args, { "--run": "text" })["--run"] ?? null });
  const [verb, ...rest] = args;
  const o = (spec) => options(rest, spec);
  let call;
  if (verb === "check" && !rest.length) return smokeCheck(main);
  if (verb === "plan" && !rest.length) call = () => smokePlan(main);
  else if (verb === "admit" && rest.length === 1) call = () => smokeAdmit(main, rest[0]);
  else if (verb === "heal" && rest.length === 1) call = () => smokeHeal(main, rest[0]);
  else if (verb === "run") {
    const f = o({ "--ids": "ids", "--slot": "slot", "--perf": "flag", "--seed": "seed" });
    call = () => smokeRun(main, { ids: f["--ids"] ?? null, slot: f["--slot"] ?? null, perf: Boolean(f["--perf"]), seed: f["--seed"] ?? null });
  } else if (verb === "propose") {
    const f = o({ "--dry-run": "flag" });
    call = () => smokePropose(main, { dryRun: Boolean(f["--dry-run"]) });
  } else if (verb === "ci") {
    const f = o({ "--run": "text" });
    call = () => smokeCi(main, { run: f["--run"] ?? null });
  } else if (verb === "baseline") {
    const f = o({ "--from-run": "text", "--ids": "ids" });
    if (f["--from-run"] === undefined) refuseUsage();
    call = () => smokeBaseline(main, { fromRun: f["--from-run"], ids: f["--ids"] ?? null });
  } else if (verb === "perf" && rest.length === 2 && rest[0] === "--issue") call = () => perfIssue(main, rest[1]);
  else if (verb === "perf" && rest.length === 2 && rest[0] === "--rebaseline") call = () => perfRebaseline(main, rest[1]);
  else if (verb === "workflow" && !rest.length) call = () => smokeWorkflow(main);
  else refuseUsage();
  smokeGate();
  return call();
}

try {
  // down and the reaper drain every session into the run's secret ledger before they close it.
  if (cmd === "reap" && args.length === 1) await reap(main, args[0], { drain: (records, o) => drainSessions(main, args[0], records, o) });
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
      if (args[i] === "--handoff" && !opts.handoff) opts.handoff = true;
      else if (args[i] === "--map" && !opts.map) opts.map = true;
      else if (args[i] === "--seed" && !opts.seed) opts.seed = true;
      else if ((args[i] === "--journey" || args[i] === "--accounts") && i + 1 < args.length && !Object.hasOwn(opts, args[i])) opts[args[i]] = args[++i];
      else throw new Error(`refused: ${usage}`);
    }
    if (Number.isNaN(n)) throw new Error("refused: a slot is a number from 1 to 99");
    if (opts.map && Object.keys(opts).length === 1 + (opts.seed ? 1 : 0)) printMasked(JSON.stringify(await mintMapSlot(main, { slot: n, seed: Boolean(opts.seed) })));
    else if (opts.handoff && Object.keys(opts).length === 1) printMasked(JSON.stringify(await handoffSlot(main, n)));
    else if (!opts.handoff && !opts.map && opts["--journey"] !== undefined && opts["--accounts"] !== undefined) printMasked(JSON.stringify(await mintSlot(main, { slot: n, journey: opts["--journey"], accounts: parseAccounts(opts["--accounts"]) })));
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
    const r = await minimize(main, args[0], { say: print });
    process.exit(r.code);
  } else if (cmd === "repro" && args.length === 2 && args[1] === "--test") {
    print(`red test: ${redTestFile(main, args[0])}`);
    const hint = apiLevelHint(main, args[0]);
    if (hint !== null) print(hint);
  }
  else if (cmd === "repro" && args.length === 2 && args[1] === "--saved") {
    // What the issue may quote of the run's reads: scrub's refusal, or each value as scrub would let it leave.
    const r = savedValues(main, args[0]);
    for (const line of r.out) print(line);
    process.exit(r.code);
  }
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
  } else if (cmd === "scrub") {
    const opts = { attach: [], labels: [] };
    const once = (k) => opts[k] === undefined;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      const value = i + 1 < args.length;
      if ((a === "--run" || a === "--ref") && value && once(a)) opts[a] = args[++i];
      else if (a === "--title" && value && once("title")) opts.title = args[++i];
      else if (a === "--body" && value && once("body")) opts.body = args[++i];
      else if (a === "--attach" && value) opts.attach.push(path.resolve(args[++i]));
      else if (a === "--label" && value && /^[^\s,][^\u0000-\u001f,]{0,49}$/.test(args[i + 1])) opts.labels.push(args[++i]);
      else if (a === "--create" && once("create")) opts.create = true;
      else if (a === "--comment" && value && once("comment") && /^[1-9][0-9]{0,9}$/.test(args[i + 1])) opts.comment = args[++i];
      else throw new Error(`refused: ${usage}`);
    }
    if (opts.title === undefined || opts.body === undefined || (opts.create && opts.comment !== undefined) || (opts.labels.length && !opts.create)) throw new Error(`refused: ${usage}`);
    // Its lines are the wrapper's own: classes and places, never a value (decision 17); gh's output is never printed.
    const r = await scrub(main, { run: opts["--run"] ?? null, ref: opts["--ref"] ?? null, title: opts.title, bodyFile: path.resolve(opts.body), attach: opts.attach, create: Boolean(opts.create), labels: opts.labels, comment: opts.comment ?? null });
    for (const line of r.out) print(line);
    process.exit(r.code);
  } else if (cmd === "map-check" && (args.length === 0 || (args.length === 1 && args[0] === "--list") || (args.length === 2 && args[0] === "--merge"))) {
    if (args[0] === "--merge") {
      if (!/^[1-9][0-9]?$/.test(args[1])) throw new Error("refused: a slot is a number from 1 to 99");
      // The map as the map agent read the code: stamped with its run's worktree commit, never MAIN's HEAD (decision 20).
      const m = mapReturn(main, Number(args[1]));
      writeJourneys(main, mergeMap(readJourneys(main), m.value, { head: m.head, seeds: seedsOf(main, m.runId, Number(args[1])) }));
    }
    const r = mapCheck(main);
    for (const d of r.dropped) print(`dropped ${d.id}: ${d.reason}`);
    print(`catalog: ${r.kept.length} journeys, ${(readJourneys(main)?.dropped ?? []).length} dropped${r.rolesUnchecked ? ", roles unchecked" : ""}`);
    const why = refreshReasons(main, { newDrops: r.newDrops });
    print(`refresh: ${why.length ? why.join("; ") : "none"}`);
    if (args[0] === "--list") for (const line of catalog(main)) print(line);
    if (!r.kept.length) throw new Error("refused: no journey is selectable");
  } else if (cmd === "select") {
    const opts = {};
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "--cycle" && i + 1 < args.length && opts.cycle === undefined && /^[1-9][0-9]{0,8}$/.test(args[i + 1])) opts.cycle = Number(args[++i]);
      else if ((a === "--flagged" || a === "--ids") && i + 1 < args.length && opts[a] === undefined && IDS.test(args[i + 1])) opts[a] = args[++i].split(",");
      else throw new Error(`refused: ${usage}`);
    }
    if (opts.cycle === undefined) throw new Error(`refused: ${usage}`);
    const r = selectJourneys(main, { cycle: opts.cycle, flagged: opts["--flagged"] ?? [], ids: opts["--ids"] ?? null });
    const list = (accounts) => Object.entries(accounts).map(([a, u]) => (u === null ? a : `${a}=${u}`)).join(",");
    for (const p of r.picks) print(`select ${p.id} score ${p.score} accounts ${list(p.accounts)}`);
    for (const w of r.waits) print(`wait ${w.id} score ${w.score} (${w.why})`);
    for (const d of r.displaced) print(`displaced ${d.id} score ${d.score}`);
    if (!r.picks.length) throw new Error("refused: no journey is selectable");
  } else if (cmd === "visit" && args.length >= 1) {
    const opts = { filed: [] };
    for (let i = 1; i < args.length; i++) {
      if (args[i] === "--cycle" && i + 1 < args.length && opts.cycle === undefined && /^[1-9][0-9]{0,8}$/.test(args[i + 1])) opts.cycle = Number(args[++i]);
      else if (args[i] === "--filed" && i + 1 < args.length) opts.filed.push(args[++i]);
      else throw new Error(`refused: ${usage}`);
    }
    if (opts.cycle === undefined) throw new Error(`refused: ${usage}`);
    // lastHead is MAIN's HEAD as the cycle ends: the commit the journey was last explored at, as near as MAIN tells.
    const h = run(["git", "-C", main, "rev-parse", "HEAD"]);
    const head = h.status === 0 ? String(h.stdout).trim() : "";
    const map = readJourneys(main);
    if (!map) throw new Error("refused: visit: there is no .argus/journeys.json");
    const { map: next, journey } = visitJourney(map, args[0], { cycle: opts.cycle, head, filed: opts.filed });
    writeJourneys(main, next);
    print(`visited ${journey.id}: last cycle ${journey.lastCycle}, last head ${journey.lastHead.slice(0, 12)}, filed ${journey.filed.length}`);
  } else if (cmd === "drift") {
    let doc;
    const code = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--doc" && i + 1 < args.length && doc === undefined) doc = args[++i];
      else if (args[i] === "--code" && i + 1 < args.length) code.push(args[++i]);
      else throw new Error(`refused: ${usage}`);
    }
    if (doc === undefined || !code.length) throw new Error(`refused: ${usage}`);
    const r = drift(main, { doc, code });
    print(r.verdict === "doc-newer" ? "doc-newer → class B(a)" : `${r.verdict === "code-newer" ? "code-newer" : `undecidable (${r.why})`} → needs-owner`);
  } else if (cmd === "up" && args.length === 1 && args[0] === "--map") print(JSON.stringify(await upMap(main, { say: print })));
  else if (cmd === "up" && (args.length === 0 || (args.length === 1 && args[0] === "--fresh"))) print(JSON.stringify(await up(main, { fresh: args[0] === "--fresh", say: print })));
  else if (cmd === "check" && !args.length) {
    // up's own configuration checks, against the draft contract in the working tree (init runs check before committing it).
    const c = loadContract(main, { workingTree: true });
    const r = await configProblems(main, { contract: c.contract ?? (c.missing ? null : undefined) });
    const problems = [...r.problems, ...(!c.contract && !c.missing ? [`refused: ${c.error}`] : [])];
    for (const p of problems) process.stderr.write(`${redact(p, secrets)}\n`);
    if (problems.length) process.exit(1);
    const roles = Object.values(r.config.roles);
    const accounts = roles.reduce((n, role) => n + (role.login ? 1 : (role.users ?? []).length), 0);
    print(`live: ok — ${roles.length} roles, ${accounts} accounts, ${r.config.start.length} start entries`);
    // up reads the committed contract: until the draft is committed, up still refuses the env file.
    if (typeof r.config.env_file === "string" && !guardsEnvFile(loadContract(main).contract ?? null, r.config.env_file)) print(`note: the committed contract's guard.envFiles does not hold ${path.basename(r.config.env_file)} yet: up refuses until the contract is committed`);

  } else if (cmd === "show" && !args.length) {
    // The owner's window on the run's browsers: only once up has a browser for them (never a map run's).
    const lock = readLock(main);
    const rec = lock && readRun(main);
    if (!rec || rec.runId !== lock.runId || !rec.browser || typeof rec.browser.js !== "string" || typeof rec.home !== "string") throw new Error("refused: no journey cycle is running");
    if (lock.deadline <= Math.floor(Date.now() / 1000)) throw new Error(`refused: cycle ${lock.runId}'s lock is past its deadline: no journey cycle is running`);
    const cwd = path.join(liveDir(main), lock.runId);
    if (!fs.existsSync(cwd)) throw new Error(`refused: the run's directory ${path.relative(main, cwd)} is missing`);
    process.exit(await showDashboard({ js: rec.browser.js, home: browserHome(rec), cwd }));
  } else if (cmd === "renew" && !args.length) {
    const r = await renewRun(main, { say: print });
    print(`cycle ${r.runId} renewed until ${new Date(r.deadline * 1000).toISOString()}`);
  } else if (cmd === "down" && !args.length) {
    const lock = readLock(main);
    if (!lock) print("no journey cycle is running");
    else {
      const { report } = await down(main, { runId: lock.runId, secrets, drain: (records, o) => drainSessions(main, lock.runId, records, o) });
      for (const line of report) print(line);
      print(`cycle ${lock.runId} is down`);
    }
  } else if (cmd === "smoke" || cmd === "seed" || cmd === "report") {
    const r = await laneCommand(cmd, args);
    for (const line of r.lines) (r.masked === true ? printMasked : print)(line);
    process.exit(r.code);
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
