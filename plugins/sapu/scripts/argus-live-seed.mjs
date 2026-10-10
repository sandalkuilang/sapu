// argus-live-seed.mjs — journeys seeded from a trusted issue or a tracked doc (spec §19.12): `seed` writes the
// text a seed map slot's explorer reads through `pw <token> source`, and the merge links each journey that
// slot returned to its source. Below the slots and the wrapper, which read the seed.

/** `seed (--issue <n> | --doc <file>:<a>-<b>)` → `{code, lines}`: exactly one of `issue` (a number) and `doc` (as typed) is set. */
export function seed(main, { issue, doc }) {
  throw new Error("refused: seed: not built yet");
}

/**
 * The seeds `map-check --merge <slot>` links to each journey slot `slot` of run `runId` returned →
 * `[{kind, ref}]`, empty when the slot was not a seed map slot (none yet).
 */
export function seedsOf(main, runId, slot) {
  return [];
}
