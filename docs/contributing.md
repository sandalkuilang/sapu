# Contributing

<sub><a href="../README.md">README</a> · <a href="usage.md">Install and use</a> · <a href="agents.md">How the agents work</a> · <a href="security.md">Safety and trust</a> · <b>Contributing</b></sub>

## What is in this repo

```
.claude-plugin/marketplace.json   marketplace "sapu" → plugins/sapu, plugins/senior-dev-team
.claude/sapu.json                 this repo's own sapu contract (its maintainer's identity)
.claude/sapu/*.md                 this repo's own profiles (sapu, worker, forge, dream), as /sapu:init writes them
plugins/sapu/
  .claude-plugin/plugin.json      version; dependencies: senior-dev-team
  CONTRACT.md                     the repo contract format
  skills/                         sapu, forge, argus, journey, momus, nemesis, inspector, dream, init
  agents/                         the worker ladder sapu-sonnet-medium … sapu-opus-high, ui-explorer (the journey lane's explorer) and curator (its taste judge, tools Read and StructuredOutput)
  data/taste-bar.json             the taste bar: rules, thresholds, sources, reference frames, calibrated bands per archetype and width (versioned)
  hooks/hooks.json                PreToolUse guard (Bash, Monitor, PowerShell, file and search tools, every MCP tool), active for every subagent, not for the orchestrator
  workflows/sapu-wave.js          one Phase B lane (one issue: scout, builder, review, fix cycles) as code
  workflows/inspector.js          the momus → argus → nemesis sequence as code
  scripts/                        sapu-contract.mjs, sapu-guard.mjs, sapu-merge.sh (and sapu-smoke-gate.mjs, its smoke check), sapu-metrics.ts, sapu-cleanup.mjs;
                                  argus-live.mjs and its argus-live-*.mjs modules (the journey lane's instance, wrapper, repro and scrub;
                                  the smoke suite's -smokecfg configuration, -codegen generator, -layout and -a11y checks, -smoke pass, -suite, -propose, -heal, -artifacts (CI's runs and artifacts), -ci, -baseline, -perf, -seed and -report;
                                  the taste pass's -taste, -ease and -aiux probes, -world (their isolated world), -tastecfg, -tastesink, -tastejudge, -tastefile and -codeproj: see "The taste bar and its calibration")
  scripts/pw/                     package.json and lockfile of the pinned browser CLI the journey lane installs on first use
plugins/senior-dev-team/          sapu's dependency: the specialist agents (agents/), README, LICENSE
docs/img/src/                     the diagram generator: one source per diagram, light and dark files
scripts/rule-guard.ts             gate: a weakened engine rule needs a Rule-Change trailer (not shipped)
scripts/taste-calibrate.mjs       the maintainer's calibration of the taste bar (not shipped; never run by an agent)
scripts/taste-corpus.json         the reference corpus it measures: public pages, their sites' terms review, what was left out (not shipped)
scripts/taste-calibrate-local.mjs its --local mode: OSS apps fetched pinned, run on loopback by the lane's up/down, measured, deleted (not shipped)
scripts/taste-corpus-local.json   the local corpus: OSI-licensed OSS apps, their licenses, pinned releases, live configs and routes (not shipped)
tests/                            vitest: guard, workflows, contract, merge, metrics, cleanup, rule-guard, the journey lane (argus-live*), and "the engine is clean of repos"
.github/workflows/                test.yml runs the suite on Linux and macOS for a PR once it is ready for review (drafts run nothing), in parallel jobs (a `taste` job runs the taste pass's Chrome test files); tag-release.yml tags a released version
```

The plugin has no npm dependencies. Its scripts run on Node ≥ 22.18 (`.ts` runs directly), `bash`, `git`, `gh`, and `jq`. The journey lane's browser CLI is the one exception, and it is not installed with the plugin: `scripts/pw/` pins it, and the lane installs it into the user's cache with `npm ci --ignore-scripts` the first time it needs it.

The journey lane's browser tests (`tests/argus-live-browser.test.ts`, `-repro`, `-codegen`, `-layout`, `-a11y`, `-perf`, and the taste pass's `-tasteprobe`, `-ease`, `-tasteflow`, `-tastejudge`, `-aiux`, `tests/taste-calibrate.test.ts` and `tests/taste-calibrate-local.test.ts`) drive a real Chrome or Edge, through that CLI or through the pinned runner: a machine without one fails them rather than skipping them, and their first run needs the network or a warm npm cache to install the CLI. The generated smoke suite imports `@playwright/test`, which the pinned CLI install does not hold, so the codegen, layout and a11y tests run it against the install's own runner through a scratch `node_modules/@playwright/test` stub; no test runs `npm install` for it.

## Changing the plugin

Every change goes through a PR, with a green gate and a review by an agent that is not its author.

```bash
npm install
```

```bash
npm run gate
```

`npm run gate` validates the manifests (`claude plugin validate`) and then runs every test. One test (`tests/engine.test.ts`) fails when a file in this repo points at one machine, one account, or one consuming repo: an issue number, a date (outside a URL), a macOS or Linux home directory path, a laptop folder name, or one person's split of repos. A consuming repo's facts belong in that repo's contract. The same file also fails when the plugin, this README or `docs/` carry prose in another language than English, and when the plugin or this README narrate past runs (a release named as the time something happened, e.g. "in the 2.2.9 pilot") or state, in prose, a number one machine or one model measured (a context size such as "750k", a core count, a fixed `--workers` count, a step budget in tool calls, a model window): those values come from `sapu-contract.mjs lanes` and `tuning`, and the prose names them.

The names of your own consuming repos must not be written into a test, because writing them down is exactly what leaks them. Put them in `.sapu-banned` at the root of this clone: one JS regex per line (case-insensitive), `#` for comments. That file is gitignored and read by the same test; a worktree without the file reads the main checkout's. A new clone has none: recreate it ([Install and use](usage.md#a-new-machine), the steps for a new machine).

`.claude/sapu.json` is the sapu contract of **this** repo, like CODEOWNERS: it names its maintainer's identity (`repo`, `ghUser`, `gitEmail`). A fork replaces it with its own identity. That, together with `repository`/`author` in `plugin.json`, `owner` in `marketplace.json`, and this repo's own `owner/name` slug where this README says how to install or clone it, is the only place an identity may appear; the same test exempts exactly those JSON fields, no more.

Before the tests, the gate runs `node scripts/rule-guard.ts`. It compares the branch with `origin/main` (or `GATE_DIFF_BASE`) and goes red when:

- a normative clause (must, never, only, should, do not, …, and their Indonesian equivalents) in `README.md`, `plugins/sapu/CONTRACT.md`, `plugins/sapu/skills/**`, or `plugins/sapu/agents/**` is lost or changed;
- an agent's `tools:`, `model:`, or `effort:` changed, or its agent file was deleted;
- one of the files that enforce the rules changed at all or was deleted — tightening changes included:
  - `plugins/sapu/hooks/hooks.json`
  - `plugins/sapu/scripts/sapu-guard.mjs`, `sapu-merge.sh`, `sapu-smoke-gate.mjs`, `sapu-contract.mjs`, `sapu-cleanup.mjs`
  - `plugins/sapu/workflows/sapu-wave.js`, `inspector.js`
  - `tests/engine.test.ts` (here a context budget that went up or vanished is also named on its own)
  - `scripts/rule-guard.ts` and `tests/rule-guard.test.ts`
- `gate` in `package.json` no longer runs `node scripts/rule-guard.ts` as an `&&` step of its own, or contains anywhere `||`, `;`, a lone `&`, a newline, or `exit`, which could make the gate pass while the guard is red (for example `… && vitest run || true`).

Adding rules, moving clauses, or re-wrapping lines does not trigger it. When such a change is intended, write the reason as a trailer in one of the branch's commits:

```
Rule-Change: <reason, at least 20 characters>
```

Every PR that changes the content of `plugins/sapu/` must raise `version` in `plugins/sapu/.claude-plugin/plugin.json` in that same PR, and the `sapu vX.Y.Z — ` prefix of each workflow's `meta.description` with it (the Workflow panel shows it; `tests/engine.test.ts` checks they match): patch for fixes, minor for new behaviour. Claude Code's cache is keyed by version, so without a version bump consuming repos keep using the old copy. `tests/engine.test.ts` refuses a change without a version bump. After the merge, `.github/workflows/tag-release.yml` tags the commit `v<version>` and publishes it as the Latest GitHub Release; then run both commands of "Updating the plugin" in the consuming repos (between sweeps: a running session keeps its version until restarted). A release that misbehaves is rolled back by tag: [Install and use](usage.md#rolling-back-to-a-previous-version). Auto-update is off for third-party marketplaces, so a version never changes silently. The same version rule holds for `plugins/senior-dev-team/` and its own `plugin.json` (the test checks both; the Release tag follows sapu's version).

The GitHub Release notes are generated from the merged PRs' titles. What users must do or know when they upgrade (a new contract key, a newly refused command, a changed trust rule) goes into [Install and use](usage.md#updating-the-plugin), under a heading `Upgrading from a version before <version>`, in the same PR that raises the version.

Engine defects that a sweep hits in a consuming repo arrive here as issues titled `<component>: <one line>`, with the fields Component, Plugin version, What happens, Expected and Proposed fix ([`CONTRACT.md`](../plugins/sapu/CONTRACT.md) §Engine defects go upstream). By design they carry nothing of the consuming repo: reproduce the defect from its description and fix it in the plugin.

The smoke suite is not in this repo: the journey lane generates it into a consuming repo (`e2e/argus-smoke/` by default), and `scripts/argus-live-codegen.mjs` is its only writer. Three constants there matter when you change it:
- `SMOKE_PLAYWRIGHT` and `SMOKE_AXE` are the exact versions the suite pins, and `SMOKE_PLAYWRIGHT` names the CI container image. A test keeps `SMOKE_PLAYWRIGHT`'s major and minor equal to the `playwright-core` that `scripts/pw/package-lock.json` pins, so raising the browser CLI fails that test until the constant moves; `smoke plan` then lists `upgrade …` for every consumer, and each needs a baseline run.
- `CODEGEN_VERSION` is written into every generated file's header. Raise it when the generator's output changes for the same inputs: `smoke check` reports every older file as `stale`.

Generated code uses only Playwright APIs that exist in both the pinned CLI's runner and the suite's `@playwright/test`. A test scans the generated output and bans hard waits, template literals that hold path data, serial tests, shared state and `fixme`.

## The taste bar and its calibration

The journey lane's taste and usability pass ([Install and use](usage.md#the-taste-and-usability-pass)) is made of leaf modules under `plugins/sapu/scripts/`, each owned by one concern. A module is capped at 750 lines, and a test pins the module order (leaves first, `-tastejudge` before `-tastefile`, nothing but `argus-live.mjs` and `-report` reaching them).

| Module | Holds |
|---|---|
| `argus-live-taste.mjs` | The visual probes: `TASTE_SOURCE` and the page-level `censusOf`, `rulesFor` and `ruleExpression` for the scale, hierarchy, colour, contrast, motion and density rules, and `TASTE_INIT`, the motion recorder. |
| `argus-live-ease.mjs` | The interaction probes: feedback, states, copy, consistency, `pathCost` for efficiency, and `EASE_INIT`, the feedback clock. |
| `argus-live-aiux.mjs` | The AI-surface rules (`ai.*`), their recorder `AIUX_INIT` and the drive a confirmation uses. |
| `argus-live-tastecfg.mjs` | The shared leaf: loaders and validators for `.argus/taste.json` and the bar, the record shapes (judge rows, the Curator's return, `.argus/taste-state.json`), and the page-side constants the recorders and the lane share. |
| `argus-live-tastejudge.mjs` | `taste judge` and `taste confirm`: witnesses, peers, bands, the replay and the state. |
| `argus-live-tastesink.mjs` | The confirmation's sink: the in-daemon code a replay runs around each step of the path, measuring the row's screen once it is reached. |
| `argus-live-tastefile.mjs` | `taste file` and `taste accept`: filing, the cap, deduplication, accepted rows. |
| `argus-live-codeproj.mjs` | Split from `-codegen`: the suite's projects and check registry, including the `taste` project and its single reporter. |
| `argus-live-browser.mjs`, `-session.mjs` | `PAGE_INIT` (the signal script, the init payload of every lane document's own world), `TASTE_WORLD` (the recorders), and the recorder that writes `<run>/taste/`. |
| `argus-live-world.mjs` | The recorders' isolated world: `WORLD_INSTALL` (the session hook's, through a CDP session a page, with the driver's request timing), `WORLD_EVAL` (every read of the recorders), and `EASE_NET`, the request wrappers for the page's own world the suite uses. |
| `argus-live-propose.mjs` | The workflow's `taste` job and `TASTE_SUMMARY`, the scorecard it writes. |

A probe is one in-page function, so the lane (through `run-code`) and the suite (embedded verbatim in `support.ts`) run the same source. Each rule's fixture has a twin that differs only by the defect: a rule that fires on one must hold on the other. The bar's `probe` digest is the sha256 of `TASTE_SOURCE` and `EASE_SOURCE` as they were when the bands were measured. When you change how a probe measures a banded metric, calibrate again: no test compares the shipped digest with the current sources, so a stale one fails nothing.

**The CI `taste` job.** The test workflow runs the Chrome-driving taste test files (`-tastejudge`, `-tasteprobe`, `-ease`, `-tasteflow`, `-aiux`, `taste-calibrate` and `taste-calibrate-local`) in their own matrix job, named on one `files:` line, so they do not pile into `rest`. Add a new Chrome-driving taste test to that line. Do not confuse it with the `taste` job of the *generated* smoke workflow, which runs in a consumer's CI ([Install and use](usage.md#the-taste-job-in-ci)).

**Calibrating the bar.** `scripts/taste-calibrate.mjs` is the maintainer's: it runs the probes on the public pages in `scripts/taste-corpus.json` (or, with `--local`, on the OSS apps of `scripts/taste-corpus-local.json`, below) and writes only the bar's `probe` digest and its `archetypes` (one band a line; the rest of the file stays byte for byte). Each archetype holds the month it was calibrated (`calibrated`, `YYYY-MM`, never a day) and its bands by width bucket (`widths`: `390` for a screen narrower than 1024 px, `1440` otherwise); the public pages are measured at 1440 only. An archetype the run did not measure keeps its entry while the bar's `probe` digest is the current probes', and is dropped otherwise. Run it from your own session, never from an agent: the guard refuses it to every subagent ([Safety and trust](security.md#the-calibration-is-maintainer-only)).

```bash
node scripts/taste-calibrate.mjs --corpus scripts/taste-corpus.json --out plugins/sapu/data/taste-bar.json
```

Without `--network` it validates the corpus and the bar and prints the plan: how many pages and sites, and when robots.txt and the pace allow it to finish. Nothing is fetched or written. To measure:

```bash
node scripts/taste-calibrate.mjs --network --diff --corpus scripts/taste-corpus.json --out plugins/sapu/data/taste-bar.json
```

`--network` measures a site only when a maintainer confirmed its terms in the corpus: `sites.<site>.confirmed` is `{by, on}`, `on` the bar version it was confirmed for (`"taste-bar 1"`, never a date). A site without it is refused before any request (`refused: taste-calibrate: no maintainer confirmed the terms of <sites> …`). No site is confirmed today, so the shipped bar holds no band and its `probe` is null; a test fails whenever the bar holds a band its `probe` digest no longer matches (the probes changed since: calibrate again). `--diff` prints each band as changed, unchanged, new or gone, and `--diff` without `--network` is refused. The script prints, per archetype, the pages and sites measured and whether the band is `a witness` (5 sites and 15 pages) or `thin`, and it cuts and names a band driven by one site. It does not raise the bar's `version`.

**Calibrating from the local corpus.** Public app screens sit behind a login, so the `app`, `form` and `data` archetypes are calibrated on OSI-licensed, actively maintained open-source SaaS apps run on this machine instead. `scripts/taste-corpus-local.json` lists them: per app its GitHub `repo`, its `license` (an SPDX id the Open Source Initiative approved; any other is refused), `source` (`git`, or `image` with the image's name), its pinned `release`, the lane's `live` config for it (its `.argus/live.json`), the `env` values its env file gets, the `login` role signed in first, and seven `routes` (3 `app`, 2 `form`, 2 `data`). An app without `live` is a candidate and is not run; today every app is one (Twenty, Plane, Cal.com, Documenso, Supabase Studio, Infisical, shadcn/ui).

```bash
node scripts/taste-calibrate.mjs --local scripts/taste-corpus-local.json --refresh
node scripts/taste-calibrate.mjs --local scripts/taste-corpus-local.json --out plugins/sapu/data/taste-bar.json
node scripts/taste-calibrate.mjs --local scripts/taste-corpus-local.json --network --diff --out plugins/sapu/data/taste-bar.json
```

1. `--refresh` pins every app to its latest GitHub release (`{tag, published, commit}`, or the image's `digest` for that tag, `image_tag` mapping the release tag to the image's) and rewrites only the pins. It rejects an app, leaving its `release` null, when its latest release is older than `max_age_months` (12: unmaintained), when GitHub reads its license as anything but the one declared (a repository that mixes licenses reads `NOASSERTION`: Twenty and Infisical do today), or when it has no release. It reads GitHub's API (`GH_TOKEN` or `GITHUB_TOKEN` when set) and `docker buildx imagetools` for a digest. Review its diff and commit it.
2. Without `--network` it prints the plan: each app ready or not and why, each ready app's pin and routes, and each archetype's calibration month (stale past 12 months).
3. `--network` first asks GitHub again and refuses the whole run, before anything is fetched, when a pin is no longer the app's latest release: a calibration always measures the latest releases. Then, one app at a time, it fetches the pinned commit alone (or pulls the image by digest) into a new temp directory, commits the app's `live` config and a throwaway sapu contract there, writes its env file, and runs the journey lane's own `argus-live.mjs up` in it (with `TMPDIR` inside the temp directory, so the run's worktree and HOME stay there too). It signs the `login` role in with the lane's own login stage, visits each route at 390 and 1440 with every request outside the run's origins aborted, and runs the census and ease probes, which give a light and a dark screen where the app answers `prefers-color-scheme`. Then `argus-live.mjs down`, the image removed, and the temp directory deleted, whatever happened; a line per app says how many pages it measured and that its instance is down and its files deleted.
4. The bands record numbers only. A band's `urls` are the apps' release pages on GitHub, never the instance's address, and no page text, screenshot or asset is kept. Base images an app's own Compose file pulls (a database, say) stay in Docker's cache unless its `live` config's stop command removes them (`docker compose down -v --rmi all`).

Writing an app's `live` config is the work of making it ready: it is a `.argus/live.json` like any repo's (its format: [`skills/journey/live.md`](../plugins/sapu/skills/journey/live.md)), its `base_url` on loopback, its store seeded so the seven routes show real data, its first `login` user signing in with a password alone. Check it by hand before you commit it: run `--network` with only that app ready and read its lines.

Review the bar when a sapu minor version is released, at least twice a year, and whenever a researched design system publishes a new major version:
1. Re-read the sources the bar cites (its `sources` map) and the corpus's site terms. A site joins the corpus only with a read justification and a terms review, recorded on each page (`terms_reviewed_by`), and is measured only once you confirm that reading (`sites.<site>.confirmed`); a site leaves when its terms bar robots or data mining.
2. Run `--local … --refresh`, then both calibrations with `--network --diff` (the public pages and the local corpus), and read every band for plausibility. The journey lane's judge prints `stale bands: …` once an archetype's month is over 12 months old.
3. Raise `version` in `plugins/sapu/data/taste-bar.json` by one, commit the new bands, and open a pull request that cites the sources and justifies each corpus change. A bar change is a change to the plugin: raise the plugin version too.

A suite records the bar version it was judged against in its header (`taste-bar <n>`), so `smoke check` names a suite generated against an older bar `stale`, and a report names the version it used.

Diagrams are generated, not hand-edited: change `docs/img/src/diagrams/<name>.mjs` (or the shared `lib.mjs`), then run `node docs/img/src/build.mjs <name>`; it writes `docs/img/<name>.svg` and `<name>-dark.svg` (set `OUT=<dir>` to write elsewhere, e.g. to compare). A diagram's title, description and label sit in its module or in `docs/img/src/a11y/<name>.json`; when they change, change the `alt` of its `<picture>` in the README and `docs/` with them. The logo, badges and icons are hand-made SVGs, edited directly. The README shows each through `<picture>`, so GitHub picks the file matching the reader's theme.

