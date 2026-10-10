// argus-live-a11y.mjs — the accessibility checks (spec §19.7): keyboard reach and order, visible focus,
// names, ARIA snapshots, modals, contrast, design tokens and form cases, each an in-page source embedded
// verbatim in the generated suite's support.ts and run by the lane through run-code. A leaf module.

/**
 * The check registry the generator loops over: `[{name, project, when, source, emit(step, ctx) → string[]}]`,
 * as in argus-live-layout.mjs. Empty until the accessibility checks land.
 */
export const CHECKS = [];
