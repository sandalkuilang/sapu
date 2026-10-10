# Argus journey lane — Phase 6: the smoke suite and its checks — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task names its model (`Model:`); reviewers are always Opus.

**Goal:** the lane leaves a regression net behind it. The catalog's critical journeys become a lean,
generated Playwright suite that is committed in the consumer repo and run by its CI on every pull
request, with no LLM at run time. It runs on Chromium, Firefox and WebKit inside the pinned
Playwright container, and on Edge where the runner has it. It covers every viewport and carries
reviewed screenshot and ARIA baselines, a responsive layout oracle, locale checks, axe's WCAG rules
with journey-scoped keyboard and dialog checks, and form, link and dynamic-state checks. The lane
keeps the suite healthy:
- it admits paths only after two runs;
- it proposes every change, baselines included, as a pull request the owner merges or closes;
- it tells a UI change from a bug by re-running unchanged expectations;
- it quarantines base-branch flakes off the critical path without hiding them;
- it measures performance against per-journey baselines;
- it seeds journeys from trusted issues and docs;
- it writes one report per cycle.

**Architecture:** spec §19 is the design. Read it first; every rule below points into it. The design
has one data format (the repro DSL in *path* mode) and one generator (`argus-live-codegen.mjs`,
grown from `argus-live-redtest.mjs`'s body builder). Each in-page check has one source, in two leaf
modules: the suite embeds it verbatim, and the lane runs it through `run-code`. The exploratory
lane is unchanged except for three additions: paths in returns, heal mode, and `pw layout`/`source`.
sapu gains no runtime dependency. The suite has exactly two dependencies, `@playwright/test` and
`@axe-core/playwright`, both pinned to exact versions in the suite's own `package.json`.

**Tech stack:** Node ≥ 22.18 ESM, vitest, `gh`, `git`, and the pinned `@playwright/cli` 0.1.22
install. That install's `playwright` 1.64 alpha package carries the test runner the lane's browser
tests drive, through a scratch `@playwright/test` stub (see D4).

Spec: [docs/specs/argus-journey-lane.md §19](../specs/argus-journey-lane.md#19-phase-6--the-smoke-suite-and-its-checks-not-built-yet);
§3 (narrowed non-goals), §10 (the DSL), §11 (guard). Roadmap: row 6, [argus-journey-lane-roadmap.md](argus-journey-lane-roadmap.md).
**Evidence:** [argus-journey-lane-6-research.md](argus-journey-lane-6-research.md). Each decision
below carries its source ids in square brackets. `[probe]` is Task 0.1's measured result, which
outranks every document.

**Precondition.** Phase 5 as built. This plan was written at 2225fcb on `feat/argus-p6`, which
branched from the 2.9.0 release branch. Its research revision builds on Task 0.1 (6bf856d). Rebase
onto the release branch once its Linux CI fixes land, before lane 0 goes on. The plugin-text rules
of phase 5's plan apply unchanged: English, no date, no three- or four-digit `#` reference, no home
path, no consumer name, no run history, and no machine-tuned number in prose. Every commit carries
the branch's `Signed-off-by` trailer and no assistant attribution. A commit that touches an
enforcement file also carries a `Rule-Change:` trailer.

---

## Verified at 2225fcb, and since

| Fact | Where |
|---|---|
| The pinned install holds `@playwright/cli` 0.1.22, `playwright` and `playwright-core` `1.64.0-alpha-1790635538000`, but **not** `@playwright/test`. npm's `latest` for `@playwright/test` is `1.64.0`, and for `@axe-core/playwright` it is `4.13.0` (MPL-2.0, `axe-core ~4.13.0`). | `scripts/pw/package-lock.json`, `npm view`, [probe], [npm] |
| `parseRepro` requires a last step with a `final` naming an oracle. `FINAL_KINDS`'s keys are exactly `ORACLES`. | `argus-live-steps.mjs` |
| `redTest` builds every string through `str()` (a JSON literal or a placeholder variable) and every target through `targetCode`. Its helpers are stubs that throw. | `argus-live-redtest.mjs` |
| `argus-live-repro.mjs` is 747 lines. The DAG test caps only `-instance.mjs` (< 700) and pins `-redtest`'s imports to `-return` and `-targets`. | `tests/argus-live-findings.test.ts` "the DAG" |
| Module names must match `^argus-live(-[a-z]+)?\.mjs$` to be in the DAG graph. | same |
| The guard lets a subagent run only `status`, `status --json` and `check` of `argus-live.mjs`. The explorer runs only `pw`. | `sapu-guard.mjs` `LIVE_READS` |
| The wrapper's login code is built from constant templates and `live.json`'s parsed locators. TOTP is Node crypto. | `argus-live-login.mjs` |
| The session hook installs `SIGNAL_SCRIPT` in every page. | `argus-live-browser.mjs`, `-session.mjs` |
| `live.json` already has `viewports`, `locales`, `locale` and `timezone`. Unknown keys are refused. | `argus-live-config.mjs` `TOP_KEYS` |
| standards.md cites WCAG 2.2 1.4.3, 1.4.10, 1.4.11, 1.4.12, 2.4.7, 2.4.11, 2.5.5, 2.5.8 and 3.2.4. It does not cite 2.1.1, 2.1.2, 2.4.3, 3.3.1, 4.1.2 or 4.1.3. | `skills/argus/standards.md` |
| A test is passed, flaky (failed, then passed on retry) or failed. 1.64 adds `--shuffle [seed]`, and 1.63 adds test locks. ARIA snapshots match partially by default. Screenshots differ per browser and platform. | [pw-retries], [pw-release], [pw-cli], [pw-aria], [pw-snap] |
| Under `updateSnapshots: "none"`, a missing screenshot fails with no actual. A mismatch attaches expected, actual and diff. `--update-snapshots=missing` writes the baseline and passes. An ARIA mismatch gives only a line diff, and a missing `.aria.yml` compares as `""`. | [probe] (As built, Task 0.1) |
| WCAG 2.4.3 requires an order that "preserves meaning and operability", not the visual order. F44 is the failure of a positive tabindex that breaks meaning. | [u-2.4.3] |

---

## Decisions (one each; alternatives rejected)

1. **The suite is generated from paths, not map steps.** A map step is a goal, not an action. Only
   an LLM could turn it into code, and no LLM runs at test time. *Rejected:* codegen from map steps.
   [pw-best]
2. **Paths come from explorers that reached the goal** (`path` in the return, charter `path:
   wanted`). A path is admitted only after two runs, fresh then dirty, which catches its assumptions
   about the data's state. *Rejected:* recording the explorer's trail (free text, not the DSL).
   [google-tott-flaky]
3. **Suite location:** `e2e/argus-smoke/` by default (`smoke.json` `dir`). The suite is
   self-contained with its own `package.json` and lockfile, so a repo in any language runs it with
   `npm ci`. *Rejected:* the repo's root `package.json`, because non-Node repos have none and it
   would touch the app's lockfile. [pw-ci]
4. **Exact pins, one version line.**
   - `@playwright/test` is pinned to `SMOKE_PLAYWRIGHT` = `1.64.0` (stable), and `@axe-core/playwright`
     to `SMOKE_AXE` = `4.13.0`. Both pins are exact, and the lockfile is committed (`npm install
     --package-lock-only --ignore-scripts`).
   - The CI image is `mcr.microsoft.com/playwright:v<SMOKE_PLAYWRIGHT>-noble`.
   - A test checks that `SMOKE_PLAYWRIGHT`'s major.minor equals the pinned lockfile's
     `playwright-core`. Bumping the CLI fails that test until the constant moves, and `smoke plan`
     then lists the suite's upgrade, which needs a baseline run (D7).
   - The pinned install has no `@playwright/test` [probe]. The lane's own browser tests therefore
     run a generated suite against the pinned alpha through a scratch
     `node_modules/@playwright/test/index.js` holding `module.exports = require("playwright/test")`.
     The probe showed this passes. Tests never run `npm install`.
   - Generated code uses only APIs present in both the alpha and 1.64.0 (test locks arrived in
     1.63). `--shuffle` lives only in the CI command line.
   - *Rejected:* the CLI's alpha in a consumer repo; installing from npm inside sapu's tests (network
     in the gate). [probe] [npm] [axe-pw] [pw-ci] [pw-release]
5. **Every suite change is a pull request** on an `argus/` branch, and sapu never merges it. This
   covers paths, heals, quarantine, drops and baselines. Merged = accepted; closed = rejected and
   remembered. *Rejected:* filing an issue for a sapu worker to apply (workers may not run lane
   verbs, and sapu would merge it itself); local patches (no review trail). [chromatic-review]
   [chromatic-branch]
6. **UI change vs bug is decided by re-running unchanged expectations** (spec §19.9). A heal changes
   only action targets, at most `heal_max_steps` of them. It can never add, drop or reorder a step,
   skip the test, add a wait or change a value. A heal is never applied at run time: CI fails, and
   the heal arrives later as a proposal. *Rejected:* runtime healing that picks the best-scoring
   locator and continues [healenium]; a healer that may patch waits or data, or skip a test it
   "believes" broken [pw-agents]; letting the explorer judge.
7. **Visual and ARIA baselines are made only by CI's baseline run on the pinned container, and they
   reach the repo as a reviewed pull request.**
   - A normal CI run never writes baselines (`updateSnapshots: "none"`). A missing baseline fails
     the run, and the failure attaches nothing to adopt [probe]. An ARIA mismatch carries only a
     line diff [probe].
   - `smoke baseline --from-run <id>` on a normal run therefore dispatches the workflow's
     `baseline` job (`workflow_dispatch`) on that run's branch, with `--update-snapshots=missing`
     for missing ids. It uses `changed` only for ids the owner names with `--ids` after reading
     `smoke ci`'s diff.
   - The same command on a baseline run adopts the files that run wrote. The adopted ARIA files are
     pruned: digit runs become `\d+`, and the marker becomes `argus-[0-9a-z]+`.
   - The files land as a commit on the run's `argus/` branch, or in an `argus/baselines-<runId>` PR
     into the run's branch. The owner reviews them in the PR's image view (2-up, swipe, onion skin)
     and accepts them by merging.
   - A journey has no visual check until its first baseline merges. Tests fail until a baseline is
     accepted, as Chromatic's do.
   - A conflicting baseline file is never resolved by picking a side. It is dropped and
     regenerated by a baseline run on the merged branch, since a stale baseline yields false
     positives.
   - *Rejected:* lane-made baselines (the wrong platform for screenshots, a second adoption path for
     ARIA); adopting `-actual.png` from a failing normal run (that covers mismatches only, and the
     probe shows new baselines need the update run anyway, so one path serves both); an external
     baseline store (no review trail). [probe] [pw-release] [pw-ci] [pw-snap] [gh-dispatch]
     [gh-images] [chromatic-branch] [percy-baseline]
8. **Cross-browser lives only in the suite.**
   - Screenshot projects run on Playwright's own Chromium, Firefox and WebKit inside the pinned
     container. WebKit is labelled as not Safari.
   - `msedge` runs the path and checks, but no screenshots, on the plain runner, whose image ships
     Edge. A branded channel moves with the runner image, not with the pin, so a baseline would
     drift. sapu never installs Edge, since `install msedge` overrides the machine's own copy.
   - The exploratory lane stays on Chrome. Its isolation (proxy, in-daemon hook, signal script) is
     proven there, and workflow defects are browser-independent. [pw-browsers] [gh-runner]
     [pw-snap]
9. **Performance is measured by the lane, not by CI.**
   - It runs on suite paths, on a quiet machine: refused while another slot is live, since
     concurrent load skews results.
   - Each batch is a warm-up, then `perf.runs` = 5 runs, and each metric takes its median. A
     regression is confirmed by a second batch.
   - LCP is read per document, and a perf run waits for `load` before acting on a new document,
     because LCP stops at the first input.
   - INP is the worst interaction, with `durationThreshold: 16`. CLS is the largest session window,
     skipping `hadRecentInput` shifts.
   - web.dev's "good" thresholds are field targets at the 75th percentile. The report shows them
     only as lab context, never as a verdict.
   - *Rejected:* a CI perf gate (noisy shared runners, no baseline store); explorer walks (not
     repeatable). [lh-variability] [lhci-config] [webdev-lcp] [webdev-cls] [webdev-inp]
     [webdev-vitals] [webdev-labfield]
10. **axe-core runs in the suite's `a11y` project** at each path screen. It uses
    `withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])` and is scoped with
    `include("main")`, or the whole page without a `main`. `target-size` is disabled, because the
    layout oracle owns 2.5.8 in every viewport.
    - Violations are fingerprinted `{check: "axe:<rule>", key: <node target>}`, and adopted known
      ones never fail. axe's `incomplete` results are reported `manual`, never failed.
    - axe replaces the hand-written contrast check. The custom checks keep what axe cannot see:
      keyboard reach, focus, dialogs, forms, layout, locale, links, loading, empty states and
      toasts.
    - *Rejected:* the earlier "no axe" decision. Its reasons (whole-page debt, a second suppression
      baseline) are exactly what `withTags`, `include` and fingerprinted known issues answer, and
      axe's zero-false-positive policy beats a re-implemented contrast engine. [pw-a11y]
      [axe-readme] [axe-api] [axe-pw]
11. **Hybrid setup.** One `setup` project signs every account in through the real UI with the
    wrapper's own login template. The storageState is gitignored and 0600, since it holds session
    cookies. The setup project records no trace, video or screenshot, because typed passwords would
    land in the artifact. Seeds go through `seed: true` triggers. *Rejected:* an owner-wired
    `signedIn` stub for every role (kept only for `login.command` roles). [pw-auth] [pw-use]
12. **Order and concurrency are proven on every CI run.**
    - Every test declares a `lock` named after each account it opens (`account:<role>.<k>`), so two
      tests sharing an account never run at once, in any project. The auth guide limits a shared
      signed-in state to tests without server-side state, and journeys change it.
    - The config sets `fullyParallel: true` (shard balance) and `workers: 1` under CI, which
      Playwright's CI guide recommends. Elsewhere it uses Playwright's default or `smoke.json`
      `workers`.
    - CI runs `--shuffle`, and the seed is printed. *Correction:* the earlier "the runner has no
      shuffle" was wrong for 1.64. [pw-auth] [pw-parallel] [pw-ci] [pw-release] [pw-cli]
      [google-tott-flaky]
13. **Flakes are quarantined off the critical path, never out of sight.**
    - A test `flaky` on a base-branch push run is proposed into `quarantine.json`. Codegen tags it
      `@quarantine`. The gating job runs `--grep-invert @quarantine`, and a non-gating quarantine
      job keeps running it.
    - A flake first seen on a pull request's head, never seen on the base, is `flaky-new`. It gets a
      comment on that PR and is never quarantined, since quarantine "could easily mask a real race
      condition".
    - A test leaves quarantine after three cycles in which the lane held it twice and every
      quarantine-job result read passed first time. It is dropped after a second quarantine or
      five cycles. `failOnFlakyTests` stays off, because a retry-pass reports as `flaky`, not red.
    - *Rejected:* `test.fixme` (it stops the runs that prove recovery); marking a test flaky and
      re-running it until green. [google-flaky] [google-flaky-size] [pw-retries] [pw-config]
14. **The API-level RED hint ships in phase 6.** It is one line from `repro --test` when the final
    is `fact-equals` or `mail`. Generating API tests is a follow-up, because the engine knows no
    app's API.
15. **A smoke suite needs the contract's home `repo` and `traces: "visible"`.** Office mode gets
    none.
16. **The CI workflow is written by `/sapu:init`, only with consent**, from `smoke workflow`. It
    carries:
    - `permissions: contents: read` and no `pull_request_target`;
    - actions pinned to full commit SHAs, which `smoke workflow` resolves through `gh api` when it
      prints the file;
    - the container with `--ipc=host --init`;
    - `globalTimeout` and `forbidOnly` under CI;
    - artifacts with `retention-days: 7`;
    - the `baseline` dispatch, whose inputs reach the shell only through `env:` and are checked
      against fixed shapes.

    Without a `workflow` token scope, init hands the file over. [pw-ci] [pw-docker] [pw-config]
    [gh-secure] [gh-artifacts] [gh-dispatch]
17. **Version 2.10.0** at the end (new behaviour, new `live.json` keys an older plugin refuses).
    If 2.9.0 is still untagged when this phase closes, phase 6 rides in 2.9.0 and the upgrade note
    grows. Task Z4 decides from `git ls-remote --tags`.
18. **Screenshot settings are Playwright's own defaults, made explicit.**
    - `threshold` stays at 0.2, with no pixel allowance. `animations: "disabled"` and `caret:
      "hide"` are set, and the pointer is parked (`page.mouse.move(-1, -1)`) before each shot.
    - Shots are viewport-only PNGs. The `mask` covers `time` elements, the marker, every saved
      value and the journey's configured `masks`. Each project names its own path:
      `__screenshots__/{projectName}/{platform}/{testFileBaseName}/{arg}{ext}`.
    - *Rejected:* a pixel allowance by default (the pinned container removes the platform noise it
      would paper over); WebP (PNG is what the PR image view shows). [pw-snap] [pw-config]
19. **Fences are hygiene, not a boundary.** Text from pages, issues, docs and CI artifacts is
    fenced as data. The guarantees come from elsewhere: the explorer's confinement (only `pw`, no
    network out), the deterministic gates (`validateMap`, `map-check` anchors, repro two of two,
    the heal decision table) and the owner's merge of every proposal. *Rejected:* an LLM guardrail
    filter, which is "itself susceptible to prompt injection". [owasp-llm01] [owasp-pi-cheat]

---

## Lanes, models, merge order

Lane 0 is sequential and lands first. It owns every shared hotspot: the config schema, the CLI
dispatch, the guard, CONTRACT.md, the DAG test, the DSL, the runner and the generator. After it,
lanes A–F run in parallel worktrees, each owning disjoint files. Lane Z is sequential and last. No
lane edits the spec; Z4 folds in the as-built notes.

**Rules for parallel lanes.**
- A lane edits only the files its table row lists.
- A lane implements the function bodies lane 0 stubbed, with the signatures below.
- A lane never edits `argus-live.mjs`, `argus-live-config.mjs`, `sapu-guard.mjs`, CONTRACT.md, the
  DAG test or the spec. A missing hook is reported back to lane 0, not added.
- Each lane's tests live in its own test file.
- Engine text (agent file, skills, init, docs) waits for lane Z.

| Lane | Tasks | Owns | Model mix | Estimate |
|---|---|---|---|---|
| 0 | 0.1 → 0.2 → 0.3 → 0.4 | `argus-live.mjs`, `-config.mjs`, `-steps.mjs`, `-classes.mjs`, `-return.mjs`, `-repro.mjs`, `-minimize.mjs`, `-smoke.mjs`, `-codegen.mjs`, `-redtest.mjs`, `sapu-guard.mjs`, CONTRACT.md, `tests/argus-live-findings.test.ts`, `tests/argus-live-smoke.test.ts`, `tests/sapu-guard.test.ts`, every new module's stub | opus-high (0.1 sonnet-medium) | 7 h |
| A | A1 → A2 → A3 → A4 | `-suite.mjs`, `-propose.mjs`, `tests/argus-live-suite.test.ts` | A1 sonnet-medium, A2–A4 opus-high | 5.5 h |
| B | B1 → B2 → B3 | `-heal.mjs`, `-ci.mjs`, `tests/argus-live-ci.test.ts`, `tests/fixtures/ci-artifact/` | opus-high | 7 h |
| C1 | C1.1 → C1.2 → C1.3 | `-layout.mjs`, `tests/argus-live-layout.test.ts`, `tests/fixtures/journey-app/pages/layout/` | sonnet-medium | 4 h |
| C2 | C2.1 → C2.2 → C2.3 → C2.4 | `-a11y.mjs`, `skills/argus/standards.md`, `tests/argus-live-a11y.test.ts`, `tests/fixtures/journey-app/pages/a11y/`, `tests/fixtures/axe-results/` | sonnet-medium | 4.5 h |
| C3 | C3.1 → C3.2 | `-codegen.mjs` (after lane 0), `tests/argus-live-codegen.test.ts` | sonnet-medium | 3.5 h |
| D | D1 | `-perf.mjs`, `-session.mjs`, `-smoke.mjs` (after lane 0), `tests/argus-live-perf.test.ts` | sonnet-medium | 3.5 h |
| E | E1 | `-seed.mjs`, `-pw.mjs`, `-slots.mjs`, `-map.mjs`, `tests/argus-live-seed.test.ts` | opus-high | 3 h |
| F | F1 → F2 | `-report.mjs`, `-scrub.mjs`, `-repro.mjs` (after lane 0), `tests/argus-live-report.test.ts` | F1 opus-high, F2 sonnet-medium | 2.5 h |
| Z | Z1 → Z2 → Z3 → Z4 | `-pw.mjs`/`-steps.mjs` runner kind (Z1), engine text, docs, diagrams, spec, roadmap, this plan | Z1, Z3 sonnet-medium; Z2 opus-high; Z4 review Opus | 7 h |

**Merge order after lane 0:** A, C3, C1, C2, B, D, E, F. Each lane is rebased on the one before,
and the whole suite is green before the next merges.
- A goes before B, because heal and baseline proposals use A's propose and A4's dispatch job.
- C3 goes before C1 and C2, because the check registry's emitters and the axe pin live in C3's
  projects and `package.json`.

Critical path ≈ lane 0 (7 h) + the longest lane (B, 7 h) + merges (2 h) + Z (7 h) ≈ 23 h
wall-clock, against ≈ 47 h serial.

**Signatures lane 0 fixes.** Each returns `{code, lines}`; the CLI prints `lines` and exits with
`code`. They are unchanged by the research revision.

| Module | Signatures |
|---|---|
| `-suite.mjs` | `smokePlan(main)`, `smokeAdmit(main, ref)`, `smokeCheck(main)` |
| `-propose.mjs` | `smokePropose(main, {dryRun})`, `smokeWorkflow(main)` |
| `-smoke.mjs` | `smokeRun(main, {ids, slot, perf, seed})` |
| `-heal.mjs` | `smokeHeal(main, ref)` |
| `-ci.mjs` | `smokeCi(main, {run})`, `smokeBaseline(main, {fromRun, ids})` |
| `-perf.mjs` | `perfIssue(main, id)`, `perfRebaseline(main, id)` |
| `-seed.mjs` | `seed(main, {issue, doc})` |
| `-report.mjs` | `report(main, {run})` |

`smokeBaseline` dispatches on a normal run and adopts on a baseline run (D7). Check modules export
`CHECKS`: `[{name, project, when, source, emit(step, ctx) → string[]}]` (`-layout.mjs`, `-a11y.mjs`).

---

## File structure

| File | Responsibility |
|---|---|
| `scripts/argus-live-config.mjs` | `live.json` keys `test_id_attribute`, `pseudo_locales`, `tokens`, `triggers.*.seed`; `loadSmoke`, `validateSmoke`, `SMOKE_KEYS` (0.2) |
| `scripts/argus-live-steps.mjs` | path mode, selector order, the `regression` oracle, the `layout` expectation (0.2, 0.3) |
| `scripts/argus-live-classes.mjs` | the `regression` row (0.2) |
| `scripts/argus-live-return.mjs` | `path` and `heal` in a return (0.3) |
| `scripts/argus-live-minimize.mjs` | new: `minimize`, `redTestFile`, `savedValues` moved out of `-repro.mjs` (0.3) |
| `scripts/argus-live-repro.mjs` | `runOnce` path mode (0.3); the API-level hint (F2) |
| `scripts/argus-live-smoke.mjs` | new: `smokeRun` (0.3); `--perf` (D1) |
| `scripts/argus-live-codegen.mjs` | new: the suite generator, locks, CI config rules (0.4); projects, visual, browsers, the axe pin (C3) |
| `scripts/argus-live-redtest.mjs` | its body builder moved to `-codegen.mjs`; `redTest` becomes a thin caller (0.4) |
| `scripts/argus-live-suite.mjs` | new: plan, admit, check (A1–A3) |
| `scripts/argus-live-propose.mjs` | new: propose, workflow (A3, A4) |
| `scripts/argus-live-heal.mjs`, `-ci.mjs` | new: heal (B1); CI triage, quarantine, the baseline run and adoption (B2, B3) |
| `scripts/argus-live-layout.mjs`, `-a11y.mjs` | new leaves: check sources and emitters, with axe's emitter in `-a11y` (C1, C2) |
| `scripts/argus-live-perf.mjs` | new: `PERF_SCRIPT`, medians, baselines, the perf issue (D1) |
| `scripts/argus-live-seed.mjs` | new: seeds (E1); `-pw.mjs` `source`, `-slots.mjs` `--seed`, `-map.mjs` `seeds` |
| `scripts/argus-live-report.mjs` | new: the report (F1); `-scrub.mjs` `filed.jsonl` |
| `scripts/argus-live.mjs` | dispatch and usage for every new verb (0.2) |
| `scripts/sapu-guard.mjs` | `["smoke", "check"]` in `LIVE_READS` (0.2) |
| `agents/ui-explorer.md`, `skills/argus/journeys.md`, `skills/journey/SKILL.md`, `skills/journey/smoke.md` (new), `skills/init/SKILL.md`, CONTRACT.md | engine text (Z2; CONTRACT.md layer rows in 0.2) |
| `README.md`, `docs/usage.md`, `docs/security.md`, `docs/agents.md`, diagrams | Z3 |

---

## Lane 0 — prerequisites (sequential, lands first)

### Task 0.1: probe the pinned runner
**Model: sonnet-medium.** No production code. With the pinned install's `playwright/cli.js test` against
`tests/fixtures/journey-app` on Chrome, record in "As built" (each a yes/no with the observed output):
missing screenshot baseline under `updateSnapshots: "none"` fails and attaches `-actual.png` in
`results.json`; `toMatchAriaSnapshot({name})` with `expect.toMatchAriaSnapshot.pathTemplate` and its
actual on mismatch; partial ARIA matching of extra list items; `results.json` shows `test.step` titles
and status `flaky` with `retries: 1`; `storageState` from a setup project with `dependencies`;
`toHaveAccessibleName`; `testIdAttribute`; `run-code` can call `page.ariaSnapshot()` and
`page.keyboard.press("Tab")`. A "no" changes the matching spec line in Z4, never silently.
- [x] Probe; write the outcomes (see "As built (phase 6)"). **Commit** `docs(sapu): phase 6 plan — the pinned runner's facts`.

### Task 0.2: shared surfaces
**Model: opus-high** (guard change, schema). **Files:** `-config.mjs`, `-steps.mjs` (registry only),
`-classes.mjs`, `argus-live.mjs`, `sapu-guard.mjs`, CONTRACT.md, stub modules, `tests/argus-live-findings.test.ts`,
`tests/sapu-guard.test.ts`, `tests/argus-live-smoke.test.ts`.
- [ ] **Failing tests:** `validateLive` takes the four new keys and refuses each wrong shape (a
  `test_id_attribute` not `^[a-z][a-z0-9-]{0,63}$`; a `pseudo_locales` code `Intl.getCanonicalLocales`
  refuses; `tokens` with both or neither key, an absolute path or `..`; `seed` not boolean);
  `validateSmoke` defaults, caps (`max` ≤ 50), unknown keys, a non-loopback `ci.web_server` URL, a pin of
  an unknown id kept for `smoke plan` to refuse; `ORACLES` holds `regression` and `FINAL_KINDS.regression`
  every expectation kind; `classify --oracle regression [--money]` prints class A, `bug`, the needs-owner
  label, S2 with `--money` else S3; the usage line names every §19.15 verb and each stub answers
  `refused: <verb>: not built yet`; the DAG test admits each new module with its allowed imports
  (`-layout`, `-a11y` leaves; `-codegen` imports `-targets`, `-return`, `-steps`, `-layout`, `-a11y`,
  `-login`; `-smoke` above `-repro`; `-suite`, `-propose`, `-heal`, `-ci`, `-perf`, `-seed`, `-report`
  below `argus-live.mjs` and above what they read) and caps every argus-live module at 750 lines; the
  guard passes `smoke check` to a subagent and refuses `smoke plan`, `smoke propose`, `seed`, `report`.
- [ ] **Run** → FAIL. **Implement.** **Run** the files, then `npx vitest run` → PASS.
- [ ] **Commit** `feat(sapu): argus-live phase 6 surfaces — live.json keys, smoke.json, the regression
  oracle, the new verbs' dispatch`, trailer `Rule-Change: the guard lets a subagent run argus-live smoke
  check, a read; the DAG test caps argus-live modules at 750 lines`.

### Task 0.3: path mode and the lane's pass
**Model: opus-high** (page-derived strings become committed data). **Files:** `-steps.mjs`, `-return.mjs`,
`-repro.mjs`, `-minimize.mjs` (new), `-smoke.mjs`, `tests/argus-live-repro.test.ts`, `tests/argus-live-smoke.test.ts`.
- [x] **Step 0 (pure move):** `minimize`, `redTestFile`, `savedValues` to `-minimize.mjs`; the existing
  repro tests pass unchanged. Commit `refactor(sapu): argus-live minimize moves beside the runner`.
- [x] **Failing tests:** `parseRepro(list, {accounts, live, path: true})` takes a list ending in an
  `expect` with no `final`, refuses a `final`, a `{text}` action target, `{testId}` without
  `test_id_attribute`, `within` nested twice, a leading `trigger` not `seed: true`, and keeps every §10
  rule; `validateReturn` takes `path` (parsed in path mode against the slot's accounts) and `heal`
  (`[{step, target}]`, at most `heal_max_steps`, targets through `parseTarget`'s smoke kinds, or `[]`
  with `reason` in `no-control|blocked|harness`); `runOnce(..., {path})` on the fixture app prints
  `PATH held` (exit 0) or `PATH broke step=<n> kind=target-missing|target-ambiguous|expect-failed|action-failed`
  (exit 3), records under `<run>/smoke/<id>/`; `smokeRun` runs paths in the order `--seed` shuffles,
  confirms a break with a second run after `up --fresh` (`broke` only at two of two, else `flaky`), and
  with `--slot <n>` writes a confirmed expectation break as slot `n`'s return holding one `regression`
  candidate that `repro <n>.<g>.1` reproduces two of two.
- [x] **Run** → FAIL. **Implement.** **Run**, then `npx vitest run` → PASS.
- [x] **Commit** `feat(sapu): argus-live paths — the DSL's path mode, the runner's PATH verdicts, the
  lane's smoke pass`.


### Task 0.4: the generator core
**Model: opus-high** (codegen of page-derived strings, storageState). **Files:** `-codegen.mjs` (new),
`-redtest.mjs`, `tests/argus-live-codegen.test.ts`, `tests/fixtures/argus-red/` (golden unchanged).
- [x] **Failing tests.** Each test scans the generated text.
  - **The RED test.** The golden RED test is byte-identical through the moved builder.
  - **`smokeSpec` bans.** The fixture path's spec holds none of: `waitForTimeout`, `setTimeout`,
    `sleep`, a template literal of path data, a CSS selector, an XPath, `describe.serial`,
    `beforeAll`, `afterAll`, a module-level `let`, `test.fixme`.
  - **`smokeSpec` shape.**
    - The marker is declared inside the test.
    - Every step is a `test.step("step <n> …")`.
    - The test declares `lock: ["account:<role>.<k>", …]`, one entry for each account it opens and
      no other [pw-parallel].
    - A quarantined id carries `tag: "@quarantine"` [google-flaky].
    - Every string of the path appears only as a JSON literal: a path value holding `` ` ``, `${`,
      `"` and `\n` comes out inert.
  - **`smokeConfig`.**
    - It sets `fullyParallel: true`, plus under CI: `retries: 1`, `workers: 1`, `forbidOnly: true`,
      `globalTimeout` and `updateSnapshots: "none"`. Outside CI, `workers` follows `smoke.json` or
      is unset [pw-ci] [pw-config].
    - It sets `trace: "on-first-retry"`, and `use: {trace: "off", video: "off", screenshot: "off"}`
      on the `setup` project [pw-auth].
    - It has a loopback guard that throws on `http://example.test`.
    - It sets `testIdAttribute` only with `test_id_attribute`.
  - **`authSetup`.** It embeds the wrapper's login template verbatim, writes
    `.auth/<role>.<k>.json` and chmods it 0600. It reads passwords and TOTP secrets by their
    `${NAME}` names from `process.env` and never holds a value.
  - **Support and package files.**
    - `support.ts` runs triggers by argv without a shell and checks values against `args`.
    - The suite's `.gitignore` lists `.auth/`.
    - `package.json` pins `@playwright/test` exactly to `SMOKE_PLAYWRIGHT`, whose major.minor
      equals the pinned lockfile's `playwright-core`.
  - **Determinism.** Generation is a pure function (same input, same bytes), and every file's
    header digest matches its body.
  - **Browser test.**
    - The generated suite for the fixture app runs with `CI=1` under the pinned alpha runner and a
      wrapper config (`channel: "chrome"`, `--project setup --project chromium`).
    - `@playwright/test` resolves through a scratch `node_modules/@playwright/test/index.js` holding
      `module.exports = require("playwright/test")`, never through `npm install` [probe].
    - The suite passes, and the runner accepts the `lock` option.
- [x] **Run** → FAIL. **Implement** (the `CHECKS` registry loop is in place, empty until C1, C2).
  **Run**, then `npx vitest run` → PASS.
- [x] **Commit** `feat(sapu): argus-live codegen — the smoke suite generated from paths, setup project
  and support, the RED test through the same builder`.

---

## Lane A — suite lifecycle

### A1: `smoke plan`
**Model: sonnet-medium.**
- [ ] **Failing tests:**
  - the rank of §19.3 on a fixture catalog: pin > money > exposure > filed > roles > id;
  - members before non-members of a tier;
  - `global` and dropped journeys skipped;
  - `exclude` and `max`;
  - each output line kind;
  - a pinned global refused;
  - home `local` or `traces: "none"` refused;
  - `pending` from an open `argus/` PR (gh stub);
  - `upgrade <from> → <to> (baseline run needed)` when the suite's pin is behind `SMOKE_PLAYWRIGHT`
    [pw-snap].
- [ ] Run → FAIL; implement; run → PASS.
- [ ] **Commit** `feat(sapu): argus-live smoke plan ranks the catalog into the suite's members`.

### A2: `smoke admit`
**Model: opus-high.**
- [ ] **Failing tests:**
  - a return's path runs twice, fresh then dirty (the `up --fresh` stub is counted once), and is
    staged with `{run, head, pathSha, seed}`;
  - a break in either run refuses with `<run> <kind> at step <n>`;
  - a journey that `smoke plan` does not list as `capture` is refused;
  - a path whose values hold a ledger secret is refused by name and position, never by value.
- [ ] Run → FAIL; implement; run → PASS.
- [ ] **Commit** `feat(sapu): argus-live smoke admit stages a path that held fresh and dirty`.

### A3: `smoke propose`, `smoke check`
**Model: opus-high.**
- [ ] **Failing tests** (git and gh stubs):
  - propose builds a worktree from `origin/<base>` and writes the staged paths, the regenerated
    files, the `changes.jsonl` lines and the lockfile (npm stub);
  - it commits with the contract's `gitEmail` and `Signed-off-by`, pushes `argus/smoke-<runId>`,
    and opens a PR with `labels.agentFiled`;
  - the body lists each journey that still needs a baseline, as
    `baseline: needed <id> (smoke baseline --from-run after this PR's first CI run)` [probe];
  - a baseline file that conflicts on rebase is dropped from the commit and listed as `baseline:
    needed`, never resolved by picking a side [chromatic-branch];
  - a file or body holding a ledger secret refuses before any push, naming `file:line:col class`;
  - a rejected digest is never proposed again;
  - `--dry-run` prints the change list and writes nothing;
  - `smoke check` names a hand-edited spec, a stale header digest and a `live.json` drift, passes a
    clean suite, and writes nothing.
- [ ] Run → FAIL; implement; run → PASS.
- [ ] **Commit** `feat(sapu): argus-live smoke propose opens the suite's changes as a pull request;
  smoke check finds hand edits`.

### A4: `smoke workflow`
**Model: opus-high** (CI secrets).
- [ ] **Failing tests:** the YAML has:
  - `pull_request`, a base-branch push and `workflow_dispatch` with inputs `baseline`
    (`missing|changed`) and `grep`;
  - `permissions: contents: read`, and no `pull_request_target`;
  - the fork skip;
  - every `uses:` pinned to a 40-hex SHA with a `# <tag>` comment, resolved by `gh api` (gh stub;
    an unresolvable tag refuses printing) [gh-secure];
  - `persist-credentials: false`;
  - the test job in `container: mcr.microsoft.com/playwright:v<SMOKE_PLAYWRIGHT>-noble` with
    `--ipc=host --init`, its matrix over the screenshot projects with `setup` [pw-ci] [pw-docker];
  - an `msedge` job on the plain runner with no container [gh-runner];
  - the suite directory's `npm ci` and `npx playwright test --shuffle --grep-invert @quarantine`;
  - a `quarantine` job with `--grep @quarantine` and `continue-on-error: true` [google-flaky];
  - the `baseline` job, dispatch only, running `--update-snapshots=$MODE --grep "$GREP"` with both
    inputs passed through `env:` and checked against `^(missing|changed)$` and `^[a-z0-9|-]+$`
    before use [gh-dispatch] [gh-secure];
  - the upload of `test-results/` as `argus-smoke-results`, and in the baseline job also the
    written `__screenshots__/` and `__aria__/` files as `argus-smoke-baselines`, all with
    `retention-days: 7` and never `.auth/` [gh-artifacts];
  - exactly the `${NAME}` names `live.json` uses, passed as `secrets.<NAME>`: no value.
- [ ] Run → FAIL; implement; run → PASS.
- [ ] **Commit** `feat(sapu): argus-live smoke workflow prints the CI job init writes`.

## Lane B — breaks, triage, baselines

### B1: `smoke heal` and the decision table
**Model: opus-high.**
- [ ] **Failing tests:**
  - a heal return replaces only the named steps' targets;
  - the healed path runs twice, fresh then dirty;
  - held → a staged heal with `git log -S` evidence (`no commit removed it` when none), and the
    proposal body shows the old and new target of each healed step;
  - an expectation failing → a regression candidate at it;
  - `heal: []` with `no-control` → a regression candidate ending in `visible` on the old target;
  - a heal is refused if it touches an expectation, a value or an action kind, removes or adds a
    step, or names more than `heal_max_steps` steps [pw-agents];
  - nothing in CI ever applies a heal [healenium];
  - every §19.9 row has a test.
- [ ] Run → FAIL; implement; run → PASS.
- [ ] **Commit** `feat(sapu): argus-live smoke heal proposes only what unchanged expectations prove`.

### B2: `smoke ci` and quarantine
**Model: opus-high.**
- [ ] **Failing tests** (fixture artifacts and `gh run view` stubs):
  - **Flakes.**
    - `flaky` on a base-branch push run → a staged quarantine and its fingerprint.
    - `flaky` on a PR head with no base-branch flake in `smoke-state.json` → `flaky-new <id> <pr>`
      and a PR comment, never a quarantine [google-flaky].
  - **Failures.**
    - Failed in an action step → `ui-change? <id> step <n>`.
    - Failed in an expectation → `bug? <id> step <n>`.
    - Failed only off Chromium → `browser-only <project>`.
  - **Checks and baselines.**
    - A check → `check <id> <check> <key>`, and an axe `incomplete` → `manual <id> <rule>`.
    - A missing baseline (`A snapshot doesn't exist`) → `baseline-missing <id> <project>`.
    - A screenshot mismatch → `visual <id> <n> <project>`, naming the expected, actual and diff
      files [probe].
    - An ARIA mismatch → `aria <id> <n>` with the message's line diff, ANSI stripped and fenced
      [probe].
  - **Refusals.** These are refused or skipped: a run from a fork, a path outside the suite's
    names, a non-PNG `-actual.png`, and an oversized file. No artifact text appears outside a fence.
  - **Quarantine lifecycle.**
    - The exit is staged after three cycles in which the lane held the test twice and every
      quarantine-job result read passed first time.
    - A second quarantine, or five cycles, stages `drop`.
- [ ] Run → FAIL; implement; run → PASS.
- [ ] **Commit** `feat(sapu): argus-live smoke ci triages the CI run and quarantines base-branch flakes`.

### B3: `smoke baseline`
**Model: opus-high.**
- [ ] **Failing tests** (gh stubs):
  - **A normal run.** `--from-run` dispatches `gh workflow run <workflow> --ref <head branch> -f
    baseline=missing -f grep=<ids>` for its `baseline-missing` ids, and prints `baseline:
    dispatched <ids> mode=missing; adopt with smoke baseline --from-run <new run id>`.
  - **Changed baselines.** `--ids <ids>` on a run with `visual` or `aria` mismatches dispatches
    `mode=changed` for exactly those ids. Without `--ids` a mismatch is never re-baselined
    [chromatic-branch].
  - **A baseline run** (event `workflow_dispatch`, artifact `argus-smoke-baselines`).
    - It adopts only `__screenshots__/<project>/<platform>/<id>/*.png` (a PNG signature, under 5 MB,
      not `msedge`), `__aria__/<id>/*.aria.yml` (under 1 MB; digit runs to `\d+`, the marker
      shape) and `violations-<id>.json` (under 1 MB).
    - The files land as a commit on the run's `argus/` branch, else as an `argus/baselines-<runId>`
      PR into the run's branch. The PR body lists each file with journey, step and project, for
      review in GitHub's image view [gh-images].
  - **Refusals.**
    - A run on another repository is refused.
    - A run whose head SHA is no longer its branch's head is refused as `stale`.
    - Nothing outside the defined names is copied.
  - **No dispatch right.** Without the `actions` scope, the `gh workflow run` line is printed for the
    owner instead [gh-dispatch].
- [ ] Run → FAIL; implement; run → PASS.
- [ ] **Commit** `feat(sapu): argus-live smoke baseline runs CI's baseline job and proposes what it
  wrote`.

## Lane C1 — layout, locale, links, dynamic states

### C1.1: layout oracle
**Model: sonnet-medium.** Fixture pages each hold a violation and its excluded twin: a wide table,
sr-only text, an ellipsis with `title`, a fixed header over a control, a modal backdrop, an inline
link, a native checkbox, and a label-covered custom checkbox.
- [ ] **Failing tests:**
  - every positive is reported with a stable key, and no excluded twin is (the false-positive set
    is the test);
  - `emit` adds a soft check after every step for the viewport projects;
  - the target-size rule follows 2.5.8's circle and exceptions [wcag22] [u-2.5.8].
- [ ] Run → FAIL; implement; run → PASS.
- [ ] **Commit** `feat(sapu): argus-live layout oracle — page scroll, clipped text, covered controls,
  target size`.

### C1.2: locale and format checks
**Model: sonnet-medium.**
- [ ] **Failing tests:**
  - under `de-DE`, `1,234.56` fails and `1.234,56` holds;
  - `13/02/2026`-shaped text fails on day order under `en-US`;
  - ISO dates, inputs, `code` and `translate="no"` are skipped;
  - a page with `lang="en"` under `de-DE` is `not localized`;
  - pseudo-locales run only page-scroll and clipped;
  - under a pseudo-locale, visible text identical to the default locale's render (path values,
    digits and `translate="no"` excluded) is reported as `pseudo-localization: <n> text unchanged
    under <code> (hard-coded?)`, never failed [android-pseudo] [mozilla-pseudo];
  - without `pseudo_locales`, the line `pseudo-localization: not done (no pseudo-locale listed)`.
- [ ] Run → FAIL; implement; run → PASS.
- [ ] **Commit** `feat(sapu): argus-live locale checks — overflow under each locale, number and date
  formats`.

### C1.3: links, CTA routes, loading, empty, toasts
**Model: sonnet-medium.**
- [ ] **Failing tests:**
  - **Links** [lychee] [linkinator].
    - A 404, 410 and 500 link fail. A 302 to sign-in holds.
    - A 401 or 403 is `manual` (a link offered to a role that cannot open it). A 429 is `manual`,
      with no retry wait.
    - Requests go one at a time, with `maxRedirects: 0` and redirects followed by hand only within
      the origin (at most 5). Another origin is never requested. `link_cap` holds.
  - **CTA routes.** An unvisited map route fails.
  - **Loading.** A stuck `aria-busy` fails, and a resolved one holds.
  - **Empty states.** An empty table without text fails, and one with an empty-state message holds.
  - **Toasts.** A non-live fixed toast fails 4.1.3, a live toast over the next target fails, and a
    dismissible one holds [u-4.1.3].
- [ ] Run → FAIL; implement; run → PASS.
- [ ] **Commit** `feat(sapu): argus-live checks — links and CTA routes, loading, empty states, toasts`.

## Lane C2 — accessibility

### C2.1: keyboard pass, focus and names
**Model: sonnet-medium.**
- [ ] **Failing tests:**
  - a `div` with a click handler is not in the tab order (2.1.1);
  - a radio inside a `radiogroup`, a `tab` and a `menuitem` pass once Tab reaches their widget,
    because arrows move inside a composite [apg-keyboard];
  - `tabindex="3"` jumping back in DOM order is `manual` (F44 needs a human), never a fail
    [u-2.4.3];
  - an outline-less button fails focus visible;
  - a solid `outline` under 3:1 against the adjacent background fails 1.4.11, and any other
    indicator is `manual` [u-1.4.11];
  - a sticky footer over the focused control fails 2.4.11;
  - `hover` and `dblclick` targets are skipped;
  - 500 presses → undetermined;
  - a nameless icon button fails `toHaveAccessibleName`.
- [ ] Run → FAIL; implement; run → PASS.
- [ ] **Commit** `feat(sapu): argus-live a11y — keyboard reach, order, visible focus, names`.

### C2.2: ARIA snapshots, modals
**Model: sonnet-medium.**
- [ ] **Failing tests:**
  - **ARIA snapshots** [probe].
    - `emit` writes `toMatchAriaSnapshot({name: "<n>.aria.yml"})` at the path's screens, with the
      `__aria__` template and `children: "contain"` [pw-aria].
    - A journey with no adopted `.aria.yml` fails as `baseline-missing` (the probe compares it as
      `""`), and B3 is the only way it gets one.
  - **Modals** [apg-dialog] [apg-alertdialog] [mdn-dialog].
    - A modal dialog and a modal `alertdialog` both Escape-close.
    - A non-modal dialog is exempt from the Escape and Tab rules.
    - Focus returns to the invoker. A removed invoker is exempt, focus lost to `body` fails, and
      focus elsewhere is `manual`.
    - Focus escaping a modal fails.
    - Two modal dialogs with different backdrop behaviour fail consistency.
- [ ] Run → FAIL; implement; run → PASS.
- [ ] **Commit** `feat(sapu): argus-live a11y — ARIA snapshots and modal dialogs`.

### C2.3: axe rules, tokens, forms
**Model: sonnet-medium.**
- [ ] **Failing tests:**
  - **axe** [pw-a11y] [axe-api] [axe-readme].
    - `emit` writes at each path screen of the `a11y` project an `AxeBuilder` with exactly the
      tags `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa`, `include("main")` when the page
      has one, and `disableRules(["target-size"])`.
    - From recorded results in `tests/fixtures/axe-results/` (no axe runs in sapu's tests): each
      violation node becomes `{check: "axe:<rule>", key: <target joined>}`, a known one is
      filtered, and `incomplete` becomes `manual`.
  - **Tokens.**
    - With a token CSS file, an off-token colour fails.
    - Without `tokens`, the skip line.
  - **Forms.**
    - Each form case from `required`, `type=email`, `maxlength`, `minlength` and `pattern` is
      generated, and none other.
    - A form that posts and gets 200 on a bad value fails.
    - Native validation holds.
    - `novalidate` with `aria-invalid` and `aria-describedby` holds.
    - Focus on an error-summary link to the field holds.
- [ ] Run → FAIL; implement; run → PASS.
- [ ] **Commit** `feat(sapu): argus-live a11y — axe's WCAG rules, design tokens, form validation
  cases`.

### C2.4: standards citations
**Model: sonnet-medium.** Fetch, read and quote the WCAG 2.2 Understanding pages for 2.1.1, 2.1.2,
2.4.3, 3.3.1, 4.1.2 and 4.1.3 into standards.md's accessibility table: the level as printed, the
sentence quoted, and the page's URL, as phase 5 did. A page that does not load is marked ⚠, never
quoted. The research doc lists the URLs [wcag22] [u-2.1.1] [u-2.1.2] [u-2.4.3] [u-3.3.1] [u-4.1.2]
[u-4.1.3].
- [ ] **Failing test** (engine): each SC above appears with its Understanding URL.
- [ ] Run → FAIL; edit; run → PASS.
- [ ] **Commit** `docs(sapu): argus standards cite the WCAG criteria the smoke suite's checks measure`.

## Lane C3 — projects, browsers, visual

### C3.1: projects and browsers
**Model: sonnet-medium.**
- [ ] **Failing tests:**
  - **Projects.**
    - `setup`, `chromium`, `firefox` and `webkit`.
    - `msedge` only when the executable exists (a filesystem seam). Absent → the skip line, and no
      project.
    - `chromium-<w>` for each further viewport.
    - `a11y`, and `i18n` only with locales.
  - **Project rules.**
    - Every project depends on `setup`, and per-journey `browsers` are honoured.
    - `msedge` has no screenshot assertions [pw-browsers].
    - A comment names WebKit as not Safari.
  - **Package.** `package.json` pins `@axe-core/playwright` exactly to `SMOKE_AXE` [axe-pw].
- [ ] Run → FAIL; implement; run → PASS.
- [ ] **Commit** `feat(sapu): argus-live codegen — browser, viewport, a11y and i18n projects`.

### C3.2: screenshots
**Model: sonnet-medium.**
- [ ] **Failing tests:**
  - **The shot.**
    - `toHaveScreenshot("<n>.png")` at the path's screens with `animations: "disabled"` and
      `caret: "hide"`, after `page.mouse.move(-1, -1)`.
    - Masks for `time`, the marker, every saved value and the journey's `masks`.
    - No `maxDiffPixels` and no `threshold` override [pw-snap] [pw-config].
  - **Config.**
    - The `snapshotPathTemplate` is `{testDir}/__screenshots__/{projectName}/{platform}/{testFileBaseName}/{arg}{ext}`.
    - `ignoreSnapshots` is on outside CI.
  - **Browser test** (stub runner of Task 0.4, `CI=1`).
    - `"none"` fails a missing shot with no actual.
    - `--update-snapshots=missing` writes it and passes, overriding the config's `"none"`.
    - `--update-snapshots=changed` rewrites a mismatching `.aria.yml`, a mode the probe did not
      cover. A "no" here moves B3's ARIA adoption to the lane regenerating the snapshot with
      `run-code` and `page.ariaSnapshot()`, which the probe showed matches the baseline form. Z4
      records it.
- [ ] Run → FAIL; implement; run → PASS.
- [ ] **Commit** `feat(sapu): argus-live codegen — screenshot baselines with dynamic masks`.

## Lane D — performance

### D1: perf collection, baselines, regressions
**Model: sonnet-medium.**
- [ ] **Failing tests:**
  - **Collection.**
    - `PERF_SCRIPT` on fixture pages reports LCP (the largest per document, background loads
      ignored), CLS (the largest session window, `hadRecentInput` shifts skipped), INP (the worst
      interaction from `event` entries with `durationThreshold: 16`, grouped by `interactionId`),
      requests and bytes [webdev-lcp] [webdev-cls] [webdev-inp].
    - The session hook installs it beside the signal script.
  - **Batches.**
    - `smokeRun --perf` waits for `load` before acting on each new document, runs a warm-up, then
      `perf.runs` runs, and records the medians [lh-variability].
    - It is refused (`refused: smoke run --perf: <n> other slot(s) live`) while another slot of the
      run is live [lh-variability].
  - **Baselines.**
    - The first batch is the baseline.
    - A changed `pathSha` or machine voids it.
  - **Regressions.**
    - A regression needs both thresholds and a second batch.
    - The report line shows web.dev's "good" values as `lab context`, never a verdict
      [webdev-vitals] [webdev-labfield].
  - **Commands.**
    - `perfIssue` prints the baseline, both batches and `git log` over the anchor files.
    - `perfRebaseline` moves it.
- [ ] Run → FAIL; implement; run → PASS.
- [ ] **Commit** `feat(sapu): argus-live smoke run --perf — web vitals and request budgets against
  per-journey baselines`.

## Lane E — journeys from issues and docs

### E1: seeds
**Model: opus-high.**
- [ ] **Failing tests:**
  - **Sources.**
    - `seed --issue` is refused when `issue-trust` fails (gh stub).
    - `--doc` is refused when the file is untracked or outside the repo.
    - `seed.json` is 0600.
  - **The `source` command.**
    - `pw <token> source` exists only on a `--seed` map token.
    - It fences the text with escaped marker shapes.
  - **Fenced text changes nothing.** A fenced instruction in the source changes nothing the
    wrapper does: the explorer's command set, network and return validation are identical with and
    without it [owasp-llm01] [owasp-pi-cheat].
  - **Merging.**
    - `map-check --merge` adds `seeds` to that slot's journeys only.
    - A returned `seeds` key is refused by `validateMap`.
    - The catalog marks the journeys `seeded`.
- [ ] Run → FAIL; implement; run → PASS.
- [ ] **Commit** `feat(sapu): argus-live seed — journeys from trusted issues and tracked docs, fenced,
  linked to their source`.

## Lane F — report, filed record, API hint

### F1: filed record and report
**Model: opus-high** (scrub).
- [ ] **Failing tests:**
  - `scrub --create` and `--comment` append `{ref, url, kind}` to `<run>/filed.jsonl` after gh
    succeeds, never before;
  - `report` writes `.argus/reports/<runId>.md` 0600 with every §19.13 section from fixture
    records, including `manual` items and `flaky-new`;
  - a ledger secret planted in a claim comes out as `*** (<class>)`;
  - links are defanged;
  - it works after `down`.
- [ ] Run → FAIL; implement; run → PASS.
- [ ] **Commit** `feat(sapu): argus-live report writes one scrubbed summary per cycle`.

### F2: the API-level hint
**Model: sonnet-medium.**
- [ ] **Failing test:** `repro --test` prints the `api-level: suggested` line for a `fact-equals` or
  `mail` final, and not otherwise.
- [ ] Run → FAIL; implement; run → PASS.
- [ ] **Commit** `feat(sapu): argus-live repro --test suggests an API-level RED test where the UI is
  not the observable`.

## Lane Z — integration (sequential, last)

### Z1: the exploratory layout oracle
**Model: sonnet-medium.** Three additions:
- the `layout` expectation in the runner;
- `pw <token> <role>.<k> layout [<check>]`, with its answer fenced;
- `layout` among `viewport-locale`'s final kinds.
- [ ] Failing tests in the pw and repro test files.
- [ ] Run → FAIL; implement; run → PASS.
- [ ] **Commit** `feat(sapu): the explorer's layout oracle`.

### Z2: engine text
**Model: opus-high** (heal and seed briefs read untrusted text).
- **`ui-explorer.md`:**
  - paths: `path: wanted`, selector order, seed triggers;
  - heal mode: the path, the broken step, "never change an expectation", and the `heal` return;
  - the `layout` command;
  - `pw source` in seed map mode.
- **`journeys.md`:** `path: wanted`, `smoke admit`, `seed`, and `report` at the end.
- **New `skills/journey/smoke.md`:**
  - the smoke cycle: plan → up → run `--perf` → ci → heal → admit → propose → baseline → report →
    down;
  - the decision table's actions;
  - the baseline run and its review in the PR;
  - `smoke.json`'s format;
  - the CI wiring.
- **Also:** `/sapu:journey smoke`; `/sapu:init` (the smoke questions, the workflow with consent,
  the gitignore exception); CONTRACT.md's text.
- [ ] **Failing engine tests:**
  - the brief's example path passes `parseRepro(..., {path: true})`;
  - its heal example passes `validateReturn`;
  - `smoke.md`'s `smoke.json` example passes `validateSmoke`;
  - every command it names is in the usage line;
  - budgets for the changed files.
- [ ] Run → FAIL; write; run → PASS.
- [ ] **Commit** `feat(sapu): the smoke cycle's engine text`, trailer `Rule-Change: engine.test.ts
  pins the smoke cycle's text and budgets`.

### Z3: docs and diagrams
**Model: sonnet-medium.**
- **Docs.**
  - README: `/sapu:journey smoke`.
  - Usage: requirements, the CI wiring, the baseline run, common problems and the upgrade note.
  - Security: a "The smoke suite" section (§19.16).
  - Agents.
- **Diagrams.**
  - A new `smoke.mjs` diagram shows one smoke cycle, the proposal loop and the baseline run.
  - `journey.mjs` gains the path capture.
  - Build them with `node docs/img/src/build.mjs smoke journey`.
- [ ] `npx vitest run tests/engine.test.ts` → PASS.
- [ ] **Commit** `docs: the smoke suite — README, usage, security, agents, diagrams`.

### Z4: whole suite, review, as built
- [ ] `npx vitest run` and `npm run gate` → green.
- [ ] **Phase-end team review** on `git diff 2225fcb..HEAD`.
  - `senior-dev-team:senior-qa-reviewer`: each task's tests against §19.
  - `senior-dev-team:senior-software-architect`: the DAG, the decision table as built, the proposal
    and baseline loops, and the security boundaries of §19.16.
  - `senior-dev-team:senior-technical-writer`: docs, `smoke.md` and diagrams.
  - Findings are fixed, re-reviewed and green.
- [ ] **As built.**
  - Set the version per decision 17.
  - Fold the as-built notes into §19: remove "not built yet" from what landed and keep it on
    anything cut.
  - Link roadmap row 6 to this plan, and fill in "As built (phase 6)" below.
  - Commit `docs(sapu): argus journey lane — phase 6 as built`. No push, merge or tag: the owner
    holds every release.

---

## Out of scope, and covered elsewhere

- **Out:** native mobile apps and real-device clouds; tests generated from Figma or other external
  design services (the lane is loopback-only); hosted visual review services. Committed baselines
  and the PR image view cover review [chromatic-branch] [gh-images].
- **Covered:** intelligent prioritization is SELECT's score and the smoke rank; parallel execution
  is CI's project matrix, with locks for shared accounts.
- **Follow-up:** generating the API-level RED test the hint suggests.

## Open risks

1. **A heal that hides a regression.** A control moved somewhere the role still reaches in the same
   number of steps passes as a UI change. The owner's review mitigates this, with the `git log -S`
   evidence and the old and new target shown. A heal cannot add a step, so a control buried one level
   deeper is a bug.
2. **CI's app start and seed are the owner's** (`ci.web_server`, the users `live.json` names). A repo
   that cannot seed CI gets a red setup project, reported as harness, never as a finding.
3. **Branch protection deadlock.** A sapu worker's PR that renames a control stays red on the suite
   until the heal proposal merges. The report names both PRs. A journey-adding proposal is red until
   its baseline commit lands on the same branch. That is intended: tests fail until a baseline is
   accepted [chromatic-branch].
4. **Alpha vs stable Playwright** (the lane's 1.64 alpha, the suite's 1.64.0). Both share a minor,
   pinned by test, and the stub runner proves the generated code on the alpha. A locator difference
   would show as a CI-only break.
5. **Check false positives.** Every exclusion has a fixture twin, and axe's own policy is "zero false
   positives". Known-violation adoption keeps day one green, and uncertain cases are `manual`,
   never red. A check that still misfires is the owner's `allow`, and Z4's review reads the fixture
   set.
6. **CI duration.** Duration grows with projects × journeys. The matrix runs projects in parallel
   jobs, `workers: 1` keeps each job reproducible, and `max` caps the journeys. Sharding is the
   next lever once a job passes `globalTimeout` [pw-shard].
7. **The baseline run needs a dispatch right.** It needs write access and the workflow on the
   default branch [gh-dispatch]. Until init's workflow merges, `smoke baseline` prints the command
   and the suite runs with no visual check.
8. **`--update-snapshots=changed` for ARIA is documented, not probed.** C3.2 probes it. Its fallback
   is decided in advance (C3.2).
9. **`@axe-core/playwright` is MPL-2.0.** It is a dev dependency of the consumer's suite only, never
   of sapu, and the owner sees it in the proposal's `package.json` [npm].

## As built (phase 6)

### Task 0.1 — the pinned runner, probed live

Probed with the pinned install's `node_modules/playwright/cli.js test` (`1.64.0-alpha-1790635538000`)
and the pinned CLI's `run-code`, against `tests/fixtures/journey-app` on Chrome (`channel: "chrome"`,
headless), `retries: 1`, the `json` reporter. The same suite was then run on the stable
`@playwright/test` `1.64.0` installed from npm into a scratch directory: **every row below is identical
on both**, except the import row.

| Probe | Result | Observed |
|---|---|---|
| Missing screenshot baseline, `updateSnapshots: "none"` | **NO, differs from the task's expectation** | Fails (both attempts) with `A snapshot doesn't exist at <testFile>-snapshots/<name>-<project>-<platform>.png`. Nothing is written and **no `-actual.png` is attached**: the only attachment in `results.json` is `error-context` (markdown). |
| Screenshot mismatch, `"none"` | yes | Fails; each result attaches `<name>-expected.png`, `<name>-actual.png`, `<name>-diff.png` (paths under the test's output dir and the snapshots dir), and the message reports the differing pixel count. |
| Screenshot, `--update-snapshots=missing` | yes, with a twist | A missing baseline is written and **the test passes** (exit 0); `results.json` attaches `-expected.png` (the new baseline) and `-actual.png`. |
| `toMatchAriaSnapshot({name})` with `expect.toMatchAriaSnapshot.pathTemplate` | yes | With `__aria__/{testFilePath}/{arg}{ext}` the file is `__aria__/<spec file>/<name>.aria.yml`; `--update-snapshots=missing` writes it and the test passes. |
| ARIA actual on mismatch | partly | The failure message holds a line diff (`- Expected`, `+ Received`, only the changed lines marked); no file or attachment. A **missing** `.aria.yml` is compared as the empty string, fails, and the message carries the whole received snapshot. Both are ANSI-coloured in `results.json`. |
| Partial ARIA matching of extra list items | yes | A baseline `list` holding items `a`, `c` passes against a page holding `a`, `b`, `c`, `d`. |
| `results.json` shows `test.step` titles | yes | Each result has `steps[].title` (`step 1 expect:visible`); a failing step is named in the failed result. |
| Status `flaky` with `retries: 1` | yes | A test failing at `retry` 0 and passing at 1 has test `status: "flaky"`, two results, `stats.flaky: 1`. A test that fails both is `unexpected` with two results. |
| `storageState` from a setup project with `dependencies` | yes | `setup` signs in through the real `/login` UI and writes `context().storageState({path})`; a dependent project with `use.storageState` opens `/stock` signed in (the header "Account" button). |
| `toHaveAccessibleName` | yes | `/\S/` and an exact string both pass on the "Account" button. |
| `testIdAttribute` | yes | `test.use({testIdAttribute: "data-qa"})` finds `data-qa`; with it set, `getByTestId` no longer matches `data-testid`. |
| CLI `run-code` calls `page.ariaSnapshot()` | yes | Returns the snapshot string with no `[ref=]` markers (`- main:` / `- heading "Sign in" [level=1]` …), the form the runner's baselines use. |
| CLI `run-code` calls `page.keyboard.press("Tab")` | yes | Focus moved to the sign-in page's first field (`activeElement` an `INPUT`). |
| Spec imports `@playwright/test` | **NO under the pinned install** | `Error: Cannot find module '@playwright/test'`: the pinned install holds `playwright`, `playwright-core` and `@playwright/cli` only (the runner is `playwright/test`). It resolves with a stable `@playwright/test` `1.64.0` install, or a stub `node_modules/@playwright/test` whose `index.js` is `module.exports = require("playwright/test")` (probed: the alpha runner then passes the spec). |

Other facts met on the way:

- Every failed result attaches an `error-context` markdown holding the page's ARIA snapshot at the
  failure (with `[ref=]` markers; not the baseline form).
- The snapshot path default is `<spec file>-snapshots/<name>-<project>-<platform>.png`; the ARIA path
  is whatever `pathTemplate` says.
- A project's retry results each get their own output directory (`...-retry1`), so a mismatch's
  actual is attached once per attempt.

**What this changes** (a "no" is never silent; Task 0.4, B3, C3.2, Z4 depend on it):

1. *Task 0.4 browser test, "run by the pinned runner".* A generated suite imports `@playwright/test`, which
   the pinned alpha install does not hold. The test must either install the stable `@playwright/test`
   from the generated `package.json`, or put the stub above into a scratch `node_modules` beside the
   generated suite. It cannot run the generated suite as it is against the pinned install alone.
2. *Decision 7 and `smoke baseline --from-run` (B3), C3.2.* With `updateSnapshots: "none"` (CI, §19.5) a
   **new** screenshot baseline cannot be adopted from the CI artifact: a missing baseline attaches no
   actual and writes nothing. Only a *mismatch* attaches `-actual.png`. Adopting a first baseline needs
   a run with `--update-snapshots=missing` (which writes the baseline and passes), so `smoke baseline`
   must either drive such a CI run or the new-baseline path must be a separate one-time workflow input.
3. *ARIA baselines (C2.2, B3).* A mismatch gives a diff in the message, not the full received snapshot,
   so adopting a changed ARIA baseline from an artifact cannot parse an actual from `results.json`.
   Adoption of a changed ARIA baseline needs a CI update run (the other `--update-snapshots` modes were
   not probed) or the lane regenerating the snapshot with `run-code` (`page.ariaSnapshot()`, probed
   above, which matches the baseline form).
4. Everything else the task named holds, so the matching spec lines (§19.5, §19.7, §19.9) stand as written.

### Task 0.2: shared surfaces

**Locked for the lanes.** Every verb's function returns (or resolves to) `{code, lines, masked?}`: the CLI
prints `lines` through the env-file mask, or as they are when `masked: true` (a function that fenced or
masked its own lines, so a nonce is never cut), and exits `code`. A stub throws `refused: <verb>: not built
yet` (stderr, exit 1, the CLI's refusal channel); a lane replaces the body. The dispatch reads the line
whole before anything runs: flags at most once, `--slot` 1–99 (`refused: a slot is a number from 1 to
99`), `--seed` 0–4294967295 (`refused: a seed is an integer from 0 to 4294967295`), `--ids` a comma list of
kebab ids (an array), `--issue` a positive integer (a number); refs, run ids, journey ids and doc ranges
reach the lane as typed, for it to validate. Absent options are `null` (`perf`, `dryRun`: booleans).

| Verb | Function (module) |
|---|---|
| `smoke plan` | `smokePlan(main)` (`-suite`) |
| `smoke admit <slot>.<generation>` | `smokeAdmit(main, ref)` (`-suite`) |
| `smoke check` | `smokeCheck(main)` (`-suite`), never gated |
| `smoke run [--ids] [--slot] [--perf] [--seed]` | `smokeRun(main, {ids, slot, perf, seed})` (`-smoke`) |
| `smoke heal <slot>.<generation>` | `smokeHeal(main, ref)` (`-heal`) |
| `smoke propose [--dry-run]` | `smokePropose(main, {dryRun})` (`-propose`) |
| `smoke workflow` | `smokeWorkflow(main)` (`-propose`) |
| `smoke ci [--run <id>]` | `smokeCi(main, {run})` (`-ci`) |
| `smoke baseline --from-run <id> [--ids]` | `smokeBaseline(main, {fromRun, ids})` (`-ci`) |
| `smoke perf --issue <id>` / `--rebaseline <id>` | `perfIssue(main, id)` / `perfRebaseline(main, id)` (`-perf`; verb `smoke perf`) |
| `seed (--issue <n>\|--doc <file>:<a>-<b>)` | `seed(main, {issue, doc})` (`-seed`), exactly one set |
| `report [--run <runId>]` | `report(main, {run})` (`-report`) |

`CHECKS = []` in `-layout.mjs` and `-a11y.mjs`. Hooks added for lanes that cannot edit the CLI:
`apiLevelHint(main, ref) → string | null` in `-repro.mjs` (F2; `repro --test` prints it after `red test:`);
`seedsOf(main, runId, slot) → [{kind, ref}]` in `-seed.mjs`, passed by `map-check --merge` as
`mergeMap(prev, value, {head, seeds})` (E1); `slot <n> --map --seed` → `mintMapSlot(main, {slot, seed})`,
which refuses `slot --seed: not built yet` until E1. The DAG order is fixed in `-instance.mjs`'s header:
`-seed` after `-run` (below `-slots` and `-pw`), `-perf` after `-map` (below `-session`, which installs its
script), `-codegen` beside the instance before `-redtest`, then `-repro` → `-smoke` → `-suite` → `-propose` →
`-heal`, `-ci` → `-report` → `argus-live.mjs`; no phase 1–5 module reaches the six upper ones.

**Deviations.**
- `-a11y` holds digits: the DAG test's module pattern is `^argus-live(-[a-z0-9]+)?\.mjs$` (and its import
  and header patterns likewise).
- `ORACLES` lives in `-return.mjs`, which gains `LANE_ORACLES = ["regression"]`: an explorer's return naming
  `regression`, as a candidate or in `coverage`, is refused (§19.9: never the explorer's word). Task 0.3's
  `smokeRun --slot` writes its regression return itself. engine.test's two brief checks read the explorer's
  oracles (`Rule-Change` trailer). `FINAL_KINDS.regression` is `Object.keys(EXPECTS)`, so Z1's `layout`
  joins it.
- `skills/journey/live.md` names the three new keys and `seed` (engine.test requires every `TOP_KEYS` key
  there; 14,443 of its 14,500 bytes). docs/security.md and docs/usage.md name `smoke check` as a read.
- §19.2's trace gate is in the dispatch: every `smoke` verb but `check`, once the line parses, before the
  lane runs: no committed contract, a local one, or `traces: "none"` → `refused: smoke: a committed suite
  would leave a trace`; a broken contract → its error. `seed` and `report` are not gated.
- `smoke.json` where §19.2 is silent: `ci` defaults `{web_server: [], ports: {}, workflow:
  "argus-smoke.yml", artifact: "argus-smoke-results"}` (a given `web_server` is non-empty, each
  `{command, url, timeout_s?}`, `timeout_s` 1–3600); loopback is judged by spelling (`localhost`, `127.x`,
  `[::1]`: CI resolves nothing for the suite); ranges `heal_max_steps` 1–10, `form_cases_max` 0–50,
  `link_cap` 0–500, `perf.runs` 1–20, `workers` 1–64 or `"N%"`; `journeys.<id>.screens` distinct step numbers
  1–500, `allow` `[{check, key}]`, `masks` locators `parseTarget` reads (no ref); `dir` repo-relative, not
  under `.git` or `.argus`; a journey both pinned and excluded is refused. `validateSmoke(raw) → {value,
  errors}` (`value` with every default, null on any error); `loadSmoke(main) → {smoke, errors, missing}`.
  Exported: `SMOKE_FILE`, `SMOKE_KEYS`, `SMOKE_BROWSERS`, `PERF_METRICS`, `SMOKE_DEFAULTS` (frozen).
- Line counts at 0.2: `-config` 747, `-repro` 750 (the cap; 0.3's move frees it), `-run` 748.
- `-codegen.mjs` gets no stub (0.4 creates it); `-minimize.mjs` is not yet in the header (0.3 adds it).
- Open for the lanes' owners: B2's "codegen writes `test.fixme`" lands in `-codegen.mjs`, which is C3's.

### Task 0.3: path mode and the lane's pass

**Locked for the lanes.**
- `parseRepro(list, {accounts, live, path: true})` (`-steps`) reads a smoke path. Its refusals, each as
  `refused: repro: step <n>: <reason>`: `a path has no final: it ends with an expect proving the journey's
  goal`; `a path ends with an expect proving the journey's goal`; `an action's target in a path is {role,
  name}, {label}, {placeholder} or {testId}` (`within` included); `a testId target needs live.json's
  test_id_attribute` (any step); `within nests at most one level in a path`; `a path's trigger leads it and is
  marked seed: true in live.triggers`. A trigger leads when no step of an account comes before it, so a
  seed trigger's `system` proving expect may sit between two seed triggers. Every other §10 rule holds.
- `suiteAccounts(live) → {"<role>.<k>": user | null}` (`-steps`) is the suite's numbering: a users role's
  k-th user is `<role>.<k>`, and anon and a login-command role are `.1`. The suite's paths name accounts
  this way. `smokeRun`, `runOnce`'s path mode and codegen parse against it. A return's path is checked
  against its slot's allocation, so A2 renumbers it to the suite's accounts by user before staging.
- `pathChecks({accounts, live, healMax}) → {parsePath, healTarget, healMax}` (`-steps`) is what
  `validateReturn(obj, {journey, accounts, outFiles, checks})` (`-return`) reads, through `checks()`, only for
  a return that holds `path` or `heal`. The return's new keys:
  - `path`, kept as written;
  - `heal: [{step, target}]`, at most `heal_max_steps`, `step` 1–100 and distinct. `target` is a locator
    string, the explorer's own form, which `parseTarget` reads. It is stored as the DSL's target object, in
    the selector order an action takes;
  - `heal_reason` (`no-control|blocked|harness`), only beside `heal: []`.

  `submit(main, {runId, slot, rec}, json, {checks})`. `pw` passes `returnChecks`: the slot's accounts,
  live.json as the run expands it, and smoke.json's `heal_max_steps`. An unreadable live.json or smoke.json
  refuses a return holding a path or heal (`… cannot be checked (…)`), and no other.
- `runOnce(main, null, {path: {id, list}, dirty})` (`-repro`) is path mode. Exit 0 is `PATH held`. Exit 3
  is `PATH broke step=<n> kind=target-missing|target-ambiguous|action-failed|expect-failed`, and an
  expect-failed break shows what the page showed in its fence first. Exit 2 is `HARNESS: …`, which
  includes a path that path mode refuses. `dirty: true` skips `up --fresh` and prints `dirty: instance
  <id>`. Records go to `.argus/live/<run>/smoke/<id>/`: `path.json`, `run-<i>.json` (with `kind` and
  `dirty`) and `steps-<i>.jsonl`.
- `smokeRun(main, {ids, slot, perf, seed}, {once})` (`-smoke`). The first run of each path is dirty, and a
  break is confirmed fresh. Lines:
  - `seed: <n>`;
  - `path <id>: held`;
  - `path <id>: broke step=<n> kind=<k>`;
  - `path <id>: flaky step=<n> kind=<k>`;
  - `path <id>: harness: <reason>`;
  - `regression <id>: step <n> written as <slot>.1.1 (repro <slot>.1.1)`, written only for the first
    `expect-failed` break;
  - `smoke run: <h> held, <b> broke, <f> flaky, <x> harness`.

  Exit 3 when a path broke, else 2 when one was the harness's, else 0. `<run>/smoke/pass.jsonl` (0600)
  holds `{id, verdict, step, kind, seed}` per path, for F1's report. `perf: true` still throws `refused:
  smoke run --perf: not built yet`, for lane D to replace.
- `-smoke` also exports `seededOrder(ids, seed)` (Fisher–Yates over mulberry32) and `readSuitePaths(main,
  dir) → [{id, path, admitted}]`. A suite path file is `<dir>/journeys/<id>.json`: `{journey: <id>, path:
  [...], admitted: {run, head, pathSha, seed}}`.
- A regression candidate's slot in run.json is `{mode: "smoke", journey, generation: 1, tokenHash: null,
  accounts, retired: [], submitted: true}`. Its accounts are only those the candidate acts as. Its repro is
  the parsed context, then the path up to the broken expectation, which takes `final: "regression"`.

**Deviations.**
- The step templates read ambiguity. An action whose target matches several elements answers
  `ambiguous-target`, and an expectation answers `ambiguous`. Candidate mode reports both as before (`failed
  (error)`, `could not be judged`).
- `-pw.mjs` (lane E's file) gains `returnChecks`, so the instance header orders `-steps.mjs → -pw.mjs`.
  `-slots.mjs` (also lane E's): a `smoke` slot is skipped by the allocation clash check, because its
  accounts browse only in slot `r`, and refused by `slot --handoff`.
- Step 0 moved `minimize`, `redTestFile` and `savedValues` with their helpers (`liveOf`, `runRecords`);
  `-repro` exports `nextRun` and `writePrivate` for them. The findings test imports `minimize` from
  `-minimize`, and the DAG test pins `-minimize` (not `-repro`) as the RED test's writer. Spec §18's file
  table still lists them under `-repro` (Z4).
- Line counts at 0.3: `-repro` 594, `-steps` 630, `-minimize` 219, `-smoke` 222.

### Task 0.4: the generator core

**Locked for the lanes** (`-codegen.mjs`). Every function is pure, and every file it writes carries a
header line naming `argus-live codegen <CODEGEN_VERSION>, digest <sha256 of the body without that line>`.
- `generateSuite({paths: [{id, path}], live, smoke, quarantine}) → {<file>: text}`. It writes:
  - `<id>.spec.ts` for each path;
  - `auth.setup.ts`, `support.ts`, `playwright.config.ts`, `package.json` and `.gitignore`;
  - `fixtures.ts` (`FIXTURES`, a stub that throws) only when a path acts as a login-command role.

  `live` is live.json as written, its `${NAME}` references unexpanded; `smoke` is validateSmoke's value.
  It writes neither `journeys/*.json` (A2's) nor `package-lock.json` (A3's, through npm).
- `smokeSpec({id, path, live, smoke, quarantined})`, `smokeConfig({live, smoke})`, `authSetup({live,
  accounts})`, `supportFile({live, smoke, roles})`, `packageJson()`, `suiteGitignore()`.
- `headerDigest(text) → {digest, ok}`, for `smoke check` (A3).
- Constants: `SMOKE_PLAYWRIGHT` (`1.64.0`), `CODEGEN_VERSION` (`1`), `TOTP_SOURCE` and `FIXTURES`.
- The check lanes (C1, C2):
  - `stepLines` calls every registered check's `emit(step, ctx)` (`ctx = {id, steps, smoke}`) after each
    path step's `test.step`, and `supportFile` embeds every check's `source`.
  - Emitted lines run inside the test's `try`. In scope: the page variables, `marker`, `opened`,
    `browser`, `baseURL`, `viewport`, `SETTLE`, `test` and `expect`.
- `-redtest` and the suite share one step builder: `str`, `literal`, `variable`, `pageVars`, `stepLines`,
  `COLLECT`, `READ_VALUE` and `WAIT`.

A spec is `test("<id>", {"tag": "@quarantine"?, "lock": ["account:<role>.<k>", …]}, async ({ browser,
baseURL, viewport }) => {…})`:
- the marker is made first (`newMarker()`), and each account's page opens from its storageState;
- the page's context options are `{baseURL, viewport}` from the project, and `locale` and `timezoneId`
  from the path's context;
- every context is kept in `opened` and closed in `finally`;
- each step is `await test.step("step <n> <do|expect>:<kind>", …)`, and a parallel group is a
  `Promise.all` of `test.step`s;
- expectations wait `{ timeout: SETTLE }`, and a fact compares as strings, as the runner compares it.

The config:
- the base URL is `ARGUS_SMOKE_BASE_URL`, else the origin of `ci.web_server[0]`, behind the loopback guard
  (`localhost`, `127.x.x.x`, `[::1]`);
- under CI the reporter is `list` plus JSON at `test-results/results.json`, for B2;
- `globalTimeout` is `CI ? 3_600_000 : 0`, and `updateSnapshots` is `CI ? "none" : "missing"`;
- `webServer` comes from `ci.web_server`, never reused, run from the repo's root;
- the projects are `setup` (`auth.setup.ts`, with trace, video and screenshot off) and `chromium` (`*.spec.ts`,
  depending on `setup`). C3 adds the rest.

**Deviations.**
- The wrapper's login template and `signInPage` live in `support.ts`, as spec §19.2 lists them, because a
  path's `login` step needs them too. The template comes through `-login`'s new `loginStageSource(stage)`.
  `auth.setup.ts` names each account's user, password and TOTP secret by environment name, writes
  `.auth/<role>.<k>.json` and chmods it 0600. A password or TOTP secret that is not a `${NAME}` reference is
  refused.
- TOTP is written out as `TOTP_SOURCE`, not `totp.toString()`, because vitest's module transform rewrites
  a function's own text. A test pins it to `-login`'s codes. With under 3 s of the current step left, it
  takes the next step, which the app's one-step drift allows, rather than waiting.
- `lock` leaves anon out, since anon holds no signed-in server state. It locks every other account the
  test opens.
- A hook's `{port:<name>}` takes smoke.json's `ci.ports` at generation. A name missing there is refused.
- The login template polls with `page.waitForTimeout` and finds a form by `xpath=ancestor::form`. The bans
  scan the spec files, which hold neither.
- The browser test runs the pinned runner in a scratch suite directory. Its `node_modules` holds the
  `@playwright/test` stub and links to the pinned `playwright` and `playwright-core`. A wrapper config sets
  `channel: "chrome"`.
- Codegen never writes `test.fixme`: a quarantined test gets `tag: "@quarantine"` (decision 13). This
  closes 0.2's open line for B2.
- Line counts at 0.4: `-codegen` 603, `-redtest` 77, `-login` 712.

### Lane F — report, filed record, API hint

**Locked for the lanes.**
- `filedFile(main, runId)` (`-scrub`) is `<run>/filed.jsonl` (0600). `scrub --create` and `--comment` append
  `{ref, url, kind}` to it only after gh printed the issue URL: `kind` is `issue` or `comment`, and `ref` is the
  candidate's, or null for a scrub named by `--run` alone (a perf issue). A refusal, a gh failure and a check
  without `--create` or `--comment` record nothing. What scrub prints is unchanged; a record that cannot be
  written adds one `note: … not recorded …` line, and the exit stays 0, so nothing files twice.
- `report(main, {run}, {env})` (`-report`) writes `.argus/reports/<runId>.md` (0600, the directory 0700) and
  answers `report: <path>`. `run` null takes `lastRun` (the lock's, else the newest run directory), so it works
  after `down`. Refusals: `refused: report: --run takes a run id`, `refused: report: no run here`, `refused:
  report: no run <id> here`, and a secret's pattern that cannot run.
- The report reads only these records, each optional (missing: `none recorded`; malformed: named under
  "Records not read", never guessed at):
  - `<run>/returns/<slot>.<generation>.json`, `<run>/repro/<ref>/verdict.json` and `minimize.json`: journeys
    walked (status, steps, coverage per oracle), candidates (ref, oracle, verdict, minimized steps, filed URL,
    claim) and the explorers' harness events;
  - `<run>/filed.jsonl`: issues filed;
  - `<run>/smoke/pass.jsonl` (0.3): each path's verdict;
  - `<run>/smoke/events.jsonl`, one object per line, which the smoke verbs append:
    `{kind: "admitted" | "quarantined" | "unquarantined" | "dropped", id}`, `{kind: "healed", id, steps:
    [<n>…]}`, `{kind: "proposal", url, branch: "argus/…", changes}`, `{kind: "perf", id, baseline: {<metric>:
    <n>} | null, batches: [{<metric>: <n>}…], verdict: "baseline" | "held" | "regressed" | "unconfirmed" |
    "void"}` (metrics are `PERF_METRICS`);
  - `.argus/smoke-ci.json`, the newest `smoke ci` summary, overwritten by each `smoke ci`: `{run, event, branch,
    lines}`. Only lines whose first word is a §19.9 triage word (`flaky`, `flaky-new`, `quarantine`, `ui-change?`,
    `bug?`, `ci-only`, `browser-only`, `check`, `manual`, `baseline-missing`, `visual`, `aria`, `stale`,
    `harness`, …) and that are printable single-spaced words of at most 200 characters are shown. The rest is
    counted as `<k> line(s) not shown: not a triage line`, since CI artifact text is untrusted.
- Sections, in order: Journeys walked, Candidates, Issues filed, Smoke (`held, broke, flaky, harness; healed,
  admitted, quarantined` counts, then each path and event), Perf (each batch beside its baseline, then one `lab
  context, never a verdict` line with web.dev's "good" values), Visual and checks, Proposals, Harness events,
  and Records not read only when something was not read.

**How secrets and page text are kept out.**
- Free text means a candidate's claim or an explorer's harness event. Each item is cleaned (`clean`: marker
  shapes, control characters), its whitespace collapsed, and capped at 200 characters. Its long unknown tokens
  are redacted (`redactIds`, the run's seen ids kept), and it is quoted as a JSON string, with `<` and `>` as
  `<` and `>` so that no page tag renders. An item that holds a secret scrub knows, before or after
  the cap, is `*** (<class>)`.
- When `scrubSecrets` refuses the run (a ledger gone, damaged or incomplete; a configuration that cannot be
  read), every free-text item is `(withheld)`, and the header says why. A map run says `a map run keeps no
  secret ledger`.
- The whole file is then defanged (scrub's `defang`: an outside URL, a mention and a reference go into code
  spans, and a loopback URL stays). Last, scrub's matcher (`secretHits`) runs over the whole file: a line in
  which it still finds a secret becomes `*** (<class>)`, with its list marker kept, until none is left.
- The CLI prints only the path, never the report's text.

**F2.** `apiLevelHint(main, ref)` (`-repro`) reads the candidate's own final, which minimizing never drops. It
answers `api-level: suggested (the final reads live.facts)` for `fact-equals`, `… live.mail` for `mail`, and null
for any other kind. A `mail` final exists only on a `regression` candidate (`FINAL_KINDS`).

**Deviations.**
- `report` takes a third, optional `{env}` (scrub's environment, a test seam like `smokeRun`'s `{once}`). The
  CLI's call `report(main, {run})` is unchanged.
- F1 landed as two commits: scrub's filed record first, then the report.
- Line counts: `-report` 305, `-scrub` 538, `-repro` 607.

**Needs coordinator.**
- `tests/argus-live-smoke.test.ts` (lane 0's) fails two tests on this branch: "each new verb reaches its lane's
  function, which is not built yet" and the trace-gate test. Both iterate a `STUBS` list that still holds
  `["report"]` and `["report", "--run", "r1"]`. Drop both entries; every lane that fills a stub has the same
  conflict. What replaces them is pinned in `tests/argus-live-report.test.ts`: `report` on a repo with no run
  answers `refused: report: no run here`, and `report --run r1` answers `refused: report: --run takes a run id`
  (exit 1). The trace gate never applies to `report`.
- The report's inputs from lanes A, B and D are the record shapes above. Each lane must write them:
  - A2: `admitted`;
  - A3 and B3: `proposal`;
  - B1: `healed`;
  - B2: `quarantined`, `unquarantined` and `dropped`, plus `.argus/smoke-ci.json` holding its triage lines,
    `flaky-new` and `manual` included;
  - D1: `perf`.

  If a lane's as-built record differs, Z adapts either the lane or the report's reader (`sections` in
  `-report.mjs`).
- Z2 and Z3: spec §19.13 should name the inputs above (`smoke/events.jsonl`, `.argus/smoke-ci.json`). CONTRACT.md
  and the docs should name `filed.jsonl` and `.argus/reports/`. Both files are already gitignored under
  `.argus/`'s rule.
