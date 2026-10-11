# Argus journey lane — Phase 6 research: what proven tools and published guidance say

The evidence behind the phase 6 plan ([argus-journey-lane-6-smoke.md](argus-journey-lane-6-smoke.md))
and spec §19. Each source below was fetched and read in full (primary documents, not summaries). Each
row records the claim the plan uses, quoted briefly, and the decision it informs. The plan marks each
decision with the source ids in square brackets.

**Ranking of evidence.** A measured fact from Task 0.1's live probe of the pinned runner (the plan's
"As built (phase 6)", commit 6bf856d) outranks any document. Next comes the vendor's own document for
its own tool, then standards (W3C, OWASP), then practitioner writing. A claim that could not be read
at its source is listed under "Unverified", and the plan relies on none of them.

Playwright's documentation was read from its source tree on `main`
(https://github.com/microsoft/playwright/tree/main/docs/src). The release notes place each feature
the plan uses at or before 1.64, the version the suite pins.

---

## Playwright

| Id | Source | Claim used | Informs |
|---|---|---|---|
| pw-snap | Visual comparisons — https://playwright.dev/docs/test-snapshots | "Browser rendering can vary based on the host OS, version, settings, hardware … run tests in the same environment where the baseline screenshots were generated." The default name carries the browser and the platform (`…-chromium-darwin.png`). `threshold` defaults to `0.2`, and `maxDiffPixels` is unset. `stylePath` hides volatile elements. A hover effect is avoided with `page.mouse.move(-1, -1)`. Snapshot directories are committed and "review any changes to it". | D7, D18: baselines made only on the pinned CI image, Playwright's default tolerances, pointer parked before a shot. |
| pw-config | TestConfig — https://playwright.dev/docs/api/class-testconfig | `updateSnapshots`: `'missing'` creates missing snapshots, and tests that only create them pass. `'none'` updates nothing. `'default'` writes missing snapshots but fails the test, "so that the run does not silently pass in CI". The page also documents `forbidOnly` ("Useful on CI"), `failOnFlakyTests`, `ignoreSnapshots: !process.env.CI` and `globalTimeout`. `workers` defaults to "half of the number of logical CPU cores". `toHaveScreenshot` defaults to `animations: "disabled"` and `caret: "hide"`. The `toMatchAriaSnapshot.children` default is `contain`. `snapshotPathTemplate` tokens include `{platform}`, `{projectName}`, `{testFileBaseName}`, `{arg}` and `{ext}`. | §19.5 config rules, D7, D13. |
| pw-aria | ARIA snapshots — https://playwright.dev/docs/aria-snapshots | Partial matching: "a template containing the subset of children will be matched". `/children` takes `contain` (the default), `equal` or `deep-equal`. Names accept regexes (`- heading /Issues \d+/`). A `.aria.yml` file is written through the `name` option, and `-u` updates it. | C2.2: digits become regexes when a baseline is adopted, partial matching is kept. |
| pw-retries | Retries — https://playwright.dev/docs/test-retries | A test that fails, then passes on a retry, is "flaky". After a failure the runner discards the worker and its browser. | D13: `flaky` comes from the runner, never from sapu's guess. |
| pw-auth | Authentication — https://playwright.dev/docs/auth | The `.auth` directory goes in `.gitignore`, since "the browser state file may contain sensitive cookies and headers". Reusing one signed-in state is "recommended … for tests **without server-side state**". Tests that "modify server-side state" need "one account per parallel worker". Session storage is not saved. | D11, D12: a lock per account, storageState kept local. |
| pw-parallel | Parallelism — https://playwright.dev/docs/test-parallel | Test locks: "Tests that share a lock name never run concurrently, even when they are declared in different files or belong to different projects." Serial mode "is not recommended". Flakiness "comes from state that lives *outside* a single test". | D12. |
| pw-release | Release notes — https://playwright.dev/docs/release-notes | 1.64 adds `--shuffle [seed]`, which schedules tests in a random order "to find tests that accidentally depend on each other". From 1.64, `--update-snapshots=missing` passes, "so that CI can generate new snapshots and verify the existing ones in a single run". Test locks arrive in 1.63. | D7, D12, which correct the plan's earlier "the runner has no shuffle". |
| pw-cli | Command line — https://playwright.dev/docs/test-cli | `--shuffle [seed]`: "The seed is printed at the start of the run, pass it to reproduce the same order." | D12. |
| pw-ci | Continuous integration — https://playwright.dev/docs/ci | "We recommend setting workers to "1" in CI environments to prioritize stability and reproducibility." "Always set a global timeout in CI." A job container (`mcr.microsoft.com/playwright:v<version>-noble`) gives "a consistent environment for e.g. screenshots/visual regression testing". | D12, D16, D7. |
| pw-docker | Docker — https://playwright.dev/docs/docker | The image is "intended to be used for testing and development purposes only". It recommends `--ipc=host` for Chromium and `--init`. | D16: the CI job's container options. |
| pw-shard | Sharding — https://playwright.dev/docs/test-sharding | With `fullyParallel: true`, shards are balanced per test, which is "the preferred mode". | §19.5 `fullyParallel`, kept. |
| pw-browsers | Browsers — https://playwright.dev/docs/browsers | Branded Chrome and Edge are not installed by Playwright by default, and `install msedge` installs "at the default global location … overriding your current browser installation". Stable channels serve "regression testing … against the current publicly available browsers". Playwright's WebKit is "not … the branded version of Safari", and "for the closest-to-Safari experience you should run WebKit on mac". | D8: Edge only where present, never installed by sapu, no screenshot baseline. WebKit is labelled as not Safari. |
| pw-a11y | Accessibility testing — https://playwright.dev/docs/accessibility-testing | The page uses `@axe-core/playwright`. `withTags(['wcag2a','wcag2aa',…])` restricts a scan to WCAG rules. For known issues, take "a *fingerprint* of the violation(s)" rather than snapshotting the whole violations array. The disclaimer reads "many accessibility problems can only be discovered through manual testing". | D10 (reversed), C2.3. |
| pw-locators | Locators — https://playwright.dev/docs/locators | "We recommend prioritizing role locators." Use text locators "to find non interactive elements". `getByTestId`'s attribute is configurable through `testIdAttribute`. "CSS and XPath are not recommended as the DOM can often change." | §19.4 selector order, kept. |
| pw-best | Best practices — https://playwright.dev/docs/best-practices | Tests should be "completely isolated". Use web-first assertions. Soft assertions "compile and display a list of failed assertions once the test ended". | §19.5, §19.7, kept. |
| pw-agents | Test agents — https://playwright.dev/docs/test-agents | The healer "suggests a patch (e.g., locator update, wait adjustment, data fix)". It outputs "a passing test, or a skipped test if the healer believes that functionality is broken". | D6: a heal may change only targets. It never skips a test, changes data or adds a wait. |
| pw-use | Test use options — https://playwright.dev/docs/test-use-options | `trace` takes `'off'`, `'on'`, `'retain-on-failure'` or `'on-first-retry'`. | D11: the setup project records nothing. |
| probe | Task 0.1 as built (this plan, commit 6bf856d) | Measured on the pinned alpha and on stable 1.64.0. A missing screenshot under `"none"` fails and attaches no actual. A mismatch attaches expected, actual and diff. `--update-snapshots=missing` writes the baseline and passes. An ARIA mismatch gives only a line diff in the message, and a missing `.aria.yml` compares as `""`. `flaky` takes two results. The pinned install lacks `@playwright/test`, and a stub re-exporting `playwright/test` works. | D4, D7, Task 0.4, B3, C2.2, C3.2. |

## Visual review services

| Id | Source | Claim used | Informs |
|---|---|---|---|
| chromatic-branch | Branches and baselines — https://www.chromatic.com/docs/branching-and-baselines/ | "tests fail until the new visual and/or accessibility snapshots are accepted as baselines". "Baselines only update when changes are accepted." Each branch keeps its own baseline, which is "akin to storing a snapshot file in your repository with each accepted change". An outdated baseline yields "false positives", so merge or rebase from main regularly. | D7: committed per-branch baselines, the PR as the acceptance, a binary conflict regenerated rather than picked. |
| chromatic-review | UI Review — https://www.chromatic.com/docs/review/ | "Each UI Review is linked to a pull/merge request." UI Review "is where you discuss intentional changes". | D7: review happens in the PR. |
| percy-baseline | Understand the selected baseline — https://www.browserstack.com/docs/percy/visual-testing-workflows/baseline-management/understand-baseline | With approvals required, Percy "selects the most recent approved build as the baseline". With no approved build, "Percy cannot perform comparisons". | D7: a journey with no reviewed baseline has no visual check yet. Its first baseline arrives in a reviewed PR. |
| gh-images | Working with non-code files — https://docs.github.com/en/repositories/working-with-files/using-files/working-with-non-code-files | A PR compares images in "three different modes: 2-up, swipe, and onion skin". | D7: the owner reviews baselines in the PR's file view. No viewer is built. |

## Performance

| Id | Source | Claim used | Informs |
|---|---|---|---|
| webdev-vitals | Web Vitals — https://web.dev/articles/vitals | LCP "within 2.5 seconds", INP "of 200 milliseconds or less", CLS 0.1. Measure at "the 75th percentile of page loads". | D9: these thresholds are field targets. The report shows them as lab context only. |
| webdev-lcp | LCP — https://web.dev/articles/lcp | "The browser will stop reporting new entries as soon as the user interacts with the page." | D9: a perf run waits for `load` before its first action on a new document. |
| webdev-cls | CLS — https://web.dev/articles/cls | A session window has gaps under 1 s and lasts at most 5 s, and CLS is "the largest burst". Layout shifts "within 500 milliseconds of user input" carry `hadRecentInput` "so they can be excluded". | §19.11 `cls`. |
| webdev-inp | INP — https://web.dev/articles/inp | "the interaction with the worst latency is reported", with one ignored per 50 interactions. Observers skip entries under 104 ms by default, and `durationThreshold` has "a minimum value of 16 milliseconds". In the lab, INP depends "on what interactions are performed". | §19.11 `inp_ms`: the worst interaction, `durationThreshold: 16`. |
| webdev-labfield | Lab and field data — https://web.dev/articles/lab-and-field-data-differences | Lab values differ from field values for the same page. | D9: no web.dev threshold is ever a verdict. |
| webdev-budgets | Performance budgets 101 — https://web.dev/articles/performance-budgets-101 | Budgets cover quantity-based metrics ("page weight and the number of HTTP requests") and milestone timings. | §19.11 `requests`, `bytes`, kept. |
| lh-variability | Lighthouse variability — https://github.com/GoogleChrome/lighthouse/blob/main/docs/variability.md | "The median Lighthouse score of 5 runs is twice as stable as 1 run." "**DO NOT** collect multiple Lighthouse reports at the same time on the same machine." Use localhost, and use aggregates "like the median". | D9: median of 5, perf refused while another slot is live. |
| lhci-config | Lighthouse CI configuration — https://github.com/GoogleChrome/lighthouse-ci/blob/main/docs/configuration.md | `numberOfRuns` defaults to 3, and the pro setup uses 5. Assertions aggregate as `median-run`, `optimistic` or `pessimistic`. | D9: `perf.runs` 5, the median. |

## Flaky tests

| Id | Source | Claim used | Informs |
|---|---|---|---|
| google-flaky | Flaky Tests at Google and How We Mitigate Them — https://testing.googleblog.com/2016/05/flaky-tests-at-google-and-how-we.html | About 1.5% of runs are flaky, and "84% of the transitions … from pass to fail involve a flaky test". Marking a test flaky "encourages developers to ignore flakiness". Quarantine "removes the test from the critical path and files a bug" but "could easily mask a real race condition". | D13: quarantined tests keep running off the critical path, and a flake that first appears on a PR is not quarantined. |
| google-flaky-size | Where do our flaky tests come from? — https://testing.googleblog.com/2017/04/where-do-our-flaky-tests-come-from.html | 0.5% of small tests are flaky, 1.6% of medium tests and 14% of large tests. | D13: `max` stays small (every journey test is a large test). |
| google-tott-flaky | Test flakiness — one of the main challenges of automated testing — https://testing.googleblog.com/2020/12/test-flakiness-one-of-main-challenges.html | Listed causes include "Dependencies on the order in which the tests are run" and tests that "collide". "Hermetic environments … are less likely to be flaky." | D12: shuffle and locks. CI runs on a disposable runner. |

## Self-healing

| Id | Source | Claim used | Informs |
|---|---|---|---|
| healenium | How Healenium works — https://healenium.io/docs/how_healenium_works | On `NoSuchElement` Healenium "takes the locator with the highest score and performs an action with this locator". "Testing continues", and a report follows the run. | D6: sapu never heals at run time. A heal is a proposal, held only when the unchanged expectations pass. |
| healenium-disable | Disable Healing — https://healenium.io/docs/disable_healing | Healing can be turned off for a section of code. | D6: a step is never healed when its target is the path's proof (an expectation). |

## Accessibility

| Id | Source | Claim used | Informs |
|---|---|---|---|
| wcag22 | WCAG 2.2 — https://www.w3.org/TR/WCAG22/ | Normative text of 1.4.3 (4.5:1, 3:1 large, inactive components exempt), 1.4.10 (320 CSS px, two-dimensional exception), 1.4.11 (3:1 for UI component states), 2.1.1, 2.1.2, 2.4.3 ("an order that preserves meaning and operability"), 2.4.7, 2.4.11 ("not entirely hidden due to author-created content"), 2.5.8 (24 × 24, the 24 px circle spacing, and the equivalent, inline, user-agent and essential exceptions), 3.3.1, 4.1.2 and 4.1.3. | §19.7 checks. |
| u-1.4.3 | Understanding Contrast (Minimum) — https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html | Level AA. Large text is 18 pt, or 14 pt bold. | C2.3 (by axe). |
| u-1.4.10 | Understanding Reflow — https://www.w3.org/WAI/WCAG22/Understanding/reflow.html | Level AA. 320 CSS px equals 1280 px at 400 % zoom. | Layout *page-scroll*. |
| u-1.4.11 | Understanding Non-text Contrast — https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html | Level AA. "the visual focus indicator for a component must have sufficient contrast against the adjacent background", and an indicator partly inside a control may contrast with either side. | C2.1: the focus-indicator contrast is computed for a solid `outline` only. Every other indicator is `manual`. |
| u-2.1.1 | Understanding Keyboard — https://www.w3.org/WAI/WCAG22/Understanding/keyboard.html | Level A. | C2.1. |
| u-2.1.2 | Understanding No Keyboard Trap — https://www.w3.org/WAI/WCAG22/Understanding/no-keyboard-trap.html | Level A. | C2.2 modal trap rule. |
| u-2.4.3 | Understanding Focus Order — https://www.w3.org/WAI/WCAG22/Understanding/focus-order.html | Level A. The order must preserve meaning and operability, not match the visual order. C27 makes "the DOM order match the visual order". F44 is the failure of "using tabindex to create a tab order that does not preserve meaning and operability". | C2.1: a backward DOM jump is `manual`, not a failure. Whether meaning is preserved is a human judgement. |
| u-2.4.7 | Understanding Focus Visible — https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html | Level AA. | C2.1. |
| u-2.4.11 | Understanding Focus Not Obscured (Minimum) — https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html | Level AA. | C2.1. |
| u-2.5.8 | Understanding Target Size (Minimum) — https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html | Level AA. | Layout *target-size*. |
| u-3.3.1 | Understanding Error Identification — https://www.w3.org/WAI/WCAG22/Understanding/error-identification.html | Level A. | C2.3 forms. |
| u-4.1.2 | Understanding Name, Role, Value — https://www.w3.org/WAI/WCAG22/Understanding/name-role-value.html | Level A. | C2.1 names. |
| u-4.1.3 | Understanding Status Messages — https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html | Level AA. Status messages are presented "without receiving focus". The page warns against live regions that are "too chatty". | C1.3 toasts. |
| apg-dialog | Dialog (Modal) Pattern — https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/ | "Tab and Shift + Tab do not move focus outside the dialog." "Escape: Closes the dialog." Focus returns to the invoker "unless either: The invoking element no longer exists", or the workflow makes another element "a more logical choice". | C2.2. |
| apg-alertdialog | Alert and Message Dialogs Pattern — https://www.w3.org/WAI/ARIA/apg/patterns/alertdialog/ | Keyboard interaction: "See the keyboard interaction section for the modal dialog pattern." | C2.2: an `alertdialog` is no longer exempt from Escape. |
| apg-keyboard | Developing a Keyboard Interface — https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/ | In a radio group "only one of the radio buttons is included in the tab sequence", and arrow keys move inside a composite widget. | C2.1: a target inside a composite widget is reached through its widget's tab stop. |
| mdn-dialog | `<dialog>` — https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/dialog | A dialog opened by `showModal()` "can be dismissed by pressing the Esc key". A non-modal dialog "does not dismiss via the Esc key by default". | C2.2: the Escape and Tab rules apply to modal dialogs only. |
| axe-readme | axe-core — https://github.com/dequelabs/axe-core | "on average 57% of WCAG issues automatically". "It returns zero false positives (bugs notwithstanding)." Uncertain nodes are returned as "incomplete" for manual review. | D10 (reversed). |
| axe-api | axe-core API — https://github.com/dequelabs/axe-core/blob/develop/doc/API.md | Tags include `wcag2a`, `wcag2aa`, `wcag21aa` and `wcag22aa`. The `incomplete` array holds nodes that "could neither be determined to definitively pass or definitively fail". | C2.3: tags, and `incomplete` reported as `manual`. |
| axe-pw | `@axe-core/playwright` — https://github.com/dequelabs/axe-core-npm/blob/develop/packages/playwright/README.md | The package "uses the major and minor version … of axe-core". `include(selector)` limits the scan. | D4, D10: pinned exactly. |
| npm | npm registry — https://www.npmjs.com/package/@playwright/test · https://www.npmjs.com/package/@axe-core/playwright | `@playwright/test` `latest` is `1.64.0`. `@axe-core/playwright` `latest` is `4.13.0`, which depends on `axe-core ~4.13.0` and is licensed MPL-2.0. | D4. |

## Localization

| Id | Source | Claim used | Informs |
|---|---|---|---|
| android-pseudo | Test your app with pseudolocales — https://developer.android.com/guide/topics/resources/pseudolocales | English (XA) "adds Latin accents … expands the original text … and brackets each message unit". `ar-XB` reverses direction. "Hardcoded strings … display as unaccented." | C1.2: pseudo-locale codes, and the unchanged-text report. |
| ms-pseudo | Pseudolocalization — https://learn.microsoft.com/en-us/globalization/methodology/pseudolocalization | "lengthen the text by 40%". Delimiters reveal truncation and concatenation. | C1.2: *clipped* under a pseudo-locale. |
| mozilla-pseudo | Fluent for Firefox developers — https://firefox-source-docs.mozilla.org/l10n/fluent/tutorial.html | Pseudolocalization "should expose any strings that were left" untranslated, and translations "may be 30% longer". | C1.2. |

## Links

| Id | Source | Claim used | Informs |
|---|---|---|---|
| lychee | lychee — https://github.com/lycheeverse/lychee | The default accepted statuses are `100..=103,200..=299`. Requests are limited per host (10 concurrent by default, at least 50 ms apart). | C1.3: one request at a time, with redirects followed. |
| linkinator | linkinator — https://github.com/JustinBeckwith/linkinator | `--retry` retries "HTTP 429 responses" that "include a 'retry-after' header". Redirects can be `allow`, `warn` or `error`. | C1.3: one 429 retry after `Retry-After`, and a 401 or 403 reported, not failed. |
| w3c-linkcheck | W3C Link Checker — https://validator.w3.org/checklink/docs/checklink.html | The checker honours robots exclusion. | C1.3: same-origin only, so there is no crawl policy to honour. |

## Prompt injection and CI security

| Id | Source | Claim used | Informs |
|---|---|---|---|
| owasp-llm01 | LLM01 Prompt Injection — https://genai.owasp.org/llmrisk/llm01-prompt-injection/ | Indirect injection comes "from external sources, such as websites or files". The mitigations are "Enforce privilege control and least privilege access", "Require human approval for high-risk actions" and "Segregate and identify external content". | §19.12, §19.16: the boundary is the explorer's confinement, the deterministic gate and the owner's merge. |
| owasp-pi-cheat | LLM Prompt Injection Prevention Cheat Sheet — https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html | "do not treat text labels or prompt wording as an enforcement boundary". "Treat user input as DATA, not COMMANDS". A guardrail model "is itself susceptible to prompt injection". | §19.12: fences are hygiene, not a boundary. No LLM filter is added. |
| gh-dispatch | Manually running a workflow — https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow | The workflow "must be in the default branch". "Write access to the repository is required." `gh` passes inputs with `-f`. | D7: the baseline run. |
| gh-secure | Secure use reference — https://docs.github.com/en/actions/reference/security/secure-use | "Pinning an action to a full-length commit SHA is currently the only way to use an action as an immutable release." Avoid `pull_request_target`, and give `GITHUB_TOKEN` "the minimum required permissions". | D16. |
| gh-artifacts | Store and share data — https://docs.github.com/en/actions/tutorials/store-and-share-data | `retention-days` sets an artifact's retention. | D16. |
| gh-runner | Ubuntu 24.04 runner image — https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md | The image lists Google Chrome, Microsoft Edge and Firefox as installed. | D8: the `msedge` job runs on the plain runner, outside the container. |

---

## Unverified (the plan relies on none of these)

- **Applitools** (match levels, ignore and floating regions). The pages tried
  (https://applitools.com/docs/api-ref/sdk-api/wdio/checksettings and the match-level pages) render
  client-side or return 404, so no primary text was read. The plan's handling of dynamic regions
  rests on Playwright's own `mask` and `stylePath` [pw-snap, pw-config] instead.
- **mabl** auto-heal (https://help.mabl.com/docs/how-auto-heal-works) returned 403. The claim that
  heals run at run time from an element history, and that users review them afterwards, comes only
  from a search summary.
- **Testim** smart locators (https://help.testim.io/docs/smart-locators) returned 522.

## Gaps this research closed (the plan changed)

1. "The runner has no shuffle" was wrong for 1.64 [pw-release, pw-cli]. CI now runs `--shuffle`.
2. Shared storageState across parallel tests that change server state is the case the auth guide
   warns against [pw-auth]. Each test now takes a lock per account [pw-parallel].
3. A new screenshot baseline cannot be adopted from a normal CI run [probe]. It now comes from a
   dispatched baseline run with `--update-snapshots=missing|changed` on the pinned container
   [pw-release, pw-ci, gh-dispatch].
4. axe-core was rejected for reasons the Playwright guide answers: `withTags`, `include` and
   fingerprinted known issues [pw-a11y]. Its zero-false-positive policy and `incomplete` category
   [axe-readme, axe-api] replace the hand-written contrast check.
5. Quarantine through `test.fixme` stops collecting the data needed to leave quarantine, and can
   hide a race a PR introduced [google-flaky]. Quarantined tests now run in a non-gating job, and a
   new flake on a PR is never quarantined.
6. An `alertdialog` is not exempt from Escape [apg-alertdialog]. Focus need not return when the
   invoker is gone [apg-dialog]. Composite widgets have one tab stop [apg-keyboard]. A backward focus
   jump is not by itself an F44 failure [u-2.4.3].
7. Perf measurements must not overlap other load on the machine [lh-variability]. LCP stops at the
   first input [webdev-lcp]. INP needs `durationThreshold: 16` [webdev-inp].
8. CI hardening: actions pinned by commit SHA [gh-secure], `workers: 1`, `globalTimeout` and
   `forbidOnly` [pw-ci, pw-config], and the setup project recording no trace [pw-auth, pw-use].
