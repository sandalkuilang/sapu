# Argus journey lane — implementation roadmap

Spec: [docs/specs/argus-journey-lane.md](../specs/argus-journey-lane.md). Target release: sapu 2.9.0.

The spec covers several subsystems that can each be built and tested on their own, so it is
implemented as six phases, each with its own plan. A phase starts only when the one before it is
merged into the feature branch with the whole suite green. Each later plan is written in full at the
start of its phase, because it builds on facts the earlier phase proves (for example, the filtering
proxy's mechanics in phase 3 depend on the instance lifecycle of phase 2).

| Phase | Plan | Delivers | Spec sections |
|---|---|---|---|
| 1 | [Foundations](argus-journey-lane-1-foundations.md) | `journey` in the contract's skills, `labels.needsOwner`; the guard protecting that label and confining `sapu:ui-explorer` (Bash allowlist, reads); `sapu-merge.sh` marking gates that overlapped a journey cycle and keeping them out of flake proofs | §4 policy, §8 "beside a sapu sweep", §10 needs-owner, §11 |
| 2 | Instance | the fixture app's server side; `argus-live.mjs` config loading and expansion, refusals, lock, ports, worktree outside the repo, environment, store phase, start and health, Compose checks, egress check, run files, `sapu-live.log`, reaper, `down`, `up --fresh`, `renew`, recovery | §8, §12 |
| 3 | Browser | per-slot CLI config, the filtering proxy and the other network layers, the `pw` wrapper (tokens, command allowlist, URL and value validation, logins with two-step, modal and TOTP, re-login, nonce-fenced output, signal capture, budget, loop and deadline, `trigger`, `facts`, `mail`, `submit`, `intake`) | §7 return, §9 |
| 4 | Findings | the repro DSL runner with its exit codes and `final` templates, `parallel` and per-account steps, minimize, the generated Playwright test; `scrub`; `map-check`, refresh triggers, SELECT scoring and account allocation | §6, §10 |
| 5 | Engine text and release | `journeys.md`, the `/sapu:journey` skill, the `sapu:ui-explorer` agent, argus SKILL.md, reference.md and standards.md edits, `/sapu:init`, sapu B2, the inspector exclusion, CONTRACT.md, docs and diagram, engine tests, version 2.9.0, the release checklist | §4, §5, §7, §16 |
| 6 | Pilot | repo-side prep in the repo argus has run on longest (explore datastore, `store_check`, `reset`, `facts`, `mail`, `triggers`, `live` block, `env_file`), three journeys, the scorecard | §15 |

Rules for every phase:
- TDD: the failing test first, then the code, then the whole suite (`npx vitest run`).
- The suite runs on the release machine; browser tests need a local Chrome and fail without one.
- Commits carry no assistant attribution. One feature branch, `feat/argus-journey-lane`, one PR at
  the end of phase 5; phase 6 runs on the released plugin.
