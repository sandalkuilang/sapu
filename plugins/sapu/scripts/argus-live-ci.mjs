// argus-live-ci.mjs — the suite's CI runs read back (spec §19.8, §19.9): `smoke ci` triages a run's results
// (flake, UI change, bug, browser-only, check, visual) and stages quarantines; `smoke baseline` adopts CI's
// screenshots, ARIA snapshots and known violations as a proposal. Artifact text is untrusted: read by name and
// shape, and fenced.

/** `smoke ci [--run <id>]` → `{code, lines}`: one triage line per failing test (`run` null: the newest run). */
export function smokeCi(main, { run }) {
  throw new Error("refused: smoke ci: not built yet");
}

/** `smoke baseline --from-run <id> [--ids <id>,…]` → `{code, lines}`: what was staged from that run's artifact (`ids` null: every journey). */
export function smokeBaseline(main, { fromRun, ids }) {
  throw new Error("refused: smoke baseline: not built yet");
}
