// argus-live-report.mjs — one scrubbed summary per cycle (spec §19.13): `report` writes
// .argus/reports/<runId>.md (0600) from the run's records only, after `down` too, and takes no lock.

/** `report [--run <runId>]` → `{code, lines}`: `report: <path>` (`run` null: the newest run). */
export function report(main, { run }) {
  throw new Error("refused: report: not built yet");
}
