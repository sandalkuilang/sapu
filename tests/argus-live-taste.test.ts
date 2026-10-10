// tests/argus-live-taste.test.ts — phase 7's shared surfaces (spec §20, plan lane 0): the taste bar
// (`plugins/sapu/data/taste-bar.json`) and its validator, `.argus/taste.json` and its defaults,
// `.argus/taste-state.json`'s one reader and writer, and the contract's rows for both files.
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { cleanTemps, tempDir } from "./helpers/argus-live";
// @ts-expect-error — plain ESM script without types
import { ARCHETYPES, BAR_FILE, explicitMedia, FAMILIES, loadBar, loadTaste, MEDIA_READ, readTasteState, RENDER_ATTRIBUTES, ROW_STATES, routeMatches, SCREEN_KEY, TASTE_BUDGET_MS, TASTE_BUFFER, TASTE_DEFAULTS, TASTE_DRAIN, TASTE_EVENTS, TASTE_EVENTS_MAX, TASTE_FILE, TASTE_KEYS, TASTE_STATE_FILE, tasteEventFault, titleKey, validateBar, validateTaste, writeTasteState } from "../plugins/sapu/scripts/argus-live-tastecfg.mjs";

type Obj = Record<string, any>;

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

  it("is version 1 with no archetype band yet (calibration fills them) and no probe digest", () => {
    const bar = loadBar();
    expect(bar.version).toBe(1);
    expect(bar.archetypes).toEqual({});
    expect(bar.probe).toBeNull();
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
    expect(byId["scale.spacing"]).toMatchObject({ class: "derived", threshold: { peer: [1.5, 3], band: "p90" } });
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
    expect(errs({ colour: "blue" })).toEqual(['.argus/taste.json: unknown key "colour"']);
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
    expect(errs({ off: ["nope"] })).toEqual(["off: nope is not a rule of the bar"]);
    expect(errs({ accept: [{ rule: "scale.vibes", key: "k", why: "w" }] })).toEqual(["accept[0].rule: scale.vibes is not a rule of the bar"]);
    expect(errs({ gate: ["copy.broken", "copy.broken"] })).toEqual(["gate must be an array of distinct rule ids"]);
  });

  it("refuses a rule both gated and off, and a gated information rule", () => {
    expect(errs({ gate: ["copy.broken"], off: ["copy.broken"] })).toEqual(["gate and off both name copy.broken"]);
    expect(errs({ gate: ["contrast.headroom"] })).toEqual(["gate: contrast.headroom is information only: it cannot gate"]);
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
