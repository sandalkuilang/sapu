// tests/argus-live-taste.test.ts — phase 7's shared surfaces (spec §20, plan lane 0): the taste bar
// (`plugins/sapu/data/taste-bar.json`) and its validator, `.argus/taste.json` and its defaults,
// `.argus/taste-state.json`'s one reader and writer, and the contract's rows for both files.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ARGUS_LIVE, cleanTemps, committed, example, tempDir } from "./helpers/argus-live";
// @ts-expect-error — plain ESM script without types
import { PAGE_INIT, SIGNAL_SCRIPT, slotConfig, writeSlotConfig } from "../plugins/sapu/scripts/argus-live-browser.mjs";
// @ts-expect-error — plain ESM script without types
import { classify } from "../plugins/sapu/scripts/argus-live-classes.mjs";
// @ts-expect-error — plain ESM script without types
import { EASE_INIT, ruleExpression as easeRuleExpression } from "../plugins/sapu/scripts/argus-live-ease.mjs";
// @ts-expect-error — plain ESM script without types
import { LANE_ORACLES, ORACLES, validateReturn } from "../plugins/sapu/scripts/argus-live-return.mjs";
// @ts-expect-error — plain ESM script without types
import { FINAL_KINDS, parseRepro, stepCode } from "../plugins/sapu/scripts/argus-live-steps.mjs";
// @ts-expect-error — plain ESM script without types
import { COMMANDS } from "../plugins/sapu/scripts/argus-live-pw.mjs";
// @ts-expect-error — plain ESM script without types
import { TASTE_INIT, ruleExpression as tasteRuleExpression } from "../plugins/sapu/scripts/argus-live-taste.mjs";
// @ts-expect-error — plain ESM script without types
import { ARCHETYPES, BAR_FILE, CURATOR_FILE, tasteOff, CW_WORDS, explicitMedia, FAMILIES, laneOnly, loadBar, readCuratorFile, SUBSTITUTIONS, tokensPx, validateCurator, loadTaste, MEDIA_READ, readTasteState, RENDER_ATTRIBUTES, ROW_STATES, routeMatches, SCREEN_KEY, TASTE_BUDGET_MS, TASTE_BUFFER, TASTE_DEFAULTS, TASTE_DRAIN, TASTE_EVENTS, TASTE_EVENTS_MAX, TASTE_FILE, TASTE_KEYS, TASTE_STATE_FILE, tasteEventFault, titleKey, validateBar, validateTaste, writeTasteState } from "../plugins/sapu/scripts/argus-live-tastecfg.mjs";

type Obj = Record<string, any>;

// The probes' ruleExpression are lanes T1's and T2's: here each answers fixed rows, so the replay's taste expectation
// is tested on its own (the stubs and the real probes are pinned in those lanes' files).
vi.mock("../plugins/sapu/scripts/argus-live-taste.mjs", async (orig) => ({ ...(await orig()), ruleExpression: (rule: string) => `(() => ${JSON.stringify([{ rule, key: "k1", measured: 2, expected: 1 }])})()` }));
vi.mock("../plugins/sapu/scripts/argus-live-ease.mjs", async (orig) => ({ ...(await orig()), ruleExpression: (rule: string) => `(() => ${JSON.stringify([{ rule, key: "k1", measured: 2, expected: 1 }, { rule: "other.rule", key: "k9", measured: 1, expected: 0 }])})()` }));

afterEach(cleanTemps);

const ROOT = join(__dirname, "..");
const RESEARCH = join(ROOT, "docs/plans/argus-journey-lane-7-research.md");
/** The research's source ids: every evidence table's first cell that is an id. */
const researchIds = () => new Set([...readFileSync(RESEARCH, "utf8").matchAll(/^\| ([a-z0-9]+(?:-[a-z0-9]+)*) \|/gm)].map((m) => m[1]));
const shipped = (): Obj => JSON.parse(readFileSync(BAR_FILE, "utf8"));
const RUN = "20000101000000-0123abcd";

describe("the taste bar (plugins/sapu/data/taste-bar.json)", () => {
  it("ships in the plugin and validates; loadBar hands out its value", () => {
    expect(BAR_FILE).toBe(join(ROOT, "plugins/sapu/data/taste-bar.json"));
    const { value, errors } = validateBar(shipped());
    expect(errors).toEqual([]);
    expect(loadBar()).toEqual(value);
    expect(Object.isFrozen(loadBar())).toBe(true);
  });

  it("is version 1 with no band: no site's terms are confirmed by a maintainer, so no calibration is shipped (and no probe digest)", () => {
    const bar = loadBar();
    expect(bar.version).toBe(1);
    expect(bar.archetypes).toEqual({});
    expect(bar.probe).toBe(null);
  });

  it("every rule and frame cites an id of the phase 7 research, and every source is cited", () => {
    const bar = loadBar();
    const ids = researchIds();
    expect(ids.size).toBeGreaterThan(50);
    const cited = new Set([...bar.rules.flatMap((r: Obj) => r.cite), ...Object.values(bar.frames).flatMap((f: any) => f.cite)]);
    for (const id of cited) expect(ids.has(id), id).toBe(true);
    expect(new Set(Object.keys(bar.sources))).toEqual(cited);
    for (const [id, url] of Object.entries(bar.sources)) expect(readFileSync(RESEARCH, "utf8"), id).toContain(url as string);
  });

  it("holds every family of decisions 3 and 6-14, each rule promotable but none gating by itself", () => {
    const bar = loadBar();
    expect(new Set(bar.rules.map((r: Obj) => r.family))).toEqual(new Set(Object.keys(FAMILIES)));
    for (const r of bar.rules) {
      expect(r.gate, r.id).toBe(false);
      expect(r.id.startsWith(`${r.family}.`), r.id).toBe(true);
    }
    const byId = Object.fromEntries(bar.rules.map((r: Obj) => [r.id, r]));
    // The decisions' own words, pinned where a rule's class or threshold is the decision.
    expect(byId["contrast.headroom"]).toMatchObject({ class: "bar", info: true, threshold: { min: 7 } });
    expect(byId["motion.duration"]).toMatchObject({ class: "bar", threshold: { range: [50, 500], opacity_max: 700 } });
    expect(byId["motion.reduced"].cite).toContain("wcag-233");
    expect(byId["feedback.latency"]).toMatchObject({ info: true, threshold: { max: 100 } });
    expect(byId["feedback.busy"]).toMatchObject({ class: "implicit", threshold: { max: 1000 } });
    expect(byId["feedback.progress"]).toMatchObject({ class: "implicit", threshold: { max: 10000 } });
    expect(byId["feedback.loader-flash"]).toMatchObject({ class: "bar", threshold: { min: 300, min_wait: 1000 } });
    expect(byId["copy.vague"].terms.en).toEqual(["OK", "Submit", "Continue", "Click here", "Yes", "No"]);
    expect(byId["efficiency.actions"]).toMatchObject({ class: "derived", threshold: { ratio: 3 } });
    expect(byId["efficiency.klm"]).toMatchObject({ class: "derived", threshold: { plus_s: 10 } });
    // max(median of the peers × 2, median + 3): a p90 page of the corpus is no row against a p10 peer.
    expect(byId["scale.spacing"]).toMatchObject({ class: "derived", threshold: { peer: [2, 3], band: "p90" } });
    // Decision 15: no rule asks for a CSS feature or a style.
    expect(JSON.stringify(bar.rules)).not.toMatch(/oklch|container|view-transition|anchor|animation-timeline|content-visibility/i);
  });

  it("keeps Polaris as a historical frame only", () => {
    const { frames } = loadBar();
    expect(Object.keys(frames).sort()).toEqual(["atlassian", "carbon", "material", "polaris", "primer"]);
    expect(frames.polaris.historical).toBe(true);
    for (const [k, f] of Object.entries(frames) as [string, Obj][]) if (k !== "polaris") expect(f.historical, k).toBeUndefined();
  });

  const bar = (patch: Obj = {}): Obj => ({ ...structuredClone(shipped()), ...patch });
  const errs = (raw: unknown) => validateBar(raw).errors as string[];
  const rule = (patch: Obj): Obj => ({ ...structuredClone(shipped().rules[0]), ...patch });
  const BAND = { n: 20, sites: 6, p10: 3, p50: 5, p90: 9, urls: ["https://a.test/x", "https://b.test/y"] };

  it("refuses a rule without a citation, or citing a source it does not list", () => {
    for (const cite of [undefined, [], "primer", [""]]) {
      const r = rule({ cite });
      if (cite === undefined) delete r.cite;
      expect(errs(bar({ rules: [r] })), JSON.stringify(cite)).toContainEqual(expect.stringMatching(/^rules\[0\]\.cite must be a non-empty array of source ids/));
    }
    expect(errs(bar({ rules: [rule({ cite: ["nowhere"] })] }))).toContainEqual("rules[0].cite: nowhere is not in sources");
  });

  it("refuses a rule of another shape: an unknown key, a class outside three, a gating rule, a family its id does not name, a duplicate", () => {
    expect(errs(bar({ rules: [rule({ style: "flat" })] }))).toContainEqual('rules[0]: unknown key "style"');
    expect(errs(bar({ rules: [rule({ class: "taste" })] }))).toContainEqual(expect.stringMatching(/^rules\[0\]\.class must be implicit, derived or bar/));
    expect(errs(bar({ rules: [rule({ gate: true })] }))).toContainEqual(expect.stringMatching(/^rules\[0\]\.gate must be false/));
    expect(errs(bar({ rules: [rule({ family: "motion" })] }))).toContainEqual(expect.stringMatching(/^rules\[0\]: the id .* names family scale, not motion/));
    expect(errs(bar({ rules: [rule({}), rule({})] }))).toContainEqual(expect.stringMatching(/^rules\[1\]: the id .* is taken/));
    expect(errs(bar({ rules: [rule({ threshold: { max: "3" } })] }))).toContainEqual(expect.stringMatching(/^rules\[0\]\.threshold/));
    expect(errs(bar({ rules: [rule({ threshold: { mood: 3 } })] }))).toContainEqual(expect.stringMatching(/^rules\[0\]\.threshold/));
  });

  it("refuses a band whose n is under its sites, and a string beyond URLs and metric names in archetypes (numbers only)", () => {
    expect(errs(bar({ archetypes: { docs: { distinct_spacing: BAND } } }))).toEqual([]);
    expect(errs(bar({ archetypes: { docs: { distinct_spacing: { ...BAND, n: 5 } } } }))).toContainEqual(expect.stringMatching(/^archetypes\.docs\.distinct_spacing: n must be an integer of at least its sites/));
    for (const [what, archetypes] of [
      ["a note", { docs: { distinct_spacing: { ...BAND, note: "looks clean" } } }],
      ["page text in place of a URL", { docs: { distinct_spacing: { ...BAND, urls: ["Buy now"] } } }],
      ["a CSS value as a string", { docs: { distinct_spacing: { ...BAND, p50: "12px" } } }],
      ["a text as a metric name", { docs: { "Buy now": BAND } }],
      ["an archetype outside five", { dashboard: { distinct_spacing: BAND } }],
      ["a string in place of a band", { docs: { distinct_spacing: "screenshot.png" } }],
    ] as [string, Obj][]) expect(errs(bar({ archetypes })), what).not.toEqual([]);
    expect(errs(bar({ archetypes: { docs: { distinct_spacing: { ...BAND, p10: 10 } } } }))).toContainEqual(expect.stringMatching(/p10 <= p50 <= p90/));
  });

  it("refuses unknown top-level keys, a version under 1, and a probe that is not a sha256", () => {
    expect(errs(bar({ house: "x" }))).toContainEqual('taste-bar.json: unknown key "house"');
    expect(errs(bar({ version: 0 }))).toContainEqual("version must be a positive integer");
    expect(errs(bar({ probe: "abc" }))).toContainEqual("probe must be null or a sha256 (64 hex digits)");
    expect(errs(bar({ probe: "a".repeat(64) }))).toEqual([]);
    expect(errs([])).toEqual(["taste-bar.json must be a JSON object"]);
  });

  it("refuses a frame of another shape: a metric both listed and ranged, an unordered scale, a frame citing nothing", () => {
    const frames = (f: Obj) => bar({ frames: { ...shipped().frames, x: f } });
    expect(errs(frames({ cite: ["primer"], spacing: { values: [2, 4] } }))).toEqual([]);
    expect(errs(frames({ cite: ["primer"], spacing: { values: [4, 2] } }))).not.toEqual([]);
    expect(errs(frames({ cite: ["primer"], spacing: { values: [2], range: [0, 4] } }))).not.toEqual([]);
    expect(errs(frames({ cite: [], spacing: { values: [2] } }))).not.toEqual([]);
    expect(errs(frames({ cite: ["primer"], colours: 10 }))).toContainEqual('frames.x: unknown key "colours"');
    expect(errs(frames({ cite: ["primer"] }))).toContainEqual("frames.x must hold at least one of spacing, radius, type, durations, layers");
  });
});

describe(".argus/taste.json — the owner's calibration", () => {
  const errs = (raw: unknown) => validateTaste(raw).errors as string[];

  it("takes {} as every default", () => {
    expect(TASTE_FILE).toBe(".argus/taste.json");
    expect(TASTE_KEYS).toEqual(["frame", "archetypes", "accept", "gate", "off", "cap", "optimistic", "ai", "copy"]);
    expect(Object.isFrozen(TASTE_KEYS) && Object.isFrozen(TASTE_DEFAULTS)).toBe(true);
    expect(validateTaste({})).toEqual({ value: { frame: null, archetypes: {}, accept: [], gate: [], off: [], cap: 5, optimistic: [], ai: [], copy: { vague: [] } }, errors: [] });
  });

  it("takes a full file", () => {
    const raw = {
      frame: "primer",
      archetypes: { "/": "marketing", "/docs/**": "docs", "/orders/*": "data", "/orders/:id": "app", "/checkout": "form" },
      accept: [{ rule: "scale.spacing", key: "/reports|1440|light", why: "the report is dense on purpose" }],
      gate: ["copy.broken"],
      off: ["hierarchy.alignment"],
      cap: 20,
      optimistic: ["/cart/**"],
      ai: ["/assistant"],
      copy: { vague: ["Proceed", "OK"] },
    };
    expect(validateTaste(raw)).toEqual({ value: raw, errors: [] });
    expect(ARCHETYPES).toEqual(["marketing", "docs", "app", "form", "data"]);
  });

  it("refuses unknown keys at every level", () => {
    // Each caller names the file once (`refused: <verb>: .argus/taste.json: …`): the fault itself never repeats it.
    expect(errs({ colour: "blue" })).toEqual(['unknown key "colour"']);
    expect(errs({ copy: { vague: [], tone: "warm" } })).toEqual(['copy: unknown key "tone"']);
    expect(errs({ accept: [{ rule: "scale.spacing", key: "k", why: "w", until: 3 }] })).toEqual(['accept[0]: unknown key "until"']);
  });

  it("refuses an archetype key that is not a route glob, and an archetype outside the five", () => {
    for (const k of ["orders", "/orders?x=1", "/a b", "https://x.test/y", "/a/../b", "/a#b", "", `/${"a".repeat(200)}`]) {
      expect(errs({ archetypes: { [k]: "app" } }), k).toEqual([expect.stringMatching(/^archetypes: .* is not a route glob/)]);
    }
    expect(errs({ archetypes: { "/orders/*": "dashboard" } })).toEqual(["archetypes./orders/* must be one of marketing, docs, app, form, data"]);
  });

  it("refuses a gate, off or accept rule id the bar lacks", () => {
    expect(errs({ gate: ["scale.vibes"] })).toEqual(["gate: scale.vibes is not a rule of the bar"]);
    expect(errs({ off: ["nope"] })).toEqual(["off: nope is not a rule, a family or * of the bar"]);
    expect(errs({ accept: [{ rule: "scale.vibes", key: "k", why: "w" }] })).toEqual(["accept[0].rule: scale.vibes is not a rule of the bar"]);
    expect(errs({ gate: ["copy.broken", "copy.broken"] })).toEqual(["gate must be an array of distinct rule ids"]);
  });

  it("refuses a rule both gated and off, and a gated information rule", () => {
    expect(errs({ gate: ["copy.broken"], off: ["copy.broken"] })).toEqual(["gate and off both name copy.broken"]);
    expect(errs({ gate: ["contrast.headroom"] })).toEqual(["gate: contrast.headroom is information only: it cannot gate"]);
  });

  it("a perf pass hooks the signal script and the perf observers alone: no taste buffer or recorder weighs on what it times", async () => {
    const { hookSignals } = await import("../plugins/sapu/scripts/argus-live-session.mjs");
    const { PERF_SCRIPT } = await import("../plugins/sapu/scripts/argus-live-perf.mjs");
    const { AIUX_INIT } = await import("../plugins/sapu/scripts/argus-live-aiux.mjs");
    const sink = { pass: "perf" };
    expect(hookSignals(sink)).toBe(`${SIGNAL_SCRIPT};\n${PERF_SCRIPT}`);
    for (const recorder of [TASTE_BUFFER, TASTE_INIT, EASE_INIT, AIUX_INIT]) expect(hookSignals(sink)).not.toContain(recorder.trim());
    // Outside a perf pass, the lane's whole payload.
    expect(hookSignals(null)).toBe(PAGE_INIT);
    for (const recorder of [TASTE_BUFFER, TASTE_INIT, EASE_INIT, AIUX_INIT]) expect(PAGE_INIT).toContain(recorder.trim());
    // The slot's CLI init payload follows it at each open: signals.js holds the same.
    const dir = tempDir();
    const { writeInitPayload } = await import("../plugins/sapu/scripts/argus-live-browser.mjs");
    mkdirSync(join(dir, ".playwright"), { recursive: true });
    writeInitPayload(dir, SIGNAL_SCRIPT);
    expect(readFileSync(join(dir, ".playwright/signals.js"), "utf8")).toBe(SIGNAL_SCRIPT);
    expect(statSync(join(dir, ".playwright/signals.js")).mode & 0o777).toBe(0o600);
  });

  it("off takes rule ids, family names and *: the value lists the rule ids they name; * turns the whole pass off (tasteOff)", () => {
    const bar = loadBar();
    const ids = (f: string) => bar.rules.filter((r: Obj) => r.family === f).map((r: Obj) => r.id);
    expect(validateTaste({ off: ["ai", "motion.duration"] }).value.off).toEqual([...ids("ai"), "motion.duration"].sort());
    const all = validateTaste({ off: ["*"] }).value;
    expect(all.off).toEqual(bar.rules.map((r: Obj) => r.id).sort());
    expect(tasteOff(all)).toBe(true);
    expect(tasteOff(validateTaste({ off: ["ai"] }).value)).toBe(false);
    expect(tasteOff(validateTaste({}).value)).toBe(false);
    expect(errs({ off: ["vibes"] })).toEqual(["off: vibes is not a rule, a family or * of the bar"]);
    expect(errs({ off: ["ai", "ai"] })).toEqual(["off must be an array of distinct rule ids, family names or *"]);
    expect(errs({ gate: ["copy.broken"], off: ["copy"] })).toEqual(["gate and off both name copy.broken"]);
    expect(errs({ gate: ["copy.broken"], off: ["*"] })).toEqual(["gate and off both name copy.broken"]);
  });

  it("refuses to gate a rule the suite cannot measure: a lane-only rule (laneOnly) or a cycle rule, each with why", () => {
    expect(errs({ gate: ["scale.spacing"] })).toEqual(["gate: scale.spacing is the lane's alone (it compares the cycle's screens): the suite cannot measure it, so it cannot gate"]);
    expect(errs({ gate: ["states.error"] })).toEqual(["gate: states.error is the lane's alone (the routed fault: only the lane's confirmation arms it): the suite cannot measure it, so it cannot gate"]);
    expect(errs({ gate: ["ai.stop"] })).toEqual(["gate: ai.stop is the lane's alone (it reads the owner's declared AI surfaces): the suite cannot measure it, so it cannot gate"]);
    expect(errs({ gate: ["consistent.action"] })).toEqual(["gate: consistent.action is the lane's alone (it compares the cycle's screens or paths): the suite cannot measure it, so it cannot gate"]);
    expect(errs({ gate: ["efficiency.klm"] })).toEqual(["gate: efficiency.klm is the lane's alone (it compares the cycle's screens or paths): the suite cannot measure it, so it cannot gate"]);
    // Every rule the suite measures can gate (an information rule aside), and only those.
    const suite = loadBar().rules.filter((r: Obj) => !r.info && FAMILIES[r.family].scope === "screen" && laneOnly(r) === null).map((r: Obj) => r.id);
    expect(errs({ gate: suite })).toEqual([]);
    expect(suite).toEqual(expect.arrayContaining(["copy.broken", "hierarchy.heading-order", "colour.dark-border"]));
  });

  it("refuses a cap outside 1-20", () => {
    for (const cap of [0, 21, 2.5, "5", null]) expect(errs({ cap }), String(cap)).toEqual(["cap must be an integer from 1 to 20"]);
  });

  it("refuses a frame the bar does not hold", () => {
    expect(errs({ frame: "geist" })).toEqual(["frame must be one of atlassian, carbon, material, polaris, primer"]);
    expect(errs({ frame: 3 })).toEqual(["frame must be one of atlassian, carbon, material, polaris, primer"]);
  });

  it("refuses accept rows of another shape, route lists that are not globs, and vague labels that are not short words", () => {
    expect(errs({ accept: [{ rule: "scale.spacing", key: "", why: "w" }] })).toEqual([expect.stringMatching(/^accept\[0\] must be \{rule, key, why\}/)]);
    expect(errs({ accept: [{ rule: "scale.spacing", key: "k" }] })).toEqual([expect.stringMatching(/^accept\[0\] must be \{rule, key, why\}/)]);
    expect(errs({ accept: "all" })).toEqual(["accept must be an array of {rule, key, why}"]);
    expect(errs({ optimistic: ["cart"] })).toEqual(["optimistic must be an array of distinct route globs (/…, path characters and *)"]);
    expect(errs({ ai: "/assistant" })).toEqual(["ai must be an array of distinct route globs (/…, path characters and *)"]);
    expect(errs({ copy: { vague: [""] } })).toEqual(["copy.vague must be an array of distinct labels of 1 to 60 characters, without control characters"]);
    expect(errs({ copy: { vague: ["a\nb"] } })).toEqual(["copy.vague must be an array of distinct labels of 1 to 60 characters, without control characters"]);
    expect(errs([])).toEqual([".argus/taste.json must be a JSON object"]);
  });

  it("loadTaste: every default when the file is missing, its errors when it is broken", () => {
    const main = tempDir();
    expect(loadTaste(main)).toEqual({ taste: validateTaste({}).value, errors: [], missing: true });
    mkdirSync(join(main, ".argus"), { recursive: true });
    writeFileSync(join(main, TASTE_FILE), "{");
    expect(loadTaste(main)).toMatchObject({ taste: null, missing: false, errors: [expect.stringMatching(/^\.argus\/taste\.json is not valid JSON/)] });
    writeFileSync(join(main, TASTE_FILE), JSON.stringify({ cap: 3 }));
    expect(loadTaste(main)).toMatchObject({ taste: { cap: 3, gate: [] }, errors: [], missing: false });
    writeFileSync(join(main, TASTE_FILE), JSON.stringify({ cap: 30 }));
    expect(loadTaste(main)).toEqual({ taste: null, errors: ["cap must be an integer from 1 to 20"], missing: false });
  });

  it("matches a route against a glob: * one segment, ** any depth, :param a segment", () => {
    for (const [glob, route, ok] of [
      ["/orders/*", "/orders/12", true],
      ["/orders/*", "/orders/12/edit", false],
      ["/orders/**", "/orders/12/edit", true],
      ["/orders/**", "/orders", true],
      ["/orders/:id", "/orders/:id", true],
      ["/orders/:id", "/orders/12", false],
      ["/", "/", true],
      ["/", "/x", false],
      ["/docs/*.md", "/docs/a.md", true],
      ["/docs/*.md", "/docs/a/b.md", false],
    ] as [string, string, boolean][]) expect(routeMatches(glob, route), `${glob} ${route}`).toBe(ok);
  });
});

describe(".argus/taste-state.json — one reader, one writer", () => {
  const ROW = { rule: "scale.spacing", screen: "/orders/:id|1440|light", class: "derived", severity: "S4", state: "queued", issue: null, first: RUN, last: RUN };
  const STATE = { version: 1, journeys: { checkout: { judged: RUN, best: { run: RUN, actions: 7, klm_s: 12.5, pathSha: "a".repeat(64) }, rows: { [titleKey(ROW.rule, ROW.screen)]: ROW } } } };

  it("names screens and title keys as the issues spell them", () => {
    expect(TASTE_STATE_FILE).toBe(".argus/taste-state.json");
    expect(ROW_STATES).toEqual(["queued", "open", "closed", "accepted"]);
    expect(titleKey("scale.spacing", "/orders/:id|1440|light")).toBe("taste:scale.spacing:/orders/:id|1440|light");
    for (const k of ["/orders/:id|1440|light", "/|320|dark"]) expect(SCREEN_KEY.test(k), k).toBe(true);
    for (const k of ["/orders|1440", "orders|1440|light", "/a b|1440|light", "/x|1440|dim", "/x|99|light"]) expect(SCREEN_KEY.test(k), k).toBe(false);
  });

  it("reads an empty state when there is none, and writes a state 0600 that reads back whole", () => {
    const main = tempDir();
    expect(readTasteState(main)).toEqual({ version: 1, journeys: {} });
    writeTasteState(main, STATE);
    expect(readTasteState(main)).toEqual(STATE);
    expect(statSync(join(main, TASTE_STATE_FILE)).mode & 0o777).toBe(0o600);
  });

  it("refuses to write, and refuses to read, a state of another shape", () => {
    const main = tempDir();
    const bad = [
      { ...STATE, version: 2 },
      { version: 1, journeys: { Checkout: STATE.journeys.checkout } },
      { version: 1, journeys: { checkout: { ...STATE.journeys.checkout, rows: { "taste:x:y": ROW } } } },
      { version: 1, journeys: { checkout: { ...STATE.journeys.checkout, rows: { [titleKey(ROW.rule, ROW.screen)]: { ...ROW, state: "done" } } } } },
      { version: 1, journeys: { checkout: { ...STATE.journeys.checkout, best: { run: RUN, actions: -1, klm_s: 1, pathSha: "a".repeat(64) } } } },
    ];
    for (const s of bad) expect(() => writeTasteState(main, s), JSON.stringify(s).slice(0, 80)).toThrow(/^failed: \.argus\/taste-state\.json/);
    mkdirSync(join(main, ".argus"), { recursive: true });
    writeFileSync(join(main, TASTE_STATE_FILE), JSON.stringify(bad[0]));
    expect(() => readTasteState(main)).toThrow(/^failed: \.argus\/taste-state\.json/);
    writeFileSync(join(main, TASTE_STATE_FILE), "{");
    expect(() => readTasteState(main)).toThrow(/^failed: \.argus\/taste-state\.json is not valid JSON/);
  });
});

describe("the page-side taste buffer, its drain and the media restore (Task 0.1's post-probe decisions)", () => {
  /** A stand-in page: a document object, performance and location, as an init script and a drain see them. */
  const page = () => {
    const ctx: Obj = { document: {}, performance: { now: () => 12.5, timeOrigin: 1000 }, location: { href: "http://localhost:4100/orders/7" } };
    vm.createContext(ctx);
    vm.runInContext(TASTE_BUFFER, ctx);
    return ctx;
  };
  const push = (ctx: Obj, rec: Obj) => vm.runInContext(`document.__argusTastePush(${JSON.stringify(rec)})`, ctx);
  const drain = (ctx: Obj) => vm.runInContext(TASTE_DRAIN, ctx);
  const CHANGE = { kind: "change", t: 3.25, cause: "attribute", attr: "class" };
  const MOTION = { kind: "transition", t: 4, phase: "end", name: "transform", duration_ms: 200, delay_ms: 0, easing: "ease-out", target: "div|dialog|Edit order" };

  it("installs once per document and drains its events with the document's URL and time origin", () => {
    const ctx = page();
    push(ctx, CHANGE);
    vm.runInContext(TASTE_BUFFER, ctx); // the hook evaluates it again at domcontentloaded: the buffer stays
    push(ctx, MOTION);
    expect(drain(ctx)).toEqual({ url: "http://localhost:4100/orders/7", timeOrigin: 1000, dropped: 0, events: [CHANGE, MOTION] });
    expect(drain(ctx)).toEqual({ url: "http://localhost:4100/orders/7", timeOrigin: 1000, dropped: 0, events: [] });
  });

  it("keeps at most TASTE_EVENTS_MAX a document, counts the rest and every record of another shape as dropped", () => {
    const ctx = page();
    for (let i = 0; i < TASTE_EVENTS_MAX + 3; i++) push(ctx, { ...CHANGE, t: i });
    push(ctx, { kind: "mood", t: 1 });
    push(ctx, { kind: "change" });
    const d = drain(ctx);
    expect(d.events).toHaveLength(TASTE_EVENTS_MAX);
    expect(d.dropped).toBe(5);
    expect(drain(ctx).dropped).toBe(0);
  });

  it("names each event kind's fields, and its validator refuses another shape", () => {
    expect(Object.keys(TASTE_EVENTS)).toEqual(["input", "change", "busy", "transition", "animation"]);
    for (const e of [CHANGE, MOTION, { kind: "input", t: 1, type: "click" }, { kind: "busy", t: 2, on: true, signal: "aria-busy" }, { ...MOTION, kind: "animation", phase: "start", name: "grow" }]) expect(tasteEventFault(e), e.kind).toBeNull();
    expect(tasteEventFault({ ...CHANGE, cause: "focus", attr: null })).toBeNull();
    for (const e of [{ ...CHANGE, attr: "data-state" }, { ...CHANGE, cause: "mutation" }, { ...MOTION, duration_ms: -1 }, { ...MOTION, phase: "paused" }, { ...CHANGE, t: "3" }, { ...CHANGE, extra: 1 }, { kind: "input", t: 1, type: "scroll" }]) expect(tasteEventFault(e), JSON.stringify(e)).not.toBeNull();
  });

  it("counts only the rendering attributes of decision 1, never a data-* attribute", () => {
    expect(RENDER_ATTRIBUTES).toEqual(["class", "style", "hidden", "aria-hidden", "open", "disabled", "aria-expanded", "aria-selected", "aria-busy"]);
    expect(RENDER_ATTRIBUTES.some((a: string) => a.startsWith("data-"))).toBe(false);
  });

  it("reads the page's media as explicit values, and restores only explicit values, never null", () => {
    const ctx: Obj = { matchMedia: (q: string) => ({ matches: q === "(prefers-color-scheme: dark)" }) };
    vm.createContext(ctx);
    expect(vm.runInContext(MEDIA_READ, ctx)).toEqual({ colorScheme: "dark", reducedMotion: "no-preference" });
    expect(explicitMedia({ colorScheme: "light", reducedMotion: "reduce" })).toEqual({ colorScheme: "light", reducedMotion: "reduce" });
    for (const m of [{ colorScheme: null, reducedMotion: "reduce" }, { colorScheme: "light", reducedMotion: null }, { colorScheme: "no-preference", reducedMotion: "reduce" }, {}, null]) {
      expect(() => explicitMedia(m), JSON.stringify(m)).toThrow(/^failed: taste: emulateMedia takes explicit values/);
    }
  });

  it("bounds the taste pass of a cycle by a lane constant", () => {
    expect(TASTE_BUDGET_MS).toBe(15 * 60_000);
  });
});

describe("argus-live CLI — the taste verbs (spec §20.4, §20.5)", () => {
  const cli = (main: string, ...args: string[]) => spawnSync(process.execPath, [ARGUS_LIVE, ...args], { cwd: main, encoding: "utf8" });

  it("the usage line names every taste verb", () => {
    const r = cli(committed(), "nonsense");
    expect(r.status).toBe(2);
    for (const alt of [" | taste judge [--run <runId>] | ", " | taste confirm <row> | ", " | taste file [--run <runId>] | ", " | taste accept <rule> <key>"]) expect(r.stderr, alt).toContain(alt);
  }, 30_000);

  it("refuses a malformed taste line with the usage, before any lane runs", () => {
    const main = committed();
    for (const args of [
      ["taste"],
      ["taste", "nonsense"],
      ["taste", "judge", "x"],
      ["taste", "judge", "--run"],
      ["taste", "judge", "--run", "a", "--run", "b"],
      ["taste", "confirm"],
      ["taste", "confirm", "t1", "t2"],
      ["taste", "file", "--cap", "3"],
      ["taste", "file", "--run"],
      ["taste", "accept", "scale.spacing"],
      ["taste", "accept", "scale.spacing", "k", "x"],
    ]) {
      const r = cli(main, ...args);
      expect(r.status, args.join(" ")).toBe(1);
      expect(r.stderr, args.join(" ")).toMatch(/^refused: usage: argus-live\.mjs /);
    }
  }, 60_000);
});

describe("the session hook's init payload (Task 0.1's post-probe seam)", () => {
  it("is the signal script, then the taste buffer, then the taste and ease init scripts, in every document", () => {
    expect(PAGE_INIT.startsWith(SIGNAL_SCRIPT)).toBe(true);
    expect(PAGE_INIT).toContain(TASTE_BUFFER);
    expect(PAGE_INIT.indexOf(TASTE_BUFFER)).toBeGreaterThan(PAGE_INIT.indexOf(SIGNAL_SCRIPT));
    for (const s of [TASTE_INIT, EASE_INIT]) if (s) expect(PAGE_INIT.indexOf(s)).toBeGreaterThan(PAGE_INIT.indexOf(TASTE_BUFFER));
    expect(() => new Function(PAGE_INIT)).not.toThrow();
  });

  it("the slot's init script file holds it", () => {
    const dir = tempDir();
    writeSlotConfig(dir, slotConfig({ dir, origins: ["http://localhost:4100"], proxyPort: 4999, chrome: { channel: "chrome" } }));
    expect(readFileSync(join(dir, ".playwright/signals.js"), "utf8")).toBe(PAGE_INIT);
  });

  it("emulation stays the lane's own: the explorer's pw has no media command", () => {
    for (const c of Object.keys(COMMANDS)) expect(c, c).not.toMatch(/color-scheme|reduced-motion|emulat|media/i);
  });
});

describe("the taste lane oracle (spec §20.4; Task 0.3)", () => {
  const ACCOUNTS = { "customer.1": "buyer1@example.test", "sales.1": "sales1@example.test" };
  const at = { accounts: ACCOUNTS, live: example() };
  const TASTE = { as: "customer.1", expect: "taste", rule: "copy.broken", key: "p|Status undefined|#", final: "taste" };
  const last = (list: Obj[], o: Obj = at) => {
    try {
      return parseRepro(list, o).steps.at(-1);
    } catch (e) {
      return (e as Error).message;
    }
  };
  const repro = (step: Obj) => [{ as: "customer.1", do: "goto", path: "/orders/7" }, step];

  it("is the lane's own: last in ORACLES, in LANE_ORACLES, never in an explorer's return", () => {
    expect(ORACLES.at(-1)).toBe("taste");
    expect(LANE_ORACLES).toEqual(["regression", "taste"]);
    const opts = { journey: "j1", accounts: { "customer.1": "buyer1@example.test" }, outFiles: [] };
    expect(validateReturn({ journey: "j1", status: "done", candidates: [{ claim: "c", oracle: "taste", repro: [] }] }, opts).errors).toEqual([expect.stringMatching(/^candidates\[0\]\.oracle must be one of handoff, .*, viewport-locale$/)]);
    expect(validateReturn({ journey: "j1", status: "done", coverage: { taste: "held" } }, opts).errors).toEqual(['coverage: "taste" is not an oracle']);
  });

  it("its final is a taste expectation {rule, key}: one screen rule of the bar re-run on the replay's screen", () => {
    expect(FINAL_KINDS.taste).toEqual(["taste"]);
    expect(last(repro(TASTE))).toEqual({ n: 2, ...TASTE });
    for (const [what, step, why] of [
      ["a rule the bar lacks", { ...TASTE, rule: "copy.vibes" }, "taste takes a screen rule of the bar (rule) and a key"],
      ["a cycle rule (consistency)", { ...TASTE, rule: "consistent.action" }, "taste takes a screen rule of the bar (rule) and a key"],
      ["a cycle rule (efficiency)", { ...TASTE, rule: "efficiency.klm" }, "taste takes a screen rule of the bar (rule) and a key"],
      ["an empty key", { ...TASTE, key: "" }, "taste takes a screen rule of the bar (rule) and a key"],
      ["no key", { as: "customer.1", expect: "taste", rule: "copy.broken", final: "taste" }, "taste takes a screen rule of the bar (rule) and a key"],
      ["another oracle's final", { ...TASTE, final: "viewport-locale" }, "viewport-locale's final is visible or enabled or layout"],
      ["the taste final on another expectation", { as: "customer.1", expect: "visible", target: { text: "x" }, final: "taste" }, "taste's final is taste"],
    ] as [string, Obj, string][]) expect(last(repro(step)), what).toBe(`refused: repro: step 2: ${why}`);
    expect(last(repro({ ...TASTE, final: undefined }))).toMatch(/^refused: repro: step 2: the last step must be an expect naming its oracle/);
  });

  it("the explorer's trail: one row a step, in short fixed fields the Curator's walkthrough reads; validated", () => {
    const A = { "customer.1": "buyer1@example.test" };
    const base = { journey: "order-to-cash", status: "done" };
    const ok = { step: 1, goal: "place an order", clicks: 2, words_shown: "New order", new_state: "Order placed" };
    const check = (trail: unknown) => validateReturn({ ...base, trail }, { journey: "order-to-cash", accounts: A, outFiles: [] });
    expect(check([ok])).toEqual({ value: expect.objectContaining({ trail: [ok] }), errors: [] });
    expect(validateReturn(base, { journey: "order-to-cash", accounts: A, outFiles: [] }).value.trail).toBeUndefined();
    for (const [bad, why] of [
      [{ ...ok, step: 0 }, "trail[0].step must be a step number from 1 to 100"],
      [{ ...ok, clicks: "2" }, "trail[0].clicks must be a count from 0 to 99"],
      [{ ...ok, words_shown: "x".repeat(121) }, "trail[0].words_shown must be a string of at most 120 characters"],
      [{ ...ok, new_state: "line\nbreak" }, "trail[0].new_state must be a string of at most 120 characters"],
      [{ ...ok, goal: undefined }, "trail[0].goal must be a string of at most 120 characters"],
      [{ ...ok, why: "free text" }, 'trail[0]: unknown key "why"'],
    ] as [Obj, string][]) expect(check([bad]).errors, why).toEqual([why]);
  });

  it("validateCurator locks the Curator's return: verdicts, leads, substitutions per screen, and a walkthrough in fixed words", () => {
    const ok = {
      verdicts: [{ row: "t1", verdict: "confirm", reason: "" }, { row: "t12", verdict: "polish", reason: "minor" }],
      leads: [{ rule: "copy.broken", screen: "/orders/:id|1440|light" }],
      substitutions: [{ screen: "/orders/:id|1440|light", substitution: "partly" }, { screen: "/orders|1440|dark", substitution: "no" }],
      cw: [{ journey: "order-to-cash", step: 1, q1: "pass", q2: "fail", q3: "n/a", q4: "pass" }],
    };
    expect(validateCurator(ok)).toEqual({ value: ok, errors: [] });
    expect([CURATOR_FILE, CW_WORDS, SUBSTITUTIONS]).toEqual(["taste/curator.json", ["pass", "fail", "n/a"], ["substitutable", "partly", "no"]]);
    for (const [bad, why] of [
      [null, "is not {verdicts, leads, substitutions, cw}"],
      [{ ...ok, extra: [] }, "unknown key extra"],
      [{ verdicts: [], leads: [], substitutions: [] }, "cw must be a list"],
      [{ ...ok, verdicts: [{ row: "1", verdict: "confirm", reason: "" }] }, "verdicts[0] is not {row, verdict: confirm|reject|polish, reason}"],
      [{ ...ok, verdicts: [{ row: "t1", verdict: "confirm" }] }, "verdicts[0] is not {row, verdict: confirm|reject|polish, reason}"],
      [{ ...ok, leads: [{ rule: "consistent.action", screen: "/a|1440|light" }] }, "leads[0] is not {rule: a screen rule of taste-bar 1, screen: a screen key}"],
      [{ ...ok, leads: [{ rule: "copy.broken", screen: "/a" }] }, "leads[0] is not {rule: a screen rule of taste-bar 1, screen: a screen key}"],
      [{ ...ok, substitutions: [{ screen: "/a|1440|light", substitution: "maybe" }] }, "substitutions[0] is not {screen, substitution: substitutable|partly|no}"],
      [{ ...ok, substitutions: [{ screen: "/a|1440|light", substitution: "no" }, { screen: "/a|1440|light", substitution: "partly" }] }, "substitutions[1]: a second substitution for /a|1440|light"],
      [{ ...ok, cw: [{ journey: "order-to-cash", step: 1, q1: "yes, it held", q2: "pass", q3: "pass", q4: "pass" }] }, "cw[0] is not {journey, step: 1-100, q1..q4: pass|fail|n/a}"],
      [{ ...ok, cw: [{ journey: "order-to-cash", step: 0, q1: "pass", q2: "pass", q3: "pass", q4: "pass" }] }, "cw[0] is not {journey, step: 1-100, q1..q4: pass|fail|n/a}"],
      [{ ...ok, cw: [{ ...ok.cw[0], note: "free text" }] }, "cw[0]: unknown key note"],
    ] as [unknown, string][]) expect(validateCurator(bad).errors[0], why).toBe(why);
    // The file: none is no fault; JSON of another shape names its first fault.
    const run = tempDir();
    expect(readCuratorFile(run)).toEqual({ value: null, fault: null });
    mkdirSync(join(run, "taste"));
    // The file holds the return as `taste curator` stored it: each verdict also names its row's journey, rule, screen and key.
    writeFileSync(join(run, CURATOR_FILE), JSON.stringify(ok));
    expect(readCuratorFile(run)).toEqual({ value: null, fault: "taste/curator.json verdicts[0] is not {row, journey, rule, screen, key, verdict: confirm|reject|polish, reason}" });
    const stored = { ...ok, verdicts: ok.verdicts.map((v) => ({ ...v, journey: "order-to-cash", rule: "copy.broken", screen: "/orders/:id|1440|light", key: "main" })) };
    writeFileSync(join(run, CURATOR_FILE), JSON.stringify(stored));
    expect(readCuratorFile(run)).toEqual({ value: stored, fault: null });
    expect(validateCurator(stored).errors[0]).toBe("verdicts[0]: unknown key journey");
    writeFileSync(join(run, CURATOR_FILE), "{");
    expect(readCuratorFile(run)).toEqual({ value: null, fault: "taste/curator.json is not valid JSON" });
  });

  it("tokensPx: the owner's tokens as the taste probe's scale in px, by the kind each name names; null when none", () => {
    const css = ":root {\n  --space-1: 4px; --space-2: 0.5rem; /* --space-9: 99px */\n  --radius-sm: 4px; --rounded-lg: 12px;\n  --font-size-sm: 14px; --text-lg: 1.125rem;\n  --color-text: navy; --gap-x: calc(1rem + 2px); --spacing-y: var(--space-1); --margin: 50%;\n}";
    expect(tokensPx("css", css)).toEqual({ spacing: [4, 8], radius: [4, 12], type: [14, 18] });
    const json = { spacing: { "1": { $value: "4px", $type: "dimension" }, "2": "8px", "3": 12 }, radius: { md: { value: "0.375rem" } }, font: { size: { sm: "0.875rem" } }, color: { text: "black" } };
    expect(tokensPx("json", JSON.stringify(json))).toEqual({ spacing: [4, 8, 12], radius: [6], type: [14] });
    for (const [kind, text] of [["css", "--color-ink: navy;"], ["json", "{not json"], ["json", "{}"], ["yaml", "space: 4px"]]) expect(tokensPx(kind, text), text).toBe(null);
    // Self-contained: the suite embeds its source.
    expect(new Function(`return ${String(tokensPx)}`)()("css", "--radius-md: 6px")).toEqual({ radius: [6] });
  });

  it("refuses a lane-only rule when it parses the repro, before any step's code is built", () => {
    // What one page expression cannot see: peers and bands, a driven form case, the routed fault, the owner's routes.
    const only = loadBar().rules.filter((r: Obj) => laneOnly(r) !== null).map((r: Obj) => r.id);
    expect(only).toEqual(expect.arrayContaining(["scale.spacing", "scale.shadows", "feedback.skeleton-peers", "feedback.optimistic", "states.recovery", "states.error", "ai.stop", "ai.error", "ai.regenerate"]));
    expect(only.filter((id: string) => !/^(scale\.(spacing|type|weights|colours|radii|shadows)|feedback\.(skeleton-peers|optimistic)|states\.(recovery|error)|ai\..+)$/.test(id))).toEqual([]);
    for (const [rule, why] of [
      ["scale.spacing", "it compares the cycle's screens"],
      ["feedback.skeleton-peers", "it compares a screen with its peers"],
      ["states.recovery", "a form case drives it"],
      ["states.error", "the routed fault: only the lane's confirmation arms it"],
      ["ai.stop", "it reads the owner's declared AI surfaces"],
    ]) expect(last(repro({ ...TASTE, rule })), rule).toBe(`refused: repro: step 2: taste: ${rule} is the lane's alone (${why}): a replay's page cannot measure it`);
    expect(laneOnly(null)).toBe(null);
    expect(laneOnly(loadBar().rules.find((r: Obj) => r.id === "copy.broken"))).toBe(null);
  });

  it("is never a regression's final, and a path holds no taste expectation (the suite runs the taste checks)", () => {
    expect(FINAL_KINDS.regression).not.toContain("taste");
    const live = { ...example(), test_id_attribute: "data-testid" };
    const path = [{ as: "customer.1", do: "goto", path: "/orders/7" }, { as: "customer.1", expect: "taste", rule: "copy.broken", key: "k" }, { as: "customer.1", expect: "visible", target: { text: "x" } }];
    expect(last(path, { accounts: { "customer.1": "buyer1@example.test" }, live, path: true })).toBe("refused: repro: step 2: a path has no taste expectation: the suite runs the taste checks after every step");
  });

  it("stepCode carries the rule, the key and its probe's page expression as data; held when no row of that rule has that key", async () => {
    const code = stepCode({ n: 2, as: "customer.1", expect: "taste", rule: "copy.broken", key: "k1", final: "taste" }, { settleMs: 300, runOrigins: ["http://localhost:41002"] });
    const P = JSON.parse(/\n  const P = (.*);\n/.exec(code)![1]);
    expect(P).toMatchObject({ kind: "taste", rule: "copy.broken", key: "k1", expr: easeRuleExpression("copy.broken") });
    expect(stepCode({ n: 2, as: "customer.1", expect: "taste", rule: "scale.spacing", key: "k1" }, { settleMs: 300, runOrigins: [] })).toContain(JSON.stringify(tasteRuleExpression("scale.spacing")));
    // Run against a stand-in page whose expression answers the mocked probe's rows.
    const run = async (key: string) => {
      const c = stepCode({ n: 2, as: "customer.1", expect: "taste", rule: "copy.broken", key, final: "taste" }, { settleMs: 300, runOrigins: [] });
      const page = { waitForTimeout: async () => {}, evaluate: async (e: unknown) => (typeof e === "string" ? (0, eval)(e) : []), context: () => ({ cookies: async () => [], pages: () => [] }) };
      const r = await new Function(`return (${c})`)()(page);
      return { held: r.held, observed: r.observed, shown: r.shown };
    };
    expect(await run("k9")).toEqual({ held: true, observed: null, shown: undefined });
    expect(await run("k1")).toEqual({ held: false, observed: "rows:1", shown: [{ key: "k1", measured: 2 }] });
  });

  it("classify --oracle taste: ux always, bug for implicit and derived, never for bar; S4 for bar, S3 with a cost", () => {
    const REST = ["argus", "found-by:user"];
    expect(classify({ oracle: "taste", tasteClass: "implicit" })).toEqual({ cls: "taste", labels: ["bug", "ux", ...REST], severity: "by outcome", because: "taste row, implicit: broken on its face, rated by what the user did (aesthetics.md §7)" });
    expect(classify({ oracle: "taste", tasteClass: "derived" })).toMatchObject({ cls: "taste", labels: ["bug", "ux", ...REST], severity: "by outcome" });
    expect(classify({ oracle: "taste", tasteClass: "bar" })).toEqual({ cls: "taste", labels: ["ux", ...REST], severity: "S4", because: "taste row, bar: beyond the outside range, never a bug" });
    expect(classify({ oracle: "taste", tasteClass: "bar", cost: true })).toMatchObject({ labels: ["ux", ...REST], severity: "S3" });
    expect(classify({ oracle: "taste", tasteClass: "derived", cost: true })).toMatchObject({ severity: "at least S3" });
    expect(() => classify({ oracle: "taste" })).toThrow("refused: classify: --oracle taste takes --class implicit, derived or bar");
    expect(() => classify({ oracle: "taste", tasteClass: "taste" })).toThrow("refused: classify: --oracle taste takes --class implicit, derived or bar");
    for (const f of [{ tasteClass: "bar" }, { cost: true }]) expect(() => classify({ oracle: "dead-end", ...f }), JSON.stringify(f)).toThrow("refused: classify: --class and --cost are the taste oracle's");
  });

  it("the CLI's classify takes --class and --cost for the taste oracle", () => {
    const main = committed();
    const cli = (...args: string[]) => spawnSync(process.execPath, [ARGUS_LIVE, "classify", ...args], { cwd: main, encoding: "utf8" });
    expect(cli("--oracle", "taste", "--class", "bar", "--cost")).toMatchObject({ status: 0, stdout: "class taste labels ux,argus,found-by:user severity S3 because taste row, bar: beyond the outside range, never a bug\n" });
    expect(cli("--oracle", "taste", "--class", "implicit").stdout).toBe("class taste labels bug,ux,argus,found-by:user severity by outcome because taste row, implicit: broken on its face, rated by what the user did (aesthetics.md §7)\n");
    expect(cli("--oracle", "taste")).toMatchObject({ status: 1, stderr: "refused: classify: --oracle taste takes --class implicit, derived or bar\n" });
    expect(cli("--oracle", "taste", "--class")).toMatchObject({ status: 1 });
    expect(cli("--oracle", "taste", "--class", "bar", "--class", "bar")).toMatchObject({ status: 1 });
  }, 30_000);
});

describe("CONTRACT.md — phase 7's files", () => {
  it("lists .argus/taste.json (tracked) and .argus/taste-state.json (local state)", () => {
    const flat = readFileSync(join(ROOT, "plugins/sapu/CONTRACT.md"), "utf8").replace(/\s+/g, " ");
    expect(flat).toContain("`.argus/taste.json`");
    expect(flat).toContain("`.argus/taste-state.json`");
    const row = readFileSync(join(ROOT, "plugins/sapu/CONTRACT.md"), "utf8").split("\n").find((l) => l.startsWith("| Existing QA configuration |"))!;
    expect(row).toContain("`.argus/taste.json`");
  });

  it("names the Curator's confinement and the calibration script's refusal", () => {
    const flat = readFileSync(join(ROOT, "plugins/sapu/CONTRACT.md"), "utf8").replace(/\s+/g, " ");
    expect(flat).toContain("`sapu:curator`");
    expect(flat).toContain("`taste-calibrate`");
    expect(flat).toContain("`taste accept`");
  });
});
