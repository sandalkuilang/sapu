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
- [x] Failing tests in the pw and repro test files.
- [x] Run → FAIL; implement; run → PASS.
- [x] **Commit** `feat(sapu): the explorer's layout oracle`.

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
- **Follow-up:** gate `sapu-merge.sh` on the `argus-smoke` check (decided out of this release: the check is advisory,
  and as a required check it could deadlock a pull request that renames a control until the heal proposal merges).

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
8. **`--update-snapshots=changed` for ARIA.** Answered by C3.2's live probe on the pinned alpha: it
   rewrites a mismatching `.aria.yml` to the received snapshot and passes, so a changed ARIA baseline is
   adopted from a CI update run in `changed` mode and the `run-code` fallback is not needed (As built,
   Lane C3).
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

### Lane A — suite lifecycle (A1–A4)

**Locked for the other lanes.**
- **Staged changes** (`-suite.mjs`): `.argus/smoke-staged.json` (0600) `{changes: [...]}`, one change per kind and
  journey (a later one replaces it). `stageChange(main, change)`, `readStaged(main)`, `writeStaged(main, changes)`,
  `changeDigest(change)`, `CHANGE_KINDS`. A change is `{kind, id, step?, from?, to?, evidence, run, journey?,
  quarantine?}`, `run` a run id (propose checks the files against that run's scrub secrets):
  - `add`, `heal`: `journey` is the whole `journeys/<id>.json`, `{journey, path, admitted}`;
  - `drop`, `retire`: the journey's path, spec, `known/<id>.json`, `__aria__/<id>/` and every
    `__screenshots__/*/*/<id>/` leave the suite, and its quarantine entry too;
  - `quarantine`: `quarantine: {id, issue, since}`; `unquarantine` removes the entry.

  The digest covers kind, id, step, from, to and the path, never the run or the evidence, so the same change
  found again by a later run is known as rejected.
- **`smoke-state.json`** (`readState(main) → {journeys, proposals}`, `STATE_FILE`): A owns `proposals`
  (`{<digest>: {kind, id, branch, url, outcome: open|merged|closed}}`); `smoke plan` reads `journeys.<id>.retire
  === true`. Any other writer rewrites the whole file and keeps the other part.
- **`quarantine.json`** in the suite directory is `[{id, issue, since}]` (`quarantineIds(main, dir)`).
- **Helpers** for later lanes: `planOf(main, {runner, gh}) → {entries: [{id, line, target}], lines, smoke}`,
  `smokeOf`, `suitePaths`, `liveAsWritten(text, verb)`, `generated(root, {live, smoke, verb})` (the suite a
  checkout's inputs generate).
- **The workflow's artifact names**: each test job uploads `test-results/` as `<ci.artifact>-<project>`
  (`<ci.artifact>-msedge`, `<ci.artifact>-quarantine`), the baseline job as `<ci.artifact>-<project>` too, plus
  `argus-smoke-baselines-<project>` (`__screenshots__/`, `__aria__/`). upload-artifact v4 refuses two
  uploads of one name in a run, and the matrix runs one job per project.

**As built.**
- A1 `smoke plan`: one line per catalog journey, plus each suite member the catalog lacks. The target set's
  lines come in rank order, as `pending` (an open `argus/` pull request changes its path or spec; asked of
  `gh pr list --json url,headRefName,files`), `quarantined`, `heal` (its newest pass in the last run's
  `pass.jsonl` broke at `target-*`), `keep` or `capture`. Then the drops: `excluded`, `retired`, `past the
  cap` in rank order, then `global`, then `out of the map`. Then `upgrade <from> → <to> (baseline run
  needed)` when the committed `package.json` pins an older `@playwright/test`. A gh failure adds `note: open
  argus/ pull requests not checked (gh …)` and never refuses.
- A2 `smoke admit <slot>.<generation>`: refused unless `smoke plan` lists the journey `capture`. The path is
  renumbered to `suiteAccounts` by user (a bare role word is the slot's `.1`), parsed in path mode, then
  checked string by string against `scrubSecrets` of the cycle's run: `refused: admit <id>: a secret in its
  values: step <n> <field> <class>`, and a gone or incomplete ledger refuses as uncheckable. Then
  `once(…, {dirty: false})`, then `once(…, {dirty: true})`. A harness exit answers code 2 with `admit <id>:
  harness (<fresh|dirty>): <reason>`. The admission head is run.json's `worktreeHead`, and `pathSha` is the
  sha256 of the renumbered path's JSON.
- A3 `smoke propose`: the proposal branch's earlier work is carried over file by file from its merge base, a
  rebase in effect. A baseline file (`__screenshots__`, `__aria__`, `known`) the base changed too is
  dropped (`baseline: dropped <file> (it conflicts with origin/<base>)`). Any other file changed on both
  sides refuses. The branch's earlier `changes.jsonl` lines are kept. The push uses
  `--force-with-lease=refs/heads/<branch>:<the sha ls-remote saw>`. An open pull request for the branch gets its
  body edited, and none gets `gh pr create --repo --base --head --title --body-file --label <agentFiled>`.
  The commit is `chore(argus-smoke): …` with `--no-verify`, since the consumer's hooks need its own
  install, which a fresh worktree lacks. CI runs the suite either way.
- A3 `smoke check`: exit 1 with `missing|hand-edited|drift|stale|orphan` lines and a summary, else exit 0 with
  `smoke check: <n> generated files current`. With no path it answers `smoke check: no suite (<dir>/journeys
  holds no path)`, exit 0. `drift` means the live.json of the file's last commit regenerates the file exactly.
  `fixtures.ts` is the owner's and is never compared.
- A4 `smoke workflow`: `masked: true`, since its lines hold names, never a value, and the env-file mask
  would cut the action SHAs. Actions `actions/checkout`, `actions/setup-node` and `actions/upload-artifact`
  at `v4` are each resolved by `gh api repos/<action>/commits/<tag> --jq .sha`. The jobs run on
  `ubuntu-24.04` with `timeout-minutes: 70`, above `globalTimeout`. The container jobs set `HOME: /root`,
  which Firefox needs. The matrix value reaches the shell as `PROJECT` through `env:`. The `msedge` job
  runs `npx playwright install chromium` for the setup project's browser, never Edge. The quarantine job runs
  `--pass-with-no-tests` on `chromium`. The grep check is `[ -z "$GREP" ] || [ "$(printf '%s.' "$GREP" |
  LC_ALL=C tr -d 'a-z0-9|-')" != . ]`, run against good and bad inputs (a newline, `$(…)`, upper case) by
  the test.

**Deviations.**
- §19.3's exposure tier is SELECT's `score` with no visit and no commit, as no momus flags reach `smoke plan`.
  It equals the money factor, so it never splits a money tie. The test covers pin, money, member, filed,
  roles and id.
- The trace gate stays in lane 0's dispatch. A1's test pins it through the CLI: no contract, `traces:
  "none"` and a local contract.
- The workflow's project list (`projectsOf` in `-propose.mjs`) follows §19.6's names: the container projects
  `chromium`, `firefox`, `webkit` (smoke.json's `browsers`), `chromium-<w>`, `a11y`, and `i18n` with a locale
  or pseudo-locale. C3 owns the generated config's projects.
- Line counts: `-suite` 472, `-propose` 474.

**Needs coordinator.**
1. `tests/argus-live-smoke.test.ts` (lane 0) fails two tests once lane A lands. "each new verb reaches its
   lane's function, which is not built yet" lists A's verbs in `STUBS`: `smoke plan`, `admit`, `propose`
   (twice), `check` and `workflow`. "a committed suite needs …" expects `smoke check` to answer `not built
   yet`; it now answers `smoke check: no suite (e2e/argus-smoke/journeys holds no path)` with exit 0. Each
   lane's built verbs leave `STUBS`, and the check expectation changes as stated.
2. Lane B stages heals, quarantines, unquarantines and drops through `stageChange` (kinds above). A heal
   carries the healed `journey` file and `step`, `from`, `to`. B's `smoke-state.json` writes keep
   `proposals`, and a retire is `journeys.<id>.retire: true`. B2 and B3 read the artifact names above by
   prefix. B3's `argus/baselines-<runId>` pull request is B's own; propose does not build it.
3. Once C3 lands, the workflow's matrix and the generated config's projects should come from one function
   (a `-codegen` export such as `suiteProjects(live, smoke)`), so the two never disagree.
4. Z2's engine text: the smoke cycle's `admit` needs a cycle with an instance. `propose` needs the staged
   changes' runs' ledgers, so a staged change from a run a later `up` dropped refuses until re-admitted.

### Lane C3: projects, browsers, visual

All in `-codegen.mjs` (now 705 lines) and `tests/argus-live-codegen.test.ts`; no other file.

**Locked for the lanes.**
- `suiteProjects({live, smoke}) → [{name, kind, browser, width}]` (exported). After `setup`: `chromium`, `firefox`,
  `webkit`, `msedge` (kind `browser`, the first `viewports` width, filtered by smoke.json `browsers`); then, only
  with `chromium` among the browsers, `chromium-<w>` for each further width (`viewport`), `a11y` and, with `locales`
  or `pseudo_locales`, `i18n`. Every project depends on `setup`. A journey's own `browsers` become a `testIgnore` of
  its spec in the other engines' projects; the chromium-engine projects (`chromium-<w>`, `a11y`, `i18n`) follow
  `chromium`.
- `msedge` is decided by the generated config at run time (generation stays pure): the project exists only where the
  host's documented Edge path exists, else the config prints `msedge: skipped (not installed)`. sapu never installs it.
- A check's `project` (`CHECKS[].project`) gates its `emit` lines with `if (inProject([...])) {…}`. Accepted: a project
  name (`chromium`, `firefox`, `webkit`, `msedge`, `chromium-<w>`, `a11y`, `i18n`), `"browser"` (the engines),
  `"viewport"` (those and every `chromium-<w>`), an array of these, or `"all"`, `"*"`, absent (every project). Any
  other name is refused at generation (`failed: codegen: check <name> names project <x>, which the suite does not
  define`); a known project this suite lacks (`i18n` with no locales) leaves the check no lines. `support.ts` exports
  `inProject(names)`; every spec imports it. `when` is not read.
- `emit(step, ctx)`'s `ctx` is now `{id, steps, smoke, screens, projects}`: `screens` the ascending step numbers of
  the path's screens, `projects` the names above (msedge included). `screensOf(id, steps, smoke)` (exported): smoke.json
  `journeys.<id>.screens`, else the last step that acts on a page. A step that is not one, or is the system's, is
  refused (`smoke.json journeys.<id>.screens names step <n>, which is not a step of the path acting on a page`). C2's
  ARIA and axe emitters take their screens from `ctx.screens`.
- The shot, after the step and before its checks' lines: `if (inProject([engines and chromium-<w>, never msedge, a11y
  or i18n])) { await <page>.mouse.move(-1, -1); await expect(<page>).toHaveScreenshot("<n>.png", {animations:
  "disabled", caret: "hide", mask: [...]}) }`. Masks: `getByRole("time")`, the marker and every value read at or before
  the step (empty strings dropped, since `getByText("")` matches everything), then smoke.json `masks` and the journey's
  `masks` through `targetCode`. No `maxDiffPixels`, no `threshold`, not full page. It is not its own `test.step`, so
  the title list stays the DSL's; the name `<n>.png` carries the step.
- The config adds `ignoreSnapshots: !CI`, `snapshotPathTemplate` (the plan's string), and
  `expect.toMatchAriaSnapshot.pathTemplate` `{testDir}/__aria__/{testFileBaseName}/{arg}{ext}`, which C2.2 needs
  and the plan's C3 lines did not list.
- `package.json` also pins `@axe-core/playwright` to `SMOKE_AXE` (`4.13.0`, exported), exact.

**The ARIA `--update-snapshots=changed` probe (plan C3.2), run live on the pinned alpha: YES.** With a stale
`.aria.yml` holding a different heading, a normal run fails with a line diff; `--update-snapshots=changed` rewrites the
file to the received snapshot (the `page.ariaSnapshot()` form, without a trailing newline), reports `A snapshot is
generated at …` and passes; a missing file under `missing` is written the same way. So B3 may adopt a changed ARIA
baseline from a CI update run with `changed`, and the `run-code` fallback is not needed. The test pins it. Other
facts met: `getByRole("time")` matches a `<time>` element; `toHaveScreenshot` and `toMatchAriaSnapshot` both accept
the path templates; `--project` is variadic, so a file filter must come before it on the command line.

**Deviations.**
- **`{testFileBaseName}` is `<id>.spec`, not `<id>`:** the base name drops only the last extension, so every baseline
  is `__screenshots__/<project>/<platform>/<id>.spec/<n>.png` and `__aria__/<id>.spec/<n>.aria.yml` (probed). I kept
  the plan's template string, because C2 chooses the ARIA name without the id and needs the template to carry it.
- The existing green browser test now runs `--update-snapshots=missing`: a generated suite has a default screen per
  journey, so under `"none"` it fails until a baseline exists (decision 7). The new browser test proves that failure
  has no `-actual.png`, that `missing` writes the PNGs and passes, and that a normal run then holds with the
  marker and order number masked.
- The browser tests run Chromium only (`channel: "chrome"`): this machine has no Firefox build, and WebKit is not what
  the pinned install resolves. The Firefox, WebKit and msedge projects are proven on the evaluated config
  (`name`, `use`, `testIgnore`, the Edge seam), not by a run.
- The Edge seam is the generated `const EDGE = …` line, which the test replaces; there is no environment override.

**Needs coordinator.**
- **Spec §19.2 and §19.8, and lane B3's adoption globs** say `__screenshots__/<project>/<platform>/<id>/*.png` and
  `__aria__/<id>/*.aria.yml`; the real directory is `<id>.spec`. Either the spec and B3 take `<id>.spec`, or the
  generator renames the spec files (a lane 0 contract change). I left the spec and B3 alone.
- **Lane Z (CI workflow, A4's `smoke workflow`):** the matrix needs the project list above; the screenshot projects
  (engines and `chromium-<w>`) run in the pinned container and `msedge` on the plain runner; the baseline job's
  `--update-snapshots` run must name `--project` entries (screenshots and `a11y`'s ARIA), and `a11y`/`i18n` take no
  screenshot.
- **Lanes C1, C2:** use the `project` names above and `ctx.screens`; a `project` outside the list is refused when
  the first spec is generated.
- **Lane A (A3 `smoke check`, `smoke propose`) and any test that runs a generated suite under `CI=1`:** needs
  `--update-snapshots=missing` or committed baselines, or it fails by design.
- **Z4:** this section's `changed` result replaces the "documented, not probed" line of open risk 8.

### Lane C1 — layout, locale, links, dynamic states

**Locked for the lanes** (`-layout.mjs`, a leaf; 665 lines of the 750 cap).
- Exports: `CHECKS`, `PAGE_FN`, `pageExpression(kind, opts)` and `LAYOUT_KINDS`. `PAGE_FN` is one plain-script
  function, `({kind, opts}) → answer`, so the same text is the support file's `page.evaluate` source and the
  exploratory lane's `run-code` source: Z1 runs `pageExpression("layout")`. Its kinds are `layout` ({only?}),
  `format` ({locale}), `lang`, `text` ({exclude}), `links` ({origin}), `loading`, `empty`, `toast-arm`,
  `toast-take` ({next}) and `toast-state` ({ids}).
- `CHECKS` holds six entries: `layout`, `locale` (project `i18n`), `links`, `loading`, `empty` and `toast`. The
  `layout` entry's `source` carries the shared core (the in-page function, project gating, known and allowed
  violations, annotations) and every later source calls it, so the entries must stay together. Names in the
  sources start with `layout`, `locale`, `links`, `loading`, `empty` or `toast`, so another lane's source cannot
  collide with them.
- Each `emit` writes one `expect.soft(await (await import("./support")).<fn>(…), "<what>: step <n>").toEqual([])`
  per account step, none for a `system` step (`links` also writes `linksStep` and, after the last step, `linksFinal`
  even when that step is a `system` proof). The account is passed as its index in the order accounts first act,
  which is the order of `opened`. The functions: `layoutStep`, `localeStep`, `linksStep`, `linksFinal`,
  `loadingStep`, `emptyStep`, `toastStep`. The import is dynamic because the spec's static import list is
  codegen's; both load the same module instance (probed under the pinned runner).
- Gating is by project name: `a11y` and `i18n` are those two projects, and every other project is a viewport
  project. The viewport projects run layout, links, loading, empty and toast; only `i18n` runs locale; `a11y` runs
  none of them.
- A violation is `{check, step, key, detail}`. A kept one is a soft failure and an annotation `argus-violation`
  (JSON in `description`). The owner's own judgements are annotations `argus-manual` (`{check, step, key, detail}`)
  and report lines are `argus-info`. Those annotations are the structured channel for `smoke ci` and the report:
  `results.json` carries them per result. Keys are `<role>|<name with digit runs as #>|<tag>`, and `detail` holds a
  clipped page string (a name, at most 30 characters; a key, at most 60), so a reader must fence it, never print it
  bare.
- Check names and keys: `page-scroll` (key `page-scroll`), `clipped`, `covered`, `target-size`, `locale-page-scroll`,
  `locale-clipped` (key `<code>|<key>`), `locale-format` (`<code>|number|<shape>` or `<code>|date|<shape>|order|separator`),
  `link` (`link|<pathname, digit runs #>`), `cta-route` (`<role>|<route>`), `loading`, `empty`, `toast` (key suffixes
  `|covers` and `|persistent`). A `manual` one is `locale` (`<code>|not localized`) or `link`.
- `known/<id>.json` is an array of `{check, key}` rows (a missing file holds none; a corrupt one throws). `allow`
  comes from `smoke.json` `journeys.<id>.allow`, embedded as a JSON literal.
- The `i18n` project reads its codes at run time from `<repo>/.argus/live.json` (`locales`, `pseudo_locales`,
  `locale`, `timezone`), because a check's `source` is static. It also opens each account's `.auth/<account>.json`
  when it exists.
- `ctx.routes` is optional: `[{role, route}]`, the journey's map steps that have a `route`. Without it the CTA-route
  check emits nothing (see "Needs coordinator").

**Deviations.**
- *Locale, dedupe.* A URL is looked at once per account unless the step may change server state (`click`, `dblclick`,
  `press`, `reload`, `login`, `go-back`); a sibling context per code per step otherwise costs more than it finds.
- *Toasts.* The recorder is armed after step 1 (an init script for later documents, plus the current one), so a toast
  of step 1 is not seen. A fixed element that appears, has text and goes within `SETTLE` must be in a live region; a
  live one must not cover the next action's target (matched by the target's name or value) and, if it stays, must be
  dismissible. Text added to a fixed region that was already there is a status update, not a new toast. Dialogs,
  menus, navigation, headers and footers are not toasts.
- *Links.* A redirect loop (more than 5) fails. Any 4xx but 404 and 410 is `manual`, and a failed request is `manual`
  too (never a false fail). Another origin's redirect target ends the walk and holds the link.
- *Loading.* The final step is judged as every other step is: a loader still visible after `SETTLE` fails.
- *Empty state.* Headings, the table's own header and caption, scripts and styles do not count as "text near it", so a
  section title alone does not excuse an empty table.
- *Page scroll.* A page that scrolls sideways with no element found past the edge is still reported.
- *Target size.* The circle test also counts an undersized neighbour by its box, and the exceptions are the inline
  link in a text block and a native checkbox, radio or range whose computed size equals the browser's default. The
  equivalent and essential exceptions are the owner's, through `allow`.
- *Covered.* A coverer that is fixed or sticky is skipped only when it does not contain the control (a modal dialog is
  itself fixed). A control partly clipped by a scrolling ancestor, a multi-line inline link and `pointer-events: none`
  are skipped.

**Needs coordinator.**
1. `tests/argus-live-codegen.test.ts` ("runs green for the fixture app") goes red once the layout oracle merges: the
   fixture app's header really fails WCAG 2.5.8 (the 64 x 21 px "Account" button sits directly under the "Home" link,
   key `button|Account|button`, check `target-size`). Either add `journeys.<id>.allow` for that key to the `smoke` the
   test builds (as lane C1's own suite run does), or give the button a 24 px minimum height in
   `tests/fixtures/journey-app/server.mjs` (shared with C3's screenshots, so the allow is the safer one). The file is
   C3's after lane 0.
2. The CTA-route check needs `ctx.routes`. `smokeSpec` in `-codegen.mjs` (C3) builds `ctx = {id, steps, smoke}`; it should
   add `routes`, read from the journey's map steps (or from a `routes` member A2 stages in `journeys/<id>.json`).
3. C3's projects must be named `a11y` and `i18n` (spec §19.6) for the gating above to hold; a differently named
   project would run as a viewport project.
4. B2 and F read the annotations above (`argus-violation`, `argus-manual`, `argus-info`) from `results.json`; B3's
   adoption of known violations writes `known/<id>.json` as `{check, key}` rows. §19.8 names a `violations-<id>.json`
   artifact that no lane in this plan writes: B decides whether it is the annotations, collected.
5. Z: spec §19.7 still describes the empty state as "visible text near it beyond its own headers" (the build also
   excludes section headings), the toast's blind first step, and the locale dedupe above.

### Lane C2 — accessibility

C2.1–C2.4 are built in `-a11y.mjs` (642 lines, a leaf with no import), `tests/argus-live-a11y.test.ts`,
`tests/fixtures/journey-app/pages/a11y/` and `tests/fixtures/axe-results/`, plus the rows of `skills/argus/standards.md`.

**Locked for the other lanes.**
- **Registry.** `CHECKS` holds `a11y-core` (shared helpers, no emitter), `a11y-keyboard`, `a11y-names`,
  `a11y-aria`, `a11y-axe`, `a11y-tokens`, `a11y-forms` and `a11y-modals`, all with `project: "a11y"`. `screensOf(ctx)`
  is exported: smoke.json's `journeys.<id>.screens`, else the last expectation of an account before that account's
  next action or the path's end. C3.2's screenshots should use the same list.
- **Sources** are plain JavaScript (the suite is never type-checked), every function named `a11y…`, so no lane's
  names clash. A function the specs call is `export`ed. A test strips the keyword to evaluate a source, and so would a
  `run-code` caller. A source reads `SETTLE`, `REPO`, `__dirname` and `require`, all in scope of `support.ts`. No source
  holds a backtick, and none uses `.exec(` or the other words the support test scans for.
- **Emitters.** The spec's import line is the generator's, so each emitted block opens with `if
  (test.info().project.name === "a11y") { const a11y = require("./support"); … }`. Only that project runs a check.
  The lines use no `test.step`, so the step titles stay `step <n> <do|expect>:<kind>`. Checks that must see the page
  before an action (keyboard, names, forms, the modal arm) are emitted after the previous step, for the whole group
  that follows it. Checks of a screen (ARIA, axe, tokens) and the modal check follow their own step.
- **A violation** is `{check, step, key, detail, manual?, hard?}`. `a11yReport(expect, test.info(), found, id, allow)`
  drops a violation listed in `known/<id>.json` (a JSON list of `{check, key}`, read at run time; an absent or
  malformed file is no known violation) or in smoke.json's `allow` (baked into the spec as a literal). It
  annotates `manual` ones as `a11y-manual`, soft-fails the rest in one `expect.soft`, and throws for a `hard` one
  (a form that accepted a bad value), which ends the test. A `hard` one can still be adopted or allowed.
- **Keys.** Role and accessible name with digit runs written `#`; axe's are `axe:<rule>` with the target joined
  (shadow levels with ` >> `, iframe levels with ` | `).
- **ARIA.** The specs write `toMatchAriaSnapshot({ name: "<n>.aria.yml", timeout: SETTLE })`, `n` the screen's step
  number. `ARIA_EXPECT` is `{pathTemplate: "{testDir}/__aria__/{testName}/{arg}{ext}"}`, which puts the file at
  `__aria__/<id>/<n>.aria.yml` (the test's title is the journey id).
- **Notes** are annotations of type `a11y-note` (the token line), `a11y-manual` and `a11y-backdrop` (a modal's
  backdrop behaviour, read back by the next modal of the test).

**Probed facts** (the pinned alpha runner and Chrome; they outrank the spec lines they touch).
- `expect.toMatchAriaSnapshot.children: "contain"` set in the config makes a **missing or empty baseline match**:
  the run passes with nothing adopted. Left unset, matching is already partial (a baseline with fewer lines than the
  screen passes), a missing file fails, and a mismatch gives a line diff only.
- Tab "from the page's start": a script cannot reset Chrome's sequential focus starting point except by focusing and
  removing a node at the document's start, and that start skips the positive `tabindex` group. Following it with
  Shift+Tab, which leaves the page, makes the next Tab the first stop of the true order. Once the walk starts, focus
  that leaves the page (the active element is the body) is the end of a lap, but before the first stop it is only the
  walk's own start.
- `expect` from the runner works outside a test for hard matchers (`toHaveAccessibleName`), and `page.screenshot`
  with a `clip` takes viewport coordinates.
- A native modal dialog's Escape and focus return work as the pattern says. `fill` truncates at `maxlength`, so a
  `maxlength` case holds when the field is capped.

**Deviations from the plan.**
- `children: "contain"` is not part of the ARIA config (the probe above). C2.2's line and spec §19.7's "children:
  contain" must be corrected in Z4.
- C2.4's test lives in `tests/argus-live-a11y.test.ts`, not `engine.test.ts` (a rule file this lane does not own).
  The rows are in the existing accessibility table of `standards.md`, whose third header became "Used for
  (aesthetics.md, or the smoke suite's checks)". Each new row quotes the criterion's sentence from its Understanding
  page, read in full, and no row is marked ⚠. 2.4.3's row records why a backward jump is for a human.
- Tokens are read at run time from the repo's `.argus/live.json` (`REPO` is the repo's root) because the emitter's
  `ctx` carries no `live`. The generated files then do not depend on `tokens`. The source file must lie inside the
  repo. The skip line `design tokens: not checked (no token source)` is an `a11y-note`, written once per test.
- The page variable of an account is rebuilt in `-a11y` from the steps (`ctx.pages` is used when given), because the
  spec's variable map is not in `ctx`.
- A modal whose invoker is gone is checked for Tab only. Escape and the backdrop click would close a dialog the path
  could not reopen, so a manual `modal-escape` says "not tested".
- A keyboard check whose target is covered reports 2.4.11 alone: the focus-visible and contrast verdicts need a
  visible indicator.
- Form cases click the path's own submit (a `button` or `input` of type submit, inside a `form`); a click on any other
  control gets no cases. A page that navigates on a case counts as a submit.

**Needs coordinator** (none of these files is this lane's).
- **C3 / codegen.** The `a11y` project is not in the config yet: Chromium, `testMatch` the specs, depending on
  `setup`, and `expect: { toMatchAriaSnapshot: ARIA_EXPECT }` imported from `-a11y` (codegen already imports its
  `CHECKS`). The suite's `package.json` needs `@axe-core/playwright` pinned exactly (`SMOKE_AXE`); the emitter takes
  the named export, `const { AxeBuilder } = require("@axe-core/playwright")`. The end-to-end test in
  `argus-live-a11y.test.ts` adds that project and a recording stub of the builder by hand.
- **Codegen `ctx`.** Adding `pages` (the variable map `pageVars` builds) would let `-a11y` drop its copy of the
  naming rule. `live` in `ctx` would let tokens be decided at generation.
- **A3 / B3.** `known/<id>.json` is a JSON list of `{check, key}` as `a11yReport` reads it; the adoption of
  `__aria__/<id>/<n>.aria.yml` prunes digit runs and the marker as decision 7 says. Neither lane's code was read.
- **Z2–Z4.** Spec §19.7 needs: the Shift+Tab start of the keyboard pass; the screens rule; the modal procedure
  (backdrop click, then Escape, then reopen by the invoker, and the exemption above); the form runner (cases click
  the path's submit and put values back); `children` left unset; tokens read at run time. `live.md` should say the
  token file is read from the repo's root in the suite.

### Lane B — breaks, triage, baselines

**Locked for the lanes** (`-heal.mjs`, `-ci.mjs`).
- **The smoke state** (`-heal`'s `STATE_FILE`, `.argus/smoke-state.json`, 0600): `{version: 1, staged, rejected,
  journeys, comments}`. `readState(main)` refuses a file not of that shape rather than overwriting it.
  `writeState`, `stageInto(state, entry)`, `stage(main, entry)`, `changeDigest`, `canonical` and `codeBlock` are
  exported.
  - A staged entry is `{kind, id, run, changes, body, path?, quarantine?, digest}`. `kind` is `heal`,
    `quarantine`, `unquarantine` or `drop`. `changes` are the `changes.jsonl` lines (`{kind, id, step?, from?,
    to?, evidence, run}`), and `body` is the proposal body's markdown lines. A heal carries the healed `path` for
    `journeys/<id>.json`, and a quarantine carries `{id, issue: null, since}` for `quarantine.json`.
  - `digest` is the sha256 of `{kind, id, changes, path, quarantine}`, without the run, the evidence or the body.
    So the same change from a later cycle has the same digest. A new entry replaces the staged entry of the same
    kind and journey. A digest in `rejected` is never staged again.
  - `journeys.<id>` holds `baseFlakes` (CI run ids), `tracking` (`smoke-flaky:<id>`), `exits` and `quarantine:
    {since, cycles, clean, counted}`. `comments` holds the `<pr>:<id>` pairs already commented.
- **`smoke heal <slot>.<generation>`.** The verb needs a cycle with an instance, the slot minted in it, a return
  holding `heal`, and this cycle's `pass.jsonl` ending, for that journey, in `broke` with kind `target-missing`,
  `target-ambiguous` or `action-failed`.
  - `healPath(list, heal, max)` applies the heal, and `healOnly(before, after, max)` checks it. Their refusals:
    `refused: smoke heal: [step <n>: ]<reason>`.
  - Exit 0 is `heal <id>: UI changed: …`, then `staged: heal <id> (digest <12 hex>)` (since Z4, `heal <id>: not staged
    (this change was rejected before; digest <12 hex>)` and no `healed` event for a rejected digest) and a fence holding the old
    and new target code and the `git log -S"<name>" <head12>..HEAD: <commit>` evidence (or `no commit removed
    it`), with the anchor files' commits.
  - Exit 3 is `heal <id>: behaviour changed: …` or `heal <id>: bug: …`, then `regression <id>: step <n> written as
    <slot>.1.1 (repro <slot>.1.1)`. It is also `heal <id>: did not hold (fresh: …, dirty: …); nothing staged`.
  - Exit 2 is `heal <id>: harness: …; nothing staged`.
- **`smoke ci [--run <id>]`.** It writes one unfenced line per finding, then one fence (`<<<PAGE-<nonce>`) that
  holds every key, diff and message. `[k]` in a line names its entry in the fence.
  - The finding lines: `harness setup <account>: …`; `flaky <id> <projects>: …`; `flaky-new <id> <pr>`;
    `ui-change? <id> step <n>`; `ci-only <id> step <n>`; `bug? <id> step <n>`; `browser-only <id> <project>`;
    `visual <id> <n> <project>: expected <file>, actual <file>, diff <file>`; `baseline-missing <id> <project>`;
    `aria <id> <n> [k]`; `check <id> <check> [k]`; `manual <id> <check> [k]`; `quarantined <id> <project>: …`;
    `quarantine <id>: …`; `drop <id>: …`; `skipped: …`.
  - The run ends with `smoke ci: <a> failing, <b> flaky, <c> harness, <d> quarantined read`. Exit 3 with a
    failure, else 2 with a harness line, else 0.
  - The unfenced lines go to `.argus/smoke-ci/<run>/triage.json` (`{run, event, branch, sha, lines}`, 0600): F1's
    "newest smoke ci summary" and B3's input. Screenshots are copied to
    `.argus/smoke-ci/<run>/<id>/<project>/<n>-<expected|actual|diff>.png` (0600), under names sapu makes.
  - A check's violations are read from a test result's attachment named `argus-violations` (`VIOLATIONS`). It is
    JSON `[{check, step?, key, detail?, status?: "manual"}]`, as a base64 `body` or a file under the run's
    `test-results/`.
- **`smoke baseline --from-run <id> [--ids …]`.** Its lines are `baseline: dispatched <ids> mode=<m>; adopt with
  smoke baseline --from-run <new run>`, `baseline: committed <k> file(s) to <argus/ branch> (<sha12>)`,
  `baseline: <k> file(s) proposed in <url> (argus/baselines-<run> into <branch>)`, `baseline: nothing to dispatch
  …`, and the owner's `gh workflow run …` line (exit 2). `pruneAria(text)` is exported.
- `smokeCi(main, {run}, {runner})`, `smokeBaseline(main, {fromRun, ids}, {runner})` and `smokeHeal(main, ref,
  {once, runner})` keep lane 0's names and arguments. The third argument is a test seam: `runner` stands in for gh
  and git, `once` for runOnce. `smokeBaseline` is `async`, like `smokeCi`.

**Deviations.**
- **Heal.**
  - `smoke heal` takes no `--slot`. A regression candidate is written as the run's lowest free slot, with smoke
    run's slot record (`mode: "smoke"`, no token, the accounts the candidate acts as). `-heal` keeps its own
    copies of `-smoke`'s `regressionList` and `writeRegression`, which `-smoke` does not export (see below).
  - `action-failed` counts as an action break a heal answers, beside the table's "matches nothing or several".
  - Rows the table does not have: `heal_reason` `blocked` or `harness` is the harness's (exit 2). A healed path
    that does not hold twice, or fails an expectation only once, is `did not hold` (exit 3). Neither stages
    anything.
- **Triage.**
  - `browser-only` names the journey too. Keys and diffs never appear unfenced, so `check`, `manual` and `aria`
    lines point into the fence with `[k]` rather than printing the key. `manual` names the check (`axe:<rule>` for
    axe), not a bare rule.
  - **ARIA.** A `toMatchAriaSnapshot` failure's screen number comes from its error snippet's `"<n>.aria.yml"`.
    It is `baseline-missing` when `<dir>/__aria__/<id>/<n>.aria.yml` is absent at the run's head (the working
    tree when the clone lacks that commit), else `aria`.
  - **Artifacts.** smoke ci downloads `gh run download --pattern "<ci.artifact>*"`, each artifact in its own
    directory, so a matrix's per-project artifacts all count. smoke baseline does the same for
    `argus-smoke-baselines*`.
- **Quarantine.**
  - A quarantined journey's cycle is counted once a lane cycle (the lock's run id), at that cycle's first
    `smoke ci`.
  - A cycle is clean when the cycle's pass holds the path at least twice and holds no other verdict, and at
    least one quarantine-job result was read, every one passed first time.
  - Exit stages `unquarantine`, which bumps `exits`. A later base-branch flake with `exits ≥ 1` stages `drop`.
- **Tracking issue.** smoke ci names the tracking issue (`tracking issue smoke-flaky:<id>`) and records it.
  Filing it is the orchestrator's, through `scrub --create` (Z2's text). The quarantine entry's `issue` is staged
  as `null`.
- **Baseline.**
  - On a normal run, smoke baseline reads that run's `triage.json`, so `smoke ci --run <id>` comes first
    (`refused: smoke baseline: run <id> is not triaged yet (smoke ci --run <id> first)`). It dispatches one job per
    mode. The new run id is taken from gh's output when gh prints a run URL. Otherwise the line names the `gh run
    list` query that finds it.
  - A missing dispatch right is read from gh's failure (HTTP 403 or 404, "not accessible", scope, permission).
  - Adopted violations replace `known/<id>.json`, sorted and deduplicated. The baseline commit appends one
    `changes.jsonl` line per file (`{kind: "baseline", id, step?, to, evidence, run}`).
  - Scrub's matcher (the newest run's `scrubSecrets`, which needs that run's ledger) reads every adopted text
    file, before and after pruning, and the pull request's body. PNGs are not text-scanned.
- Line counts at B3: `-heal` 404, `-ci` 741.

**Needs coordinator.**
1. **Staging (A2, A3).** `-propose` and `-suite` sit below `-heal` in the DAG, so they cannot import
   `readState`. At merge, either move the state helpers (`STATE_FILE`, `readState`, `writeState`, `stageInto`,
   `stage`, `changeDigest`, `canonical`, `codeBlock`) down into `-suite.mjs`, where A2's admit stages too, or have
   A read the file by the format above. Propose must also:
   - apply each kind: a heal's `path` to `journeys/<id>.json`; `quarantine` and `unquarantine` to
     `quarantine.json`, and so to codegen's `@quarantine` tag; `drop` as the journey's removal;
   - append `changes`;
   - move a closed proposal's `digest` into `rejected`.
2. **`-smoke.mjs` (lane D).** Export `writeRegression` and `regressionList` (taking a repro list), so that
   `-heal`'s `writeCandidate` and `regressionList` can go. Also, `smoke run` should run a quarantined path twice
   in a cycle. Without that, a cycle can count two holds only if `smoke run --ids <id>` runs twice.
3. **C1 and C2.**
   - Attach violations as `argus-violations` in the shape above, with axe's `incomplete` as `status: "manual"`.
   - Emit `toMatchAriaSnapshot({ name: "<n>.aria.yml" })` with the literal name, because B2 reads the screen
     from the error snippet.
   - Store ARIA files at `__aria__/<id>/<n>.aria.yml`, not under the spec file's name.
   - Have the baseline job write `violations-<id>.json` at the uploaded root.
4. **C3.** The snapshot path must be `__screenshots__/<project>/<platform>/<id>/<n>.png`, with the directory
   `<id>` itself. If `{testFileBaseName}` yields `<id>.spec`, B3's name shape must follow.
5. **A4.**
   - Name the results artifacts `argus-smoke-results` or `argus-smoke-results-<project>`, uploading
     `test-results/`'s contents, with `results.json` at the root.
   - Name the baseline artifacts `argus-smoke-baselines[-<project>]`, with the suite directory as their root
     (`__screenshots__/…`, `__aria__/…`, `violations-<id>.json`). A `-<project>` suffix names the project that a
     baseline commit's `changes.jsonl` line and the pull request's table give an ARIA or violations file.
6. **F1.** Read `.argus/smoke-ci/<run>/triage.json` as smoke ci's summary.
7. **Lane 0's dispatch test.** `tests/argus-live-smoke.test.ts`'s `STUBS` still lists `smoke heal`, `smoke ci`
   and `smoke baseline` as "not built yet", so "each new verb reaches its lane's function" fails from this lane
   on (`smoke heal 2.1` answers `refused: no journey cycle is running`). Drop those rows at merge. With no suite
   paths, `smoke ci` and `smoke baseline` now refuse (`refused: smoke <verb>: the suite has no paths (…)`)
   before gh is asked anything, so that test never reaches the network.
8. **Z2's `smoke.md`.**
   - Run `smoke ci` before `smoke baseline`.
   - The orchestrator files `smoke-flaky:<id>` and the `ci-only` and check issues.
   - `smoke heal` follows a `broke` with a target or action kind.

### Lane D: performance (D1)

**Locked for the lanes.**
- `argus-live-perf.mjs` exports, below the session driver (it imports `-config`, `-fence`, `-map`, `-proc` only):
  - `PERF_SCRIPT`, `perfCode({wait, waitMs, settle})`;
  - the sink: `newSink`, `activeSink`, `collecting(sink, fn)`, `recordDocs`, `measure`, `runMetrics`;
  - the statistic: `median`, `batchMedians`, `regressions`, `confirmedRegressions`;
  - the store: `readPerf`, `pathSha`, `machineOf`, `perfPath`;
  - the commands: `perfIssue(main, id)` and `perfRebaseline(main, id)`, both synchronous, returning `{code, lines[, masked]}`.
- `smoke run --perf [--ids] [--seed]` runs the suite's paths in the seed's order, each through `perfPath`:
  - **Batch.** One warm-up run after `up --fresh` (left out), then `perf.runs` dirty runs on that instance; a value is each metric's median.
  - **Verdicts.** There are five. `baselined` means a first batch, or a void baseline whose path digest or machine changed. `ok` means within the thresholds. `regressed` means a second batch, after another `up --fresh`, has the same metric over both thresholds. `flaky` means the second batch was within them. `not-measured` means the path broke or the harness failed.
  - **Exit.** 3 for a confirmed regression or a path that broke, else 2 for the harness, else 0.
  - **Lines.** `seed: <n>`; `perf <id>: baseline set (<why>), <n> runs: lcp_ms=… (lab context: good 2500), inp_ms=… (lab context: good 200), cls=… (lab context: good 0.1), duration_ms=…, requests=…, bytes=…`; `perf <id>: ok, …`; `perf <id>: regressed <metric> <baseline> -> <batch 1>, <batch 2> (more than <rel>% and <abs>[ ms])` (one per metric); `perf <id>: flaky …`; `perf <id>: not measured (<reason>)`; `smoke run --perf: <b> baselined, <o> ok, <r> regressed, <f> flaky, <x> not measured`.
  - **Refusals.** It takes no `--slot` (`refused: smoke run --perf: it writes no regression, so it takes no --slot`). It is refused while another slot of the run holds a live token (`refused: smoke run --perf: <n> other slot(s) live`), counted from run.json `slots[*].tokenHash`.
- `.argus/perf.json` (0600, local state) is `{<journey id>: {pathSha, head, machine, n, medians, latest}}`:
  - `pathSha` is the sha256 of the path file's `path` list as JSON.
  - `head` is the instance worktree's commit.
  - `machine` is `{cpu, cores, mem_gb, platform, chrome}`, and Chrome's version comes from the user agent.
  - `latest` is `{pathSha, head, machine, n, batches: [medians…], regressed: [{metric, baseline, values}]}`.
  - `readPerf` validates every field, and refuses with `refused: .argus/perf.json is not a perf record`.
- `<run>/smoke/perf.jsonl` (0600) gets one row per path per pass: `{id, verdict, baseline, batches, regressed[, why]}`. It is what F1's report reads for "perf (baseline → batches, verdict)".
- `smoke perf --issue <id>` prints, fenced and masked (`masked: true`):
  - `perf regression: <id>`;
  - one `dedupe: perf:<id>:<metric>` line per regressed metric;
  - the baseline's head and run count;
  - `machine: <cores> cores, <GB> GB, <platform>, Chrome <version>`, without the CPU model;
  - a table of the baseline, each batch, the thresholds and a verdict per metric;
  - the `lab context` line;
  - `git log --format='%h %s' <baseline head>..HEAD` over the journey's anchor files, in a `COMMITS` nonce fence.

  It refuses with no record, no batch, or no confirmed regression. `--rebaseline` moves the baseline to the newest batch, carrying that batch's path digest, head, machine and run count, and clears `latest.regressed`.
- The session driver reads `activeSink()` when it is made. In a perf pass it hooks `${SIGNAL_SCRIPT};\n${PERF_SCRIPT}`, and its `code()` is `measure(...)`: a snapshot after the pages' `load`, the step, a snapshot after `settle: 50`. `stage()` never is. `runOnce` is unchanged.

**Deviations.**
- **The hook installs the perf script only in a perf pass**, not in every session. The spec's wording ("installed with the signal script") would put it in the explorer's sessions too, where nothing reads it. It would also change the hook payload that `tests/argus-live-findings.test.ts` pins. Z4 may widen it. The spec reads "installed with the signal script", and the as-built reading is "when a perf pass measures".
- **The script is evaluated at each `domcontentloaded` by the hook and again before every measured step** (it is idempotent per document). It does not run at document start, because the slot's init script (`-browser.mjs`) belongs to another lane. The observers are `buffered`, so LCP, CLS and event entries from before the evaluation are still read, and the Chrome test proves it.
- **"Background loads ignored"** is read as web.dev's rule: an LCP candidate that comes after the document went to the background, or a document that began there, is not counted.
- **INP** is the worst `interactionId` group (the longest event of an interaction), so there is no p98 allowance. A path with no event over 16 ms reads 0.
- **`duration_ms`** is the time of the step templates' `run-code` calls. A parallel group's actions wait for their barrier, so a group adds a constant 1.5 s to the sum. This is stable between runs.
- **`pathSha`** is computed from the path file, not read from `admitted.pathSha`: a heal changes the path without a new admission.
- **`perfIssue` and `perfRebaseline` are synchronous.** `smoke run --perf` exits 3 for a confirmed regression, which §19.11 leaves open.
- Lane 0's `tests/argus-live-smoke.test.ts` lost three not-built entries: the `--perf` row of STUBS, the two `smoke perf` rows, and the `--perf` refusal assertion. The behaviour they pinned is now `tests/argus-live-perf.test.ts`'s.
- `-smoke.mjs` changed in `smokeRun`'s `--perf` branch only (the refusal, the live-slot check and `perfPass`).
- Line counts: `-perf` 398, `-smoke` 258, `-session` 265.

**Needs coordinator.**
- **F1:** the report's perf section reads `<run>/smoke/perf.jsonl` (and `.argus/perf.json` for the baseline), not the pass lines.
- **Z2:** the orchestrator's text for a perf pass is `smoke run --perf` (exit 3) → `smoke perf --issue <id>` → `scrub --create` with labels `performance` (argus's label; the plan's `perf` is not one, see Z2's deviations), `argus`, `found-by:user` and the needs-owner label, deduplicated by the printed `dedupe:` keys. The guard needs no change, since `smoke perf` is the orchestrator's verb and already refused to a subagent.
- **Z4 / the spec:** §19.11 should name `latest` in `perf.json`, the `perf.jsonl` row, and the five verdicts and exit codes above. Its wording "installed with the signal script" is the as-built "installed in a perf pass" (first deviation).
- **A (A2):** if `admitted.pathSha` is meant to be the digest of the path list as JSON, the two agree on a path written once. If it hashes something else, no change is needed, since `perf.json` keeps its own digest.
- **Merge:** the three STUBS rows above conflict textually with the other lanes' edits of the same list. Keep every other lane's removals.

### Lane E — seeds (E1)

**Locked for the lanes** (`-seed.mjs`, with `-slots.mjs`, `-pw.mjs` and `-map.mjs` hooks).
- `seed(main, {issue, doc}, {runner}) → {code: 0, lines, masked: true}` (synchronous; refusals thrown). It
  needs a running cycle with a worktree (`up --map` or a full `up`), else `refused: seed: no journey cycle is
  running (up --map or up first)`, `… the deadline of cycle <id> passed; run down`, `… cycle <id> is being torn
  down`, `… cycle <id> has no worktree yet`.
  - `--issue <n>` runs `sapu-contract.mjs issue-trust <n> --text` (argv, no shell) and uses the title and body
    of the verdict's own snapshot as `<title>\n\n<body>`. A refusal or an unreadable GitHub → `refused: seed:
    issue <n> fails issue-trust (sapu-contract.mjs issue-trust <n> says why)`: the verdict's reason is not
    echoed. A pull request → `refused: seed: <n> is a pull request, not an issue`. The URL is
    `https://github.com/<contract repo>/issues/<n>`.
  - `--doc <file>:<a>-<b>` reads lines a to b of a regular file (`100644`/`100755` blob) tracked at the **run
    worktree's** HEAD, the code the map explorer reads and the merged map is stamped with, from git's object
    (`ls-tree --literal-pathspecs`, `cat-file blob`), never a working tree or a symlink's target. Refusals:
    `refused: seed: --doc takes <repo-relative file>:<a>-<b>, 1 ≤ a ≤ b` (absolute, `..`, a leading `-`, a
    control character; the input is not echoed); `… <file> is not tracked at HEAD`; `… <file> is not a regular
    file at HEAD (a symlink or a directory)`; `… <file> has <k> lines; the range ends past them`.
  - Both: `… the text is empty` (blank), `… the text is <k> characters, at most 100000` (`SEED_MAX`).
  - `<run>/seed.json` (0600): issue `{kind: "issue", ref: <n> (a number), url, text, digest}`; doc `{kind:
    "doc", ref: "<file>:<a>-<b>", file, lines: [a, b], commit, text, digest}` (`digest` the text's sha256).
    The printed line is `seed: <kind> <ref> <sha12> <k> characters`, never the text. A later `seed` replaces
    the file.
- `readSeed(main, runId)` → the record or null (its digest re-checked). `bindSeed(dir, s)`, `boundSeed(dir)`:
  a seed slot's binding `<slot>/seeded.json` (0600, `{kind, ref, digest}`), which `down` keeps (it removes
  only `.playwright/`, `state.json`, `lock`, `totp.json` from a slot directory), so `map-check --merge` works
  after `down`.
- `mintMapSlot(main, {slot, seed: true})` reads the run's seed first (`refused: slot --seed: cycle <id> holds
  no seed (seed --issue <n> or seed --doc <file>:<a>-<b> first)`), mints the map slot as before, binds it under
  the slot's lock, and replies `{slot, token, generation: 1, mode: "map", seed: {kind, ref}}`. run.json's slot
  entry is unchanged (`mode: "map"`).
- `pw <token> source` (role-free, no argument) → `source: <kind> <ref>`, then the seed's text in a fresh
  `<<<SOURCE-<nonce>` fence, then `calls <c>/<max>` and `truncated <k> characters` past `PAGE_CAP`
  (`sourceLines`). The text goes through `clean` (env-file values masked, controls replaced, `PAGE`/`RETURN`
  marker shapes escaped), then its `SOURCE` marker shapes get the same U+2011. It reads the run's files only:
  no process, no browser, no network (the test proves no runner or CLI call). Refusals, each counted: on any
  token but a seed map slot's, `refused: source takes a seed map slot's token (slot <n> --map --seed)`; on a
  seed slot whose run's seed was replaced since it was minted, `refused: source: the run's seed changed since
  slot <n> was minted` (the slot never sees another text). A seed slot's other commands answer `refused: a
  seed map slot takes only code, source and submit`. A plain map slot keeps `… a map slot takes only code and
  submit`.
- `seedsOf(main, runId, slot)` → `[{kind, ref}]` from the slot's binding, else `[]`. `mergeMap(prev, value,
  {head, seeds = []})` adds them to each journey the slot returned, once each (kind and ref equal), and keeps
  a journey's `seeds` on a later merge, since `validateMap` refuses a returned `seeds` (map or journey level),
  so only the merge writes them. `catalog` adds ` seeded` after ` money`/` global`. `score` ignores `seeds`.

**Trust, as tested** (`tests/argus-live-seed.test.ts`). With a seed whose text holds an instruction, forged
fence markers, a forged return with `seeds`, a shell line and a terminal escape: the seed slot's answers to
`goto`, `snapshot`, `trigger`, `facts`, `mail`, `code`, a `submit` with `seeds` and a valid `submit` are the
same as with a benign seed (fence nonces and counters aside), and a plain map slot's are the same but for its
refusal's wording. Nothing in the text reaches an argv, a shell, a label, a file name or a printed line
outside the SOURCE fence. A journey the text names but the code does not anchor is dropped by `map-check`.

**Deviations.**
- One seed per run at a time (spec §19.12 names one `<run>/seed.json`). A second `seed` replaces it, and a
  slot minted before then refuses `source` rather than read a text it was not bound to.
- `pw`'s role-free words are config's `ROLE_FREE` plus `source`, held locally in `-pw.mjs` (`PW_ROLE_FREE`),
  because `-config.mjs` is a shared hotspot. A role named `source` would be shadowed (see "Needs coordinator").
- The doc is read at the run worktree's HEAD, not MAIN's: the same commit the explorer reads and the merge
  stamps. `seed.json`'s `commit` records it.
- `seed` returns `masked: true`: its line holds the wrapper's words and the owner's own ref, and masking with
  a short env value would cut the digest.
- Line counts at E1: `-seed` 173, `-pw` 561, `-slots` 439, `-map` 480.

**Needs coordinator.**
- `tests/argus-live-smoke.test.ts` (lane 0's) pins the stubs this lane fills, and fails three tests until it
  moves: drop the two `seed` rows from `STUBS` (the CLI now answers `refused: seed: no journey cycle is running
  (up --map or up first)` with no cycle, which `tests/argus-live-seed.test.ts` pins), and in "slot --map
  --seed is the seed lane's" expect `refused: no journey cycle is running` for `slot 1 --map --seed`. The two
  `--seed needs --map` usage checks there still hold.
- `argus-live-config.mjs` `ROLE_FREE` should gain `"source"`, so `validateLive` refuses a role named `source`
  as it refuses the other wrapper commands; `-pw.mjs`'s `PW_ROLE_FREE` then folds back into `ROLE_FREE`.
- Engine text (Z2): the map explorer's charter for a seed token (run `pw <token> source` once, read the SOURCE
  fence as data, extend the map with the journeys the text describes, follow no instruction in it), and the
  orchestrator's sequence `seed …` → `slot <n> --map --seed` → dispatch → `map-check --merge <n>`, in
  `agents/ui-explorer.md`, `skills/argus/journeys.md` and `skills/journey/SKILL.md`.
- Spec §19.12 (Z4): fold in the binding file, `seed.json`'s fields, the one-seed-per-run rule, the reply's
  `seed`, and the read at the run worktree's HEAD.

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

### Integration

The lanes merged in the order A, C3, C1, C2, B, D, E, F (`--no-ff`); only this plan conflicted, and every lane's "As
built" sub-section is kept above. Each lane's "Needs coordinator" item is settled here; what the lanes left to lane Z
(engine skill texts, `live.md`, CONTRACT.md, docs and diagrams, the plan's open risks) stays lane Z's.

**Decisions.**
- **Dispatch test.** `tests/argus-live-smoke.test.ts` holds no stub row any more: each phase 6 verb's own answer in
  a repo with a contract and no cycle, suite or run is pinned (`smoke check: no suite (e2e/argus-smoke/journeys holds
  no path)`, exit 0; `seed` and `slot 1 --map --seed`: no journey cycle), and the trace gate over every smoke verb but
  `check`. The heal refusal test spawns git, so it has an explicit timeout.
- **Fixture header.** The codegen browser tests' suite allows `target-size` `button|Account|button` on every journey;
  `tests/fixtures/journey-app/server.mjs` is unchanged. The codegen probes of the layout registry pop their probe
  rather than emptying the array (which had erased C1's checks for the rest of the file).
- **Codegen `ctx`.** `{id, steps, smoke, screens, projects, pages, routes}`. `pages` is `pageVars`' map, so -a11y lost
  its copy of the naming rule; `screens` is codegen's `screensOf` (smoke.json's `screens`, else the path's last page
  step), the one list the screenshots, the ARIA snapshots, axe and the tokens check use (C2's own rule, the last
  expectation before each account's next action, is gone). `routes` is the journey file's `routes` (`[{role,
  route}]`): `smoke admit` records the catalog journey's map routes in it (the catalog is gitignored, so generation
  must not read it), `readSuitePaths` returns them, a heal keeps them. The config's ARIA settings are -a11y's
  `ARIA_EXPECT`, imported as is; the generated `a11y` project runs the whole check set under the pinned runner
  (C2's end-to-end test now runs the generator's own project, not a hand-added one).
- **Baseline directories.** `{testFileBaseName}` is `<id>.spec`: screenshots `__screenshots__/<project>/<platform>/
  <id>.spec/<n>.png`, ARIA `__aria__/<id>.spec/<n>.aria.yml` (ARIA_EXPECT's template is `{testFileBaseName}` too,
  and `a11yAriaFailure` looks there by the spec file's name). Adoption, `smoke ci`'s baseline-missing check, propose's
  drop, its baseline-needed list and its rebase's dropped files read `<id>.spec`; spec §19.2, §19.7 and §19.8 say so.
- **Smoke state.** One file and one format, B's, owned by `-suite.mjs` (below -propose, -heal and -ci):
  `.argus/smoke-state.json` `{version: 1, staged, rejected, journeys, comments, proposals}`, every writer writing it
  whole; `readState` refuses another shape (a file without `version` is read as version 1). `.argus/smoke-staged.json`
  and A's `stageChange`/`readStaged` are gone. A staged entry is `{kind, id, run, changes, body, path?, admitted?,
  routes?, quarantine?, digest}`; admit stages `add` this way and skips a rejected digest. `smoke propose` applies
  add, heal (keeping the base file's admission and routes; a heal of a journey the base lacks refuses), drop and retire
  (with the `<id>.spec` baselines), quarantine and unquarantine; appends each entry's `changes`; adds each entry's
  `body` under "Details"; and moves a closed proposal's digest into `rejected`. An entry `smoke ci` staged names a CI
  run (digits), which has no ledger: propose's secrets come from the lane runs.
- **Regressions.** -smoke exports `regressionList(list, n, context, last?)` and `writeRegression(main, {runId, slot?,
  id, repro, n, live, accounts, claim, result?})` (slot null: the run's lowest free one); -heal's copies are gone.
  `quarantineIds` moved down to -smoke. `smoke run` runs each quarantined path twice, one after the other
  (`quarantined <id>: run twice`), so the quarantine lifecycle can count two holds a cycle.
- **Workflow.** Its projects are codegen's `suiteProjects`, the config's list: every project but msedge in the
  container matrix of the test and baseline jobs (each run with `--project setup --project "$PROJECT"`), msedge on the
  plain runner with no screenshot; the quarantine job runs on the container's first engine. Artifacts:
  `argus-smoke-results-<project>` (`results.json` at the root; `-msedge`, `-quarantine`) and
  `argus-smoke-baselines-<project>` rooted at the suite directory.
- **Violations.** The collected annotations are the artifact. a11yReport now writes `argus-violation` and
  `argus-manual` (JSON `{check, step, key, detail}`) as C1's checks do, and the token note as `argus-info`. `smoke
  ci` reads them from results.json (a passing test's `manual` and `info` too; `info <id> <project> [k]` is a new
  line), and reads an `aria-snapshot` violation as `baseline-missing` or `aria`. `smoke baseline` adopts the baseline
  run's `argus-violation` rows of the adopted journeys from its results artifacts as `known/<id>.json`, a JSON list
  of `{check, key}` merged with the branch's own and sorted; no `violations-<id>.json` is read. Keys, details and
  info lines are fenced wherever printed.
- **New module.** `smoke baseline` and its adoption moved from -ci into `argus-live-baseline.mjs` (after -ci, before
  -report in the module order), so -ci stays under the line cap; -ci exports its artifact readers.
- **Report records.** -smoke's `smokeEvent(main, runId, event)` is the one writer of `<run>/smoke/events.jsonl`:
  `admitted` (smoke admit), `healed` with steps (smoke heal), `quarantined`/`unquarantined`/`dropped` when smoke ci
  stages them, `proposal` (smoke propose; smoke baseline's pull request). The report reads perf from `perf.jsonl`
  (D's five verdicts, the regressed metrics, a quoted not-measured reason) and `.argus/perf.json`'s baseline, and
  the CI summary from the newest `.argus/smoke-ci/<run>/triage.json` (no `.argus/smoke-ci.json`, no perf event). Its
  shown triage words gain `smoke`, `quarantined`, `failed`, `info` and `skipped:`. The integration tests run the real
  producers and read the report: pass and perf in `tests/argus-live-report.test.ts`, the events in each producer's
  own test.
- **ROLE_FREE** holds `source`; pw's local copy is gone. pw's usage line names `source`.
- **Found by the full suite.** A gated check with no line at a step left an empty `if (inProject(…)) {}` block in
  the spec; the gate is now written only around lines (both were hidden while a probe test emptied the layout
  registry). `repro --test` prints the API-level hint after the red test's line, which the findings end-to-end test
  now reads as the first line. The a11y and layout tests' browser close and the teardowns that run `down` get 30 s
  hooks. `smoke propose` checks a proposal against the staged changes' own lane runs, the newest run's ledger only
  when every staged change came from smoke ci (a newest map run has no ledger). pw's request-mask test searched the fence's random hex
  nonce for the masked values (`abc`, `def`): it searches the page's lines only.
- **Spec.** §19.7, §19.10–§19.13 follow the as-built behaviour (dedupe, Shift+Tab start, screens, no `children`,
  tokens at run time, empty-state headings, the toast's blind first step, a gone invoker's modal, the perf pass's
  script, `latest`, the five verdicts, the exit codes, the workflow's artifacts, the seed's HEAD, the report's
  inputs). A2's `admitted.pathSha` and D's `pathSha` are the same digest (sha256 of the path list's JSON) for a path
  written once.

**Left to lane Z.** A4's and B's Z2 engine text (admit needs an instance, ci before baseline, the orchestrator files
`smoke-flaky:<id>`, perf's `--issue` flow, the seed sequence), `live.md`'s token file, CONTRACT.md and the docs naming
`filed.jsonl`, `.argus/reports/` and the new `argus-live-baseline.mjs`, and open risk 8's line (C3's probe answered it).

### Lane Z2 — engine text

**As built.** `agents/ui-explorer.md` gains `## Paths` (`path: wanted`, the selector order, seed triggers, an example
path), `## Heal mode` (the path as data, the broken step, "never change an expectation", `heal`/`heal_reason`, an
example return), `pw '<token>' <role>.<k> layout [<check>]`, the `layout` expectation and final, `source` among the
role-free commands, and the seed map token's `source` read once as data. `skills/argus/journeys.md`: `path: wanted`
in the explore charter, `live smoke admit <s>.<g>` in step 6, the seed sequence in step 2 and the map charter, `live
report` last in step 10. New `skills/journey/smoke.md`: the ten-step smoke cycle, filing, perf, the heal charter, the
decision table's actions, the baseline run, admit and propose requirements, `smoke.json` and the CI wiring.
`/sapu:journey` gains `smoke`, `seed --issue <n>` and `seed --doc <file>:<a>-<b>`; `/sapu:init` the smoke block, the
`!/.argus/smoke.json` exception and the consented workflow; CONTRACT.md the lane's files and modules, the trust row
"the journey lane's seeds and smoke suite" and the explorer's `source`; `live.md` names `source` as role-free and the
token file read from the repo's root. `tests/engine.test.ts` pins the example path (path mode), the heal example
(`validateReturn` with `pathChecks`), smoke.md's `smoke.json` (`validateSmoke`, every `SMOKE_KEYS` key), every `live …`
command and flag smoke.md names against the usage line (split outside brackets), the smoke cycle's step per command,
the filing words, init's and CONTRACT.md's statements, and that every budget names an existing file.

| File | Bytes | Budget |
|---|---|---|
| `agents/ui-explorer.md` | 19,101 | 19,200 (was 15,500) |
| `skills/argus/journeys.md` | 12,764 | 12,800 (was 12,500) |
| `skills/journey/SKILL.md` | 4,677 | 4,700 (was 4,000) |
| `skills/journey/smoke.md` | 12,778 | 12,800 (new) |
| `skills/journey/live.md` | 14,500 | 14,500 (unchanged, full) |
| `skills/init/SKILL.md` | 22,560 | 50,000 (the default) |

**Deviations.**
- Labels follow argus's exact list (SKILL.md: `performance`, `ux`; no `perf` or `a11y`): perf issues file with
  `performance` and the needs-owner label, check issues with `ux`, S3.
- `up --fresh` retires every live explorer token, so `smoke run` and `smoke run --perf` come before any explorer slot,
  and `smoke heal` and `smoke admit` only after every explorer returned. Heal and capture explorers are dispatched
  together in step 5; the order is still plan → up → run → `--perf` → ci → heal → admit → propose → baseline → report →
  down.
- A heal slot is minted with the path's own accounts (`<role>.<k>=<the role's k-th user>`); one refused with
  `already serves slot <m>` waits for the next cycle.
- `smoke workflow` passes the trace gate only on a committed contract, so init writes the workflow in its own pull
  request after the init PR merged.
- journeys.md runs `live report` last (after `down`); smoke.md before `down`, as this plan orders it. `report` reads only
  records, so both hold.
- The `layout` command and expectation are written as Z1's task states them (checks `page-scroll`, `clipped`, `covered`,
  `target-size`; the answer in a page fence). No engine example uses `layout`, so the tests hold before Z1 merges.

**Needs coordinator.**
1. **Code vs plan.** `smoke heal` prints `staged: heal <id> (digest …)` and appends a `healed` event even when
   `stage()` answered `staged: false` (a digest the owner rejected): `-heal.mjs` ignores the `staged` flag that
   `smoke ci` and `smoke admit` read.
2. **Code vs spec §19.9.** No verb sets `smoke-state.json` `journeys.<id>.retire` ("an issue the owner closes as not
   planned marks the journey retire"), though `smoke plan` and `smoke propose` read it; and nothing turns a closed heal
   proposal into a needs-owner regression issue (the rejected heal is only skipped). smoke.md promises neither.
3. **Spec §19.9, §19.11 and lane D's note** name the labels `ux or a11y` and `perf`; argus's label list has `ux` and
   `performance` only. Z4 aligns the spec (or argus's list).
4. **Z1.** If its `layout` checks or answer differ from the above, ui-explorer.md's layout sentence follows.
5. **Z3.** The docs gain `/sapu:journey seed --issue|--doc` beside `/sapu:journey smoke`.

### Lane Z3 — docs and diagrams

**Built.** README, `docs/usage.md`, `docs/security.md`, `docs/agents.md`, `docs/contributing.md` and three diagrams.
- **Usage** gains the `/journey smoke` row, init's opt-in bullet, a requirements bullet, a `### The smoke suite` section
  (what you get, before you start, set-up, the CI workflow's jobs and safety properties, the commands with `smoke ci`'s
  finding lines, baselines and their update rules, self-healing and its decision table, flaky and quarantine policy, the
  checks by project, performance, seeds and their trust rules, the report, the files, limits), an `Upgrading from a version
  before 2.10.0` section, and one Common problems row for each `refused:` family the verbs can print (`smoke`'s trace gate,
  `smoke.json`, plan, admit, run, perf, heal, propose, workflow, ci, baseline, perf issue, seed, source, report, the state
  file, path mode, the new `live.json` keys, `failed: codegen:`, and `smoke check`'s findings).
- **Security** gains `## The smoke suite`: what reaches the repo and how, what runs in CI, sessions, traces and artifacts,
  outside text and fences as hygiene, healing, the guard, and the known limits.
- **Agents** gains `### /journey smoke` with the new diagram, and the `/journey` card names path capture, `seed` and `report`.
- **Contributing** names the new modules, the six browser-test files, the stub for `@playwright/test`, and what to do when
  `SMOKE_PLAYWRIGHT`, `SMOKE_AXE` or `CODEGEN_VERSION` moves.
- **Diagrams** (built with `node docs/img/src/build.mjs smoke journey journey-boundary`, both themes, rendered in Chrome
  and read for overlaps): `smoke` is new (the lane, the pull request, CI's jobs, what a break is, the baseline run, the
  hard limits; `a11y/smoke.json`); `journey` gains the path-for-the-smoke-suite card and `visit · report`;
  `journey-boundary` gains the smoke suite's two flows across the boundary and the "fences are hygiene" limit. The `alt`
  of each `<picture>` equals its `label`. Every other diagram rebuilds byte for byte.
- **Not written, because the code is not here yet:** the explorer's `pw <token> <role>.<k> layout` and the `layout`
  expectation of the `viewport-locale` oracle (Z1); the text of `/sapu:init`'s smoke questions, `skills/journey/smoke.md`
  and CONTRACT.md (Z2). The docs link to `skills/journey/smoke.md` for `smoke.json`'s format, as the plan says.

**Verified live.** `argus-live.mjs smoke check` (a repo with no suite: `smoke check: no suite (…)`, exit 0; a scratch repo
with a bad `.argus/smoke.json`: one `refused: smoke check: .argus/smoke.json: …` line listing every fault, exit 1), and
`smoke plan|workflow|ci|run|baseline|perf|admit|heal`, `seed` and `report` against a repo with no cycle, catalog or
suite, each answering the refusal the docs quote (`smoke propose --dry-run` answers `smoke propose: nothing to propose`). A sample `smoke.json` passes `validateSmoke`.
`tests/engine.test.ts` and `node scripts/rule-guard.ts` are green. No full suite (Z4).

**Needs coordinator.**
1. **Version heading.** Plan decision 17: `plugin.json` still says 2.9.0 and `git ls-remote --tags` shows no `v2.9.0`, so
   phase 6 may ride in 2.9.0. I wrote the notes under `Upgrading from a version before 2.10.0` (and the README link to it).
   If Z4 keeps 2.9.0, fold those bullets into the existing `before 2.9.0` section and fix the README anchor.
2. **Init's behaviour is taken from spec §19.2 and §19.10, not from Z2's text:** the smoke opt-in question, drafting
   `.argus/smoke.json`, the `!/.argus/smoke.json` exception, and writing the workflow only with consent in a pull request
   of its own (handing the file over without the `workflow` scope). Check `skills/init/SKILL.md` says the same.
3. **`skills/journey/smoke.md` and `live.md` must carry** what the docs point to: `smoke.json`'s keys, defaults and the
   example (the usage page's example passes `validateSmoke`), and the four new `live.json` keys.
4. **Spec §19.9's retire flow has no code writer.** `smoke plan` reads `journeys.<id>.retire === true`, but nothing sets
   it: a heal proposal closed becoming a needs-owner regression issue, and that issue closed as not planned retiring the
   journey, are the orchestrator's text (Z2) or a gap for lane 0's owner. The docs claim only what the code does: a closed
   proposal's digest is rejected and skipped by `smoke propose`, and `exclude` makes `smoke plan` print `excluded`.
5. **Spec §19 still says "not built yet"** in its title and status line, and open risk 8 still says "documented, not
   probed" (C3's probe answered it). Both are Z4's.
6. **`smoke check` validates `.argus/smoke.json`** before it looks for a suite, so it doubles as the format check; the docs
   say so, and `live.md`/`smoke.md` should too.
7. **Z1** must add the explorer's `layout` command and expectation before the docs can name them (spec §19.15); until then
   the upgrade note lists only `slot <n> --map --seed` and `pw <token> source` among the explorer's new commands.

### Lane Z1 — the exploratory layout oracle

Built in `-steps.mjs`, `-pw.mjs` and `-repro.mjs`; tests in `tests/argus-live-findings.test.ts` (the DSL, the template),
`tests/argus-live-pw.test.ts` (the verb, with the CLI shim) and `tests/argus-live-repro.test.ts` (both on a real Chrome and the
fixture app, whose header Account button is a real target-size violation).

- **`layout` expectation.** `{as, expect: "layout", check, target?, final?}`: `check` is one of `LAYOUT_KINDS` (`page-scroll`,
  `clipped`, `covered`, `target-size`). It holds when the check finds no violation, polled every 200 ms up to `settle_ms` as any
  expectation is; `page-scroll` takes no target (it names no element); a path holds none (the suite runs the oracle after every
  step, and the regression oracle's final kinds do not list it); a `system` step cannot be one. `FINAL_KINDS["viewport-locale"]`
  is `visible`, `enabled` or `layout`.
- **How it runs.** `stepCode` embeds `pageExpression("layout", {only: [check]})` as a JSON string (`P.expr`) and runs it with
  `page.evaluate`: the same function the generated suite runs, through the same `run-code` route. The page's answer is only
  compared with data (`P.check`, `P.skip`), never evaluated.
- **Target.** With a target, a violation counts when the name segment of its key (`<role>|<name>|<tag>`) equals the target's name
  (its ARIA snapshot's name, else its text; digit runs `#`, at most 60 characters) or the target's name contains it (a
  violation inside the target). A target the page lacks is `error` (the run answers `HARNESS: … could not be judged`, never
  REPRODUCED); several is `ambiguous`.
- **Answer.** A failed layout expectation observes `violations:<k>` (the repro runner's OBSERVED enum gains it) and shows the
  keys (at most 20); the fenced `expected` line names the check. The shown digest is over keys only, so two runs that find the
  same violations agree for `minimize`.
- **`pw <token> <role>.<k> layout [<check>]`.** Not a CLI command: the wrapper runs the oracle's expression through `d.code`
  (a `run-code` template of its own; the explorer picks only one of the four checks, refused by name otherwise) and prints, in
  the PAGE fence, `layout [<check>]: <n> violations` and one `<check> <key>: <detail>` line each (forty at most, the rest
  counted), `no violations`, or `unavailable (…ask again)` when the page changed under the call. It is counted, loop-ruled
  and observed like every other command; a gone browser reopens as for any command.
- **Allow and known rows.** The journey is the slot's (`slotRec.journey`): `journeys.<id>.allow` of `.argus/smoke.json` and the
  adopted `<smoke dir>/known/<id>.json` rows are left out, in `pw layout` and in the expectation alike (`layoutSkips`, exported
  by `-pw`, which `-repro` imports; `-repro` already reached `-pw` through `-instance`). An invalid `smoke.json` or known file is
  `failed: <file> is not valid …`, no text of it.
- **Deviations.** (1) The DAG test's list of what `-steps` may import gains `argus-live-layout` (a leaf; the DSL names the
  checks). (2) `-redtest.mjs` (not on Z1's list) refuses a layout expectation: `repro --test` would otherwise have written
  `expect(errors_<account>)`, the no-error branch's code, for it; a layout finding has no generated test. (3) No change in
  `-return.mjs`: a return's repro list is not parsed there.

**Needs coordinator.**
1. Z2: `agents/ui-explorer.md` documents `pw … layout [<check>]`, the `layout` expectation (`{check}`, optional `target`; the
   `page-scroll` check takes none) and the `viewport-locale` row's kinds (`visible`, `enabled` or `layout`); a layout finding's
   repro ends `{expect: "layout", check, final: "viewport-locale"}`, and `repro --test` has no RED test for it.
   Until Z2 changes the `viewport-locale` row of that brief's "The final step" table to name `layout` beside `visible` and
   `enabled`, `tests/engine.test.ts` ("the brief states each oracle's final as the runner checks it") is red by design: the
   test reads `FINAL_KINDS` and wants each kind in backticks in the row.
2. Z3: spec §19.15's sentence is as built; §19.1's table row "Responsive layout oracle" needs no change. Mention that a layout
   expectation is refused in a path, and that `pw layout` and the expectation leave out the journey's `allow` and known rows.

### Lane Z4 — the known issues, fixed before the phase-end review

Z2's and Z3's "Needs coordinator" items 1 to 5 (Z2) and 1, 4 and 5 (Z3) are settled here.

- **`smoke heal` and a rejected digest.** It reads `stage()`'s `staged` flag as `smoke admit` and `smoke ci` do: a heal whose
  digest the owner rejected prints `heal <id>: not staged (this change was rejected before; digest <12 hex>)` in place of
  `staged: heal …`, records no `healed` event, and exits 0, as admit does (the fence with the old and new targets still
  follows, for the regression issue).
- **The retire flow (spec §19.9). Decision: an owner command, `smoke retire <id>`, not a read of the issue's state.** The
  regression issue is the orchestrator's, filed through `scrub --create`, and nothing records its number against the journey:
  only its title would tie the two, and a title match is no proof of the owner's ruling. A command the guard already refuses
  to every subagent is smaller and exact, and it is the pattern `smoke perf --rebaseline` set (run only on the owner's word).
  - `refreshOutcomes` moved from -propose into -suite; `smoke plan` and `smoke ci` call it too (one `gh pr view` per open
    proposal, none when there is none). A closed heal marks the journey `journeys.<id>.regression = {url, run}` (the run its
    `argus/smoke-<run>` branch names); a closed retire clears `journeys.<id>.retire`.
  - `settleRegressions(main, state, {dir, members})` (-suite; smoke plan and smoke ci): a marked suite member is pending —
    smoke plan's journey line `pending-regression <id> <url>` (after `pending`, before `quarantined`, `heal` and `keep`), a line
    of its own in smoke ci — and a quarantine is staged for it, `{id, issue: null, since: <the mark's run>}` (so its digest is
    stable), unless quarantine.json holds it or it is staged or proposed already: `quarantine <id>: staged until the owner
    decides (digest <12 hex>)`, or `… not staged (rejected before; …)`. A last pass that holds the journey clears the mark and
    drops that staged quarantine (the quarantine lifecycle ends a merged one after three clean cycles, or proposes its drop
    after five, as for a flake). A journey no longer in the suite loses `retire` and its mark, so a merged retire lists it
    `capture` and a re-admitted path is `keep`, never `drop (retired)` again.
  - `smoke retire <id>` (-suite, the CLI's `smoke retire <id>`, behind the trace gate): refused for a journey the suite lacks
    (`refused: smoke retire: the suite has no path <id>`), a bad id, or no lane run (`… no lane run names the change (run a
    journey cycle first)`). It stages a `retire` named after the newest run, in place of every other change staged for the
    journey, and sets `retire: true` (the mark goes): `retire <id>: staged (digest …); smoke propose removes it from the
    suite, then smoke plan lists it capture`. A digest the owner rejected: `retire <id>: not staged (this change was rejected
    before; …)`, nothing written. Exit 0 both ways.
  - `smoke propose` checks only add and heal entries' runs' ledgers (their paths carry page values); every other kind falls
    back to the branch's run, as smoke ci's entries did. A retire named after a run a later `up` dropped would otherwise
    refuse for ever.
  - smoke.md (budget 12,800 → 13,600): step 1 names `pending-regression` and the `quarantine` line; Filing files it once, the
    title holding `smoke-regression:<id>`, with `bug`, `regression`, the needs-owner label, S2 on a money journey else S3;
    "Retire" runs `live smoke retire <id>` only on the owner's word; Breaks gains the closed heal's row.
  - Tests: tests/argus-live-suite.test.ts (plan, the fix, retire and its refusals, a closed retire, propose of a retire with no
    ledger), tests/argus-live-ci.test.ts (smoke ci's line), tests/argus-live-smoke.test.ts (dispatch, usage, trace gate,
    malformed lines), tests/sapu-guard.test.ts (refused to a subagent), tests/engine.test.ts (smoke.md's words).
- **Labels.** Spec §19.9 and §19.11, and lane D's note above, use argus's labels: `ux` (S3) for a check's issue, `performance`
  for a perf issue. No code named `perf` or `a11y` as a label; `a11y` stays a Playwright project name.
- **Spec §19** is headed "(built)", status "built (version 2.10.0)"; nothing in it was cut, so no item keeps a "not built"
  marker. The overview and the phase file table no longer say "not built yet", and `-baseline.mjs` joins the module list.
  Open risk 8 is answered (C3.2's probe).
- **Docs.** usage.md's day-to-day table gains `/journey seed --issue <n>` and `/journey seed --doc <file>:<a>-<b>`, and
  agents.md's /journey card names both; usage.md, agents.md, security.md and CONTRACT.md name the closed-heal flow and `smoke
  retire`. `live.md` is unchanged (still at its 14,500 budget).
- **Version 2.10.0** (decision 17): plugin.json and the two workflow metas, as the 2.9.0 commit did; the upgrade notes were
  already under "before 2.10.0", and the roadmap names both releases. Phase 6 ships as a pull request of its own on top of the
  held 2.9.0 one.

### Review fixes — the phase-end review (architect, writer, QA)

Every item below has a test that failed first; one commit per item or small group.

**Decisions, in the reviews' order.**
- **B1, traces.** A spec whose path holds a `login` step gets `test.use({ trace: "off" })` (a trace keeps each typed
  value and CI uploads it); the config sets `video: "off"` and `screenshot: "off"` for every project, and a failed
  `toHaveScreenshot` shows a password field as the browser masks it. docs/security.md says so.
- **M1(a), baseline grep.** The job checks `GREP` with a POSIX `case` (no empty id, no leading `-` or `|`, no `||`)
  plus the old character check, which together equal `^[a-z0-9][a-z0-9-]*(\|[a-z0-9][a-z0-9-]*)*$` under `sh`, and runs
  `--grep "(^| )($GREP)( |\$)"`. Codegen refuses a journey named as a project (`setup` and the PROJECT shapes). Each
  dispatch is recorded in smoke-state `dispatches` (`{ciRun, from, branch, mode, ids}`; `ciRun` null when gh printed no
  run URL, then it counts for its branch). Adoption compares each file with the branch at the run's head: an unchanged
  file is left out, a new one adopted, a changed one only for an id the run was dispatched with in `changed` mode.
- **M1(b), known rows.** New rows only with `--known`, and then always as an `argus/baselines-<run>` pull request whose
  body lists each new row (`+ <file> {"check","key"}` in a code block), even on an `argus/` branch: a direct commit has no
  body to list them in. Without the flag: `known: <n> new violation row(s) of <id> not adopted (…)`.
- **M3, heal.** `action-failed` is refused by `smoke heal`; `smoke run --slot` writes it as a regression candidate whose
  final is `enabled` on the step's target (a step in a parallel group, or without a target, is not written). Heal answers
  `target-missing` and `target-ambiguous` only (the old locator, two of two, no longer finds one control). A heal to a
  target of another role is refused when both name a role; a target found by role where the old one was not (or the
  reverse) is flagged `role changed`, different names `name changed`: a `needs owner` line, a body line, the staged entry's
  `needsOwner`, and the needs-owner label on the pull request (`--label` on create, `--add-label` on edit). `smoke plan`
  lists an `expect-failed` or `action-failed` last pass as `regression-candidate <id> step <n> <kind>` (QA m2).
- **M4, quarantine.** `smoke ci` with no `--run` reads `?status=completed&event=push&branch=<base>`. Lifecycle counts only
  on a base push, once per lane cycle and once per CI run (`ciRuns`); no lane pass of the path or no quarantine-job result
  of its projects is "not counted" and keeps the streak (quarantineCycle answers `counted: false`). The workflow's
  quarantine job is the test job's matrix: the workflow is written once, so it cannot follow quarantine.json; instead
  quarantine.json entries carry `projects` (the flake's) and the lifecycle reads only those projects' results (every
  project for an entry that names none, or only `msedge`). The quarantine digest is `{id}` only (QA M2), and a base flake
  is `{run, at}`, kept 30 days (a bare id from before is dated at its first read). An exit's `quarantine: null` and
  `exits + 1` happen when refreshOutcomes sees it merged (QA m7); smoke ci asks for outcomes before it judges flakes.
  Found on the way: smoke propose dropped a quarantine's `projects` when it wrote quarantine.json.
- **M5, admission.** Fresh at live.json's first viewport, then on the same instance at each further width the suite runs
  it at, then one pass over the suite's other paths in the recorded seed's order (their breaks are smoke run's to judge;
  a harness failure stops the admission), then dirty at the first width. `journeys.<id>.viewports` leaves further widths
  out (a `testIgnore` on those `chromium-<w>` projects); the first width, every engine's, always runs.
- **M6, M7, workflow.** Refused without `ci.web_server` or a suite path. The `hashFiles('<dir>/package.json') != ''` guard
  is on every step after the checkout, not on the job: a job-level `if` has no workspace to hash. Secrets only in the
  env of the step that runs `npx playwright test`; `npm ci --ignore-scripts`. The image is pinned by the digest an HTTPS
  `curl -sSfI` of `mcr.microsoft.com/v2/playwright/manifests/<tag>` answers (probed live: anonymous, `Docker-Content-
  Digest`), as `<name>:<tag>@sha256:…`; when it cannot be resolved the tag stays and a comment line says why.
- **M8.** No code: docs/usage.md says the suite is advisory CI (and why a required check could deadlock), and the
  follow-up is listed under "Out of scope".
- **Minors.** One reader per shared file: quarantine.json `readQuarantine`/`quarantineAt` in -smoke (its writer,
  smoke propose, sits above -smoke, which cannot import it, so the reader lives in the lowest module every reader shares
  and propose writes what it reads), pass.jsonl `readPass` in -smoke (its writer), known/<id>.json `readKnown` and
  `knownText` in -smokecfg (below -pw, the lowest reader), triage.json `readTriage`/`writeTriage` in the new -artifacts.
  triage.json gains `version: 1` and `findings[]`, which smoke baseline reads (an older file's findings are parsed from its
  lines in the reader); the report shares the CI branch shape. perf.json is `{version: 1, journeys}` (the flat file still
  reads). Perf: the baseline is two batches, its `max` the slowest run; a regression needs both thresholds and more than
  `max` (the architect's first option; p75 + k·MAD not built); `perf.runs` at least 3; a new `perf.max_load` (default 0.5
  of each core) refuses `smoke run --perf` on a busy machine — an owner knob rather than a fixed constant, so a machine
  that always runs other work (and the fixture test, through the CLI) can opt in knowingly; a Chrome-only change prints
  the new baseline against the old one. `smoke baseline` adopt and `smoke propose` check text with no run's values against
  the newest run that keeps a ledger (`newestLedgerRun`), never a map run's (QA m1). -smokecfg holds smoke.json's schema
  (-config 747 → 609 lines); -artifacts holds CI's runs and artifacts (-ci 635 → 376; -baseline no longer imports -ci).
  CI is optional: without `.github/workflows/<ci.workflow>` in the checkout, `smoke ci` and `smoke baseline` answer `no CI
  wiring (…): skipped`, exit 0.
- **Writer M1 and QA's blocker.** `suiteIdsAt` reads `git ls-tree <head>:<dir>/journeys`, fetching the run's branch, then
  its sha, when the clone lacks the head; when no fetch brings it the working tree's ids are used with a `note:` line.
  The early "no paths" refusal (before any gh call) now waits while a proposal is open. QA's scenario is the test.
- **Writer M2.** /sapu Phase A's `OWNER-ONLY` class: a pull request whose head branch starts with `argus/` (read from the
  pr-trust file) is never reviewed, fixed, merged or closed, and is listed in the report.
- **QA M1.** A staged drop or retire supersedes the journey's heal, quarantine and unquarantine: stageInto removes them
  when the drop comes later, smoke propose skips one staged after it (`skip heal <id>: superseded by the staged drop`).
- **QA M3, m6.** The suite's hooks substitute `${NAME}` from `process.env` when they run, in one pass with the `{k}`
  values; `{port:<name>=<n>}` takes `ci.ports`' port, else `n`; a failed hook throws `argus-smoke: <hook> exited <code>`,
  no stderr; a `login_url` that is no URL is `failed: codegen: login_url … is not a URL or a path`. live.json's `env`
  block is not reproduced in CI (decided: the step's environment and `ci.web_server` are the owner's).
- **QA m3.** A form case counts only the form's own request (to its `action` when it names one, else a body carrying a
  field name, issued after the click); a form rendered anew, or a page gone, with no such request is a `manual`
  `form-accepts-invalid` that ends the cases, never `hard`.
- **QA m5.** `dir` is `[A-Za-z0-9._/-]`, never under `.git`, `.github` or `.argus`; a mask is a role, text, label or
  test-id locator (a container's too), never `locator(…)`, a title or XPath.
- **QA test.** The journey-app cycle's `settle_ms` (repro 3000 → 6000, else 5000 → 8000) and `live_health_timeout_s` (20 →
  90) were short for a loaded machine; the tests' own timeouts were already generous.

**Engine-text budgets.**

| File | Bytes | Budget |
|---|---|---|
| `skills/journey/smoke.md` | 15,137 | 15,150 (was 13,600) |
| `skills/sapu/SKILL.md` | 40,603 | 40,610 (was 40,336) |
| `skills/argus/journeys.md` | 12,791 | 12,800 (unchanged) |
| `agents/ui-explorer.md` | 19,088 | 19,200 (unchanged) |

**Left over.**
- `sapu-merge.sh` does not refuse an `argus/` branch in code: the rule is the skill's (Phase A), as M8's gate is a
  follow-up.
- An `action-failed` candidate ends in `enabled`: a control covered by another element stays enabled, so its replay
  does not reproduce and nothing is filed; the path stays broken and `smoke plan` keeps listing it.
- A quarantine digest the owner rejected before these fixes no longer matches (the digest is now the journey's alone):
  that quarantine may be proposed once more.
- The full suite was not run here (the coordinator runs it).
