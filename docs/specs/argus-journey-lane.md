# Argus journey lane — design spec

Status: draft for owner review. Target release: sapu 2.9.0.

## 1. Problem

The owner wants an agent that uses an app the way its users do — every role, end to end — and
reports bugs, UI defects and **workflow** defects: how a piece of work passes from one role to the
next, where it gets stuck, where users get lost. It must work on any repo with a web UI, not only
the first one it is piloted on.

## 2. What exists, and the gap

`sapu:argus` already is an autonomous QA operative: charters, the law of evidence, refute-by-default,
minimize-before-filing, fingerprints, coverage rotation, Workflow fan-out, the Council of Five
(operator realism, cold-start walk, Curator, Auditor). On the repo it has run on longest it logged 97
cycles and filed 181 issues. A new, separate "explore" system would duplicate all of it. This spec
**extends argus** instead.

The gaps, with evidence:

| Gap | Evidence |
|---|---|
| Workflows are never experienced through the UI | reference.md §4.1 drives workflow conformance "over HTTP, never through the UI". Argus proves a flow is *correct*; nothing checks that each role can *carry it through*: handoff signals, status coherence across roles, dead ends, discoverability. 10 of 97 cycles mention a journey or handoff at all. |
| Cycles fall back to static when the owner's servers are down | 10 logged cycles ran `mode=static` (severity capped at S3, Curator and cold-start walk off); argus may not start servers. One UX sweep was re-scoped for this reason. |
| One browser per session | Argus uses "the session's browser-automation tool": one pane, no parallel explorers, absent outside the desktop app. |
| Stale docs act as truth | Class B(a) grounds a finding in `business_truth.docs`. A doc older than the behaviour it describes yields a false "nonconformance". |

## 3. Goals and non-goals

Goals:
- A new argus lane, `journey`: one charter = one business journey across roles, walked through the
  real UI by a dedicated agent that is given goals, not steps.
- Every journey cycle runs live, on an isolated instance argus starts itself — never the owner's
  servers or data.
- Parallel explorers, one isolated browser per role per journey.
- Generic: the engine names no repo; every repo fact lives in the repo's `.argus/config.yml` and
  argus profile.
- Every filed journey finding carries a runnable reproduction.

Non-goals (v1): native mobile or desktop apps (web only; phone sizes by viewport), load or
performance testing, penetration testing (`sapu:nemesis`), pixel-diff visual testing, replacing the
repo's own E2E suite.

## 4. Overview

| # | Unit | Does | LLM tokens |
|---|---|---|---|
| 1 | `argus-live.mjs up` | allocate ports, reset disposable data, start the app, log every role in | none |
| 2 | Journey map | `.argus/journeys.json`: journeys built from code (momus's business-process map when present) | one agent, only when stale |
| 3 | SELECT / CHARTER | argus picks the least-covered journey cells and writes a journey charter | orchestrator |
| 4 | `sapu:ui-explorer` | walks one journey as every role it needs; returns candidates with trails and repro steps | one agent per journey |
| 5 | `argus-live.mjs repro` | re-runs a candidate's repro across role sessions; exit code = reproduced or not | none |
| 6 | MINIMIZE / TRIAGE / REPORT | argus's existing gates and issue template, plus §10 | orchestrator |
| 7 | `argus-live.mjs down` | stops only what `up` started | none |

The relationship to sapu does not change: argus files issues, `/sapu:sapu` works them.

## 5. Sources of truth

- **What exists now** = the running system and its code: routes, permission checks, status enums
  and transitions, seed data.
- **What was intended** = docs (`business_truth.docs`, product and design docs, user guides). They
  supply the *goals* a journey's roles pursue, never the verdict on their own.
- **Doc drift.** A candidate whose only grounding is a doc that contradicts coherent system
  behaviour (no Class A defect in that path) is checked with one discriminating observation: the
  last commit touching the doc versus the last commit touching the code path. Code newer than the
  doc → filed as a `question` titled `[doc drift] …`, asking whether the doc or the system is
  right; never as `bug`. Doc newer than the code → ordinary Class B(a).
- A journey-lane verdict never rests on "differs from the product doc" alone.

## 6. Journey map

`.argus/journeys.json` (argus state, gitignored like the rest of `.argus/`; the owner may edit it):

```json
{ "head": "<commit the map was built at>",
  "journeys": [{
    "id": "order-to-cash",
    "goal": "a partner's order is paid for, approved, shipped and visible as delivered",
    "steps": [{ "role": "partner", "goal": "place an order for two products" },
              { "role": "sales", "goal": "confirm the order" }],
    "sources": ["<route or service file:line per transition>"],
    "global": false,
    "lastCycle": null } ] }
```

- Built by one `sapu:ui-explorer` call in map mode. Inputs, in order: the newest momus report's
  business-process map (each status-advancing endpoint with its permission is one step; chaining
  the steps of one process gives a journey; the permission names the role), the repo's routes and
  permission checks, the repo's E2E journeys, then docs for the goals.
- Rebuilt when any file in a journey's `sources` changed since `head`; untouched journeys are kept.
- `global: true` marks a journey that changes settings shared by every other journey (master data,
  tax rates, role permissions). Global journeys run alone, after the others.
- Coverage cells in `coverage.json`: `journey:<id> × <oracle>` for the oracles in §7, so SELECT
  ranks journeys with the existing `cycles_since_visit × exposure × commits since last visit` score.

## 7. The explorer: `sapu:ui-explorer`

Agent file `plugins/sapu/agents/ui-explorer.md`: model opus, effort high, tools `Bash, Read, Grep,
Glob, StructuredOutput`. Opus because finding a workflow defect is judgment, not mechanics. It never
edits the repo and never reads `.argus/config.yml` or the auth files (§11).

Charter it receives: `Explore journey <id> / as <roles> / with <goals per role, seed facts> / to
discover <oracles>`, plus the base URL, the session names to use, and the auth-state path per role.

It drives the browser only through the wrapper `node <plugin>/scripts/argus-live.mjs pw -s=<session>
<command>` (§9), whose absolute path the charter gives. It acts as each role in turn, reaching every goal from the role's own
navigation (no typed URLs, except to test a deep link).

**Journey oracles** — each verdict is a measurement, not a feeling (argus: "taste selects the
target; a number files the finding"):

| Oracle | Measured as |
|---|---|
| Handoff signal | after role A's step, is the object in role B's landing page, inbox, badge or notification without a search? Present or absent, plus clicks to reach it |
| Status coherence | the same object's status as rendered to each role at the same moment; equal, or mapped by a written vocabulary |
| Dead end | a non-terminal state where no role allowed by the permission checks has an enabled control that moves it on |
| Reversal | reject or cancel mid-chain: the originator is told, and the reserved resource (stock, credit, quota) is released exactly once on screen and after reload |
| Re-entry | fields a later role must type that an earlier step already captured (count) |
| Discoverability | the goal needed knowledge the screen never gave: no visible control on the role's path leads there (the steps tried are listed) |
| Interrupted flow | back, reload or double-submit at each step |
| Viewport and locale | the journey's critical step repeated at each `viewports` width and in each `locales` locale |

Throughout: console errors and 4xx/5xx responses (`pw console`, `pw requests`) for every step.

**Token discipline.** Read the page with `pw find` or `pw snapshot --depth=<n>` first and a full
snapshot only when needed; batch several `pw` calls in one Bash call; screenshots only as evidence
for a candidate. The guard's step budget and handoff apply as for any sapu agent.

**Before calling something a defect**, the explorer runs argus's three hypotheses: H2 (its own
harness — wrong role, expired session, missing seed) and H3 (intended: the permission checks say
this role may not do it, so "cannot find it" is not discoverability).

**Return (schema):** `{ journey, roles, steps: [{role, action, code, saw}], candidates: [{claim,
oracle, class: "A"|"B"|"drift", roles, observed, expected, repro: [{role, code}], screenshots[],
h2h3}], coverage: {oracle: "held"|"failed"|"not-tested"}, harness_failures, notes }`. `code` is the
Playwright line the CLI printed for that action. A candidate is never a finding (argus §3).

## 8. Live setup

New block in `.argus/config.yml`, written by `/sapu:init`:

```yaml
app_under_test:
  live:
    start:
      - name: api
        cmd: "npm run dev"
        env: { PORT: "{port:api}" }
        health: "http://localhost:{port:api}/health"
      - name: web
        cmd: "npm run dev:web"
        env: { PORT: "{port:web}", API_PORT: "{port:api}" }
        health: "http://localhost:{port:web}/"
    base_url: "http://localhost:{port:web}"
    login_url: "/login"
    env: { DATABASE_URL: "${EXPLORE_DATABASE_URL}" }   # applied to every start command and to reset
    reset: "npm run db:reset:explore"
    mocks_confirmed: true
test_accounts:            # existing block; per account, optionally:
  <role>: { login: form | command, command: "<prints a storage-state path>", totp_secret: "…" }
limits:
  max_parallel_journeys: 2
  live_health_timeout_s: 120
```

`argus-live.mjs up` (no LLM, every step logged to `.argus/live/logs/`):
1. Refuses unless `reset` is set and `mocks_confirmed` is true (the owner's statement that every
   outbound integration — payments, email, messaging, identity checks — runs in test or mock mode
   under `env`; a browser cannot see server-side calls, so this is the owner's to confirm).
2. Allocates free ports for each `{port:<name>}`; a fixed port in the config that is taken →
   refuse, naming the process holding it.
3. Refuses a `base_url` whose host is not `localhost`, `127.0.0.1`, `[::1]`, `*.localhost` or `*.test`.
4. Expands `${NAME}` from its own environment, never printing the values. Runs `reset`, then each
   `start` command with `env`, waits for each `health` (`limits.live_health_timeout_s`, default 120).
5. Logs every account in: `form` = open `login_url`, fill the fields labelled user/email and
   password, submit, wait for the URL to leave `login_url`, then `state-save`; `command` = the
   repo's command prints a storage-state path; `totp_secret` fills a one-time code field.
   State files: `.argus/live/auth/<role>.json`.
6. Writes `.argus/live/run.json`: pids, ports, base URL, session prefix (`<cycle>-`).

`down` kills only the pids in `run.json`, closes only sessions with its prefix, and leaves data in
place for the next reset. Argus's "never start or stop the servers yourself" rule stays for the
owner's servers; with `app_under_test.live` configured, argus starts and stops its own isolated
instance instead of going static. Without `live`, argus behaves exactly as today and the journey
lane is not selectable.

Separate ports and a separate database also let a journey cycle run while a sapu sweep uses the
repo's own E2E ports and database; `max_parallel_journeys` bounds the CPU taken from its gates.

## 9. Browser driver

`@playwright/cli` (Microsoft's agent-oriented CLI), run as `npx -y @playwright/cli@<pinned>` by the
`argus-live.mjs pw` wrapper, which also: rejects a non-local URL in `open`, `goto` and `tab-new`;
requires the run's session prefix; and runs the CLI from `.argus/live/<cycle>/` so its snapshot
and console files stay out of the work tree. The app's own stack is irrelevant: the repo needs no
Playwright.

Probed live with 0.1.22: headless start in about 4 s; named sessions isolated (cookies and
localStorage of one invisible in another, three opened in parallel); `state-save` → `state-load`
into another session carries cookies and localStorage; `console` and `requests` report JS errors
and 404s; `resize` works; each action returns 300–500 characters and writes the snapshot to a file;
each action prints its Playwright code; `run-code` exits 0 when the snippet passes and 1 when it
throws. A dense data-table page snapshot measured 21.7 KB in full, 4 KB at `--depth=6`, 0.5 KB for
`find`. Defaults to the installed Chrome; `up` checks a browser exists and names the install
command when it does not.

## 10. Candidate → finding

Argus's cycle, gates and issue template apply unchanged. Additions:

- **Repro re-run by the orchestrator** (the hard block `repro re-run = n` stays):
  `argus-live.mjs repro <candidate.json>` opens a fresh session per role, loads its auth state, and
  runs the candidate's `repro` steps in order with `run-code`. The last step throws `REPRO: <what was
  observed>` when the defect shows. Exit 1 = reproduced. Run twice for `Reproduced: N of M`.
  Each repro creates its own records with a unique marker, so parallel journeys and the seed stay
  untouched.
- **Minimize** = drop one repro step or role at a time and re-run the script; no browser work in the
  orchestrator's context.
- **Classes and labels** (argus's own): a broken behaviour → Class A, `bug`. A workflow defect
  with a written rule → Class B(a), `class:business` + `workflow`. Without a written rule → Class
  B(b): title `[no rule exists]`, label `question`, body opens with "Is this intentional?" and cites
  the external heuristic. New citable source in `standards.md`: Nielsen's 10 usability heuristics
  (NN/g), e.g. "Visibility of system status" for a missing handoff signal. UX on a single screen →
  `ux`. Doc drift → `question` (§5). All carry `argus` and `found-by:user`.
- **Owner acceptance.** `/sapu:sapu` does not work an issue labelled `question` until the owner
  removes the label: this release names `question` in B2's SKIP list next to the parked, blocked,
  wontfix and discussion labels.
- **One defect per issue** (gate 4) and `max_issues_per_cycle` with its `[queue]` overflow issue,
  as today.
- **Issue body additions:** journey id and the roles involved; the trail — per step: role, action,
  Playwright line, what the user saw, with a screenshot at the failing step; the repro as a
  runnable `[{role, code}]` list a sapu worker turns into a RED test; for status coherence, one
  screenshot per role.

## 11. Guard changes (`sapu-guard.mjs`)

For `sapu:ui-explorer`:
- refuse any read of `.argus/live/auth/**` and `.argus/config.yml` — Bash readers, `Read`, `Grep`,
  `Glob`;
- allow those auth paths only as the argument of `argus-live.mjs pw … state-load`;
- refuse direct `playwright-cli` or `npx @playwright/cli` (the wrapper is the only way in);
- refuse writes outside `.argus/live/`.

## 12. Errors

| Event | Response |
|---|---|
| `up` fails (port taken, database down, migration or reset fails, health timeout) | charter aborted with the step's name and the tool's own error quoted; argus picks another lane; the owner's servers untouched |
| Session expired mid-journey | explorer reloads the role's state; a failed login → `up` logs that role in once more; still failing → harness failure (H2), not a candidate |
| Goal cannot be reached | permission checks say the role may not → not a candidate; they say it may → discoverability candidate |
| A precondition is missing | created through the UI by a role allowed to; otherwise the charter is re-scoped (argus's standing order) |
| Browser or CLI session dies | reopened; the explorer resumes from its last trail step; counted in `harness_failures` |
| Cycle ends, by success or error | `down` always runs |

## 13. Cost

Estimates from the probe and `sapu-metrics` prices, to be replaced by pilot measurements:
- Explorer, one journey, Opus/high, about 100 steps at an average context near 100K: **$4–5**
  (cache reads about $2, output about $1.6, cache writes about $0.9).
- Map rebuild: one explorer call in map mode, only when sources changed.
- Repro, minimize, `up`, `down`: no LLM tokens.
- Reference point: a sapu PR in the latest sweep cost $6.45.

## 14. Testing

- `tests/argus-live.test.ts` against a fixture app in `tests/fixtures/journey-app/` (a small Node
  HTTP server: two roles, a login form, a three-step flow with one seeded missing-handoff defect).
  Covers: `up` refusals (no `reset`, no `mocks_confirmed`, non-local `base_url`, a taken fixed port);
  start, health and timeout; form login → storage state that authenticates; session isolation;
  `repro` exits 1 on the seeded defect and 0 on the fixed variant; `down` kills only its own pids;
  a temporary repo's `git status` is clean after a full run (nothing outside `.argus/`). Runs in
  CI with a browser; no LLM.
- `tests/sapu-guard.test.ts`: the §11 rules, blocked and allowed.
- `tests/engine.test.ts`: the new files are English and name no repo; a size budget for
  `journeys.md`; argus SKILL.md grows only by its pointer to the lane.
- Acceptance: the pilots in §15.

## 15. Rollout

- **Pilot 1**, the repo argus has run on longest: three journeys — one cross-role money journey
  under separation of duties, one partner self-serve journey at phone width, one internal approval
  journey. Repo-side prep, through that repo's normal PR flow: a reset command for an explore
  database, and the `live` block.
- **Pilot 2**, a repo on a different stack (proposed: Firstop, Next.js and Prisma; the owner
  decides, and it needs `/sapu:init`). Pass = no engine change needed beyond config. An engine
  change found there is made in the engine, and pilot 1 is re-run.
- **Scorecard per pilot:** $ and minutes per journey; raw candidates; reproduced candidates; filed;
  duplicates; the owner's verdict on each filed issue; false positives later recorded by argus's
  fix-PR loop.
- **Continue** when at least 90% of filed issues are judged real and the cost per real finding is
  below the cost of one sapu PR. **Stop or redesign** below that: a noisy explorer costs more in
  wasted fix lanes than it finds.

## 16. Changes by file

| File | Change |
|---|---|
| `plugins/sapu/skills/argus/SKILL.md` | the `journey` lane in SELECT; the live rule amended (§8); a pointer to `journeys.md` |
| `plugins/sapu/skills/argus/journeys.md` | new: map, charter, oracles, explorer brief, filing additions |
| `plugins/sapu/skills/argus/reference.md` | §4.1 note: UI journeys complement the HTTP rule; §9 state: `.argus/live/`, `journeys.json` |
| `plugins/sapu/skills/argus/standards.md` | Nielsen's 10 usability heuristics |
| `plugins/sapu/agents/ui-explorer.md` | new agent |
| `plugins/sapu/scripts/argus-live.mjs` | new: `up`, `down`, `status`, `pw`, `repro` |
| `plugins/sapu/scripts/sapu-guard.mjs` | §11 rules |
| `plugins/sapu/skills/init/SKILL.md` | asks for the `live` block, the login method per account, `mocks_confirmed` |
| `plugins/sapu/skills/sapu/SKILL.md` | `question` in B2's SKIP list (§10) |
| `tests/…` | §14 |
| `docs/usage.md`, `docs/agents.md` | the lane, the new agent, the requirements |

## 17. Owner decisions

1. Pilot 2 repo: Firstop, or another repo on a different stack.
2. Pilot budget: about $20–35 for pilot 1's three journeys, measured and reported before pilot 2.
