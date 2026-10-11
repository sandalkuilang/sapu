# Argus journey lane — Phase 7: world-class UI quality — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task names its model (`Model:`); reviewers are always Opus.

**Goal:** the journey lane judges whether the app's UI is good **by the standard of world-class
products**, not only whether it works. Taste and usability become the lane's primary oracle
family: every journey cycle measures every screen it walks for elegance, modernity and ease of
use, against three yardsticks — the repo's own design tokens, the app's own best screens, and a
calibrated bar drawn from the best public websites and the leading design systems — and files the
gaps it can measure as first-class `ux` issues. The smoke suite carries the same probes on every
pull request, on by default, advisory unless the owner promotes a rule to gating. The per-cycle
report leads with the taste and usability scorecard.

**The law stays.** Taste proposes, measurement decides (aesthetics.md §1). Nothing is filed on
opinion alone, and nothing is filed because a screen merely differs from a famous one: a gap is
filed only when it is measured, beyond a threshold, reproduced on a second visit, and — for a
comparison against the outside bar — agreed by a second, internal witness. Precision is what makes
a taste finding taken seriously.

**Architecture:** spec §20 is the design. Two new leaf modules hold every in-page probe
(`argus-live-taste.mjs` for the visual rules, `argus-live-ease.mjs` for feedback, states and
efficiency); as in phase 6 the suite embeds their sources verbatim and the lane runs them through
the session hook. A versioned data file, `plugins/sapu/data/taste-bar.json`, holds the rules,
their thresholds and sources, the reference frames and the calibrated per-archetype ranges. A
per-repo file, `.argus/taste.json`, holds the owner's calibration. A new agent, `sapu:curator`,
judges each cycle's screens from screenshots and numbers, with no tool but Read. A maintainer-only
calibration script, outside the plugin, measures the reference corpus and writes numbers only.

**Tech stack:** unchanged from phase 6: Node ≥ 22.18 ESM, vitest, `gh`, `git`, the pinned
`@playwright/cli` install; the suite's `@playwright/test` and `@axe-core/playwright` pins. Zero new
runtime dependencies for sapu or for the suite.

Spec: [docs/specs/argus-journey-lane.md §20](../specs/argus-journey-lane.md#20-phase-7--world-class-ui-quality).
Roadmap: row 7, [argus-journey-lane-roadmap.md](argus-journey-lane-roadmap.md).
**Evidence:** [argus-journey-lane-7-research.md](argus-journey-lane-7-research.md). Each decision
carries its source ids in square brackets. `[probe]` is Task 0.1's measured result, which outranks
every document.

**Precondition.** Phase 6 as built (d217c93 on `feat/argus-p6`). This plan is written on
`feat/argus-p7`, branched there. The plugin-text rules of the earlier phases apply unchanged:
English, no date, no three- or four-digit `#` reference, no home path, no consumer name, no run
history, no machine-tuned number in prose. Every commit carries the branch's `Signed-off-by` and no
assistant attribution; a commit touching an enforcement file also carries a `Rule-Change:` trailer.

---

## Verified at d217c93

| Fact | Where |
|---|---|
| Check modules export `CHECKS: [{name, project, when, source, emit}]`; annotations are `argus-violation`, `argus-manual`, `argus-info`, read back by `-artifacts.mjs` (`NOTES`). | `argus-live-layout.mjs`, `-a11y.mjs`, `-artifacts.mjs` |
| `live.json` already has `tokens` (`{css}` or `{json}`, one repo file); `a11yTokens` normalises each value through the browser. | `argus-live-config.mjs`, `argus-live-a11y.mjs` |
| The explorer's oracles end with `regression`, the only `LANE_ORACLES` entry: a lane oracle the explorer can never submit. | `argus-live-return.mjs` |
| Every `argus-live` module is capped at 750 lines; `-codegen.mjs` is 736, `-run.mjs` 748, `-a11y.mjs` 644, `-layout.mjs` 665. | `tests/argus-live-findings.test.ts`, `wc -l` |
| The session hook already installs the signal script and, in a perf pass, the perf observers; `-layout.mjs` and `-browser.mjs` already use `MutationObserver`. | `argus-live-session.mjs`, `-browser.mjs`, `-layout.mjs` |
| SELECT's score is `cycles_since_visit × exposure × (1 + commits)`, exposure 2 for money, doubled again for a momus flag. | spec §6 |
| journeys.md exempts a journey cycle from "the Curator's census". | `skills/argus/journeys.md` |
| The plugin is 2.10.0 (phase 6, held). | `plugin.json` |

---

## Decisions (one each; alternatives rejected)

1. **World-class UI quality is the lane's first purpose, and taste and usability its primary
   oracle family.** The Curator's pass runs in every journey cycle, on every screen every explorer
   reached, by default. *Rejected:* an opt-in taste mode (the owner's main question would go
   unasked by default); taste as an advisory add-on to the functional oracles (the owner ranks it
   first). [linear-quality] [m3-expressive]
2. **"Ease of use" is split the way ISO 9241-11 splits usability.** Effectiveness is the goal
   reached (phase 5's oracles). Efficiency is resources spent, measured (D3). Satisfaction is a
   person's response, which no script measures, so the lane never claims it. Learnability proper
   is a learning curve over repeated trials; the lane measures first-encounter discoverability
   (the cognitive walkthrough) and names it so. *Rejected:* a single "usability score" (it would
   blend a measured number with a guess). [iso-9241-11] [nng-learnability] [nng-heuristics]
3. **Efficiency is measured per journey from the lane's own deterministic paths.** Every explore
   charter now asks for a `path` (phase 6's `path: wanted`, always on), so each journey that
   reaches its goal yields a replayable action list. On it, and on its replay geometry:
   - `actions` (by kind), `typed` (characters typed), `modals` (dialogs opened and closed with no
     field filled), `wait_ms` (each step's time to effect, phase 6's `duration_ms`), `recovery`
     (fields lost after a rejected submit, D12);
   - `fitts_bits`: Σ `log2(A/W + 1)`, `A` the distance between consecutive pointer targets'
     centres, `W` the smaller side of the target's box [fitts-mackenzie] [nng-fitts];
   - `klm_s`: the Keystroke-Level estimate, K 0.28 s per character, P from Fitts (bounded to Kieras'
     0.8–1.5 s), BB 0.2 s per click, H 0.4 s per hand move between pointer and keyboard, one M
     (1.2 s) per map goal step — M placement is the model's hardest part, so the rule is fixed and
     documented, never tuned [klm];
   - the **best known path**: the journey's held path with the fewest actions (`.argus/taste-state.json`).
   A path at ≥ 3× the best path's actions, or ≥ 10 s more `klm_s`, while the best path **no longer
   holds** with the same expectations, is an efficiency regression and files (S3; "a 3× longer path
   is not cosmetic"). While the best path still holds, a longer explorer path is the explorer's
   detour, never a finding. *Rejected:* timing the explorer (an LLM's pace measures nothing);
   counting map steps alone (a goal step can take one click or twelve). [klm] [fitts-mackenzie]
4. **The bar is a versioned data file, generic, with optional reference frames.**
   `plugins/sapu/data/taste-bar.json` = `{version, probe, sources, rules, frames, archetypes}`:
   - `rules`: each `{id, family, class, metric, threshold, cite, gate: false}`; `class` is
     `implicit` (broken on its face), `derived` (the app contradicts itself or its tokens) or `bar`
     (beyond the outside range);
   - `frames`: the scales an owner may adopt as their expectation when the repo has no tokens:
     `carbon`, `primer`, `atlassian`, `material` — each the numbers from its own token files
     (spacing, radius, durations, type) [carbon] [primer] [atlassian] [m3-tokens]; Polaris only as a
     historical frame (archived) [polaris]: five. `geist` and `shadcn` are out until their scale
     numbers are read [geist] [shadcn] (as built: "Frames" in lane 0's notes);
   - `archetypes`: the calibrated per-archetype distributions (D16).
   No rule hard-codes a brand, and no rule rewards a style or a CSS feature (D15). *Rejected:* a
   single "house" design system as the bar (one brand's taste as everyone's law); a scraper that
   keeps the bar fresh by itself (unreviewed numbers would become policy). [lux-jakob]
5. **Per-repo calibration lives in `.argus/taste.json`** (tracked, owner-written, unknown keys
   refused): `{frame?, archetypes: {<route glob>: <archetype>}, accept: [{rule, key, why}], gate:
   [<rule id>], off: [<rule id>], cap, optimistic: [<route glob>], ai: [<route glob>], copy:
   {vague: [<label>]}}`. Tokens stay in `live.json` `tokens`. Every comparison uses at most three
   **witnesses**: the owner's tokens (or frame), the app's own best peer screen of the same
   archetype, and the corpus band of that archetype. A `derived` or `implicit` row needs its own
   measurement only; a `bar` row needs the corpus band **and** one internal witness, so a screen is
   never filed for differing from Stripe alone. Without tokens or frame, the internal-consistency
   census decides ("this screen uses 11 spacing values where your best dashboard uses 5").
   *Rejected:* growing `live.json` or `smoke.json` (both near their schema modules' caps; taste is
   a concern of its own). [primer] [nng-consistency]
6. **Colour roles and dark parity are measured, not admired.** One semantic role, one value per
   theme: a status rendered in two colours across screens is `derived` (aesthetics.md §4). Dark
   parity, wherever the app answers `prefers-color-scheme`: re-census under `colorScheme: "dark"`;
   a contrast failure only in dark, a border whose contrast against its surface collapses, or a
   surface left light on a dark page is `implicit`. An app that does not theme is reported
   `single theme`, never a finding. *Rejected:* requiring a dark theme. [apple-dark] [apple-a11y]
   [radix] [shadcn] [geist] [linear-redesign] [stripe-color] [mdn-prefers] [atlassian]
7. **Elegance is restraint, hierarchy and rhythm, each a count.** Per screen: distinct spacing,
   type (size × weight), weights, non-neutral colours, radii and shadows (aesthetics.md §3.1's
   census); primary-styled actions per view (the loudest filled button style; more than one is a
   finding, a destructive one is §7 S1/S2); heading sizes monotonic with heading level; sibling
   left edges off by 1–3 px; section gaps off-scale; shadows more numerous than layers (page,
   raised, overlay, modal); a child radius larger than its parent's at a shared corner. *Rejected:*
   a "beauty score" (no oracle); counting colours without a role model. [refactoring-ui]
   [m3-expressive] [lux-hick] [nng-heuristics] [m3-tokens] [atlassian] [vercel-wig] [apple-layout]
8. **Contrast: WCAG 2.2 is the gate; APCA is not adopted.** axe's rules (phase 6) stay the gate.
   APCA is rejected: WCAG 3 has not chosen a contrast algorithm, and APCA's code is beta, all
   rights reserved, patents pending, licensed for WCAG work only. The bar adds `contrast.headroom`,
   an `argus-info` line for body text under 7:1, never filed. *Rejected:* APCA as an advisory
   signal (licence and status); a hand-written second contrast engine. [wcag3-wd] [apca]
   [apple-dark] [vercel-wig]
9. **Motion is bounded, compositor-only and optional.**
   - An action-triggered animation (`document.getAnimations()`, view transitions included) outside
     50–500 ms (700 ms for an opacity-only backdrop) is a `bar` row [atlassian] [carbon]
     [m3-tokens] [primer];
   - an animation of `width`, `height`, `top`, `left`, `margin` or `padding` that moves another
     element's box is `implicit` (a shift the user did not cause) [webdev-animations] [webdev-cls];
   - `transition: all` is an `argus-info` line [vercel-wig];
   - under `reducedMotion: "reduce"`, a transform animation that still runs is a `bar` row citing
     SC 2.3.3 at its real level, AAA — never filed as AA [wcag-233] [apple-a11y] [mdn-prefers].
   *Rejected:* judging easing curves (no shared value; every system ships its own).
10. **Perceived performance has NN/g's three limits.** The ease probe arms a `MutationObserver`
    before each action and reports the time to the first visible change (a mutation in a shown
    element, a focus move or a navigation):
    - over 100 ms: an `argus-info` line [nng-response] [webdev-inp];
    - over 1 s with no busy signal (`aria-busy`, `progressbar`, a control going disabled): `implicit`
      [nng-response] [nng-progress];
    - over 10 s without a determinate progressbar: `implicit` [nng-response] [nng-skeleton];
    - a loader visible under 300 ms, or shown for a wait under 1 s: `bar` (it flashes)
      [vercel-wig] [nng-progress];
    - a full-screen wait of 1–10 s shown by a spinner on a route whose peers use a skeleton:
      `derived` [nng-skeleton] [carbon] [primer-patterns];
    - a skeleton replaced by content that shifts layout: `implicit` [vercel-wig];
    - for routes in `optimistic`, the UI change must precede the response: the owner's
      specification, `derived` when broken [vercel-wig].
    Web Vitals stay lab context (phase 6 D9). *Rejected:* a fixed INP gate per action (field
    thresholds at p75 are not lab verdicts).
11. **Density is a mode, judged for consistency.** Distinct control heights of one kind on one
    screen beyond two, and table row heights that differ between tables of the app, are `derived`;
    targets under 24 px stay phase 6's 2.5.8 check. *Rejected:* a preferred density (ops screens
    are dense by design, aesthetics.md §6). [cloudscape-density] [primer] [apple-a11y]
12. **States and microcopy are completeness checks.**
    - Error state: in the lane's confirmation replay only (never during an explorer's walk; in
      phase 7 the suite does not run it, see "Integration"), the screen's first same-origin JSON GET
      is answered 500 by `page.route`; a blank main,
      an endless loader, or no control to retry or leave is `implicit` [vercel-wig] [nng-errors];
    - empty state: phase 6's check, plus a control in the empty region (a direct pathway): `bar`
      [nng-empty] [carbon] [atlassian];
    - success: after a 2xx non-GET from a path action, the page names the new state within 1 s
      (a live-region text or the changed value shown); no visible change is `implicit`
      [nng-heuristics] [apple-genai];
    - error recovery: after phase 6's rejected form case, every other field keeps its value; each
      lost value is `implicit` and counts toward `recovery` [nng-errors] [primer-patterns];
    - broken copy: visible `undefined`, `null`, `NaN`, `[object Object]`, `Invalid Date`, `{{`,
      `%s` is `implicit` and carries `bug`;
    - vague labels: a primary or dialog-confirm control named only from the bar's English list
      (`OK`, `Submit`, `Continue`, `Click here`, `Yes`, `No`) or the owner's `copy.vague`, only
      under a matching `<html lang>`: `bar` [atlassian] [vercel-wig];
    - an error message with no control or link in its region: a lead for the Curator, never filed
      alone [nng-errors] [atlassian].
13. **Consistency is a self-contradiction, measured across the cycle's screens.** Actions are
    grouped by the request they trigger (`METHOD` + route template): one action reached by
    controls of different role, accessible name or region is `derived`; the primary button's
    position in dialog and form footers (first or last) differing across screens is `derived`;
    one form mixing autosave and an explicit submit is `derived`; a command palette that opens by
    one chord on one screen and not on another screen of the journey is `derived`. *Rejected:*
    requiring a command palette or particular shortcuts. [nng-consistency] [nng-heuristics]
    [primer-patterns] [superhuman-cmdk]
14. **AI surfaces, only where the owner declares them** (`ai` route globs): while a response
    streams, a Stop control is present and enabled; after an error, the surface shows it and offers
    a way on; regenerate exists after completion — each `derived` from the owner's declaration.
    Provenance and uncertainty display are Curator leads, never filed alone. *Rejected:* detecting
    AI surfaces heuristically (false positives). [teams-streaming] [aisdk-chat] [apple-genai]
    [carbon] [pair]
15. **Modern means measured outcomes, never features.** No rule requires `oklch()`, container
    queries, view transitions, anchor positioning, scroll-driven animation or `content-visibility`;
    the probes only make sure such features are measured correctly (colours resolved by the
    browser, fluid type bucketed per viewport, view transitions seen as animations). *Rejected:* a
    "modern CSS" checklist (it rewards implementation, not the user's experience; scroll-driven
    animation is not even Baseline). [webdev-baseline] [mdn-animation-timeline] [mdn-oklch]
    [mdn-clamp] [mdn-view-transition] [nng-heuristic-8-aesthetic]
16. **The reference corpus calibrates; it is never copied.** A maintainer-only script,
    `scripts/taste-calibrate.mjs` in sapu's repository (not in the plugin, so never installed in a
    consumer), runs `argus-live-taste.mjs`'s and `argus-live-ease.mjs`'s probes on the public pages
    listed in `scripts/taste-corpus.json` and writes **numbers only** into the bar's `archetypes`:
    per archetype × metric `{n, sites, p10, p50, p90}`, each with the list of URLs measured.
    - Archetypes: `marketing`, `docs`, `app`, `form`, `data`. A consumer screen is compared only
      with its own archetype: the owner's `archetypes` globs decide; otherwise a page whose `main`
      holds a table or grid of ≥ 10 rows is `data`, and any other inference is `app` and marked
      `inferred` — an inferred archetype's band is shown, never a witness.
    - An archetype's band is a witness only with ≥ 5 sites and ≥ 15 pages; below that it is
      `thin` and shown only. On the corpus after its terms review (Apple, Figma, Raycast and IBM
      Carbon left), `docs` reaches the threshold (18 pages, 5 sites); `marketing` (3 sites), `app`,
      `form` and `data` are thin (most real app chrome needs a login).
    - Rules of conduct: public pages only, no login; `robots.txt` honoured for `User-agent: *` and
      the script's own agent `sapu-taste-calibration`; one request at a time per site, at most one
      page per site every 10 s; each corpus entry records who reviewed the site's terms; no
      screenshot, text, asset or CSS is stored or committed — the probes return counts, values and
      percentiles, and the script fails if any string beyond a URL, a metric name or a CSS
      numeric value reaches its output.
    - Network boundary: the lane stays loopback-only and never fetches the internet. The script
      runs only on a maintainer's machine, explicitly, outside any consumer cycle; the guard
      refuses it to every subagent; its output reaches sapu only through a reviewed sapu pull
      request.
    *Rejected:* storing screenshots of the reference sites (copyright and terms); measuring
    logged-in apps (no consent, personal data); taking a design system's published numbers as the
    corpus (guidelines say what to aim for; the corpus shows what the best ship).
    [lux-jakob] [vercel-wig] [primer] [shadcn]
17. **Where each rule runs.**
    - **Journey lane (every cycle).** The session hook records, after each settled page-changing
      `pw` command, the taste census and the ease measurements of that screen into
      `<run>/taste/<slot>/screens.jsonl`, plus one viewport screenshot per screen key (route
      template × viewport × theme) under `<run>/taste/shots/` (0600). The explorer sees none of it
      (no context cost, no channel). After the walks, `argus-live.mjs taste judge` computes every
      rule against the witnesses and writes `<run>/taste/judge.json` rows `{row, rule, class,
      screen, key, measured, expected, witnesses, cost}`. A row is **confirmed** only when the
      confirmation replay (`taste confirm <row>`: the journey's path to that screen in slot `r` on
      a fresh instance, the probe re-run, dark and reduced-motion and fault injection there) measures
      it again — the two-of-two rule for pixels.
    - **The Curator** (`sapu:curator`, Opus, high effort, tools Read and StructuredOutput) is
      dispatched once per cycle with the judge rows and the screenshots' paths. It owes
      aesthetics.md §8's output per screen (substitution test, product half, the one measured
      divergence or the comparison establishing coherence) and a verdict per row (`confirm`,
      `reject` with reason, `polish`). It may add **leads** (a perception naming a rule and a
      screen) that the next judge pass measures first; it can file nothing, and a verdict that
      names no row id is dropped. The guard confines its reads to the run's `taste/` directory.
    - **Smoke suite (CI).** A `taste` project (Chromium, the first width), on by default, runs the
      per-screen rules at the path's screens and after each action, then repeats the census under
      `colorScheme: "dark"` and `reducedMotion: "reduce"` (`page.emulateMedia`). Its annotations are
      `argus-taste` (`{rule, step, key, measured, expected}`), shown as a separate `taste` job in the
      workflow that writes the scorecard to the job summary and exits green. A rule the owner lists
      in `taste.json` `gate` emits `argus-violation` instead, with phase 6's known-violation
      adoption, and the `taste` job then gates. Cross-screen rules (consistency, peers, corpus) run
      only in the lane. The suite embeds the bar's rules and version as a JSON literal in
      `support.ts`; the version joins the file header's digest, so `smoke check` names a suite
      judged against an older bar and `smoke plan` lists `taste-bar <from> → <to>`.
    *Rejected:* letting the explorer run the probes (untrusted, and context-costly); a separate
    taste crawl of the app (the explorers already reach the screens that matter).
18. **SELECT weighs taste and usability debt like money and momus flags.** `score =
    cycles_since_visit × exposure × taste × (1 + commits)`, `taste = 1 + min(1, debt / 4)`, `debt`
    from `taste-state.json` (as built, Z4: queued rows only, the S4 rows together at most ×1.25): each confirmed row of the journey that is open or queued and not
    accepted weighs S2 2, S3 1, S4 0.5; a journey never judged has `debt` 2 (×1.5). The cap at ×2
    equals money's doubling, so a journey's UI debt can lift it as far as handling money does, and
    never further; an unjudged journey rises enough to be looked at within a few cycles.
    *Rejected:* an additive bonus (it would be swamped by `cycles × exposure`); an uncapped factor
    (cosmetic debt outranking money).
19. **Filing: first-class `ux` issues, precise and capped.**
    - Labels: `ux`, `argus`, `found-by:user`; `bug` too for `implicit` and `derived` rows (aesthetics.md
      §2's routes); a `bar` row never carries `bug`.
    - Severity: aesthetics.md §7 (what the user did because of what they saw), plus efficiency: a
      confirmed efficiency regression (D3) or a `klm_s` cost ≥ 10 s per run on a journey is S3;
      `bar` rows are S4 unless they carry that cost.
    - Title key `taste:<rule>:<screen key>`, deduplicated through `taste-state.json` and the open
      issues' titles; the body carries `Viewport:`, `Measured:` (value → expected, the witnesses
      and the bar version), the rule's citation, and the screenshot only through scrub's screenshot
      verdict (phase 4).
    - needs-owner only for a genuine judgment call: a `consistent.*` row with no majority (two
      screens, two ways), or a row the Curator's verdict decided. Otherwise none.
    - **Cap:** `taste.cap` issues per cycle (default 5), ranked by severity, then cost, then
      witnesses; the rest stay `queued` and rank again next cycle. Measured S4 coherence items go to
      the one `[polish]` roll-up (aesthetics.md §7).
    - **Accepted:** `taste.json` `accept` rows never file and never weigh in SELECT. The owner closing
      a taste issue as not planned is their ruling: the orchestrator stages `taste accept <rule>
      <key>` only on their word (the guard refuses it to subagents), as `smoke retire` works.
    - Thresholds for count rules: beyond `max(best peer × 1.5, best peer + 3)` and, where the band
      is a witness, beyond its p90. *As built (Z4):* `max(median × 2, median + 3)` of at least three
      other peers of the same declared archetype, width and theme and a similar size, and beyond any
      band's p50 (the phase-end review: a corpus p90 page must hold against a p10 peer).
    - *As built (Z4):* a `bar` row's band compares the screen's own per-screen number under the rule's
      metric (every `bar` rule has one, recorded by the probes); the shipped bar holds no band until a
      maintainer confirms the corpus sites' terms, so no `bar` row files yet.
    *Rejected:* filing every census divergence (spam); needs-owner on every taste issue (it would
    read as "probably not a bug").
20. **The report leads with the scorecard.** `report` opens with `## Taste and usability`: per
    journey the screens judged, rows confirmed / queued / accepted by family, efficiency (`actions`
    and the best, `klm_s`, `typed`, `fitts_bits`, `modals`, `wait_ms`, `recovery`), the cognitive
    walkthrough's pass rate (its `clicks` and `term` now numbers), the Curator's substitution
    verdicts, and the bar version; the functional sections follow.
21. **Freshness by procedure, not by scraper.** The bar is reviewed on each sapu minor release
    and at least twice a year, and whenever a researched system publishes a new major version:
    re-read the sources (this research's table), re-run calibration, `taste-calibrate --diff`
    prints each metric's band before and after, a maintainer reviews the pull request (sources
    cited, corpus changes justified), and the bar's `version` goes up by one. A suite records the
    version it was judged against (D17); a report names it. A site joins or leaves the corpus only
    with a read justification source and a terms review.
22. **Security, unchanged and extended.** Loopback only, the untrusted explorer, fenced page text
    and masked secrets stay. New: the Curator reads only its run's `taste/` files and has no Bash;
    judge rows hold page text (accessible names, labels) and are fenced wherever printed; the
    calibration script is not in the plugin and is refused to subagents; nothing of the reference
    sites but numbers and URLs is committed. Fences stay hygiene, the confinement and gates the
    boundary (phase 6 D19).
23. **Version 2.11.0** at the end (new file `.argus/taste.json`, a new agent, a new lane oracle).
    If 2.10.0 is still untagged when this phase closes, phase 7 rides in it and the upgrade note
    grows; Task Z4 decides from `git ls-remote --tags`.

---

## Lanes, models, merge order

Lane 0 is sequential and lands first: every shared hotspot (config schema, CLI dispatch, the guard,
CONTRACT.md, the DAG test, the DSL's lane oracle, the codegen split, the bar's schema). After it,
lanes T1, T2, J, S, F and K run in parallel worktrees on disjoint files. Lane Z is sequential and
last. No lane edits the spec; Z4 folds in the as-built notes.

**Rules for parallel lanes** (phase 6's, unchanged): a lane edits only its row's files, implements
lane 0's stubs with lane 0's signatures, never edits `argus-live.mjs`, `-config.mjs`,
`-tastecfg.mjs`, `sapu-guard.mjs`, CONTRACT.md, the DAG test or the spec, and reports a missing hook
to lane 0. Engine text waits for lane Z.

| Lane | Tasks | Owns | Model mix | Estimate |
|---|---|---|---|---|
| 0 | 0.1 → 0.2 → 0.3 → 0.4 | `argus-live.mjs`, `-tastecfg.mjs` (new), `-steps.mjs`, `-classes.mjs`, `-return.mjs`, `-codegen.mjs` → `-codegen.mjs` + `-codeproj.mjs` (split), `sapu-guard.mjs`, CONTRACT.md, `plugins/sapu/data/taste-bar.json`, `tests/argus-live-findings.test.ts`, `tests/argus-live-taste.test.ts` (new), `tests/sapu-guard.test.ts`, every new module's stub | 0.1, 0.3 sonnet-medium; 0.2, 0.4 opus-high | 6 h |
| T1 | T1.1 → T1.2 → T1.3 | `-taste.mjs`, `tests/argus-live-tasteprobe.test.ts`, `tests/fixtures/journey-app/pages/taste/` | T1.1 sonnet-medium; T1.2 (colour, dark) opus-high; T1.3 sonnet-medium | 6 h |
| T2 | T2.1 → T2.2 → T2.3 | `-ease.mjs`, `tests/argus-live-ease.test.ts`, `tests/fixtures/journey-app/pages/ease/` | T2.1, T2.2 sonnet-medium; T2.3 (consistency) opus-high | 5 h |
| J | J1 → J2 → J3 | `-session.mjs`, `-browser.mjs`, `-tastejudge.mjs` (new), `-map.mjs`, `tests/argus-live-tastejudge.test.ts` | opus-high | 7 h |
| S | S1 → S2 | `-codegen.mjs` and `-codeproj.mjs` (after lane 0's split), `-propose.mjs`, `tests/argus-live-codegen.test.ts` | S1 sonnet-medium; S2 (workflow) opus-high | 4.5 h |
| F | F1 → F2 | `-report.mjs`, `-tastefile.mjs` (new), `tests/argus-live-tastefile.test.ts` | opus-high | 4 h |
| K | K1 → K2 → K3 | `scripts/taste-calibrate.mjs`, `scripts/taste-corpus.json`, `tests/taste-calibrate.test.ts` | K1 sonnet-medium; K2, K3 opus-high | 5 h |
| Z | Z1 → Z2 → Z3 → Z4 | `agents/curator.md`, engine text, docs, diagrams, spec, roadmap, this plan | Z1, Z3 sonnet-medium; Z2 opus-high; Z4 review Opus | 6 h |

**Merge order after lane 0:** T1, T2, J, S, F, K. T1 and T2 go first because J, S and F call
their probes; K needs only the probe sources and may merge any time after T2.

Critical path ≈ lane 0 (6 h) + the longest lane (J, 7 h) + merges (2 h) + Z (6 h) ≈ 21 h wall-clock,
against ≈ 43.5 h serial.

**Signatures lane 0 fixes.** Each verb returns `{code, lines}`.

| Module | Signatures |
|---|---|
| `-taste.mjs` | `TASTE_SOURCE` (in-page), `CHECKS` (project `taste`), `censusOf(page)`, `rulesFor(screen, bar, cfg)` |
| `-ease.mjs` | `EASE_SOURCE` (in-page), `CHECKS`, `pathCost(steps, geometry)` → `{actions, typed, modals, fitts_bits, klm_s}` |
| `-tastejudge.mjs` | `tasteJudge(main, {run})`, `tasteConfirm(main, ref)` |
| `-tastefile.mjs` | `tasteFile(main, {run, cap})`, `tasteAccept(main, rule, key)` |
| `-tastecfg.mjs` | `loadTaste(main)`, `validateTaste(raw)`, `TASTE_KEYS`, `loadBar()`, `validateBar(raw)` |
| `scripts/taste-calibrate.mjs` (repo root) | CLI: `--network --corpus <file> --out <bar> [--diff]`; without `--network` it only validates the corpus and prints the plan (the explicit opt-in); the guard refuses it to every subagent |

---

## File structure

| File | Responsibility |
|---|---|
| `plugins/sapu/data/taste-bar.json` | the bar: rules, frames, archetypes, sources, `version`, `probe` digest (0.2; archetypes from K3) |
| `scripts/argus-live-tastecfg.mjs` | new: `.argus/taste.json` and the bar's loaders and validators (0.2) |
| `scripts/argus-live-steps.mjs`, `-classes.mjs`, `-return.mjs` | the lane oracle `taste` (final `{kind: "taste", rule, key}`) and its class row (0.3) |
| `scripts/argus-live-codegen.mjs`, `-codeproj.mjs` | split: projects and the check registry move to `-codeproj.mjs` (0.3); the `taste` project and the bar literal (S1) |
| `scripts/argus-live-taste.mjs` | new leaf: visual probes and their emitters (T1) |
| `scripts/argus-live-ease.mjs` | new leaf: feedback, loaders, states, copy, efficiency, consistency probes (T2) |
| `scripts/argus-live-session.mjs`, `-browser.mjs` | the hook's taste recording, screenshots per screen key (J1) |
| `scripts/argus-live-tastejudge.mjs` | new: judge, witnesses, peers, bands, confirmation replay, `taste-state.json` (J2) |
| `scripts/argus-live-map.mjs` | SELECT's `taste` factor (J3) |
| `scripts/argus-live-tastefile.mjs`, `-report.mjs` | new: filing, cap, accept (F1); the scorecard first (F2) |
| `scripts/argus-live-propose.mjs` | the workflow's `taste` job (S2) |
| `scripts/argus-live.mjs`, `scripts/sapu-guard.mjs`, CONTRACT.md | verbs `taste judge|confirm|file|accept`; curator confinement, calibration refusal (0.2, 0.4) |
| `scripts/taste-calibrate.mjs`, `scripts/taste-corpus.json` (repo root, not shipped) | calibration (K) |
| `agents/curator.md`, `skills/argus/aesthetics.md`, `journeys.md`, `SKILL.md`, `standards.md`, `skills/journey/*.md`, `skills/init/SKILL.md` | engine text (Z2) |
| `README.md`, `docs/usage.md`, `docs/security.md`, `docs/agents.md`, diagrams | Z3 |

---

## Lane 0 — prerequisites (sequential, lands first)

### Task 0.1: probe the pinned runner
**Model: sonnet-medium.** No production code. On the pinned alpha and on stable 1.64.0, against
`tests/fixtures/journey-app`, record in "As built" (yes/no with the observed output):
`page.emulateMedia({colorScheme: "dark", reducedMotion: "reduce"})` changes `matchMedia` answers in
place; `document.getAnimations()` lists CSS transitions, CSS animations and a view transition's
pseudo-element animations with their `effect.getTiming()`; a `MutationObserver` armed by
`run-code` before a click sees the first mutation with a `performance.now()` timestamp comparable
with the click's dispatch; `page.route` answering 500 to one `fetch` works through the lane's
proxy; a viewport screenshot per screen costs under 300 ms on the fixture.
- [x] Probe; write the outcomes (see "As built (phase 7)"). **Commit** `test(sapu): phase 7 runner probe — media emulation, animations, first mutation, routed fault`.

### Task 0.2: shared surfaces
**Model: opus-high.**
- [ ] **Failing tests:** `validateTaste` refuses unknown keys, a non-glob archetype key, an archetype
  outside the five, a `gate`/`off`/`accept` rule id the bar lacks, `cap` outside 1–20; `validateBar`
  refuses a rule without `cite`, a band with `n` under its sites, a string field beyond URLs and
  metric names in `archetypes` (the numbers-only rule as a test); the bar v1 file validates and
  every rule cites an id present in the research doc (a test reads the doc's ids); the guard
  refuses `taste-calibrate` in any Bash command of a subagent, `taste accept` to every subagent,
  and a `sapu:curator` Read outside `<run>/taste/`; CONTRACT.md lists `.argus/taste.json` and
  `.argus/taste-state.json`.
- [ ] Run → FAIL; implement (bar v1 holds the rules and frames of D4–D14 with their research ids;
  `archetypes` empty until K3); run → PASS.
- [ ] **Commit** `feat(sapu): argus-live taste bar and taste.json — schema, guard rules, contract rows` (`Rule-Change:` trailer).

### Task 0.3: the lane oracle and the codegen split
**Model: sonnet-medium.** `taste` joins `LANE_ORACLES` (the explorer can never submit it); a final
`{kind: "taste", rule, key}` re-runs one rule on the replay's screen; `classify --oracle taste` →
`ux` (and `bug` per the rule's class). Move `suiteProjects`, the check registry and `smokeConfig`
from `-codegen.mjs` to `-codeproj.mjs` with no behaviour change (the generated files byte-identical,
tested).
- [ ] **Commit** `refactor(sapu): argus-live codegen split; the taste lane oracle`.

### Task 0.4: verbs and stubs
**Model: opus-high.** Dispatch and usage for `taste judge [--run]`, `taste confirm <ref>`,
`taste file [--run]`, `taste accept <rule> <key>` (orchestrator only); stubs that throw for every
signature above; the DAG test learns the new modules (`-taste`, `-ease` leaves; `-tastejudge`
imports them and `-tastecfg`).
- [ ] **Commit** `feat(sapu): argus-live taste verbs and module stubs`.

## Lane T1 — visual probes

### T1.1: census, restraint, scale
**Model: sonnet-medium.** Fixture pages: one on a 4 px scale with tokens, one with 11 spacing
values, one with three filled primary buttons, one with an h2 larger than its h1, siblings off by
2 px and by 8 px, five shadows on two layers, a child radius larger than its parent's.
- [ ] **Failing tests:** each positive reported with a stable key, each twin silent; fluid
  (`clamp()`) type bucketed per viewport, not flagged; counts match a hand count; colours
  resolved through the canvas (an `oklch()` page scores like its sRGB twin) [mdn-oklch].
- [ ] **Commit** `feat(sapu): argus-live taste probes — census, restraint, hierarchy, alignment`.

### T1.2: colour roles and dark parity
**Model: opus-high.** Fixtures: a status in two colours on two pages; a theme whose dark border
collapses; a dark page with one light card; a single-theme app.
- [ ] **Failing tests:** role divergence `derived`; dark-only contrast failure and collapsed border
  `implicit`; the single-theme app reports `single theme`, nothing filed; `contrast.headroom` is
  `argus-info` only.
- [ ] **Commit** `feat(sapu): argus-live taste probes — colour roles, dark parity, contrast headroom`.

### T1.3: motion and density
**Model: sonnet-medium.** Fixtures: a 900 ms panel slide, a `width` transition that pushes a
sibling, `transition: all`, a transform animation that ignores reduced motion, a 200 ms opacity
fade (twin), three button heights on one screen.
- [ ] **Failing tests:** each rule of D9 and D11 with its class; the twin silent; SC 2.3.3 cited as
  AAA.
- [ ] **Commit** `feat(sapu): argus-live taste probes — motion and density`.

## Lane T2 — ease probes

### T2.1: feedback and loaders
**Model: sonnet-medium.** Fixture endpoints with fixed delays (50 ms, 1.5 s with and without
`aria-busy`, 12 s with and without a determinate bar), a loader shown for 120 ms, a skeleton that
shifts on replace.
- [ ] **Failing tests:** D10's thresholds, each side of each; the measured time within ±50 ms of the
  fixture's delay.
- [ ] **Commit** `feat(sapu): argus-live ease probes — feedback latency and loaders`.

### T2.2: states, copy, efficiency
**Model: sonnet-medium.**
- [ ] **Failing tests:** the routed 500 yields `implicit` on a blank page and holds on a page with
  a retry; a form that clears other fields on error counts each lost value; broken copy tokens;
  vague labels only under a matching `lang`; `pathCost` of a fixture path equals a hand KLM sum
  (K .28, BB .2, H .4, M 1.2, P from Fitts bounded 0.8–1.5) [klm] [fitts-mackenzie].
- [ ] **Commit** `feat(sapu): argus-live ease probes — states, copy, path cost`.

### T2.3: consistency
**Model: opus-high.** Fixtures: one endpoint reached by a "Save" button and a "Submit" link; dialogs
with the primary first and last; a form with autosave and a submit; a palette opened by Mod+K on
one page only.
- [ ] **Failing tests:** each `derived`; a two-way split with no majority is marked `needs-owner`.
- [ ] **Commit** `feat(sapu): argus-live ease probes — consistency across screens`.

## Lane J — the journey lane's pass

### J1: recording in the hook
**Model: opus-high.** After each settled page-changing `pw` command, the hook records the screen's
census and ease measurements and, once per screen key, a viewport screenshot (0600). The explorer's
output is byte-identical with and without recording (tested); recording failure is a harness event,
never an explorer error.
- [ ] **Commit** `feat(sapu): argus-live records every screen an explorer reaches for the taste pass`.

### J2: judge and confirm
**Model: opus-high.**
- [ ] **Failing tests:** witnesses per D5 (a `bar` row with only the band is not a row); peers are the
  app's best screen of the archetype among ≥ 3; thresholds per D19; inferred archetypes never a
  witness; `thin` bands shown only; the best known path kept and replaced only by a held shorter
  path; an efficiency regression only when the best path fails; `taste confirm` replays to the
  screen in slot `r`, runs dark, reduced motion and the routed fault there, and confirms only a
  re-measured row; judge output fenced wherever printed.
- [ ] **Commit** `feat(sapu): argus-live taste judge — witnesses, peers, bands, two-visit confirmation`.

### J3: SELECT's taste factor
**Model: opus-high.**
- [ ] **Failing tests:** D18's formula; accepted rows weigh nothing; an unjudged journey ×1.5; the
  factor caps at ×2; a money journey with equal staleness and no debt ties a non-money journey at
  full debt.
- [ ] **Commit** `feat(sapu): argus-live SELECT weighs taste and usability debt`.

## Lane S — the suite

### S1: the taste project
**Model: sonnet-medium.**
- [ ] **Failing tests:** the `taste` project exists by default, Chromium, first width; it emits
  `argus-taste` annotations and never fails unless a rule is in `gate`; gated rules emit
  `argus-violation` and respect `known/<id>.json`; the bar's version is in the header digest;
  `smoke check` flags a suite on an older bar; generated code passes phase 6's scans (no hard
  waits, strings as JSON literals).
- [ ] **Commit** `feat(sapu): argus-live smoke suite — the taste project, advisory by default`.

### S2: the workflow's taste job
**Model: opus-high.** A `taste` job in the generated workflow (same container, same pins, same
`env:`-only inputs) that writes the scorecard to `$GITHUB_STEP_SUMMARY` (page text defanged and
capped at 200 characters an item) and stays green unless `gate` is non-empty.
- [ ] **Commit** `feat(sapu): argus-live smoke workflow — a separate taste job and its summary`.

## Lane F — filing and the report

### F1: file, cap, accept
**Model: opus-high.**
- [ ] **Failing tests:** labels and severity per D19; one issue per `taste:<rule>:<screen key>`; the
  cap holds and the rest stay `queued`; accepted rows never file; needs-owner only on the two
  judgment cases; everything goes through `scrub --create` and its screenshot verdicts; the polish
  roll-up takes measured S4 items only.
- [ ] **Commit** `feat(sapu): argus-live files taste and usability findings — capped, deduplicated, precise`.

### F2: the scorecard first
**Model: opus-high.**
- [ ] **Failing tests:** the report's first section is `## Taste and usability` with D20's fields
  and the bar version; free text capped, defanged, scrubbed as phase 6.
- [ ] **Commit** `feat(sapu): argus-live report leads with the taste and usability scorecard`.

## Lane K — calibration (maintainer only)

### K1: the script
**Model: sonnet-medium.** `scripts/taste-calibrate.mjs` drives the pinned install's Chromium over
`scripts/taste-corpus.json`'s pages, runs `TASTE_SOURCE` and `EASE_SOURCE`'s page-only parts
(no actions, no faults), and writes the bar's `archetypes`.
- [ ] **Failing tests** (offline, against loopback fixture pages): robots disallow honoured for `*`
  and for `sapu-taste-calibration`; one page per site per 10 s; percentiles exact on a known set;
  the output holds no string but URLs and metric names (a fixture page with a secret-looking text
  must not leak); `--diff` prints each band's change; without `--network` nothing is fetched.
- [ ] **Commit** `feat(sapu): taste calibration script — numbers only, robots and pace honoured`.

### K2: the corpus file
**Model: opus-high.** `scripts/taste-corpus.json` from the research's admitted sites: per page
`{url, site, archetype, source, terms_reviewed_by}`; at least 15 pages each for `marketing` and
`docs`, as many as public pages allow for `app`, `form`, `data`; the research's coverage statement
copied into the file's header.
- [ ] **Commit** `chore(sapu): the taste reference corpus — admitted sites, archetypes, sources`.

### K3: first calibration
**Model: opus-high**, run by the maintainer's main session (the guard refuses subagents). Run the
script, review every band for plausibility (a band driven by one site is cut), write the numbers
into the bar, bump `version` to 1 with the bands, and record in "As built" which archetypes are
witnesses and which are `thin`.
- [ ] **Commit** `feat(sapu): taste bar v1 calibrated against the reference corpus`.

## Lane Z — integration (sequential, last)

### Z1: the Curator agent
**Model: sonnet-medium.** `agents/curator.md` (`tools: Read, StructuredOutput`, Opus, high), its
charter and return shape, `validateCurator` in `-tastejudge.mjs`; an engine test pins its
frontmatter.

### Z2: engine text
**Model: opus-high.** aesthetics.md gains §9 (the journey lane's pass, the bar, the witnesses,
efficiency); journeys.md drops the Curator's exemption and names the pass; SKILL.md's Curator role;
standards.md cites SC 2.3.3 (AAA) and 2.2.2 (A) verbatim; `/journey` and `smoke.md` describe the
taste project and job; `/sapu:init` offers `.argus/taste.json` with the frame question.

### Z3: docs and diagrams
**Model: sonnet-medium.** README, usage (taste.json, the scorecard, promoting a rule), security
(the Curator, calibration's boundary), agents.md, the journey and smoke diagrams.

### Z4: whole suite, review, as built
**Model: Opus review.** `npx vitest run`; the phase-end team review of the whole phase diff
(architect, writer, QA); spec §20 marked built with its as-built notes; the version per D23.

---

## Out of scope, and covered elsewhere

Out: judging native mobile apps; measuring satisfaction (no script can); A/B or field analytics;
copying any reference site's visuals; a logged-in reference corpus. Covered: contrast and names are
phase 6's axe rules; target size is phase 6's layout oracle; Web Vitals are phase 6's perf lane.

## Open risks

1. **Thin `app` and `form` bands.** Most world-class app chrome is behind a login, so those bands
   may stay `thin` and act only through tokens and peers. Mitigation: D16's witness rule; the
   update procedure admits public demos as they appear.
2. **False positives from inferred archetypes.** Mitigation: inferred archetypes are never a
   witness; owners map routes in `taste.json`.
3. **KLM's M placement** is a modelling choice. Mitigation: fixed and documented (one M per goal
   step), used only to compare a path with its own best, never as an absolute verdict.
4. **Recording overhead on long walks.** Task 0.1 measures screenshot cost; recording is once per
   screen key.
5. **Bar drift between releases.** Mitigation: the version in every suite and report, `smoke plan`
   listing the upgrade, and D21's procedure.

---

## As built (phase 7)

### Task 0.1 — the pinned runner and CLI, probed live

Probed with the pinned install's `node_modules/playwright/cli.js test` (`1.64.0-alpha-1790635538000`, the
phase 6 stub `@playwright/test` in front of it), stable `@playwright/test` `1.64.0` installed into a scratch
directory, and the pinned CLI's (`@playwright/cli` 0.1.22) `run-code` through the lane's own slot config and
proxy (`browserRun`), all on Chrome 154 (`channel: "chrome"`, headless), signed in as a fixture buyer, against
`tests/fixtures/journey-app`. The fixture has no transition, animation or view transition of its own, so the
probes inject styles and elements into `/inject` (and use the order page's own `fetch` for the routed fault).
The same self-contained probe functions ran in all three; **every row is identical on the pinned alpha, stable
1.64.0 and the CLI**, except where a row says otherwise. The machine's load average was about 43 throughout,
so every time below is a loaded-machine figure.

| Probe | Result | Observed |
|---|---|---|
| `page.emulateMedia({colorScheme: "dark", reducedMotion: "reduce"})` changes `matchMedia` in place | yes | Same document (a marker survives): `(prefers-color-scheme: dark)` false → true, `light` true → false, `(prefers-reduced-motion: reduce)` false → true, and an injected `@media` rule restyles at once (`background` white → `rgb(1, 2, 3)`). |
| The `change` events of those queries | yes, late | They fire one task after `emulateMedia` resolves (a read right after sees none on stable and in the CLI; the alpha had them already); read `matches`, never wait for the event. |
| Emulation survives a navigation | yes | The next document answers dark and reduce at once. |
| A partial `emulateMedia` keeps the other axis | yes | `{colorScheme: "light"}` after dark+reduce leaves `reduce` true. |
| `colorScheme: null` restores the browser default | **trap** | A fresh context answers light (Playwright's default), but `null` (and the CLI's `clear-color-scheme`) hands the choice to the OS: on this dark-mode machine it answers dark. Restore with `"light"` and `"no-preference"`, never `null`. `reducedMotion: null` returns to `no-preference` here. |
| The CLI's emulation commands | partly | `set-color-scheme`, `set-reduced-motion`, `clear-*` work and persist across calls (they print `page.emulateMedia(...)`), as does `emulateMedia` inside `run-code` (a later `run-code` sees it); none is on the explorer's `pw` allowlist, so the lane's own `run-code` templates do the emulation. |
| `document.getAnimations()` lists CSS transitions | yes | `CSSTransition`, one per property (`transitionProperty` `transform` / `opacity`), `effect.target` the element, `getTiming()` `{duration: 300, delay: 0, easing: "ease-in", iterations: 1}` (`delay` 50 and `endTime` 170 for a 120 ms transition with a 50 ms delay). |
| ... CSS animations | yes | `CSSAnimation`, `animationName` `grow`, `{duration: 400, iterations: 2, direction: "alternate"}`, `endTime` 800; `Element.animate()` gives a plain `Animation`. |
| ... a view transition's pseudo-element animations | yes | After `startViewTransition(...).ready`: five `CSSAnimation`s with `effect.pseudoElement` `::view-transition-group(root)`, `::view-transition-new(root)` (two) and `::view-transition-old(root)` (two), `effect.target` the `html` element, names `-ua-view-transition-*` and `-ua-mix-blend-mode-plus-lighter`; UA default `duration` 250, 400 when the page sets `animation-duration` on the group. |
| Finished animations stay listed | **no** | Transitions, finite animations and the view transition are gone 900 ms later (`getAnimations().length` 0); an infinite animation stays. A `getAnimations()` in a later CLI call sees only what is still running. |
| Animation events across CLI calls | yes | Listeners armed by one `run-code` (`transitionrun`, `transitionstart`, `transitionend`, `animationstart`, with `performance.now()`) were still recording in a later call; a 200 ms transition read `transitionrun` at t, `transitionend` at t + 215. |
| `getAnimations()` in the action's own call | yes | A `run-code` that clicks, then evaluates, lists the new `CSSTransition` right after the click resolves. |
| Reduced motion does not stop motion by itself | yes | Under `reducedMotion: "reduce"` an authored transform transition (no media query) is still listed `running`; one with `@media (prefers-reduced-motion: reduce) { ... transition: none }` is not listed; the view transition's five UA animations still run. |
| `MutationObserver` armed by `run-code` sees the first mutation with a comparable timestamp | yes | The observer's `performance.now()` is 0.3–0.8 ms after the click listener's (capture phase) for a synchronous change, and 251.4–252.2 ms for a change 250 ms later. `event.timeStamp` (input time) was 1.4–12.5 ms before the listener's `performance.now()` on this load. Page clock (`timeOrigin + performance.now()`) at the click fell inside the Node-side `Date.now()` window of the click call in all three runs (19–130 ms before the call resolved; the windows are 273–476 ms wide because of Playwright's actionability wait), so the two clocks agree to within the cross-process skew, not within the wait. |
| ... which mutation counts as visible | partly | `checkVisibility({checkOpacity: true, checkVisibilityCSS: true})` on an **added node** works (`hidden` element false, `opacity: 0` false, a shown one true); on a `childList` record's `target` (the parent) it says true for a hidden child. A `data-*` attribute set on `body` is a "mutation in a shown element" at 0.3 ms with nothing visible changing; removing `hidden` later is an `attributes` record on the node, visible true at that time. |
| An observer armed before a navigating click survives | **no** | After a link click the new document has no observer (its state object is gone); `page.addInitScript(...)` from `run-code` does run in the next document (and cannot be removed from the session). The click resolved 934–1806 ms after dispatch (the navigation's load), `framenavigated` 538–1472 ms. |
| `page.route` answering 500 to one `fetch` | yes | `page.route("**/*", ...)` filtered to a same-origin `GET` with `resourceType()` `fetch` or `xhr` (the order page's `/api/orders/<id>`, `accept: */*`) and `route.fulfill({status: 500, contentType: "application/json", body})` makes the page's own `fetch` answer 500; the fixture's order page then shows `Status undefined, quantity undefined` (the broken-copy rule's `undefined`, no error state). |
| ... through the lane's proxy | yes | In the CLI session (every request through the run's proxy) the routed 500 works the same, `route.continue()` for the others passes, and the faulted request is fulfilled inside the browser: **the fixture counted no request for it** (the browser made no network request, so the proxy has none to see). |
| ... a route survives | yes | A route set in one `run-code` still answers 500 in a later `run-code`, across a navigation and until `page.unroute`. |
| ... only for a JSON response | yes | `route.fetch()` returns the real response (`content-type: application/json`), the handler fulfils 500 for JSON and `route.fulfill({response})` for anything else; the real request reaches the server once. |
| ... `route.fetch()` and the lane's egress | yes, contained | In the CLI session `route.fetch({url: <another loopback port>})` answered `403` (the listener answers 200 to anything, so the proxy refused it) and got no hit; in the plain runner (no proxy) the same call reached it (200). The page's own `fetch` to it fails in the CLI. |
| A viewport screenshot per screen costs under 300 ms | **partly** | Warm (three throwaway shots first), `page.screenshot` PNG p50 90–105 ms, p90 214–284 ms, max 256–327 ms (JPEG q60 p50 62–64 ms, p90 88–138 ms; dark + reduce PNG p50 84–132 ms), 12–20 KB on the fixture. The **first** shot after a navigation, which is the one the lane records, took 215–777 ms (median 422, nine pages). |
| The cost of one CLI call | **no, large** | A trivial `run-code` took 2.5–6.0 s wall (median 3.6 s) and the CLI's `screenshot` command 3.3–4.8 s, almost all of it the CLI's process and daemon round trip, not the page. |
| Pinned alpha vs stable 1.64.0 | identical | Every row above, apart from the late `change` events and timings. |

**What this changes** (a "no" is never silent; T2.1, T2.2, J1, J2 and 0.3 depend on it):

1. *Colour scheme restore (J1, J2's replay, T1.2, S1).* After a dark or reduced-motion pass the page and the
   session must be put back with `emulateMedia({colorScheme: "light", reducedMotion: "no-preference"})`,
   never `null`: on a dark-mode OS `null` leaves the session dark. The suite (a fresh context per test) is
   unaffected.
2. *D9, motion (T1.3, J1).* A `getAnimations()` read in a later CLI call finds only infinite animations.
   The motion measurement must either run in the action's own `run-code` (click, then read) or come from the
   `transition*` and `animation*` events with their `performance.now()` that the session hook arms once per
   document. View-transition animations are readable only between `ready` and `finished`, so they come from
   the same in-call read; the event route does not see them.
3. *D10, first visible change (T2.1).* "A mutation in a shown element" is too weak on its own: a `data-*` or
   other non-rendering attribute change on a shown element would stop the clock at 0.3 ms. Count a record
   only when its added node (or, for an attribute record, the node) passes `checkVisibility`, and for an
   attribute only the rendering ones (`class`, `style`, `hidden`, `open`, `aria-busy`, `disabled`, `src`).
   The observer dies with the document: a navigation is its own signal, and the arming has to come from the
   session hook's init script on every document, not from an ad hoc `run-code`.
4. *D12, the routed fault (T2.2, J2's replay).* Arm the route **before** the navigation to the screen, and
   `unroute` after. Armed afterwards it faulted the old document's in-flight fetch, and the reloaded screen
   got none (seen in the CLI run). Decide "JSON" with `route.fetch()` plus the response's `content-type`, not
   by `resourceType()` alone. A faulted request reaches neither the proxy nor the server, so a replay must
   not expect it in the fixture's or the app's request counts.
5. *Risk 4 and J1's recording cost.* The screenshot is cheap warm and not under 300 ms for the first shot of
   a screen on a loaded machine; the CLI call that carries it costs seconds. J1 should record a screen's
   census, ease measurements and screenshot in **one** `run-code` per screen, and a walk must not assume
   a per-screen cost under a second until it is measured on an idle machine.

**Contradictions with the plan's decisions, flagged for the owner of each task.**
- *D10 / T2.1:* "a mutation in a shown element" counts a `data-*` change as the first visible change (row
  above; change 3).
- *D9 / T1.3:* `document.getAnimations()` alone cannot measure an action-triggered animation from a later
  call (change 2).
- *Task 0.1's last probe, "under 300 ms":* true warm, false for the first shot of a screen under this
  load; the CLI round trip dominates (change 5).
- *D17 (dark replay) and Z-lane docs:* a reset by `null` is not a reset to light on a dark-mode OS
  (change 1).
- Nothing contradicts D12's use of `page.route` through the proxy or D22's loopback boundary: both hold.

No pinned browser test was added: Task 0.1 asks for none, the facts above hold on both runners, and a Chrome
test here would only add to the CI minutes of files already near the job's bound.

## As built (phase 7)

### Lane 0 — Tasks 0.2, 0.4, 0.3

Commits, in order: 0.2 shared surfaces, 0.4 verbs and stubs, 0.3 as two pieces (the codegen split, then the lane
oracle). Line counts at the end of lane 0: `-steps` 692, `-instance` 684, `-codegen` 573 (was 736), `-browser` 544,
`argus-live.mjs` 475, `-tastecfg` 419, `-codeproj` 186; the stubs `-taste` 38, `-ease` 44, `-tastejudge` 18,
`-tastefile` 13.

**Locked for the lanes: the verbs.** Each returns (or resolves to) `{code, lines, masked?}`, printed as phase 6's are.
A stub throws `refused: <verb>: not built yet` (exit 1). The dispatch reads the line whole first and refuses a
malformed one with the usage; run ids, rows, rules and keys reach the lane as typed, for it to validate. No taste verb
passes a trace gate (they file as argus files); the guard refuses every one to every subagent (`taste` is a verb of
the lane's script).

| Verb | Function (module) |
|---|---|
| `taste judge [--run <runId>]` | `tasteJudge(main, {run})` (`-tastejudge`), `run` null: the lane picks the newest |
| `taste confirm <row>` | `tasteConfirm(main, ref)` (`-tastejudge`) |
| `taste file [--run <runId>]` | `tasteFile(main, {run, cap})` (`-tastefile`); the CLI passes `cap: null`, meaning taste.json's `cap` |
| `taste accept <rule> <key>` | `tasteAccept(main, rule, key)` (`-tastefile`); `key` is the screen key the issue names |
| `classify --oracle taste --class <implicit\|derived\|bar> [--cost]` | `classify({oracle: "taste", tasteClass, cost})` (`-classes`), built (below) |

**Locked: the module exports.** Stubs throw `refused: <name>: not built yet`; each stub's pin is one `it` in the
owning lane's own test file (`tests/argus-live-tasteprobe.test.ts`, `-ease.test.ts`, `-tastejudge.test.ts`,
`-tastefile.test.ts`), for that lane to replace.

| Module | Exports |
|---|---|
| `-taste.mjs` (leaf, T1) | `TASTE_SOURCE` (an in-page function's source `(arg) => result`, run as `(${TASTE_SOURCE})(arg)`), `TASTE_INIT` (the motion recorder of the init payload; `""` until built), `CHECKS` (`[]`), `censusOf(page)` (async), `rulesFor(screen, bar, cfg)`, `ruleExpression(rule)` |
| `-ease.mjs` (leaf, T2) | `EASE_SOURCE`, `EASE_INIT` (the feedback clock; `""` until built), `CHECKS` (`[]`), `pathCost(steps, geometry)` → `{actions, typed, modals, fitts_bits, klm_s}`, `easeOf(page)` (async), `rulesFor(screen, bar, cfg)`, `ruleExpression(rule)` |
| `-tastecfg.mjs` (leaf, lane 0, built) | `BAR_FILE`, `loadBar()` (validated once, frozen; a broken bar throws `failed: the taste bar …`), `validateBar(raw)` → `{value, errors}`, `RULE_CLASSES`, `FAMILIES`, `ARCHETYPES`; `TASTE_FILE`, `TASTE_KEYS`, `TASTE_DEFAULTS`, `validateTaste(raw, bar = loadBar())` → `{value, errors}`, `loadTaste(main)` → `{taste, errors, missing}`, `routeMatches(glob, route)`; `TASTE_STATE_FILE`, `ROW_STATES`, `SCREEN_KEY`, `titleKey(rule, screen)`, `readTasteState(main)`, `writeTasteState(main, state)`; `TASTE_BUFFER`, `TASTE_DRAIN`, `TASTE_EVENTS`, `TASTE_EVENTS_MAX`, `tasteEventFault(e)`, `RENDER_ATTRIBUTES`, `MEDIA_READ`, `explicitMedia(m)`, `TASTE_BUDGET_MS` |
| `-tastejudge.mjs` (J) | `tasteJudge(main, {run})`, `tasteConfirm(main, ref)`; it imports both probes and `-tastecfg` already |
| `-tastefile.mjs` (F) | `tasteFile(main, {run, cap})`, `tasteAccept(main, rule, key)` |
| `-codeproj.mjs` (S, split from `-codegen`) | `suiteProjects`, `PROJECT_NAME`, `suiteChecks()` (the registry, read at each call), `checkSources()`, `projectChecks(projects)`, `smokeConfig`, `withHeader`, `headerDigest`, `literal`, `upTo`, `CODEGEN_VERSION`. `-codegen` re-exports `CODEGEN_VERSION`, `headerDigest`, `literal`, `smokeConfig` and `suiteProjects`, so its importers did not change. S1 adds the taste and ease `CHECKS` to `suiteChecks`. |
| `-browser.mjs` (J's file, lane 0's seam) | `PAGE_INIT`: the session hook's init payload (below) |

`rulesFor` is exported by both probe modules (each for its families); `ruleExpression(rule)` too: a page expression
evaluating to that screen rule's rows on the current page. Which module measures a family is `FAMILIES[family].probe`;
`FAMILIES[family].scope` is `screen` or `cycle` (`consistent`, `efficiency`: only the judge compares them).

**Locked: the module order.** Leaves: `-taste`, `-ease`, `-tastecfg` (beside `-layout`, `-a11y`). `-codeproj` sits
before `-codegen`. `-tastejudge` then `-tastefile` sit after `-baseline` and before `-report`; no module but
`argus-live.mjs` and `-report` reaches them, and `-tastejudge` never reaches `-tastefile`. Allowed now, for lanes that
cannot edit the DAG test: `-map` may import `-tastecfg` (J3 reads the state through it), `-steps` imports both probes
and `-tastecfg`, `-browser` imports both probes and `-tastecfg`, `-codeproj` may import `-layout`, `-a11y`, `-taste`,
`-ease` and `-tastecfg`.

**Locked: the shared record formats.**
- *The bar* (`plugins/sapu/data/taste-bar.json`): `{version, probe, sources, rules, frames, archetypes}`. `version` 1
  (K3 keeps 1: nothing ships between; the next calibration after a release is 2). `probe` null until K3 sets the
  sha256 of the probe sources it measured with. `sources` maps each cited research id to its https URL. A rule is
  `{id: "<family>.<name>", family, class, metric, threshold, cite, gate: false, info?: true, terms?: {<lang>:
  [labels]}}`; a threshold is an object of `min`, `max` (fire past them), `range` (fires outside), `within` (fires
  inside), `peer: [ratio, plus]` with `band: "p10"|"p50"|"p90"` (decision 19's count rule), `ratio`, `plus_s`,
  `opacity_max`, `min_wait`. A frame is `{cite, historical?, spacing?, radius?, type?, durations?, layers?}`, each
  metric `{values: [ascending]}` or `{range: [min, max], step?}`. A band is `archetypes.<archetype>.<metric> = {n,
  sites, p10, p50, p90, urls}`, numbers, metric names and https URLs only (n ≥ sites, p10 ≤ p50 ≤ p90, at most n
  URLs).
- *The rule ids* (47 rules, 12 families): `scale.{spacing,type,weights,colours,radii,shadows,off-scale}`,
  `hierarchy.{primary-actions,heading-order,alignment,section-gaps,shadow-layers,nested-radius}`,
  `colour.{role,dark-contrast,dark-border,dark-surface}`, `contrast.headroom`,
  `motion.{duration,layout-property,transition-all,reduced}`,
  `feedback.{latency,busy,progress,loader-flash,skeleton-peers,skeleton-shift,optimistic}`,
  `density.{control-heights,row-heights}`, `states.{error,empty-next,success,recovery,error-exit}`,
  `copy.{broken,vague}`, `consistent.{action,footer-order,save-pattern,palette}`, `ai.{stop,error,regenerate}`,
  `efficiency.{actions,klm}`. Information only (`info: true`, never filed or gated): `contrast.headroom`,
  `motion.transition-all`, `feedback.latency`, `states.error-exit`.
- *A finding* (what `rulesFor` and `ruleExpression` return, one per element or screen): `{rule, key, measured,
  expected}`; `key` stable across visits (digit runs written `#`, as the layout keys are), at most 300 characters, no
  newline; `measured` and `expected` a number or a short string (page text: fenced wherever printed).
- *A screen key*: `<route template>|<viewport width>|<light|dark>` (`SCREEN_KEY`), e.g. `/orders/:id|1440|light`.
  The issue's title key and the state's row key: `taste:<rule>:<screen key>` (`titleKey`). `accept[].key` and `taste
  accept`'s key are screen keys.
- *The judge's rows* (`<run>/taste/judge.json`, J writes; F, the Curator and the report read): `{version: 1, run, bar:
  <bar version>, rows: [...], journeys: {<id>: {screens, efficiency}}}`; a row is `{row: "t<k>", journey, rule, class,
  screen, key, measured, expected, witnesses: [{kind: "tokens"|"frame"|"peer"|"band", value, from}], cost: <klm_s
  seconds>|null, confirmed: null|true|false}`. The plan's row lacked `journey` (debt is per journey) and `confirmed`
  (two of two).
- *Efficiency* (a journey's, judge.json and the scorecard): `{actions, best, klm_s, typed, fitts_bits, modals,
  wait_ms, recovery}`, `pathCost`'s five plus `best` (the best path's actions), `wait_ms`, `recovery`.
- *The scorecard row* (the report's per journey, F2): `{journey, screens, rows: {<family>: {confirmed, queued,
  accepted}}, efficiency, walkthrough: {pass, total}, curator: {confirm, reject, polish}, bar}`.
- *The Curator's return* (Z1's `validateCurator`; J and F read it): verdicts `{row, verdict:
  "confirm"|"reject"|"polish", reason}` (a verdict naming no row of judge.json is dropped), leads `{rule, screen}`.
- *`.argus/taste-state.json`* (0600, `readTasteState`/`writeTasteState` only, either refuses another shape): `{version:
  1, journeys: {<id>: {judged: <runId>|null, best: {run, actions, klm_s, pathSha}|null, rows: {<title key>: {rule,
  screen, class, severity: "S1".."S4", state: "queued"|"open"|"closed"|"accepted", issue: <url>|null, first: <runId>,
  last: <runId>}}}}}`. Only confirmed rows are kept. For D18's debt S1 weighs as S2 (2).
- *The suite's annotation*: type `argus-taste`, description JSON `{rule, step, key, measured, expected}`; a gated
  rule's is `argus-violation` (phase 6's).
- *The bar version stamp*: written `taste-bar <n>` wherever stamped or printed: the suite's header `Generated by sapu
  (argus-live codegen <v>, taste-bar <n>, digest <sha>)`, `smoke plan`'s `taste-bar <from> → <to>`, the report and an
  issue's `Measured:` line.
- *The `taste` final* (0.3): `{as, expect: "taste", rule, key, final: "taste"}`. `rule` a screen rule of the bar
  (`refused: repro: step <n>: taste takes a screen rule of the bar (rule) and a key`), `key` 1–300 characters; never a
  path's (`a path has no taste expectation: the suite runs the taste checks after every step`) nor a regression's
  final; the RED test refuses it. In the run-code, `P = {kind: "taste", rule, key, expr: ruleExpression(rule)}`; held
  when no row of `rule` has `key`, else `observed: "rows:<k>"`, `shown: [{key, measured}]` (at most 20). For a
  `derived` count rule the cross-screen threshold is J2's: it reads `shown`.
- *classify*: `--oracle taste` needs `--class`; `implicit`/`derived` → `class taste labels bug,ux,argus,found-by:user
  severity by outcome` (`at least S3` with `--cost`), `bar` → `labels ux,argus,found-by:user severity S4` (`S3` with
  `--cost`). `--class`/`--cost` on another oracle: `refused: classify: --class and --cost are the taste oracle's`.

**Post-probe decisions (Task 0.1's five, decided by the coordinator, built as seams here).**
1. *The feedback clock (D10, T2.1).* Only rendering-relevant changes count: an added node passing `checkVisibility`,
   or an attribute of `RENDER_ATTRIBUTES` (`class`, `style`, `hidden`, `aria-hidden`, `open`, `disabled`,
   `aria-expanded`, `aria-selected`, `aria-busy`), never a `data-*` one. The observer is armed by the session hook's
   init payload in every document (`EASE_INIT`), never by an ad hoc run-code.
2. *Animations (D9, T1.3).* Finished animations leave `getAnimations()` within a second: the action's own run-code
   reads `getAnimations()` (view transitions between `ready` and `finished`), and `TASTE_INIT` records
   `transitionrun/start/end` and `animationstart/end` into the buffer.
   *The seam for 1 and 2:* `PAGE_INIT` (`-browser`) = `SIGNAL_SCRIPT`, then `TASTE_BUFFER`, then `TASTE_INIT`, then
   `EASE_INIT` (empty ones left out). The slot's init script file (`signals.js`) holds it, and the hook stage
   evaluates it again at every domcontentloaded (in a perf pass, followed by `PERF_SCRIPT`). It lives in `-browser`,
   not `-session` or `-hooks`: `writeSlotConfig` (in `-browser`) writes the file and `-session` (above it) passes it to
   the hook, so `-browser` is the lowest module both reach; `-hooks` is live.json's argv hooks, not the browser's.
   *The buffer:* once a document, `document.__argusTasteEvents` (at most `TASTE_EVENTS_MAX`, 1000), written only
   through `document.__argusTastePush(record)`, which counts a record of an unknown kind, without a numeric `t`, or
   past the cap in `document.__argusTasteDropped`. *The drain:* `page.evaluate(TASTE_DRAIN)` in the lane's own
   run-code → `{url, timeOrigin, dropped, events}` (the events spliced out). *A record:* `{kind, t, …}`, `t` the
   document's `performance.now()`: `input {type: click|dblclick|pointerdown|keydown|input|submit}`, `change {cause:
   added|attribute|navigation, attr: <RENDER_ATTRIBUTES>|null}`, `busy {on, signal:
   aria-busy|progressbar|disabled|spinner|skeleton}`, `transition` and `animation` `{phase:
   run|start|end|cancel|iteration, name, duration_ms, delay_ms, easing, target}` (strings at most 120; `target` is
   page text). `tasteEventFault(e)` checks one.
3. *Cost per screen (J1, risk 4).* J1 records a screen's census, ease measurements, drain and screenshot in one
   run-code per screen. The "under 300 ms" bound is dropped; the pass has a time budget a cycle instead,
   `TASTE_BUDGET_MS` (15 minutes, a lane constant in `-tastecfg`: taste.json's keys are decision 5's and hold no
   budget): recording, judging and confirmation replays together; past it no new screen is recorded and no new row
   replayed.
4. *Dark replay (D17, J2, T1.2).* The pass reads the page's media first (`MEDIA_READ` → explicit `{colorScheme:
   light|dark, reducedMotion: reduce|no-preference}`) and restores exactly those after a dark or reduced-motion pass
   through `explicitMedia(m)`, which refuses null (`failed: taste: emulateMedia takes explicit values …`).
5. *Routed faults (D12, T2.2, J2).* The `page.route` fault is armed before the navigation to the screen and removed
   after; a faulted request reaches neither the proxy nor the app.
- The CLI's emulation commands stay off the explorer's `pw` allowlist (a test pins that no `pw` command names colour
  scheme, reduced motion, emulation or media): emulation happens only in the lane's own run-code.

**Deviations.**
- *Frames.* The bar holds `atlassian`, `carbon`, `material`, `primer` and `polaris` (historical). `geist` and
  `shadcn` are left out: the research read no spacing, radius, duration or type scale for them (shadcn's radii derive
  from one `--radius` with no number read; Geist's type is named, not fully numbered), and the bar holds no unread
  number. `taste.json` `frame` refuses them until a maintainer adds them with a read source (D21's procedure).
- *Rule fields beyond the plan's six.* `info: true` marks the information-only rules, which `validateTaste` refuses
  to gate; `terms` holds `copy.vague`'s English list (the plan's "the bar's English list").
- *Classes.* Decision 4's three classes per rule; the bar's choices where a decision named none: the census counts and
  `scale.off-scale` `derived`, `hierarchy.primary-actions` `bar`, `hierarchy.nested-radius` `implicit`,
  `copy.broken` cites `nng-errors` (D12 named no source). The dark-mode rules are counts (`max: 0`); what counts as a
  collapsed border or a light surface is T1.2's probe, not a bar number.
- *loadTaste* returns every default when `.argus/taste.json` is missing (`missing: true`): the pass is on by
  default, unlike `loadSmoke`'s null.
- *The Curator's run* (guard): the lock's run, else the newest run directory, so a Curator dispatched after `down`
  still reads its run's `taste/`. The guard knows it by `agent_type` (`(^|:)curator$`), with or without `agent_id`.
- *The calibration refusal* covers the script as a program, an interpreter's first operand or preload, a glob it
  matches, the real file behind a symlink, `-e` code naming it, and a shell-built name followed by `--network`,
  `--corpus` or `--out` or in a command whose text names it; reading it, its tests and `node --check` stay allowed.
  Not caught: a copy under another name (CONTRACT.md §Engine floor says so).
- *`-redtest.mjs`* (no lane's) refuses a taste expectation as it refuses layout.
- *The golden test* (`tests/argus-live-codegen.test.ts`, "leaves every generated file byte-identical") pins the
  generated suite's files by sha256 as the generator wrote them before the split. S1 changes the output on purpose
  (the taste project, the header's `taste-bar <n>`): it updates the digests in its own commit.
- *Instance header and `-pw` test.* The DAG header in `-instance.mjs` (no lane's) names the new modules;
  `tests/argus-live-pw.test.ts`, `-perf.test.ts` and the findings test pin `PAGE_INIT` where they pinned `SIGNAL_SCRIPT`.

### Lane T1 — visual probes (T1.1, T1.2, T1.3)

Commits: T1.1 census, restraint, hierarchy, alignment; T1.2 colour roles, dark parity, contrast headroom (and the suite's
check); T1.3 motion and density; then one fix commit adding five exclusions, each with its twin. `-taste.mjs` ends at
about 730 lines (cap 750: little room left; a later family belongs in its own module). `tests/argus-live-tasteprobe.test.ts`
(Chrome, one browser for the file, about 45 s) replaces every lane 0 stub pin of `-taste.mjs`; it lands in CI's `rest`
job, which is fine at that length.

**What each export is.**
- `TASTE_SOURCE` `(arg) => census`: measures the page in the media it answers now, judges nothing. `{media: {dark,
  reduce}, vw, truncated, counts: {spacing, type, weights, colours, radii, shadows}, values: {spacing, type: [{px, w,
  fluid}], radius, gaps}, palette, headings, primary: {scope: view|dialog, buttons}, alignment, nested, shadows, text,
  borders, surfaces, roles, root, motion, running, transitionAll, controls, tables}`; `{motionOnly: true}` returns
  `{media, motion, running}`. Colours through a 1x1 canvas, lengths through the Typed OM (an `auto` or percentage margin
  is never a spacing value), at most 3000 rendered elements (`truncated`).
- `TASTE_INIT`: the recorder. Every transition (run, start, end, cancel) and animation (start, end, cancel), and a view
  transition at its `ready` (it fires no event: `document.startViewTransition` is wrapped, returning the same object),
  go to the taste buffer in TASTE_EVENTS' shape; `document.__argusTasteMotion` keeps the last 200 for the census, with
  the properties, `reduce` and `quiet` at the start, and for a layout-property motion how many sibling boxes up its
  ancestors it moved (0 when its own box did not change, or when it was removed mid-motion).
- `censusOf(page)` → `{media, light, dark, reduce, themes}`: the page's own media read as explicit values and censused;
  then, with an adopted sheet `transition: none !important` (no DOM mutation, so no feedback-clock event, and no theme
  transition recorded as motion), the other colour scheme, then `reducedMotion: "reduce"` (motion only); then the media
  put back as read, never null. `themes` is `single` when both schemes render the same palette (the other census is then
  null). Self-contained: J1 runs it as `async page => (${String(censusOf)})(page)` in its one run-code a screen. Measured
  at 320–420 ms for 2,400 elements (three passes) at load about 20.
- `rulesFor(screen, bar, cfg)`: pure and self-contained (its source runs in a page). `screen` is censusOf's result or a
  recorded screen holding it as `taste`; the base census is the one under `media.colorScheme`. `cfg` is loadTaste's
  value; `off` silences a rule; `frame` names the bar's frame for the off-scale rules; **`cfg.tokens`** (`{spacing?,
  radius?, type?}`, px numbers) is an addition: the owner's tokens, resolved and sorted by kind by the caller (J), outrank
  the frame. Without either, off-scale rules give nothing.
- `ruleExpression(rule, cfg = null)`: the page expression; `cfg` is an optional second argument (lane 0's call with one
  argument is unchanged). With no scale, `scale.off-scale` and `hierarchy.section-gaps` list every value measured, so a
  replay re-measures a row by its key. Under a reduced-motion page it fills `reduce` from the same census.
- `CHECKS`: one entry, `{name: "taste", project: "taste", when: "every step", source, emit}`. The source embeds
  `censusOf`, `rulesFor`, the bar's taste-family rules and frames as `TASTE_BAR` (read from the shipped bar when the module
  loads) and `TASTE_INIT`; `tasteStep(opened, i, step, id)` arms the recorder on the context at its first step, reads
  `.argus/taste.json`'s `gate`, `off` and `frame` at run time (a missing or unreadable file: defaults; the lane
  validates it, the suite does not), annotates each row once a test: `argus-taste` `{rule, step, key, measured,
  expected}`, an information rule's `argus-info` (`taste <rule> "<key>": <measured> (expected <expected>)`), a gated
  rule's `argus-violation` `{check: <rule id>, step, key, detail}` less `known/<id>.json` rows `{check, key}` (returned,
  so the soft check fails), and once a test `taste: single theme (…): dark parity not judged`. Peer rows are never
  annotated.

**Row conventions the judge and the filing read.**
- A rule whose threshold is `peer` (the six `scale.*` counts) is one measurement row a screen, `{key: "screen", measured:
  <count>, expected: "peer"}`: J2 applies the peer and band test; the suite skips it.
- Cross-screen comparison of `colour.role` and `density.row-heights`: rulesFor judges one screen; J2 joins several
  screens' `roles` (or `tables`) into one census and runs rulesFor on it (the test does exactly that for two pages).
- Keys: `<tag>|<label>` (aria-label, own text, a button-type input's value, alt, then text content; at most 60
  characters; digit runs `#` in the label only). Value keys keep their digits, being CSS values stable across visits:
  `spacing:13px`, `type:18px`, `radius:20px`, `gap:20px`, a headroom pair `rgb(…) on rgb(…)`, motion `<property or
  animation name>|<element key>`, density `button`, `field`, `tables`; screen-level rows `screen`, `view` or `dialog`;
  a role row's key is the badge text, lower-cased.
- `motion.reduced`'s `expected` cites the level: `no transform motion under reduced motion (WCAG 2.3.3, Level AAA)`.

**Definitions the probe fixes** (what counts as the thing measured; the bar holds the thresholds): a colour is non-neutral
at OKLCH chroma 0.05 or more; a primary is a filled button whose fill reaches 2:1 against what is behind it, the loudest
fill counted by distinct names (a row action repeated is one; a disabled one, and one outside an open modal, none); a
heading is compared only with the heading it sits under in the outline (the plan's "its h1"); alignment reads stacked
in-flow block siblings, skipping a container that centres or ends its items, a child with an auto left margin, and a
transformed child, and compares centres too; a corner is shared when the child's corner lies within the parent's radius
on both axes (a circle or pill is a shape, never compared); shadows exclude rings (no offset, no blur) and insets, and
a layer is raised, overlay (fixed, absolute, popover, menu) or modal; text contrast is skipped over an image or gradient
and for a disabled control; an edge is the stronger of border and fill against what is behind (collapsed: under 1.1:1 in
dark where light had 1.2:1 or more); a surface is at least 100 x 40 px with an opaque fill, never a control or media,
left light at luminance 0.4 or more on a page root of 0.1 or less, unchanged from light, not declaring `color-scheme:
light`; a badge is at most 24 characters and three words, at most 40 px tall, on its own fill, rounded or padded, in no
control; `contrast.headroom` reads body text between 4.5:1 and the bar's 7:1 (under 4.5:1 is axe's failure), one row an
ink and surface pair; a motion is one iteration's duration (a stagger's delays never add), none under one frame (17 ms),
neither a loop nor one recorded under reduced motion or while the census was switching media; under reduced motion only
a running infinite transform loop or a transform an action started under the preference counts (a finite motion still
running from before the switch never does); control and row heights a pixel apart are one; a wrapped button label and
an all-header row are excluded; a table needs three body rows. Each of these could move into the bar through D21's
procedure.

**Deviations.**
- `ruleExpression` takes an optional `cfg` and `rulesFor` reads `cfg.tokens`: additive, no locked signature changed.
- `-taste.mjs` reads `plugins/sapu/data/taste-bar.json` as data (a leaf: no argus-live import), for `ruleExpression`'s
  thresholds and the suite's `TASTE_BAR`; its family list repeats `-tastecfg`'s FAMILIES for `taste` (a leaf cannot
  import it), and rulesFor repeats it once more (self-contained).
- censusOf's restore can restart an animation the reduced-motion pass removed (a page whose `prefers-reduced-motion`
  rule sets `animation: none`): it replays once on the page. A restart that lands while quiet is never counted; one that
  lands after is recorded under the same key as its first run, so it adds no row unless the first run went unrecorded
  (it began before the recorder was armed) and is itself outside the band.

**Needs coordinator.**
1. *The `taste` final cannot re-measure dark parity.* `-steps` (lane 0's) runs `page.evaluate(ruleExpression(rule))`; a
   page expression cannot switch media, so for `colour.dark-contrast`, `colour.dark-border` and `colour.dark-surface` it
   gives no row and the final always holds (precision-safe: the row is never confirmed, but it can never be). Either the
   `taste` template in `-steps` runs `(${String(censusOf)})(page)` and `rulesFor` for those three rules (censusOf is
   self-contained and takes the run-code's `page`), or J2's `taste confirm` confirms them through censusOf directly. The
   same holds for `motion.reduced` unless the replay runs under reduced motion.
2. *Lane S.* `CHECKS[0].project` is `taste`, which `-codeproj`'s `PROJECT_NAME` and `gated()` do not know yet: until S1
   adds the `taste` project (Chromium, first width) and `-taste.mjs`'s CHECKS to `suiteChecks`, registering it throws.
   S1's header stamp `taste-bar <n>` should use the same bar the source embeds (both read the shipped file). The
   recorder is armed at a test's first taste step: motion caused by step 1's own action is not recorded; S1 may arm it
   before the first step if it wants that.

### As built — Lane T2 (ease probes)

Three commits, one a task: T2.1 feedback and loaders, T2.2 states, copy, path cost and the suite's check, T2.3
consistency. Only `-ease.mjs`, `tests/argus-live-ease.test.ts` and `tests/fixtures/journey-app/pages/ease/` changed. Every
rule fires on a fixture and holds on the twin that differs only by the defect (the shadow-root twin was proven red with
its hook off). `-ease.mjs` is 746 lines of its 750 cap.

**Lane 0's exports, as built** (signatures, refusal style and shapes unchanged; `EASE_RENDER`, `FAULT_SOURCE`,
`RECOVERY_SOURCE`, `crossRules` and `NO_MAJORITY` added).
- `EASE_INIT` (in PAGE_INIT, once a document, nothing without the taste buffer) pushes `input` (pointerdown with the
  main button, click, dblclick, submit, keydown of Enter or Space; typing as one `input` record per burst under 250 ms),
  the first rendering `change` after an input (an added element, or added or rewritten text, that passes
  `checkVisibility`; a RENDER_ATTRIBUTES change on a shown node, or one that hides it; a `data-*` change never counts;
  `navigation` at pagehide), and `busy` on/off per signal: `aria-busy`, `progressbar` (determinate: `aria-valuenow` or
  `progress[value]`), `spinner` (an indeterminate progressbar, or a shown infinite rotating animation), `skeleton` (a
  bare box with an infinite non-rotating animation or a `skeleton`/`shimmer` class token), `disabled` (a control that
  went disabled). Beside the buffer, `document.__argusEase` keeps the page's own fetch and XHR requests `{t, end,
  status, method, route, keys, same}` (route templated, `keys` the body's field names, never a value), the clicked or
  submitting controls `{t, role, name, region}`, the edits in forms, and how many skeletons a layout shift replaced.
- `EASE_SOURCE` kinds: `judge` and `feedback` (pure, no DOM), `screen`, `error`, `fields`, `palette`, `rule` (its doc
  comment lists the shapes). `easeOf(page)` is the `screen` kind with the bar's vague terms.
- `rulesFor(screen, bar, cfg)` reads `screen = {route, events, ease}`; `ruleExpression(rule)` answers every screen rule
  of the ease families but `states.recovery` (a driver runs it), `feedback.skeleton-peers` (it needs peers) and `ai.*`
  (`refused: ruleExpression: <rule>: not built yet`), each with its own refusal.
- `pathCost`: P = Fitts' ID / 4.9 s (MacKenzie's typical mouse throughput, [fitts-mackenzie]) bounded to Kieras' 0.8-1.5,
  Kieras' mean 1.1 where a box or the previous one is unknown; a select's option the short bound; `go-back` P + BB;
  goto, reload, read, login, trigger and expectations are not the user's actions. `geometry` is `{goals, targets}` or
  the bare targets (`{x, y, width, height, dialog?}`, index-aligned or keyed by `n`); without `goals`, one M per `expect`.
- `CHECKS`: one entry, `ease`, project `taste` (its source plain JavaScript with `ease`-prefixed names). It installs
  the taste buffer (TASTE_BUFFER's text, pinned equal by a test) and the clock in the account's context, configures
  from `ctx.taste` on the spec's first step, judges every step (argus-taste rows; a gated rule's argus-violation less
  `known/<id>.json`; each row once a test; a measurement that throws becomes an argus-info line, never a failure),
  runs D12's routed fault at each `ctx.screens` step in a sibling page (once a route), and the form case before a
  submit click that follows the path's fills.
- `crossRules(screens, bar, cfg)` → `[{screen, rule, key, measured, expected}]`, `screen` the screen's key; an even
  split's `expected` is `NO_MAJORITY` (decision 19's needs-owner case).

**What J and F need from this lane** (the seams, decided here).
- J1 records a screen as `{key, route, journey, archetype?, events, ease}`: one run-code evaluates the `screen` kind
  (with `terms` from the bar, `vague` from taste.json's `copy.vague`, and `palette: true` only where the lane accepts a
  synthetic Mod+K then Escape on the page) BEFORE `TASTE_DRAIN`; the events of consecutive drains of one document
  are concatenated, since an action and its change can fall in two drains. A pending action is never measured.
- J2's confirm: arm `FAULT_SOURCE` before the navigation, settle, evaluate the `error` kind and pass `ease.error =
  {faulted: Boolean(faulted()), ...}` (or `ruleExpression("states.error")`, which assumes the fault is armed);
  `RECOVERY_SOURCE` for `states.recovery`; `crossRules` for the cycle-scope rules. A replay must not drain the buffer
  before a feedback rule's `ruleExpression`.
- F1: a consistency row whose `expected` is `NO_MAJORITY` is the needs-owner case.

**Deviations.**
- *D10, which actions are measured.* The feedback rules measure only an action that started a same-origin request
  within 100 ms and showed a change before the user's next input, and the wait ends at the earlier of that change and
  the request's end. A client-only action (no request) is INP's, phase 6's perf lane; one that showed nothing before
  the next input is never a wait (a click into a field, a page that refreshes itself). D10's "focus move" is not a
  change here (TASTE_EVENTS has no `focus` cause): a focus move as the only feedback of a wait could still read as none.
- *D10's fault and states.success read requests in the page.* EASE_INIT wraps `fetch`, `XMLHttpRequest.open/send`
  and `Element.prototype.attachShadow` once a window (SIGNAL_SCRIPT already wraps `window.open` and Notification); the
  wrappers record and change nothing else. The attachShadow hook makes the clock see web components' shadow roots;
  without it a component's own busy text would read as no feedback.
- *Post-probe decision 5.* A request whose Accept names JSON is faulted without reaching the app or the proxy; any
  other (fetch's default Accept is `*/*`) is fetched once with `route.fetch()` to read its content-type, as Task 0.1's
  change 4 asks, so the app sees that one GET. A replay's request counts must allow it.
- *copy.broken.* `undefined` after a linking verb (`is undefined`) and `null` outside a value position are prose; code,
  pre, kbd, samp, var, textarea and contenteditable text is never read. The owner's `copy.vague` labels count in any
  language, the bar's English list only under `<html lang="en…">`.
- *consistent.footer-order* compares dialogs with dialogs and forms with forms; a footer whose primary is not one
  submit or one filled button is skipped. *consistent.save-pattern* counts a PUT or PATCH naming the edited field, or a
  POST naming two of the form's fields, so a field check (a POST naming one) is no save. *consistent.palette* flags the
  routes where Mod+K does not open only when it opens on at least as many routes.
- *D14 (AI surfaces)* is not built: no task of lane T2 names it, `FAMILIES` gives `ai` to this probe.

**Needs coordinator.**
1. *Lane S (S1).* `codeproj`'s `PROJECT_NAME` must admit `taste` before `suiteChecks()` holds this `CHECKS` (gated()
   throws on it today), and the emitter context needs `ctx.taste` (loadTaste's taste: gate, off, copy.vague,
   optimistic). The check reports through its own `easeReport`; if S1 builds one shared reporter for both probes, it
   replaces that function.
2. *Lane 0 (-tastecfg).* TASTE_EVENTS's `change.cause` has no `focus` (D10 names a focus move) and no `text` (this
   lane counts a rewritten text node as `added`). Adding `focus` would let the clock count a focus move.
3. *Lane 0 (-steps).* A `taste` final accepts any screen rule, but `ruleExpression` refuses `states.recovery`,
   `feedback.skeleton-peers` and `ai.*` at stepCode time; parseRepro could refuse them at parse instead.
4. *Unowned.* D14's `ai.stop`, `ai.error`, `ai.regenerate` have no task and no probe.
5. *The line cap.* `-ease.mjs` is at 746 of 750; a next rule needs a split into a second leaf (the DAG test and the
   instance header are lane 0's).
6. *Security review (architect).* PAGE_INIT now wraps fetch, XHR and attachShadow in every lane session, the
   explorer's included; request body field names and clicked controls' names (page text) reach the recorded screens.

### Lane J — J1, J2, J3

Commits, in order: J1 recording, J2 judge and confirm, J3 SELECT. Line counts at the end of the lane: `-session` 607,
`-tastejudge` 576, `-map` 511. Every test is in `tests/argus-live-tastejudge.test.ts` (lane 0's two stub pins replaced);
the probes are stood in for there by minimal self-contained sources, so the file pins the pass, not the probes' rules.

**J1, recording.** The observation's own run-code records the screen (`observeCode`): the `observe` stage first, then
`RECORDER`, bounded by time (`2 × settle_ms`, 5 to 30 s) and by answer size (400 KB), caught whole, so recording never
fails an observation nor loses its drain (the drain is kept before a shot's verdict is written). Nothing records in
slot `r`, `up` or a map slot, during a perf pass or a confirmation, or once the run's taste time (`<run>/taste/spent.jsonl`)
reaches `TASTE_BUDGET_MS`; then the observation is the `observe` stage byte for byte. A screen is recorded when the
state hash (URL and ARIA snapshot, as the loop rule hashes it) changed. One run-code a screen: the action's taste
events drained (TASTE_DRAIN), the viewport shot of a screen key not yet shot this run (0600, its scrub verdict beside
it, the verdict text read by the `shot` stage in the same call, a text past 150 000 characters unread), taken before
anything else touches the page; the census (`String(censusOf)`, T1's: own scheme, the other one, reduced motion, the
media restored as read); `EASE_SOURCE({})`; the rows of `main`'s largest table; on a `dual` page the other scheme's
shot once its transitions settled (at most 1 s), the explicit media restored; the events those switches caused drained
and dropped. A failure is a line of `<run>/taste/<slot>/harness.jsonl` `{t, account, why}`, never the explorer's
output, which is byte for byte the same with and without recording (tested on `pw`'s own output).
- *The recorded screen* (`<run>/taste/<slot>/screens.jsonl`, 0600), what the judge hands both probes' `rulesFor`: `{v: 1,
  t, journey, slot, account, key, route, width, theme, rows, themed, taste, ease, events, dropped, shots: [{theme, name,
  key}], faults}`; `taste` censusOf's `{media, light, dark, reduce, themes}` (T1's rulesFor reads `screen.taste`),
  `themed` its `themes === "dual"`, `ease` EASE_SOURCE's answer, `events` the drained buffer (a record tasteEventFault
  refuses dropped and counted). The judge adds `cycle` (the run's other recorded screens) for the cross-screen rules.
- *The route template* (`routeTemplate`): the map's most literal route, else each id-like segment written `:id` (digits,
  a UUID, 16 or more hex digits, a run of three digits, a digit beside `-`, `_`, `.`, `:` or `~` as in `ORD-1`, or 20 or
  more characters mixing letters and digits). Probed live: the fixture's order ids are `ORD-1`.
- Probed live in the CLI's `run-code`: `page.screenshot({path})` writes outside the slot's `out/` (mode 0644, made 0600
  after), `crypto.subtle`, `TextEncoder` and `Buffer` exist, `require` does not.

**J2, judge and confirm.**
- *Witnesses.* A rule with a `peer` threshold is a row only when its archetype has three recorded screens or more this
  cycle (the judged one included) and its value is beyond `max(best × ratio, best + plus)` of the best other one; where
  the archetype's band is a witness (5 sites, 15 pages, an archetype not inferred) also beyond the band's percentile
  (`expected` the larger). A `bar` row needs the band agreeing (above p90 for a `max` rule, under p10 for `min`, outside
  p10 to p90 for `range`) and an internal witness: a peer screen of its archetype that holds the rule (`value: "holds"`)
  or the owner's frame for `motion.duration` (outside the frame's durations). No tokens witness: T1's `scale.off-scale`
  measures the tokens. `implicit` and `derived` rows stand on their measurement (`witnesses: []`). A thin or inferred
  band is counted in `bands shown only`, a bar finding without both witnesses in `not rows`. Information rules and the
  owner's `off` rules are never rows. A dark-parity row (`colour.dark-*` on a `dual` page) names the dark screen key.
- *Efficiency.* The best known path is the suite's admitted path for the journey (`<dir>/journeys/<id>.json`, read here:
  the DAG test forbids `-tastejudge` reaching `-smoke`), taken when there is no best or it is shorter (a held path only;
  the explorer's path never replaces it). An explorer path at the rule's ratio of the best's actions, or its `plus_s`
  more KLM seconds (each at equality), is an `efficiency.*` row: screen the journey's first recorded screen, key the
  journey id, `cost` the extra seconds. `wait_ms` is each recorded input's time to the first change after it, summed.
- *Confirmation.* `taste confirm` replays through `runOnce` in path mode (`id: taste-<row>`, so its records lie under
  `<run>/smoke/taste-<row>/`): the journey's explorer path for a screen row, the best path (by its sha, in the suite) for
  an efficiency row (confirmed only when it breaks: exit 3; while it holds, the explorer's detour). A screen row goes
  through `confirmSink`, which the slot `r` driver runs every step through (`confirming`, as perf's sink): `states.error`
  arms the routed fault right after the hook, before any navigation (the first same-origin JSON GET at the row's route
  answered 500); at the first step after which the page is at the row's route template and width, once the network
  settled, the row is measured again. Per the coordinator's seam decision (T1), `MEDIA_RULES` (`colour.dark-contrast`,
  `colour.dark-border`, `colour.dark-surface`, `motion.reduced`, pinned to the bar by a test) are measured by T1's
  `censusOf` and `rulesFor` sources in that run-code (they switch the media, transitions off, and restore it
  explicitly); any other rule by its probe's `ruleExpression(rule, {frame})`. A peer-count row is confirmed only beyond
  its `expected` again. A cross-screen (`consistent.*`) row is not replayed: the next cycle's judge reporting it again
  confirms it. A confirmed row is kept in taste-state.json, `queued`, severity S3 for `implicit`, an efficiency row or a
  cost of 10 s or more, else S4 (F's filing may raise it). Proved end to end on the fixture app: a fresh instance, the
  fault re-measures a `states.error` row on the order page, and its unfaulted twin is not confirmed.

**J3, SELECT.** `score(j, {…, taste = 1})`; `selectJourneys` passes `tasteFactor(state, id, accept)`. A broken taste.json
refuses `select`, a broken taste-state.json fails it (never guessed).

**Deviations.**
- `tasteJudge(main, {run}, {now})` and `tasteConfirm(main, ref, {once, now})` take an optional last options argument (the
  test seams, as `runOnce` has); the CLI's calls are unchanged.
- The recorder no longer runs its own dark and reduced-motion census: T1's `censusOf` does both (its `themes` decides
  the dark shot).
- The judge's line `harness: a probe's rules failed <n> times` counts a probe module's `rulesFor` throwing (the stubs, until
  T1 and T2 merge, say so on every screen).
- Not built: the Curator's leads measured first (Z1's `validateCurator` and their file are not there yet).

**Needs coordinator.**
1. *`tests/argus-live-findings.test.ts`, the select describe* (lane 0's): every journey there is never judged, so its
   score is ×1.5 (decision 18). Seven tests go red; the exact change, checked green on a copy: line 2533 `[["b", 150],
   ["a", 90]]`; 2534 `[["a", 180], ["b", 150]]`; 2540 `score: 150`; 2541 `75`, `60`, `45`; 2546 `75`, `60`; 2547 `45`, `15`;
   2556 `score 4.5` twice; 2563 `score: 4.5`; 2564 `score: 3`; 2567 `4.5`, `3`; 2573 `score 1.5` twice; 2580 `score 3`,
   `score 6`, `displaced b score 4.5`; 2582 `score 9`, `score 6`, `score 3`; 2598 `score 1.5`. The `score()` unit lines
   stay (its `taste` defaults to 1).
2. *T2's `rulesFor(screen, bar, cfg)`* receives the recorded screen above: `screen.ease` is `EASE_SOURCE({})`'s answer,
   `screen.events` the drained buffer, `screen.cycle` the run's other recorded screens (for `consistent.*`). T2's
   `pathCost(steps, geometry)` gets the path as the return holds it and `geometry` `[]` (no replay geometry is recorded).
3. *The owner's tokens* (`live.json` `tokens`) are not resolved to px for the lane: the judge passes loadTaste's value
   (no `tokens`) to `rulesFor`, the confirmation `{frame}` to `ruleExpression`. A resolver (as `a11yTokens`) is needed for
   the tokens to outrank the frame in the lane, as they do in the suite.
4. *`-scrub.mjs` `attachVerdict`* admits only a PNG in a slot's `out/`: the taste shots (`<run>/taste/shots/<name>.png`,
   each with its verdict beside it) cannot be attached by F's filing until it admits that directory.
5. *CI*: `tests/argus-live-tastejudge.test.ts` drives Chrome (the recorder, a recording through the CLI, a replay on a
   fresh fixture instance: about two minutes under load) and lands in the `rest` job; give it a `files:` line if `rest`
   is near its bound.
6. *Engine text (Z2)*: SELECT's printed scores can now be fractional (`score 4.5`); `taste confirm` refuses a
   `consistent.*` row (the next cycle's judge confirms it) and prints the replay's own `HARNESS:` line when it failed.

### Lane S — the suite (S1, S2)

Two commits, S1 then S2. Line counts after them: `-codeproj` 473, `-codegen` 575, `-propose` 683. No new test file:
`tests/argus-live-codegen.test.ts` (already on the CI `files:` line with the a11y and layout tests) gained the unit
tests and one Chrome test (three pinned-runner runs, about a minute under load).

**S1, the taste project.**
- *The project.* `suiteProjects` adds `{name: "taste", kind: "taste", browser: "chromium", width: <first>}` after
  `a11y`, whenever chromium is among smoke.json's browsers (as a11y; on by default, no switch). `PROJECT_NAME`
  admits it, so no journey can be named `taste`. The config writes a comment over its line.
- *Which rules* (`tasteTable`): the bar's `screen` rules with a fixed threshold. A `peer` or `band` threshold compares
  screens (the judge's), and `TASTE_LANE_ONLY` (`feedback.skeleton-peers`, `feedback.optimistic`, `ai.stop`,
  `ai.error`, `ai.regenerate`) needs peers or the owner's declared routes, which one page expression cannot see. A rule
  whose `ruleExpression` throws `refused: …: not built yet` is left out; any other throw is thrown.
- *Passes.* `TASTE_MEDIA_RULES` (`colour.dark-contrast`, `-border`, `-surface` in dark; `motion.reduced` in reduced
  motion) run only in their medium. The action families (`motion`, `feedback`, `states`, `copy`, `ai`) run after every
  step of an account that acts (not `read`) and at every screen. The census families (`scale`, `hierarchy`,
  `colour`, `contrast`, `density`) run at a screen once its running animations ended (a frame, then every animation
  ending within 5 s), and again in dark. Order at a screen: action rules, settle, census; reduced motion (the page's
  colour scheme), settle, its rules; dark (the page's motion setting), settle, census and dark rules; then the media
  `MEDIA_READ` gave, put back by value, and a settle.
- *Measuring.* Each rule alone, `page.evaluate(<its expression>)` (a page's CSP does not stop it). A throw is an
  `argus-info` line (`taste <rule>: the probe failed (<first line, at most 200>)`); a row that is not `{rule: <that
  rule>, key: 1–300 characters with no newline, measured, expected: a number or a string of at most 200}` is dropped
  and counted in one line. The buffer is drained once after each pass (`TASTE_DRAIN`). Each probe source an
  expression holds (64 characters or more) is written once in support.ts and put back at run time.
- *Arming.* `open()` adds the init script (`TASTE_BUFFER`, `TASTE_INIT`, `EASE_INIT`) to every context it makes in
  the taste project. A fixtures.ts page is armed at its first taste step: the context's later documents get it, and
  the current document runs it once.
- *Reporting.* Each (rule, probe key) once a test, at its first step. A reduced-motion or dark finding's key ends in
  `|reduce` or `|dark`, so the dark pass shows only what the page's own media did not. An information rule is an
  `argus-info` line `taste <rule> step <n>: <key>: <measured> (expected <expected>)`. A gated rule is phase 6's
  `argus-violation` `{check: "taste-<family>-<name>", step, key, detail: "measured <m>, expected <e>"}` unless
  `known/<id>.json` or the journey's smoke.json `allow` lists that `{check, key}`; it fails the step through the
  emitted `expect.soft`. Anything else is `argus-taste` `{rule, step, key, measured, expected}`.
- *taste.json at run time.* support.ts reads `.argus/taste.json`'s `gate` and `off` from the repo when the suite runs
  (none without the file). A file that is not JSON, a list that is not rule ids, or a gate naming a rule the suite
  does not measure fails the step, naming the rules.
- *The stamp.* Every generated file's header reads `argus-live codegen 1, taste-bar <n>, digest <sha>`, the digest
  the sha256 of `taste-bar <n>` and the body, so a header naming another bar is not its body's. `headerDigest` returns
  `{digest, ok, bar}`, and a header from before the bar still reads (`bar` null). support.ts holds
  `TASTE_BAR_VERSION`. `smoke check` names each file of a suite generated against an older bar `stale` (tested).
- The golden digests moved on purpose (the taste project and core, the stamp).

**S2, the workflow's taste job.**
- *The matrices* come from `suiteProjects` alone: `test` and `quarantine` run the container projects but `taste`;
  `baseline` runs them with `taste`, so a dispatch's results hold the gated rules' violations for adoption.
- *The job* (only when the suite has the project): the test job's `if` (no dispatch, no fork), runner, 70 minutes,
  pinned container, `HOME`, working directory, checkout without credentials, `npm ci --ignore-scripts`, and every
  step after the checkout guarded by `hashFiles`. Then `npx playwright test --grep-invert @quarantine --project setup
  --project taste` with `continue-on-error: true` and the secrets (that step only); then "The taste scorecard, in the
  job summary", `node - test-results/results.json <up>/.argus/taste.json support.ts <<'ARGUS_TASTE'` with
  `TASTE_SUMMARY` (exported by `-propose`) as a quoted heredoc. The results upload as `taste-<ci.artifact>`, outside
  the prefix `smoke ci` reads, for 7 days.
- *The scorecard.* It reads the taste project's tests (a retried test's last attempt), `argus-taste` notes, gated
  `taste-…` violations and `taste` information lines, and writes per-family counts, a findings table and the
  information lines to `$GITHUB_STEP_SUMMARY`. Every page word sits in a code span (control, bidi and line characters
  removed, at most 200 characters, pipes escaped in a cell) with the bar version. When a taste test failed on the
  suite's own taste.json refusal, it shows that one line (no other error text: it may quote the page). It exits 1
  only when taste.json gates a rule and a taste test did not pass (a violation, a skip, no test, no results), or
  when taste.json is not JSON with a list of rule ids under `gate`. Otherwise it exits 0.

**Deviations.**
- `gate` and `off` are read at run time, by support.ts and by the scorecard, not baked in by codegen. `-suite`'s
  `generated()` (smoke check, propose) passes no taste.json, and the owner can promote a rule with no regeneration.
  "Green unless gate is non-empty" holds at run time: the scorecard's exit is the job's.
- A gated rule's check name is `taste-<family>-<name>`. Phase 6's check names hold no dot (`-artifacts` `CHECK`,
  `-smokecfg` `KNOWN_CHECK`), and families hold no hyphen, so the name maps back to one rule.
- Not every screen rule runs in the suite (above). Reduced motion and dark are separate passes, not one combined
  pass. The census waits for running animations to end, so a mid-transition frame is never measured.
- The bar version is stamped in every generated file's header, not only support.ts.

**Needs coordinator.**
1. `tests/argus-live-suite.test.ts`, the "smoke workflow" describe (no lane owns it), has four stale rows:
   - "the secrets reach only the step that runs the suite": `npm ci --ignore-scripts` `toHaveLength(4)` becomes 5
     (the taste job's).
   - "pins the Playwright image": the two `Array(3).fill(...)` become `Array(4)`.
   - "the matrix and the generated config's projects are one list": `matrix("test")` equals the names without
     `msedge` and `taste`; `matrix("baseline")` equals the names without `msedge`, no longer `matrix("test")`.
   - "uploads the results": `uploads.length` 5 becomes 6.
2. `-smoke.mjs` `PROJECT` (the `-artifacts` alias too) lacks `taste`. Until it admits it, `smoke baseline --known`
   skips a baseline run's taste results, so a gated rule's violations cannot be adopted by the verb (a hand-written
   `known/<id>.json` row works today). Admitting it also lets `smoke ci` see taste tests in a baseline run.
3. `ruleExpression(rule)` takes no taste.json and sees no peers, so `TASTE_LANE_ONLY` stays out of the suite. The
   lane's `taste` final has the same gap. The fix is a `cfg` argument, or a bar field (`needs: peers|routes`).
4. Media binding is by rule id (`TASTE_MEDIA_RULES`), and lane-only is a list. A bar rule field (`media:
   dark|reduce`, and the field of item 3) in `-tastecfg`'s schema would carry both; a test pins both lists to the
   bar's ids meanwhile.
5. For T1 and T2, the contract the core relies on:
   - an expression returns its own rule's `{rule, key, measured, expected}` rows, may be async, and must neither drain
     the buffer (the core drains after each pass) nor emulate media;
   - `TASTE_INIT` and `EASE_INIT` must be idempotent per document;
   - a probe's own `CHECKS` run after the core's line at each step and should annotate in the same shapes
     (`argus-taste`, or `argus-violation` with `taste-<family>-<name>`).
6. Decision 12's routed 500 in the suite (`states.error`) is not run by the core. Decide: T2's `CHECKS` (a sibling
   page of the same context, the route armed before its `goto` and removed after) or a core follow-up.
7. `smoke plan`'s `taste-bar <from> → <to>` (decision 17), and a `smoke check` line naming the bar change instead
   of `stale`. `headerDigest(text).bar` gives the version.
8. The golden digests in `tests/argus-live-codegen.test.ts` move again when T1 and T2 land: their sources and
   expressions are in support.ts.
9. Engine text and docs (Z2, Z3): the taste job and its scorecard, `taste-<family>-<name>`, taste.json read at run
   time, the `taste-<ci.artifact>` artifact, the lane-only rules.

### Lane F — F1 file, cap, accept; F2 the scorecard first

Commits: F1 `feat(sapu): argus-live files taste and usability findings — capped, deduplicated, precise`, F2
`feat(sapu): argus-live report leads with the taste and usability scorecard`, then this note. Line counts: `-tastefile`
491, `-report` 417. Tests: `tests/argus-live-tastefile.test.ts` (18, no browser; judge.json, curator.json and
taste-state.json are fixtures of lane 0's shapes, gh a function); the phase 6 report test is unchanged and green.

**F1, `taste file [--run]` (`tasteFile(main, {run, cap}, {env, gh, runner})`; the third argument is optional, as
scrub's).**
- *Reads* `<run>/taste/judge.json` through `readJudge` (exported; lane 0's shape, refused whole when out of shape,
  keys beyond the shape ignored), `<run>/taste/curator.json` through `readCurator` (a verdict naming no judge row
  dropped), taste.json through `loadTaste`, the state through `readTasteState`.
- *Files only* rows with `confirmed: true`, of a rule the bar holds with the judged class, neither `info` nor in
  `off`. A `bar` row needs an internal witness (`tokens`, `frame` or `peer`), else it is `held` and never written to
  the state. F does not also require the band witness: D5's band check is J2's (its test: a bar row with only the
  band is not a row).
- *One issue per title key*: a screen's rows of one rule (several element keys) share one issue, its body listing
  each row; the journeys that reached the screen all point at it in the state.
- *Severity* (`OUTCOME`, aesthetics.md §7 by outcome as a fixed table): S3 for `colour.role` (SC 3.2.4, as §4
  says), `colour.dark-contrast`, `feedback.busy`, `feedback.progress`, `states.error`, `states.success`,
  `states.recovery`, `copy.broken`, `ai.error`, `efficiency.actions`, `efficiency.klm`; every other rule S4; any row
  costing the bar's `efficiency.klm` `plus_s` (10 s) or more of klm_s is S3. Never above S3: §7's S1/S2 owe the
  money arithmetic (SKILL.md §5), which only the orchestrator can write.
- *Labels*: `classify --oracle taste`'s (`bug` for implicit and derived only), `severity:s<n>` (argus's label list),
  the contract's needs-owner label when due; scrub adds the agent-filed label.
- *Where each goes*: S3 or needs-owner → its own issue, under the cap (ranked severity, cost, witnesses, row order);
  S4 without needs-owner → the run's one `[polish] cycle <runId> — N coherence items` roll-up (`ux`, `argus`,
  `found-by:user`, `severity:s4`, `priority:p3`, never `bug`; at most 30 rows; it does not count against the cap).
  Over the cap, or after a scrub refusal, a row is `queued`. The cap counts this run's issues already filed (the
  run's filed.jsonl against the listing), so calling the verb twice never exceeds it.
- *needs-owner*: a `consistent.*` row whose `expected` is `"no majority"` (or `"needs-owner"`); a row the Curator
  `reject`s (an S4 one is `held` instead: a coherence nit the Curator disputes is not worth the owner's ruling); an
  S3 row the Curator rates `polish`. Nothing else.
- *Dedupe*: the state's issue URL (viewed with `gh issue view` when the listing of 2000 does not hold it), else the
  title key at the start of any issue's title, as given or as scrub rewrites it. Open → `open`, never filed twice.
  Closed NOT_PLANNED or DUPLICATE → `closed`, the owner's ruling, never refiled (the line names the `taste accept`
  to stage on their word). Closed COMPLETED → filed anew, its body naming the earlier issue. The listing is every
  issue in every state, never `--search`; titles are compared, never printed.
- *Bodies*: `Journey:`, `Viewport:` (width × theme), `Measured:` (value → expected, the witnesses, `taste-bar <n>`;
  numbers only in prose), `Class:`, `Severity:` with its reason, `Cost:`, `Needs the owner:`, `Source:` (the cited
  ids and their URLs), then every row as one JSON line in a `json` block: page text and the Curator's reason (at most
  500 characters) appear only there. Each body is written to `<run>/taste/filing/<row>.md` (0600) and goes through
  `scrub --create`, which records the URL in filed.jsonl.
- *Before gh*: nothing to file → no gh call; a run scrub refuses, a contract that cannot be read or files no issue,
  a secret ledger scrub refuses → refused. gh's listing failing → exit 2, nothing filed; a scrub refusal or a create
  without a URL stops the filing (exit 1 or 2), the rest queued. The state is written after each issue.
- *Only this run's rows file.* A row queued by an earlier run files when a later judge confirms it again (SELECT's
  taste factor brings its journey back), never from a stale measurement.
- *The state*: F writes each confirmed row it handles (`severity` is F's), keeps `first`, sets `last` to the run.
  A journey the state lacks is created with `judged` = the run; F never touches an existing `judged` or `best`.

**F1, `taste accept <rule> <key>`.** Adds `{rule, key, why}` to `.argus/taste.json` in the working tree (validated
whole, written beside and renamed; the owner commits it), `why` = `the owner's ruling (taste accept)` plus the
row's issue URL when the state has one; marks every state row under that title key `accepted`. Refused: a rule the
bar lacks, an information rule (it never files), a key that is no screen key, a taste.json that does not parse or
validate. Twice is once.

**F2, the scorecard.** `tasteScorecard(main, runId, cw)` (exported) returns lane 0's scorecard rows; the report
opens with `## Taste and usability` only when `<run>/taste/` exists, so every earlier caller's report stays byte for
byte the same. Per journey: screens (a count, or the length of a list of screen keys), the efficiency figures
(`-` for a null one; `efficiency not measured` when null), the walkthrough, the Curator's verdict counts, and per
family `confirmed` (this run, two of two), `queued` and `accepted` (the journey's standing rows in the state). The
section prints counts, figures, family names and journey ids only, never page text or the Curator's words; the file
still goes through defang and scrub's matcher. A judge, Curator or state record out of shape is named under
`Records not read`.

**Needs coordinator.**
1. *Screenshots (D19, F1's test row "its screenshot verdicts").* Taste issues attach none yet. A judge row names no
   screenshot, and scrub's `attachVerdict` admits only `<slot>/out/<name>.png` with a verdict pw wrote, so a shot
   under `<run>/taste/shots/` would always stay local. To attach one: lock the shot's file name per screen key (or a
   `shot` field on the judge row), have J1 write each shot's verdict (`writeVerdict`) when it records it, and let
   `attachVerdict` (`-scrub`, no lane's) admit `taste/shots/<name>.png`. F then passes it to scrub's `attach`.
2. *The no-majority mark.* Lane 0's finding has no field for "a split with no majority". F reads `expected: "no
   majority"` on a `consistent.*` judge row; T2.3 and J2 must write exactly that (or lane 0 locks another mark).
3. *The Curator's file.* F and the report read the Curator's return at `<run>/taste/curator.json` as `{verdicts,
   leads}`; the path is not locked. Z1 (and J, which dispatches it) must write it there.
4. *Substitution verdicts (D20).* The locked Curator return has no per-screen substitution verdict, so the scorecard
   shows only `confirm`, `reject`, `polish` counts. Adding e.g. `screens: [{screen, substitution:
   substitutable|partly|no}]` to the return (Z1) lets F2 count them.
5. *The walkthrough's pass rate.* `cw` answers are free text: F2 counts a step as passing when all four answers start
   with `yes`, `pass` or `held`. D20's "clicks and term now numbers" is a return-schema change (`-return`, lane 0 or
   Z): once the explorer returns a fixed verdict word or numbers, the scorecard should read those.
6. *Engine text (Z2).* journeys.md and the journey skill: run `taste file` after the judge and the confirmations and
   before `report`; it labels, dedupes and files through scrub itself (the orchestrator files no taste row by hand);
   `taste accept` only on the owner's word, after they close a taste issue as not planned.

### Lane K — calibration (K1 and K2 built; K3 not run)

**K1, the script** (`scripts/taste-calibrate.mjs`, `tests/taste-calibrate.test.ts`). The CLI is lane 0's:
`[--network] --corpus <file> --out <bar> [--diff]`. Without `--network` it validates the corpus and the bar and prints
the plan; nothing is fetched or written (a test spawns it against a loopback port that counts connections: none).
`--diff` without `--network` is refused (there is nothing new to compare). With `--network`:
- *Probes.* It imports `censusOf` (`-taste`) and `easeOf` (`-ease`), the page-level wrappers of `TASTE_SOURCE` and
  `EASE_SOURCE`, and installs `TASTE_BUFFER`, `TASTE_INIT` and `EASE_INIT` in every context as the session hook does.
  No action, no fault, no dark or reduced-motion pass. `rulesFor` is not used: it returns findings, not the per-page
  numbers a band needs. Before the first request it runs the probes on a blank local page (every request aborted);
  if they throw, as lane 0's stubs do, it refuses with `the probes cannot measure a blank page (…): nothing was
  fetched`. `probe` in the bar is `sha256(JSON.stringify([TASTE_SOURCE, EASE_SOURCE]))` (`probeDigest`).
- *Metrics.* `metricsOf(screen, bar)` takes, for every rule whose family is `screen`-scoped, the first finite number
  found under the rule's own `metric` name at any depth of the probes' plain objects. Strings, arrays and non-finite
  numbers are never taken, so page text cannot reach a band.
- *Bands.* Per archetype and metric `{n, sites, p10, p50, p90, urls}`, nearest-rank percentiles (always a measured
  value), rounded to three decimals, URLs sorted. A band driven by one site is cut and printed: a single site, or one
  site giving more than half its pages. `numbersOnly` refuses any key or value but the five archetypes, the bar's
  metric names, numbers and the corpus's own URLs, naming where the stray value sits and never the value; the new bar
  must also pass `validateBar` before anything is written.
- *Conduct.* robots.txt is read once per origin and both groups bind: a page is fetched only when the `*` group and the
  `sapu-taste-calibration` group allow it (longest match, Allow on a tie, `*` and `$`). A 4xx other than 429 means no
  robots.txt; a 5xx, 429 or network error skips the origin. One request at a time; every request to a site, robots.txt
  included, starts 10 s after the site's last one ended; sites are served round-robin, the one free soonest first. A
  fresh browser context per page (nothing signed in), viewport 1440 × 900, light, no reduced motion, service workers
  blocked, Chrome's own user agent plus ` sapu-taste-calibration`. A page is skipped when it answers non-2xx, redirects
  to another origin, to a sign-in path or to a path robots.txt refuses, or yields no metric.
- *Writing.* Only the bar's `"probe"` line and its `"archetypes"` block change (one band a line); the rest of the
  shipped file stays byte for byte (tested). `version` is not raised: lane 0 fixed K3 at 1, and the script prints that a
  calibration after a release raises it (decision 21). After the run it prints each cut band, `--diff`'s line per band
  (changed, unchanged, new, gone), and per archetype the pages and sites measured with `a witness` or `thin`.
- *Tests.* Offline: robots.txt rules, pacing on a fake clock, exact percentiles, the cut, numbers only (a page whose
  census returns its own text holding a run-time secret leaks nothing), `--diff`, the plan, the refusals, and in the
  pinned Chrome against a loopback fixture: disallowed pages never requested, every request carrying the agent token,
  the blank-page check making no request. Chrome tests carry 60 000 ms timeouts.

**K2, the corpus** (`scripts/taste-corpus.json`): `{coverage, sites, pages, skipped}`. `coverage` is the research's
coverage statement; `sites.<site>` is `{terms, note}` (the terms page read and what it says); a page is the plan's
`{url, site, archetype, source, terms_reviewed_by}`; `skipped` records each page the review left out with its reason,
so it is not proposed again unread. Every page answered 200 at its own origin and passes its origin's robots.txt for
both groups (read for every host; atlassian.design and checkout.stripe.dev have none).

The terms review changed the corpus the research admitted:
- *Excluded on their terms:* **Apple** (the site terms, which developer.apple.com links too, bar "any … robot, spider or
  other automatic device" used to access, acquire, copy or monitor any portion of the site), **Figma** (AUP 2(j):
  scraping, data mining, or accessing Figma content programmatically), **Raycast** (terms: "data mining, robots,
  scraping or similar data gathering or extraction methods").
- *Admitted:* Vercel (its AUP's scrape item binds customers; automation is barred only to get around limits), GitHub
  (AUP: research use of public, non-personal information with open-access publication), Stripe (the services
  agreement bars copying the website; nothing is copied), Linear (the AUP bars using the Services to scrape; the public
  site is not named a Service), Atlassian (no terms linked; robots.txt absent), shadcn (open source, no terms).
- *Admitted for the maintainer to confirm:* **Carbon**. IBM's terms allow a crawler "as permitted by this Web site's
  robots.txt protocol" and also bar a robot that retrieves or data-mines the sites' presentation.
- Carbon's pages are named at `www.carbondesignsystem.com`: the bare host redirects there, and the script skips a
  page that redirects to another origin.

| Archetype | Pages | Sites | Witness reachable (≥ 5 sites, ≥ 15 pages) |
|---|---|---|---|
| marketing | 15 | 3 (vercel, stripe, linear) | no: three of the research's six marketing sites are out on their terms |
| docs | 21 | 6 (vercel, github, stripe, carbon, atlassian, shadcn) | yes, if every page measures (5 without Carbon) |
| app | 8 | 3 (github, shadcn, carbon) | no |
| form | 6 | 3 (shadcn, carbon, stripe) | no |
| data | 8 | 3 (github, shadcn, carbon) | no |

No site gives more than half of an archetype's pages, so no band is cut for one site's weight unless pages fail.

**K3, not run.** `-taste` and `-ease` are still lane 0's stubs in this worktree, so the script refuses before any
request, and its numbers would mean nothing. It also runs only from the maintainer's main session: the guard refuses it
to every subagent, this lane's included. `archetypes` stays `{}` and `probe` null; no stand-in number is committed.

**Needs coordinator.**
1. *K3 after T1 and T2 merge,* from the maintainer's main session: `node scripts/taste-calibrate.mjs --network --diff
   --corpus scripts/taste-corpus.json --out plugins/sapu/data/taste-bar.json`, then review each band and commit
   `feat(sapu): taste bar v1 calibrated against the reference corpus`. Expected: docs a witness, the other four thin.
2. *The metric seam (T1, T2).* `censusOf(page)` and `easeOf(page)` must carry each per-screen measurement as a finite
   number under its bar rule's `metric` name (`distinct_spacing`, `primary_actions`, …), at any depth of plain objects.
   Otherwise that metric gets no band. Check this before K3: a dry run's `measured … (<k> metrics)` lines show it.
3. *Lane 0's pin* in `tests/argus-live-taste.test.ts` ("is version 1 with no archetype band yet … and no probe
   digest") expects `archetypes` `{}` and `probe` null. K3's commit turns it red by design and must change it, for
   example to: every band has at least 2 sites and passes `validateBar`, and `probe` is a sha256.
4. *The coverage statement is now wrong for marketing.* The research, spec §20.3 and decision 16 say marketing is well
   covered; after the terms review it has 3 sites and cannot be a witness. Lane Z (spec, docs) and the research doc
   should say so, and should name the terms review as the reason Apple, Figma and Raycast left. The corpus's
   `coverage` field must change in the same commit, because a test pins it to the research's text.
5. *Owner decisions.* Confirm or overrule the terms reading per site, Carbon above all. `terms_reviewed_by` says the
   review was this lane's agent's and that the maintainer confirms before a `--network` run. To lift marketing to a
   witness, add sites through decision 21's procedure (a read justification and a terms review).
6. *CI.* `tests/taste-calibrate.test.ts` launches Chrome twice (about 15 s together) and falls in the workflow's `rest`
   job by default; no matrix change is needed.

### Integration — the six lanes as one branch

Merged in the plan's order with `git merge --no-ff`, each merge signed off: T1, T2, J, S, F, K. Only this plan
conflicted (every lane appended its own sub-section; all six are kept, in merge order). No lane-0 stub test
conflicted: lane 0 had put each stub's pin in its owning lane's file. Then the coordinator's fifteen items, one
commit each (items 6 and the suite's reporter share the scale; see below). Line counts after it: `-ease` 626,
`-taste` 640, `-tastejudge` 654, `-session` 614, `-codeproj` 567, `-tastecfg` 553, `-tastefile` 485, `-report` 417.

**Found while integrating (not in the items, decided here).**
- *Two taste reporters in one support.ts.* S's core and T1's own suite check both declared `tasteStep`,
  `tasteArmed`, `tasteConfig` and `TasteViolation` at support.ts's top level: a suite generated with the real
  probes failed to load (the pinned runner said so). T2's check measured the same rules a second time. Decision:
  S's core is the suite's one taste reporter (phase 6's shapes: `taste-<family>-<name>`, known and allow
  adoption, taste.json read at run time). The probes export no `CHECKS` any more (lane 0's locked export list
  loses it); their rules reach the suite through `ruleExpression`. T2's routed fault and form case left the suite
  with it (items 10 and 13 make them lane-only). T1's suite-check tests now run against the core, on the same
  fixture pages.
- *Dark parity in the suite.* A page expression censuses one scheme, so the core's dark pass could never see a
  dark-only failure. The core measures `colour.dark-*` at a screen through T1's `censusOf` and `rulesFor` (their
  sources in the table, as J's confirmation does), and notes a single-theme page once.
- *Off-scale without a scale.* T1's `ruleExpression` with no `cfg` lists every measured value (made for a
  replay's re-measure by key); in the suite that reported every spacing on every page. Item 6's scale fixes it:
  without tokens or a frame the off-scale rules measure nothing, as `rulesFor` decides.
- *The lane never ran T2.* J's recorder evaluated `EASE_SOURCE({})`, which names no kind and throws: every
  recorded screen held `ease: null`, and the judge never called `crossRules`. Item 8 below.

**The items, as built.**
1. *Shots.* `-tastecfg` `shotName(key)` (the first 32 hex digits of the screen key's sha256, the recorder's own
   digest) locks a shot's name: the session keeps only a shot of that name, F finds a row's shot by its screen
   key. `attachVerdict` also admits `<run>/taste/shots/<32 hex>.png` under the same conditions; every other path
   decides as before (the old regex is one branch of the new one). F passes the screen's shot to `scrub --create
   --attach` when it exists; the polish roll-up attaches none.
2. *NO_MAJORITY.* One constant, `-ease`'s, value `"no majority"`; `-tastefile` imports it and compares the row's
   `expected` with it. T2 wrote `"no majority: the owner's call"` and F matched `no majority|needs-owner`: a real
   split never reached needs-owner before.
3. *The Curator's return.* `CURATOR_FILE` = `taste/curator.json`; `validateCurator` (and `readCuratorFile`) in
   `-tastecfg`, the shared-shapes leaf the judge, filing and the report all reach (the plan named `-tastejudge`,
   which the report and filing would then have to reach through the judge). Shape `{verdicts: [{row, verdict:
   confirm|reject|polish, reason}], leads: [{rule, screen}], substitutions: [{screen, substitution:
   substitutable|partly|no}], cw: [{journey, step: 1-100, q1..q4: pass|fail|n/a}]}`, every key present, none
   other. The judge uses the leads of the newest return at or before its run, only when it validates: the rows
   they name take the first numbers. The scorecard counts the walkthrough from the Curator's words (a step
   passes when no question is `fail`) and prints the substitution counts; the explorers' free-text `cw` is no
   longer read.
4. *`taste` in -smoke's PROJECT.* `smoke baseline --known` adopts a gated taste violation from the baseline
   run's taste results (tested; red without it).
5. *Stale rows.* S's four workflow rows and J's fourteen select lines, exactly as their notes said.
6. *The scale.* `-tastecfg` `tokensPx(kind, text)`: live.json's token file as `{spacing?, radius?, type?}` in px
   (by the kind each name names; rem and em at 16 px, the root's default; `calc()`/`var()`/`%` are no value; null
   when nothing), self-contained. Lane: the judge passes `{...taste.json, tokens}` to `rulesFor`, the confirmation
   `{frame, tokens}` to `ruleExpression` and the census (`laneTokens`). Suite: each taste expression holds two
   marks support.ts fills when the suite runs (taste.json's `frame`, live.json's tokens through the same
   `tokensPx` source), so changing either needs no regeneration. The ease probe's `ruleExpression` takes no cfg.
7. *Step 1's motion.* Every generated spec with a taste project calls `tasteReady(opened)` right after it opened
   its accounts (open() arms its own contexts; a fixtures.ts page gets the recorders at once). The lane's
   PAGE_INIT already ran before the first document. Tests: in Chrome, step 1's panel slide is a row when readied
   and none when armed at the step; PAGE_INIT records it.
8. *J and T2.* The recorder evaluates T2's `screen` kind (the bar's vague terms, taste.json's `copy.vague`; no
   palette probe, which would type on the explorer's page, so `consistent.palette` is not measured in the lane)
   before the drain, and an unchanged state no longer drains (one document's events stay together, as T2
   asked). The judge hands `crossRules` every recorded screen `{key, route, journey, archetype, events, ease}`; a
   cross finding is a row of each journey that recorded its screen; cross-screen rules (`consistent.*`,
   `feedback.skeleton-peers`) come from crossRules only and are confirmed by the next cycle's judge, never a
   replay. `pathCost` gets `{goals: <the journey's map steps>, targets: []}` for both the explorer's and the best
   path. `tests/argus-live-tasteflow.test.ts` records five fixture screens with the real recorder, payload,
   PAGE_INIT and probes, and judge.json holds T1's heading-order, T2's copy.broken and feedback.busy and
   crossRules' NO_MAJORITY split (red with the old ease call).
9. *Focus.* `TASTE_EVENTS.change.cause` admits `focus`; T2's clock pushes it when focus moves, after an action, to
   a shown element other than the action's own control. The judge already counts every change. Twin: the same
   1.5 s wait with focus moved at once holds, with nothing shown fires (red with the push removed).
10. *Lane-only rules.* `-tastecfg` `laneOnly(rule)`: a `peer` or `band` threshold, `feedback.skeleton-peers`,
    `feedback.optimistic`, `states.recovery`, `states.error` and `ai.*`. parseRepro refuses a taste final on one
    (`refused: repro: step <n>: taste: <rule> is the lane's alone (<why>): a replay's page cannot measure it`);
    the suite's `TASTE_LANE_ONLY` is derived from it (generating a suite no longer throws on T2's
    `states.recovery` refusal).
11. *Carbon.* Out of the corpus (`sites.carbon` "Excluded.", its pages in `skipped`), its frame kept (read, not
    crawled). Without it one site would give more than half of app, form and data, which calibration cuts: six
    GitHub and shadcn pages wait in `skipped` until another site joins. Corpus: 43 pages on 6 sites; docs 18 on 5
    (a witness), marketing 15 on 3, app 6, form 2, data 2 (thin). The coverage statement changed in the corpus
    and the research in one commit; spec §20.3 and decision 16 say the same. K3 was not run.
12. *Band metrics.* T1's census also holds `metrics.distinct_{spacing,type,weights,colours,radii,shadows}`;
    a test checks, for every rule with a `band` threshold, a finite number under its metric name equal to its
    row's count. No ease rule has a band threshold.
13. *The routed 500* stays lane-only: the spec's states table and decision 12 say so.
14. *-ease's lines.* No split: it is at 626 since its suite check left, so the DAG test and the -instance header
    stay as they are.
15. *CI.* A `taste` matrix entry: tastejudge, tasteprobe, ease, tasteflow, taste-calibrate. Each file is on one
    `files:` line; the rest job's check holds.

**Left for later** (owners named).
- K3, the first calibration, from the maintainer's main session; it then changes lane 0's pin in
  `tests/argus-live-taste.test.ts` (no band yet, probe null).
- The `taste` final in `-steps` still cannot re-measure dark parity or reduced motion (T1's first note): it holds
  for those rules; J's confirmation measures them through the census. Running the census in that template, or
  refusing those rules at parse, is open.
- `smoke plan`'s `taste-bar <from> → <to>` and a `smoke check` line naming a bar change (S's seventh note).
- A bar field for media and lane-only (`media`, `needs`) instead of id lists (S's third and fourth notes).
- The bar-class rules' own metrics (`primary_actions`, `loader_shown_ms`, …) are not emitted under their names
  yet: their bands, and so their `bar` rows, wait for that.
- The AI-pattern rules (D14, `ai.*`): their own task, a new leaf.
- Engine text, docs and diagrams (lane Z): the taste job and its scorecard, `taste-<family>-<name>`, the
  Curator's locked return, fractional SELECT scores, `taste file` after the confirmations.
- Security review (T2's sixth note): PAGE_INIT wraps fetch, XHR and attachShadow in every lane session.

### AI rules (D14)

Decision 14's three rules, `ai.stop`, `ai.error` and `ai.regenerate`, built in a new leaf, `argus-live-aiux.mjs` (387
lines), with its own Chrome test file `tests/argus-live-aiux.test.ts` (22 tests, about three and a half minutes under
load, on the CI `taste` job's `files:` line). Fixtures: `tests/fixtures/journey-app/pages/aiux/` (`chat.html`, one
assistant page whose answer is read chunk by chunk from a fetch, every variant by query; `search.html`, a search box
with a live status). Commits: the probe and its fixtures; the lane's wiring; the CI line; this note.

**Where the rules apply.** Decision 14 and spec §20's table hold: only on a route the owner declares in `taste.json`
`ai`. Within such a route the probe finds the surface by what the page does, never by a name: an answer **streamed**
into a live or busy region (`aria-live` other than off, `role=log` or `status`, or `aria-busy="true"`) whose text grows
by letters or digits in three steps or more over 150 ms or more, after a user action in the 30 s before; and a
**composer** (the nearest ancestor of a text box, four levels at most, holding a control, no live or busy region and
at most eight controls). No stream on a declared screen means no AI row. A stream on an undeclared route is silent
too: detecting AI surfaces alone was decision 14's rejected alternative (false positives).

**The exports.** `AIUX_INIT` (the recorder, in `PAGE_INIT` after `EASE_INIT`, once a document), `AIUX_SOURCE` (`screen`,
`rule` and the pure `judge` kind), `AIUX_DRIVE` (the confirmation's drive), `AIUX_FAULT` (the marked fault),
`AI_EXPECTED`, `AI_MARKER`, `rulesFor(screen, bar, cfg)`, `ruleExpression(rule)` (lane 0's signatures), and
`driveArg(rule)`, `faultArm()` for the sink. The recorder keeps counts, times and flags only: controls' names stay in
the page (they tell a renamed control, a send turned Stop) and no page text reaches the record.

**Each rule, as measured.** Each row has a fixed key; `expected` is `AI_EXPECTED`'s.
- `ai.stop` (key `stream`). While a stream runs, every control that is new or renamed since its action is a stop
  candidate, but not one inside the answer itself (the region's child the text grows in: a Source chip, a code block's
  Copy). A stream of 1 s or more with no candidate is a row (`no stop control while it streamed`). A candidate clicked
  while it streamed is a stop tried. When the stream grew past the bound (1 s) after the last stop tried, it is a row
  (`it streamed <n> ms past a stop`). On the walk, a candidate nobody pressed rules on nothing. The drive presses up
  to three candidates, those outside the answer region and nearest the composer first, until the stream stays quiet
  for the bound.
- `ai.regenerate` (key `answer`). The latest stream, ended (quiet for 1.5 s and its region not busy), not stopped and
  not itself regenerated, with no control new since its action outside the composer and any dialog is a row (`no
  control once the answer was complete`). A stream that follows a click on a control that appeared after the previous
  answer marks that answer regenerated. With candidates, the walk is silent. The drive presses up to four, in document
  order, and closes a dialog one opens with Escape. When none streams an answer again, the row is the drive's own (`none
  of <n> controls shown after the answer answered again`).
- `ai.error` (key `failed-stream`). A composer send, made once the document had streamed, whose request (non-GET, the
  page's origin, within a second) answered no 2xx or 3xx (a status 0 after a later action is a stop's abort, never a
  failure). Read 2 s after the failure: still busy (`aria-busy`, an indeterminate progressbar) is `an endless loader`;
  no text shown after the response is `nothing shown`; no writable text box and no new control outside the composer
  (a Retry) is `no way on`. The request's status comes from `EASE_INIT`'s request records (`document.__argusEase`).
  The drive first sends a plain prompt and waits for its stream, which proves the surface. It then sends `AI_MARKER`,
  which `AIUX_FAULT`, armed on the context before the navigation (T2's pattern), answers 500. The fault touches only a
  request whose body holds the marker, so no request of the path itself is faulted.

**Exclusions, each with its twin fixture** (the silent side, then the side that fires):
- no AI surface: an answer read whole (`stream=once` / `stream=yes`); a box neither live nor busy (`live=bare` /
  `live=busy`); a thinking indicator alone (`dots=yes&stream=once` / `dots=yes&stream=yes`); a search box with a live
  status (`search.html`, no stream, no failure). The drive also finds no stream on these, so `[]`;
- an undeclared route: the same recorded screen without and with `taste.json` `ai`;
- a control inside the streamed answer is no stop: `stop=none&cite=yes` fires and `stop=button&cite=yes` holds;
- a stream shorter than the stop's bound: `stop=none&n=5` / `stop=none&n=30`;
- an answer not yet settled, or stopped: read as its stream ends / once ended; stopped by the walk's Stop / not;
- a failure that is not the composer's (Rename's 500), or that comes before any stream in the document / the
  composer's failure after a stream;
- the drive undecided (`null`, never a row): no failure came because the fault was keyed to another prompt / the
  marker failed. Also null when the answer never ended, no stop was tried, a pressed control left the route or
  removed the answer.
Four guards were checked as tripwires: the punctuation guard, the answer's own controls, the stream before the send,
and the composer's send. Each was removed from a scratch copy, and its silent fixture fired.

**Wiring in the lane** (the integration's pattern for T1 and T2; no locked signature changed):
- `-tastecfg` `FAMILIES.ai.probe` is `aiux`. `laneOnly` already says the AI rules are the lane's, so `TASTE_LANE_ONLY`
  keeps them out of the suite. `parseRepro` refuses a `taste` final on them, and the single taste reporter (the core
  in `-codeproj`) never measures them. Their measurement needs the owner's routes and a drive that acts on the page.
- `-browser` `PAGE_INIT` gains `AIUX_INIT` (the session hook's payload, every document of every lane session).
- `-session`: the recorder's payload names `ai: AIUX_SOURCE` and `aiArg: {kind: "screen"}`. RECORDER reads it after the
  ease probe (`faults` gains `ai`; a payload without it records `ai: null`), and `screens.jsonl` lines gain `ai`.
- `-tastejudge`: the judge runs `rulesFor` of all three probes on each screen. For an AI row, `confirmSink` sets
  `drive: AIUX_DRIVE` and `driveArg`, and its wrap runs the drive on the page at the row's route and width. An
  `ai.error` row's `arm` is `faultArm()`, the marked fault on the context before the first navigation.
- `-ease`: `ruleExpression` no longer refuses the AI rules as "not built yet"; it refuses them as no rule of its own.
- The findings DAG test admits `-aiux` as a phase-7 leaf that the judge and the browser import; the `-instance`
  header names it.
- Line counts: `-aiux` 387, `-session` 626, `-tastejudge` 658, `-browser` 546, `-tastecfg` 553, `-ease` 624.

**Deviations.**
- *Detection.* The brief asked for detection from observable signals. Decision 14 and spec §20 also require the owner's
  declaration. Both hold: the declaration gates, and the signals find the surface. Neither alone files.
- *`ruleExpression(rule)`* returns the passive page expression, which reads what the page recorded so far. A
  confirmation measures with the drive instead, because only a drive can press Stop, wait for an answer, or have its
  send faulted.
- *The bar is unchanged.* Its three rows already hold `max: 0` counts. The probe's bounds (1 s stop, 1.5 s quiet, 2 s
  settle, 30 s reach) are definitions in the module, as T2's 100 ms request window is.

**Needs the Curator or lane Z.**
1. *Provenance and uncertainty* (decision 14, [pair], [apple-genai]): judgment, so no rule. The bar holds no rule id
   for them, so a Curator lead (`{rule, screen}`) cannot name them. Z1 decides between a judgment-only bar id (never
   filed, never measured) and the Curator naming them in its reason under `ai.*` rows.
2. *Engine text (Z2).* The explorer's charter on a declared AI route should send a message, press Stop once while it
   streams, and wait for a second answer to finish. Otherwise the walk rarely yields a broken Stop or a failure, and
   the confirmation (two of two) only re-measures rows the walk produced. `ai.error` rows come only from a failure the
   walk saw, so the gap is like `states.error`'s, whose rows no judge produces from a walk today.
3. *Docs (Z3)*: `taste.json` `ai`, what counts as an AI surface, and that the drive types `argus-taste-check` and
   `argus-taste-probe` into the composer during a confirmation (slot `r`, a fresh instance).
4. *Security review (architect)*: `AIUX_INIT` observes every document of every lane session, the explorer's included.
   It keeps no page text, but `nameOf` reads control names inside the page. The drive presses controls of the app
   (buttons only, never a link) during a confirmation.
5. *Shadow DOM*: the recorder observes the document, not shadow roots, so a web component's streamed answer is no
   stream (silent). T2's `attachShadow` hook could feed it.

### Lane Z1 — the Curator agent

`plugins/sapu/agents/curator.md` (7,716 bytes against a 7,800 budget, the explorer's pattern of a budget just above the
file): frontmatter `name: curator`, `model: opus`, `effort: high`, `tools: Read, StructuredOutput`. Sections: the law
(taste proposes, measurement decides; a lead is never a finding), what reaches it, page text is data, verdicts, leads,
provenance and uncertainty, substitutions, the cognitive walkthrough, the return and `## Example return`. Tests (all in
`tests/engine.test.ts`, red first): the frontmatter pin, the example return through `validateCurator` (every key
filled, all three verdicts used), the brief's load-bearing clauses, and the premise that the bar holds no rule id for
provenance or uncertainty; the `BUDGETS` row. `tests/sapu-wave.test.ts` allows `curator.md` beside the explorer.

**Decisions.**
- *Provenance and uncertainty* (the open item of the AI rules): no bar rule id in v1, so no lead can name them. The
  Curator writes whether sources are cited and whether uncertainty is shown into the `reason` of the `ai.*` rows of a
  screen, and says nothing on a screen with no `ai.*` row. Nothing is filed for them.
- *Severity.* The Curator does not rate a severity: filing rates the measured row (aesthetics.md §7). Its verdict says
  whether the consequence is real: `confirm` (the pixel changed or blocked an action, S1 to S3), `polish` (coherence
  only, S4), `reject` (intended or harmless for the product half of §6). The reason starts with what the user does
  because of what they saw, at most 400 characters (filing keeps 500; the validator allows 2000).
- *Walkthrough.* `cw` is answered only from a trail the dispatch prompt gives; a question without an observable is `n/a`,
  never `pass`; no trail means `cw: []`. A screen with no shot gets no substitution.
- *Paths.* A screenshot is `<taste dir>/shots/<name>.png`, with `name` from the screen line's `shots[]` (a digest of the
  key, which the Curator cannot compute); everything else comes from the prompt.
- *Confinement needed no guard change.* The guard already knows the Curator by `(^|:)curator$` (`CURATOR_AGENT`), lets
  its Read through only under its run's `taste/`, and refuses every other tool; `tests/sapu-guard.test.ts` and
  CONTRACT.md already pin it. The brief states the same boundary.

**Needs coordinator (for Z2, the dispatch text).** The prompt that dispatches the Curator must name: the run's `taste/`
directory and `judge.json`; every slot's `screens.jsonl`; the row ids it owes a verdict for; and, for the walkthrough,
each journey's trail steps (goal, clicks counted to the control, the words the app showed, the new state). It must write
the returned object to `<run>/taste/curator.json` itself (the Curator has no write tool).

### Lane Z2 — engine text

One commit for the text and its pins (`tests/engine.test.ts`), then this note. Every verb, flag and output string was
read from `argus-live.mjs`'s usage line and the `-tastejudge`, `-tastefile`, `-propose`, `-codeproj` and `-tastecfg`
sources; the Curator's charter follows Z1's `agents/curator.md` as committed.

**What each file says now.**
- `aesthetics.md` §9: the lane's first question (world-class: easy to use, elegant, modern; functional correctness the
  floor), the pass (record, judge, confirm two of two, the Curator, `taste file`'s rating and labels, the cap and the
  polish roll-up), ISO 9241-11's split, the bar (families, classes, no style or feature rewarded), the frames the bar
  holds (`atlassian`, `carbon`, `material`, `primer`, `polaris` historical; a system with no read scale is no frame),
  bands (witness at 5 sites and 15 pages, a declared or table archetype; only `docs` reaches it; no band, no `bar` row),
  witnesses, efficiency (KLM and Fitts, the 3× / 10 s regression only while the best path no longer holds), AI
  surfaces (provenance and uncertainty only in an `ai.*` row's `reason`), taste.json's keys and SELECT's factor, with a
  taste.json example that validateTaste accepts and that names every key (pinned).
- `journeys.md`: no Curator exemption; step 6 runs `live taste judge`, the Curator in the background, then `live renew`
  and `live taste confirm <row>` per row but the cross-screen ones (`taste confirm` refuses those); step 8 writes the
  Curator's object to `.argus/live/<runId>/taste/curator.json` and runs `live taste file` (never a taste row by hand;
  `taste accept` only on the owner's word); step 10's `live report` is led by `## Taste and usability`. `taste confirm`
  runs in the background with `up`, `repro` and `down`. SELECT's scores may be fractional. Three error rows. The
  Curator's charter names the run's `taste/` directory, `judge.json`, every slot's `screens.jsonl`, the rows owed a
  verdict, each journey's trail (goal, clicks to the control, the words shown, the new state) fenced as data, the
  `ai.*` reason rule and that it sets no severity.
- `argus/SKILL.md`: the Curator role names `sapu:curator` in a journey cycle. `standards.md`: SC 2.2.2 (A) and 2.3.3
  (AAA), quoted from the Understanding pages fetched for this lane. `smoke.md`: a "The taste project" section and the
  taste job in "CI wiring" (on by default with chromium, advisory `argus-taste`, `gate` → `taste-<family>-<name>`,
  taste.json read at run time, the lane-only rules, the header's `taste-bar <n>` and `smoke check`'s `stale`, the
  scorecard and its exit, `taste-<ci.artifact>`, the baseline job's taste project for `--known`). `/sapu:journey`: the
  purpose, the taste project in the `smoke` row, the report led by the scorecard. `/sapu:init`: offers taste.json with
  the frame question, naming only the bar's frames (pinned to `loadBar().frames`). The explorer: `ai` globs in its
  charter; on such a route a message, Stop once while it streams, a second answer waited out; no request failed on
  purpose. CONTRACT.md: `-aiux` among the probes; `<runId>/taste/`'s files, `curator.json` the orchestrator's.

**Budgets raised** (each by what the text needed, rounded up): `journeys.md` 12,800 → 15,000 (14,950);
argus `SKILL.md` 42,688 → 42,832 (exact pin); journey `SKILL.md` 4,700 → 4,950 (4,927); `smoke.md` 15,150 → 16,550
(16,502); `ui-explorer.md` 19,200 → 19,400 (19,373). `aesthetics.md` (36,116), `standards.md` (20,837) and init's
`SKILL.md` (23,530) stay under the 50,000 default.

**Deviations.**
- *Every explore charter asks for a path again* (decision 3, spec §20.4): `taste confirm` refuses a journey whose
  explorer returned no path, so without it no screen row could ever be confirmed. Only a journey `smoke plan` lists
  `capture`, in a repo with `.argus/smoke.json`, goes on to `smoke admit`. The pinned sentence changed with it.
- *One judge a cycle,* not a second one after the Curator's file. The coordinator asked for `taste judge` again once
  `curator.json` is written. In the code, `curatorLeads` takes the newest return at or before the run (this run's
  included) and the judge numbers led rows first, while `taste file` maps verdicts by row id: a second judge in the
  same run can attach a verdict to another row. The leads still act, from the next cycle's judge.
- *The Curator runs beside the confirmations* and is owed a verdict on every printed row (it cannot know which will
  confirm); its file is written once both ended, before `taste file`.

**Needs coordinator.**
1. *Re-judge vs verdict ids* (above): either the judge keeps a run's row ids stable across judges (number new rows after
   the old ones), or `taste file` maps verdicts by `(journey, rule, screen, key)`. Until then the text forbids a second
   judge.
2. *No verb validates `.argus/taste.json` before a cycle.* `live check` does not read it; `select` refuses a broken one
   after `up` started. init's text says so. A `check` line for taste.json would let init verify what it wrote.
3. *The Curator's walkthrough input.* `intake` prints the explorers' free-text `cw` and trail; the orchestrator passes
   them fenced. A fixed-shape trail (goal, clicks, terms, new state) from `intake` would make the Curator's `cw` answers
   reproducible.
4. *`curator.json`'s mode.* The orchestrator writes it with its own write tool (0644 inside the run's 0700 directory);
   a verb that writes it 0600 after `validateCurator` would match the other taste files and refuse a bad return early.

### Lane Z3 — docs and diagrams

Files: `README.md`, `docs/usage.md`, `docs/security.md`, `docs/agents.md`, `docs/contributing.md`, the `journey` and `smoke`
diagrams (`docs/img/src/diagrams/{journey,smoke}.mjs`, `docs/img/src/a11y/{journey,smoke}.json`, then
`node docs/img/src/build.mjs journey smoke`; the `<picture>` alts follow the new labels). Nothing under `plugins/`, `docs/specs`
or `tests/` changed.

**Where each thing lives.**
- usage.md: `### The taste and usability pass` (what it measures, where it runs, the commands, a finding's way to an issue, the
  scorecard, `.argus/taste.json` with an example that passes `validateTaste`, promoting a rule, the CI job, the AI-surface rules,
  efficiency, the calibrated bar, limits); the `/journey` row and tips, the workflow job table, the checks table, the files table,
  the enforced list; `#### Upgrading from a version before 2.11.0`; one Common-problems row per `refused:` or `failed:` family
  the taste verbs, `select`, `classify` and the suite can print.
- security.md: `## The taste and usability pass` with `### The Curator`, `### What the recorders keep` and
  `### The calibration is maintainer-only`.
- agents.md: `### The Curator`, and a taste paragraph under `/journey`. contributing.md: `## The taste bar and its calibration`
  (the modules, the CI `taste` job, the calibration commands and D21's procedure).
- Diagrams: `journey` gains a "The taste and usability pass" card and a Curator line in its hard limits; `smoke` gains the
  advisory `taste` job under the CI jobs. Both rendered in both themes and checked for overlaps.

**Verified.** The four `taste` verbs in a scratch repository (`taste judge`, `confirm`, `file`, `accept`: every refusal quoted in
Common problems that can print without a cycle, and `accept`'s write and its repeat), `taste-calibrate`'s dry run (the plan and
the corpus counts), the example `taste.json` through `validateTaste`, every other string against the modules.

**Version.** The upgrade notes are headed 2.11.0 (D23). `plugin.json` is 2.10.0, and the remote's tags stop before 2.9.0, so if Z4
folds phase 7 into 2.10.0 (D23's fallback), move the notes into the 2.10.0 section and fix the README's two anchors.

**Needs coordinator.**
1. *`gate` accepts what the suite cannot run.* `validateTaste` accepts any non-information rule in `gate`, but the suite fails
   the step for a rule it does not measure (`argus-smoke: .argus/taste.json gate names …: no rule the suite measures in
   taste-bar <n>`): the count rules, `consistent.*`, `efficiency.*`, `ai.*`, `feedback.skeleton-peers`, `feedback.optimistic`,
   `states.error`, `states.recovery`. usage.md says so; the better fix is for `validateTaste` to refuse `laneOnly` rules in `gate`.
2. *No `bar` row can file today.* `bandOf` needs `archetypes.<a>.<rule.metric>`, and the bands hold only the six `distinct_*`
   census counts, which belong to `derived` rules. Spec §20.3 and decision 19 read as if bar rows file; usage.md says none do yet
   (the judge counts them under `not rows`). The decision's own "left for later" item is the fix.
3. *Frames.* Decision 4 and spec §20.3 name six frames; the bar holds five (no `geist`, no `shadcn`), and `taste.json` `frame`
   refuses them. usage.md lists the five. The spec's sentence is Z4's.
4. *The Curator's file.* Nothing in the code writes `taste/curator.json` (only readers exist). agents.md and usage.md say the
   return "lives" there; Z2's orchestrator text must say who saves it, and the Curator text (Z1) must match the shape
   `validateCurator` checks (`verdicts`, `leads`, `substitutions`, `cw`, every key).
5. *Init and the gitignore exception.* usage.md tells the owner to add `!/.argus/taste.json`. Plan Z2 has `/sapu:init` offer the
   file; `skills/init/SKILL.md` has no such text at this tip. Reword to "init adds it" once Z2 lands.
6. *Unpinned digest.* No test compares the shipped bar's `probe` digest with the current probe sources (they match today).
   contributing.md says a stale digest fails nothing.
7. *The calibration refusal's limits.* The plan's K note says the guard misses "a package script that runs it"; CONTRACT.md
   §Engine floor names only a renamed copy. security.md follows CONTRACT.md.
8. *The Curator reads every file under `taste/`,* including a screenshot whose scrub verdict says it shows a secret or a
   password field (the verdict gates attaching, not reading). Architect: confirm it is acceptable.
9. *No whole-pass switch.* Decision 1 rejects an opt-in, so the upgrade note says tune with `off` and `cap`. Product: confirm
   there is no repo-level escape hatch to add.
10. *`states.error` and `ai.*` rows exist only if the walk produces them.* A confirmation replays a row the walk made, so the
    explorer charter (Z2) must make an explorer reach a failure and press Stop; usage.md describes the rules and the drive as
    built.
