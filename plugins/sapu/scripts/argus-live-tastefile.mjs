// argus-live-tastefile.mjs — filing the taste pass's confirmed rows (spec §20.5): first-class `ux` issues, one per
// `taste:<rule>:<screen key>`, at most `cap` a cycle, the rest queued, through scrub; and the owner's accept. Lane
// 0's stubs: lane F builds each verb with the signature fixed here (plan, "Signatures lane 0 fixes").

/** `taste file [--run <runId>]` → `{code, lines}`: the run's confirmed rows filed, at most `cap` (null: taste.json's cap). */
export async function tasteFile(main, { run, cap }) {
  throw new Error("refused: taste file: not built yet");
}

/** `taste accept <rule> <key>` → `{code, lines}`: the owner's ruling, staged only on their word (the guard refuses it to subagents). */
export async function tasteAccept(main, rule, key) {
  throw new Error("refused: taste accept: not built yet");
}
