// argus-live-ease.mjs — the ease probes of the taste pass (spec §20.2: perceived performance, states and
// microcopy, consistency, AI surfaces, efficiency), as in-page sources the suite embeds verbatim and the lane runs
// through the session hook. A leaf module. Lane 0's stubs: lane T2 builds each export with the signature fixed
// here (plan, "Signatures lane 0 fixes").

const notBuilt = (what) => {
  throw new Error(`refused: ${what}: not built yet`);
};

/** The in-page ease measurement: the source of one self-contained function `(arg) => result`, run as `(${EASE_SOURCE})(arg)`. */
export const EASE_SOURCE = `(arg) => {
  throw new Error("refused: EASE_SOURCE: not built yet");
}`;

/**
 * The feedback clock of the session hook's init payload (argus-live-browser.mjs PAGE_INIT): self-contained script
 * text run once a document after the taste buffer, recording `input`, `change` (an added node passing
 * `checkVisibility`, or a RENDER_ATTRIBUTES change) and `busy` events through `document.__argusTastePush`
 * (argus-live-tastecfg.mjs TASTE_EVENTS). Empty until built: nothing is installed.
 */
export const EASE_INIT = "";

/** The suite's ease checks, as argus-live-layout.mjs registers its own: `{name, project, when, source, emit}`. */
export const CHECKS = [];

/** A path's cost (decision 3) from its steps and their replay geometry → `{actions, typed, modals, fitts_bits, klm_s}`. */
export function pathCost(steps, geometry) {
  return notBuilt("pathCost");
}

/** The ease measurements of `page` (a Playwright Page) → the screen's, through EASE_SOURCE. */
export async function easeOf(page) {
  return notBuilt("easeOf");
}

/** The per-screen findings `[{rule, key, measured, expected}]` of `screen` (a recorded screen) against `bar` and `cfg` (loadTaste's). */
export function rulesFor(screen, bar, cfg) {
  return notBuilt("rulesFor");
}

/** A page expression → the findings `[{rule, key, measured, expected}]` of one screen rule of this module's families on the current page. */
export function ruleExpression(rule) {
  return notBuilt("ruleExpression");
}
