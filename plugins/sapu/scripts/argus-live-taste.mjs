// argus-live-taste.mjs — the visual probes of the taste pass (spec §20.2: scale and restraint, hierarchy and
// rhythm, colour roles and dark parity, contrast headroom, motion, density), as in-page sources the suite embeds
// verbatim and the lane runs through the session hook. A leaf module. Lane 0's stubs: lane T1 builds each export
// with the signature fixed here (plan, "Signatures lane 0 fixes").

const notBuilt = (what) => {
  throw new Error(`refused: ${what}: not built yet`);
};

/** The in-page census: the source of one self-contained function `(arg) => result`, run as `(${TASTE_SOURCE})(arg)`. */
export const TASTE_SOURCE = `(arg) => {
  throw new Error("refused: TASTE_SOURCE: not built yet");
}`;

/**
 * The motion recorder of the session hook's init payload (argus-live-browser.mjs PAGE_INIT): self-contained
 * script text run once a document after the taste buffer, recording `transition` and `animation` events through
 * `document.__argusTastePush` (argus-live-tastecfg.mjs TASTE_EVENTS). Empty until built: nothing is installed.
 */
export const TASTE_INIT = "";

/** The suite's taste checks, as argus-live-layout.mjs registers its own: `{name, project, when, source, emit}`. */
export const CHECKS = [];

/** The census of `page` (a Playwright Page) → the screen's measurements, through TASTE_SOURCE. */
export async function censusOf(page) {
  return notBuilt("censusOf");
}

/** The per-screen findings `[{rule, key, measured, expected}]` of `screen` (a recorded screen) against `bar` and `cfg` (loadTaste's). */
export function rulesFor(screen, bar, cfg) {
  return notBuilt("rulesFor");
}

/** A page expression → the findings `[{rule, key, measured, expected}]` of one screen rule of this module's families on the current page. */
export function ruleExpression(rule) {
  return notBuilt("ruleExpression");
}
