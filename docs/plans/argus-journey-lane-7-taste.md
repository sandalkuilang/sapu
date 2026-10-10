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

Spec: [docs/specs/argus-journey-lane.md §20](../specs/argus-journey-lane.md#20-phase-7--world-class-ui-quality-not-built-yet).
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
     `carbon`, `primer`, `atlassian`, `material`, `geist`, `shadcn` — each the numbers from its own
     token files (spacing, radius, durations, type) [carbon] [primer] [atlassian] [m3-tokens]
     [geist] [shadcn]; Polaris only as a historical frame (archived) [polaris];
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
    - Error state: in the suite, and in the lane's confirmation replay (never during an explorer's
      walk), the screen's first same-origin JSON GET is answered 500 by `page.route`; a blank main,
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
      `thin` and shown only. On the research's corpus, `marketing` and `docs` are well covered,
      `data` fair, `app` and `form` poor (most real app chrome needs a login).
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
    from `taste-state.json`: each confirmed row of the journey that is open or queued and not
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
      is a witness, beyond its p90.
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
  Not caught: a copy under another name, or a package script that runs it (CONTRACT.md says so).
- *`-redtest.mjs`* (no lane's) refuses a taste expectation as it refuses layout.
- *The golden test* (`tests/argus-live-codegen.test.ts`, "leaves every generated file byte-identical") pins the
  generated suite's files by sha256 as the generator wrote them before the split. S1 changes the output on purpose
  (the taste project, the header's `taste-bar <n>`): it updates the digests in its own commit.
- *Instance header and `-pw` test.* The DAG header in `-instance.mjs` (no lane's) names the new modules;
  `tests/argus-live-pw.test.ts`, `-perf.test.ts` and the findings test pin `PAGE_INIT` where they pinned `SIGNAL_SCRIPT`.

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
