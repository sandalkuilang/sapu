# Argus journey lane (`/sapu:journey`) — design spec

Status: draft for owner review. Revised after two review rounds (architecture, adversarial QA) and
three research passes (prior art, test oracles, Playwright CLI and agent safety). Target release:
sapu 2.9.0.

## 1. Problem

The owner wants an agent that uses an app the way its users do — every role, end to end — and
reports bugs, UI defects and **workflow** defects: how a piece of work passes from one role to the
next, where it gets stuck, where users get lost. It must work on any repo with a web UI, whatever its
language or framework.

## 2. What exists, and the gap

`sapu:argus` already is an autonomous QA operative: charters, the law of evidence, refute-by-default,
minimize-before-filing, fingerprints, coverage rotation, Workflow fan-out, and the Council of Five
(User, PM, Senior QA, Auditor, Curator) with its operator-realism and cold-start oracles. On the repo
it has run on longest it logged 97 cycles and filed 181 issues. A separate "explore" system would
duplicate all of it. This spec **extends argus** instead.

| Gap | Evidence |
|---|---|
| Workflows are never experienced through the UI | reference.md §4.1 drives workflow conformance "over HTTP, never through the UI". Argus proves a flow is *correct*; nothing checks that each role can *carry it through*: handoff signals, status coherence across roles, dead ends, discoverability. 10 of those 97 cycles mention a journey or handoff at all. |
| Cycles fall back to static when the owner's servers are down | 10 logged cycles ran `mode=static` (severity capped at S3, Curator and cold-start walk off); argus may not start servers. One UX sweep was re-scoped for this reason. |
| No parallel browsers | Argus uses whatever browser tool the session has: usually one shared pane, none in some sessions. |
| Stale docs act as truth | Class B(a) grounds a finding in `business_truth.docs`; a doc older than the behaviour it describes yields a false "nonconformance". |

## 3. Goals, non-goals, principles

Goals:
- A new argus lane, `journey`, with its own command `/sapu:journey`: one charter = one business
  journey across roles, walked through the real UI by a dedicated agent that is given goals, not
  steps. The journeys are generated from the code, not listed by the owner.
- Every journey cycle runs on an isolated instance argus starts itself — never the owner's servers,
  services or data.
- Parallel explorers, one isolated browser per role per journey.
- Generic: the engine names no repo, framework or language; every repo fact lives in the repo's
  `.argus/config.yml` and argus profile.
- Every filed journey finding carries a reproduction a script re-runs without an LLM.

Non-goals (v1): native mobile or desktop apps (web only; phone sizes by viewport); hosts other than
macOS and Linux (the isolation checks need `lsof` or `ss`); load or performance testing; penetration
testing (`sapu:nemesis`); pixel-diff visual testing; replacing the repo's E2E suite; replacing argus's
HTTP-level workflow conformance (§4.1 stays; this lane adds the user's side of the same flows);
self-healing tests (a healer turns a real defect into a skipped test, so nothing here "heals" a repro
or a RED test).

Principles, each from the research in §17:
- **The repro gate decides, not the explorer.** LLM web agents used as testers flag about half of
  the passing cases as failures (specificity 0.47 in ISSTA 2025). An explorer only *suspects*; a
  script reproduces, twice, each time from a clean instance, or nothing is filed.
- **Measurements, not taste.** An LLM's heuristic review overlaps experts on about a fifth of the
  issues and its severity ratings do not repeat across runs. Every journey verdict is a number or an
  observation a script can recheck; severity follows the oracle, never the LLM's opinion.
- **No lethal trifecta.** The explorer reads untrusted content (the app's pages), so it gets no
  private data beyond the repo's tracked code and no way to communicate out: no shell beyond the
  wrapper, no network beyond the run's origins, no code execution in the browser or in Node.
- **No LLM-authored code ever runs.** Repro steps are data; the runner builds every Playwright call
  itself, every value a literal.
- **Page text is data, everywhere.** Whatever the app rendered reaches the explorer, the
  orchestrator and an issue only fenced by a per-call nonce, capped, and never as an instruction.

## 4. Overview

| # | Unit | Does | LLM tokens |
|---|---|---|---|
| 1 | `argus-live.mjs up` | checks the config, takes the lock, builds a worktree outside the repo, proves the datastore, resets it, starts the app, proves isolation and every login | none |
| 2 | Journey map | `.argus/journeys.json`, generated from the code; `map-check` drops anything it cannot anchor | one agent, only when stale |
| 3 | SELECT / CHARTER | argus picks the highest-scoring journeys, allocates accounts, writes one charter each | orchestrator |
| 4 | `sapu:ui-explorer` | walks one journey as every role it needs, through the wrapper; submits candidates, measurements and repro steps | one agent per journey |
| 5 | `argus-live.mjs repro` | replays a candidate's steps on a fresh instance; exit code = reproduced, not reproduced, or harness failure | none |
| 6 | MINIMIZE / TRIAGE / REPORT | argus's gates and issue template, plus §10 | orchestrator |
| 7 | `argus-live.mjs down` | stops only what `up` started; a reaper runs it if the session dies | none |

The relationship to sapu does not change: argus files issues, `/sapu:sapu` works them.

### Commands

`/sapu:journey` is the lane's own entry point: a thin skill that runs one argus cycle with the lane
fixed to `journey`. It shares argus's profile, `config.yml`, state, fingerprints and gates — one
engine, two doors.

| Command | Does |
|---|---|
| `/sapu:journey list` | builds or refreshes the catalog (§6) and prints it; explores nothing, starts no app. `list --rebuild` rebuilds even when nothing changed |
| `/sapu:journey` | explores on its own, never stopping to ask: refreshes the catalog in the background (one summary line, e.g. `catalog: 14 journeys, 2 new, 1 dropped`) while `up` starts the app, then one cycle — SELECT picks the highest-scoring journeys, up to `limits.max_parallel_journeys`, within `limits.max_cycle_minutes`; ends with the report and the next picks |
| `/sapu:journey <id> [<id>…]` | one cycle on the named journeys (argus prints what they displaced) |

One invocation = one bounded cycle; a whole-catalog pass is that many invocations. Each run prints
the command that opens the CLI's live session dashboard, for an owner who wants to watch.

### Entry points, policy, versions

- **Every path into the lane** runs `sapu-contract.mjs allowed argus` and `allowed journey` first:
  `/sapu:journey`, and argus's SELECT before it ranks any `journey:` cell (argus run from the main
  session with `.argus/live.json` configured). In 2.9.0 the `/sapu:inspector` workflow's argus
  phase excludes the lane: it runs only from the main session.
- `journey` joins `SKILLS` in `sapu-contract.mjs`. An explicit `policy.skills` list without `journey`
  means not allowed; the 2.9.0 upgrade note tells the owner to re-run `/sapu:init`'s skills question.
- Version coupling (CONTRACT.md): `journey` in `policy.skills` and `labels.needsOwner` need plugin
  ≥ 2.9.0 — an older plugin rejects the contract.
- The policy's `fileIssues` and `traces` govern journey filing as they govern argus's.
- Only the journey lane uses the isolated instance; every other argus lane keeps today's live/static
  rule against the owner's servers, unchanged.

### A journey cycle in argus's phases

The phase table lives in `journeys.md`; argus SKILL.md §3 gains one sentence pointing to it. ORIENT,
INTAKE, TRIAGE, REPORT, PERSIST and ROTATE are unchanged plus §5 and §10; SELECT ranks
`journey:<id> × <oracle>` cells (§6); CHARTER writes one charter per journey (§7); EXECUTE and
OBSERVE are the explorers; MINIMIZE is the repro runner (§10). A journey cycle does not owe the
per-cycle work argus sets for its HTTP lanes: the Auditor's fraud pass, the Curator's census, corpus
replay, the metamorphic and operator-realism minimums, cold-start walks. §8 Done (c) reads "the
explorers' coverage map" for a journey cycle, and its `run.log` line writes
`mode=live focus=journey:<ids> fraud=-`. Those passes keep running in argus's other cycles.

## 5. Sources of truth

- **What exists now** = the running system and its code: routes, permission checks, status enums and
  transitions, seed data.
- **What was intended** = docs (`business_truth.docs`, product and design docs, user guides). They
  supply the *goals* a journey's roles pursue, never a verdict on their own.
- **Doc drift.** A candidate whose only grounding is a doc sentence that contradicts coherent
  behaviour (no Class A defect on that path) is decided at TRIAGE by line-level history:
  `git blame --porcelain -L <a>,<b> -- <doc>` for the sentence against the same on the code lines
  that implement the observed behaviour (from the journey's step anchors). Code newer → a
  needs-owner issue asking whether the doc or the app is right (§10); doc newer → ordinary Class
  B(a); undecidable (no history, generated code) → needs-owner.
- **Process vocabulary at TRIAGE.** A *model move* (a map step no allowed role could do through the
  UI) is a dead end, an unreachable step or a discoverability candidate; a *log move* (the UI let a
  role do what the permission checks forbid) is argus §4.1's forbidden transition, with UI evidence.

## 6. Journey map

`.argus/journeys.json` — argus state, gitignored like the rest of `.argus/` (only `config.yml` is
tracked); the owner may edit it:

```json
{ "head": "<commit the map was built at>",
  "roots": ["<route, permission, status-enum, scheduler, queue and webhook entrypoint files or directories>"],
  "dropped": [{ "id": "<id>", "reason": "<map-check reason>", "head": "<commit>" }],
  "journeys": [{
    "id": "order-to-cash",
    "domain": "sales",
    "title": "Order to cash",
    "money": true,
    "global": false,
    "goal": "a customer's order is paid for, approved, shipped and visible as delivered",
    "steps": [
      { "role": "customer", "route": "/orders/new", "goal": "place an order for two products",
        "sources": [{ "file": "<path>", "line": 120, "text": "<16+ non-space characters on that line>" }] },
      { "role": "system", "trigger": "payment-settles", "goal": "the payment settles",
        "sources": [{ "file": "<path>", "line": 88, "text": "<…>" }] } ],
    "lastCycle": null } ] }
```

- **Built by** one `sapu:ui-explorer` call in map mode (brief in `journeys.md`), returned through the
  wrapper's `submit`; the orchestrator writes the file. Steps come from the repo's routes and
  permission checks; each `live.roles.<r>.code_role` (§8) names the role in the code's own
  role → permission source, through which the map agent maps a permission to a role. The newest
  momus report's flagged business-process rows raise a journey's priority (below); they are not the
  step list. Docs supply the goals.
- **Reserved roles.** `anon` (never signed in) and `system`: a transition driven by a scheduler,
  webhook, queue or expiry is a step with `"role": "system"` and the `trigger` that `live.triggers`
  runs.
- **`map-check`** (no LLM) drops a journey with any failing step, printing the reason:
  - every `text` has 16+ non-space characters, occurs in its `file` at HEAD and at most 3 times
    there (`line` is moved to the nearest occurrence);
  - a user step's role is a key of `live.roles` (skipped, and the catalog marked `roles unchecked`,
    when there is no `live` block), it has a `route`, and at least one of its anchors lies in a route
    or permission file among `roots` and contains the route's last path segment in its `file` path
    or its `text`;
  - a `system` step's `trigger` is a key of `live.triggers`, and its anchor lies anywhere under
    `roots`;
  - ids are unique.
- **Refresh** when `git diff --name-only --diff-filter=ADR <head>..HEAD` adds, deletes or renames a
  file under `roots`, when a momus report is newer than `head`, when `head` is no longer in the
  history, when `map-check` drops a journey not already in `dropped` at the current head, or on
  `list --rebuild`. Modified files only re-run `map-check`. A refresh adds and updates journeys and
  keeps the rest; a journey dropped again at the same head triggers nothing more.
- **Ids** are kebab-case English, named after the process in the code, and stable: a refresh never
  renames one, so coverage history stays attached. An owner rename starts that journey's coverage
  fresh. **Titles and domains** are in the language CLAUDE.md sets for people; domains come from the
  code's own module names.
- **`global: true`** marks a journey that changes settings every other journey depends on (master
  data, rates, permissions). A cycle that selects a global journey selects only that one.
- **SELECT score** per journey: `cycles_since_visit × exposure × (1 + commits touching its anchor
  files since its last visit)`, with exposure 2 for `money: true` and 1 otherwise, doubled when a
  momus report flagged one of its steps' endpoints. Coverage cells in `coverage.json`:
  `journey:<id> × <oracle>` for the oracles in §7.
- **Accounts.** SELECT allocates accounts before launch: no account serves two journeys in one cycle
  (shared inboxes and single-session apps would corrupt both); a journey needing two accounts of one
  role (claim race) gets two; a journey whose accounts cannot be allocated waits for a later cycle.
- **Catalog output** (`/sapu:journey list`): journeys grouped by domain; per journey the id, title,
  role chain, `money` and `global` flags and coverage (last cycle, findings filed); then the dropped
  journeys with their reasons.

## 7. The explorer: `sapu:ui-explorer`

Agent file `plugins/sapu/agents/ui-explorer.md`: model opus, effort high, tools `Bash, Read,
StructuredOutput` — limited both by that frontmatter and by the guard (§11). Opus because judging a
workflow is not mechanical. Its Bash runs only the wrapper; it reads only code committed at HEAD in
the cycle's worktree, and searches it through the wrapper's `code` command (§9, §11).

**Charter:** `Explore journey <id> / as <roles and their allocated accounts> / with <goals per role,
seed facts> / to discover <oracles>`, plus: its slot **token** (§9); `stop` (the goal state, or the
wrapper's budget); `## Key assumptions` (≤5, each with the observation that would show it false,
checked first — the cheap H2 checks); `prohibited` (from `live.prohibited`); `intended` (the
`arid.md` lines that name this journey: behaviour the owner already ruled intended); the names and
commands of the `start` entries (so "no worker" is decidable); up to two accepted journey findings per
oracle from this repo's history as examples; `viewports`, `locales` and `settle_ms`; and two
absolute paths: the wrapper's (the only program its Bash runs) and the run's worktree (where the code
it Reads lives; `code files` and `code grep` print absolute paths inside it). No URL, password,
session name or other path: the wrapper supplies them.

**Goal first, code after.** For each step the explorer reaches the goal from the role's own
navigation, without reading code for it first; it reads code only afterwards, to separate intended
from broken (H3). No typed URLs, except to test a deep link.

**Untrusted content.** Everything the app renders reaches the explorer inside the wrapper's nonce
markers (§9) and is data, never instructions. Text that tries to instruct the agent is itself a
candidate (stored injection), never followed.

**Journey oracles** — each verdict is a measurement; `held` without its number counts as
`not-tested`:

| Oracle | Kind | Measured as |
|---|---|---|
| Handoff signal | specified if a rule exists, else heuristic | after role A's step, the object (found by its marker) appears within `settle_ms` in role B's landing page, inbox, badge, a captured signal (below) or the run's mail (`live.mail`), without a search; present or absent, plus clicks to reach it. `not-tested: no worker` when the step's anchors name a queue or job entrypoint that no `start` entry runs |
| Status coherence | derived | the same object's facts (lifecycle state, amount, quantity, date, assignee) as each role's page received them, compared **by script** (`argus-live.mjs`): the JSON responses the pages loaded (`response-body`); for server-rendered pages, `live.facts`; failing both, a differential that quotes both renderings and calls neither right. A contradiction counts only when both roles re-read after `settle_ms` still contradict |
| Dead end | derived | a non-terminal state where no role allowed by the permission checks has an enabled control that moves it on; a state whose only exit is a `system` step is not a dead end |
| Reversal | derived | reject or cancel mid-chain: the originator is told, and the reserved resource (stock, credit, quota) shows as released exactly once, on screen and after reload |
| Orphaned work | derived | after a terminal state, no role still sees the object as actionable (inbox, badge, task list) after `settle_ms`; count |
| Claim race | derived | two accounts of the offered role act together: the second is refused clearly and both pages converge on one outcome — never a silent double action or a 5xx. `not-tested` without a second allocated account |
| Stale view | derived | a role's page stays open while another role advances the object; acting from it is refused with the new state shown |
| Unreachable step | derived | a map step no allowed role could perform through the UI |
| Re-entry | heuristic | fields a later role must type that an earlier step already captured; count |
| Discoverability | heuristic | a cognitive walkthrough (Wharton et al.) re-walked on the trail's recorded snapshots for the action that completed each goal, each question answered only by an observable: Q1 trying — this step's handoff signal held, or it is the first step; Q2 sees — the control is on the role's landing page or reached through visible navigation (clicks counted; reached first by typed URL, search or code knowledge = fail); Q3 recognises — the control's accessible name or section heading uses a term the app itself showed for this goal; Q4 feedback — within `settle_ms` the page names the new state. Reaching the goal is not evidence; code knowledge never answers a question |
| Interrupted flow | implicit | back, reload or double-submit at each step: no 5xx, no duplicate record |
| Viewport and locale | derived | the journey's critical step repeated at each `viewports` width and each `locales` locale |

`blocked` (with its reason) marks what cannot be tested here — a `mailto:` link, printing, an OS
dialog — distinct from `not-tested`. Throughout, for every step: console errors and 4xx/5xx
responses. **Absence is never instant:** anything judged missing is waited for up to `settle_ms`.
**Short-lived signals** (toasts, `role=status`/`alert`, `aria-live` regions, Notification calls) are
captured by an init script installed in every page and popup, which logs each to the console; the
wrapper reports the new ones after every command, so a toast gone before the next snapshot is seen.

**Token discipline.** Read the page with `find` or `snapshot --depth=<n>` first and a full snapshot
only when needed; several `pw` calls per Bash call; screenshots only as evidence for a candidate.

**Before calling something a defect:** argus's three hypotheses — H2 (its own harness: wrong role,
session lost, missing seed, another journey's records) and H3 (intended: the permission checks say
this role may not, so "cannot find it" is not discoverability; or an `intended` line covers it).
Actions outside the charter's goals are marked `off-goal` in the trail.

**Budget, loops, handoff.** The wrapper enforces them per token (the guard's step budget covers only
sapu's worker agents): past `limits.explorer_pw_calls` every `pw` answers `BUDGET: submit status
handoff` without acting; the same command on the same snapshot three times answers `LOOP: submit
status handoff`; past the cycle deadline, `DEADLINE: submit status aborted`. On a handoff the
orchestrator mints a new token for the slot (the old one retires; the new one has a fresh budget)
and starts a fresh explorer with the submitted trail; the browser sessions stay open, so it continues
where the first stopped. At most two handoffs per journey.

**Return.** The explorer submits its result through the wrapper (`pw <token> submit <json>`), which
validates it against the schema, caps every free-text field at 500 characters, and writes
`.argus/live/<run>/returns/<slot>.json`; its StructuredOutput is only `{status, slot}`. Schema:
`{ journey, status: "done"|"handoff"|"aborted", roles, steps: [{role, action, locator, saw,
off_goal}], created: [markers], values: [{marker, field, role, value, from}], candidates: [{claim,
oracle, measured, roles, observed, expected, repro, screenshots[], h2h3}], cw: [{step, q1, q2, q3,
q4}], coverage: {<oracle>: "held"|"failed"|"not-tested"|"blocked"}, harness_events, next, notes }`.
The orchestrator reads it only through `argus-live.mjs intake <slot>`, which prints every free-text
field inside a fresh nonce fence, as data. A candidate is never a finding (argus §3).

## 8. Live instance

New file `.argus/live.json`, written by `/sapu:init` and tracked beside `config.yml`. It is JSON
because the plugin has no dependencies to parse YAML; argus's `config.yml` and its free-form
`test_accounts` block stay as they are, and `roles` here is the explicit per-role map this lane
needs. Below, `live.<key>` names a key of this file and `limits.<key>` a key of its `limits` object
(`max_cycle_minutes` included: the lane does not read `config.yml`). `{port:<name>}` and `${NAME}`
expand in every string of the file. Its schema is validated by `argus-live.mjs` (unknown keys are
errors, as in the sapu contract).

```json
{
  "setup": [["npm", "ci"]],
  "services": { "db": { "env": "DATABASE_URL" }, "cache": { "env": "REDIS_URL" }, "mail": { "env": "SMTP_URL" } },
  "start": [
    { "name": "backing", "phase": "store", "cmd": "docker compose up postgres redis mailpit",
      "stop": "docker compose down -v", "health": { "cmd": "docker compose exec -T postgres pg_isready" } },
    { "name": "api", "cmd": "npm run dev -- --port {port:api}", "health": { "url": "http://localhost:{port:api}/health" } },
    { "name": "web", "cmd": "npm run dev:web -- --port {port:web}", "env": { "API_URL": "http://localhost:{port:api}" },
      "health": { "url": "http://localhost:{port:web}/" } },
    { "name": "worker", "cmd": "npm run worker" }
  ],
  "base_url": "http://localhost:{port:web}",
  "login_url": "/login",
  "logged_in": "getByRole('button', { name: 'Account' })",
  "env_file": ".argus/live.env",
  "env": {
    "DATABASE_URL": "postgres://app:${DB_PW}@localhost:{port:pg}/app_explore",
    "REDIS_URL": "redis://localhost:{port:redis}", "SMTP_URL": "smtp://localhost:{port:smtp}",
    "PG_PORT": "{port:pg}", "REDIS_PORT": "{port:redis}", "SMTP_PORT": "{port:smtp}"
  },
  "pass_env": [],
  "store": "app_explore",
  "store_check": "npm run -s explore:which-db",
  "reset": "npm run -s db:reset:explore",
  "facts": { "argv": ["npm", "run", "-s", "explore:facts", "--", "{1}"], "args": ["^[A-Za-z0-9._:-]{1,128}$"] },
  "mail": { "argv": ["npm", "run", "-s", "explore:mail"] },
  "triggers": { "payment-settles": { "argv": ["npm", "run", "-s", "explore:settle", "--", "{1}"], "args": ["^[A-Za-z0-9-]{1,64}$"] } },
  "confirmed": { "mocks": true, "data": true },
  "allow_origins": [],
  "port_range": [41000, 41999],
  "reserved_ports": [3000, 4000, 5432, 6379],
  "login_spacing_ms": 0,
  "timezone": "UTC",
  "locale": "en-US",
  "fixtures": "test/fixtures/explore",
  "roles": {
    "anon": {},
    "customer": { "code_role": "partner", "users": [{ "user": "buyer1@example.test", "password": "${PW}" }, { "user": "buyer2@example.test", "password": "${PW}" }] },
    "sales": { "code_role": "sales", "users": [{ "user": "sales1@example.test", "password": "${PW}", "totp_secret": "${SALES_TOTP}" }] },
    "admin": { "code_role": "admin", "login": { "command": "npm run -s explore:login -- admin" } }
  },
  "viewports": [1440, 390],
  "locales": [],
  "settle_ms": 10000,
  "prohibited": [],
  "limits": { "max_cycle_minutes": 45, "max_parallel_journeys": 2, "live_health_timeout_s": 120, "explorer_pw_calls": 120, "minimize_runs": 12 }
}
```

Field notes: `setup` holds argv lists run in the worktree without a shell; `services` lists every
backing service the app reads; a `start` entry with `"phase": "store"` starts before `store_check`
and `reset`, and one without `health` counts as healthy when alive after 5 s; `logged_in` is visible
only when signed in; `env_file` is the only source of `${NAME}` and is gitignored; `store` is the one
datastore `reset` may touch, and `store_check` prints the store the app's own configuration resolves
to; `mail` prints `[{to, subject, text}]` as JSON; `allow_origins` are full origins pages may load
from (a font CDN); `reserved_ports` are the repo's dev and E2E ports, never allocated; `fixtures` holds
the files `upload` may use; each role may also set `base_url`, `login_url`, `logged_in`,
`login_open`.

`confirmed` is the owner's statement, asked by `/sapu:init` in these words: `mocks` — every outbound
integration (payments, email, messaging, identity checks) runs in test or mock mode under `env`,
because a browser cannot see server-side calls; `data` — the data `reset` creates is synthetic (no
real personal or business data), so screenshots and page text may appear in issues. `/sapu:init`
also lists the tracked config files and code defaults that name a local service (a cache, queue,
object store, search engine, mail server) and asks for each one's isolated address under `services`.

**Role names** match `^[a-z][a-z0-9_-]*$` (no `.`: `<role>.<n>` names an account); `anon` and
`system` are reserved. Tools outside the guard's hook matcher (WebFetch, WebSearch, Skill and the
like) are kept from the explorer by its frontmatter alone, which an engine test pins.

**The run's origins** = the origins of `base_url`, of each `roles.<r>.base_url`, and of every
`{port:<name>}` allocated this run on those URLs' hosts. `allow_origins` entries are full origins
(`scheme://host:port`), never bare hosts.

**`argus-live.mjs up`** (no LLM; every step logged to `.argus/live/logs/`):
1. **Lock.** Takes `.argus/live/lock.json` (run id, unique per run; deadline = start +
   `limits.max_cycle_minutes` + 15 min) and, before any setup or install, appends `<run id> start
   <epoch> deadline <epoch>` to `<MAIN>/.git/sapu-live.log` (epoch seconds, like every time in that
   log). Every exit of `up` that fails after this line appends `<run id> end <epoch>`. A lock whose
   deadline has not passed → refuse: another cycle is running; it is never
   "recovered". A lock past its deadline → recovery first: each recorded stop replayed exactly as
   recorded (`{cmd, cwd, env}`; one whose cwd is gone or whose env lacks its `COMPOSE_PROJECT_NAME`
   is journalled, never run), each process group whose recorded command line still matches, each
   recorded CLI session by name, the proxy, the worktree.
2. **Refusals**, each naming its cause: no `reset`, `store` or `store_check`; a `confirmed` value not
   true; no `logged_in`; an unset `${NAME}` (its value never printed); a host in `base_url` or a
   `roles.<r>.base_url` that does not resolve to loopback (as nemesis requires);
   `~/.playwright/cli.config.json` present (the CLI merges it underneath ours); no Chrome-family
   browser (the install command named); the pinned CLI not installable (offline, empty npm cache);
   neither `lsof` nor `ss` available.
3. **Environment.** Every command gets only `PATH`, `USER`, `SHELL`, `TMPDIR`, `LANG`/`LC_*`, the
   names in `pass_env`, `env`, `COMPOSE_PROJECT_NAME=argus-<run>`, and `HOME` = an empty per-run
   directory — so no tool picks up the owner's cloud, Git or registry credentials. Anything a tool
   genuinely needs from the owner's home (an npm cache, a Docker config) is named in `pass_env`.
4. **Worktree.** A linked worktree at HEAD **outside** the repo (`$TMPDIR/sapu-live/<repo>-<run>`),
   so no lookup that walks up the directory tree finds the repo's own `.env`. `live.setup` runs in it
   under step 3's environment; afterwards `up` refuses when any symlink in the worktree resolves into
   the repo's main checkout (a dependency directory linked from there would be written by the
   instance).
5. **Ports.** `{port:<name>}` takes a free port from `port_range` outside `reserved_ports` (which
   `/sapu:init` fills with the repo's dev and E2E ports); `{port:<name>=<n>}` fixes one, and a taken
   fixed port → refuse, naming the process holding it. When the worktree has a Compose file,
   `docker compose config --format json` must publish only this run's ports and name no
   `container_name`; otherwise refuse (a fixed host port or container name would collide with, or
   take over, the owner's stack).
6. **Store.** Starts the `phase: store` entries (each in its own process group) and waits for their
   health. Runs `store_check`: its output must equal `store`, and no URL in `env` may equal one in the
   repo's env files (read by the script, never printed) or name the database the contract's
   `guard.postgres` protects. Only then `reset`.
7. **Start.** Each remaining entry in its own process group. Refuse when an entry's health already
   answers before its command ran (something else serves there). Health = `{url}` answering, `{cmd}`
   exiting 0, or, when omitted, the process alive after 5 s; an entry whose process exits before its
   health passes fails `up` unless it has `stop` (a detached starter such as `docker compose up -d`).
   Timeout `limits.live_health_timeout_s`. Then `store_check` again.
8. **Egress check.** Lists the TCP connections of every process in the run's process groups (`lsof
   -nP -a -i -p <pids>`, or `ss`). A connection to an endpoint other than the run's ports, the
   endpoints named in `env`, and `allow_origins` → `down` and refuse, naming the process and the
   endpoint (a code default such as a cache on its standard local port, pointing at the owner's).
   Repeated at every `renew`.
9. **Proxy.** Starts the run's filtering proxy (§9).
10. **Logins.** One proving login per allocated account, sequential, `login_spacing_ms` apart, each
    followed by a check that the browser's requests reached only the run's origins and
    `allow_origins` — any other origin (e.g. a redirect to the owner's own server) → refuse, naming
    it. The proving sessions are then closed.
11. **Run files.** `.argus/live/run.json` (run id, instance id, process groups, stop records, ports,
    origins, worktree, tokens, session names); a detached **reaper** started with the run id,
    which runs `down` at the deadline unless `renew` moved it, and exits without acting when the lock
    names another run.

**`renew`** extends the deadline by `limits.max_cycle_minutes`, never past start + 3 × that + the
same 15 min grace as the first deadline (so a short cycle can still renew), and
appends `<run id> deadline <epoch>` to `sapu-live.log`; the cycle renews after each explorer returns and before each repro. Reaching the cap ends the cycle;
candidates not yet reproduced are journalled `not reproduced: harness`.

**`up --fresh`** (between repro runs) keeps the lock, worktree, dependencies, ports, proxy and reaper:
it stops every `start` entry (running its `stop`), starts the `phase: store` entries, runs
`store_check` and `reset`, starts the rest, runs `store_check` and the egress check again, and takes a
new instance id. It makes no proving logins.

**`down`** replays each stop record, sends SIGTERM to each process group and SIGKILL after 10 s,
stops the proxy, closes the run's CLI sessions by name (never `close-all`: other projects share the
CLI), kills the reaper, removes its own worktree (`--force` on that worktree only), `run.json` and the
lock, appends `<run id> end <epoch>` to `sapu-live.log`, and leaves the data for the next reset.

**Beside a sapu sweep.** Separate ports, worktree, services and data let a journey cycle run while a
sweep gates PRs, but browsers and dev servers take CPU from its gates. `sapu-merge.sh` appends
` live=1` to a gates-log line (green, red or setup-failed) whose `[gate start, gate end]` overlaps
any run in `sapu-live.log`: a run lasts from its `start` to its `end` line, or, with no `end`, to the
latest deadline its `start` and `deadline` lines name. A `live=1` line never counts toward the flake
ledger (neither half of a red-then-green proof), and a red gate's verdict line adds `(this gate ran
beside a journey cycle)`. `limits.max_parallel_journeys` bounds the load.

## 9. Browser driver and wrapper

`@playwright/cli` (Microsoft's agent-oriented CLI, more token-efficient than its MCP server), an exact
pinned version run through `npx -y`, with a clean environment (no `PLAYWRIGHT_*`, no `NODE_OPTIONS`).
The repo needs no Playwright of its own.

**Per-slot CLI config**, written by `up` to `.argus/live/<run>/<slot>/.playwright/cli.config.json`
(its location also scopes the CLI's session namespace):
- `outputDir` = `.argus/live/<run>/<slot>/out`, headless, `timeouts.idle` 30 min;
- `contextOptions`: `locale` and `timezoneId` from `live.locale`/`live.timezone` (a repro's own
  context overrides them, §10), `serviceWorkers: "block"`;
- `initScript`: the signal logger (§7), installed in every page and popup;
- **network block, in layers:** a **filtering forward proxy** inside `argus-live.mjs` that admits only
  the run's origins and `allow_origins` — plain HTTP, `CONNECT` and WebSocket upgrades — with
  `--proxy-bypass-list=<-loopback>`, so loopback traffic goes through it too (Chrome bypasses a proxy
  for loopback by default); `network.allowedOrigins` = the same set; `--host-resolver-rules` mapping
  every host to NOTFOUND except the run's hosts and `allow_origins` hosts;
  `--webrtc-ip-handling-policy=disable_non_proxied_udp`. A live probe with 0.1.22 showed host rules
  plus a proxy plus the WebRTC flag stop page fetches, beacons, images, WebSockets and WebRTC to an
  outside host; the filtering proxy extends that to other ports on loopback. None of these binds
  Node-side code, which is why the explorer gets neither `run-code` nor `eval`, and the runner never
  runs a code string it did not build. Requests blocked this way are logged once and never become
  console-error candidates.

**The wrapper**, `argus-live.mjs pw <token> <role>[.<n>] <command> [args]`, is the only way in
(`<role>.<n>` is the role's n-th allocated account; a plain word, so it needs no quoting):
- **Token.** `argus-live.mjs slot <n>` mints a random token per explorer dispatch, recorded in
  `run.json` with its slot, journey and generation. The wrapper refuses an unknown or retired token,
  and a role or account outside that journey's allocation.
- **Commands allowed to the explorer:** `goto` and `tab-new`; `click`, `dblclick`, `fill`, `type`,
  `select`, `check`, `uncheck`, `hover`, `press`, `drag`; `upload` (files from `live.fixtures`, which
  `up` copies to the slot's directory); `go-back`, `go-forward`, `reload`; `snapshot`, `find`,
  `screenshot`, `console`, `requests`, `request`, `response-body`; `resize`; `tab-list`,
  `tab-select`, `tab-close`; `dialog-accept`, `dialog-dismiss`; `code grep <pattern> [<pathspec>]` and
  `code files [<pathspec>]` — fixed argv `git --literal-pathspecs -C <wt> grep -e <pattern> --
  <pathspec>` and `git --literal-pathspecs -C <wt> ls-files -- <pathspec>`, no flag from the explorer:
  tracked files only, any path under `.argus/` (compared without case) filtered out, each path printed
  absolute inside the worktree, output fenced like page text; `login <user> <password>` (accounts
  the journey itself created); `trigger <name> [values…]`; `facts <marker>`; `mail`; `submit <json>`.
  Everything else is refused — `run-code`, `eval`, `route`, `unroute`, `network-state-set`,
  `state-*`, `cookie-set`, `*storage-set`, `attach`, `close-all`, `kill-all`, `list`, `show`,
  `install*` — as are the flags `-s`/`--session`, `--config`, `--browser`, `--cdp`, `--profile`,
  `--extension`, `--headed`, and any file argument.
- **URLs and paths.** A `goto`/`tab-new` path must match `^/(?![/\\])`; a URL is parsed with WHATWG
  `URL` and must use `http` or `https` with an origin among the run's origins. So `//host`, `/\host`,
  `javascript:`, `data:`, `file:`, `view-source:` and `http://localhost:<port>@host` are refused.
- **Values into commands.** `trigger`, `facts` and `mail` run their argv with no shell; each value
  replaces one placeholder (`{1}`, `{2}`…) and must match that placeholder's regex in `args` (default
  `^[A-Za-z0-9][A-Za-z0-9._@:-]{0,127}$` — never a leading `-`), so a value read from a page can
  never become a command or an option.
- **Sessions** are named `<run>-<slot>-<role>[.<n>]`; `anon` is never signed in.
- **Login** (also used by `up`), with the role's own `login_url`, `logged_in` and optional
  `login_open` (a control to click first, for a login modal): open the login page fresh each time
  (CSRF tokens); fill the visible user field (`type=email`, else the text input before the
  password); if no password field is visible, submit and wait up to `settle_ms` for one (two-step
  forms); fill `input[type=password]` and submit; if a one-time-code field appears
  (`autocomplete=one-time-code`, else the single visible text input), fill an RFC 6238 code computed
  with Node's own `crypto` — never a time step already used for that secret (recorded in
  `.argus/live/<run>/totp.json` under a file lock, shared by every process), waiting for the next
  step when under 3 s remain. Success = `logged_in` visible within `settle_ms`. A failed login is
  never retried within a run (lockout); a 429 or a lockout message is a harness event.
  `login: {command}` runs per session open and must print a fresh storage state each time, which
  goes into that session's config at open. The wrapper's login actions never appear in its output,
  the trail or a repro.
- **Re-login:** when `logged_in` is no longer visible after a command, the wrapper signs that session
  in once, reports `re-logged-in: <role>`, and does not repeat the command (it may have side effects).
- **Output** from the page is fenced by `<<<PAGE-<nonce>` … `PAGE-<nonce>>>>` with a fresh random
  nonce per call (`PAGE-` inside page text is escaped); new console signals, the budget and loop
  counters and harness events follow outside the fence.

Probed live with 0.1.22: headless start in about 4 s; named sessions isolated (cookies and
localStorage); `state-save` → `state-load` across sessions; `console` and `requests` report JS errors
and 404s; `resize` works; each action returns 300–500 characters, writes its snapshot to a file and
prints its Playwright locator; targets accept locator strings such as `getByRole('button', { name:
'Save' })`; config keys `outputDir`, `contextOptions.viewport` and `contextOptions.storageState` are
honoured; a dense data-table snapshot measured 21.7 KB in full, 4 KB at `--depth=6`, 0.5 KB for
`find`. `run-code` reaches the daemon's Node `process`, so it is never offered.

## 10. Candidate → finding

Argus's cycle, gates and issue template apply. Additions:

**Repro format — data, not code.**

```json
{ "context": { "viewport": 1440, "locale": "en-US", "timezone": "UTC" },
  "steps": [
    { "as": "customer", "do": "goto", "path": "/orders/new" },
    { "as": "customer", "do": "fill", "target": { "label": "Quantity" }, "value": "2" },
    { "as": "customer", "do": "click", "target": { "role": "button", "name": "Place order" } },
    { "as": "customer", "do": "read", "target": { "testId": "order-number" }, "save": "order" },
    { "as": "customer", "expect": "visible", "target": { "text": "{{order}}" } },
    { "as": "system",   "do": "trigger", "name": "payment-settles", "values": ["{{order}}"] },
    { "as": "customer", "expect": "fact-equals", "marker": "{{order}}", "field": "status", "value": "paid" },
    { "as": "sales",    "do": "goto", "path": "/" },
    { "as": "sales",    "expect": "visible", "target": { "text": "{{order}}" }, "final": "handoff" } ] }
```

- **Steps.** `as` is a role or `<role>.<n>` (the n-th account SELECT allocated). Actions: `goto` (a
  path on the role's origin), `click`, `dblclick`, `fill`, `select`, `check`, `uncheck`, `press`,
  `hover`, `go-back`, `reload`, `read` (+ `save`), `trigger`, `login`; `{ "parallel": [steps…] }`
  starts its steps together behind one barrier. Targets: `{role, name, exact?}`, `{label}`, `{text}`,
  `{placeholder}`, `{testId}`, each with optional `nth` and `within`. Expectations: `visible`,
  `hidden`, `enabled`, `text-equals`, `text-contains`, `value-equals`, `count`, `url`,
  `fact-equals` (through `live.facts`), `mail` (a message from `live.mail` to an address, containing
  a text), `no-error` (no 5xx and no console error since the previous step), each waited for up to
  `settle_ms`. `context` defaults to `live`'s viewport, locale and timezone.
- **Literals only.** `{{marker}}` (unique per run) and `{{<saved name>}}` are substituted as literal
  values; the runner builds every CLI command and locator itself from the schema and runs it through
  the wrapper's code paths (proxy, validation, sessions `<run>-r-<role>[.<n>]`).
- **Every state-changing step** (a submitting `click`/`dblclick`/`press`, `select`, `check`,
  `uncheck`, `trigger`, `login`) is followed by an `expect` proving its effect as the acting role sees
  it; a list without one is refused (exit 2).
- **The `final` step** names its oracle and states the **correct** behaviour, as a RED test would;
  its shape comes from the oracle's template in `journeys.md`, never free-form: handoff — `visible`
  on the marker on role B's landing page; status coherence — `fact-equals` or `text-equals` the other
  role's saved value; dead end — `enabled` on the control the next map step needs, as the role the
  map assigns; reversal — `fact-equals` the saved pre-reservation amount; orphaned work — `hidden` on
  the marker in the role's inbox; claim race — `count` of resulting records equals 1 after a
  `parallel` group; stale view — `fact-equals` the newer state after acting from the old page;
  interrupted flow — `count` equals 1 and `no-error`; viewport and locale — `visible` and `enabled`
  on the critical control under the repro's `context`; re-entry — `value-equals` the saved value;
  discoverability — `visible` on the control on the role's landing page or navigation.
- **Exit codes.** 0 = every step held (not reproduced). 3 = reproduced, valid only when the last line
  of stdout is `REPRODUCED step=<n> expected=<…> observed=<…>` and every earlier `expect` held.
  Anything else — another exit code, 3 without that line, an uncaught error (a top-level handler maps
  it to 2), a failed login, a missing target — is a harness failure, journalled as H2 and never
  counted as reproduced.

**Reproduce.** After every explorer of the cycle has returned, each candidate, one at a time: every
run starts from `up --fresh` (a clean reset, no explorer or earlier-run leftovers), and the candidate
runs twice. **Filed only at 2 of 2** (exit 3 both times); 1 of 2 is journalled as intermittent, never
filed. Each run keeps a CLI trace locally for H2 diagnosis.

**Minimize** = drop one step or one role at a time and re-run, each run from `up --fresh`. A
state-changing step is dropped only together with its proving `expect`; a `trigger`, and a role's only
state-changing step, are never dropped; a reduction is kept only when it still exits 3 with the same
`final` and every remaining `expect` holds. At most `limits.minimize_runs` runs; the journal records
where minimizing stopped. No browser work enters the orchestrator's context.

**Classes and severity** — from the oracle, then argus's own adjustments (mitigating factors, the
`Reachable-by` rule), with the arithmetic shown; never the LLM's opinion:

| Oracle | Class and labels | Starting severity |
|---|---|---|
| Dead end | A, `bug` | S1 when the journey is `money`, else S2 |
| Reversal (resource not released exactly once) | A, `bug` | S1 |
| Claim race (double action, 5xx) | A, `bug` | S1 when money or stock moved twice, else S2 |
| Stale view (an outdated page could still act) | A, `bug` | S2 (S1 on money or stock) |
| Status coherence (a contradiction on a fact) | A, `bug` | S2 when a role acts on that fact, else S3 |
| Orphaned work | A, `bug` | S3 |
| Interrupted flow, viewport/locale (a broken step), 5xx | A, `bug` | by outcome, as argus rates |
| Handoff signal, re-entry, discoverability, unreachable step | with a written rule: B(a), `class:business` + `workflow`; without: heuristic, `ux` + `workflow` + needs-owner | at most S3 |
| Doc drift (§5) | `workflow` + needs-owner | — |

Above S3 a journey finding carries argus's `Reachable-by` and `Automatable` lines. `Max <currency>
per occurrence` is required on a `money` journey, computed from the repro's saved amounts; a finding
above S3 on a non-money journey carries `Blocked work:` (the objects and roles the repro shows stuck)
in its place. All journey issues also carry `argus` and `found-by:user`. A single-screen cosmetic
issue met on the way is journalled, not filed by this lane.

**Heuristic grounding** (new, separate from argus's B(b), which keeps its versioned requirement
IDs): Nielsen's ten usability heuristics, cited by number, name and URL, as advice — "heuristic #1
Visibility of system status (NN/g, retrieved <date>) says …", never "requires" — and always with the
measured number. Per oracle: handoff and CW-Q4 → #1; CW-Q3 → #2; reversal → #3; status wording →
#4; interrupted flow → #5; re-entry → #6. Nielsen's severity factors are recorded as measurements,
never as a 0–4 rating: frequency = roles and steps affected plus `Reproduced: 2 of 2`; impact = the
workaround (clicks, or none); persistence = every time, or first time only. Mitigating factor −1: a
discoverability defect that is one-time (once found, the path is on the role's own navigation).
Workflow-net soundness ("option to complete", "proper completion", "no dead transitions") is the
citable source for dead end, orphaned work and unreachable step.

**Needs-owner.** A new contract label, `labels.needsOwner` (default `argus:needs-owner`), marks a
finding only the owner can rule on. `/sapu:init` and the 2.9.0 upgrade step create it from the main
session. `/sapu:sapu` lists it in B2's SKIP. `gh issue create --label <needsOwner>` is allowed; the
guard refuses adding or removing it on an existing issue or PR, and creating, editing, deleting or
cloning the label, for every subagent (§11). The owner removes it to accept; closes the issue as not
planned to rule it intended, which argus records in `arid.md` as today, and the next charters for
that journey carry it under `intended`. That close is the owner's ruling, so the guard refuses it to
every subagent (§11). `question` keeps its present meaning.

**Scrub, before every `gh issue create` and `comment`:** `argus-live.mjs scrub --title <t> --body
<file> [--attach <png>…]`.
- **Refuses** when the title or body holds a secret: a value from `env_file` or the repo's env files,
  a role password or TOTP secret, any cookie value or `Authorization`, `Set-Cookie` or `*-Token`
  header value in the run's request logs, a `localStorage`/`sessionStorage` value, or the value of an
  orchestrator environment variable whose name matches `TOKEN|SECRET|KEY|PASSWORD`. Each is matched
  raw, URL-encoded, base64-encoded, and with whitespace and punctuation removed on both sides.
- **Redacts in place** (`<redacted>`) any other non-hex string of 24+ characters mixing letters and
  digits, unless the run saw it as an app URL path segment or a response-body field value (record ids
  such as cuid or ULID stay readable).
- Page text sits in fenced blocks of at most 20 lines, with `@mentions`, `#N` references and
  non-local URLs defanged.

**Screenshots** are attached with `gh … --attach` only when `gh` ≥ 2.99, the repo is private or
internal (`gh repo view --json visibility`), the policy's `traces` allows it, and, at that moment,
the page text and every input value passed scrub, no password or one-time-code field was visible, and
the page was not an error page; otherwise they stay local, named in a `Local evidence:` line. A
non-zero `gh` exit after it printed the issue URL counts as filed, never re-filed.

**Issue body additions:** journey id and roles; the trail (per step: role, action, locator, what the
user saw); the measured numbers; the repro steps and, generated from them by the script, a Playwright
test a sapu worker uses as its RED test.

**One defect per issue** (gate 4) and `max_issues_per_cycle` with its `[queue]` overflow issue,
as today.

## 11. Guard changes (`sapu-guard.mjs`)

For `sapu:ui-explorer`:
- **Tools** are limited twice: by the agent's frontmatter (`tools: Bash, Read, StructuredOutput`) and
  by the guard, which allows StructuredOutput and refuses every tool it sees other than Bash and Read
  — Agent, Task and Workflow included.
- **Bash is an allowlist.** Each command is one or more `node <wrapper> pw …` invocations joined only
  by `;`, `&&` or newlines, where `<wrapper>` is an absolute path whose real path is the guard's own
  plugin root's `scripts/argus-live.mjs` (an unresolvable path is refused). Every argument is a
  single-quoted literal (segments joined only by `\'`, the POSIX apostrophe idiom: `'O'\''Brien'`
  is `O'Brien`; nothing else may follow a closing quote) or a plain word: a first character from
  `[A-Za-z0-9./_-]`, then `[A-Za-z0-9._:/=@,+-]`, never `==` (a leading `-` is harmless to the shell;
  option filtering is the wrapper's job). Any `$`, backtick, `~`, `*`, `?`, `[`, `{`, `#` or double
  quote outside single quotes, any environment prefix, pipe, redirection or substitution is refused.
  That also closes `printenv`, `node -e`, `curl`, `gh` and git for it.
- **Read** is allowed only on a file whose real path (`realpath.native`) lies in the run's worktree
  (from `.argus/live/run.json`), outside `.argus/` compared without case, and is committed at HEAD
  (`git ls-tree HEAD` lists exactly that path as a blob; a staged or untracked file, a directory or
  a gitlink is refused). Grep, Glob and
  every other tool are refused: ripgrep's `glob` overrides ignore rules and a directory search
  reaches untracked files, so code search goes through the wrapper's `code` command. Page content
  reaches the explorer only through the wrapper.

For every subagent: adding or removing `labels.needsOwner` on an existing issue or PR (`gh issue|pr
edit`, `gh api` REST and GraphQL) and `gh label create|edit|delete|clone` on it are refused;
`gh issue create --label` with it is allowed. Closing an issue as not planned (the owner's ruling
that a finding is intended, §10) is refused too: `gh issue close` with `--reason`/`-r` not planned in
any spelling or case (`--reason=` and `-r<value>` forms included), a non-GET `gh api` carrying
`state_reason` not planned or one read from a file, an issue write (`/issues/<n>`, query string and
fragment ignored) whose `--input` or `-F …=@file` body cannot be read, a GraphQL `closeIssue` with
`stateReason: NOT_PLANNED` or a variable exactly `NOT_PLANNED` (or one read from a file), and an MCP
tool whose reason field carries not planned or any of whose fields names `closeIssue` beside
`NOT_PLANNED`. A reason, label or `closeIssue` field value the shell builds (`$VAR`, `$( )`,
backticks) is refused like the owner's own. A plain `gh issue close` (completed) and prose saying
"not planned" stay allowed. `/sapu:init` adds `env_file`'s name to the contract's `guard.envFiles`.

## 12. Errors

| Event | Response |
|---|---|
| `up` refuses or fails | the step and the tool's own error are quoted; `down` runs; the cycle ends with that report (`/sapu:argus` chooses another lane); the owner's servers are untouched |
| Another cycle holds the lock | refuse, naming its run and deadline |
| The egress check finds a foreign endpoint | `down`; refuse, naming process and endpoint; at a `renew`, the cycle ends and its candidates are journalled `not reproduced: harness` |
| `map-check` drops every journey, or none is selectable | the cycle ends before `up`, listing the dropped journeys and their reasons |
| Session lost mid-journey | the wrapper signs in once; failing again → a harness event (H2), not a candidate |
| Login rate-limited or locked | a harness event; that account's journey stops for the cycle |
| Goal cannot be reached | the permission checks say the role may not → not a candidate; they say it may → discoverability candidate |
| A precondition is missing | created through the UI by a role allowed to, or by a `trigger`; otherwise the charter is re-scoped (argus's standing order) |
| A browser session dies | the wrapper reopens it on the next command; the explorer resumes from its last trail step |
| An explorer returns `aborted`, hits `DEADLINE`, or returns nothing | its submitted trail and reason are journalled; its candidates still go through repro |
| `up --fresh` fails in the repro phase | the remaining candidates are journalled `not reproduced: harness`, never dropped |
| The session running the cycle dies | the reaper runs `down` at the deadline; the next `up` recovers anything left |
| A stale reaper wakes | it exits without acting when the lock names another run |
| Repro exits other than 0 or a valid 3 | journalled as H2 with the failing step and the trace path; never filed |
| `scrub` refuses | the issue is not filed; the candidate is journalled with the reason |
| `git worktree remove` refuses a worktree the instance dirtied | `--force` on the run's own worktree only |

## 13. Cost

Estimates from the probe and `sapu-metrics` prices, to be replaced by pilot measurements:
- Explorer, one journey, Opus/high, about 100 steps at an average context near 100K: **$4–5**
  (cache reads about $2, output about $1.6, cache writes about $0.9); about 25–40 minutes.
- Map refresh: one map-mode call reading code, about $2–4, only when §6's triggers fire.
- `up`, `up --fresh`, `down`, `map-check`, repro, minimize, scrub: no LLM tokens. Wall-clock: one
  dependency install per cycle (`live.setup`), and a reset and restart per repro or minimize run.
- Reference point: a sapu PR in the latest sweep cost $6.45.

## 14. Testing

sapu has no CI test run; the suite (`npx vitest run`) runs on the release machine before every
release. The browser tests need a local Chrome and fail without one, naming the install command —
never skip. Each test is named after the §3–§11 sentence it guards.

**Fixture app**, `tests/fixtures/journey-app/` — a small Node HTTP server with no dependencies: roles
`buyer` and `clerk` (two accounts each); a two-step login, a TOTP login and a modal login; on-demand
session expiry; a login rate limit; a file upload; a backing "cache" it connects to at an address from
its environment, falling back to a fixed local port; and one seeded defect per S1/S2 oracle, each
with a fixed variant behind a switch — a dead-end state, a double stock release on cancel, a
claimable task without a lock, an action from a stale page that succeeds, an orphaned inbox item — plus
a missing handoff, a handoff that appears only after two seconds, a toast that disappears after one
second, pages that reach another loopback port (by `fetch` and WebSocket) and an outside host (by
`fetch`, WebSocket and WebRTC), and a page whose text addresses the agent.

`tests/argus-live.test.ts`:
- **`up`:** each refusal in step 2; a `store_check` printing another store (and `reset` never ran:
  a sentinel stays); an `env` URL equal to one in a repo env file; a taken fixed port; a Compose file
  with a fixed host port or a `container_name`; health already answering before start; an entry
  exiting before health without `stop`; a login redirected to another origin; a live lock; the
  worktree outside the repo with no `.env` and no symlink into the main checkout; `HOME` empty and the
  environment holding only the listed variables; `COMPOSE_PROJECT_NAME` set; `{port:…}` and `${…}`
  expanded in every string of the block; `phase: store` started before `store_check` and `reset`.
- **Egress:** the fixture's cache fallback to a fixed local port is caught at `up` and at `renew`.
- **Lifecycle:** `down` kills a grandchild (process group), replays stop records with their cwd and
  env, removes the worktree and run files, kills the reaper; recovery refuses a stop record without
  its cwd or `COMPOSE_PROJECT_NAME`; the reaper runs `down` at the deadline, `renew` moves it and
  stops at the cap, and a reaper for another run exits without acting; `up --fresh` keeps the lock
  and makes no proving logins; `sapu-live.log` gets, in epoch seconds under a run id unique per run,
  a start line when `up` takes the lock (before setup), a `deadline` line at every `renew`, and an end
  line from `down` and from an `up` that fails after its start line.
- **Wrapper:** each refused command, flag and file argument; each refused URL and path (`//x`, `/\x`,
  `javascript:`, `data:`, `file:`, `view-source:`, `http://localhost:<port>@x.test`); an unknown,
  retired or foreign-slot token; a role outside the allocation; a `trigger` value with a leading `-`
  or shell syntax; the outside fetch, WebSocket and WebRTC blocked, and the loopback `fetch` and
  WebSocket to another port blocked, each logged once and never a candidate; `allow_origins`
  honoured; first-use, two-step, modal and TOTP logins; no TOTP time step reused across two `pw`
  processes; re-login after expiry without repeating the command; a failed login not retried; login
  actions absent from output; the vanishing toast captured in a page and a popup; page output inside
  a nonce fence that page text cannot close; `BUDGET`, `LOOP` and `DEADLINE`; a fresh budget after a
  handoff; `submit` validating and capping a return; `intake` fencing it.
- **Repro:** for each seeded oracle defect, exit 3 with a valid `REPRODUCED` line, and exit 0 on its
  fixed variant, with the §10 class and severity row asserted; a claim race through a `parallel`
  group with two accounts of one role; a viewport defect reproduced at 390 and not at 1440; the
  delayed handoff is not a defect; exit 2 on a broken target, a dropped prerequisite, a missing
  proving `expect`, and an uncaught error; a run's records absent from the next run; values with
  quotes substituted as literals; minimize never drops a `trigger` and keeps only reductions that
  still exit 3; 2 of 2 required; the generated Playwright test matches a golden file.
- **Scrub:** each secret class refused, raw, URL-encoded, base64-encoded and split by spaces, in the
  title and in the body; an `HttpOnly` session cookie value refused; a cuid or ULID seen in an app URL
  left as is, an unknown long token redacted; defanging; a screenshot not attached for a public repo,
  an older `gh`, a page with a password field, or an error page; a non-zero `gh` exit after the URL
  counted as filed.
- **`map-check`:** a short anchor, a missing anchor, an anchor occurring four times, a user step with
  no route, a route segment matching no anchor, a `system` step with an unknown trigger, an unknown
  role, a duplicate id; refresh triggers (roots added, deleted, renamed; a newer momus report; `head`
  gone; a new drop) and no second refresh for a drop already recorded at the same head; ids stable
  across a refresh; `global` journeys selected alone; account allocation (no account in two journeys;
  a journey waits when its accounts cannot be allocated); `list` starts no app and spawns no explorer.
- **Doc drift:** the blame comparison on a fixture repo — code newer, doc newer, no history — and the
  needs-owner label on the resulting issue.

Elsewhere:
- `tests/sapu-guard.test.ts`: the explorer's Bash allowlist (allowed chains; a leading `-` in a plain
  word; `'O'\''Brien'` allowed and read as `O'Brien`; the wrapper by a symlink or a `..` path that
  resolves to it; refused `$VAR`, globs, env prefixes, pipes, `printenv`, `node -e`, `gh`, `'a'\''b'c`,
  `\'` outside a quoted word, another file, a missing or relative wrapper path, and an unresolvable
  wrapper); its tools (Agent, Task, Workflow, Grep, Glob and any other tool refused, StructuredOutput
  allowed); its Read limits (an untracked file, a file staged but not committed, `.argus/config.yml`
  in any case, a home file); `labels.needsOwner` add and remove refused through `gh issue edit`,
  `gh pr edit`, `gh api` and `gh label …` for every subagent, while `gh issue create --label` passes;
  a not-planned close refused for every subagent through `gh issue close --reason`/`-r` (each
  spelling and the `=` and glued forms), `gh api` `state_reason` (`-f`, `-F`, `--raw-field`,
  `--field=`), an unreadable issue body, GraphQL `closeIssue` with `NOT_PLANNED` inline or as a
  variable, and MCP fields, while a completed close passes.
- `tests/sapu-merge.test.ts`: ` live=1` written when the gate overlaps an interval in
  `sapu-live.log`, including a run that started and ended inside the gate and a renewed run past its
  first deadline, and not otherwise; an earlier `deadline` line never shortens a run; a setup-failed
  line carries ` live=1`; a `live=1` red, or a `live=1` green half, never proves a flake; a live red
  verdict says it ran beside a journey cycle.
- `tests/sapu-contract.test.ts`: `journey` in `SKILLS`; `allowed journey`; `labels.needsOwner`, which
  must differ in any case from the acceptance, in-progress and done labels and not start with the
  tier prefix (the default checked too); argus's SELECT skips the lane when `allowed journey` fails;
  the inspector workflow never selects it.
- `tests/engine.test.ts`: the new files are English and name no repo; size budgets for `journeys.md`
  and the agent file; the agent file's frontmatter is `tools: Bash, Read, StructuredOutput`; argus SKILL.md grows by at most its one-sentence pointer and the lane name in
  SELECT; B2's SKIP names `labels.needsOwner`; `/sapu:init` adds `env_file` to `guard.envFiles` and
  creates the label.
- Acceptance: the pilots in §15.

## 15. Rollout

- **Release** 2.9.0 through the usual checklist (merge, tag, upgrade the repos that use sapu when
  idle, restart). The upgrade note covers the skills question, the new label, and the stricter owner
  labels (an `accepted` or `needsOwner` label with spaces or `, = " ' / [ ] { } ( ) %` is refused and
  must be renamed).
- **Pilot 1**, the repo argus has run on longest: three journeys — one cross-role money journey under
  separation of duties, one self-serve journey at phone width, one internal approval journey.
  Repo-side prep, through that repo's normal PR flow: an explore datastore with its `store_check`
  and `reset`, `facts`, `mail` and `triggers` commands where the journeys need them, the `live` block,
  `env_file`.
- **Genericity** is held by the fixture app (§14), which shares no stack with pilot 1, and by
  `engine.test.ts` refusing repo names in the engine; there is no second pilot (owner's decision).
- **Scorecard:** $ and minutes per journey; per oracle: raw candidates → reproduced 2 of 2
  → filed; repro harness-failure rate; harness events; duplicates; the owner's verdict on each filed
  issue; false positives later recorded by argus's fix-PR loop.
- **Continue** when at least 90% of filed issues are judged real and the cost per real finding is
  below the cost of one sapu PR. **Stop or redesign** below that: a noisy explorer costs more in
  wasted fix lanes than it finds.

## 16. Changes by file

| File | Change |
|---|---|
| `plugins/sapu/skills/journey/SKILL.md` | new: `/sapu:journey` (`list`, `list --rebuild`, no argument, ids) |
| `plugins/sapu/skills/argus/SKILL.md` | one sentence in §3 pointing a journey cycle to `journeys.md` and naming what it does not owe; the lane name in SELECT, behind `allowed journey` |
| `plugins/sapu/skills/argus/journeys.md` | new: the phase table, map brief, charter, oracles and their `final` templates, explorer brief, classes and severity, filing additions |
| `plugins/sapu/skills/argus/reference.md` | §4.1 note: UI journeys complement the HTTP rule; §9 state: `.argus/live/`, `journeys.json`, and a journey cycle's `run.log` fields (`fraud=-`) |
| `plugins/sapu/skills/argus/standards.md` | Nielsen's ten heuristics; workflow-net soundness; the cognitive walkthrough |
| `plugins/sapu/agents/ui-explorer.md` | new agent |
| `plugins/sapu/scripts/argus-live.mjs` | new: `up`, `up --fresh`, `down`, `renew`, `status`, `slot`, `pw`, `intake`, `repro`, `map-check`, `scrub`, the filtering proxy |
| `plugins/sapu/scripts/sapu-merge.sh` | ` live=1` on gates-log lines overlapping `sapu-live.log`; excluded from flake proofs |
| `plugins/sapu/scripts/sapu-contract.mjs` | `journey` in `SKILLS`; `labels.needsOwner` |
| `plugins/sapu/scripts/sapu-guard.mjs` | §11 |
| `plugins/sapu/workflows/inspector.js` | its argus phase excludes the journey lane |
| `plugins/sapu/skills/init/SKILL.md` | `journey` in the skills question; the `live` block with `services` (from the tracked config and code defaults that name a local service), `live.roles` from `test_accounts`, `env_file` and its `guard.envFiles` entry, `reserved_ports`, the two `confirmed` statements in §8's words; creates `labels.needsOwner` |
| `plugins/sapu/skills/sapu/SKILL.md` | `labels.needsOwner` in B2's SKIP |
| `plugins/sapu/CONTRACT.md` | `labels.needsOwner`; version coupling; the explorer's guard rules; `sapu-live.log`; the gates-log `live=1` field |
| `plugins/sapu/.claude-plugin/plugin.json`, workflow metas | version 2.9.0 |
| `tests/…`, `tests/fixtures/journey-app/` | §14 |
| `docs/usage.md`, `docs/agents.md`, `docs/security.md`, `README.md`, `docs/img/src` | `/sapu:journey`, the new agent, requirements, the isolation and browser safety rules, a light and dark diagram |

## 17. References

Prior art and evidence:
- Playwright Test Agents (planner, generator, healer) — https://playwright.dev/docs/test-agents
- Playwright CLI — https://github.com/microsoft/playwright-cli
- Momentic Mo (an explorer suspects, a reproducer confirms; briefs with intended behaviour; triage
  memory) — https://momentic.ai/docs/mo.md
- "Are Autonomous Web Agents Good Testers?" (ISSTA 2025) — https://arxiv.org/abs/2504.01495
- MAdroid, multi-agent multi-user GUI testing — https://arxiv.org/abs/2506.17539
- AutoE2E, feature-driven E2E generation — https://arxiv.org/abs/2408.01894
- UXAgent, LLM-simulated usability testing — https://arxiv.org/abs/2504.09407
- Synthetic cognitive walkthrough with LLM agents — https://arxiv.org/abs/2512.03568
- LLM heuristic evaluation against experts — https://arxiv.org/abs/2506.16345
- AgentRewardBench (LLM judges of agent trajectories) — https://arxiv.org/abs/2504.08942

Methods and oracles:
- Cognitive walkthrough (Lewis and Rieman) — https://hcibib.org/tcuid/chap-4.html
- Nielsen's ten usability heuristics — https://www.nngroup.com/articles/ten-usability-heuristics/
- Severity ratings for usability problems — https://www.nngroup.com/articles/how-to-rate-the-severity-of-usability-problems/
- Workflow patterns — http://www.workflowpatterns.com/patterns/control/ and http://www.workflowpatterns.com/patterns/resource/
- Workflow-net soundness (van der Aalst) — https://www.vdaalst.com/publications/p628.pdf
- FEW HICCUPPS oracle heuristics — https://developsense.com/blog/2012/07/few-hiccupps
- Exploratory charters (Hendrickson) — https://media.pragprog.com/titles/ehxta/charters.pdf

Safety:
- Prompt-injection defenses for agents — https://www.anthropic.com/research/prompt-injection-defenses
- OWASP LLM01 Prompt Injection — https://genai.owasp.org/llmrisk/llm01-prompt-injection/
- The lethal trifecta — https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/
- RFC 6238 (TOTP) — https://www.rfc-editor.org/rfc/rfc6238 · RFC 9700 (OAuth security, refresh
  token rotation) — https://www.rfc-editor.org/rfc/rfc9700
- Attaching files with GitHub CLI — https://docs.github.com/en/github-cli/github-cli/attaching-files-with-github-cli

Rejected on purpose: ISO 9241-110 as a citable source (paywalled; argus quotes verbatim, Nielsen
covers the same ground); multi-evaluator severity averaging; process-mining tooling (one trace per
cycle; the vocabulary in §5 is enough); session-based time metrics (sapu-metrics covers cost and
time); assembling issue bodies entirely by script (the orchestrator keeps argus's judgement; `scrub`
and the nonce fences carry the safety).

## 18. Owner decisions

1. Pilot: one repo (the repo argus has run on longest); no second pilot.
2. Pilot budget: about $20–35 for its three journeys, measured and reported.
