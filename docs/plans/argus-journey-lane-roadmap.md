# Argus journey lane — implementation roadmap

Spec: [docs/specs/argus-journey-lane.md](../specs/argus-journey-lane.md). Target release: sapu 2.9.0.

The spec covers several subsystems that can each be built and tested on their own, so it is
implemented as six phases, each with its own plan. A phase starts only when the one before it is
merged into the feature branch with the whole suite green. Each later plan is written in full at the
start of its phase, because it builds on facts the earlier phase proves (for example, the filtering
proxy's mechanics in phase 3 depend on the instance lifecycle of phase 2).

| Phase | Plan | Delivers | Spec sections |
|---|---|---|---|
| 1 | [Foundations](argus-journey-lane-1-foundations.md) | `journey` in the contract's skills, `labels.needsOwner`; the guard protecting that label, refusing a not-planned close, and confining `sapu:ui-explorer` (Bash allowlist, reads, tools); `sapu-merge.sh` marking gates that overlapped a journey cycle and keeping them out of flake proofs; the version bump to 2.9.0 (done here, because the contract keys need it) | §4 policy, §8 "beside a sapu sweep", §10 needs-owner, §11 |
| 2 | Instance | the fixture app's server side; `argus-live.mjs` config loading and expansion, refusals, lock, ports, worktree outside the repo, environment, store phase, start and health, Compose checks, egress check, run files, `sapu-live.log`, reaper, `down`, `up --fresh`, `renew`, recovery | §8, §12 |
| 3 | Browser | per-slot CLI config, the filtering proxy and the other network layers, the `pw` wrapper (tokens, command allowlist, URL and value validation, logins with two-step, modal and TOTP, re-login, nonce-fenced output, signal capture, budget, loop and deadline, `trigger`, `facts`, `mail`, `submit`, `intake`) | §7 return, §9 |
| 4 | [Findings](argus-journey-lane-4-findings.md) | the module split (`-origin`, `-start`, `-session` and the new findings modules); the in-daemon hook, the secret ledger and the ids the run saw; repro sessions in slot `r`; the repro DSL runner with its exit codes and `final` templates, `parallel` and per-account steps, two of two, minimize, the generated Playwright test, the values a reproducing run read (`repro --saved`); `classify`; `scrub` against the run it names (`--run`, or `--ref` for a candidate reproduced two of two) with screenshot verdicts and filing through `gh`; the fence's matcher for long and re-encoded secrets; `map-check`, refresh triggers and the catalog; map mode (`up --map`, map slots, `map-check --merge`); SELECT scoring and account allocation (`select`), `visit`; doc drift (`drift`) | §5, §6, §7, §8, §9, §10, §12, §14, §16 |
| 4b | Backlog | every open backlog issue of this repo, fixed or (where the fix is a design limit) documented and closed with its reason, each commit carrying `Closes #N`; order: safety first (agent cwd and memory, the guard following the touched repo, writes into the active plugin folder, machine and git config write paths, a second sweep stopping early, the step budget proof), then portability and generic defaults, then trust-rule refinements and dogfooding | per issue |
| 5 | Engine text and release | `journeys.md`, the `/sapu:journey` skill, the `sapu:ui-explorer` agent, argus SKILL.md, reference.md and standards.md edits, `/sapu:init`, sapu B2, the inspector exclusion, CONTRACT.md, docs and diagram, engine tests (including one pinning the `ui-explorer` frontmatter to `tools: Bash, Read, StructuredOutput`), the upgrade note (the skills question, the new label, and stricter owner labels: a 2.8.x label with spaces or `, = " ' / [ ] { } ( ) %` must be renamed), the release checklist; the lane prompt runs `argus-live.mjs up` with a long timeout or in the background, so a harness timeout cannot cut it mid-setup (an `up` cut short leaves a run that only `down` accepts) | §4, §5, §7, §16 |
| 6 | Pilot | repo-side prep in the repo argus has run on longest (explore datastore, `store_check`, `reset`, `facts`, `mail`, `triggers`, `live` block, `env_file`), three journeys, the scorecard | §15 |

Rules for every phase:
- TDD: the failing test first, then the code, then the whole suite (`npx vitest run`).
- The suite runs on the release machine; browser tests need a local Chrome and fail without one.
- Commits carry no assistant attribution. One feature branch, `feat/argus-journey-lane`, one PR at
  the end of phase 5, carrying the backlog of phase 4b too; nothing is merged, tagged or released
  until the owner says so; phase 6 runs on the released plugin.
