// argus-live-tastejudge.mjs — the taste pass's judge (spec §20.3, §20.4): every recorded screen's rules against
// the witnesses (the owner's tokens or frame, the app's best peer, the archetype's band), `<run>/taste/judge.json`,
// the best known path in `.argus/taste-state.json`, and the confirmation replay that makes a row two of two. Lane
// 0's stubs: lane J builds each verb with the signature fixed here (plan, "Signatures lane 0 fixes").
// The judge's inputs, imported now so the module DAG holds its place (lane J uses them): both probes' rules and the path cost, the bar, the owner's file and the state.
import { rulesFor as tasteRules } from "./argus-live-taste.mjs";
import { pathCost, rulesFor as easeRules } from "./argus-live-ease.mjs";
import { loadBar, loadTaste, readTasteState } from "./argus-live-tastecfg.mjs";

/** `taste judge [--run <runId>]` → `{code, lines}`: every screen of the run (`run` null: the newest) judged into judge.json. */
export async function tasteJudge(main, { run }) {
  throw new Error("refused: taste judge: not built yet");
}

/** `taste confirm <row>` → `{code, lines}`: judge row `ref` replayed in slot `r` on a fresh instance and measured again. */
export async function tasteConfirm(main, ref) {
  throw new Error("refused: taste confirm: not built yet");
}
