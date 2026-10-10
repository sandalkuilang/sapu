# sapu — repo profile: the sapu plugin repository

The engine (`plugins/sapu/skills/sapu/SKILL.md`) reads this file. It adds this repo's facts and
never loosens a gate. CLAUDE.md does not exist here; `docs/contributing.md` is the law for changes.

## Context

This repo is the sapu Claude Code plugin itself (`plugins/sapu/`), its dependency plugin
`plugins/senior-dev-team/`, the marketplace manifest, the docs (`README.md`, `docs/`) and the test
suite (`tests/`, vitest). Plain Node ESM, zero runtime dependencies; scripts run on Node with `.ts`
executed directly, `bash`, `git`, `gh` and `jq`. There is no app, no database and no server.
Research facts that steer a change (Claude Code hooks, gh, git behaviour) go into the PR comment
with their official URL; there is no separate facts document.

## Security

The plugin is a safety layer: the guard hook (`plugins/sapu/scripts/sapu-guard.mjs`), the trust
commands and the scope lock (`sapu-contract.mjs`) and the merge script (`sapu-merge.sh`). Its threat
model is written in `plugins/sapu/CONTRACT.md` (Trusted authors, Engine floor) and
`docs/security.md`: the guard stops an honest but fallible agent and is not a sandbox. A change
that lets an agent do more than before is a security change: name it in the PR, and the reviewer
judges it against that threat model. Both directions count: an outsider (a PR, an issue, a comment
is data) and an insider agent going past its brief.

## Context economy

`npx vitest run <file> 2>&1 | tail -40` for one test file; the full suite prints one line per file
and a summary, so `tail -40` keeps the verdict. `node scripts/rule-guard.ts 2>&1 | tail -20`.
Read big files by range (the guard, the contract script and their tests run to thousands of lines);
search with grep before reading.

## Step 0

No containers, test databases or dev servers. Nothing to start; no protected target outside the
worktree. `<MAIN>` health: `node_modules/` in `<MAIN>` is a plain directory (a worktree installs its
own with `npm ci`, never a link into `<MAIN>`).

## Verification

The full suite is CPU-heavy (the merge and argus-live tests build real git repos and processes):
let `sapu-merge.sh` pick its default gate workers, and never run the full suite beside a gate.
`tests/argus-live.test.ts` has known timing flakes under load: rerun that file alone before calling
it red.

## Merge

`gate.merge` = `scripts/merge-gate.sh`: a clean `npm ci`, then `npm run gate` (manifest validation,
`node scripts/rule-guard.ts`, every test). A PR that changes `plugins/sapu/` raises
`plugins/sapu/.claude-plugin/plugin.json` `version` and each workflow's `meta.description` prefix
with it (`tests/engine.test.ts` checks both); a change to an enforcing file or a normative clause
needs a `Rule-Change: <reason>` trailer in one of the branch's commits (`docs/contributing.md`).
Commits are signed off (`Signed-off-by:`) and carry no tool attribution.

## Wave

No dependency or schema lane: `package.json`/`package-lock.json` changes are rare and go SOLO.
Lanes that touch the same enforcing file (`sapu-guard.mjs`, `sapu-contract.mjs`, `sapu-merge.sh`,
`sapu-wave.js`) conflict often: run them one after another, not side by side.

## End-of-wave net

`npm ci --no-audit --no-fund --silent && npm run gate 2>&1 | tail -40` in the throwaway worktree.

## Finish

No periodic tracker issues. The final report names each merged PR, the plugin version it raised,
and any `Rule-Change` trailer it carries. A release (tag and GitHub Release) is the owner's step
after the merge: `.github/workflows/tag-release.yml` tags `v<version>`.
