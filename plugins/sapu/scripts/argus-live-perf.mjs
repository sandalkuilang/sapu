// argus-live-perf.mjs — performance on the suite's paths (spec §19.11): the in-page observers the session
// hook installs beside the signal script, a batch's medians, the per-journey baselines in .argus/perf.json,
// and the perf issue's body. Below the session driver, so the hook can read its script.

/** `smoke perf --issue <id>` → `{code, lines}`: the perf issue's body (baseline, both batches, thresholds, git log). */
export function perfIssue(main, id) {
  throw new Error("refused: smoke perf: not built yet");
}

/** `smoke perf --rebaseline <id>` → `{code, lines}`: the journey's baseline moved to its newest batch. */
export function perfRebaseline(main, id) {
  throw new Error("refused: smoke perf: not built yet");
}
