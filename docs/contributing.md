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
  agents/                         the worker ladder sapu-sonnet-medium … sapu-opus-high, and ui-explorer (the journey lane's explorer)
  hooks/hooks.json                PreToolUse guard (Bash, Monitor, PowerShell, file and search tools, every MCP tool), active for every subagent, not for the orchestrator
  workflows/sapu-wave.js          one Phase B lane (one issue: worker, review, fix cycles) as code
  workflows/inspector.js          the momus → argus → nemesis sequence as code
  scripts/                        sapu-contract.mjs, sapu-guard.mjs, sapu-merge.sh, sapu-metrics.ts, sapu-cleanup.mjs;
                                  argus-live.mjs and its argus-live-*.mjs modules (the journey lane's instance, wrapper, repro and scrub)
  scripts/pw/                     package.json and lockfile of the pinned browser CLI the journey lane installs on first use
plugins/senior-dev-team/          sapu's dependency: the specialist agents (agents/), README, LICENSE
docs/img/src/                     the diagram generator: one source per diagram, light and dark files
scripts/rule-guard.ts             gate: a weakened engine rule needs a Rule-Change trailer (not shipped)
tests/                            vitest: guard, workflows, contract, merge, metrics, cleanup, rule-guard, the journey lane (argus-live*), and "the engine is clean of repos"
.github/workflows/                test.yml runs the suite on Linux for every push and PR; tag-release.yml tags a released version
```

The plugin has no npm dependencies. Its scripts run on Node ≥ 22.18 (`.ts` runs directly), `bash`, `git`, `gh`, and `jq`. The journey lane's browser CLI is the one exception, and it is not installed with the plugin: `scripts/pw/` pins it, and the lane installs it into the user's cache with `npm ci --ignore-scripts` the first time it needs it.

The journey lane's browser tests (`tests/argus-live-browser.test.ts` and `tests/argus-live-repro.test.ts`) drive a real Chrome or Edge through that CLI: a machine without one fails them rather than skipping them, and their first run needs the network or a warm npm cache to install the CLI.

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
  - `plugins/sapu/scripts/sapu-guard.mjs`, `sapu-merge.sh`, `sapu-contract.mjs`
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

Diagrams are generated, not hand-edited: change `docs/img/src/diagrams/<name>.mjs` (or the shared `lib.mjs`), then run `node docs/img/src/build.mjs <name>`; it writes `docs/img/<name>.svg` and `<name>-dark.svg` (set `OUT=<dir>` to write elsewhere, e.g. to compare). A diagram's title, description and label sit in its module or in `docs/img/src/a11y/<name>.json`; when they change, change the `alt` of its `<picture>` in the README and `docs/` with them. The logo, badges and icons are hand-made SVGs, edited directly. The README shows each through `<picture>`, so GitHub picks the file matching the reader's theme.

