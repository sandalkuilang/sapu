// argus-live-layout.mjs — the layout, locale, link and dynamic-state checks (spec §19.7): each an in-page
// source embedded verbatim in the generated suite's support.ts and run by the lane through run-code, each
// reporting violations as {check, step, key, detail} with a key stable across runs. A leaf module.

/**
 * The check registry the generator loops over: `[{name, project, when, source, emit(step, ctx) → string[]}]`
 * — `project` the suite project that runs it, `when` the steps it follows, `source` the in-page code,
 * `emit` the suite lines one path step adds. Empty until the layout and locale checks land.
 */
export const CHECKS = [];
