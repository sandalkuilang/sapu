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

Phase 6 (§19, built) narrows three of these non-goals, on the owner's decision, for the
**smoke suite only** — a lean, generated Playwright suite committed in the consumer repo and run by its
CI: per-journey performance baselines (relative, median of N, re-run before filing; still no load
testing), screenshot baselines reviewed by the owner (pixel-diff through Playwright's own
`toHaveScreenshot`, adopted from CI's platform), and reviewable locator healing (a proposal the owner
merges or closes; never an expectation, never a repro or RED test, never silent). The smoke suite is
not the repo's E2E suite and does not replace it.

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
the command that opens the CLI's live session dashboard, for an owner who wants to watch: `cd <main
checkout> && node <real path>/argus-live.mjs show`. `show` is refused without a cycle whose browser is
up, on a lock past its deadline, and (named) without the run's directory; the CLI leads a process group
of its own, and a SIGINT, SIGTERM or SIGHUP to `show` ends that whole group, its dashboard included.

### Entry points, policy, versions

- **Every path into the lane** runs `sapu-contract.mjs allowed argus` and `allowed journey` first:
  `/sapu:journey`, and argus's SELECT before it ranks any `journey:` cell (argus run from the main
  session with `.argus/live.json` configured). In 2.9.0 the `/sapu:inspector` workflow's argus
  phase excludes the lane: it runs only from the main session.
- `journey` joins `SKILLS` in `sapu-contract.mjs`. An explicit `policy.skills` list without `journey`
  means not allowed; `allowed journey` also refuses while argus is not allowed (`journey runs under
  argus, which is not allowed in this repo …`), and `/sapu:init` selects `argus` whenever `journey` is
  selected; the 2.9.0 upgrade note tells the owner to re-run `/sapu:init`'s skills question.
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
  that implement the observed behaviour (from the journey's step anchors), each side read as the
  newest **author** time of its lines (a rebase or cherry-pick rewrites the committer time, never when
  a line was written). Code newer → a needs-owner issue asking whether the doc or the app is right
  (§10); doc newer → ordinary Class B(a); undecidable → needs-owner. `argus-live.mjs drift --doc
  <file>:<a>-<b> --code <file>:<a>-<b> [--code …]` (repo-relative files, `1 ≤ a ≤ b`) prints one line,
  `code-newer → needs-owner`, `doc-newer → class B(a)` or `undecidable (<why>) → needs-owner`, and
  exits 0 for each. `<why>`: `uncommitted lines` (blame runs on the working tree, so an edited line has
  no commit), `no history` (git's blame failed: a file HEAD lacks, a range starting past the file's
  end; an end past it is clipped by git) or `same time`; the doc's range is read first, then each code
  range, and the first undecidable one gives the reason. A range that is not one (start past end, line
  0, an absolute path, `..`, a control character) → `refused: drift: <range> is not <repo-relative
  file>:<a>-<b>`.
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
    "lastCycle": 12, "lastHead": "<commit at the last visit>", "filed": ["<issue URL>"] } ] }
```

- **Built by** one `sapu:ui-explorer` call in map mode (brief in `journeys.md`), returned through the
  wrapper's `submit`; the orchestrator writes the file. Steps come from the repo's routes and
  permission checks; each `live.roles.<r>.code_role` (§8) names the role in the code's own
  role → permission source, through which the map agent maps a permission to a role. The newest
  momus report's flagged business-process rows raise a journey's priority (below); they are not the
  step list. Docs supply the goals.
- **Map mode** starts no app. `argus-live.mjs up --map` takes the lock and builds the worktree at HEAD
  (§8 "`up --map`"); `slot <n> --map` mints a map token in any run whose run.json has a worktree — a map
  run, or a full `up` still starting, so `/sapu:journey` refreshes the map while `up` brings the app
  up — and prints `{slot, token, generation, mode: "map"}`. A map token takes `code` and `submit` only
  (§9), before an instance id too. Its `submit` validates the map (`validateMap`), which collects
  every fault (the refusal, `refused: return: …`, names the first five) and caps nothing: `{roots,
  journeys, notes?}` with no other key at any level; `roots` at most 100
  repo-relative paths (no `..`); at most 100 journeys, each `{id, domain, title, money, global, goal,
  steps}` — `id` kebab-case (at most 100 characters), `domain` at most 60 characters, `title` 120,
  `goal` 500, `money` and `global` booleans — with 1–40 steps, each `{role, route?, trigger?, goal,
  claim?, sources}`: `role` a role name, `route` starting `/` (at most 200 characters), `trigger`
  matching `^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$`, `claim` a boolean, 1–10 `sources` of `{file, line ≥ 1,
  text of 16–500 characters}`; `notes` at most 2000 characters. What the catalog prints as given — a
  journey's `domain`, `title` and `goal`, a step's `goal`, and `notes` — holds no C0 or C1 control
  character (DEL included: `<where> must hold no control character`), so no line of the catalog can be
  forged. `map-check --merge <slot>` merges the newest generation that map slot returned (in the lock's run,
  else the newest run directory) into `.argus/journeys.json`, `head` set to the commit the run's
  worktree was built at — the code the map agent read, not MAIN's HEAD, which may have moved meanwhile
  — read from run.json's `worktreeHead`, or after `down` from the run's `worktree.json` (§8); then it
  runs `map-check`. A journey whose id the file already holds takes the returned domain, title, flags,
  goal and steps and keeps `lastCycle`, `lastHead` and `filed`; a new id is appended with `lastCycle:
  null`; every other journey, and `dropped`, stay. A slot whose newest return is not a map → `refused:
  map-check --merge: slot <n> returned no map`; one that no longer validates → `refused: map-check
  --merge: <the first five faults>`; a run that recorded no worktree commit → `refused: map-check
  --merge: run <runId> recorded no worktree commit`.
- **Reserved roles.** `anon` (never signed in) and `system`: a transition driven by a scheduler,
  webhook, queue or expiry is a step with `"role": "system"` and the `trigger` that `live.triggers`
  runs. A step's `"claim": true` marks the role a claim race needs two accounts of.
- **Visits.** `argus-live.mjs visit <journeyId> --cycle <n> [--filed <url>…]` (PERSIST) writes into
  `.argus/journeys.json` the journey's `lastCycle` (argus's cycle `n`, a whole number from 1),
  `lastHead` (MAIN's HEAD as the cycle ends, `git rev-parse HEAD`: the commit the journey was last
  explored at, as near as MAIN tells) and `filed`, a list of issue URLs: each `--filed` (repeatable)
  is one URL as `scrub` prints it after `filed:` or `commented:` (`https://<host>/<owner>/<repo>/issues/<n>`,
  optionally `#issuecomment-<n>`), appended in order, once each. Nothing else changes. It prints
  `visited <id>: last cycle <n>, last head <sha12>, filed <k>` (`k` the URLs `filed` now holds).
  Refused: no `.argus/journeys.json`, an id that is not kebab-case or not in the map, a `--filed`
  that is not such a URL or holds a control character, C0 or C1, or an invisible format character
  (an ESC or a CSI would reach the catalog; U+202E reverses the text), a HEAD that cannot be read.
- **`map-check`** (no LLM, no lock, starts nothing) drops a journey at its first failing check, in
  this order, printing `dropped <id>: <reason>` (steps and anchors numbered from 1):
  - the id is kebab-case (`id is not kebab-case`) and not an earlier journey's (`duplicate id`: the
    later one goes);
  - per step, each anchor: its `text` has 16+ non-space characters, occurs in its `file` as read at
    HEAD (`git show HEAD:<file>`; a path that is absolute or holds `..` is never read) and at most 3
    times there, every occurrence counted (two on one line, or overlapping, count two); `line` moves to
    the nearest occurrence's line;
  - a user step's role is a key of `live.roles` (roles and triggers go unchecked, and the catalog is
    marked `roles unchecked`, when there is no `.argus/live.json`; one that is not JSON is refused), it
    has a `route`, and at least one of its anchors lies under `roots` (its file is a root or under a
    root directory) and holds the route's last path segment, compared without case, in its `file` path
    or its `text` — the last segment that is not a parameter (`:id`, `[id]`, `{id}`, `*`); the route
    `/` has none and needs only an anchor under `roots`;
  - a `system` step's `trigger` is a key of `live.triggers` (`trigger (none)` when it has none), and an
    anchor lies under `roots`.

  Dropped journeys leave `journeys` for `dropped` (`{id, reason, head}`, replacing an earlier entry of
  that id; a journey kept again leaves `dropped`), and the file is rewritten with the anchors' moved
  lines. `map-check` then prints `catalog: <n> journeys, <k> dropped[, roles unchecked]` and `refresh:
  <reason>; …` or `refresh: none`; with `--list` the catalog after them. No journey kept → `refused: no
  journey is selectable` (exit 1).
- **Refresh** when `git diff -z --name-status -M --diff-filter=ADR <head> HEAD` (over the whole tree, so a
  file renamed out of `roots` counts) adds, deletes or renames a file under `roots`; when the newest
  `.momus/report-*.md` was modified after `head`'s committer time (compared only while `head` is in the
  history); when `head` is no longer in HEAD's history; when `map-check` drops a journey not already in
  `dropped` at the current head; when there is no map; or on `list --rebuild`. Modified files only
  re-run `map-check`. A refresh adds and updates journeys and keeps the rest; a journey dropped again
  at the same head triggers nothing more.
- **Ids** are kebab-case English, named after the process in the code, and stable: a refresh never
  renames one, so coverage history stays attached. An owner rename starts that journey's coverage
  fresh. **Titles and domains** are in the language CLAUDE.md sets for people; domains come from the
  code's own module names.
- **`global: true`** marks a journey that changes settings every other journey depends on (master
  data, rates, permissions). A cycle that selects a global journey selects only that one: a global
  journey ranked first is selected alone (the rest wait: `global journey selected alone`), one ranked
  later waits (`a global journey waits for a cycle of its own`).
- **SELECT score** per journey: `cycles_since_visit × exposure × (1 + commits touching its anchor
  files since its last visit)`, with `cycles_since_visit` = the cycle number − `lastCycle` (the cycle
  number when never visited), at least 1; exposure 2 for `money: true` and 1 otherwise, doubled when the
  newest momus report flagged one of its steps' endpoints; the commits counted `lastHead..HEAD` over its
  anchor files (0 without `lastHead`, or when git cannot count them). Coverage cells in
  `coverage.json`: `journey:<id> × <oracle>` for the oracles in §7.
- **`argus-live.mjs select --cycle <n> [--flagged <id>,…] [--ids <id>,…]`** runs SELECT: `--cycle` is
  argus's current cycle (a whole number from 1), `--flagged` the ids the orchestrator read as flagged
  in the newest momus report, `--ids` the journeys asked for, in that order (an id the map lacks →
  `refused: select: no journey <id> in .argus/journeys.json`). It reads `.argus/live.json` as it stands
  (refused without it); every user of `roles.*.users` must be written literally, since `select` prints
  the account lists `slot` takes (`${` in a user → refused). Journeys are taken in rank order (score,
  then id), up to `limits.max_parallel_journeys` (default 2). Output: `select <id> score <s> accounts
  <role>.<k>=<user>|<role>.<k>,…` per pick (the list `slot --accounts` takes, roles in their steps'
  order), `wait <id> score <s> (<why>)` (`limit <max> reached`, `no free account for <role>`, the two
  global reasons), and with `--ids` `displaced <id> score <s>` for each journey the score's own ranking
  would have picked. No pick → `refused: no journey is selectable` (exit 1, after those lines).
- **Accounts.** SELECT allocates accounts before launch: no account serves two journeys in one cycle
  (shared inboxes and single-session apps would corrupt both). Each role a step names but `system`
  gets one account: `anon.1` with no user, a login-command role's `.1` (one journey a cycle), else a
  free user; then a role a `claim: true` step names gets a second free user, when there is one (never
  for `anon` or a login-command role). A journey whose accounts cannot be allocated waits for a later
  cycle, its `why` the first role, in step order, it could not get.
- **Catalog output** (`/sapu:journey list` = `map-check --list`): domains sorted, each as `<domain>:`,
  then per journey `  <id> — <title> — <role> → <role> …[ money][ global] — last cycle <n|never>, filed
  <k>` (a role repeated in a row said once); then, when any journey is dropped, `dropped:` and `  <id>:
  <reason>` each.

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
captured by an init script installed in every page and popup, which pushes each onto the page's own
`window.__argusSignals` buffer (and logs it to the console). After every command the wrapper's
observation evaluates the script again in every page of the session (it watches each document once)
and drains every page's buffer, so a toast gone before the next snapshot is seen. The script also wraps
`window.open`: Chrome runs init scripts in a popup's first document (about:blank) but not in the page
it then loads, so the opener watches that page once it leaves about:blank. The session's in-daemon
hook (§9) evaluates the script again at every `domcontentloaded` of every page and popup, so a popup a
link opened (`target=_blank rel=opener`) is watched from its first document too.

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
validates it against the schema, caps every free-text field at 500 characters, writes
`.argus/live/<run>/returns/<slot>.<generation>.json` (each handoff's generation apart) and retires the
token (a return the schema refuses is written nowhere and leaves the token live; `submit` answers past
the budget and the deadline); its StructuredOutput is only `{status, slot}`. Schema:
`{ journey, status: "done"|"handoff"|"aborted", roles, steps: [{role, action, locator, saw,
off_goal}], created: [markers], values: [{marker, field, role, value, from}], candidates: [{claim,
oracle, measured, roles, observed, expected, repro, screenshots[], h2h3}], cw: [{step, q1, q2, q3,
q4}], coverage: {<oracle>: "held"|"failed"|"not-tested"|"blocked"}, harness_events, next, notes }`;
a candidate's `repro` is the list §10 describes, at most 100 elements. A map slot's return is the map
itself (§6, `validateMap`), answered `submitted: slot <n> generation <g> map journeys <k>`.
The orchestrator reads it only through `argus-live.mjs intake <slot>`, which prints, per generation,
a summary from enums and counts only first (`slot <n> generation <g> journey <id> status <s> steps
<k> candidates <k> coverage <oracle>=<verdict>,…`; a map return, told by its content — `journeys`, no
`status`, since after `down` no run.json says which slot was a map slot — `slot <n> generation <g> map
journeys <k> roots <k>`), then the whole return pretty-printed inside a fresh `<<<RETURN-<nonce>` fence
(marker shapes escaped, secrets masked), as data. A candidate is never a finding (argus §3).

## 8. Live instance

New file `.argus/live.json`, written by `/sapu:init` and tracked beside `config.yml`. It is JSON
because the plugin has no dependencies to parse YAML; argus's `config.yml` and its free-form
`test_accounts` block stay as they are, and `roles` here is the explicit per-role map this lane
needs. Below, `live.<key>` names a key of this file and `limits.<key>` a key of its `limits` object
(`max_cycle_minutes` included: the lane does not read `config.yml`). `{port:<name>}` and `${NAME}`
expand in every string of the file, with one exception: in a field run by the shell (`store_check`,
`reset`, `start[].cmd`, `start[].stop`, `start[].health.cmd`, `roles.<r>.login.command`), `${NAME}`
becomes a reference to the variable `ARGUS_SECRET_<NAME>` (quoted outside double quotes), whose
value only that command's environment carries. What is guaranteed: the value is never written into
the field's command text — so not into the shell's own command line, a recorded command line or
`run.json` — and the shell running the field reads it as one word of data, never as shell syntax.
`${NAME}` inside single quotes or a heredoc is refused at validation (that shell would not expand it
there); a field that hands the value to an inner shell or a container writes `"$ARGUS_SECRET_<NAME>"`
for the inner shell and passes it into a container by name (`-e ARGUS_SECRET_<NAME>`). A command
that puts the value into another program's arguments makes it visible in `ps` — the owner's choice.
Argv lists (`setup`, `facts`, `mail`, `triggers`) and env values get the value itself, so a secret
in an argv list is visible in `ps` while that command runs (recorded command lines mask it). Its schema is validated by `argus-live.mjs` (unknown keys are
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
only when signed in, and it and `login_open` (a control to click before the login form shows, top
level or per role) are Playwright locators of the getBy family or `locator('<css>')`, optionally
chained and with `.first()`, `.last()` or `.nth(<n>)` — never a snapshot ref or a bare CSS string —
because the wrapper parses them and builds its own login code from the parsed form (§9); `env_file` is the only source of `${NAME}` and is gitignored; `store` is the one
datastore `reset` may touch, and `store_check` prints the store the app's own configuration resolves
to; `mail` prints `[{to, subject, text}]` as JSON; `allow_origins` are full origins pages may load
from (a font CDN); `reserved_ports` are the repo's dev and E2E ports, never allocated; `fixtures` holds
the files `upload` may use (a repo-relative directory: no absolute path, no `..`); each role may also
set `base_url`, `login_url`, `logged_in`, `login_open`. Ranges: `settle_ms` 0–120 000,
`login_spacing_ms` 0–60 000, each `viewports` width 200–4000, `limits.explorer_pw_calls` 1–10 000;
`locale` and `timezone` non-empty. An optional `compose_files` lists the Compose files the instance uses (paths from the
repo's root, tracked, no `..` and no `:`), in Compose's `-f` order: only those are checked (step 5), and the run
sets `COMPOSE_FILE` from them (step 3), so its own Compose commands read only those too.

`confirmed` is the owner's statement, asked by `/sapu:init` in these words: `mocks` — every outbound
integration (payments, email, messaging, identity checks) runs in test or mock mode under `env`,
because a browser cannot see server-side calls; `data` — the data `reset` creates is synthetic (no
real personal or business data), so screenshots and page text may appear in issues. `/sapu:init`
also lists the tracked config files and code defaults that name a local service (a cache, queue,
object store, search engine, mail server) and asks for each one's isolated address under `services`.

**Role names** match `^[a-z][a-z0-9_-]*$` (no `.`: `<role>.<n>` names an account); `anon` and
`system` are reserved, and so are the wrapper's role-free commands `submit`, `code`, `trigger`,
`facts` and `mail` (§9: `pw <token> submit <json>` takes no role). Tools outside the guard's hook matcher (WebFetch, WebSearch, Skill and the
like) are kept from the explorer by its frontmatter alone, which an engine test pins.

**The run's origins** = the origins of `base_url`, of each `roles.<r>.base_url`, and of every
`{port:<name>}` allocated this run on those URLs' hosts. `allow_origins` entries are full origins
(`scheme://host:port`), never bare hosts.

**Threat model.** `.argus/live.json` and the repo are the owner's own and trusted. The checks of
`up`, `renew` and `down` exist to catch a misconfiguration, or an app default, that would make a cycle
touch the owner's servers, services or data (a cache on its standard local port, a Compose file with a
fixed container name or an external volume, an env value left pointing at the dev database); they are
not a sandbox against a repo written to escape them. Known limits, each a reason the checks are
defence in depth and not enforcement:
- Static scans read what the config and the tracked Compose files say. A script they call (`npm run
  docker:up`) is seen only through what it does: the Docker runtime gate (step 8) and the egress check.
- Process groups bound every kill and every listing: a process that leaves its group (`setsid`, a
  double fork) is neither killed nor listed.
- The egress check samples (step 8): a connection opened and closed between two samples is not seen,
  and processes inside containers are not listed (the Compose checks and the runtime gate stand in).
- A host name in `env` or `allow_origins` stands for the addresses it resolves to when the check
  runs; a name that rotates (DNS round robin, a CDN) may be refused for an address it took since, or
  allowed for one it no longer has.
- `allow_origins` is matched for every process of the run, not only for pages.
- A container reaches the Docker host by names and addresses the checks know (`host.docker.internal`,
  `host.containers.internal`, `host.lima.internal`, `host-gateway`, `172.16-31.0.1`,
  `192.168.65.0/24`); a custom bridge subnet escapes them, and so do OrbStack's `host.orb.internal`
  and rootless Docker's slirp4netns gateway (`10.0.2.2`). Podman's Docker-compatible socket is untested.
- The Docker runtime gate judges objects by when they were created, not by who created them: what
  touches an object that existed before the cycle (other than a container's own healthcheck) ends the
  cycle, the owner's own work on the same daemon included — and so does a sweep's gate that started a
  container before the cycle and stops it during it. A new object that is not the run's passes unless
  it touches the owner's state (step 8). An owner's container that its restart policy restarts during
  the cycle, and a Docker daemon restart (which restarts containers and ends the events follower), end
  the cycle too; a container that only exits by itself (`die`) does not.
- A container gone by the time the gate lists (`docker run --rm`) is seen through its events alone:
  its volume mounts are there (`volume mount` names the container), its bind mounts are not, so a
  transient container that bind-mounts the owner's checkout or a socket is not seen.
- The testcontainers reaper (image `testcontainers/ryuk*`, or any container labelled
  `org.testcontainers.ryuk=true`) may bind-mount the Docker socket: a container carrying that label is
  exempt from the socket rule whatever it runs (every other rule still applies to it). The label
  `org.testcontainers=true`, which every testcontainers container carries, exempts nothing.
- Unix-socket peers are named by `lsof` and, on macOS, by `netstat -an -f unix` (which also shows the
  sockets of servers other users run; its addresses are the ones lsof prints; a netstat that fails
  there fails the check), or by `ss -xp` on Linux; a Linux without `ss` is blind to unix-socket peers
  (its `lsof` does not name a client's peer).
- The worktree and HOME live under `$TMPDIR`. On a Linux whose `/tmp` is a tmpfs, a large checkout
  and its dependencies take memory; point `TMPDIR` at a disk-backed directory of the user's own.
- Nothing is enforced by the operating system. A sandbox that denies the instance every other
  connection (`sandbox-exec` on macOS, a network namespace on Linux) is future work.

**`argus-live.mjs up`** (no LLM; every step logged to `.argus/live/logs/`):
1. **Lock.** Takes `.argus/live/lock.json` (run id, unique per run; deadline = start +
   `limits.max_cycle_minutes` + 15 min) and, before any setup or install, appends `<run id> start
   <epoch> deadline <epoch>` to `<MAIN>/.git/sapu-live.log` (epoch seconds, like every time in that
   log). Every exit of `up` that fails after this line appends `<run id> end <epoch>`. A lock whose
   deadline has not passed → refuse: another cycle is running; it is never
   "recovered". A lock past its deadline → recovery first: each recorded stop replayed exactly as
   recorded (`{cmd, cwd, env}`; one whose cwd is gone or whose env lacks its `COMPOSE_PROJECT_NAME`
   is journalled, never run), each process group that still runs what was recorded (below), each
   recorded CLI session by name, the proxy, the worktree and its HOME. Then every earlier run's secret
   ledger (`logs/secrets.jsonl`, §10) is deleted (`dropLedgers`), before run.json and the reaper.
2. **Refusals**, each naming its cause: no `reset`, `store` or `store_check`; a `confirmed` value not
   true; no `logged_in`; every unset `${NAME}`, one line each (its value never printed; none when the
   env file itself is missing or outside the repo, which the schema line says once); a host name in
   `base_url` or a `roles.<r>.base_url` that does not resolve to loopback (as nemesis requires; a
   literal address is the schema's); a `store` the contract's `guard.postgres`/`databases` protects
   (checked again at step 6); a user's `password` or `totp_secret` that is not exactly one `${NAME}`;
   an `env_file` git tracks;
   `~/.playwright/cli.config.json` present (the CLI merges it underneath ours); no Chrome-family
   browser (the install command named); the pinned CLI not installable (offline, empty npm cache);
   neither `lsof` nor `ss` available; no process identity (a start time for this very process, from
   field 22 of `/proc/<pid>/stat` on Linux — boot ticks, which never drift — else `ps -o lstart=`):
   every kill asks a process's identity first, so without one a teardown would be blind; a
   `services.<n>.env` variable the instance env (`env`, or a set `pass_env` name) does not set — the
   app would fall back to its default address, the owner's service; an `env_file` whose base name the
   committed contract's `guard.envFiles` (with the guard's `.env`/`.env.local` floor; no contract, the
   floor alone) does not hold — any agent could read it (`refused: env_file <f> is not in the contract's
   guard.envFiles (/sapu:init adds it)`, or, with no contract, `refused: there is no sapu contract, so the
   guard keeps no agent out of env_file <f> …`); an `env_file` git tracks, matched as a file name in any
   letter case, never a glob (`refused: env_file <f> is tracked by git …`), or, untracked, does not ignore
   (`refused: env_file <f> is not ignored by git, so it could be committed (add it to .gitignore)`).
   `live check` makes the same checks against the draft contract
   in the working tree, and adds `note: … up refuses until the contract is committed` while only the
   draft covers the file.
3. **Ports and environment.** The **ports** first, since the environment names them:
   `{port:<name>}` takes a free port from `port_range` outside `reserved_ports` (which `/sapu:init`
   fills with the repo's dev and E2E ports; `port_range` is required whenever a `{port:<name>}` is
   used); `{port:<name>=<n>}` fixes one, and a taken fixed port → refuse, naming the process holding
   it; one port fixed for two names, or one name fixed at two ports → refuse. Then the
   **environment**: every command gets only `PATH`, `USER`, `SHELL`, `TMPDIR`, `LANG`/`LC_*`, the
   names in `pass_env`, `env`, `COMPOSE_PROJECT_NAME=argus-<run>`, `HOME` = a per-run directory
   outside the repo, beside the worktree (`$TMPDIR/sapu-live/<repo>-<run>.home`, mode 0700, empty but
   for `.docker`; a setup may link into it, e.g. a managed Python or a package store) — so no tool
   picks up the owner's cloud, Git or registry credentials — and the run's Docker client (through which
   `since`, the daemon's clock, is read and the events follower, step 8, starts right after):
   `DOCKER_CONFIG` = `<HOME>/.docker`, holding only links to the owner's Docker CLI plugins and a
   `config.json` without `auths`, `credsStore` or `currentContext`, and `DOCKER_HOST` = the local unix
   socket of the owner's current Docker context (refused before step 5 when that context is anything
   else: tcp, ssh). Private images are therefore pulled beforehand by the owner. Anything else a tool
   genuinely needs from the owner's home (an npm cache) is named in `pass_env`. `env`, `pass_env` and
   a start entry's env may not name `HOME`, `COMPOSE_PROJECT_NAME`, `DOCKER_CONFIG`, `DOCKER_HOST` or
   `DOCKER_CONTEXT`. With `live.compose_files`, `COMPOSE_FILE` = those files joined with `:` (and
   `COMPOSE_PATH_SEPARATOR` = `:`, whatever a tracked `.env` says; so a
   tracked `compose.override.yaml` beside them is not read), and none of them may set `COMPOSE_FILE`
   or `COMPOSE_PATH_SEPARATOR`.
4. **Worktree.** A linked worktree at HEAD **outside** the repo (`$TMPDIR/sapu-live/<repo>-<run>`),
   so no lookup that walks up the directory tree finds the repo's own `.env`. `$TMPDIR/sapu-live` is
   the user's own directory, mode 0700, never a symlink, and never inside the repo. The commit it was
   built at is run.json's `worktreeHead`, kept also in `.argus/live/<run>/worktree.json` (0600)
   `{worktreeHead, mode}` (`mode` `"map"` for `up --map`, else `"explore"`), which `down` leaves: after
   `down`, §6 `map-check --merge` reads the commit there and `scrub` (§10) tells a map run by its
   `mode`. `live.setup` runs
   in the worktree under step 3's environment, each command bounded by the time left before the
   lock's deadline (`failed: setup <cmd> timed out`), its output logged to a private file and every
   secret value masked in the error quoted; afterwards `up` refuses when any symlink in the worktree, followed through every link
   (broken ones too), resolves into the repo's main checkout or to a directory holding it (a
   dependency directory linked from there would be written by the instance).
5. **Compose.** No command of the config (setup, `store_check`, `reset`, start `cmd`/`stop`/health
   `cmd`, login commands, `facts`, `mail`, `triggers`) may set or unset a `COMPOSE_*` or `DOCKER_*`
   variable (`X=… cmd`, `env X=…`, `export`, `unset`), run `docker` other than `docker compose`
   (no `docker run`, `exec`, `rm`, `volume …`, `--context`), or pass Compose `-p`, `-f`,
   `--project-directory`, `--env-file` or a variable where its flags go (quotes and backslashes read
   as the shell reads them): the check would not see what it runs (the env's `COMPOSE_FILE` and
   `COMPOSE_PROFILES` do that). The Compose files checked are `live.compose_files` when set (merged
   in its order from the worktree's root); else the `COMPOSE_FILE` the instance env (or a tracked
   `.env`) sets, read as Compose reads it; else every Compose file of the worktree — tracked at any
   depth (`compose*.y*ml`, `docker-compose*.y*ml`), or a default name at its root — one run per
   directory, and a refusal then tells the owner to list `compose_files` (fail closed; files only a
   command or a script uses are left to the runtime gate, step 8). None may name a path inside the
   main checkout, spelled anywhere in it (a `${VAR:-<path>}` default too) or reached by a relative
   path (an `env_file`, `extends` or `include` read from the owner's checkout). Then `docker compose
   [-f <file>…] --profile '*' config --format json` runs under step 3's environment with every
   profile, and each project must share nothing with the owner's stack, otherwise refuse: it is named
   `COMPOSE_PROJECT_NAME`; it publishes only this run's ports (no random host port either) and names
   no `container_name`; no service sets `network_mode` `host`, `bridge` or `container:…`, `pid`,
   `ipc` or `cgroup` `host` or `container:…`, `uts` or `userns_mode` `host`, or `volumes_from` a
   container; none is `privileged`, sets `security_opt` `seccomp`/`apparmor` `unconfined`,
   `label` `disable` or `systempaths=unconfined`, maps `devices`, or adds a capability other than
   `NET_BIND_SERVICE`, `CHOWN`, `SETUID`, `SETGID`, `DAC_OVERRIDE`, `FOWNER`; no bind mount or local
   volume `device` (`o: bind`, `type: none`) lies inside the main checkout or holds it, or is a
   container runtime or datastore socket (Docker, containerd, Podman, PostgreSQL, MySQL, Redis) or a
   directory holding one (`/var/run`, `/run`, `~/.docker/run`, …), or any `*.sock` under a Docker
   run directory (`~/.docker/run`, Docker Desktop's data directory, …), unless it lies in the worktree;
   no secret or config `file` or build context is read from the main checkout; no `extra_hosts`
   entry maps a name to the Docker host (`host-gateway`, a bridge gateway); no network or volume is
   `external` or named outside the project. Each service's resolved `environment`, `command` and
   `entrypoint` go through step 6's comparison as a container sees them (below). Docker missing or
   failing is a refusal too. The projects' service names are the Compose services step 6 exempts.
6. **Store.** Starts the `phase: store` entries (each in its own process group) and waits for their
   health. `store` must not be a database the contract's `guard.postgres` protects. Runs
   `store_check` under the instance environment and again under the environment of every `start`
   entry that sets its own: each output must equal `store`. Then, as defence in depth (`store_check`
   and the egress check are the primary guards), no value in those environments may reach what the
   repo's env files name (read by the script, never printed):
   - a non-http service (postgres, mysql, redis, mongodb, amqp, …) on the same host and port,
     whatever its database, remote or local. There is no opt-in: the instance reaches such services
     only through its own local ones. An endpoint with no host or no port never matches — except
     for libpq and MySQL-family values (`postgres:///app`, `dbname=app`, `mysql://u@/app`), whose
     clients read a missing host (or a libpq socket directory) as the local server, so they are a
     loopback endpoint on the default port — and a single-label host that is a service of the
     worktree's own Compose project is exempt;
   - an http(s) URL equal up to its query, or on the same loopback endpoint, unless its origin is
     listed in `allow_origins`;
   - a file or socket (`sqlite:`, `jdbc:sqlite:`, `file:`, `unix:`, `<scheme>+unix:`, a bare path)
     equal to one they name, or any path inside the repo's main checkout (the instance's relative
     paths resolve in its worktree, the owner's in the main checkout; `file://<host>/p` is `/p`).
     `sqlite:///x` is read both ways, relative (as SQLAlchemy reads it) and absolute (as others
     do), on both sides, and refused when either reading hits.

   Hosts are compared canonically (lower case, one form per IP address, no trailing dot, every
   loopback address one name) with default ports filled in; `X_HOST` + `X_PORT` (and `PGHOST` +
   `PGPORT`) count as one endpoint on both sides, and an instance `*PORT` with no host beside it as a
   loopback endpoint (so a bare `*PORT` holding a standard port, such as `POSTGRES_PORT=5432` read
   only inside the Compose file, is refused when the owner's env files name that local port: rename
   it in the live env, or give it its own port). Nor may a value name a port or database `guard.postgres` protects: URLs, `jdbc:`
   URLs, libpq `key=value` strings and bare port numbers are read, and a bare database name under a
   variable that names a database (`PGDATABASE`, `*_DB`, `*DATABASE*`, `*_DB_NAME`, `*_DBNAME`). And
   an instance value of the libpq or MySQL family must name its host and its port: one that leaves
   either to the client's default (`postgres:///app`, `postgres://u@localhost/app`, `dbname=app`) would
   reach whatever local server answers there, and is refused; so is a client variable that takes
   its host from another one left unset (`PGDATABASE`, `PGUSER`, `PGPASSWORD` or `PGPORT` without
   `PGHOST`; `MYSQL_PWD` or `MYSQL_TCP_PORT` without `MYSQL_HOST`). Only then `reset`.

   The same comparison runs at step 5 over each Compose service's `environment`, `command` and
   `entrypoint` (each word, and what follows its first `=`), as a container sees them: its loopback
   and its paths are its own and are not compared, and a host that is the Docker host
   (`host.docker.internal`, `gateway.docker.internal`, `host-gateway`, a bridge gateway such as
   `172.17.0.1`) is refused unless on one of the run's ports.
7. **Start.** Each remaining entry in its own process group, run by `/bin/sh -c`; an entry (or `reset`)
   that is one simple command runs as `exec <cmd>`, so the command leads its group on every `/bin/sh`
   (bash execs such a command itself, dash, the Debian and Ubuntu one, does not). Refuse when an entry's health already
   answers before its command ran (a `url` that responds, a `cmd` that exits 0: something else serves
   there). Health = `{url}` answering, `{cmd}` exiting 0, or, when omitted, the process alive after
   5 s; an entry whose process exits before its health passes — checked again after a health that
   answered — fails `up` unless it exited 0 and has `stop` (a detached starter such as `docker compose
   up -d`). Timeout `limits.live_health_timeout_s`, which also bounds each `store_check`; every health
   `cmd` and `store_check` runs in its own process group, killed once it returns. Then `store_check`
   again.
8. **Egress check.** Lists the connections of every process in the run's process groups, five
   samples over a few seconds (and one sample between health tries in steps 6 and 7, so a
   connection made while the app starts is seen too): TCP (`lsof -nP -a -iTCP -p <pids>`, or `ss`)
   and unix sockets (`lsof -U`, or `ss -xp` on Linux). A TCP connection may reach only the run's
   ports on loopback, another listener of those processes on loopback, a non-loopback endpoint named
   in `env` or a start entry's env (a host name standing for every address it resolves to), a
   non-loopback `allow_origins` origin, or an endpoint named by a `pass_env` variable (an
   `HTTPS_PROXY`, loopback included: the owner chose to share it); a loopback endpoint the env names
   but the run did not allocate is refused, since the owner's own dev servers listen there. A unix
   socket outside the run's directories may not be a datastore's: a PostgreSQL, MySQL, Redis, MongoDB
   or memcached socket name, a socket in such a server's default directory or in a directory the
   owner's env files name for a socket, or any socket inside the main checkout. Anything else →
   `down` and refuse, naming the process and the endpoint or socket (a code default such as a cache
   on its standard local port, pointing at the owner's). A connection the processes accepted is
   inbound and not counted. A listing that cannot be trusted fails `up`: `lsof` exiting 1 with an
   error, or no listener of the run (the port of `base_url`, when the app serves it from the host and
   not through a port a Compose service publishes, which the Docker daemon serves) in the first
   sample, or no process of the run left to list at all while one should serve it (an empty listing
   would pass anything). Repeated at every `renew`.
   Then the **Docker runtime gate**, for what no static check can see (a script such as `npm run
   docker:up`), over the window since `up` began (`since`: the daemon's own clock, `docker info`,
   read at step 3, so a second's tolerance is enough). The run's own objects carry the label
   `com.docker.compose.project=<the run's project>` (a volume may instead be a new anonymous one); a
   container of the run may mount only the run's volumes, join only the run's networks (or none),
   bind-mount nothing step 5 refuses, run unprivileged, and publish only the run's ports (never a
   random one, nor every exposed port with `-P`; the ports asked for and the ones the daemon bound
   alike). What is not the run's falls under the **owner-state rule**, so a cycle can run beside a sapu
   sweep whose gates use the same daemon: an object that existed before `since` and is not the run's
   may not be touched — not started, and no action on it in the daemon's events (an exec other than the
   container's own healthcheck, a copy in or out with `docker cp`, kill, stop, removal or other change
   of a container — not `die` alone, a container ending by itself; the removal of a volume or network);
   an object created during the cycle that is not the run's (a sweep's gate container, say) is refused
   only when it touches the owner's state — a container that mounts a volume that existed before
   `since` (listed, or by a `volume mount` event, which also shows a container removed since), joins a
   network that existed before `since` (the default `bridge` and `none` aside; `host` included),
   bind-mounts a path inside the main checkout (a linked worktree inside it, such as a sweep's under
   `.claude/worktrees/`, is not the main checkout) or a container runtime or datastore socket or a
   directory holding one (the testcontainers reaper aside: "Beside a sapu sweep"), or is privileged; a
   volume whose device binds such a path. What such an object does to itself is its own. The events
   come from the run's **events follower**, started at step 3 when a daemon answers:
   `docker events --since <since> --format '{{json .}}'` in its own recorded process group, writing
   `<logs>/docker-events.jsonl` (the daemon replays only its last 256 events to a later `--since`, so
   only a follower sees a long cycle whole); the gate reads that file, then catches up with `docker
   events --since <the last event it saw> --until <the daemon's now>`. A follower that no longer runs
   leaves the gate blind: refused. Every teardown stops the follower like any process group, after the
   gate. Otherwise `down` and refuse, naming the object. Repeated at every `renew`, at `up --fresh`,
   and at `down`, where a finding is reported but never stops the teardown. No docker, or no daemon
   running, means nothing was created through it (a run whose daemon did not answer at step 3 has no
   follower; its gate reads the daemon's own window from `since`).
9. **Proxy.** Records `allowOrigins` (the expanded `allow_origins`) in run.json, then starts the
    run's filtering proxy (§9) as `argus-live.mjs proxy <run>`, detached into a process group recorded
    as the run's `internal` group `proxy` before anything waits; it listens on 127.0.0.1 at a port the
    system gives it and reads its allowed origins from run.json once, at start. Once it reports its port, run.json
    `internal.proxy` is written (by the proxy's start, its one writer).
10. **Logins.** One proving login per configured account — every user of every role with `users`
    (`<role>.<k>`, k from 1 in order) and once per login-command role (`<role>.1`) — sequential,
    `login_spacing_ms` apart, in slot `up/` (its CLI config written there), each
    followed by a check that the browser's requests reached only the run's origins and
    `allow_origins` — any other origin (e.g. a redirect to the owner's own server) → refuse, naming
    it. The check reads only the requests and WebSockets of the login's own pages (popups, redirects
    and blocked requests included), never the proxy's log: Chrome's own start-up traffic, which no
    flag stops entirely, reaches the proxy too and is no page's request. A login that fails →
    `refused: <role>.<k> could not sign in (<reason>)` and `down`. The proving sessions are then
    closed and their records dropped.
11. **Run files.** `.argus/live/run.json` gets its instance id; a detached **reaper**, started with
    the run id as soon as run.json first exists (step 1), runs `down` at the deadline unless `renew`
    moved it, and exits without acting when the lock names another run. `up` ends by printing the
    run's **summary**, one line of JSON free of secrets — `{runId, instanceId, deadline, baseUrl,
    origins, ports, worktree}` (`deadline` in epoch seconds) — and `status --json` repeats it with
    `mode` (`map` for an `up --map` run, else `live`; null when no cycle runs) and
    `slots`, each slot's `{journey, generation, calls, max, submitted, retired}` (`retired`: it holds
    no live token; `status` marks such a slot ` retired`), and `stale: true` once the lock's deadline
    has passed (the next `up` takes it over and recovers it, so journeys.md's ORIENT goes on): the
    orchestrator reads that, never run.json.
    `status` prints `mode: map` for a map run and a map slot as `slot <n>: map generation <g> calls
    <c>/<max>`, and ends its first line, `cycle <run> until <time>`, with ` (stale: up recovers it)`
    once the deadline has passed.

    **`run.json`** (mode 0600, under the gitignored `.argus/`; written from step 1 on, so a session that
    dies mid-`up` leaves a record for the reaper and for recovery). Every write is a read-modify-write
    under the run's lock claim (`down` below). Each key has one owner: a writer merges only its own
    keys over the record as it stands, so a key another owner wrote — or one a later version adds — is
    kept. `up` and `up --fresh` write only `up`'s keys (every row below whose writer is `up` or `up
    --fresh`, except `reaper` and `internal`, which have their own writers). This is its one schema:

    | Key | Holds | Written by |
    |---|---|---|
    | `runId` | the run id | `up` step 1 |
    | `digest` | `{live, env_file}`: sha256 of `.argus/live.json` and of the env_file as `up` read them | `up` step 1 |
    | `reaper` | the reaper's pid | the reaper's start (`up` step 1) |
    | `ports` | `{<name>: port}` of every `{port:<name>}`: what pages and processes use | `up` step 3 |
    | `browser` | `{js, channel}`: the pinned CLI's entry point and the Chrome-family channel | `up` step 2 |
    | `internal` | `{<name>: port}` the run's own machinery uses (`proxy`): never in `ports` or the origins | the proxy's start (`up` step 9) |
    | `allowOrigins` | the expanded `allow_origins`, which the proxy and every slot config admit | `up` step 9 |
    | `upstream` | `{<port>: address}`: the loopback address each run port's listener passed health on (the proxy connects a loopback name such as `localhost` there, never at another listener on that port; a port with none recorded answers 502) | `up`'s health waits; rewritten by `up --fresh` |
    | `origins` | the run's origins (above), from `ports` only | `up` step 3 |
    | `baseUrl` | `base_url`, expanded | `up` step 3 |
    | `home` | the run's HOME | `up` step 3 |
    | `env` | the instance environment, secret values included: stop records are replayed with it | `up` step 3 |
    | `since` | the daemon's clock at step 3 (epoch ms; the local clock without a daemon) | `up` step 3 |
    | `events` | the events follower's file, or null without a daemon | `up` step 3 |
    | `mode` | `"map"` for a map run; absent otherwise | `up --map` |
    | `worktree` | the worktree's absolute real path (null before it exists); the guard reads it | `up` step 4, `up --map` |
    | `worktreeHead` | the commit the worktree was built at (copied to `worktree.json`, step 4) | `up` step 4, `up --map` |
    | `composeServices`, `composePorts` | the Compose projects' service names, and the host ports they publish | `up` step 5 |
    | `groups` | `[{name, pgid, started, cmdline, members: [{pid, started, cmdline}], exited}]`: every process group the run started (setup steps, the follower, `reset`, start entries), recorded as it starts; members and command lines re-read from `ps` at every write, secret values masked | every start; `up --fresh` drops those it stopped |
    | `stops` | `[{name, cmd, cwd, env}]`: each start entry's stop, as `down` replays it (`cmd` holds variable references, never a secret value) | every start of an entry with `stop`; `up --fresh` |
    | `instanceId` | set once `up` (or `up --fresh`) passed every step; null meanwhile (`pw` refuses then) | `up` step 11, `up --fresh` |
    | `sessions` | `[{name, slot, account, cwd, home, daemon: {pid, pgid, started}, browser: {pid, pgid, started}}]`: every CLI session (§9 "Sessions"), recorded before it opens | the session's open; its close (the proving logins, `up --fresh`, a reopen) |
    | `slots` | `{<n>: {journey, generation, tokenHash, accounts, retired, submitted}}`: each slot's token as its sha256 (§9 "Token"); a map slot's `{mode: "map", journey: null, accounts: {}, …}` | `slot`, `slot --map`, `slot --handoff`, `submit`, `up --fresh` (retires) |
    | `loginFailed` | `{"<role>/<user>": reason}`: the configured accounts whose login failed this run (never retried) | the login |
    | `closing` | true once a `down` sealed the record | `down` |

**`renew`** extends the deadline by `limits.max_cycle_minutes`, never past start + 3 × that + the
same 15 min grace as the first deadline (so a short cycle can still renew), and
appends `<run id> deadline <epoch>` to `sapu-live.log`; the cycle renews after each explorer returns and before each repro. Reaching the cap ends the cycle;
candidates not yet reproduced are journalled `not reproduced: harness`.

**`up --fresh`** (between repro runs) keeps the lock, worktree, dependencies, ports, proxy, reaper,
setup groups and events follower: it first retires every slot's token and clears the instance id (so
`pw` refuses every call but `submit` from then on), stops every `start` entry (running its `stop`),
drains and then closes every CLI session whose slot is not `up` (the explorers' and the repro
runner's, §9, §10) as run.json holds it then (the tokens retired first, so no call reopens one after
its close; one still running stays recorded for `down`), starts the `phase: store`
entries, runs `store_check` and `reset`, starts the rest, runs `store_check`, the egress check and the
Docker runtime gate again, takes a new instance id, and prints the summary. It makes no proving
logins, and `loginFailed` survives it. A failure tears down from run.json as it stands (the sessions
and slots other writers recorded meanwhile) under its own in-memory keys.

`up --fresh` and `renew` refuse, leaving the run as it is for `down`, a map run (`refused: cycle <run>
is a map run (up --map); run down`), a cycle whose `up` did not finish
(no instance id), whose deadline passed, that a `down` sealed, or whose `.argus/live.json` or env_file
changed since `up` (`refused: .argus/live.json changed since up; run down and up again`: the run was
checked against the files as they were; `down` reports such a change and tears down as recorded,
its output masked with the env_file's values as `up` read them, recovered from run.json, as well as
with those now).

**`up --map`** (§6 map mode) runs step 1 — the lock and its start line, recovery of stale runs,
`dropLedgers`, run.json with `mode: "map"`, `instanceId: null` and no group, the reaper — and step 4's
worktree at HEAD with its `worktreeHead` (and `worktree.json`, written with `mode: "map"`); nothing else: no setup, store, app,
proxy, HOME or logins. It reads only `limits.max_cycle_minutes` from `.argus/live.json` (the lock's
deadline). It prints `{runId, mode: "map", deadline, worktree}`; a failure after the lock runs `down`.

**`down`** first seals `run.json` (every write of it is a read-modify-write under the run's lock
claim, refused once the lock no longer names the run, once `down` sealed it, or once `down` removed
it: so an `up` racing a `down` cannot add a process group the teardown did not read, and fails into
its own teardown instead), then replays each stop record, sends SIGTERM to each process group that still runs what was
recorded and SIGKILL after 10 s, stops the proxy, drains each recorded CLI session into the run's
secret ledger (§10; a session found gone while its account's state says `drained: false` marks the
ledger `<session> lost before its drain`, one that cannot be drained `<session> could not be
drained`, and a drain that throws part-way marks each session it had not drained `<session> closed
undrained`) and only then closes them by name (never
`close-all`: other projects share the CLI) and kills by identity what they leave, removes its own
worktree (`--force` on that worktree only) and its HOME (read-only trees made writable first), removes
each slot's secrets and CLI state (`.playwright/`, `state.json`, `lock`, `totp.json`) under that
slot's lock, waiting at most 10 s for a `pw` call still holding it (every writer of those files —
a `slot` mint, a handoff, a `pw` call — holds that lock and re-checks run.json under it just before it
writes, so one that outlives the wait writes nothing), keeps `out/`, `files/`, `returns/`,
`repro/`, `worktree.json` and `logs/` — the secret ledger `logs/secrets.jsonl` and `logs/seen.jsonl`
among them, so `scrub` and `map-check --merge` still work after `down` — (evidence for the owner and
the repro), deletes every file under `r/out/traces/` that no repro run that exited 2 names (§10
"Traces"), kills the reaper last, removes `run.json` and the
lock, appends `<run id> end <epoch>` to `sapu-live.log`, and leaves the data for the next reset. A step
that fails is reported and the next one runs: `run.json`, the lock and the end line are always
finished, and what could not be removed is named for the owner; the end line is written under the
lock's claim by the `down` that removes the lock, so a second `down` adds none. A worktree whose
directory is already gone loses its record in `.git/worktrees` (that one only, never a repo-wide
prune). A group "still runs what was recorded" when its leader has the pid and start time `run.json`
recorded for it (captured when the group started; boot ticks compared exactly, an `lstart` within a
second), or one of its members a recorded pid and start
time (a daemon a setup left behind, its leader gone): unlike a command line, that survives an exec and
a changed process title, and a reused pid has another start time. A group whose own leader has exited
while a process holds its pid is someone else's, so it is neither recorded nor killed. `down` and
recovery kill by this rule alone; command lines are recorded for reports. Recovery (and a teardown
given no drain) closes sessions undrained: each recorded session with a daemon appends `<session>
closed undrained` to that run's ledger, so `scrub` refuses the run.
Known limit: process groups are the unit of every kill, so a process that leaves its group (one that
calls `setsid`, a daemon that double-forks) escapes them. It is then outside the run's groups, so the
egress check does not see it either; it surfaces only when the next `up` finds its port taken.

**Beside a sapu sweep.** Separate ports, worktree, services and data let a journey cycle run while a
sweep gates PRs, but browsers and dev servers take CPU from its gates. `sapu-merge.sh` appends
` live=1` to a gates-log line (green, red or setup-failed) whose `[gate start, gate end]` overlaps
any run in `sapu-live.log`: a run lasts from its `start` to its `end` line, or, with no `end`, to the
latest deadline its `start` and `deadline` lines name. A `live=1` line never counts toward the flake
ledger (neither half of a red-then-green proof), and a red gate's verdict line adds `(this gate ran
beside a journey cycle)`. `limits.max_parallel_journeys` bounds the load. On a shared Docker daemon,
the runtime gate's owner-state rule (step 8) lets a sweep's gates create, use and remove their own
containers, volumes and networks during the cycle; only what touches objects older than the cycle, or
the owner's volumes, networks, checkout or sockets, ends it. A sweep whose tests use testcontainers
runs its reaper (Ryuk: image `testcontainers/ryuk*`, label `org.testcontainers.ryuk=true`), which
bind-mounts the Docker socket to remove its own session's containers: the gate exempts it from the
socket rule alone.

## 9. Browser driver and wrapper

`@playwright/cli` (Microsoft's agent-oriented CLI, more token-efficient than its MCP server), an exact
pinned version, never `npx -y` (which pins no integrity and reads the npm cache under the HOME the run
replaces): the plugin ships `scripts/pw/package.json` and its `package-lock.json` (an integrity for every
package), `up` installs them once per user with `npm ci --ignore-scripts` into the user's own cache
(macOS `~/Library/Caches/sapu/pw-<lock hash>`, else `${XDG_CACHE_HOME:-~/.cache}/sapu/pw-<lock hash>`;
not `$TMPDIR`, which macOS prunes file by file), writes a manifest (path, size, sha256 of every file)
and verifies it on every use — a file missing, changed or added is a reinstall. The CLI runs with
`node` in a clean environment: `PATH`, `USER`, `SHELL`, `LANG`/`LC_*`, `HOME` = `<run HOME>/browser`,
`TMPDIR` = `<that HOME>/tmp` (Chrome's profiles die with the run; on Linux reached through the link
`<sockets dir>/tmp`, since Chrome there puts its process-singleton socket in `TMPDIR` and exits on a path
longer than 107 bytes), `NO_UPDATE_NOTIFIER=1`, and its daemon
sockets in `/tmp/sapu-<uid>/<hash of that HOME>` (0700, this user's own: a socket path holds at most 103
bytes, which the run's HOME exceeds; the teardown removes the directory, since the CLI leaves its
sockets behind); nothing of the owner's `PLAYWRIGHT_*`, `PWTEST_*`, `NODE_OPTIONS` or `XDG_*`. The
repo needs no Playwright of its own.

**Per-slot CLI config**, written by `slot` when it mints slot `<n>` to
`.argus/live/<run>/<n>/.playwright/cli.config.json` (with the signal script beside it, `signals.js`,
both 0600, and the fixtures in `<n>/files/`), by `up` for its proving logins in slot `up/`, and by
the repro runner at the start of every run in slot `r/`, with the repro's context in place of
`live`'s locale, timezone and viewport (§10); the
slot's directory is the CLI's cwd, so its location also scopes the CLI's session namespace. The keys,
as 0.1.22 reads them:
- `outputDir` = `.argus/live/<run>/<slot>/out`, `timeouts.idle` 30 min, `console.level` `info`,
  `allowUnrestrictedFileAccess: false`;
- `browser.browserName` `chromium`, `browser.isolated: true`,
  `browser.launchOptions`: `channel` (Chrome, else Edge), `headless`, `proxy.server` (the run's proxy)
  and `args` (the host rules, the WebRTC flags and the quiet flags below);
- `browser.contextOptions`: `locale` and `timezoneId` from `live.locale`/`live.timezone` (a repro's
  own context overrides them, §10), `viewport` (the first of `viewports`, 900 high),
  `serviceWorkers: "block"`;
- `browser.initScript`: the signal logger (§7), installed in every page and popup;
- **network block, in layers:** a **filtering forward proxy** that admits only the run's origins and
  `allow_origins` — plain HTTP in absolute form, `CONNECT` and WebSocket upgrades. It runs as
  `argus-live.mjs proxy <run>`, an internal process group of the run listening on 127.0.0.1 at a port
  it is given by the system (§8 step 9); origin-form requests and absolute `https://` answer 400 (it is
  no reverse proxy); a run host that is not loopback by itself is resolved again at each connection and
  connected to only while it resolves to loopback alone, at the address checked; each blocked origin
  is logged once to `logs/proxy-blocked.jsonl`; and it exits by itself once the lock names another
  run. Chrome gets it with
  `--proxy-bypass-list=<-loopback>`, so loopback traffic goes through it too (Chrome bypasses a proxy
  for loopback by default); `network.allowedOrigins` = the same set; `--host-resolver-rules` mapping
  every host to NOTFOUND except the run's hosts and `allow_origins` hosts;
  `--webrtc-ip-handling-policy=disable_non_proxied_udp`; and Chrome's own background services kept
  quiet (background networking, component updates, sync, pings, the sign-in, push-messaging and
  component-update URLs pointed at a refused loopback port, and the prefetch, optimization-guide,
  autofill-server and similar features disabled — one `--disable-features` list repeating
  Playwright's, since Chrome keeps the last). One start-up connection of Chrome's still reaches the
  proxy, which blocks it: every judgement about where a page went (the proving logins, the
  `blocked:` lines the explorer sees) reads the page's own requests, never the proxy's log alone.
  **Origins are compared exactly** — by the proxy, by `goto`'s URL check and by the login check: a
  host as the run's origin spells it (lower case, one form per IP address, no trailing dot, default
  ports filled), loopback spellings kept apart (`localhost`, `127.0.0.1` and `::1` may be different
  listeners on one port), so `http://127.0.0.1:<p>` is not `http://localhost:<p>`. A loopback name is
  connected to at the address its listener passed health on (run.json `upstream`, §8), a loopback
  address as written. A live probe with 0.1.22 showed host rules
  plus a proxy plus the WebRTC flag stop page fetches, beacons, images, WebSockets and WebRTC to an
  outside host; the filtering proxy extends that to other ports on loopback. None of these binds
  Node-side code, which is why the explorer gets neither `run-code` nor `eval`, and the runner never
  runs a code string it did not build. Requests blocked this way are logged once and never become
  console-error candidates.

**The wrapper**, `argus-live.mjs pw <token> <role>[.<n>] <command> [args]`, is the only way in
(`<role>.<n>` is the role's n-th allocated account; a plain word, so it needs no quoting):
- **Token.** `argus-live.mjs slot <n> --journey <id> --accounts <role>.<k>=<user>|<role>.<k>,…`
  mints a random token per explorer dispatch and prints it in one line of JSON `{slot, token,
  generation, journey, accounts}` — the only place a token exists: `run.json` `slots[<n>]` keeps its
  sha256 alone (`{journey, generation, tokenHash, accounts, retired: [<sha256>…], submitted}`).
  `slot <n> --handoff` retires the current token and mints the next generation with a fresh budget; a
  slot has at most three generations (the first and two handoffs). An account (a configured user, or a
  login-command role's `.1`) serves one slot per run. Each slot keeps its counters in `<n>/state.json`
  (calls, loops, its sessions' state, the blocked origins it was told, the accounts its journey
  created) under `<n>/lock`, which every `pw` call and handoff of the slot holds. The wrapper refuses
  an unknown or retired token, and a role or account outside that journey's allocation. A **map
  token** (`slot <n> --map`, §6) holds no account and takes `pw <token> code …` and `pw <token> submit
  <json>` only, in a run with no instance id too (anything else: `refused: a map slot takes only code
  and submit`); its calls are counted as an explorer's (a refusal too, with its `calls` line), under
  the same `BUDGET` and `DEADLINE`, its `code` output fenced and masked with the env file's values, and
  its writes re-check only that the run is named and not sealed. Known limit: the token is an argument of the
  explorer's command line, so while a `pw` call runs any local user can read it in the process list;
  the lane assumes a single-user development machine (on a shared host, another user could spend the
  slot's budget, though never reach the CLI past the wrapper's checks).
- **Commands allowed to the explorer:** `goto` and `tab-new`; `click`, `dblclick`, `fill`, `type`,
  `select`, `check`, `uncheck`, `hover`, `press`, `drag`; `upload` (files from `live.fixtures`, which
  `slot` copies from HEAD into the slot's `files/`); `go-back`, `go-forward`, `reload`; `snapshot`, `find`,
  `screenshot`, `console`, `requests`, `request`, `response-body`; `resize`; `tab-list`,
  `tab-select`, `tab-close`; `dialog-accept`, `dialog-dismiss`; `code grep <pattern> [<pathspec>]` and
  `code files [<pathspec>]` — fixed argv `git --literal-pathspecs -C <wt> grep -z -n -I --no-color
  -e <pattern> HEAD -- <pathspec>` and `git --literal-pathspecs -C <wt> ls-tree -z -r --name-only HEAD
  -- <pathspec>`, no flag from the explorer: HEAD's tree only (as the explorer's Read sees blobs at HEAD), any path under `.argus/` (compared without case) filtered out, each path printed
  absolute inside the worktree, output fenced like page text; `login <user> <password>` (accounts
  the journey itself created: a user of `roles.*.users`, in any slot, is refused, and a created account's
  failure is kept in its slot, never in run.json's `loginFailed`; the password goes to the run's secret
  ledger as `created password` before the sign-in, §10); `trigger <name> [values…]`; `facts <marker>`; `mail`; `submit <json>`.
  Everything else is refused — `run-code`, `eval`, `route`, `unroute`, `network-state-set`,
  `state-*`, `cookie-set`, `*storage-set`, `attach`, `close-all`, `kill-all`, `list`, `show`,
  `install*` — as are the flags `-s`/`--session`, `--config`, `--browser`, `--cdp`, `--profile`,
  `--extension`, `--headed`, and any file argument.
- **URLs and paths.** A `goto`/`tab-new` path must match `^/(?![/\\])`; a URL is parsed with WHATWG
  `URL` and must use `http` or `https` with an origin among the run's origins, compared exactly
  (above), and carry no credentials or control characters. So `//host`, `/\host`,
  `javascript:`, `data:`, `file:`, `view-source:` and `http://localhost:<port>@host` are refused.
- **Values into commands.** `trigger`, `facts` and `mail` run their argv with no shell; each value
  replaces one placeholder (`{1}`, `{2}`…) and must match that placeholder's regex in `args` (default
  `^[A-Za-z0-9][A-Za-z0-9._@:-]{0,127}$`); a leading `-` is refused even when a custom `args` regex
  allows it, so a value read from a page can never become a command or an option. The browser
  commands' positionals go to the CLI after `--`, so none is read as an option either.
- **Sessions** are named `<run>-<slot>-<role>.<k>`, always with the account's number (an explorer's
  bare `<role>` is `<role>.1`); the repro runner's live in slot `r` (`.argus/live/<run>/r/`, named
  `<run>-r-<role>.<k>`, the accounts those of the candidate's slot). `anon` is never signed in. Each is recorded in run.json `sessions`
  before `open` runs, as `{name, slot, account, cwd, home, daemon, browser}`, the daemon and the
  browser (Chrome's root, which leads a process group of its own) each `{pid, pgid, started}`. A
  session of any slot but `up` is recorded only while run.json has an instance id, and its opened record
  only while its pending one is still there: one an `up --fresh` began under is closed again by its
  opener, never left past that run's close pass. The
  teardown closes each by name (`close`, in its own cwd and HOME), kills what still runs as recorded
  by identity, then sweeps what no record names: daemons of the run by name, orphaned browsers by HOME.
- **The wrapper's own browser code** (the login stages, the probe, the `hook`, the observation, the
  `shot` stage and the repro's step templates) comes from
  fixed templates: its payload enters only as one JSON literal (`const P = <JSON>;`), targets only as
  the JSON literals the target parser emits; it is written 0600 to `.playwright/run-<nonce>.js`, run
  as `run-code --filename=<file>` and removed, and the CLI's echo of it is never shown.
- **The in-daemon hook.** `hook`, a stage run once after every session open of an explorer or repro
  slot (not the proving logins), installs once per browser context (`ctx.__argus`; listeners a
  `run-code` attaches to the context outlive the call): request and response listeners that record the
  values of the `Cookie`, `Authorization`, `Proxy-Authorization` and `*-token` request headers and
  every `Set-Cookie`, each 5xx, and the id-shaped path segments and JSON string leaves (24+
  characters, a letter and a digit) of the run's origins; `console` and `pageerror` listeners on every
  page; and a `domcontentloaded` listener on every page and popup that evaluates the signal script
  again (§7). A header value is recorded once (a `Set` of every value it recorded, no count cap) until
  `capBytes` (4 MiB) of distinct values per context; past it nothing more is recorded and `overflow` is
  set, which the drain turns into the ledger marker `<session> passed <capBytes> bytes`. Errors keep at
  most 200 and ids 2000 of each kind until the next drain (a lost id costs one redaction, never a
  secret). Every `pw` call ends with a drain (`observe`), every repro step with its template's own: the
  context's cookies and storage and what the hook gathered go to the run's secret ledger and
  `seen.jsonl` (§10), and the account's state is marked `drained: true` (`false` from the command's
  start). A session found gone while `drained: false` marks the ledger `<session> lost before its
  drain`. A hook that fails is told as `harness: hook failed` among the open's events. For `pw`'s
  sessions the session driver then marks the ledger `<session> unhooked` — at whichever open failed
  to hook (a first use, a reopen, a login-command role's re-login) — and the session is used all the
  same, its headers unrecorded. The repro runner never uses an unhooked session (the run ends at once,
  `HARNESS: step <n> <role>.<k> hook failed`), so it marks nothing.
- **Screenshots.** After `pw … screenshot` the call drains first, then the `shot` stage reads the text
  of the page and of every frame (iframes included), every input value, and whether a password or
  one-time-code field is visible and the page an error page (main document status ≥ 400, or a
  `chrome-error:` page). Beside each PNG the call wrote goes `<name>.verdict.json` (0600) `{t, sha256,
  passed, reasons}`: `sha256` of the PNG's bytes as written; reasons `secret` (that text holds a scrub
  secret, §10; also when the ledger is gone or incomplete, a frame could not be read, the stage failed
  or the call did not drain), `password-field`, `one-time-code-field`, `error-page`. Never the text;
  nothing of the verdict is printed.
- **Login** (also used by `up`), with the role's own `login_url`, `logged_in` and optional
  `login_open` (a control to click first, for a login modal): open the login page fresh each time
  (CSRF tokens); fill the visible user field (`type=email`, else the text input before the
  password); if no password field is visible, submit and wait up to `settle_ms` for one (two-step
  forms); fill `input[type=password]` and submit; if a one-time-code field appears
  (`autocomplete=one-time-code`, else the single visible text input), fill an RFC 6238 code computed
  with Node's own `crypto` — never a time step already used for that secret (recorded, as a hash of the
  secret and its last step, in `<MAIN>/.git/sapu-totp.json` under a file lock, shared by every process
  and kept across runs: a cycle starting within 30 s of the last one must not reuse a step), waiting for the next
  step when under 3 s remain. Success = `logged_in` visible within `settle_ms`. A failed login is
  never retried within a run (lockout); a 429 or a lockout message is a harness event.
  `login: {command}` runs per session open and must print a fresh storage state each time, which
  goes into that session's config at open. The wrapper's login actions never appear in its output,
  the trail or a repro: after every successful login the session's `requests --clear` and
  `console --clear` run.
- **Re-login:** when `logged_in` is gone from the page after a command while the session was signed
  in, a probe tab opens at the role's base_url; only when `logged_in` is absent there too (a page
  without the header is not a lost session) does the wrapper sign that session in once, report
  `re-logged-in: <role>.<k>`, and not repeat the command (it may have side effects). A login-command
  role's session is closed and opened again with a fresh storage state. Every probe is told as
  `probed: <role>.<k>` outside the fence and logged to `logs/probes.jsonl` (`{slot, account, url,
  start, end}`), so the probe tab's request to the base_url is told apart from the page's own.
- **Absence is never instant:** a `find` with no match is asked again every 500 ms up to
  `settle_ms`, then `found after <ms> ms` or `not found after <ms> ms`.
- **`request`** prints the values of `Cookie`, `Set-Cookie`, `Authorization`,
  `Proxy-Authorization` and every `*-Token` header as `<masked>`.
- **Exit codes:** 0 the command ran (a CLI error is page data, inside the fence), 1 refused or
  `BUDGET`/`LOOP`/`DEADLINE`/`HARNESS`, 2 the wrapper failed. `BUDGET` and `DEADLINE` apply to every
  command but `submit`. While the run is not live, every command but `submit` is refused and counts
  nothing: `refused: cycle <run> has no instance (its up did not finish)` during an `up --fresh`,
  `refused: cycle <run> is being torn down` once a `down` sealed run.json; and every write of the
  slot's files re-checks it just before it writes, so a call in flight during a `down` leaves nothing.
- **Output** from the page is fenced by `<<<PAGE-<nonce>` … `PAGE-<nonce>>>>` with a fresh random
  nonce per call. Inside the fence: the CLI's answer and the page's lines — the new signals, the
  console's new errors and warnings, and `blocked: <origin>` once per slot for an origin the run
  blocked that a page named (never as a console error). In it every marker shape (`PAGE-`,
  `RETURN-`) gets U+2011 for its hyphen, C0 and C1 controls become U+FFFD (newlines and tabs kept,
  CRLF as LF), and past 24 000 characters the rest is dropped and counted. Outside the fence, only the
  wrapper's own vocabulary: `calls <c>/<max>`, `loop <n>/3`, `re-logged-in: <role>.<k>`,
  `session-reopened: <role>.<k>`, `probed: <role>.<k>`, `found after <ms> ms`, `not found after <ms>
  ms`, `truncated <n> characters`, `exit <n>` (a role-free command's), the harness lines (`HARNESS:
  …`, `harness: login failed`, `harness: observation failed`, `harness: probe failed`), `BUDGET:`,
  `LOOP:`, `DEADLINE:`, refusals, and `login: ok` or `login: failed (<reason>)`. Inside the fence every secret value (the env file's,
  the role passwords and TOTP secrets, created accounts' passwords) is masked however the page or the
  CLI encoded it: per character as is or in its other case, backslash-escaped, `\uXXXX`, `\xHH`, an
  HTML entity, `%HH` of its UTF-8 bytes or `+` for a space (so JavaScript's, Go's, Python's and PHP's
  JSON, HTML and URL forms alike, mixed freely); or the value in base64 (padded or unpadded from 8
  characters, URL-safe, and inside a longer base64 text at any byte offset from 7: a 6-character secret
  after 4 or 5 other bytes, `base64("abc:" + pw)`, is 7) or in hex, either case, from 4 bytes; and the
  same for the value URL-decoded, when it holds `%HH`. Known limit: a character whose other case is more
  than one character (`ß`, upper-cased `SS`) is matched only in the cases that are one character. A value longer than 256 characters is matched part by part —
  parts of 256 characters, each overlapping the next by 16, the last ending at the value's end — so the
  whole value is masked and no pattern grows past what the regular-expression engine can run. Known
  limit: where the page text starts or ends inside such a value, the piece of it the text holds that
  no whole part covers — shorter than 256 characters — matches no part and is not masked. A pattern that cannot be built or run withholds the whole text:
  `*** (withheld: a secret's pattern could not be run)`, never the engine's message (which quotes the
  pattern, and so the value). Outside it the wrapper prints only its own fixed words: a
  login's failure is `rejected`, `rate-limited`, `no-login-form`, `no-totp-secret` or `error:
  playwright`, Playwright's own text (which may quote the page) going to the run's `logs/logins.log`.

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

A candidate's `repro` is a list (at most 100 elements); its first element may be the context, every
other one a step or `{"parallel": [steps…]}`:

```json
[ { "context": { "viewport": 1440, "locale": "en-US", "timezone": "UTC" } },
  { "as": "customer", "do": "goto", "path": "/orders/new" },
  { "as": "customer", "do": "fill", "target": { "label": "Quantity" }, "value": "2" },
  { "as": "customer", "do": "click", "target": { "role": "button", "name": "Place order" } },
  { "as": "customer", "do": "read", "target": { "testId": "order-number" }, "save": "order" },
  { "as": "customer", "expect": "visible", "target": { "text": "{{order}}" } },
  { "as": "system",   "do": "trigger", "name": "payment-settles", "values": ["{{order}}"] },
  { "as": "customer", "expect": "fact-equals", "marker": "{{order}}", "field": "status", "value": "paid" },
  { "as": "sales",    "do": "goto", "path": "/" },
  { "as": "sales",    "expect": "visible", "target": { "text": "{{order}}" }, "final": "handoff" } ]
```

- **Context.** `{"context": {viewport?, locale?, timezone?}}`: a width of 200–4000, a BCP 47 locale, a
  time zone Intl knows; each defaults to `live`'s first viewport, locale and timezone (else 1440,
  `en-US`, `UTC`). A fault reads `refused: repro: context: <reason>`.
- **Steps.** `as` is a role or `<role>.<n>` (the n-th account SELECT allocated, from the candidate
  slot's allocation), or `system` for `trigger`, `fact-equals` and `mail` only. Actions: `goto` (a path,
  `^/(?![/\\])`, on the role's origin), `click`, `dblclick`, `hover`, `check`, `uncheck` (+ `target`),
  `fill`, `select` (+ `target`, `value`), `press` (+ `key`, letters, digits and `+`, at most 32;
  `target` optional), `go-back`, `reload`, `read` (+ `target`, `save`), `trigger` (+ `name`, `values`),
  `login` (+ `user`, `password`). `{ "parallel": [steps…] }` holds 2 to 8 actions of different
  accounts — never a `trigger`, a `login` or the final — started together behind one barrier 1500 ms
  ahead; its members are numbered as steps. Targets: `{role, name?, exact?}`, `{label}`, `{text}`,
  `{placeholder}`, `{testId}`, each with optional `nth` (−1 to 1000) and `within` (a target); `css`,
  `title`, `altText` and snapshot refs are refused. Expectations: `visible`,
  `hidden`, `enabled` (+ `target`), `text-equals`, `text-contains`, `value-equals` (+ `target`,
  `value`), `count` (+ `target`, a whole number 0–10 000), `url` (+ a path), `fact-equals` (+ `marker`,
  `field`, `value`, through `live.facts`), `mail` (+ `to`, `contains`: a message from `live.mail` to that
  address holding the text), `no-error` (the acting account's 5xx responses, console errors and page
  errors since the previous step: lines of a blocked request or naming an origin outside the run's
  origins and `allow_origins` never count, nor does Chrome's `Failed to load resource: the server
  responded with a status of <k>` line, a 5xx being counted once from its response). Each expectation,
  the final included, is polled — browser ones every 200 ms in the page, `fact-equals` and `mail`
  every 500 ms — up to `settle_ms` and holds at its first success. Every string is at most 500
  characters without control characters; an unknown key is refused; at most 100 steps.
- **`login` steps** sign an account in as a user the journey created: `{"as": "<role>.<k>", "do":
  "login", "user": <string>, "password": <string>}`, `as` an allocated account written with its number
  (never `anon`), `user` never a configured user (`roles.*.users`) after substitution, and `password`
  written with the `{{marker}}` placeholder, never as a literal. The runner appends the substituted
  password to the run's ledger as `created password` before the sign-in (so `scrub` refuses it after
  `down` too), and signs in with slot `r`'s state.json `createdFailed` as the failure record, never
  run.json's `loginFailed`; an account whose first step is a `login` is opened without signing its
  allocated user in.
- **Literals only.** `{{marker}}` (`argus-<8 hex>`, fresh per run) and `{{<saved name>}}` (a `save`
  name matches `^[a-z][a-z0-9_]{0,31}$`, never `marker`; a `read` saves an input's, textarea's or
  select's value, else the element's trimmed text, at most 500 characters) are substituted textually in
  string fields, the result a literal; a name used before the `read` that saves it is refused. A
  `trigger`'s literal values meet its `args` regexes before any browser work. The runner builds every
  CLI command and locator itself from the schema and runs each browser step as the wrapper's own
  `run-code` template (§9), its target through the target parser and its values as JSON literals, in
  slot `r`'s sessions, through the same driver, proxy and per-slot config as an explorer's; `goto`
  takes a path through the wrapper's URL check, and `trigger`, `fact-equals` and `mail` run their argv
  with no shell.
- **Every state-changing step** — `select`, `check`, `uncheck`, `trigger` and `login` always; a
  `click`, `dblclick` or `press` when the page sent a request other than `GET` or `HEAD` during it — is
  followed by an `expect` proving its effect as the acting role sees it: the first `expect` as the same
  account after it (after its `parallel` group), before that account's next action other than `read`
  and before the list ends; a `trigger`'s is the first `expect` of any account, before the next
  state-changing step. The always-state-changing ones are checked before any browser work, the click
  family once it ran; a list that breaks the rule exits 2.
- **The `final` step** names its oracle and states the **correct** behaviour, as a RED test would;
  its shape comes from the oracle's template in `journeys.md`, never free-form: handoff — `visible`
  on the marker on role B's landing page; status coherence — `fact-equals` or `text-equals` the other
  role's saved value; dead end — `enabled` on the control the next map step needs, as the role the
  map assigns; reversal — `fact-equals` the saved pre-reservation amount; orphaned work — `hidden` on
  the marker in the role's inbox; claim race — `count` of resulting records equals 1 after a
  `parallel` group; stale view — `fact-equals` the newer state after acting from the old page;
  interrupted flow — `count` equals 1 and `no-error`; viewport and locale — `visible` and `enabled`
  on the critical control under the repro's `context`; re-entry — `value-equals` the saved value;
  discoverability — `visible` on the control on the role's landing page or navigation. As checked:
  one `final`, on the last step; its kind handoff, discoverability and unreachable step `visible`;
  status coherence `fact-equals` or `text-equals`; dead end `enabled`; reversal and stale view
  `fact-equals`; orphaned work `hidden`; re-entry `value-equals`; viewport and locale `visible` or
  `enabled`; claim race `count`, after a `parallel` group holding two accounts of one role (each
  proving its action with `visible` on a target with `nth: 0`, since one row or two may match);
  interrupted flow `count`, right after a `no-error` of the same account.
- **References and records.** `argus-live.mjs repro <slot>.<generation>.<k>` names candidate `k`
  (1-based) of `returns/<slot>.<generation>.json` of the lock's run; the runner reads the repro there,
  so the orchestrator never re-types one. A ref of another shape, no running cycle, no such return or
  candidate, or a slot never minted is refused (`refused: repro: …`, CLI exit 1). The candidate's
  records go to `.argus/live/<run>/repro/<ref>/` (0600 files, kept by `down`): `repro.json` (the whole
  list, written by a run of it), `run-<i>.json` `{exit, step, expected, observed, shownSha256, ms,
  saved, traces, changed, reduced}` (`saved` the values `read` saved, masked; `traces` the trace files
  the run wrote; `changed` the click-family steps that changed state; `reduced` true for a minimizer's
  run), `steps-<i>.jsonl`, `verdict.json`, `minimize.json`, `min.json` and `red.spec.ts`. Run numbers
  continue: each run takes one past the highest `run-<i>.json` the candidate's records hold (an
  unreadable one included), so a later `repro`, `--once` or `--minimize` never overwrites an earlier
  run's records; the `run <i> ` prefix of `repro`'s lines counts that repro's own runs (1, 2).
  Refs are numbered per run, so a later cycle can hold the same ref again.
- **One run** (`repro <ref> --once`): the list checked (a refusal → `HARNESS: repro: step <n>:
  <reason>`); an acting account in run.json `loginFailed` → `HARNESS: <role>.<k> cannot sign in this
  cycle`, no browser opened (a repro's own failed sign-in of a configured account is recorded there
  too, so it is never retried); `up --fresh` (`fresh: instance <id>`); slot `r` under its lock to the
  end, its config written with the repro's context; each account's session opened on first use,
  hooked, signed in (unless `anon`, a login-command role, or its first step is a `login`); then each
  step. Outside any fence only the wrapper's words: one `step <n> <account|system> <kind>:
  ok|held|failed|changed-state` line per step, `truncated <k> characters`, and the last line; what
  the failed final expected and what the page showed go in one nonce fence before it, secrets masked.
  The run ends by draining each account, `tracing-stop`, and closing its sessions.
- **Exit codes.** 0 = every step held (not reproduced): `NOT REPRODUCED`. 3 = reproduced, valid only
  when the last line of stdout is `REPRODUCED step=<n> expected=<kind>[:<number>] observed=<enum>` —
  enums and integers only, `observed` one of `absent`, `hidden`, `visible`, `disabled`, `differs`,
  `errors:<k>`, `count:<k>` — and every earlier `expect` held. Anything else is a harness failure,
  exit 2 with `HARNESS: step <n> <reason>` or `HARNESS: <reason>` last, journalled as H2 and never
  counted as reproduced: another exit code, 3 without that line, an expectation that failed before
  the final or could not be judged (a strict-mode violation), a missing target, an action that failed
  (`HARNESS: step <n> <action> failed (timeout|error)`), a session lost (`HARNESS: step <n> <role>.<k>
  lost its session`), a hook that failed at an open (`… hook failed`), a `login` step that failed
  (`HARNESS: step <n> <role>.<k> login failed`; the cycle unaffected), an uncaught error (`HARNESS:
  failed: <message, masked>`).

**Reproduce.** After every explorer of the cycle has returned, each candidate, one at a time: every
run starts from `up --fresh` (a clean reset, no explorer or earlier-run leftovers), and the candidate
runs twice. **Filed only at 2 of 2** (exit 3 both times); 1 of 2 is journalled as intermittent, never
filed. `repro <ref>` is that rule: run 1, and run 2 only when run 1 exited 3, each run's lines
prefixed `run <i> ` (a fence left whole), then the verdict — run 2's `REPRODUCED …` (exit 3), `NOT
REPRODUCED runs=<k>/<n>` (exit 0; `runs=1/2` the intermittent case) or `HARNESS: run <i>: <reason>`
(exit 2, at once: also an exit 3 without its `REPRODUCED` line, and any exit but 0, 2 and 3) — and
`verdict.json` `{runs: [exit…], verdict: "reproduced"|"not-reproduced"|"intermittent"|"harness"}`.

**Traces.** Each repro account's `tracing-start` runs only after its sign-in (right after its open for
`anon` and for an account whose first step is a `login`); a `login` step stops the account's trace
before it and starts a new one after it, so no trace holds a password typed into a form or a sign-in's
request. Traces stay in `r/out/traces/` (the slot's 0700 directory), named in `run-<i>.json`. They
still hold the session's cookies and requests, so they are never attached or filed, and `down` deletes
every trace file but those a run that exited 2 names: only an H2 run keeps its traces, local only.

**Minimize** (`repro <ref> --minimize`) = drop one step or one role at a time and re-run, each run from
`up --fresh`. Its base is the newest run of the whole list that exited 3 (`refused: repro: <ref> has no
reproducing run (repro <ref> first)` without one), so a `--once` run is enough. Removal units, tried
in this order, each once: each role but `system` and the final step's role (all its steps); then, from
the last step back, each single step that is not the final, not a `trigger`, not a `parallel` group's member,
not a proving `expect` and not a role's only state-changing step — a state-changing step (as the base
run recorded them) together with its proving `expect`. A unit whose reduced list the static checks
refuse is skipped without a run (`try <label>: skipped (the static checks refuse it)`); any other costs
one run (`try <label>: exit <k>`) and is kept only when it exits 3 failing the final **the same way**
as the base: the same `expected`, `observed` and `shownSha256`, a digest of what the failed final
showed with the values of the placeholders the final names put back as those placeholders (without it
a reversal repro could lose its cancel: with or without the defect, the stock fails `fact-equals` as
`differs`). Runs stop at `limits.minimize_runs` (default 12), one of them kept for a confirming run of
the result (`confirm: exit <k>`). Last line `minimized <ref>: steps <a> → <b>, runs <k>/<max>, stopped
fixpoint|budget|down|deadline, confirmed yes|no`: `fixpoint` when no unit is left untried, `budget` at
the cap. Before each run, a try or the confirm, the lock must still name the candidate's run (else
`stopped down`), and at least the longest of the candidate's recorded runs (its `run-<i>.json` `ms`,
read as minimize starts), a minute at the least, must be left before the lock's deadline (else
`stopped deadline`); either stops it at once, with no confirm run, and exits 2 (else 0). `min.json` (the
context element first) is written only when the confirm run failed the same way, else the whole list
stays the one filed; `minimize.json` `{runs, max, stopped, from, to, confirmed, tried}` always. No
browser work enters the orchestrator's context.

**RED test** (`repro <ref> --test`) is refused unless the candidate's `verdict.json` says
`reproduced` (2 of 2): `refused: repro: <ref> did not reproduce two of two (<verdict>); repro <ref>
first`, `<verdict>` `not-reproduced`, `intermittent`, `harness` or `never run`. It writes
`red.spec.ts` from `min.json` when the last minimize confirmed it, else from `repro.json`, and prints
`red test: <absolute path>`.

**Saved values** (`repro <ref> --saved`, for the issue body): the values the candidate's newest
reproducing run of its whole list (a `run-<i>.json` that exited 3 and is not a minimizer's) read with
`save`, as scrub would let them leave: per value `saved <name>: <JSON string>`, long tokens the run never
saw redacted as scrub redacts them (§"Scrub"), or `saved <name>: *** (<class>)` for one holding a
scrub secret (`*** (unchecked)` when its matcher failed); a name that is not a save name prints as
`(name not shown)`. Scrub's run refusal (a ledger gone, damaged or incomplete; the configuration
unreadable) → that line, exit 1. Refused without a reproducing run (`refused: repro: <ref> has no
reproducing run (repro <ref> first)`); it needs no `verdict.json`.

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

`argus-live.mjs classify --oracle <o> [--money] [--stock] [--moved-twice] [--acted-on] [--rule]` reads
the oracle's row (`--rule`: a written rule exists) and prints `class <A|B(a)|heuristic> labels <l>,…
severity <S1|S2|S3|at most S3|by outcome> because <the row's words>`, its labels ending `argus`,
`found-by:user` and the heuristic class carrying the contract's `labels.needsOwner` (an invalid
contract is refused). A flag that does not move the oracle's row is accepted and ignored; a flag given
twice, or an oracle the table lacks, is refused. argus's own adjustments stay the orchestrator's.

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
session. `/sapu:sapu` lists it in B2's SKIP, and `/sapu:forge`'s priority ladder skips it. `gh issue create --label <needsOwner>` is allowed; the
guard refuses adding or removing it on an existing issue or PR, and creating, editing, deleting or
cloning the label, for every subagent (§11). The owner removes it to accept; closes the issue as not
planned to rule it intended, which argus records in `arid.md` as today, and the next charters for
that journey carry it under `intended`. That close is the owner's ruling, so the guard refuses it to
every subagent (§11). `question` keeps its present meaning.

**The secret ledger** is `.argus/live/<run>/logs/secrets.jsonl` (0600), one `{"c": <class>, "v":
<value>}` per line, appended by every drain (§9 "The in-daemon hook") and by every `login` of a created
account (class `created password`, from `pw` or a repro). The drains record, as class `header`, the
`Authorization` and `Proxy-Authorization` values whole and without their scheme word, every `*-token`
value whole, and a `Cookie` header's pairs and a `Set-Cookie` value's first pair; as class `cookie`,
the context's cookies; as class `storage`, `localStorage`/`sessionStorage` items. A cookie only when
its name is a secret name — it holds `password`, `passwd`, `secret`, `token`, `session`, `sessid`,
`credential`, `cookie`, `bearer`, `signature`, `authorization`, `jwt`, `api[-_]?key` or
`private[-_]?key` anywhere (any case: `JSESSIONID`, `PHPSESSID`, `csrftoken`), or one of its words, split
at anything but a letter or digit and where camelCase turns, is `auth`, `oauth`, `authn`, `authz`,
`sid`, `sig`, `pin` or `pwd` (a plural too: `connect.sid`, `authToken`, `AUTH_PIN`, `MYSQL_PWD`; never
`SIGNAL`, `CONSIDER` or `AUTHOR`) —,
it is flagged HttpOnly or Secure, or its value is high-entropy (at least 16 characters, at least three
of lower case, upper case, digit and other, no whitespace); a storage item only when its key matches
a secret name or its value is high-entropy — a value that parses as a JSON object or array never whole,
each string leaf by the same rule under its own key. Every value is cut to its first 4096 characters;
a value of these three classes shorter than 6 is not recorded (it would refuse every issue; `pw`'s
fence still masks it). Nothing is lost silently: the markers `incomplete` (`<session> passed <capBytes>
bytes`, `<session> lost before its drain`, `<session> could not be drained`, `<session> closed
undrained`, `<session> unhooked`) say where something may be missing. `<session> unhooked` is set by
the session driver for `pw`'s sessions (§9 "The in-daemon hook": a first use, a reopen or a
login-command role's re-login whose hook failed), never by the repro runner, which ends such a run
with `HARNESS` instead. The ledger lives under `logs/`,
which `down` keeps, so it survives `down` and `scrub` never needs the run live; the next `up`'s step 1
(`up --map`'s too) deletes every earlier run's ledger. Until then it holds the dead instance's session
values, 0600 under the run's 0700 directory. Beside it, `logs/seen.jsonl` keeps the ids the run's
pages saw: id-shaped path segments of the requests to the run's origins and JSON response leaves —
never a leaf under a key matching `/token|secret|key|pass|session|auth|csrf|cookie|bearer|value|jwt|credential|sig|signature|code|otp|nonce/i`,
a segment after one matching `/reset|verify|invite|magic|token|confirm|activate|unsubscribe/i`, or a
value starting `eyJ`.

**Scrub, before every `gh issue create` and `comment`:** `argus-live.mjs scrub (--run <runId> | --ref
<slot>.<generation>.<k> | both) --title <t> --body <file> [--attach <png>…] [--create [--label <l>…] |
--comment <n>]` (`--run` and `--ref` may also be given together). It reads only what `down` keeps (the run's ledger and seen ids, the configuration), so
a run that is down is scrubbed the same way. It checks the run it is told, never the newest: text from
one run checked against another's ledger would let the first run's secrets through. `--run <runId>`
names the run; `--ref <slot>.<generation>.<k>` names a candidate, and the run is the one whose
records (`repro/<ref>/`) hold it; both together name the candidate in that run. With `--ref`, the
candidate's `verdict.json` in that run must say `reproduced` (2 of 2). Refused, each with exit 1 and
no `gh` run:
- neither flag: `refused: scrub: name the run (--run <runId>) or the candidate (--ref
  <slot>.<generation>.<k>); nothing is filed`; a malformed one: `refused: scrub: --run takes a run id;
  …` or `refused: scrub: --ref takes <slot>.<generation>.<k>; …`;
- a ref no run directory holds: `refused: scrub: no run here reproduced candidate <ref>; nothing is
  filed`; a ref more than one run directory holds — a second cycle that reached the same ref, since
  refs are numbered per run and `down` keeps `repro/` — `refused: scrub: candidate <ref> was reproduced
  in more than one run; name it with --run <runId> too; nothing is filed`, so such a ref always needs
  `--run` beside `--ref`;
- a run with no directory here: `refused: scrub: no run <runId> here; nothing is filed`;
- a candidate not reproduced 2 of 2: `refused: scrub: candidate <ref> of run <runId> did not reproduce
  two of two (<verdict>); nothing is filed`, `<verdict>` `not-reproduced`, `intermittent`, `harness`
  or `never run`;
- a map run (run.json's `mode` while it names the run, else `worktree.json`'s, §8 step 4): `refused:
  scrub: run <runId> is a map run (up --map): it drained no session and keeps no secret ledger;
  nothing from it is filed`;
- a title holding a line break: `refused: scrub: a title is one line`; a body file it cannot read:
  `refused: scrub: the body file cannot be read (<error code>)`.

Then, against the run it named:
- **Refuses the run** — `nothing from this run is filed` — when its ledger is gone (`refused: scrub:
  the run's secret ledger is gone (a later up removed it); nothing from this run is filed`), holds an
  `incomplete` marker (`refused: scrub: the run's secret ledger is incomplete (<why>); nothing from this
  run is filed`) or a line it cannot read (`refused: scrub: the run's secret ledger is damaged`); and
  when `.argus/live.json` or the env file cannot be read (`refused: scrub: .argus/live.json: <why>;
  nothing is filed`), or the contract is invalid (`refused: scrub: <why>`): its secrets would be unknown.
- **Refuses the issue** when the title, the body or a label holds a secret. Classes:
  - the ledger's: `cookie`, `header`, `storage`, `created password`;
  - `env file`: every value of `env_file`, now and as `up` read it (the owner declared them secrets),
    at any length, but a switch word (`true`, `false`, `yes`, `no`, `on`, `off`, in any case, `0`, `1`)
    or a plain number: digits only, at any length under a name that ends in a unit or limit word
    (`TIMEOUT`, `TTL`, `AGE`, `EXPIRES`, `EXPIRES_IN`, `EXPIRY`, `MIN`, `MAX`, `LIMIT`, `LEN`, `LENGTH`,
    `SIZE`, `COUNT`, `PORT`, `RETRIES`, `INTERVAL`, `DAYS`, `HOURS`, `MINUTES`, `SECONDS` or `MS`, the
    whole name or after `_`, any case), else under 6 characters under a name that is no secret name
    (`PORT=3000`, `SESSION_TIMEOUT=3600` and `JWT_EXPIRES_IN=604800` stay; `ADMIN_PIN=73914826` and
    `DB_PASSWORD=1234` are secrets);
  - `repo env file` (the owner's `.env`, `.env.local` and `guard.envFiles`) and `environment variable
    <NAME>`: sources that mix configuration with secrets, so only what is secret-like. Never a value
    under 4 characters, a switch word or a plain number (as for `env file`: any other number, 6 digits
    or more or under a secret name, is judged as any value), nor a variable named `PWD`,
    `OLDPWD`, `INIT_CWD`, `HOME`, `TMPDIR`, `TMP`, `TEMP`, `PATH`, `SHELL`, `USER`, `USERNAME`,
    `LOGNAME`, `LANG`, `LANGUAGE`, `LC_*`, `TERM*`, `XDG_*_HOME` or `SSH_AUTH_SOCK`, nor a
    `CLAUDE_CODE_*` variable whose name is no secret name (names compared exactly, upper
    case: `CLAUDE_CODE_OAUTH_TOKEN` is judged, `CLAUDE_CODE_ENTRYPOINT` never); otherwise a value whose
    name is a secret name, or a high-entropy value that is not an absolute path under a name that
    does not end in a place word (`DIR`, `PATH`, `HOME`, `CWD`, `ROOT` or `PREFIX`, the whole name or
    after `_`, any case; `…_PWD` is a password's name, `MYSQL_PWD`). An absolute path starts `/`, `~/` or `C:\` and has at least two
    non-empty segments of path characters (letters, digits, `_`, `.`, `@`, `~`, `,`, `-`), never a `+`
    or `=`: a base64 value that starts with `/` is judged by its entropy. Claude Code's own
    `CLAUDE_CODE_CHILD_SESSION=1` would otherwise refuse every issue holding a lone `1`;
  - `role password` and `TOTP secret`: `.argus/live.json`'s roles, expanded.

  Empty values are ignored. The separators below are whitespace, punctuation, symbols and invisible
  format characters (Unicode `Cf`, read a code point at a time: a soft hyphen, a zero-width space, a
  word joiner, a tag character). The text is searched as it is and after one and two rounds of decoding
  each `%HH` run and HTML entity once (`%2541` → `%41` → `A`, `&amp;#65;` → `&#65;` → `A`), so a value
  encoded twice is found too. A value of 6 characters or more is found in every encoding `pw`'s fence
  masks (§9 "Output": either case, hex, base64 at any byte offset, URL-decoded too), or when the text
  and the value, each stripped of separators, contain it. Detection looks for windows of the value, 64
  characters long, one starting every 32 characters (the last ending at the value's end): any run of 95
  characters or more of a value (64 + 32 − 1) holds a whole window wherever it starts, so its middle or
  its tail alone is found; a value of 64 characters or fewer is one window. Hits of windows that overlap
  or touch are one hit, so a whole value is one. Most windows' patterns are never built: one pass over
  the text lists every 4 characters it may spell in any mix of those encodings, and a window is matched
  only when the text may spell each 4 of its characters, or holds its base64 or hex (200 values of 4096
  characters against a 64 KB text take about 0.3 to 0.9 s). Known limit: a piece shorter than 95
  characters of a value longer than 64 may hold no whole window and is not found. A shorter value — or one
  under 6 once stripped of separators — is found only as a whole token, not preceded or followed by a
  letter or digit: raw, URL-decoded, as its base64 (padded, unpadded or URL-safe) and spelled out with
  separators between its characters, never as part of a longer word. So a ledger-class value is never
  short (the 6-character floor is theirs), a `repo env file` or `environment variable` value counts
  from 4 characters, and an `env file`, `role password`, `TOTP secret` or `created password` value at
  any length. Each hit prints `<title|body> <line>:<col> <class>` (1-based, a hit in a stripped or
  decoded form placed at its first character) or `label <i> <class>`, then `refused: scrub: <k>
  secret(s) in the issue; nothing is filed` — never the value, never the text around it. A pattern that
  cannot be built or run refuses by class alone: `refused: scrub: a <class> value could not be checked;
  nothing is filed`, never the engine's message (which quotes the pattern, and so the value). Exit 1,
  the body file untouched, no `gh` run.
- **Redacts in place** (`<redacted>`, fenced blocks included) every other run of 24+ `[A-Za-z0-9_-]`
  holding a letter and a digit, not all hex (a commit sha stays), and not among the run's seen ids
  (record ids such as cuid or ULID stay readable).
- **Defangs**, outside fenced blocks and code spans as CommonMark reads them, by wrapping in
  backticks: every `http(s)` URL whose host is not loopback, its scheme in any case (`HTTPS://`) and its
  slashes escaped, entity-encoded or not (`https:\/\/`, `https:&#47;&#47;`; trailing punctuation left
  outside), a `www.` host, a protocol-relative target where GitHub would follow it, its slashes the same
  (`\/\/host`, `&#47;&#47;host`, `&#x2F;&#x2F;host`, `&sol;&sol;host`) — a link's or an image's
  (`[x](//host/…)`, `[x](<//host/…>)`, `![x](//host/…)`), a reference definition's (`[1]: //host/…`),
  either on the line after its `](` or `]:` too, and an HTML `src=`, `href=`, `poster=` or `srcset=`
  value, the attribute's name in any case (`src="//host/…"`, `SRC=//host/…`, every candidate of a
  srcset) —,
  `owner/repo#<n>`, `GH-<n>`, `#<n>` (not after `&`, an HTML entity) and `@user` or `@org/team`, each
  with the backslashes right before it; a bare `//host` in prose is left as it is. A backtick run with no
  closer on its line, or a span holding a `|` (a GFM table splits there), is escaped instead, so no span
  crosses a line, a block or a cell. Fenced blocks whose info string is `ts`, `typescript` or `json`
  (the generated test, the repro) stay whole; every other keeps at most 20 lines (`… <k> lines cut`).
  The title gets the same treatment. What scrub would file is checked for secrets again after the
  rewrite.
- **Prints** `scrub: ok; redacted <n>, defanged <n>, cut <n> line(s)` and `title: <the scrubbed
  title>`, and rewrites the body file in place.

**Screenshots.** Each `--attach` prints `attach: <name>` or `local: <name> (<reason>)`, the file named
by its path from MAIN (else its base name). One is attached only when `gh --version` is 2.99 or later,
`gh repo view` says `PRIVATE` or `INTERNAL` (a visibility it cannot tell counts as public), the
contract's policy `traces` is not `none`, the file is not under a `traces/` directory, it is a regular
`.png` right in a slot's `out/` of the run by its real path, its verdict (§9 "Screenshots") passed, and
its bytes still hash to the verdict's `sha256`; otherwise its reason (`gh older than 2.99`, `public
repository`, `traces none`, `a trace, never attached`, `not a screenshot of this run`, `no verdict
recorded`, `the screenshot changed after its verdict`, or the verdict's own: `a secret on the page`, `a
password field`, `a one-time-code field`, `an error page`). The local ones are named in one `Local
evidence:` line appended to the body (once, however often it is scrubbed). Traces are never attached.

**Filing.** With `--create` (and its `--label`s: 1–50 characters, no comma or C0 control character,
not starting with whitespace, only with `--create`) or `--comment <n>` (never both), once the text passed, scrub runs `gh issue
create|comment … --body-file <file> [--attach <png>]…` with no shell. An issue's labels end with the
contract's `labels.agentFiled` (default `sapu:agent-filed`; given once, whatever its case among the
`--label`s; none under `policy.traces` `"none"`), as every agent-filed issue's do (CONTRACT.md,
Agent-filed issues). `--create` is refused, with no gh run, when a committed contract cannot be read
(`refused: scrub: the committed sapu contract cannot be read (<its first error line>): nothing is
filed`; no contract at all files under the defaults), when the committed contract's
`policy.fileIssues` is `false` (`refused: scrub: the contract's policy.fileIssues is false: nothing is
filed (skills/sapu/policy.md)`) or a `--label` is its acceptance label in any case (`refused: scrub:
label <i> is the acceptance label (<name>): only an acceptor applies it`). An issue or comment URL in gh's
stdout means filed — `filed: <url>` or `commented: <url>`, exit 0, whatever gh's exit — and is never
re-filed; none → `failed: gh issue create|comment exited <k> before printing an issue URL` (exit 2).
gh's own output is never printed. Without either flag scrub only checks and rewrites.

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

For every subagent, the lane's script itself (`argus-live.mjs`) is the orchestrator's: only its reads
`status`, `status --json` and `check` pass, every word after the script literal (a redirection aside),
and the explorer's `pw` (above). Any other verb is refused when the script is reached by its name in
any case or the real file behind a path (a symlink of another name), by its path, through an
interpreter as its first operand past its options and their values, or loaded by an interpreter's
option (`-r`, `--import`, spaced or after `=`), behind env prefixes, wrappers (`env`, `exec`, `nice`,
`xargs`) and `sh -c`; a script name or a loaded file the shell builds whole (`node "$S" up`, `node $(…)
up`, `node --import=$S x up`) counts as the script when one of its verbs, or any word the shell
builds, follows. Only the first operand is the script: `node --test a.test.mjs argus-live.mjs` and
eslint over the file pass, and `node --check` runs nothing. Not caught (a guard LIMIT): a copy of the
script under another name, or an interpreter's own code that imports it (`node -e`). `map-check
--list` rewrites `.argus/journeys.json`, so it is not a read.

## 12. Errors

| Event | Response |
|---|---|
| `up` refuses or fails | the step and the tool's own error are quoted, every secret value masked; `down` runs; the cycle ends with that report (`/sapu:argus` chooses another lane); the owner's servers are untouched |
| A `setup` command outlives the lock's deadline | it is killed; `failed: setup <cmd> timed out`; `down` runs |
| Another cycle holds the lock | refuse, naming its run and deadline |
| The owner's Docker context is not a local unix socket (tcp, ssh) | refuse before step 5, naming the context and its scheme only; `down` runs |
| A Compose project, Compose file or config command would share something with the owner's stack, or run Docker past the check | refuse, naming the service, file or field and the rule; `down` runs |
| The Docker runtime gate finds a run container on another's volume or network (or otherwise outside step 8's rule), an object that is not the run's and existed before the cycle started or acted on during it, a new object that is not the run's touching the owner's state, or a follower that no longer runs | `down`; refuse, naming the object; at a `renew`, the cycle ends and its candidates are journalled `not reproduced: harness`; at `down`, reported and the teardown goes on |
| The egress check finds a foreign endpoint or a datastore socket, or its listing cannot be trusted | `down`; refuse, naming process and endpoint; at a `renew`, the cycle ends and its candidates are journalled `not reproduced: harness` |
| `map-check` drops every journey, or none is selectable | the cycle ends before `up`, listing the dropped journeys and their reasons |
| Session lost mid-journey | the wrapper signs in once; failing again → a harness event (H2), not a candidate |
| Login rate-limited or locked | a harness event; that account's journey stops for the cycle |
| Goal cannot be reached | the permission checks say the role may not → not a candidate; they say it may → discoverability candidate |
| A precondition is missing | created through the UI by a role allowed to, or by a `trigger`; otherwise the charter is re-scoped (argus's standing order) |
| A browser session dies | the command that finds it gone reopens it (and signs it in) and is not run: `session-reopened: <role>.<k>`; the explorer resumes from its last trail step |
| Another local user reads a slot's token from the process list while a `pw` call runs | a known limit (§9 "Token"): the lane assumes a single-user development machine |
| An explorer returns `aborted`, hits `DEADLINE`, or returns nothing | its submitted trail and reason are journalled; its candidates still go through repro |
| `up --fresh` fails in the repro phase | the remaining candidates are journalled `not reproduced: harness`, never dropped |
| The session running the cycle dies | the reaper runs `down` at the deadline; the next `up` recovers anything left |
| A stale reaper wakes | it exits without acting when the lock names another run |
| Repro exits other than 0 or a valid 3 | journalled as H2 with the failing step and the trace path; never filed |
| A repro's acting account is in run.json `loginFailed` (the explore phase's or an earlier repro's failed sign-in) | the run exits 2 at once, `HARNESS: <role>.<k> cannot sign in this cycle`, no browser opened for it; never retried (lockout) |
| A repro `login` step fails | the run exits 2, `HARNESS: step <n> <role>.<k> login failed`; the failure is kept in slot `r`'s state.json `createdFailed`, never in run.json `loginFailed`; the cycle is unaffected |
| `repro <ref>` names no return, no candidate, a slot never minted or no running cycle | `refused: repro: …`, CLI exit 1; nothing runs |
| Minimize finds, before a try or the confirm, the lock no longer naming the candidate's run, or less than the longest of its recorded runs (a minute at the least) left before the deadline | it stops at once, no confirm run, `stopped down` or `stopped deadline`, exit 2; the candidate is journalled with where minimizing stopped |
| `scrub` refuses | the issue is not filed; the candidate is journalled with the reason; on a hit, the orchestrator rewrites the place named and scrubs again, never pasting the value anywhere |
| The run's secret ledger is gone, damaged or incomplete | `scrub` refuses the whole run: nothing from it is filed, and the journal says so |
| A run's ledger after `down` | kept 0600 under `logs/`, so scrub of that run still works; the next `up` (or `up --map`) removes it, and scrub of the old run then refuses as gone |
| `scrub --ref` names a candidate not reproduced 2 of 2 (or `repro --test` does) | refused, naming the verdict (`not-reproduced`, `intermittent`, `harness`, `never run`); nothing is filed or written |
| `scrub` names neither `--run` nor `--ref` | refused: `refused: scrub: name the run (--run <runId>) or the candidate (--ref <slot>.<generation>.<k>); nothing is filed` |
| A second cycle reproduces the same ref (refs are numbered per run, and `down` keeps each run's `repro/`) | `scrub --ref <ref>` alone is refused: `refused: scrub: candidate <ref> was reproduced in more than one run; name it with --run <runId> too; nothing is filed`; the orchestrator passes `--run <runId>` beside `--ref` |
| `scrub` names a map run | `refused: scrub: run <runId> is a map run (up --map): it drained no session and keeps no secret ledger; nothing from it is filed`, after `down` too |
| A screenshot changed after its verdict | not attached: `local: <name> (the screenshot changed after its verdict)`, named in `Local evidence:` |
| `up --fresh` or `renew` on a map run | `refused: cycle <run> is a map run (up --map); run down` |
| `map-check --merge` on a slot whose newest return is not a map, or one that no longer validates, or in a run that recorded no worktree commit | refused, naming the slot, the first five faults or the run; `.argus/journeys.json` untouched |
| `git worktree remove` refuses a worktree the instance dirtied | `--force` on the run's own worktree only |
| `down` or recovery cannot remove something (a read-only module cache, a directory it may not write) | read-only trees are made writable first (symlinks not followed); what still cannot be removed is named in the report; `run.json`, the lock, the end line and the stale run's claim are finished anyway, so the next `up` is not blocked |
| A recorded process group now runs something else (its pid reused by the owner's process) | not killed; named in the report |

`run.json` (§8 step 11) holds the run's expanded environment, secret values included (an `env` value
that names `${NAME}` holds the value), so its stop records replay with exactly that environment; it is
mode 0600 under the gitignored `.argus/`, and `down` and recovery remove it. Shell fields keep only
references (`ARGUS_SECRET_<NAME>`), and command lines recorded from `ps` are stored with secret values
masked.

## 13. Cost

Estimates from the probe and `sapu-metrics` prices, to be replaced by pilot measurements:
- Explorer, one journey, Opus/high, about 100 steps at an average context near 100K: **$4–5**
  (cache reads about $2, output about $1.6, cache writes about $0.9); about 25–40 minutes.
- Map refresh: one map-mode call reading code, about $2–4, only when §6's triggers fire.
- `up`, `up --fresh`, `up --map`, `down`, `map-check`, `select`, `visit`, repro, minimize, `classify`,
  `drift`, scrub: no LLM tokens. Wall-clock: one
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
with a fixed variant behind a switch (`$DEFECTS_FILE`: the defects on, comma separated, re-read on
every request) — a dead-end state, a double stock release on cancel, a
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
- **`up --fresh`:** "up --fresh keeps the proxy, closes the explorer and repro sessions (never the up
  ones) and retires every slot's token".

`tests/argus-live-findings.test.ts` (no browser; a CLI shim where a session is involved):
- **The DAG:** "every argus-live module imports only modules below it"; "origins are compared as the
  run spells them"; "the instance module's header names every module, each after the modules it
  imports".
- **Session driver and hook:** "ensure opens the session on first use and reuses the recorded one",
  "a hook that fails is told among the open's events, and the session is used all the same", "a gone
  browser is reopened and the command is not run", "relogin probes before signing in", "observe keeps
  the drain in the ledger and seen.jsonl and marks the account drained; a reopen after a command marks
  it lost", "maskSecrets holds the env file's, the roles' and the created accounts' values", "the
  hook's code takes its payload only as JSON".
- **Ledger:** "ledgerEntries takes only secret-like cookies and storage, and every secret header",
  "secretHits finds a value raw, URL-encoded, base64-encoded and split by spaces, and says where", "a
  short configuration secret is matched as a whole token only", "seenIds keeps the ids and none of the
  tokens", "a damaged ledger refuses; a gone one is null; an incomplete one says why", "drainSessions
  marks what it could not drain", "a drain that throws mid-way leaves the sessions it had not drained
  marked undrained".
- **Repro sessions:** "slot r is a slot", "a repro session is recorded only while the run has an
  instance", "down closes them".
- **Repro DSL:** "FINAL_KINDS holds decision 7's templates, one per oracle", "parseRepro reads §10's
  example", "the context defaults to live's viewport, locale and timezone", "each refusal names its
  step", "a claim race's parallel group and an interrupted flow's no-error pass", "a login step has its
  shape", "a trigger needs an expect of any account before the next state-changing step", "every step
  template drains", "stepCode embeds values only as JSON", "substitute is textual and literal",
  "reductions never offer a trigger, a final, a parallel group, a proving expect or a role's only
  state-changing step".
- **Two of two:** "3 then 3 reproduces: each run's lines prefixed, run 2's REPRODUCED line last", "3
  then 0 is intermittent; 0 stops after one run", "a harness failure stops at once and is never counted
  as reproduced", "a run is numbered after the candidate's records, never over one", "repro --saved
  prints the values the reproducing run read, masked by scrub's rules", "a candidate the return lacks
  is refused".
- **Classes:** one test per §10 row ("dead end: A, S1 on a money journey, else S2", …, "handoff,
  re-entry, discoverability, unreachable step: B(a) with a written rule, else heuristic and
  needs-owner, at most S3") and "each seeded defect's class line".
- **Minimize:** "keeps the essential steps and every step it may not drop, to a fixpoint, and
  confirms", "stops at its budget, one run kept for the confirm; an unconfirmed result is not written",
  "a reduction that fails its final another way is not kept", "never tries a trigger or the final; a
  reduction the static checks refuse costs no run", "refuses a candidate that never reproduced", "stops
  before a try once the cycle is down, or too little of its deadline is left".
- **Generated RED test:** "the §10 example matches the golden file"
  (`tests/fixtures/argus-red/order-to-cash.handoff.spec.ts`, written by hand before the generator), "saved
  names never collide", "the test is valid TypeScript", "strings never become code", "repro --test
  writes red.spec.ts from the confirmed min.json, else repro.json".
- **Scrub:** "each secret class is refused, raw, URL-encoded, base64-encoded and split by spaces, in
  the title and in the body", "a refusal says where, never what", "configuration that is not
  secret-like is not a secret", "a short configuration secret is refused as a whole token, never inside
  a word", "a cuid or ULID the run saw stays; an unknown long token is redacted", "mentions, references
  and outside links are defanged outside code", "scrub needs the run's whole ledger", "scrub works on a
  run that is down", "scrub checks the run it is told, never the newest: a later up's run leaves the
  earlier one unfileable", "with --ref, scrub files only a candidate that reproduced two of two, in the
  run that reproduced it", "a ledger or env_file value thousands of characters long is refused by its
  class, and no output holds any part of it", "a secret is refused case-folded, in hex, inside base64
  at any offset, URL-decoded and split by invisible format characters", "a long secret's middle or
  tail alone is refused: every part of it is looked for, not only the first", "every part of 200
  ledger values of 4096 characters is checked against a 64 KB body in under 3 seconds", "a 6-character
  secret inside base64 after 4 or 5 other bytes is refused, and a near miss is not", "environment and
  repo env values: a short secret from 4 characters is refused, a switch, a short plain number and a
  path never", "protocol-relative links and images are defanged too", "an angle-bracketed target, a
  reference definition, srcset, poster, escaped slashes and an upper-case scheme are defanged too".
- **Attachments and filing:** "a screenshot whose every condition holds is attached, and gh files the
  rewritten body", "a screenshot is attached only when every condition holds: <reason>" (one per
  reason), "a non-zero gh exit after the URL counts as filed", "the needs-owner label goes through
  create", "a label is checked as the title and the body are, naming where and never what, and a
  refused one runs no gh", "a body scrubbed again names its local evidence once", "a refused scrub runs
  no gh", "nothing scrub printed or gave gh holds a recorded secret, in any form, through the CLI too".
- **`map-check`:** "drops <case>" (a short anchor, a missing anchor, an anchor in a file HEAD lacks,
  one occurring four times, a user step with no route, a route segment no anchor names, a system step
  with an unknown trigger or anchored outside roots, an unknown role), "drops a
  later duplicate id and an id that is not kebab-case; the route / needs only an anchor under roots",
  "an anchor's file is read at HEAD, not from the working tree", "line moves to the nearest occurrence",
  "without .argus/live.json roles are unchecked", "refresh triggers", "a new drop asks for a refresh;
  the same drop again at the same head does not", "no journey kept is refused; a map that is not one is
  refused", "map-check starts nothing", "the catalog groups by domain and lists the drops", "the usage
  line names map-check".
- **Map mode:** "up --map takes the lock and a worktree and starts nothing", "a map slot reads code and
  submits a map, nothing else", "validateMap holds the map's schema", "a map slot can be minted while up
  is still starting", "map-check --merge keeps ids, lastCycle and the journeys the map did not return",
  "map-check --merge stamps the worktree's commit, not MAIN's HEAD", "up --fresh and renew refuse a map
  run", "the usage line names map mode".
- **Select:** "the score", "a global journey is selected alone, or waits", "no account serves two
  journeys; a journey waits when its accounts cannot be allocated", "a claim step gets a second account
  when one is free", "a login-command role serves one journey a cycle", "explicit ids print what they
  displaced", "users must be literal", "no journey is selectable", "the usage line names select".
- **Doc drift:** "code newer than the doc, the doc newer, both in one commit", "the newest of every code
  range counts", "uncommitted lines, a file with no history and a bad range", "author time decides, not
  committer time", "the CLI's verdict lines".
- **Visit:** "visit writes a journey's lastCycle, lastHead and filed into journeys.json, and nothing
  else".

`tests/argus-live-repro.test.ts` (in Chrome, on the fixture app):
- **Hook:** "a popup a link opened is watched from its first document", "the hook installs once per
  context", "header values are recorded once, and overflow is flagged", "a reopened session gets the
  hook again".
- **Ledger in Chrome:** "observation records the HttpOnly cookie, the jwt and the bearer token, never
  in pw's output", "the ids the run saw are kept, tokens are not", "down drains every session before it
  closes it", "up --fresh drains every session it closes", "the ledger survives down and the next up
  removes it", "a created account's password is in the ledger".
- **Screenshot verdicts:** "each screenshot gets a verdict at capture time, after its call's drain,
  over every frame, hashed, holding no page text".
- **One run:** "each seeded oracle defect reproduces, and its fixed variant does not", "a viewport
  defect reproduces at 390 and not at 1440; the delayed handoff is not a defect", "exit 2 on a broken
  target, a dropped prerequisite, a missing proving expect and an uncaught error", "a run's records are
  absent from the next run, and values with quotes are substituted as literals", "a login step signs in
  an account the run created, and its failure is the run's only", "an account whose login failed this
  cycle is never retried", "the run leaves a trace, begun after sign-in, and no session; down keeps only
  the traces of runs that exited 2".
- **End to end:** "a candidate goes from an explorer's submit to a filed issue, and down leaves no
  secret outside the ledger" (submit → `repro` 2 of 2 → `--minimize` → `--test` → scrub and filing
  through a fake `gh`).

`tests/argus-live-pw.test.ts` also holds "the findings and map commands are the orchestrator's: none
passes the explorer's guard", and for the fence's long and re-encoded secrets "a secret thousands of
characters long is masked whole in its every form, and no pattern ever fails on it", "a secret is
masked case-folded, in hex, inside base64 at any byte offset, and URL-decoded" and "an env_file value
thousands of characters long is masked in pw's output, and no pattern error prints it". `vitest.config.ts` excludes `tests/fixtures/**` (vitest would collect the
golden `*.spec.ts` as a test) and `.claude/**`.

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
  variable, and MCP fields, while a completed close passes; "the guard lets the map agent Read
  committed files of a map run's worktree".
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
  SELECT; B2's SKIP and forge's priority ladder name `labels.needsOwner`; `/sapu:init` adds `env_file` to `guard.envFiles` and
  creates the label.
- Acceptance: the pilots in §15.

## 15. Rollout

- **Release** 2.9.0 through the usual checklist (merge, tag, upgrade the repos that use sapu when
  idle, restart). The upgrade note covers the skills question, the new label, and the stricter owner
  labels (an `accepted` or `needsOwner` label with spaces or `, = " ' / [ ] { } ( ) %` is refused and
  must be renamed).
- **Phase 6** (§19, the smoke suite and its checks) is built before the pilot; the pilot moves to
  phase 7 and exercises both lanes.
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
| `plugins/sapu/scripts/argus-live.mjs` | new: `up`, `up --fresh`, `up --map`, `down`, `renew`, `status [--json]`, `slot`, `slot --map`, `slot --handoff`, `pw`, `intake`, `repro <ref> [--once\|--minimize\|--test\|--saved]`, `classify`, `scrub`, `map-check [--list\|--merge <slot>]`, `select`, `visit`, `drift`, the filtering proxy |
| `plugins/sapu/scripts/argus-live-origin.mjs` | new leaf: exact origins (`exactHost`, `canonicalOrigin`, `originOf`), `BLOCKED_ERROR`, `checkUrl` |
| `plugins/sapu/scripts/argus-live-start.mjs` | new: the bring-up blocks of `up` (ports, worktree, HOME, environment, setup, start, health, store) |
| `plugins/sapu/scripts/argus-live-session.mjs` | new: the session driver shared by `pw` and the repro runner (open, hook, sign-in, observe and drain), `drainSessions`, `maskSecrets`, `configuredUser` |
| `plugins/sapu/scripts/argus-live-ledger.mjs` | new: the secret ledger and `seen.jsonl` (§10), `dropLedgers`, the matcher `secretHits` |
| `plugins/sapu/scripts/argus-live-steps.mjs` | new: the repro DSL (`parseRepro`, `FINAL_KINDS`, `substitute`, the step templates, `reductions`) |
| `plugins/sapu/scripts/argus-live-repro.mjs` | new: the repro runner (`runOnce`), two of two (`repro`), `minimize`, `redTestFile`, `savedValues` (`--saved`) |
| `plugins/sapu/scripts/argus-live-classes.mjs` | new leaf: §10's class and severity table, `classify` |
| `plugins/sapu/scripts/argus-live-redtest.mjs` | new: the generated Playwright RED test |
| `plugins/sapu/scripts/argus-live-scrub.mjs` | new: `scrub` (`scrubRun`, the run it checks; `scrubSecrets`), the screenshot verdict's writer and reader, redaction and defanging |
| `plugins/sapu/scripts/argus-live-fence.mjs` | `secretPatterns` built part by part (256-character parts overlapping by 16), case-folded, hex, base64 at any byte offset and URL-decoded; `leakFinder`, which finds every 64-character window of a value (one every 32: any 95-character run) while building only the patterns the text may hold; `holds`; `mergedSpans`; `PatternError`, whose fixed words replace the engine's message |
| `plugins/sapu/scripts/argus-live-map.mjs` | new: the journey map (`validateMap`, `map-check`, refresh reasons, the catalog, `mergeMap`), SELECT (`score`, `selectJourneys`), PERSIST (`visitJourney`) |
| `plugins/sapu/scripts/argus-live-drift.mjs` | new: doc drift by author time (§5) |
| `vitest.config.ts` | excludes `tests/fixtures/**` (the golden RED test is a Playwright spec) and `.claude/**` |
| `plugins/sapu/scripts/sapu-merge.sh` | ` live=1` on gates-log lines overlapping `sapu-live.log`; excluded from flake proofs |
| `plugins/sapu/scripts/sapu-contract.mjs` | `journey` in `SKILLS`; `labels.needsOwner` |
| `plugins/sapu/scripts/sapu-guard.mjs` | §11 |
| `plugins/sapu/workflows/inspector.js` | its argus phase excludes the journey lane |
| `plugins/sapu/skills/init/SKILL.md` | `journey` in the skills question; the `live` block with `services` (from the tracked config and code defaults that name a local service), `live.roles` from `test_accounts`, `env_file` and its `guard.envFiles` entry, `reserved_ports`, the two `confirmed` statements in §8's words; creates `labels.needsOwner` |
| `plugins/sapu/skills/sapu/SKILL.md` | `labels.needsOwner` in B2's SKIP |
| `plugins/sapu/skills/forge/reference.md` | `labels.needsOwner` among the priority ladder's exclusions |
| `plugins/sapu/CONTRACT.md` | `labels.needsOwner`; version coupling; the explorer's guard rules; `sapu-live.log`; the gates-log `live=1` field |
| `plugins/sapu/.claude-plugin/plugin.json`, workflow metas | version 2.9.0 |
| `tests/…`, `tests/fixtures/journey-app/`, `tests/fixtures/argus-red/` | §14 |
| `docs/usage.md`, `docs/agents.md`, `docs/security.md`, `README.md`, `docs/img/src` | `/sapu:journey`, the new agent, requirements, the isolation and browser safety rules, a light and dark diagram |

Phase 6 (§19, built): new modules `argus-live-smoke.mjs`, `-minimize.mjs`, `-codegen.mjs`,
`-suite.mjs`, `-propose.mjs`, `-heal.mjs`, `-ci.mjs`, `-baseline.mjs`, `-layout.mjs`, `-a11y.mjs`, `-perf.mjs`,
`-seed.mjs`, `-report.mjs`; changes to `-config.mjs`, `-steps.mjs`, `-classes.mjs`, `-return.mjs`, `-repro.mjs`,
`-session.mjs`, `-pw.mjs`, `-slots.mjs`, `-map.mjs`, `-scrub.mjs`, `argus-live.mjs`, `sapu-guard.mjs`;
new engine text `skills/journey/smoke.md`; edits to the explorer's agent file, `journeys.md`,
`/sapu:journey`, `/sapu:init`, `standards.md`, CONTRACT.md and the docs. The plan's file table is
the list.

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

Phase 6 (§19) — every source read, the claim used and the decision it informs are in
[argus-journey-lane-6-research.md](../plans/argus-journey-lane-6-research.md); the main ones:
- Playwright best practices — https://playwright.dev/docs/best-practices · retries and flaky tests —
  https://playwright.dev/docs/test-retries · ARIA snapshots — https://playwright.dev/docs/aria-snapshots ·
  visual comparisons — https://playwright.dev/docs/test-snapshots · authentication —
  https://playwright.dev/docs/auth · parallelism and test locks — https://playwright.dev/docs/test-parallel ·
  CI — https://playwright.dev/docs/ci · accessibility testing — https://playwright.dev/docs/accessibility-testing
- Chromatic branches and baselines — https://www.chromatic.com/docs/branching-and-baselines/
- Lighthouse variability — https://github.com/GoogleChrome/lighthouse/blob/main/docs/variability.md ·
  web.dev Web Vitals — https://web.dev/articles/vitals
- Flaky Tests at Google — https://testing.googleblog.com/2016/05/flaky-tests-at-google-and-how-we.html
- WAI-ARIA APG Dialog (Modal) — https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/
- axe-core — https://github.com/dequelabs/axe-core
- WCAG 2.2 Understanding: Focus Order — https://www.w3.org/WAI/WCAG22/Understanding/focus-order.html ·
  Status Messages — https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html (the rest are cited
  in `standards.md`, phase 6 adds the fetched ones it lacks)

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
3. Phase 6 (§19): the smoke suite, its checks, reviewable healing, cross-browser projects, journeys
   seeded from issues and docs, the per-cycle report and performance baselines close the gaps the
   owner approved; native mobile apps, real-device clouds and tests generated from external design
   tools stay out.

## 19. Phase 6 — the smoke suite and its checks (built)

**Status: built** (version 2.10.0). Plan: [argus-journey-lane-6-smoke.md](../plans/argus-journey-lane-6-smoke.md);
evidence: [argus-journey-lane-6-research.md](../plans/argus-journey-lane-6-research.md) (the source ids
in square brackets below).
This section describes phase 6 as built (the plan's "As built" holds each lane's details and deviations);
§1–§18 describe the lane as built through phase 5. What phase 6 leaves out is in §19.17.

### 19.1 Shape

Two lanes over one catalog. The **exploratory lane** (§4–§10) stays as it is: an LLM explorer on
Chrome, one isolated loopback instance, findings filed at two of two. The **smoke suite** is new: a
generated `@playwright/test` suite, committed in the consumer repo, run by the repo's own CI on every
pull request, with no LLM at run time. They share one data format (the repro DSL, §10, in *path*
mode), one target parser (`argus-live-targets.mjs`), one set of in-page check sources (embedded
verbatim in the suite, run by the lane through `run-code`), and the catalog (`.argus/journeys.json`).

| Owner item | Smoke suite (CI) | Exploratory lane | Lane-local (orchestrator) |
|---|---|---|---|
| Smoke suite, membership, codegen | ✔ | captures paths | `smoke plan`, `admit`, `propose`, `check` |
| Visual baselines | `toHaveScreenshot`; a dispatched baseline run writes new ones | — | `smoke baseline` dispatches CI's baseline run and proposes what it wrote |
| Reviewable healing | — | heal-mode explorer | `smoke heal`, decision table §19.9 |
| Cross-browser | Chromium, Firefox, WebKit (pinned container); Edge on the plain runner | Chrome only | — |
| Journeys from issues and docs | — | map explorer (`pw source`) | `seed` |
| Per-cycle report | — | — | `report` |
| Performance | — | — | `smoke run --perf` (Chrome, median of N) |
| Responsive layout oracle | every step × every viewport project | `layout` expectation, `pw layout` | — |
| Locales, pseudo-locale | `i18n` project | `viewport-locale` oracle | — |
| Keyboard, names, ARIA snapshot | `a11y` project | — | — |
| axe WCAG rules (contrast, names, ARIA), design tokens | `a11y` project | — | — |
| Forms (negative cases) | `a11y` project | — | — |
| Links and CTA routes | every browser project | — | — |
| Loading, empty, toasts | every browser project | empty state measured | — |
| Modals | `a11y` project | — | — |
| CI triage, quarantine | — | — | `smoke ci` |
| API-level RED hint | — | `repro --test` | — |

### 19.2 Files

- **`.argus/smoke.json`** (tracked, like `live.json`; `/sapu:init` adds `!/.argus/smoke.json`):
  `{dir, max, pin, exclude, browsers, journeys: {<id>: {browsers?, viewports?, masks?, screens?, allow?}}, masks,
  workers, ci: {web_server: [{command, url, timeout_s?}], ports: {<name>: <port>}, workflow,
  artifact}, perf: {runs, thresholds: {<metric>: [<relative>, <absolute>]}}, heal_max_steps,
  form_cases_max, link_cap}`. Unknown keys are refused. Defaults: `dir` `e2e/argus-smoke`, `max` 20
  (at most 50), `browsers` `["chromium", "firefox", "webkit", "msedge"]`, `workers` unset (the
  generated config then uses 1 under CI, Playwright's default elsewhere), `perf.runs` 5, `heal_max_steps` 3, `form_cases_max` 6, `link_cap` 50. A `ci.web_server`
  or `ci.ports` URL must name a loopback host. A journey's own `browsers` and `viewports` leave its spec
  out of the other engines' projects and the other further widths' `chromium-<w>` projects (`testIgnore`);
  the first width, every engine's, always runs.
- **`.argus/live.json`** gains four optional keys: `test_id_attribute` (the attribute the app already
  uses; Playwright's `testIdAttribute`; without it a `testId` target is refused in a smoke path),
  `pseudo_locales` (locale codes the owner states the app serves as pseudo-locales, e.g. `en-XA`),
  `tokens` (`{css: <tracked file>}` or `{json: <tracked file>}`: the repo's own design-token source)
  and, per trigger, `seed: true` (the trigger creates data a smoke path may seed with).
- **The suite directory** (`dir`, committed): `journeys/<id>.json` (the path and its admission
  record, data), `<id>.spec.ts` (generated), `auth.setup.ts` (generated), `support.ts` (generated:
  triggers, facts, mail, TOTP, the login template, the check sources), `playwright.config.ts`
  (generated), `package.json` and `package-lock.json` (`@playwright/test` and `@axe-core/playwright`,
  exact), `.gitignore`
  (`.auth/`, `test-results/`, `playwright-report/`), `quarantine.json`, `known/<id>.json` (adopted
  check violations), `changes.jsonl` (the visible log), `__screenshots__/<project>/<platform>/<id>.spec/`
  (no `msedge`), `__aria__/<id>.spec/` (the runner's `{testFileBaseName}`, the spec file's name without `.ts`). `fixtures.ts` exists only when a role signs in by `login.command`: the owner's
  `signedIn` for it, created once as a stub that throws, never overwritten.
- **Local state** (gitignored): `.argus/smoke-state.json` (per journey: last check, flaky streaks,
  quarantine clean streak, a closed heal's `regression` mark, `retire`, proposal digests and their
  outcome), `.argus/perf.json`
  (baselines), `.argus/reports/<runId>.md` (0600).
- A smoke suite needs the contract's home `repo` and `policy.traces` `"visible"`; otherwise every
  `smoke` verb but `check` is refused (`refused: smoke: a committed suite would leave a trace`).

### 19.3 Membership

`smoke plan` ranks the catalog's journeys, skipping `global: true` ones (they change settings every
other journey reads, so CI order would decide outcomes) and dropped ones: pinned first, then
`money: true`, then exposure as SELECT computes it (§6), then filed findings (`filed` length), then
distinct roles, then id. Members already in the suite rank before non-members of the same tier (no
flapping). The first `max` minus `exclude` are the target set. Output, one line each: `keep <id>`,
`capture <id>` (no path yet), `drop <id> (<reason>)` (excluded, out of the map, global, past the
cap, retired), `heal <id>`, `regression-candidate <id> step <n> <kind>` (an `expect-failed` or
`action-failed` last pass: `smoke run --slot` writes the candidate), `quarantined <id>`, `pending <id> <pr url>`, `pending-regression <id> <pr url>`
(§19.9), and `upgrade <from> → <to>
(baseline run needed)` when the suite's pin is behind the generator's (a new Playwright renders
differently, so every screenshot is re-baselined in the upgrade's pull request) [pw-snap]. Pinning a global or dropped
journey is refused. Membership changes only through a proposal (§19.8).

### 19.4 Paths and admission

A **path** is a repro list (§10) parsed with `path: true`: no `final`; the last step is an `expect`
proving the journey's goal; every state-changing step proven as §10 requires; leading `system`
`trigger` steps only for triggers marked `seed: true` (seed data, never through the UI). **Selector
order**, enforced at admission and again by codegen: an action's target is `{role, name}`, else
`{label}` or `{placeholder}`, else `{testId}` only with `test_id_attribute` set; `{text}` only in
expectations; `within` at most one level; `css`, `title`, `altText`, refs and XPath are refused
(§10 already refuses the first four) [pw-locators].

The explorer submits a path in its return (`path`, optional) when its charter says `path: wanted`
(the journey is `capture` in `smoke plan`) and it reached the goal. `smoke admit <slot>.<generation>`
runs it as the suite will: after `up --fresh` at live.json's first viewport (`fresh`), on the same
instance at every further width the suite runs it at (`width <w>`; `journeys.<id>.viewports` leaves a
width out), then after one pass over the suite's other paths in the order the seed shuffles them (seed
printed and recorded; another path's break is `smoke run`'s to judge) at the first width again (`dirty`).
Held every time → staged with its admission record `{run, head, pathSha, seed}`; else `refused: admit
<id>: <run> <kind> at step <n>`. The dirty run is what proves a path independent of a clean store and
of the other tests.

### 19.5 Codegen rules (pinned)

The generated text is a function of the path file, `.argus/smoke.json`, `live.json`'s fields it reads
and the generator's version, recorded as a digest in each file's header; `smoke check` regenerates
in memory and names any file that differs. Every rule below has a test that scans generated output:

- **No hard waits:** no `waitForTimeout`, `setTimeout`, `sleep` or fixed delay; Playwright's
  auto-waiting and web-first assertions with `{ timeout: SETTLE }` only (`expect.poll` for facts and
  mail).
- **Strings:** every repro string is a JSON literal or a placeholder's variable (`argus-live-redtest`'s
  rule); no template literal holds path data; test titles are `<id>`, step numbers and kinds only.
- **Independence:** one test per journey file (plus its form and a11y tests); the marker is made
  inside the test (`argus-` + the test id's hash + time + random), never at module scope; no
  `test.describe.serial`, `beforeAll`, `afterAll` or module-level mutable state; `fullyParallel:
  true`. Every test declares a `lock` per account it opens (`account:<role>.<k>`): a shared
  signed-in state is safe only for tests that change no server state, and journeys change it, so two
  tests of one account never run at once, in any project [pw-auth] [pw-parallel]. Order independence
  is proven by admission's dirty run, by the lane's own pass (paths in a seeded random order) and by
  CI, which runs `--shuffle` and prints the seed [pw-release] [pw-cli].
- **Hybrid setup:** an `auth.setup.ts` setup project signs each account in through the real sign-in
  UI once (the wrapper's own login template, embedded; TOTP from Node's crypto) and saves its
  storageState under `<dir>/.auth/<role>.<k>.json`, mode 0600, gitignored, never uploaded; tests
  open each account's context from it. That setup is the one login test per role, and it records no
  trace, video or screenshot (typed passwords would reach the artifact) [pw-use]. Seeds go through
  `trigger` (argv from `live.json`, no shell, values checked against `args`), never UI clicks.
- **Selectors:** the target kinds of §19.4 only, through `targetCode`.
- **Steps:** each DSL step is one `test.step("step <n> <do|expect>:<kind>")`, so CI results name the
  failing step without parsing an error message.
- **Base URL:** `ARGUS_SMOKE_BASE_URL`, else the first `ci.web_server` URL; the config throws unless
  its host is loopback. No test ever drives a deployed environment.
- **CI settings:** `retries` 1 (0 locally), `workers` 1 (else `smoke.json` `workers` or Playwright's
  default), `forbidOnly`, `globalTimeout`, `trace: "on-first-retry"`, `updateSnapshots: "none"` (only
  the dispatched baseline run passes `--update-snapshots`, §19.8); `ignoreSnapshots` outside CI
  (baselines are the CI container's) [pw-ci] [pw-config]. `failOnFlakyTests` stays off: a retry-pass
  is reported `flaky`, and `smoke ci` handles it (§19.9).
- **Generated code uses only APIs present in both** the lane's pinned alpha and the suite's
  `@playwright/test` (locks: 1.63); `--shuffle` lives in CI's command line only. The lane's own
  browser tests run a generated suite on the alpha through a scratch `@playwright/test` stub that
  re-exports `playwright/test` [probe].

### 19.6 Projects and browsers

`setup`; `chromium`, `firefox`, `webkit` (WebKit is the closest stand-in for Safari, not Safari), and
`msedge` (`channel: "msedge"`) only when Edge's executable exists at Playwright's documented path for
the host, else the config logs `msedge: skipped (not installed)` and leaves the project out — at the
first `viewports` width, each running the path, the screenshots (not `msedge`: a branded channel
moves with the machine, not with the pin, so its baseline would drift), the layout oracle, the links
and CTA routes, loading and toast checks. In CI the screenshot projects run in the
`mcr.microsoft.com/playwright:v<SMOKE_PLAYWRIGHT>-noble` container (one platform for every baseline)
and `msedge` on the plain runner, whose image ships Edge; sapu never installs Edge (`install msedge`
overrides the machine's own) [pw-browsers] [pw-ci] [gh-runner]; `chromium-<width>` for every further `viewports` width (path,
screenshots, layout oracle); `a11y` (Chromium: keyboard pass, names, ARIA snapshots, contrast,
tokens, modals, form cases; WebKit does not Tab to links by default and is not used for the keyboard
pass; axe's WCAG rules); `i18n` (Chromium, only with `locales` or `pseudo_locales`). Every project
depends on `setup`.

### 19.7 Checks

Each check is an in-page source in a leaf module (`argus-live-layout.mjs`, `argus-live-a11y.mjs`),
embedded verbatim into `support.ts` and run by the lane through `run-code`; each reports violations
as `{check, step, key, detail}`, `key` stable across runs (role, accessible name with digit runs
written `#`, tag), each a test annotation in the JSON report: `argus-violation`, `argus-manual` (a human's
call) or `argus-info` (a report line). `detail` is page text: fenced wherever it is printed. Checks are soft assertions (`expect.soft`), so one run reports every violation.
**Known violations:** a violation in `known/<id>.json` (adopted from CI and reviewed, §19.8) is not a
failure; a new one is. **Allowed:** `smoke.json`'s `journeys.<id>.allow` lists `{check, key}` the
owner rules out (WCAG's equivalent or essential exceptions, which a script cannot decide).

Excluded everywhere: invisible elements (`display: none`, `visibility: hidden`, `opacity: 0`, zero
size), `aria-hidden` and `inert` subtrees, the visually-hidden pattern (clip to 1 px), and, while a
modal dialog is open, everything outside it.

- **Layout** (after every step, every viewport project; 1.4.10 Reflow cited at widths ≤ 320)
  [u-1.4.10] [u-2.5.8]:
  *page-scroll* — `scrollingElement.scrollWidth > innerWidth + 1`, unless every element past the
  right edge sits in a `table`, `pre`, `code`, `canvas`, `svg`, `video`, `iframe` or a `grid` or
  `application` role (1.4.10's two-dimensional exception); *clipped* — an element with a direct
  non-blank text node, `overflow` hidden or clip or `text-overflow: ellipsis`, `scrollWidth >
  clientWidth + 1` or `scrollHeight > clientHeight + 1`; excluded: form fields (they scroll by
  design), elements inside a scroll container, and text whose full value is the element's `title` or
  accessible name; *covered* — an interactive control fully inside the viewport whose center's
  `elementFromPoint` is not the control, its descendant or inside one of its `labels`; excluded:
  disabled controls and coverers that are `fixed` or `sticky` (a scroll-position artifact; the
  keyboard pass checks 2.4.11 instead); *target-size* (2.5.8) — a control under 24 × 24 CSS px whose
  24 px circle intersects another target or its circle; excluded: a link inline in a text block and a
  native checkbox, radio or range the author did not size (2.5.8's inline and user-agent
  exceptions).
- **Locale** (`i18n`): after each step, a sibling context with the step's account storageState and
  each `locales` and `pseudo_locales` code opens the step's URL and runs *page-scroll* and *clipped*; a URL
  is looked at once per account unless the step may change server state (`click`, `dblclick`, `press`,
  `reload`, `login`, `go-back`); the codes are read from `.argus/live.json` when the suite runs;
  for real locales also the format check — numbers with both group and decimal separators in the
  wrong roles for the locale (`Intl.NumberFormat` parts), dates whose separator differs from the
  locale's or whose day above 12 proves the field order wrong (`Intl.DateTimeFormat` parts); ISO 8601
  dates, inputs, `code`, `pre`, URLs and `translate="no"` are excluded; a page whose `<html lang>` does
  not start with the locale's language is reported `not localized` and its format check skipped (the
  app ignored the browser's locale: no false fails). State that only URL-addressable states are
  checked. Pseudo-localization is done only for codes in `pseudo_locales` (Android's `en-XA`, `ar-XB`
  shapes; expansion of 30–40 % is what reveals clipping) [android-pseudo] [ms-pseudo]; under one,
  visible text identical to the default locale's render (path values, digits and `translate="no"`
  excluded) is reported `pseudo-localization: <n> text unchanged under <code> (hard-coded?)`, never a
  fail [mozilla-pseudo]. Without one the report says `pseudo-localization: not done (no pseudo-locale
  listed)`. No hook is ever invented.
- **Keyboard** (`a11y`, before each `click`, `check`, `uncheck`, `select` or `fill` of the path):
  Tab from the page's start (a node focused and removed at the document's start, then Shift+Tab, which leaves
  the page, so the next Tab is the first stop of the true order, a positive `tabindex` group included) until
  focus reaches the target (pass), cycles back to the first stop
  (fail: not in the tab order, 2.1.1) or 500 presses pass (undetermined, never a fail). A target
  inside a composite widget (`radiogroup`, `tablist`, `menu`, `menubar`, `listbox`, `grid`, `tree`,
  `toolbar`) passes when focus enters its widget: a composite has one tab stop and arrows move inside
  it [apg-keyboard] [u-2.1.1]. While walking, each stop is compared with the previous one in DOM order
  (`compareDocumentPosition`); a backward jump is reported `manual` with its key, never a fail:
  2.4.3 asks for an order that preserves meaning, and F44 fails a positive `tabindex` only where it
  breaks meaning, which a script cannot judge [u-2.4.3]. At the target: focus visible (2.4.7 [u-2.4.7]: a
  screenshot of the target focused differs from one blurred, animations off, caret hidden); its
  indicator's contrast (1.4.11: a solid `outline` colour against the effective background at 3:1;
  any other indicator `manual`) [u-1.4.11]; not entirely hidden by author content (2.4.11: its
  center's `elementFromPoint` is it or inside it) [u-2.4.11]. `hover` and `dblclick` targets are excluded (the
  function may have a keyboard path elsewhere). Then focus is blurred and the step runs.
- **Names** (`a11y`): every action target `toHaveAccessibleName(/\S/)` (4.1.2).
- **ARIA snapshot** (`a11y`, at the path's screens: smoke.json's `journeys.<id>.screens`, else the
  path's last step that acts on a page; the screenshots take the same list): `toMatchAriaSnapshot({name:
  "<n>.aria.yml"})` of `main` (else `body`), stored as `__aria__/<id>.spec/<n>.aria.yml`, with no
  `children` option: matching is already partial [pw-aria], and `children: "contain"`, probed, makes a
  missing or empty baseline match. A missing file compares as the empty string and fails
  (`baseline-missing`); a mismatch reports a line diff only, no file [probe]. Baselines therefore come
  only from the baseline run (§19.8); on adoption, names holding a digit become regexes with each
  digit run as `\d+`, the marker shape `argus-[0-9a-z]+`.
- **axe** (`a11y`, at the path's screens): `@axe-core/playwright` with `withTags(["wcag2a",
  "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])`, `include("main")` when the page has one, and
  `target-size` disabled (the layout oracle owns 2.5.8 in every viewport). It covers contrast
  (1.4.3) [u-1.4.3], names and roles (4.1.2) [u-4.1.2], labels and ARIA validity with axe's tested
  exceptions. Each
  violation node is `{check: "axe:<rule>", key: <its target>}`, filtered by `known/<id>.json` like
  every check; `incomplete` nodes are `manual`, never a fail (axe returns as incomplete what it
  cannot decide, and holds itself to zero false positives) [pw-a11y] [axe-readme] [axe-api].
- **Tokens** (`a11y`, only with `live.tokens`, read from the repo's `.argus/live.json` when the suite runs,
  the file inside the repo): the token values (CSS custom properties of the named file, or the JSON's string
  leaves and `$value`s), normalized in the page by setting each on a probe
  element; each journey control's computed `color`, non-transparent `background-color`, first
  `font-family` and `font-size` must be one of them. No `tokens` → skipped, reported `design tokens:
  not checked (no token source)`. Tokens are never inferred.
- **Forms** (`a11y`, each form the path fills, at most `form_cases_max` cases a journey): from the
  fields' own `required`, `type=email`, `maxlength`, `minlength` and `pattern` — an empty required
  field, `not-an-email`, `maxlength + 1` characters, `minlength − 1`, and the first of a fixed list of
  values the pattern refuses. The path's own values fill the rest, one field is bad, the path's
  submit runs. Holds when no non-GET request of the form's own (to its `action` when it names one,
  else a body carrying one of its field names, issued after the click: an analytics beacon or an
  autosave elsewhere does not count) got a 2xx; the field is invalid (`validity.valid`
  false for native validation, `aria-invalid="true"` under `novalidate`); an error is associated
  (`validationMessage` for native, else `aria-describedby` or `aria-errormessage` naming a visible
  element with text; 3.3.1 [u-3.3.1]); focus is on the field or on an element linking to it. The first case
  the server accepts ends the test (hard fail); a form rendered anew or a page gone with no such request
  ends the cases with a `manual` finding. No business rule is invented.
- **Links and CTA routes** (every browser project): the `href`s of `a` elements on each step's page
  with the base URL's origin (never another origin; `mailto:`, `javascript:` and fragment-only links
  skipped), at most `link_cap` a journey, requested one at a time with GET from the test's context
  after the final step (a sign-out link then costs nothing), `maxRedirects: 0` and redirects followed
  by hand only within the origin (at most 5): a 404, 410 or 5xx final status fails; a 401 or 403 is
  `manual` (a link offered to a role that cannot open it); a 429 is `manual` (no retry wait: the
  suite has no fixed delays) [lychee] [linkinator]. Each map step of
  the journey with a `route`, for a role the path acts as, must have been visited (pathname matched,
  parameters as wildcards).
- **Loading** (every step): no `[aria-busy="true"]` and no indeterminate `progressbar` visible
  within `SETTLE`, and none at the final step. ARIA-marked loaders only; class names are never read.
- **Empty state** (every step; also measured by the explorer): a visible `table` or `grid` with a
  header and no body rows, or a `list`, `listbox` or `feed` with no items, must have visible text
  near it (its section or landmark) beyond its own headers: headings, the table's header and caption,
  scripts and styles do not count, so a section title alone does not excuse an empty table.
- **Toasts** (every step): an element that appears after an action with `position: fixed` and text,
  and goes by itself within `SETTLE`, must be inside a live region (`role=status`, `alert`,
  `aria-live`; 4.1.3); a live region's toast must not cover the path's next target (the covered
  check) and must be dismissible or go by itself. The recorder is armed after step 1, so a toast of
  step 1 is not seen; text added to a fixed region that was already there is a status update, not a toast.
- **Modals** (`a11y`, when an action opens a modal dialog: `role=dialog` or `alertdialog` with
  `aria-modal="true"`, or a `dialog` opened modal): Escape closes it, an `alertdialog` included
  [apg-alertdialog]; Tab stays inside it (2.1.2's trap is allowed only where Escape leaves) [u-2.1.2]; the
  path's control reopens it; focus returns to the control that opened it — exempt when that control
  is gone (then only Tab is checked: Escape and the backdrop would close a dialog the path cannot reopen,
  so `modal-escape` is reported `manual`, not tested), a fail when focus is lost to `body`, `manual` when it lands elsewhere (the workflow
  exception) [apg-dialog]; and the backdrop click (a point outside its box) behaves the same in every
  modal dialog of the journey. A non-modal dialog is exempt from the Escape and Tab rules
  [mdn-dialog].

axe covers what a rule engine decides from one rendered state; the custom checks above cover what
it cannot see — keyboard reach, focus, dialogs, forms, layout, locale, links, loading, empty states
and toasts. Known violations of both share one adoption path (§19.8), so whole-page debt never turns
CI red on day one.

### 19.8 Baselines and proposals

Every change to the committed suite — a new path, a healed target, a dropped or quarantined journey,
adopted baselines, a regenerated file — reaches the repo only as a **proposal**: `smoke propose`
builds it in a worktree from `origin/<base>` on a branch `argus/smoke-<runId>` (baselines:
`argus/baselines-<run id>`), runs every file and the PR body through scrub's matcher (a hit refuses,
naming `file:line:col class`), writes `package-lock.json` with `npm install --package-lock-only
--ignore-scripts`, appends one `changes.jsonl` line per change (`{kind, id, step?, from?, to?,
evidence, run}`), commits with the contract's `gitEmail` and a `Signed-off-by`, pushes, and opens a
pull request with `labels.agentFiled` and the change log as its body. sapu never merges it: sapu works
issues, and its branches are not `argus/`. Merged = accepted; closed unmerged = rejected, remembered in
`smoke-state.json` by the change's digest, and never proposed again.

**Visual and ARIA baselines and known violations are made by CI's baseline run, on the pinned
container, and accepted by the owner's merge.** A normal CI run never writes a baseline
(`updateSnapshots: "none"`): a missing one fails and attaches nothing, and an ARIA mismatch carries
only a line diff [probe]. So the workflow has a `baseline` job, run only by `workflow_dispatch`
(write access, the workflow on the default branch) [gh-dispatch], which runs `--update-snapshots=
missing|changed --grep <ids>` — `missing` writes new baselines and still verifies the existing ones
in the same run [pw-release] — and uploads the files it wrote as `argus-smoke-baselines`.

`smoke baseline --from-run <run id>` does one of two things. On a normal run it dispatches the
baseline job on that run's branch: `missing` for its `baseline-missing` ids, `changed` only for the
ids the owner names with `--ids` after reading `smoke ci`'s diff (no mismatch is ever re-baselined
unasked); it prints the dispatched run. On a baseline run it downloads the artifact with `gh run
download` into a 0700 temporary directory and adopts only files whose names the suite defines
(`__screenshots__/<project>/<platform>/<id>.spec/*.png` with a PNG signature under 5 MB, never `msedge`;
`__aria__/<id>.spec/*.aria.yml` under 1 MB, pruned as §19.7 says), and reads the run's results
(`results.json` at each `argus-smoke-results-<project>` artifact's root): the `argus-violation` annotations of
the adopted journeys become `known/<id>.json`, a JSON list of `{check, key}` merged with the branch's own,
sorted (the collected annotations are the artifact; there is no violations file); nothing else is read, no artifact text is printed outside a fence, and a run on another repository
(a fork) or a run whose head is no longer its branch's head (`stale`) is refused. Without the right
to dispatch, the `gh workflow run` line is printed for the owner.

The adopted files land as a commit on the run's `argus/` branch (a journey-adding proposal gets its
first baselines in its own pull request) or as an `argus/baselines-<runId>` pull request into the
run's branch, its body listing each file with journey, step and project. The owner reviews them in
the pull request's image view (2-up, swipe, onion skin) [gh-images] and accepts by merging; a test
fails until its baseline is accepted, as hosted review services do [chromatic-branch]
[percy-baseline]. Baselines are kept per branch by being committed. A baseline file that conflicts
on a rebase is never resolved by picking a side: it is dropped and regenerated by a baseline run on
the merged branch (a stale baseline yields false positives) [chromatic-branch].

### 19.9 Breaks: UI change or bug

The decisive rule: **healing may change how an action finds its control, never what the journey
proves.** Expectations, values, actions, step order and step count are never changed by a heal; a
heal changes at most `heal_max_steps` action targets; the decision is the unchanged expectations
re-run, never the explorer's word. A heal never skips a test, adds a wait or changes data, and is
never applied at run time: CI fails, and the heal arrives later as a proposal (runtime healers pick
the best-scoring locator and carry on; Playwright's healer may patch waits and data or skip a test it
"believes" broken) [healenium] [pw-agents].

| Evidence | Verdict | What follows |
|---|---|---|
| CI: failed, then passed on retry, same commit, on a base-branch push | flake | quarantine (below) |
| The same on a pull request's head, never flaky on the base | `flaky-new` | a comment on that pull request; never quarantined (it may be a race the change brought) [google-flaky] |
| CI: an action step failed on every attempt; the lane's pass holds on Chrome | `ci-only` (`browser-only <project>` when Chromium passed in CI) | needs-owner issue with the run's link |
| An action step's target matches nothing or several, twice on fresh and dirty instances | locator break | heal-mode explorer |
| An action step's target matches one control, but the action times out or errors, twice (`action-failed`: a disabled or covered control) | **bug** | regression candidate: the path to step n − 1, then `enabled` on the step's target as its `final` (`smoke run --slot`); `smoke heal` refuses it |
| The explorer gives new targets of the same role; the healed path holds twice with every expectation unchanged | **UI changed** | heal proposal (§19.8); a target found by another way than its role, or by another name, is flagged `role changed` or `name changed` in its body and the pull request gets the needs-owner label |
| The explorer gives a target of another role (a button that became a link) | refused | a heal never changes the control's role |
| The explorer finds no control for the step's goal (a heal cannot add a step) | **bug** | regression candidate: the path to step n − 1, then `visible` on the old target as its `final` |
| The healed path fails an expectation | **behaviour changed** | regression candidate at that expectation |
| An expectation fails twice | **behaviour changed** | regression candidate |
| A screenshot or ARIA snapshot differs | owner's call | `smoke ci` shows the diff; `smoke baseline --ids` only if the owner says so |
| A baseline is missing | not yet reviewed | `smoke baseline` dispatches the baseline run (§19.8) |
| A check reports a violation not known | defect | one issue per `{id, check, key}`, `ux`, S3 |
| The owner closes a heal proposal | regression | `pending-regression`, quarantined, a needs-owner issue (below) |
| The setup project cannot sign an account in | harness | the report; nothing filed |

A **regression candidate** is a repro whose `final` names the new oracle `regression` (its kinds:
every expectation kind); `smoke run --slot <n>` writes it as slot `n`'s return, so `repro`, `--minimize`,
`--test`, `classify` and `scrub` take it by its ref unchanged. `classify --oracle regression` → class
A, `bug`, the needs-owner label (an intended product change must not be "fixed" back), S2 on a money
journey, else S3. The proposal and the issue carry advisory evidence: `git log -S'<old name>'
<admission head>..HEAD` (the commit that removed the old accessible name, or `no commit removed it`)
and the commits touching the journey's anchor files.

**A closed heal.** A heal proposal the owner closes leaves the break with the owner. The next `smoke
plan` or `smoke ci` asks gh how each open proposal ended (as `smoke propose` does), marks the journey
`regression` in `smoke-state.json`, prints `pending-regression <id> <url>`, and stages a quarantine of
it (`quarantine <id>: staged until the owner decides`) unless `quarantine.json` holds it already; the
orchestrator files one needs-owner regression issue (`smoke-regression:<id>` in its title, `bug`,
`regression`, S2 on a money journey, else S3). It stays pending until the lane's pass holds the
journey again (a fix: the mark and that staged quarantine go) or the owner rules the change intended,
by closing that issue as not planned or saying so, and runs `smoke retire <id>` (the orchestrator only
on their word; the guard refuses it to every subagent). A staged `retire` then replaces the journey's
other staged changes and marks it `retire`: `smoke plan` lists it `drop <id> (retired)`, the next
proposal removes its path, spec, known violations and baselines, and once that merges `smoke plan`
lists it `capture`. A retire proposal the owner closes clears the mark. No script reads the issue's
state: only its title ties an issue to a journey, so the owner's ruling is a command.

**Quarantine.** `smoke ci` stages a test that was `flaky` on a base-branch push run (with no `--run`, it
reads the newest completed push run of the base branch); the proposal adds `{id, issue, since,
projects}` to `quarantine.json` (`projects` those it flaked on), and codegen tags the test `@quarantine`.
The change's digest is the journey's alone, so a quarantine the owner rejected stays rejected whatever
run flakes next. The gating job runs `--grep-invert @quarantine`; a non-gating `quarantine` job
(`continue-on-error`, the same matrix over the container projects) keeps running the quarantined tests, so
they leave the critical path without leaving sight — quarantine "could easily mask a real race condition"
[google-flaky]. One tracking issue per journey (`smoke-flaky:<id>`, deduplicated through
`smoke-state.json`). A base-branch flake tells a pull request's flake from a new one for 30 days. The
lane's own pass keeps running a quarantined path. A cycle is counted only on a push run of the base
branch, once per lane cycle and once per CI run (`ciRuns`), and only with evidence: no lane pass of the
path or no quarantine-job result of its `projects` (every project when it names none, or only `msedge`)
is "not counted", never dirty, and keeps the streak. Three consecutive counted cycles in which it holds
twice and every quarantine-job result read passed first time make the next proposal remove the entry and
comment on the issue; a journey quarantined twice, or for five counted cycles, is proposed for `drop` (a
large UI test is the flakiest kind; twenty reliable tests beat two hundred flaky ones) [google-flaky-size].

### 19.10 CI wiring

`/sapu:init`, only with the owner's consent and in its own pull request, writes
`.github/workflows/<smoke.ci.workflow>` from `argus-live.mjs smoke workflow`: `on: pull_request`, a
push to the base branch and `workflow_dispatch` (inputs `baseline`, `grep`; they reach the shell only
through `env:` and are checked against `^(missing|changed)$` and `^[a-z0-9][a-z0-9-]*(\|[a-z0-9][a-z0-9-]*)*$`,
the ids then anchored to a whole title word, `--grep "(^| )(<ids>)( |$)"`; codegen refuses a journey named as a
project); `permissions:
contents: read`, never `pull_request_target`; every action pinned to a full commit SHA, resolved by
`gh api` when the file is printed, its tag in a comment [gh-secure], and the container image pinned to the
digest the registry answers for its tag (else the tag, with a comment saying why); refused without
`ci.web_server` or a suite path; every step after the checkout guarded by `hashFiles('<dir>/package.json')
!= ''` (a job-level `if` cannot read the checkout), so the workflow is green until the first suite merges; a job skipped when a pull
request comes from a fork (no secrets there); `actions/checkout` with `persist-credentials: false`;
the app started by the config's `webServer` from `smoke.json` `ci.web_server`
(`reuseExistingServer: false`, loopback URLs). The screenshot projects run in the
`mcr.microsoft.com/playwright:v<SMOKE_PLAYWRIGHT>-noble` container with `--ipc=host --init`
[pw-ci] [pw-docker], `msedge` on the plain runner; in the suite directory `npm ci --ignore-scripts` and `npx playwright
test --shuffle --grep-invert @quarantine --project setup --project <p>` in a matrix over the
projects (codegen's `suiteProjects`, the generated config's own list, every one but `msedge`; each job its
own app instance), plus the non-gating `quarantine` job (the same matrix) and the dispatch-only
`baseline` job (§19.8, the same matrix). Each job uploads `test-results/` as
`argus-smoke-results-<project>` (`results.json` at its root; `-msedge`, `-quarantine-<project>`), the baseline job also
its written files as `argus-smoke-baselines-<project>` (rooted at the suite directory: `__screenshots__/`,
`__aria__/`), all with `retention-days: 7` [gh-artifacts], never `.auth/`. The secrets the job passes are the names
`.argus/live.env` holds, from the repo's CI secrets, set only in the env of the step that runs the suite
(never `npm ci`'s or an action's); the generated support reads them by name.
Without a `workflow` scope on the owner's gh token, init hands the file to the owner instead.
The suite's hooks run from the repo's root with the step's environment: `${NAME}` in their argv is read
from it at run time, `{port:<name>}` takes `ci.ports`' port (`{port:<name>=<n>}` it, else `n`), live.json's
`env` block is not reproduced, and a failed hook is reported by name and exit code only (no stderr: the
results are an artifact). `ci.web_server` is the owner's statement of how CI starts the app; `/sapu:init` proposes it from
`live.json`'s `start` entries with `{port:<name>}` replaced by `ci.ports`. The lane's isolation
(worktree outside the repo, ports from `port_range`, HOME, proxy, reaper, `store_check`, `reset`) is
not reproduced in CI: a disposable runner is the isolation there, and the loopback-only base URL keeps
the suite off any deployed system. CI's datastore holds `live.json`'s users (the owner's seed).

### 19.11 Performance

Measured by the lane, on Chrome, in `smoke run --perf`, on suite paths (a fixed script; an explorer's
walk is not repeatable): per run `lcp_ms` (the largest LCP of the run's documents; LCP stops at the
first input, so a perf run waits for the document's `load` event before its first action on it)
[webdev-lcp], `cls` (the largest session-window sum, shifts flagged `hadRecentInput` skipped)
[webdev-cls], `inp_ms` (the worst interaction: `event` entries observed with `durationThreshold: 16`,
grouped by `interactionId`) [webdev-inp], `duration_ms` (the steps' time to effect, seed triggers
excluded), `requests` and `bytes` (resource and navigation entries, `transferSize`) [webdev-budgets],
from a script of `PerformanceObserver`s (`buffered`, so entries from before it ran are read) that the
session hook installs beside the signal script (§7) only in a perf pass, at each `domcontentloaded` and again
before each measured step, and read after every step. A batch is one warm-up run, then `perf.runs` runs on one instance; its value is each
metric's median (five runs' median is about twice as stable as one) [lh-variability]
[lhci-config]. A batch is refused while another slot of the run is live (`refused: smoke run
--perf: <n> other slot(s) live`): concurrent load on one machine skews every timing
[lh-variability]. Baseline per journey in `.argus/perf.json` `{pathSha, head, machine, n, medians, latest}`
(`latest`: the newest pass's `{pathSha, head, machine, n, batches, regressed}`, what `--issue` reads and
`--rebaseline` moves the baseline to): the first batch; void when the path's digest or the machine (CPU model and count, memory, platform,
Chrome version) differs; moved only by `smoke perf --rebaseline <id>` (the owner's command, or the
owner closing a perf issue as not planned). Default thresholds `[relative, absolute]`: `lcp_ms` [0.2,
250], `inp_ms` [0.25, 50], `cls` [0.25, 0.05], `duration_ms` [0.2, 500], `requests` [0.2, 5], `bytes`
[0.2, 102400]. A metric regresses when its median exceeds the baseline by more than both; a
regression counts only when a second batch after `up --fresh` regresses too. Each path's verdict is one
of five: `baselined` (a first batch, or a void baseline), `ok`, `regressed` (both batches), `flaky` (the
second batch was within the thresholds), `not-measured` (the path broke or the harness failed), one
`<run>/smoke/perf.jsonl` row a path `{id, verdict, baseline, batches, regressed[, why]}`. `smoke run
--perf` exits 3 for a confirmed regression or a path that broke, else 2 for the harness, else 0. Filed through `scrub
--create` with `performance`, `argus`, `found-by:user` and the needs-owner label, deduplicated by
`perf:<id>:<metric>`, its body from `smoke perf --issue <id>`: baseline, both batches, thresholds,
and `git log --format='%h %s' <baseline head>..HEAD -- <anchor files>`. web.dev's "good" values
(LCP 2.5 s, INP 200 ms, CLS 0.1) are field targets at the 75th percentile; the report prints them
beside the medians as `lab context`, never as a verdict [webdev-vitals] [webdev-labfield]. The generated suite measures
nothing: shared CI runners are too noisy for a gate, and perf APIs are complete only in Chromium.

### 19.12 Journeys from issues and docs

`argus-live.mjs seed --issue <n> | --doc <file>:<a>-<b>` in a run with a worktree (`up --map` or a full
`up`): an issue only when `sapu-contract.mjs issue-trust <n>` passes; a doc only a regular file tracked at
the run worktree's HEAD, read from git's object. It writes `<run>/seed.json` (0600: kind, ref, URL or file and range, the
text, its digest) and prints `seed: <kind> <ref> <sha12> <k> characters`; one seed a run: a later `seed`
replaces it, and a slot minted before then refuses `source`. `slot <n> --map --seed` mints a map token that also takes
`pw <token> source`, which prints the text in a fresh `<<<SOURCE-<nonce>` fence, capped, marker
shapes escaped, as data; the charter says to extend the map with the journeys the text describes.
The returned map passes `validateMap` and `map-check` like any other: a journey whose steps the code
does not anchor is dropped, so a ticket can only name journeys the code has. `map-check --merge <n>`
adds `seeds: [{kind, ref}]` to each journey the seed slot returned (written by the merge, never by
the explorer), and the catalog marks them `seeded`. The explorer still has no network and no channel
out (§3), so an injected instruction can at most waste its budget or yield a candidate the repro gate
refuses. The fence is hygiene, not the boundary: text labels and prompt wording are no enforcement
boundary [owasp-pi-cheat]; the boundary is least privilege (the explorer's confinement), the
deterministic gates (`validateMap`, anchors, repro two of two) and the owner's merge of every
proposal [owasp-llm01].

### 19.13 The per-cycle report

`argus-live.mjs report [--run <runId>]` (no lock) writes `.argus/reports/<runId>.md` (0600) from the
run's records only: journeys walked (status, steps, coverage per oracle), candidates (ref, oracle,
verdict, minimized steps, filed URL), issues filed (`<run>/filed.jsonl`, which `scrub --create` and
`--comment` append), smoke (`<run>/smoke/pass.jsonl`: held, broke, flaky; `<run>/smoke/events.jsonl`,
which the smoke verbs append: healed, admitted, quarantined, unquarantined, dropped), perf
(`<run>/smoke/perf.jsonl`: baseline → batches, verdict; `.argus/perf.json`'s baseline now), visual and
checks (the newest `.argus/smoke-ci/<run>/triage.json`, only its triage lines), proposals (`events.jsonl`),
harness events.
Free text is at most 200 characters an item, defanged, and the whole file passes scrub's matcher,
each hit replaced by `*** (<class>)`. It prints `report: <path>`.

### 19.14 The API-level hint

`repro <ref> --test` adds `api-level: suggested (the final reads live.facts|live.mail)` when the final's
kind is `fact-equals` or `mail`: the defect is observable without the UI, and the issue body suggests
an API-level RED test beside the UI one. Generating that test is a follow-up (the engine knows no
app's API).

### 19.15 Commands and the guard

New verbs, all the orchestrator's: `smoke plan`, `smoke admit <ref>`, `smoke run [--ids …] [--slot <n>]
[--perf] [--seed <n>]`, `smoke heal <slot>.<generation>`, `smoke propose`, `smoke ci [--run <id>]`,
`smoke baseline --from-run <id> [--ids …]`, `smoke perf (--issue|--rebaseline) <id>`, `smoke retire <id>`
(the owner's ruling, §19.9), `smoke workflow`, `seed`, `report`. `smoke check` writes nothing and joins the guard's subagent reads (`status`, `status
--json`, `check`). The explorer gains `pw <token> <role>.<k> layout [<check>]` (the layout oracle,
its answer fenced) and, on a seed map token, `pw <token> source`; it still runs nothing but `pw`.
The repro DSL gains the `layout` expectation (`{check}`, optional `target`), a `viewport-locale`
final kind.

### 19.16 Security, unchanged and new

Unchanged: the exploratory lane's loopback instance, proxy, explorer confinement, ledger and scrub.
New boundaries: generated code is built from data by the generator alone (JSON literals, sapu's own
check and login sources); CI artifacts and issue text are untrusted inputs, read by name and shape
and fenced (fences are hygiene; the gates and the owner's merge are the boundary, §19.12); nothing
secret-shaped is committed (scrub's matcher over every proposed file; CI secrets by name only;
storageState gitignored, 0600, never uploaded; the setup project records no trace, video or
screenshot; test traces stay in the short-lived CI artifact, never attached to an issue, never read
by `smoke ci` or `smoke baseline`); the CI workflow runs with `contents: read`, SHA-pinned actions and
dispatch inputs through `env:` only; the suite drives loopback only. A heal is never applied at run
time (§19.9).

### 19.17 Out of scope, and covered elsewhere

Out: native mobile apps and real-device clouds; tests generated from Figma or other external design
services (the lane is loopback-only and reads no outside service). Covered: intelligent
prioritization is SELECT's score (§6) and the smoke rank (§19.3); parallel execution is Playwright's
workers and CI's project matrix.
