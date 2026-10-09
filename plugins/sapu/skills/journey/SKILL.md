---
name: journey
description: Use when walking the repo's web app through its real UI as every role its business journeys need, or when listing those journeys — argus's journey lane, on an isolated instance argus starts itself, never the owner's servers. One invocation = one bounded cycle: the catalog refreshed while the instance comes up, the top journeys walked by sapu:ui-explorer agents, every candidate reproduced two of two by a script before anything is filed. Needs `.argus/live.json` and the argus profile (/sapu:init writes them). Triggers: "/sapu:journey", "run a journey cycle", "walk the workflows as every role", "list the journeys".
---

# JOURNEY — argus's journey lane

A door, not a methodology: a journey cycle is an argus cycle ([SKILL.md](${CLAUDE_PLUGIN_ROOT}/skills/argus/SKILL.md)) with the lane fixed to `journey`, its phases run per [journeys.md](${CLAUDE_PLUGIN_ROOT}/skills/argus/journeys.md). Every argus gate holds; this file adds none and loosens none.

**Policy.** First `node "${CLAUDE_PLUGIN_ROOT}/scripts/sapu-contract.mjs" allowed argus`, then `node "${CLAUDE_PLUGIN_ROOT}/scripts/sapu-contract.mjs" allowed journey` (exit 1 on either = stop and quote it). When the policy has `fileIssues: false` or `traces: "none"`, `${CLAUDE_PLUGIN_ROOT}/skills/sapu/policy.md` governs filing and every GitHub write, as it does for argus.

**Step 1** is argus's: read the profile `<profiles>/argus.md` (missing → stop and tell the user to run `/sapu:init`). No `.argus/live.json` → stop and tell the user to run `/sapu:init` with the journey lane enabled.

Run it from the main session only, never inside `/sapu:inspector` or a subagent: the cycle dispatches agents of its own.

**`live <cmd>`** below stands for `node "${CLAUDE_PLUGIN_ROOT}/scripts/argus-live.mjs" <cmd>`, run from the main checkout. `live up`, `live repro` and `live down` run in the background, as journeys.md says.

## Forms

| Form | Does |
|---|---|
| `list` | the catalog only; starts no app. `live map-check --list`: with `refresh: none`, print its catalog and stop. A refresh due (or `refused: no journey is selectable` with one due) → rebuild: `live up --map`, `live slot 1 --map`, one map-mode `sapu:ui-explorer` (journeys.md's map charter), `live map-check --merge 1`, `live down`, then `live map-check --list` and print it |
| `list --rebuild` | `list`, rebuilding the map even when no refresh is due |
| no argument | one journey cycle, autonomous, never stopping to ask: journeys.md's steps 1 to 10, SELECT picking up to `limits.max_parallel_journeys` within `limits.max_cycle_minutes` |
| `<id> [<id>…]` | one cycle on the named journeys: step 3 runs `live select --cycle <n> --ids <id>,…` and prints the journeys they displaced |

One invocation = one bounded cycle; a pass over the whole catalog is that many invocations. The report's catalog line is `map-check`'s own (`catalog: <k> journeys, <d> dropped`).

**Watching.** Once `live up` printed its summary, print for the owner the command that opens the browser CLI's dashboard on this cycle's sessions, `live show` written out with the plugin's real path (`realpath "${CLAUDE_PLUGIN_ROOT}/scripts/argus-live.mjs"`), to run in a terminal of their own: it blocks until Ctrl-C. Never run it yourself.

## The report

argus's report (SKILL.md §5, §6), plus: the catalog line; `select`'s `select`, `wait` and `displaced` lines; per explored journey its status, coverage and candidates; per candidate its verdict (`REPRODUCED`, `runs=1/2`, harness), its class and severity, and the URL `scrub` filed or the reason it was not filed; the `down` report. It ends with the next picks: `select`'s `wait` lines, as ROTATE pins them.
