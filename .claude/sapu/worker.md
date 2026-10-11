# worker — repo profile: the sapu plugin repository

The worker brief (`plugins/sapu/skills/sapu/subagent-brief.md`) reads this file.

## Setup

From the worktree root: `npm ci --no-audit --no-fund --silent` (vitest only; the plugin itself has no
npm dependencies). Never link `<MAIN>`'s `node_modules`.

## Red areas

The contract sets no `redAreas`. Treat as red, and say so in the PR: the files the rule guard
protects (`docs/contributing.md`) — `plugins/sapu/hooks/hooks.json`,
`plugins/sapu/scripts/sapu-guard.mjs`, `sapu-merge.sh`, `sapu-contract.mjs`,
`plugins/sapu/workflows/sapu-wave.js`, `inspector.js`, `tests/engine.test.ts`,
`scripts/rule-guard.ts`, `tests/rule-guard.test.ts` — and any normative clause in `README.md`,
`plugins/sapu/CONTRACT.md`, `plugins/sapu/skills/**` or `plugins/sapu/agents/**`. A change there needs
a `Rule-Change: <reason of at least 20 characters>` trailer.

## Test DB

None: no database. Tests create their own temporary directories and repos under the system temp
directory and remove them.

## Protected targets

Nothing outside the worktree: not `<MAIN>`, not `~/.config/sapu/`, not an installed copy of the
plugin, not the real GitHub repo (the tests stub `gh`).

## Test

Run only the test files that cover the diff: `npx vitest run tests/<file>.test.ts 2>&1 | tail -40`.
`sapu-guard.mjs` → `tests/sapu-guard.test.ts`; `sapu-contract.mjs` → `tests/sapu-contract.test.ts`
and `tests/sapu-merge.test.ts` (the merge script calls it); `sapu-merge.sh` → `tests/sapu-merge.test.ts`;
`workflows/*.js` → `tests/sapu-wave.test.ts`, `tests/inspector.test.ts`; `argus-live*.mjs` →
`tests/argus-live.test.ts`; `sapu-metrics.ts` → `tests/sapu-metrics.test.ts`; `sapu-cleanup.mjs` →
`tests/sapu-cleanup.test.ts`; any prose under `plugins/`, `README.md` or `docs/` →
`tests/engine.test.ts` (prose budgets, English only, no repo or machine facts). "No test files
found" means a wrong path, never green.

## Verification

`npx vitest run tests/engine.test.ts 2>&1 | tail -20` and `node scripts/rule-guard.ts 2>&1 | tail -20`
before the PR (the rule guard needs the `Rule-Change` trailer committed first).

## Teardown

Nothing to tear down: no server, container or database is started.
