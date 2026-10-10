// argus-live-smoke.mjs — the lane's own pass over the smoke suite's paths (spec §19.4, §19.9, §19.11):
// `smoke run` runs each path on the live instance in a seeded random order, confirms a break with a second
// run after `up --fresh`, writes a confirmed expectation break as a slot's regression candidate, and with
// `--perf` measures each path against its baseline. Above the repro runner, below the CLI.

/**
 * `smoke run [--ids <id>,…] [--slot <n>] [--perf] [--seed <n>]` → `{code, lines}`: `ids` the journeys to run
 * (null: every suite path), `slot` the slot a confirmed break is written to (null: none), `perf` whether to
 * measure, `seed` the order's seed (null: one drawn and printed).
 */
export function smokeRun(main, { ids, slot, perf, seed }) {
  throw new Error("refused: smoke run: not built yet");
}
