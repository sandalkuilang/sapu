// argus-live-propose.mjs — every change to the committed smoke suite as a pull request (spec §19.8, §19.10):
// `smoke propose` builds the staged changes in a worktree from the base branch, passes every file and the
// body through scrub's matcher, and opens the pull request sapu never merges; `smoke workflow` prints the CI
// job /sapu:init writes with the owner's consent.

/** `smoke propose [--dry-run]` → `{code, lines}`: the pull request's URL, or with `dryRun` the change list alone. */
export function smokePropose(main, { dryRun }) {
  throw new Error("refused: smoke propose: not built yet");
}

/** `smoke workflow` → `{code, lines}`: the CI workflow's YAML, one line each. */
export function smokeWorkflow(main) {
  throw new Error("refused: smoke workflow: not built yet");
}
