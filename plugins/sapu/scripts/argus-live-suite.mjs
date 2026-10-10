// argus-live-suite.mjs — the smoke suite's membership (spec §19.3–§19.5): `smoke plan` ranks the catalog into
// the suite's members, `smoke admit` stages a path that held twice, fresh then dirty, and `smoke check`
// regenerates the suite in memory and names every file that differs. check writes nothing (the guard lets a
// subagent run it); every change to the committed suite goes through a proposal.

/** `smoke plan` → `{code, lines}`: one `keep|capture|drop|heal|quarantined|pending` line per journey. */
export function smokePlan(main) {
  throw new Error("refused: smoke plan: not built yet");
}

/** `smoke admit <slot>.<generation>` → `{code, lines}`: the return's path run twice, staged when it held both times. */
export function smokeAdmit(main, ref) {
  throw new Error("refused: smoke admit: not built yet");
}

/** `smoke check` → `{code, lines}`: every hand-edited or stale file of the suite named; writes nothing. */
export function smokeCheck(main) {
  throw new Error("refused: smoke check: not built yet");
}
