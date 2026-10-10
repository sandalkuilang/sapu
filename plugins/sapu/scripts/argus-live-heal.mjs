// argus-live-heal.mjs — a broken suite path: UI change or bug (spec §19.9). `smoke heal` reads a heal-mode
// explorer's return, re-runs the path with only the named action targets replaced and every expectation
// unchanged, and stages a heal proposal or a regression candidate by the decision table.

/** `smoke heal <slot>.<generation>` → `{code, lines}`: the table's verdict and what it staged. */
export function smokeHeal(main, ref) {
  throw new Error("refused: smoke heal: not built yet");
}
