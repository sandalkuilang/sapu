# Argus journey lane — Phase 6: the smoke suite and its checks — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task names its model (`Model:`); reviewers are always Opus.

**Goal:** the lane leaves a regression net behind it. The catalog's critical journeys become a lean,
generated Playwright suite committed in the consumer repo and run by its CI on every pull request —
Chromium, Firefox, WebKit and Edge when installed, every viewport, with screenshot and ARIA baselines,
a responsive layout oracle, locale and accessibility checks, form, link and dynamic-state checks — and
the lane keeps it healthy: it admits paths only after two runs, proposes every change as a pull
request the owner merges or closes, tells a UI change from a bug by re-running unchanged expectations,
quarantines flakes, measures performance against per-journey baselines, seeds journeys from trusted
issues and docs, and writes one report per cycle.

**Architecture:** spec §19 is the design (read it first; every rule below points into it). One data
format (the repro DSL in *path* mode), one generator (`argus-live-codegen.mjs`, grown from
`argus-live-redtest.mjs`'s body builder), one source per in-page check (two leaf modules, embedded
verbatim in the suite and run by the lane through `run-code`). The exploratory lane is unchanged but
for three additions (paths in returns, heal mode, `pw layout`/`source`). Zero sapu runtime
dependencies: the suite's only dependency is `@playwright/test` at an exact version, in its own
`package.json`.

**Tech stack:** Node ≥ 22.18 ESM, vitest, the pinned `@playwright/cli` 0.1.22 install (its
`playwright` 1.64 alpha package carries the test runner the browser tests drive), `gh`, `git`.

Spec: [docs/specs/argus-journey-lane.md §19](../specs/argus-journey-lane.md#19-phase-6--the-smoke-suite-and-its-checks-not-built-yet);
§3 (narrowed non-goals), §10 (the DSL), §11 (guard). Roadmap: row 6, [argus-journey-lane-roadmap.md](argus-journey-lane-roadmap.md).

**Precondition.** Phase 5 as built (`feat/argus-p6` from the 2.9.0 release branch, this plan written at
2225fcb). Rebase onto the release branch once its Linux CI fixes land, before lane 0 starts. The
plugin-text rules of phase 5's plan apply unchanged (English, no date, no three- or four-digit `#`
reference, no home path, no consumer name, no run history, no machine-tuned number in prose); every
commit carries the branch's `Signed-off-by` trailer and no assistant attribution; a commit touching
an enforcement file carries a `Rule-Change:` trailer.

---

## Verified at 2225fcb

| Fact | Where |
|---|---|
| The pinned install holds `@playwright/cli` 0.1.22, `playwright` and `playwright-core` `1.64.0-alpha-1790635538000`; npm's `latest` for `@playwright/test` is `1.64.0` | `scripts/pw/package-lock.json`, `npm view` |
| `parseRepro` requires a last step with `final` naming an oracle; `FINAL_KINDS` keys are exactly `ORACLES` | `argus-live-steps.mjs` |
| `redTest` builds every string through `str()` (JSON literal or placeholder variable) and targets through `targetCode`; its helpers are stubs that throw | `argus-live-redtest.mjs` |
| `argus-live-repro.mjs` is 747 lines; the DAG test caps only `-instance.mjs` (< 700) and pins `-redtest`'s imports to `-return`, `-targets` | `tests/argus-live-findings.test.ts` "the DAG" |
| Module names must match `^argus-live(-[a-z]+)?\.mjs$` to be in the DAG graph | same |
| The guard lets a subagent run only `status`, `status --json`, `check` of `argus-live.mjs`; the explorer only `pw` | `sapu-guard.mjs` `LIVE_READS` |
| The wrapper's login code is built from constant templates and `live.json`'s parsed locators; TOTP is Node crypto | `argus-live-login.mjs` |
| `SIGNAL_SCRIPT` is installed in every page by the session hook | `argus-live-browser.mjs`, `-session.mjs` |
| `live.json` already has `viewports`, `locales`, `locale`, `timezone`; unknown keys are refused | `argus-live-config.mjs` `TOP_KEYS` |
| standards.md cites WCAG 2.2 1.4.3, 1.4.10, 1.4.11, 1.4.12, 2.4.7, 2.4.11, 2.5.5, 2.5.8, 3.2.4; not 2.1.1, 2.1.2, 2.4.3, 3.3.1, 4.1.2, 4.1.3 | `skills/argus/standards.md` |
| Playwright: tests are passed, flaky (failed, then passed on retry) or failed; no shuffle option is documented; ARIA snapshots match partially by default, `.aria.yml` files take `expect.toMatchAriaSnapshot.pathTemplate`, `-u` updates; screenshots differ per platform | playwright.dev (test-retries, aria-snapshots, test-snapshots) |
| WCAG 2.4.3 requires an order that "preserves meaning and operability", not visual order; F44 is the positive-tabindex failure | w3.org Understanding Focus Order |

---

## Decisions (one each; alternatives rejected)

1. **The suite is generated from paths, not map steps.** A map step is a goal, not an action; only an
   LLM could turn it into code, and no LLM runs at test time. *Rejected:* codegen from map steps.
2. **Paths come from explorers that reached the goal** (`path` in the return, charter `path: wanted`),
   admitted only after two runs, fresh then dirty. *Rejected:* recording the explorer's trail (free
   text, not the DSL).
3. **Suite location:** `e2e/argus-smoke/` by default (`smoke.json` `dir`), self-contained with its own
   `package.json`, so a repo in any language runs it. *Rejected:* the repo's root `package.json` (none
   in non-Node repos; touches the app's lockfile).
4. **`@playwright/test` pinned exactly** to `SMOKE_PLAYWRIGHT` = `1.64.0` (stable), with a test that its
   major.minor equals the pinned lockfile's `playwright-core`; bumping the CLI fails that test until the
   constant moves, and `smoke plan` then lists the suite's upgrade. Lockfile committed (`npm install
   --package-lock-only --ignore-scripts`). *Rejected:* the CLI's alpha build in a consumer repo.
5. **Every suite change is a pull request** on an `argus/` branch, never merged by sapu; merged =
   accepted, closed = rejected and remembered. *Rejected:* filing an issue for a sapu worker to apply
   (workers may not run lane verbs, and sapu would merge it itself); local patches (no review trail).
6. **UI change vs bug is decided by re-running unchanged expectations** (spec §19.9). A heal changes
   only action targets, at most `heal_max_steps`; it can never add, drop or reorder a step. *Rejected:*
   letting the explorer judge; healing expectations.
7. **Visual, ARIA and known-violation baselines are adopted from CI's artifact** (`smoke baseline
   --from-run`), committed, so per branch. *Rejected:* lane-made baselines (wrong platform for
   screenshots; one adoption path is simpler than two); an external baseline store (no review trail).
8. **Cross-browser lives only in the suite.** The exploratory lane stays on Chrome: its isolation
   (proxy, in-daemon hook, signal script) is proven on the pinned CLI's Chrome; Firefox and WebKit would
   be downloads at `up`; explorer cost would multiply for workflow defects that are browser-independent;
   perf APIs are Chromium-complete.
9. **Performance is measured by the lane, not by CI**, on suite paths, median of `perf.runs` after a
   warm-up, confirmed by a second batch. *Rejected:* a CI perf gate (noisy shared runners, no baseline
   store); explorer walks (not repeatable).
10. **axe-core is not used** (spec §19.7). *Rejected:* `@axe-core/playwright` as a suite dev dependency —
    whole-page rules fail CI on debt the journeys never touch and need a second suppression baseline.
    Revisit when the owner wants a conformance audit rather than journey checks.
11. **Hybrid setup:** one `setup` project signs every account in through the real UI with the
    wrapper's own login template, storageState gitignored and 0600; seeds through `seed: true`
    triggers. *Rejected:* an owner-wired `signedIn` stub for every role (kept only for `login.command`
    roles).
12. **Workers:** `fullyParallel: true`, Playwright's default worker count; storageState reuse means no
    sign-in races. Order independence is proven by admission's dirty run and the lane's seeded random
    order (the runner has no shuffle).
13. **Flakes are quarantined** (`quarantine.json` in the suite, `test.fixme`, one tracking issue),
    leave after three clean lane cycles, and are dropped after a second quarantine or five cycles.
14. **The API-level RED hint ships in phase 6** (one line from `repro --test` when the final is
    `fact-equals` or `mail`); generating API tests is a follow-up.
15. **A smoke suite needs the contract's home `repo` and `traces: "visible"`**; office mode gets none.
16. **The CI workflow is written by `/sapu:init`, only with consent**, from `smoke workflow`; without a
    `workflow` token scope init hands the file over.
17. **Version 2.10.0** at the end (new behaviour, new `live.json` keys an older plugin refuses), unless
    2.9.0 is still untagged when this phase closes, in which case phase 6 rides in 2.9.0 and the
    upgrade note grows (Task Z4 decides from `git ls-remote --tags`).

---

## Lanes, models, merge order

Lane 0 is sequential and lands first: it owns every shared hotspot (the config schema, the CLI
dispatch, the guard, CONTRACT.md, the DAG test, the DSL, the runner, the generator). After it, lanes
A–F run in parallel worktrees, each owning disjoint files. Lane Z is sequential and last. The spec is
not edited by any lane; Z4 folds the as-built notes.

**Rules for parallel lanes.** A lane edits only the files its table lists. A lane implements the
function bodies lane 0 stubbed, with the signatures below, and never edits `argus-live.mjs`,
`argus-live-config.mjs`, `sapu-guard.mjs`, CONTRACT.md, the DAG test or the spec; a missing hook is
reported back to lane 0, not added. Each lane's tests live in its own test file. Engine text (agent
file, skills, init, docs) waits for lane Z.

| Lane | Tasks | Owns | Model mix | Estimate |
|---|---|---|---|---|
| 0 | 0.1 → 0.2 → 0.3 → 0.4 | `argus-live.mjs`, `-config.mjs`, `-steps.mjs`, `-classes.mjs`, `-return.mjs`, `-repro.mjs`, `-minimize.mjs`, `-smoke.mjs`, `-codegen.mjs`, `-redtest.mjs`, `sapu-guard.mjs`, CONTRACT.md, `tests/argus-live-findings.test.ts`, `tests/argus-live-smoke.test.ts`, `tests/sapu-guard.test.ts`, every new module's stub | opus-high (0.1 sonnet-medium) | 7 h |
| A | A1 → A2 → A3 → A4 | `-suite.mjs`, `-propose.mjs`, `tests/argus-live-suite.test.ts` | A1 sonnet-medium, A2–A4 opus-high | 5 h |
| B | B1 → B2 → B3 | `-heal.mjs`, `-ci.mjs`, `tests/argus-live-ci.test.ts`, `tests/fixtures/ci-artifact/` | opus-high | 6 h |
| C1 | C1.1 → C1.2 → C1.3 | `-layout.mjs`, `tests/argus-live-layout.test.ts`, `tests/fixtures/journey-app/pages/layout/` | sonnet-medium | 4 h |
| C2 | C2.1 → C2.2 → C2.3 → C2.4 | `-a11y.mjs`, `skills/argus/standards.md`, `tests/argus-live-a11y.test.ts`, `tests/fixtures/journey-app/pages/a11y/` | sonnet-medium | 5 h |
| C3 | C3.1 → C3.2 | `-codegen.mjs` (after lane 0), `tests/argus-live-codegen.test.ts` | sonnet-medium | 3 h |
| D | D1 | `-perf.mjs`, `-session.mjs`, `-smoke.mjs` (after lane 0), `tests/argus-live-perf.test.ts` | sonnet-medium | 3 h |
| E | E1 | `-seed.mjs`, `-pw.mjs`, `-slots.mjs`, `-map.mjs`, `tests/argus-live-seed.test.ts` | opus-high | 3 h |
| F | F1 → F2 | `-report.mjs`, `-scrub.mjs`, `-repro.mjs` (after lane 0), `tests/argus-live-report.test.ts` | F1 opus-high, F2 sonnet-medium | 2.5 h |
| Z | Z1 → Z2 → Z3 → Z4 | `-pw.mjs`/`-steps.mjs` runner kind (Z1), engine text, docs, diagrams, spec, roadmap, this plan | Z1, Z3 sonnet-medium; Z2 opus-high; Z4 review Opus | 7 h |

Merge order after lane 0: **A, C3, C1, C2, B, D, E, F**, each rebased on the one before and the whole
suite green before the next merges (A before B: heal proposals use A's propose; C3 before C1 and C2: the
check registry's emitters run inside C3's projects). Critical path ≈ lane 0 (7 h) + the longest lane
(B, 6 h) + merges (2 h) + Z (7 h) ≈ 22 h wall-clock, against ≈ 45 h serial.

**Signatures lane 0 fixes** (each returns `{code, lines}`; the CLI prints `lines`, exits `code`):
`smokePlan(main)`, `smokeAdmit(main, ref)`, `smokeCheck(main)` (`-suite.mjs`); `smokePropose(main,
{dryRun})`, `smokeWorkflow(main)` (`-propose.mjs`); `smokeRun(main, {ids, slot, perf, seed})`
(`-smoke.mjs`); `smokeHeal(main, ref)` (`-heal.mjs`); `smokeCi(main, {run})`, `smokeBaseline(main,
{fromRun, ids})` (`-ci.mjs`); `perfIssue(main, id)`, `perfRebaseline(main, id)` (`-perf.mjs`);
`seed(main, {issue, doc})` (`-seed.mjs`); `report(main, {run})` (`-report.mjs`). Check modules export
`CHECKS`: `[{name, project, when, source, emit(step, ctx) → string[]}]` (`-layout.mjs`, `-a11y.mjs`).

---

## File structure

| File | Responsibility |
|---|---|
| `scripts/argus-live-config.mjs` | `live.json` keys `test_id_attribute`, `pseudo_locales`, `tokens`, `triggers.*.seed`; `loadSmoke`, `validateSmoke`, `SMOKE_KEYS` (0.2) |
| `scripts/argus-live-steps.mjs` | path mode, selector order, `regression` oracle, `layout` expectation (0.2, 0.3) |
| `scripts/argus-live-classes.mjs` | the `regression` row (0.2) |
| `scripts/argus-live-return.mjs` | `path` and `heal` in a return (0.3) |
| `scripts/argus-live-minimize.mjs` | new: `minimize`, `redTestFile`, `savedValues` moved out of `-repro.mjs` (0.3) |
| `scripts/argus-live-repro.mjs` | `runOnce` path mode (0.3); the API-level hint (F2) |
| `scripts/argus-live-smoke.mjs` | new: `smokeRun` (0.3); `--perf` (D1) |
| `scripts/argus-live-codegen.mjs` | new: the suite generator (0.4); projects, visual, browsers (C3) |
| `scripts/argus-live-redtest.mjs` | its body builder moved to `-codegen.mjs`, `redTest` a thin caller (0.4) |
| `scripts/argus-live-suite.mjs` | new: plan, admit, check (A1–A3) |
| `scripts/argus-live-propose.mjs` | new: propose, workflow (A3, A4) |
| `scripts/argus-live-heal.mjs`, `-ci.mjs` | new: heal (B1); CI triage, quarantine, baselines (B2, B3) |
| `scripts/argus-live-layout.mjs`, `-a11y.mjs` | new leaves: check sources and emitters (C1, C2) |
| `scripts/argus-live-perf.mjs` | new: `PERF_SCRIPT`, medians, baselines, perf issue (D1) |
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
- [ ] Probe; write the outcomes. **Commit** `docs(sapu): phase 6 plan — the pinned runner's facts`.

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
- [ ] **Step 0 (pure move):** `minimize`, `redTestFile`, `savedValues` to `-minimize.mjs`; the existing
  repro tests pass unchanged. Commit `refactor(sapu): argus-live minimize moves beside the runner`.
- [ ] **Failing tests:** `parseRepro(list, {accounts, live, path: true})` takes a list ending in an
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
- [ ] **Run** → FAIL. **Implement.** **Run**, then `npx vitest run` → PASS.
- [ ] **Commit** `feat(sapu): argus-live paths — the DSL's path mode, the runner's PATH verdicts, the
  lane's smoke pass`.

### Task 0.4: the generator core
**Model: opus-high** (codegen of page-derived strings, storageState). **Files:** `-codegen.mjs` (new),
`-redtest.mjs`, `tests/argus-live-codegen.test.ts`, `tests/fixtures/argus-red/` (golden unchanged).
- [ ] **Failing tests** (each scans the generated text): the golden RED test is byte-identical through
  the moved builder; `smokeSpec` for the fixture path holds no `waitForTimeout`, `setTimeout`, `sleep`,
  template literal of path data, CSS selector, XPath, `describe.serial`, `beforeAll`, `afterAll` or
  module-level `let`; the marker is declared inside the test; every step is a `test.step("step <n> …")`;
  every string of the path appears only as a JSON literal (a path value holding `` ` ``, `${`, `"` and
  `\n` comes out inert); `smokeConfig` sets `fullyParallel: true`, `retries` 1 under CI, a loopback guard
  that throws on `http://example.test`, `testIdAttribute` only with `test_id_attribute`; `authSetup`
  embeds the wrapper's login template verbatim, writes `.auth/<role>.<k>.json` and chmods it 0600, reads
  passwords and TOTP secrets by their `${NAME}` names from `process.env` and never holds a value;
  `support.ts` runs triggers by argv without a shell and checks values against `args`; the suite's
  `.gitignore` lists `.auth/`; `package.json` pins `@playwright/test` exactly to `SMOKE_PLAYWRIGHT`, whose
  major.minor equals the pinned lockfile's `playwright-core`; generation is a pure function (same input,
  same bytes) and every file's header digest matches its body. Browser test: the generated suite for
  the fixture app, run by the pinned runner with a wrapper config (`channel: "chrome"`, `--project setup
  --project chromium`), passes.
- [ ] **Run** → FAIL. **Implement** (the `CHECKS` registry loop is in place, empty until C1, C2).
  **Run**, then `npx vitest run` → PASS.
- [ ] **Commit** `feat(sapu): argus-live codegen — the smoke suite generated from paths, setup project
  and support, the RED test through the same builder`.

---

## Lane A — suite lifecycle

### A1: `smoke plan`
**Model: sonnet-medium.** - [ ] **Failing tests:** the rank of §19.3 on a fixture catalog (pin > money >
exposure > filed > roles > id), members before non-members of a tier, `global` and dropped skipped,
`exclude` and `max`, each output line kind, a pinned global refused, home `local` or `traces: "none"`
refused, `pending` from an open `argus/` PR (gh stub). - [ ] Run → FAIL; implement; run → PASS.
- [ ] **Commit** `feat(sapu): argus-live smoke plan ranks the catalog into the suite's members`.

### A2: `smoke admit`
**Model: opus-high.** - [ ] **Failing tests:** a return's path runs twice (fresh, dirty; `up --fresh` stub
counted once) and is staged with `{run, head, pathSha, seed}`; a break in either run refuses with
`<run> <kind> at step <n>`; a journey `smoke plan` does not list `capture` is refused; a path whose
values hold a ledger secret is refused by name and position, never value. - [ ] Run → FAIL; implement;
run → PASS. - [ ] **Commit** `feat(sapu): argus-live smoke admit stages a path that held fresh and dirty`.

### A3: `smoke propose`, `smoke check`
**Model: opus-high.** - [ ] **Failing tests:** propose (git and gh stubs) builds a worktree from
`origin/<base>`, writes staged paths, regenerated files, `changes.jsonl` lines, lockfile (npm stub),
commits with the contract's `gitEmail` and `Signed-off-by`, pushes `argus/smoke-<runId>`, opens a PR
with `labels.agentFiled`; a file or body holding a ledger secret refuses before any push, naming
`file:line:col class`; a rejected digest is never proposed again; `--dry-run` prints the change list and
writes nothing; `smoke check` names a hand-edited spec, a stale header digest, a `live.json` drift, and
passes a clean suite; it writes nothing. - [ ] Run → FAIL; implement; run → PASS.
- [ ] **Commit** `feat(sapu): argus-live smoke propose opens the suite's changes as a pull request;
  smoke check finds hand edits`.

### A4: `smoke workflow`
**Model: opus-high** (CI secrets). - [ ] **Failing tests:** the YAML has `pull_request` and a base-branch
push, `permissions: contents: read`, the fork skip, `persist-credentials: false`, a matrix of the
config's projects with `setup`, the suite directory's `npm ci` and `playwright install --with-deps`, the
artifact upload of `test-results/` only (never `.auth/`), and passes exactly the `${NAME}` names
`live.json` uses as `secrets.<NAME>`; no value, no `pull_request_target`. - [ ] Run → FAIL; implement;
run → PASS. - [ ] **Commit** `feat(sapu): argus-live smoke workflow prints the CI job init writes`.

## Lane B — breaks, triage, baselines

### B1: `smoke heal` and the decision table
**Model: opus-high.** - [ ] **Failing tests:** a heal return replaces only the named steps' targets; the
healed path runs twice (fresh, dirty); held → staged heal with `git log -S` evidence (`no commit removed
it` when none); an expectation failing → a regression candidate at it; `heal: []` with `no-control` →
a regression candidate ending in `visible` on the old target; a heal touching an expectation, a value, an
action kind or more than `heal_max_steps` steps is refused; every §19.9 row has a test.
- [ ] Run → FAIL; implement; run → PASS. - [ ] **Commit** `feat(sapu): argus-live smoke heal proposes
  only what unchanged expectations prove`.

### B2: `smoke ci` and quarantine
**Model: opus-high.** - [ ] **Failing tests** (fixture artifacts): flaky → staged quarantine and its
fingerprint; failed in an action step → `ui-change? <id> step <n>`; in an expectation → `bug? <id> step
<n>`; only off Chromium → `browser-only <project>`; a check → `check <id> <check> <key>`; a screenshot →
`visual <id> <n>`; a run from a fork, a path outside the suite's names, a non-PNG `-actual.png` and an
oversized file are refused or skipped; no artifact text appears outside a fence; codegen writes
`test.fixme` for a quarantined id; three clean cycles stage the exit, a second quarantine or five cycles
stage `drop`. - [ ] Run → FAIL; implement; run → PASS. - [ ] **Commit** `feat(sapu): argus-live smoke
  ci triages the CI run and quarantines flakes`.

### B3: `smoke baseline`
**Model: opus-high.** - [ ] **Failing tests:** actual PNGs, ARIA files (pruned: digit runs to `\d+`, the
marker shape) and violations land at the suite's paths on a branch whose base is the run's branch;
nothing outside the defined names is copied. - [ ] Run → FAIL; implement; run → PASS.
- [ ] **Commit** `feat(sapu): argus-live smoke baseline adopts CI's screenshots, ARIA snapshots and known
  violations as a proposal`.

## Lane C1 — layout, locale, links, dynamic states

### C1.1: layout oracle
**Model: sonnet-medium.** Fixture pages, each with a violation and its excluded twin (wide table,
sr-only text, ellipsis with `title`, fixed header over a control, modal backdrop, inline link, native
checkbox, label-covered custom checkbox). - [ ] **Failing tests:** every positive is reported with a
stable key, every excluded twin is not (the false-positive set is the test); `emit` adds a soft check
after every step for the viewport projects. - [ ] Run → FAIL; implement; run → PASS.
- [ ] **Commit** `feat(sapu): argus-live layout oracle — page scroll, clipped text, covered controls,
  target size`.

### C1.2: locale and format checks
**Model: sonnet-medium.** - [ ] **Failing tests:** under `de-DE` `1,234.56` fails and `1.234,56` holds;
`13/02/2026`-shaped text under `en-US` fails on day order; ISO dates, inputs, `code` and `translate="no"`
are skipped; a page with `lang="en"` under `de-DE` is `not localized`; pseudo-locales run only page-scroll
and clipped; without `pseudo_locales` the line `pseudo-localization: not done (no pseudo-locale listed)`.
- [ ] Run → FAIL; implement; run → PASS. - [ ] **Commit** `feat(sapu): argus-live locale checks —
  overflow under each locale, number and date formats`.

### C1.3: links, CTA routes, loading, empty, toasts
**Model: sonnet-medium.** - [ ] **Failing tests:** a 404 and a 500 link fail, a 302 to sign-in holds,
another origin is never requested, `link_cap` holds; an unvisited map route fails; a stuck `aria-busy`
fails, a resolved one holds; an empty table without text fails, with an empty-state message holds; a
non-live fixed toast fails 4.1.3, a live toast over the next target fails, a dismissible one holds.
- [ ] Run → FAIL; implement; run → PASS. - [ ] **Commit** `feat(sapu): argus-live checks — links and CTA
  routes, loading, empty states, toasts`.

## Lane C2 — accessibility

### C2.1: keyboard pass and names
**Model: sonnet-medium.** - [ ] **Failing tests:** a `div` with a click handler is not in the tab order;
`tabindex="3"` fails order; an outline-less button fails focus visible; a sticky footer over the focused
control fails 2.4.11; `hover` and `dblclick` targets are skipped; 500 presses → undetermined; a nameless
icon button fails `toHaveAccessibleName`. - [ ] Run → FAIL; implement; run → PASS.
- [ ] **Commit** `feat(sapu): argus-live a11y — keyboard reach, order, visible focus, names`.

### C2.2: ARIA snapshots, modals
**Model: sonnet-medium.** - [ ] **Failing tests:** `emit` writes `toMatchAriaSnapshot` at screens with the
`__aria__` template; a dialog Escape-closes and returns focus; an `alertdialog` is exempt from Escape;
focus escaping a modal fails; two dialogs with different backdrop behaviour fail consistency.
- [ ] Run → FAIL; implement; run → PASS. - [ ] **Commit** `feat(sapu): argus-live a11y — ARIA snapshots
  and modal dialogs`.

### C2.3: contrast, tokens, forms
**Model: sonnet-medium.** - [ ] **Failing tests:** grey on white at 3.9:1 fails, 4.6:1 holds, large
text at 3.1:1 holds; a gradient background is `manual`; a disabled control is skipped; with a token
CSS file an off-token colour fails, without `tokens` the skip line; each form case from `required`,
`type=email`, `maxlength`, `minlength`, `pattern` is generated and none other; a form that posts and
gets 200 on a bad value fails; native validation holds; `novalidate` with `aria-invalid` and
`aria-describedby` holds; focus on an error-summary link to the field holds. - [ ] Run → FAIL;
implement; run → PASS. - [ ] **Commit** `feat(sapu): argus-live a11y — contrast, design tokens, form
  validation cases`.

### C2.4: standards citations
**Model: sonnet-medium.** Fetch, read and quote WCAG 2.2 Understanding pages for 2.1.1, 2.1.2, 2.4.3,
3.3.1, 4.1.2, 4.1.3 into standards.md's accessibility table (level as printed, the sentence quoted, the
page's URL), as phase 5 did; a page that does not load is marked ⚠, never quoted.
- [ ] **Failing test** (engine): each SC above appears with its Understanding URL. - [ ] Run → FAIL;
  edit; run → PASS. - [ ] **Commit** `docs(sapu): argus standards cite the WCAG criteria the smoke
  suite's checks measure`.

## Lane C3 — projects, browsers, visual

### C3.1: projects and browsers
**Model: sonnet-medium.** - [ ] **Failing tests:** projects `setup`, `chromium`, `firefox`, `webkit`,
`msedge` only when the executable exists (a filesystem seam; absent → the skip line, no project),
`chromium-<w>` per further viewport, `a11y`, `i18n` only with locales; every project depends on
`setup`; per-journey `browsers` honoured; a comment names WebKit as not Safari. - [ ] Run → FAIL;
implement; run → PASS. - [ ] **Commit** `feat(sapu): argus-live codegen — browser, viewport, a11y and
  i18n projects`.

### C3.2: screenshots
**Model: sonnet-medium.** - [ ] **Failing tests:** `toHaveScreenshot` at the path's screens with
`animations: "disabled"`, `caret: "hide"`, masks for `time`, the marker, every saved value and the
configured targets; `snapshotPathTemplate` per project and platform; `ignoreSnapshots` outside CI.
- [ ] Run → FAIL; implement; run → PASS. - [ ] **Commit** `feat(sapu): argus-live codegen — screenshot
  baselines with dynamic masks`.

## Lane D — performance

### D1: perf collection, baselines, regressions
**Model: sonnet-medium.** - [ ] **Failing tests:** `PERF_SCRIPT` on fixture pages reports LCP, CLS, INP,
requests and bytes; the session hook installs it beside the signal script; `smokeRun --perf` runs a
warm-up and `perf.runs` runs, medians recorded; the first batch is the baseline; a changed `pathSha` or
machine voids it; a regression needs both thresholds and a second batch; `perfIssue` prints the
baseline, both batches and `git log` over the anchor files; `perfRebaseline` moves it.
- [ ] Run → FAIL; implement; run → PASS. - [ ] **Commit** `feat(sapu): argus-live smoke run --perf —
  web vitals and request budgets against per-journey baselines`.

## Lane E — journeys from issues and docs

### E1: seeds
**Model: opus-high.** - [ ] **Failing tests:** `seed --issue` refused when `issue-trust` fails (gh stub);
`--doc` refused untracked or outside the repo; `seed.json` is 0600; `pw <token> source` exists only on a
`--seed` map token and fences the text with escaped marker shapes; a fenced instruction in the source
changes nothing the wrapper does; `map-check --merge` adds `seeds` to that slot's journeys only and a
returned `seeds` key is refused by `validateMap`; the catalog marks `seeded`. - [ ] Run → FAIL;
implement; run → PASS. - [ ] **Commit** `feat(sapu): argus-live seed — journeys from trusted issues and
  tracked docs, fenced, linked to their source`.

## Lane F — report, filed record, API hint

### F1: filed record and report
**Model: opus-high** (scrub). - [ ] **Failing tests:** `scrub --create` and `--comment` append `{ref, url,
kind}` to `<run>/filed.jsonl` after gh succeeds, never before; `report` writes `.argus/reports/<runId>.md`
0600 with every §19.13 section from fixture records; a ledger secret planted in a claim comes out as
`*** (<class>)`; links are defanged; it works after `down`. - [ ] Run → FAIL; implement; run → PASS.
- [ ] **Commit** `feat(sapu): argus-live report writes one scrubbed summary per cycle`.

### F2: the API-level hint
**Model: sonnet-medium.** - [ ] **Failing test:** `repro --test` prints the `api-level: suggested` line for
a `fact-equals` or `mail` final and not otherwise. - [ ] Run → FAIL; implement; run → PASS.
- [ ] **Commit** `feat(sapu): argus-live repro --test suggests an API-level RED test where the UI is not
  the observable`.

## Lane Z — integration (sequential, last)

### Z1: the exploratory layout oracle
**Model: sonnet-medium.** `layout` expectation in the runner, `pw <token> <role>.<k> layout [<check>]`
(answer fenced), `viewport-locale`'s final kinds gain `layout`. - [ ] Failing tests in the pw and repro
test files; run → FAIL; implement; run → PASS. - [ ] **Commit** `feat(sapu): the explorer's layout
  oracle`.

### Z2: engine text
**Model: opus-high** (heal and seed briefs read untrusted text). `ui-explorer.md`: paths (`path: wanted`,
selector order, seed triggers), heal mode (the path, the broken step, "never change an expectation",
`heal` return), the `layout` command, `pw source` in seed map mode; `journeys.md`: `path: wanted`, `smoke
admit`, `seed`, `report` at the end; new `skills/journey/smoke.md` (the smoke cycle: plan → up → run
`--perf` → ci → heal → admit → propose → baseline → report → down, the decision table's actions,
`smoke.json`'s format, the CI wiring); `/sapu:journey smoke`; `/sapu:init` (the smoke questions, the
workflow with consent, the gitignore exception); CONTRACT.md's text. - [ ] Failing engine tests: the
brief's example path passes `parseRepro(..., {path: true})`; its heal example passes `validateReturn`;
`smoke.md`'s `smoke.json` example passes `validateSmoke`; every command it names is in the usage line;
budgets for the changed files. - [ ] Run → FAIL; write; run → PASS. - [ ] **Commit** `feat(sapu): the
  smoke cycle's engine text`, trailer `Rule-Change: engine.test.ts pins the smoke cycle's text and budgets`.

### Z3: docs and diagrams
**Model: sonnet-medium.** README (`/sapu:journey smoke`), usage (requirements, the CI wiring, common
problems, the upgrade note), security ("The smoke suite": §19.16), agents; a `smoke.mjs` diagram (one
smoke cycle and the proposal loop) and `journey.mjs` gaining the path capture. `node docs/img/src/build.mjs
smoke journey`. - [ ] `npx vitest run tests/engine.test.ts` → PASS. - [ ] **Commit** `docs: the smoke
  suite — README, usage, security, agents, diagrams`.

### Z4: whole suite, review, as built
- [ ] `npx vitest run` and `npm run gate` → green.
- [ ] **Phase-end team review** on `git diff 2225fcb..HEAD`: `senior-dev-team:senior-qa-reviewer`
  (each task's tests against §19), `senior-dev-team:senior-software-architect` (the DAG, the decision
  table as built, the proposal loop, the security boundaries of §19.16), `senior-dev-team:senior-technical-writer`
  (docs, `smoke.md`, diagrams). Findings fixed, re-reviewed, green.
- [ ] Version per decision 17; fold the as-built notes into §19 (removing "not built yet" from what
  landed, keeping it on anything cut); roadmap row 6 links this plan; "As built (phase 6)" below.
  Commit `docs(sapu): argus journey lane — phase 6 as built`. No push, merge or tag: the owner holds
  every release.

---

## Out of scope, and covered elsewhere

Out: native mobile apps and real-device clouds; tests generated from Figma or other external design
services (the lane is loopback-only). Covered: intelligent prioritization is SELECT's score and the
smoke rank; parallel execution is Playwright's workers and CI's project matrix. Follow-up: generating
the API-level RED test the hint suggests.

## Open risks

1. **A heal that hides a regression** — a control moved somewhere the role still reaches with the same
   number of steps passes as a UI change. Mitigated by the owner's review with the `git log -S`
   evidence; a heal cannot add a step, so a control buried one level deeper is a bug.
2. **CI's app start and seed** are the owner's (`ci.web_server`, the users `live.json` names); a repo that
   cannot seed CI gets a red setup project, reported as harness, never a finding.
3. **Branch protection deadlock** — a sapu worker's PR that renames a control stays red on the suite
   until the heal proposal merges; the report names both PRs.
4. **Alpha vs stable Playwright** (the lane's 1.64 alpha, the suite's 1.64.0): same minor, pinned by test;
   a locator difference would show as a CI-only break.
5. **Check false positives** — every exclusion is a fixture twin; the known-violation adoption keeps day
   one green; a check that still misfires is the owner's `allow`, and Z4's review reads the fixture set.
6. **CI duration** — projects × journeys; the matrix runs projects in parallel jobs and `max` caps the
   journeys.

## As built (phase 6)

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
