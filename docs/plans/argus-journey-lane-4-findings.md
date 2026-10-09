# Argus journey lane — Phase 4: Findings — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a candidate becomes a finding only through scripts. `argus-live.mjs repro` replays a
candidate's repro steps — data, never code — on a freshly reset instance, twice, and answers
reproduced, not reproduced or harness failure by exit code; `--minimize` shrinks a reproduced list one
step or role at a time; `--test` writes the Playwright test a sapu worker uses as its RED test.
`scrub` refuses an issue that carries any secret the run saw, in any encoding, redacts unknown long
tokens, defangs mentions, references and outside links, decides which screenshots may be attached,
and files through `gh`. `map-check` keeps only journeys whose every step is anchored in HEAD's code,
names its refresh triggers and prints the catalog; `select` ranks journeys and allocates accounts.
The map itself is built through the wrapper, on a run that starts no app.

**Architecture:** the phase opens with the seams phase 3 left for it: a leaf `argus-live-origin.mjs`,
the session driver `argus-live-session.mjs` (extracted from `pw`, shared by the repro runner), an
in-daemon hook installed at every session open (signals in every document, request headers, errors,
the ids the run saw), the secret ledger, repro sessions in slot `r`, and the split of
`argus-live-instance.mjs`. New zero-dependency ESM modules then add the repro DSL
(`-steps.mjs`), the runner and minimizer (`-repro.mjs`), the generated test (`-redtest.mjs`), the
class and severity table (`-classes.mjs`), scrub (`-scrub.mjs`), the journey map and SELECT
(`-map.mjs`) and doc drift (`-drift.mjs`). Every browser step of a repro runs as wrapper-built
`run-code` from a constant template, its targets through `targetCode` and its values as JSON literals,
in sessions the runner opens through the same driver, proxy and per-slot config as an explorer's.

**Tech Stack:** Node ≥ 22.18 ESM (`node:child_process`, `node:crypto`, `node:fs`, `node:module`
`stripTypeScriptTypes` in tests), `@playwright/cli` 0.1.22 (pinned in phase 3), a local
Chrome-family browser, git, `gh` (filing only, ≥ 2.99 for attachments), vitest.

Spec: [docs/specs/argus-journey-lane.md](../specs/argus-journey-lane.md) §5 (doc drift), §6 (all of
it), §7 (signals, return), §9 (sessions, the wrapper's own code), §10 (all of it), §12 (the repro,
scrub and map rows), §14 ("Repro", "Scrub", "`map-check`", "Doc drift"). Roadmap row 4:
[argus-journey-lane-roadmap.md](argus-journey-lane-roadmap.md). Phase 3's carry-overs:
[argus-journey-lane-3-browser.md, "Carried to Phase 4"](argus-journey-lane-3-browser.md#carried-to-phase-4-opening-tasks) — Tasks 1–5 below.

**Precondition.** Phase 3 is on `feat/argus-journey-lane` (this plan was written at 5fef368) with the
suite green. Phase 3 code imports each symbol from its owning module; this phase does the same, and a
helper it needs that is still private is exported from its owner in the commit that first imports it —
never copied. Every path under `.argus/` is resolved from `<MAIN>` (`findMain`), never from the cwd.
Test seams are function parameters only, never environment variables.

---

## Verified against @playwright/cli 0.1.22, Chrome and gh 2.102.0

Probed live on 2026-10-09 (macOS, Google Chrome, the pinned CLI from
`~/Library/Caches/sapu/pw-c925ef206091`, a scratch HTTP server, `HOME`/`TMPDIR`/`PWTEST_SOCKETS_DIR`
as `cliEnv` sets them):

| Fact | Probe |
|---|---|
| State a `run-code` function attaches to `page.context()` (an object, and `ctx.on("request"/"response"/"page")` listeners) **persists across later `run-code` calls** of the session: a second call saw the first's object, and listeners registered once kept recording every later `goto`'s traffic | `run-code` installing `ctx.__argus` and listeners, then `goto`, then a reading `run-code` |
| Such a listener reads every request's headers with `request.allHeaders()` (the HttpOnly `Cookie`, `Authorization`, `X-Csrf-Token`) and every response's `Set-Cookie` with `response.allHeaders()`; `response.json()` reads JSON bodies; `response.status()` sees 5xx | same probe: `sid=…` HttpOnly, `Bearer …`, `x-csrf-token`, a 500 |
| `page.on("console")` (type `error`) and `page.on("pageerror")` registered from `run-code` persist too; a 5xx sub-resource also logs `Failed to load resource: the server responded with a status of 500` | `run-code` hook, then `goto /fail` |
| A `ctx.on("page", p => p.on("domcontentloaded", …))` hook that evaluates a watcher in the new page **catches a toast in a `target=_blank rel=opener` popup** that appears 200 ms after load and is removed 300 ms later (phase 3's known limit) | link popup in the scratch app; the watcher's buffer read by the next `run-code` |
| `page.requests()` and `page.consoleMessages()` exist in the bundled playwright-core (1.64 alpha); `requests --clear` does not clear `page.requests()` | `typeof page.requests`; reading after `requests --clear` |
| `performance.getEntriesByType("navigation")[0].responseStatus` is the main document's status (200, 500); a navigation that failed leaves the page at `chrome-error://chromewebdata/` with status 0 | `goto /fail`, `goto http://127.0.0.1:1/` |
| `tracing-start` / `tracing-stop` work; the trace goes to `<outputDir>/traces/trace-<ms>.trace`, `.network` and `resources/` (files 0644, inside the slot's 0700 directory) | `tracing-start`, `goto`, `tracing-stop` |
| A `run-code` call takes about 1.0 s end to end, its function starting 350–400 ms after spawn; two sessions' `run-code` calls spawned together and waiting for a shared epoch-ms barrier 1.5 s ahead acted within 1 ms of each other and 2 ms after the barrier | three timed calls; two sessions in parallel |
| `gh` 2.102.0: `gh issue create` and `gh issue comment` take `--attach <file>[#alt]` (up to 50); an upload that fails still leaves the issue created | `gh issue create --help`, `gh issue comment --help` |
| `stripTypeScriptTypes` (`node:module`) strips a generated `@playwright/test` file and throws `ERR_INVALID_TYPESCRIPT_SYNTAX` on bad TypeScript; `node --check` then parses the result | Node v26 (the repo requires ≥ 22.18, which has it) |

Facts read from the code as built (5fef368), where it and the spec differ:

| Built | Spec |
|---|---|
| A return's `candidates[].repro` is an array of at most 100 objects (`validateReturn`) | §10 shows `{context, steps}` |
| `slotDir` accepts a positive integer or `up`; `putSession`'s instance rule and `upFresh`'s close pass cover numbered slots only | §10 names repro sessions `<run>-r-<role>[.<n>]` |
| Nothing records cookie, header or storage values: the proxy logs blocked origins only, logins `requests --clear` | §10 scrub reads "the run's request logs" |
| `mintSlot` needs an instance id, the proxy and the browser; `pw` refuses every call but `submit` without an instance id | §6: the map is "returned through the wrapper's `submit`", and `list` "starts no app" |
| `login` records a configured account's failure in run.json `loginFailed`, which `up --fresh` keeps | §10 says nothing about repro accounts that failed |

## Decisions this plan takes (spec gaps; fold into the spec)

1. **Repro list.** A candidate's `repro` stays the array `validateReturn` takes; its first element may
   be `{"context": {"viewport", "locale", "timezone"}}` (each optional; defaults from `live`). Every
   other element is a step or `{"parallel": [steps…]}`.
2. **Repro references.** `repro <slot>.<generation>.<k>` names candidate `k` (1-based) of
   `returns/<slot>.<generation>.json` of the lock's run; the runner reads the file itself, so the
   orchestrator never re-types a repro. Its records live in `.argus/live/<run>/repro/<ref>/`
   (`repro.json`, `run-<i>.json`, `steps-<i>.jsonl`, `min.json`, `minimize.json`, `red.spec.ts`), kept
   by `down`; the teardown's slot-file pass skips `repro/` like `logs/` and `returns/`.
3. **Repro sessions** live in slot `r` (`.argus/live/<run>/r/`), named `<run>-r-<role>.<k>`
   (`sessionName(runId, "r", account)`). The accounts are the candidate's slot allocation (run.json
   `slots[<slot>].accounts`). Slot `r`'s CLI config is written at the start of every run with the
   repro's context (`slotConfig` with `locale`, `timezone` and `viewports: [viewport]` overridden).
   The runner closes its sessions at the end of every run; `up --fresh` closes every session whose
   slot is not `up`; `putSession`'s instance-id rule covers every slot but `up`.
4. **`loginFailed` and repro.** An account in run.json `loginFailed` (the explore phase's, or an
   earlier repro's) makes the run exit 2 at once with `HARNESS: <role>.<k> cannot sign in this cycle`,
   no browser opened for it. A repro's own failed login is recorded there too (`login`'s default
   `runFailures`), so it blocks every later repro of the cycle: never retried (lockout).
5. **Steps are wrapper code.** Every browser step and browser expectation runs as `run-code
   --filename` of a constant template (`stepCode`), its payload only as `const P = <JSON>;`, its target
   only as `(pg) => <targetCode>` built from a structured target; `goto` takes paths only, through
   `checkUrl`; `trigger`, `fact-equals` and `mail` run through `runHook`. Repro targets are the spec's
   five kinds (`role`+`name?`+`exact?`, `label`, `text`, `placeholder`, `testId`) with `nth?` and
   `within?`; `css`, `title`, `altText` and refs are refused.
6. **State-changing steps.** `select`, `check`, `uncheck`, `trigger` and `login` always change state;
   `click`, `dblclick` and `press` change state when the page issued a request other than `GET`/`HEAD`
   during the step (the template watches the context's requests). Its **proving expect** is the first
   `expect` as the same account after it, and it must come before that account's next action other
   than `read` and before the list ends (§10's example: `click Place order`, `read`, `expect visible`);
   a `trigger`'s is the first `expect` of any account, before the next state-changing step. After a
   `parallel` group, each acting account needs its own. The always-state-changing ones are checked
   before any browser work; the click family when it ran (the run records which steps changed state).
   A list that breaks the rule exits 2.
7. **`final` templates** (one `final`, on the last step only, its oracle one of `ORACLES`): handoff,
   discoverability and unreachable-step → `visible`; status-coherence → `fact-equals` or `text-equals`;
   dead-end → `enabled`; reversal and stale-view → `fact-equals`; orphaned-work → `hidden`; re-entry →
   `value-equals`; claim-race → `count` after an earlier `parallel` group holding two accounts of one
   role; interrupted-flow → `count` with the step before it a `no-error` of the same account;
   viewport-locale → `visible` or `enabled`. (The spec gives no template for unreachable-step.)
8. **Output and exit codes of one run.** Outside any fence only the wrapper's words: `fresh: instance
   <id>`, one `step <n> <account|system> <action|expect kind>: ok|held|failed|changed-state` line per
   step, `truncated <k> characters`, and the last line. Expected values and what the page showed go in
   one nonce fence before the last line (secrets masked as `pw` masks them). Exit 3's last line is
   `REPRODUCED step=<n> expected=<kind>[:<number>] observed=<enum>|<kind>:<number>` — enums and
   integers only (`observed=absent|hidden|visible|disabled|differs|errors:<k>|count:<k>`); exit 0's is
   `NOT REPRODUCED`; exit 2's is `HARNESS: step <n> <reason>` or `HARNESS: <reason>`.
9. **2 of 2 is the script's rule.** `repro <ref>` runs once, and a second time only when the first
   exited 3; exit 3 needs both runs at 3, else exit 0 with `NOT REPRODUCED runs=<k>/<n>` (`1/2` is the
   intermittent case the journal records); a harness failure stops at once (exit 2). `repro <ref>
   --once` is one run.
10. **Minimize.** Removal units, tried in this order: each role but `system` and the final step's
    role (all its steps); then, from the last step back, each single step that is not the final, not a
    `trigger`, not a `parallel` group, not a proving `expect` and not a role's only state-changing step
    — a state-changing step (as the reproducing run recorded them) together with its proving `expect`.
    A unit whose reduced list fails the static checks is skipped without a run; one is kept only when
    its run exits 3 (every remaining `expect` held, same `final`). Runs stop at
    `limits.minimize_runs` (default 12), one of them kept for a confirming run of the result; an
    unconfirmed result leaves the original list the one filed. Output `minimized <ref>: steps <a> → <b>,
    runs <k>/<max>, stopped fixpoint|budget, confirmed yes|no`.
11. **Expectations wait.** Every expectation, the final included, is polled (browser ones every 200 ms
    in the page, `fact-equals` and `mail` every 500 ms) up to `settle_ms` and holds at the first
    success. `no-error` reads the acting account's 5xx responses, console errors and page errors since
    the previous step; lines carrying Chrome's blocked-request errors or naming an origin outside the
    run's origins and `allow_origins` never count.
12. **Placeholders.** `read` saves an element's value (`inputValue` of an input, textarea or select,
    else its trimmed `innerText`, at most 500 characters) under `save` (`^[a-z][a-z0-9_]{0,31}$`, not
    `marker`); `{{marker}}` is `argus-<8 hex>`, fresh per run; a `{{name}}` used before its `read` is a
    static error. Substitution is textual in string fields only, the result a literal.
13. **Trace.** Each repro session runs `tracing-start` after its open and `tracing-stop` before its
    close; the files stay in `r/out/traces/` (the slot's 0700 directory), kept by `down` for H2
    diagnosis, never attached (they hold the run's cookies).
14. **The secret ledger** is `.argus/live/<run>/secrets.jsonl` (0600), one `{"c": "cookie"|"header"|
    "storage", "v": <value>}` per line, appended by the session driver's observation; `down` removes it
    with the slot secrets; `scrub` refuses without it (`refused: scrub: the run's secret ledger is gone (a
    down removed it); nothing from this run is filed`) and with a line it cannot read. Values shorter
    than 6 characters, of any class, are not recorded and not matched by scrub (they would refuse every
    issue; `pw`'s fence still masks them);
    `Authorization` values are kept whole and without their scheme word, a `Cookie` header as each
    cookie's value, `Set-Cookie` as the value before its first `;`, storage values whole and as each JSON
    string leaf.
15. **Ids the run saw** go to `logs/seen.jsonl` (kept): the path segments of the pages' requests to the
    run's origins and the JSON response leaves that are 24+ characters mixing letters and digits, except
    under a key matching `/token|secret|key|pass|session|auth|csrf|cookie/i`. Scrub leaves those
    readable.
16. **The in-daemon hook.** `hook`, a new stage of `loginCode`, runs once after every session open of
    an explorer or repro slot (not the proving logins): it installs, once per context (`ctx.__argus`),
    the request and response listeners (header values, 5xx, ids), `console`/`pageerror` listeners on
    every page, and a `domcontentloaded` listener on every page and popup that evaluates
    `SIGNAL_SCRIPT` again — so a `target=_blank` popup is watched from its first document (phase 3's
    known limit, spec §7, goes). Buffers are capped (headers 500, errors 200, ids 2000); `observe`
    drains them.
17. **Scrub's text rules.** A secret is refused in the title and the body when `secretPattern` finds
    it or when the text and the value, each stripped of whitespace, punctuation and symbols, contain
    it. Redaction: every run of 24+ `[A-Za-z0-9_-]` holding a letter and a digit, not all hex, not in
    the seen ids → `<redacted>`. Defanging, outside fenced blocks and code spans as CommonMark reads
    them: `@name`, `#123`, `owner/repo#123` and every `http(s)` URL whose host is not loopback are
    wrapped in backticks. Fenced blocks whose info string is `ts`, `typescript` or `json` (the generated
    test, the repro) are left whole; every other fenced block keeps at most 20 lines (`… <k> lines cut`
    inside it). The title gets the same treatment.
18. **Screenshots.** After `pw … screenshot`, the wrapper runs a `shot` stage and writes, beside the
    PNG, `<name>.verdict.json` (0600) `{t, passed, reasons}`: `secret` (the page text or an input value
    holds a scrub secret at that moment), `password-field`, `one-time-code-field`, `error-page` (status
    ≥ 400 or a `chrome-error:` page). Never the text. Scrub attaches a screenshot only when it lies in a
    slot's `out/` of the run, its verdict passed, `gh --version` ≥ 2.99, `gh repo view` says `PRIVATE`
    or `INTERNAL`, and the contract's policy `traces` is not `none`; the others are named in a `Local
    evidence:` line scrub appends to the body.
19. **Scrub files.** `scrub … --create [--label <l>…]` and `scrub … --comment <n>` run `gh issue
    create|comment --body-file` (no shell) once the text passed; an issue or comment URL in gh's stdout
    means filed, whatever its exit code (`filed: <url>`); no URL means not filed (exit 2). Without
    either flag scrub only checks and rewrites.
20. **Map mode.** `argus-live.mjs up --map` takes the lock and builds the worktree at HEAD — no setup,
    store, app, proxy, HOME or logins — and writes run.json with `mode: "map"`. `slot <n> --map` mints a
    map token in any run whose run.json has a worktree (a map run, or a full `up` still starting), so
    `/sapu:journey` can refresh the map while `up` brings the app up. A map token takes `code` and
    `submit` only, before an instance id too; its `submit` validates the map schema (`validateMap`).
    `map-check --merge <slot>` merges the newest generation's map into `.argus/journeys.json` and checks
    it. `up --fresh` and `renew` refuse a map run. The guard needs nothing new: the map agent's Read is
    the run's worktree, as run.json names it.
21. **`map-check`'s rules, made exact.** An anchor's `text` counts every occurrence in the file at HEAD
    (two on one line count two); `line` moves to the nearest occurrence's line. "In a route or
    permission file among `roots`" = the anchor's file is a root or under a root directory. A route's
    last path segment is its last segment that is not a parameter (`:id`, `[id]`, `{id}`, `*`), compared
    without case; the route `/` has none and needs only an anchor under `roots`. A later duplicate id is
    dropped (`duplicate id`), and so is an id that is not kebab-case. Dropped journeys leave `journeys`
    for `dropped`, the file is rewritten. A momus report is "newer than head" when the newest
    `.momus/report-*.md`'s mtime is after `head`'s committer time.
22. **SELECT inputs.** `select --cycle <n>` takes argus's current cycle number; `cycles_since_visit =
    n − lastCycle` (`n` when never visited). Journeys gain `lastHead` (the commit at the last visit;
    commits touching anchor files are counted `lastHead..HEAD`, 0 without it) and `filed` (issue
    numbers), both written by PERSIST beside `lastCycle`. "Flagged by a momus report" is the
    orchestrator's reading of the newest report, passed as `--flagged <id>,…`. A step `"claim": true`
    marks the role a claim race needs two accounts of. Users in `.argus/live.json` must be literal for
    `select` (it prints account lists `slot` takes). Defaults: `limits.max_parallel_journeys` 2.
23. **Class and severity** come from `classify --oracle <o> [--money] [--stock] [--moved-twice]
    [--acted-on] [--rule]` (§10's table; `--rule` = a written rule exists); argus's own adjustments
    stay the orchestrator's.
24. **Doc drift** comes from `drift --doc <file>:<a>-<b> --code <file>:<a>-<b> [--code …]` (§5's
    blame comparison): `code-newer` (needs-owner), `doc-newer` (class B(a)), or `undecidable (<why>)`
    (needs-owner).
25. **Module split.** `argus-live-instance.mjs` keeps `up`, `up --fresh`, `up --map`, `renew` and
    `status`; the bring-up blocks (ports, worktree, HOME, environment, setup, start, health, store)
    move whole to `argus-live-start.mjs`. `canonicalOrigin`, `exactHost` (from `-proxy.mjs`),
    `originOf`, `BLOCKED_ERROR` and `checkUrl` (from `-pw.mjs`) move to the leaf `argus-live-origin.mjs`;
    `secretsOf` and `configuredUser` move from `-pw.mjs` to `-session.mjs` (as `maskSecrets`,
    `configuredUser`), shared with the runner.

**Spec edits this plan needs** (folded in by the final task, as built): §5 — `drift`; §6 — the
journey fields `lastHead`, `filed` and the step field `claim`, map mode (`up --map`, map slots,
`map-check --merge`), the exact `map-check` rules (decision 21), `select`'s inputs and output,
`map-check --list` as the catalog; §7 — the popup known limit removed (decision 16); §8 — run.json
`mode`, `up --map`, map slots, `down` removing `secrets.jsonl`, the teardown skipping `repro/`,
`status` naming a map run; §9 — slot `r` and its sessions, the `hook` stage, the screenshot verdict,
the map token's two commands; §10 — decisions 1–15 and 17–19, 23; §12 — rows for a repro account in
`loginFailed`, a gone or damaged ledger, `up --fresh` refusing a map run; §14 — the test names as
built; §16 — `argus-live.mjs` gains `up --map`, `slot --map`, `repro`, `map-check`, `select`, `scrub`,
`classify`, `drift`. Roadmap row 4 — map mode, `classify` and `drift` added.

---

## File structure

| File | Responsibility |
|---|---|
| `plugins/sapu/scripts/argus-live-origin.mjs` | new leaf: `exactHost`, `canonicalOrigin`, `originOf`, `BLOCKED_ERROR`, `checkUrl` |
| `plugins/sapu/scripts/argus-live-start.mjs` | new: the bring-up blocks moved from `-instance.mjs` |
| `plugins/sapu/scripts/argus-live-session.mjs` | new: `sessionDriver`, `maskSecrets`, `configuredUser` (from `pw`'s `call`) |
| `plugins/sapu/scripts/argus-live-ledger.mjs` | new: `MIN_SECRET`, `ledgerFile`, `ledgerEntries`, `appendLedger`, `readLedger`, `seenFile`, `appendSeen`, `readSeen`, `secretHits` |
| `plugins/sapu/scripts/argus-live-steps.mjs` | new: the repro DSL — `parseRepro`, `FINAL_KINDS`, `substitute`, `stepCode`, `reductions` |
| `plugins/sapu/scripts/argus-live-repro.mjs` | new: `reproRef`, `runOnce`, `repro`, `minimize` |
| `plugins/sapu/scripts/argus-live-redtest.mjs` | new: `redTest` |
| `plugins/sapu/scripts/argus-live-classes.mjs` | new leaf: `CLASSES`, `classify` |
| `plugins/sapu/scripts/argus-live-scrub.mjs` | new: `scrubSecrets`, `redactIds`, `defang`, `attachVerdict`, `scrub` |
| `plugins/sapu/scripts/argus-live-map.mjs` | new: `JOURNEYS_FILE`, `readJourneys`, `validateMap`, `mapCheck`, `refreshReasons`, `catalog`, `mergeMap`, `score`, `selectJourneys` |
| `plugins/sapu/scripts/argus-live-drift.mjs` | new: `drift` |
| `plugins/sapu/scripts/argus-live-proxy.mjs`, `-login.mjs`, `-pw.mjs`, `-browser.mjs`, `-cli.mjs`, `-run.mjs`, `-slots.mjs`, `-return.mjs`, `-instance.mjs`, `argus-live.mjs` | modified (each task names its change) |
| `tests/fixtures/journey-app/server.mjs` | modified: `/storage`, `/api/items/<id>`, stock, inbox, claim, approve, ship, cancel, the seeded defects behind `$DEFECTS_FILE` |
| `tests/fixtures/argus-red/order-to-cash.handoff.spec.ts` | new: the golden generated test |
| `tests/helpers/argus-live.ts` | modified: `appCycle()` (a full `up` on the fixture app with its defects file), `candidate()` (a minted slot's return holding repros), `fakeGh()` |
| `tests/argus-live-findings.test.ts` | new: tests that need no browser (DAG, DSL, red test, classes, ledger matcher, scrub, map, select, drift; the CLI shim where a session is involved) |
| `tests/argus-live-repro.test.ts` | new: tests in Chrome (hook, ledger, repro, minimize, screenshot verdicts, the end-to-end cycle) |
| `tests/argus-live.test.ts`, `tests/argus-live-pw.test.ts`, `tests/argus-live-browser.test.ts` | modified: imports from the modules symbols moved to |

Module DAG after this phase (each module imports only modules to its left; leaves import no
`argus-live-*` module): proc → lock → endpoints → docker/egress and cli → run → {browser, proxy,
hooks, slots, start, map, ledger, scrub, drift} → return → login → session → {pw, steps} →
{instance, redtest} → repro → `argus-live.mjs`. Leaves: `fence`, `targets`, `origin`, `classes`.
`ledger` imports only `fence` and `lock`; `scrub` imports `config`, `endpoints`, `run`, `ledger`,
`proc` and `sapu-contract.mjs` (so `pw`'s screenshot verdict can use it); `map` imports `config` and
`proc`; `drift` imports `proc`; `return` imports `map` (`validateMap`); `steps` imports `targets`,
`hooks`, `login` (`HELPERS`) and `return` (`ORACLES`). `pw` never imports `instance`; `start` never
imports `browser`. Task 1's test pins this and each later task adds its module to it.

**The CLI shim** (phase 3's `makeShim()`, `tests/helpers/argus-live.ts`) stands in for the CLI in the
findings file; its `run-code` queue answers each stage in order.

---

### Task 1: the leaf `-origin.mjs`, the split of `-instance.mjs`, and the DAG test

**Files:** Create `plugins/sapu/scripts/argus-live-origin.mjs`, `plugins/sapu/scripts/argus-live-start.mjs`,
`tests/argus-live-findings.test.ts`; Modify `-proxy.mjs`, `-login.mjs`, `-pw.mjs` (imports),
`-instance.mjs` (moved blocks out; its header comment rewritten as this plan's DAG), `tests/argus-live.test.ts`,
`tests/argus-live-pw.test.ts`, `tests/argus-live-browser.test.ts` (imports).

Interfaces:
- `-origin.mjs` (imports only `node:net`): `exactHost(h)` and `canonicalOrigin(origin)` moved
  verbatim (its default ports `{http: 80, https: 443, ws: 80, wss: 443}` its own constant, not
  `-endpoints.mjs`'s); `originOf(u)` (moved from `pw`: a URL's canonical origin, `ws:` as `http:`,
  `wss:` as `https:`, or null); `BLOCKED_ERROR` (moved); `checkUrl(arg, {origins, base})` moved from
  `pw` with its refusal wording and its `shown` helper.
- `-start.mjs`: every function from `accepts` through `bringUpRest` of today's `-instance.mjs`
  (`portFree`, `allocatePorts`, `makeWorktree`, `makeHome`, `instanceEnv`, `refuseLinksIntoMain`,
  `runSetup`, `startEntry`, `waitHealth`, `checkStore`, `bringUpStore`, `bringUpRest` and their private
  helpers), moved whole. `-instance.mjs` keeps `defaultLookup` onward and imports what it uses.
- No behaviour changes; `pw`'s, `login`'s and the proxy's importers take the moved names from
  `-origin.mjs`; the tests take `startEntry`, `waitHealth`, `allocatePorts`, … from `-start.mjs`.

- [ ] **Step 1: Write the failing tests** (`tests/argus-live-findings.test.ts`, describe "argus-live
  modules — the DAG"):
  - "every argus-live module imports only modules below it": read every
    `plugins/sapu/scripts/argus-live*.mjs`, collect `from "./argus-live-<x>.mjs"`, assert the graph is
    acyclic, `-fence`, `-targets`, `-origin` import no `./argus-live-` module, `-pw` cannot reach
    `-instance`, `-start` cannot reach `-browser`, and `-instance.mjs` is under 700 lines.
  - "origins are compared as the run spells them": `originOf("wss://Example.test/x")` →
    `https://example.test:443`; `originOf("ws://localhost:5/x")` → `http://localhost:5`;
    `originOf("javascript:x")` → null; `checkUrl("/orders/new", {origins: ["http://localhost:4100"],
    base: "http://localhost:4100/"})` → `http://localhost:4100/orders/new`; `checkUrl("//x.test/",
    …)` throws `refused: //x.test/ is outside the run's origins`.
- [ ] **Step 2: Run** `npx vitest run tests/argus-live-findings.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement** the moves (cut and paste, then imports); rewrite `-instance.mjs`'s header
  comment (it still says steps 9 and 10 arrive later) to list the DAG above.
- [ ] **Step 4: Run** the file, then `npx vitest run` → PASS (the moved code's own tests unchanged).
- [ ] **Step 5: Commit** `git add -A plugins/sapu/scripts tests`; `git commit -m "refactor(sapu):
  argus-live origins in a leaf module, the instance's bring-up blocks in argus-live-start.mjs, and a test
  pinning the module DAG"`.

---

### Task 2: the session driver, extracted from `pw`

**Files:** Create `plugins/sapu/scripts/argus-live-session.mjs`; Modify `plugins/sapu/scripts/argus-live-pw.mjs`
(`call` keeps grammar, budget, loop, HARNESS, `login`, `find`, console and blocked lines, output);
Test `tests/argus-live-findings.test.ts` (shim).

Interfaces:
- `export function maskSecrets(main, config, live, state)` — today's `secretsOf`, renamed.
- `export function configuredUser(live, u)` — moved as is.
- `export function sessionDriver({main, runId, slot, account, rec, live, envSecrets, slotRec, dir,
  js, credentials, failures = null, runner = run, cliRunner = runAsync})` → a driver:
  - `name`, `plan` (`loginPlan(live, role)`), `role`, `state` (the account's `{signedIn, lastState,
    consoleSeen}`, read from the slot's state.json);
  - `cli(args, timeoutMs = plan.settleMs + 60_000)` → `runCli` in the slot's cwd and `<run HOME>/browser`;
  - `stage(which, payload)` → `runCode(loginCode(which, payload))`; `code(text, timeoutMs)` → `runCode`
    of a template the caller built (the runner's steps);
  - `async ensure()` → `{record, opened}`: the recorded session with a daemon, else `open()`
    (`stillLive`; a login-command role's storage state from `commandLogin`; `openSession`);
  - `async signIn(c = credentials())` → `login`'s answer (with `failures` for a created account);
    `state.signedIn` set on success;
  - `gone(res, record)` → true when the CLI said `is not open, please run open first` or the recorded
    daemon no longer runs;
  - `async reopen(record)` → events: closes it (`closeSessions`), `open()`, signs in unless `anon` or a
    login-command role; `["session-reopened: <role.k>"]` plus `harness: login failed` when that failed;
  - `async observe()` → `{o, events}`: the `observe` stage; sets `state.lastState`; a failure →
    `events: ["harness: observation failed"]`;
  - `async relogin(o)` → events: the probe (`probed: <role.k>`, `logs/probes.jsonl`), and when it
    also lacks `logged_in`, one sign-in (`re-logged-in: <role.k>` or `harness: login failed`), a
    login-command role closed and opened again.
- `pw`'s output, refusals, counters and files are unchanged byte for byte.

- [ ] **Step 1: Failing tests** (describe "argus-live session driver"; a `liveRun()` with an instance
  id, slot 1 holding `buyer.1`, the shim as `js`):
  - "ensure opens the session on first use and reuses the recorded one": the shim saw one `open` with
    `-s=<run>-1-buyer.1` in the slot's cwd; a second driver's `ensure()` → `opened: false`, no new
    `open`.
  - "a gone browser is reopened and the command is not run": the shim answers `goto` with `The browser
    '<name>' is not open, please run open first` (exit 1) → `gone(res, record)` true; `reopen(record)`
    → `["session-reopened: buyer.1"]`; the shim saw `close`, then `open`, and one `goto` only.
  - "relogin probes before signing in": `observe` queued `{loggedIn: false}`, `probe` queued
    `{in: true}` → `relogin` events `["probed: buyer.1"]`, no login stage run; with `{in: false}` and a
    `credentials` stage answering `in` → `["probed: buyer.1", "re-logged-in: buyer.1"]`.
  - "maskSecrets holds the env file's, the roles' and the created accounts' values": keys as `pw`
    used them.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**, moving code out of `call` (no copy left behind).
- [ ] **Step 4: Run** `npx vitest run tests/argus-live-findings.test.ts tests/argus-live-pw.test.ts
  tests/argus-live-browser.test.ts` (the `pw` suites unchanged prove the behaviour), then `npx vitest run` → PASS.
- [ ] **Step 5: Commit** `refactor(sapu): argus-live-session.mjs — the session driver pw used inline, shared with the repro runner`.

---

### Task 3: the in-daemon hook

**Files:** Modify `plugins/sapu/scripts/argus-live-login.mjs` (stages `hook`, `observe`),
`plugins/sapu/scripts/argus-live-session.mjs` (`open()` runs `hook`); Test
`tests/argus-live-repro.test.ts` (Chrome), `tests/argus-live-findings.test.ts` (shim).

Interfaces:
- Stage `hook` (payload `{runOrigins, signals: SIGNAL_SCRIPT}`; returns `{installed: true|false}`,
  false when `ctx.__argus` existed): creates `ctx.__argus = {headers: [], errors: [], ids: [],
  paths: []}`; `ctx.on("request")` pushes `[name, value]` for `cookie`, `authorization`,
  `proxy-authorization` and `*-token` headers (`request.allHeaders()`), and the URL's path segments for
  a run origin; `ctx.on("response")` pushes `set-cookie`, a `{kind: "5xx", status, url}` error for a
  status ≥ 500, and for a `json` content type the string leaves of the body (decision 15's shape and key
  rule); a page hook (for `ctx.pages()` and `ctx.on("page")`) adds `console` errors and `pageerror`
  (`{kind: "console"|"pageerror", text ≤ 500, url}`) and a `domcontentloaded` listener evaluating
  `P.signals`. Buffers capped (decision 16).
- Stage `observe` additionally returns `secrets: {cookies: <ctx.cookies() values>, storage: <every
  page's localStorage and sessionStorage values>, headers: <drained>}`, `ids: <drained>`, `paths:
  <drained>`, `errors: <drained>`.
- `sessionDriver().open()` runs `hook` right after `openSession` (a failure → `harness: hook failed`
  among the open's events; the session is used all the same).

- [ ] **Step 1: Probe first (done, see "Verified against"); re-run on the release machine** the
  linked-popup case below before writing the code.
- [ ] **Step 2: Failing tests.**
  `tests/argus-live-repro.test.ts`, describe "argus-live hook — every document watched" (phase 3's
  `browserRun()` and `mintSlot`, moved to the helpers file if it is still local):
  - "a popup a link opened is watched from its first document": `pw <t> buyer.1 goto /popup`, `click
    'getByRole('\''link'\'', { name: '\''Open linked details'\'' })'`, wait 6 s (the toast comes at 4 s
    and goes at 5 s), `pw <t> buyer.1 tab-list` → the fence holds `signal status: Linked ready`.
  - "the hook installs once per context": two `pw` calls, then a test `runCode` returning
    `Object.keys(page.context().__argus)` and the listener count of `ctx.listenerCount("request")` → 1.
  - "a reopened session gets the hook again": kill the browser root; the next call answers
    `session-reopened: buyer.1`; the one after records the linked popup's toast as above.
  `tests/argus-live-findings.test.ts`, describe "argus-live hook stage": "the hook's code takes its
  payload only as JSON" (a run origin `http://x.test:1"); process.exit(); ("` appears only on the
  `const P = …;` line).
- [ ] **Step 3–4:** run (FAIL), implement, run both files and `npx vitest run` (PASS).
- [ ] **Step 5: Commit** `feat(sapu): argus-live hooks every session's context — signals in every document, popups from links included, and the headers, errors and ids the run saw`.

---

### Task 4: the secret ledger and the ids the run saw

**Files:** Create `plugins/sapu/scripts/argus-live-ledger.mjs`; Modify `-session.mjs` (`observe()`
appends), `-run.mjs` (`removeRunSecrets` removes `secrets.jsonl`, skips `repro/`),
`tests/fixtures/journey-app/server.mjs` (`/storage`, `/api/me`, `/api/items/<id>`); Test
`tests/argus-live-findings.test.ts`, `tests/argus-live-repro.test.ts`.

Interfaces:
- `export const MIN_SECRET = 6`.
- `export function ledgerFile(main, runId)` → `<liveDir>/<runId>/secrets.jsonl`;
  `export function seenFile(main, runId)` → `<logs>/seen.jsonl`.
- `export function ledgerEntries({cookies = [], storage = [], headers = []})` → `[{c, v}]` per
  decision 14 (values under `MIN_SECRET` dropped, duplicates dropped).
- `export function appendLedger(main, runId, entries)`: appends the entries not already in the file,
  as one write, mode 0600; `export function readLedger(main, runId)` → `[{c, v}]`, `null` when the file
  is gone, throws `refused: scrub: the run's secret ledger is damaged` on a line that is not
  `{c, v}` JSON.
- `export function appendSeen(main, runId, values)`, `export function readSeen(main, runId)` → `Set`.
- `export function secretHits(text, secrets)` → the sorted distinct classes (`secrets` is `{"<class>:
  <anything>": value}`) whose value (≥ `MIN_SECRET`) `secretPattern` finds in `text`, or whose value
  stripped of `[\s\p{P}\p{S}]` (when still ≥ `MIN_SECRET` long) is a substring of `text` stripped the
  same way.
- The fixture: `/storage` (signed in) sets `localStorage.jwt` to 32 random hex, fetches `/api/me` with
  `Authorization: Bearer <32 random hex>` (kept in `DATA_DIR/bearer.json` so the test can read it) and
  `/api/items/ck9a8b7c6d5e4f3g2h1i0j9k8` answering `{"id": "ck9a8b7c6d5e4f3g2h1i0j9k8", "token":
  "tok_<32 hex>"}`; nothing of it is rendered.

- [ ] **Step 1: Failing tests.**
  describe "argus-live ledger" (findings file):
  - "ledgerEntries splits headers and storage as scrub matches them": cookies `["COOKIEVALUE_abc123"]`,
    storage `['{"jwt":"LS_TOKEN_98765","n":1}', "dark"]`, headers `[["authorization", "Bearer
    AUTHVALUE_112233"], ["cookie", "sid=abcdef123456; theme=dark"], ["set-cookie",
    "sid=zzzzzz999999; Path=/; HttpOnly"], ["x-csrf-token", "CSRFVAL_9988"]]` → exactly the values
    `COOKIEVALUE_abc123`, the whole JSON string, `LS_TOKEN_98765`, `Bearer AUTHVALUE_112233`,
    `AUTHVALUE_112233`, `abcdef123456`, `zzzzzz999999`, `CSRFVAL_9988` with their classes.
  - "secretHits finds a value raw, URL-encoded, base64-encoded and split by spaces": value
    `AUTHVALUE_112233` in `x AUTHVALUE_112233 y`, `AUTHVALUE%5F112233`, `QVVUSFZBTFVFXzExMjIzMw`,
    `A U T H V A L U E _ 1 1 2 2 3 3` → `["header"]` each; `"db"` as a value and `db` in the text →
    `[]`.
  - "a damaged ledger refuses; a gone one is null".
  describe "argus-live ledger in Chrome" (repro file):
  - "observation records the HttpOnly cookie, the storage value and the bearer token, never in pw's
    output": `pw <t> buyer.1 goto /storage` → `secrets.jsonl` (mode 0600) holds the `sid` the fixture
    issued (from `sessions.json`), `localStorage.jwt` and the bearer from `bearer.json`; `pw`'s output
    holds none of the three.
  - "the ids the run saw are kept, tokens are not": `logs/seen.jsonl` holds
    `ck9a8b7c6d5e4f3g2h1i0j9k8`, not the `tok_` value.
  - "down removes the ledger and keeps the ids": after `down`, `secrets.jsonl` is gone,
    `logs/seen.jsonl` remains.
- [ ] **Step 2–4:** run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `feat(sapu): argus-live records the run's cookie, header and storage values in a 0600 ledger down removes, and the ids its pages saw`.

---

### Task 5: repro sessions in slot `r`

**Files:** Modify `plugins/sapu/scripts/argus-live-browser.mjs` (`SLOT`, `putSession`),
`plugins/sapu/scripts/argus-live-instance.mjs` (`upFresh` closes every slot but `up`); Test
`tests/argus-live-findings.test.ts` (shim).

Interfaces:
- `slotDir(main, runId, slot)`: `slot` a positive integer, `up` or `r`; else `failed: <slot> is not a
  slot (a positive integer, up or r)`.
- `putSession`: the instance-id rule and the pending-record rule apply to every slot but `up`.
- `upFresh`: closes the sessions whose `slot !== "up"` (explorers and repro), with the same
  drop-only-the-gone rule.

- [ ] **Step 1: Failing tests** (describe "argus-live repro sessions"):
  - "slot r is a slot": `slotDir(main, run, "r")` ends `/<run>/r`; `slotDir(main, run, "x")` throws;
    `sessionName(run, "r", "buyer.1")` → `<run>-r-buyer.1`.
  - "a repro session is recorded only while the run has an instance": `openSession({slot: "r", …})`
    with `instanceId: null` → refused, the shim saw no `open`.
  - "up --fresh closes repro sessions": a recorded `r` session (a `sleep 600` group as its daemon) →
    after `upFresh` the shim saw `-s=<run>-r-buyer.1 close` and the record is gone.
  - "down closes them": the same through `down`.
- [ ] **Step 2–4:** run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `feat(sapu): argus-live repro sessions in slot r — recorded, closed by up --fresh and down like an explorer's`.

---

### Task 6: the fixture's seeded oracle defects

**Files:** Modify `tests/fixtures/journey-app/server.mjs`; Test `tests/argus-live-pw.test.ts`
(describe "journey-app fixture — browser side", plain `fetch`).

The fixture keeps every phase-2 and phase-3 behaviour and adds, without dependencies:
- **Stock.** `stock.json` (absent → `{"widget": 10}`); placing an order of quantity `q` takes `q`;
  `/stock` (any signed-in role) shows `data-testid=stock` with the number. `--facts <id>` prints
  `{status, quantity, stock, claims}` (`stock` the current widget count, `claims` the order's claim
  count).
- **Buyer.** `/orders/<id>` shows `Cancel order` while the order is `placed` or `approved`;
  `POST /orders/<id>/cancel` → `cancelled`, stock `+= q`.
- **Clerk.** `/inbox` lists actionable orders, one `data-testid=inbox-item` row each holding the id
  and a `Claim` button; `POST /orders/<id>/claim` adds a claim (`data-testid=claim` rows on the order
  page); a second claim answers 409 `Already claimed by <user>`. `/orders/<id>` for a clerk shows
  `Approve` (a hidden field carrying the status the page rendered) while `placed`, and `Ship` while
  `approved`; `POST …/approve` refuses (409 `Order is <status>`) unless the order is still `placed`;
  `POST …/ship` → `shipped`.
- **Defects**, each on while its name is in `$DEFECTS_FILE` (comma separated, re-read on every
  request, so a test toggles one without restarting the app): `missing-handoff` (the inbox never
  lists an order), `delayed-handoff` (an order is listed only 2000 ms after it was placed),
  `double-release` (cancel adds `2q`), `claim-race` (claim checks, waits 300 ms, then writes, so two
  together both pass), `stale-view` (approve accepts any status), `orphaned` (the inbox also lists
  cancelled orders), `dead-end` (`Ship` rendered `disabled`), `narrow-viewport` (`Place order` hidden
  below 500 px wide by a media query).

- [ ] **Step 1: Failing tests:** each fixed behaviour and each defect through `fetch` with a `sid` from
  `--login-state` (one `it` per defect: on and off), e.g. "double-release adds twice what the order
  took": stock 10, order of 2 → 8, cancel → 10 (off) / 12 (on); "claim-race lets two claims through":
  two parallel claims → 409 for one (off) / `claims: 2` in `--facts` (on).
- [ ] **Step 2–4:** run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `feat(sapu): the journey-app fixture's seeded oracle defects — handoff, dead end, reversal, claim race, stale view, orphaned work, viewport — each with its fixed variant`.

---

### Task 7: the repro DSL

**Files:** Create `plugins/sapu/scripts/argus-live-steps.mjs`; Modify `-login.mjs` (export `HELPERS`);
Test `tests/argus-live-findings.test.ts`.

Interfaces:
- `export const FINAL_KINDS` — decision 7 as `{<oracle>: [<expect kinds>]}`, keys exactly `ORACLES`.
- `export function parseRepro(list, {accounts, live})` → `{context, steps}` or throws `refused:
  repro: step <n>: <reason>` (`n` 1-based, the context element not counted). `accounts` is the
  slot's allocation; `as` goes through `accountOf` (or is `system`, only for `trigger`, `fact-equals`,
  `mail`). Each step is normalized to `{n, as, do|expect, target?, …, final?}` with `target` in
  `parseTarget`'s structure (`{by: "role", role, name?, exact?}`, `{by: "label", value}`, …, `nth`,
  `within`). Refusals (exact reasons): `unknown key "<k>"`, `unknown action`, `<as> is not allocated to
  this slot`, `system only triggers, reads facts and reads mail`, `a target names one of role, label,
  text, placeholder, testId`, `goto takes a path (/…)`, `{{<name>}} is used before a read saves it`,
  `final must be the last step`, `one final only`, `<oracle>'s final is <kinds>`, `claim-race needs a
  parallel group of two accounts of one role before its final`, `interrupted-flow needs no-error right
  before its final`, `<action> changes state: an expect as <account> must follow before its next
  action`, `a
  parallel group holds 2 to 8 actions of different accounts`, `anon is never signed in`, `login takes
  an account the journey created, never a configured user`, `trigger <name> is not in live.triggers`,
  `trigger <name> takes <k> value(s)`, `viewport must be from 200 to 4000`, `locale is not a BCP 47
  tag`, `timezone is not one Intl knows`, `at most 100 steps`. Every string ≤ 500 characters, no
  control characters.
- `export function substitute(step, vars)` → a copy with every `{{name}}` in its string fields replaced
  by `vars[name]` (a literal).
- `export function stepCode(step, {settleMs, at = null, runOrigins})` → the `async page => {…}` text
  of the `step` template: `const P = <JSON>;`, `const T = (pg) => <targetCode(step.target, "pg")>;` (or
  `null`), the shared `HELPERS`, then the action or the expectation's poll (decision 11). Actions answer
  `{ok, changed, method, value?, errors}` or `{ok: false, why: "missing-target"|"timeout"|"error",
  detail}`; expectations `{held, observed, detail, errors}` (`observed` per decision 8). `P.at` (epoch
  ms) is the `parallel` barrier.
- `export function reductions(steps, {changed})` → the removal units of decision 10, in order, each
  `{kind: "role"|"step", label, drop: [n…]}`; `changed` holds the steps of the click family the
  reproducing run recorded as state-changing.

- [ ] **Step 1: Failing tests** (describe "argus-live repro DSL"):
  - "parseRepro reads §10's example": the spec's list (as an array whose first element is the
    `context`) with accounts `{"customer.1": "buyer1@example.test", "sales.1": "clerk1@example.test"}`
    → 9 steps, step 4 `save: "order"`, step 9 `final: "handoff"`, targets in `parseTarget`'s shape.
  - "each refusal names its step" — one `it` per reason above, each with the smallest list that
    breaks it, e.g. `[{as: "customer", do: "select", target: {label: "Size"}, value: "L"}, {as:
    "customer", do: "goto", path: "/"}]` → `refused: repro: step 1: select changes state: an expect as
    customer.1 must follow before its next action`; §10's example itself passes (its `read` between
    the click and the `expect` is allowed).
  - "stepCode embeds values only as JSON": a `fill` value `'); process.exit(); ('` and a target name
    `"}); evil(); ({"` appear only inside the `const P = …;` line and as JSON string literals in the `T`
    line; the `T` line matches phase 3's `targetCode` regex.
  - "substitute is textual and literal": `{{order}}` → `ORD-1`; a saved value `O'Brien "x" \ ${y}`
    comes through unchanged inside the JSON payload.
  - "reductions never offer a trigger, a final, a parallel group, a proving expect or a role's only
    state-changing step": §10's example with `changed: [3]` → labels exactly `["role customer", "step
    8", "step 4", "step 2", "step 1"]` (step 9 the final, 7 and 5 proving expects, 6 a trigger, 3
    customer's only state-changing step); a list where `buyer` clicks twice with a POST each
    (`changed: [2, 4]`, its expects at 3 and 5, the final at 6 by `clerk`) → `steps 4+5` and `steps
    2+3` are offered, neither click alone.
- [ ] **Step 2–4:** run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `feat(sapu): argus-live repro DSL — steps as data, literal values, proving expects, final templates and the units minimize may drop`.

---

### Task 8: the repro runner, one run

**Files:** Create `plugins/sapu/scripts/argus-live-repro.mjs`; Modify `plugins/sapu/scripts/argus-live.mjs`
(`repro <ref> --once`), `tests/helpers/argus-live.ts` (`appCycle()`, `candidate()`); Test
`tests/argus-live-repro.test.ts`.

Interfaces:
- `export function reproRef(main, ref)` → `{runId, slot, generation, k, candidate, slotRec, dir}`;
  `ref` must match `^[1-9][0-9]?\.[1-9]\.[1-9][0-9]?$`; refused: `refused: repro: no return
  <slot>.<generation>`, `refused: repro: return <slot>.<generation> has no candidate <k>`.
- `export async function runOnce(main, ref, {list = null, i = 1, fresh = upFresh, cli = null, runner,
  cliRunner, say})` → `{code: 0|2|3, lines, result}`, in order:
  1. `parseRepro` (static checks; a refusal → exit 2 `HARNESS: repro: step <n>: <reason>`);
  2. accounts in `loginFailed` → exit 2 (decision 4);
  3. `fresh(main)` (`up --fresh`; a failure → exit 2 `HARNESS: up --fresh failed at <step>`), line
     `fresh: instance <id>`;
  4. slot `r`: `writeSlotConfig` with the repro's context, a fresh `state.json`;
  5. each step in order (a `parallel` group's actions spawned together with `at = now + 1500`): the
     account's driver `ensure()` (first use: `tracing-start`, signed in unless `anon`), `substitute`,
     then the browser step through `driver.code(stepCode(…))`, or `trigger` through `runHook` (its
     values through `fillArgv`), `fact-equals`/`mail` polled through `runHook`, `no-error` from the
     account's error buffer; a session lost (`logged_in` gone on the page and in a probe) → exit 2
     `HARNESS: step <n> <role.k> lost its session`; a `click`/`dblclick`/`press` with `changed` and no
     proving expect → exit 2 `HARNESS: step <n> changed state (a <METHOD> request) with no proving
     expect` (decision 6); a missing target → `HARNESS: step <n> missing target`; an
     `expect` before the final that fails → `HARNESS: step <n> expectation failed before the final step`;
  6. the final: held → exit 0 `NOT REPRODUCED`; failed → exit 3 with the fence and `REPRODUCED …`;
  7. `finally`: for each opened account `observe()` (the ledger), `tracing-stop`, `closeSessions`;
     `run-<i>.json` `{exit, step, expected, observed, ms}` and `steps-<i>.jsonl` (0600) written.
  Any throw → exit 2 `HARNESS: failed: <message, masked>` (the top-level handler).
- CLI: `repro <ref> --once` prints `lines` (each already masked; the fence's nonce never re-masked)
  and exits with `code`.

- [ ] **Step 1: Failing tests** (describe "argus-live repro — one run", Chrome; `appCycle()` = phase
  3's end-to-end setup (`homeWithCli()`, spawned `up`) with roles `buyer` (buyer1, buyer2) and `clerk`
  (clerk1 TOTP, clerk2), `settle_ms: 3000`, triggers `settle`, `facts`, `mail`, and `$DEFECTS_FILE`;
  `candidate(main, {slot, accounts, repro})` mints a slot and submits a return holding that repro):
  - "each seeded oracle defect reproduces, and its fixed variant does not": for each of handoff
    (`missing-handoff`), dead end, reversal (`double-release`), claim race (a `parallel` group of
    `clerk.1` and `clerk.2` clicking `Claim`), stale view, orphaned work — the repro written in the test
    from §10's templates; defect on → exit 3, last line matches `^REPRODUCED step=\d+ expected=[a-z-]+(:\d+)?
    observed=[a-z-]+(:\d+)?$`, every earlier line outside the fence matches the vocabulary regex
    `^(fresh: instance [0-9a-f]+|step \d+ (system|[a-z][a-z0-9_-]*\.\d+) [a-z-]+: (ok|held|failed|changed-state)|truncated \d+ characters)$`;
    defect off → exit 0, last line `NOT REPRODUCED`.
  - "a viewport defect reproduces at 390 and not at 1440": `narrow-viewport` on; context `{viewport:
    390}` → 3; `{viewport: 1440}` → 0.
  - "the delayed handoff is not a defect": `delayed-handoff` on, `settle_ms` 3000 → 0.
  - "exit 2 on a broken target, a dropped prerequisite, a missing proving expect and an uncaught
    error": `{testId: "nope"}` → `HARNESS: step 3 missing target`; a non-final `fact-equals` that does
    not hold → `… expectation failed before the final step`; a `Place order` click followed by `goto` →
    `HARNESS: step 3 changed state (a POST request) with no proving expect`; a `fresh` seam that throws
    `boom` → `HARNESS: failed: boom`.
  - "a run's records are absent from the next run": run 1 places an order; run 2's first step `expect
    count {testId: "inbox-item"} 0` as `clerk` holds.
  - "values with quotes are substituted as literals": `fill` of `O'Brien "x" \ {{marker}}` → a `text-equals`
    on the echoed field holds with the marker substituted; a `trigger settle` value `;id` → exit 2 naming
    the value's regex, the hook never ran.
  - "an account whose login failed this cycle is never retried": run.json `loginFailed
    {"buyer/buyer1@example.test": "rejected"}` → exit 2 `HARNESS: buyer.1 cannot sign in this cycle`; the
    fixture's `/__test/stats` shows no new `POST /login`.
  - "the run leaves a trace and no session": `r/out/traces/*.trace` exists; no process command holds
    `cliDaemon.js <run>-r-`; run.json `sessions` holds none of slot `r`.
- [ ] **Step 2–4:** run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `feat(sapu): argus-live repro runs a candidate's steps on a fresh instance — exit 0, a valid 3, or 2 for every harness failure`.

---

### Task 9: two of two, and the class and severity table

**Files:** Modify `plugins/sapu/scripts/argus-live-repro.mjs` (`repro`), `plugins/sapu/scripts/argus-live.mjs`
(`repro <ref>`, `classify`); Create `plugins/sapu/scripts/argus-live-classes.mjs`; Test
`tests/argus-live-findings.test.ts`.

Interfaces:
- `export async function repro(main, ref, {once = runOnce, …})` → `{code, lines}` per decision 9:
  each run's lines prefixed `run <i> `; the verdict last: `REPRODUCED …` (run 2's), `NOT REPRODUCED
  runs=<k>/<n>`, or `HARNESS: run <i>: <reason>`. `verdict.json` `{runs: [exit…], verdict:
  "reproduced"|"not-reproduced"|"intermittent"|"harness"}`.
- `export const CLASSES` — §10's table by oracle; `export function classify({oracle, money, stock,
  movedTwice, actedOn, rule, needsOwner = "argus:needs-owner"})` → `{cls, labels, severity, because}`;
  labels always end `argus`, `found-by:user`.
- CLI `classify --oracle <o> [--money] [--stock] [--moved-twice] [--acted-on] [--rule]` → one line
  `class <A|B(a)|heuristic> labels <l>,… severity <S1|S2|S3|at most S3|by outcome> because <words>`
  (the needs-owner label from the contract's `labels.needsOwner`).

- [ ] **Step 1: Failing tests:**
  describe "argus-live repro — two of two" (a stub `once` answering exits in turn):
  - `[3, 3]` → exit 3, last line run 2's `REPRODUCED …`; `[3, 0]` → exit 0 `NOT REPRODUCED runs=1/2`,
    `verdict: "intermittent"`; `[0]` → exit 0 `NOT REPRODUCED runs=0/1`, the stub called once; `[2]` →
    exit 2 `HARNESS: run 1: …`, called once; `[3, 2]` → exit 2.
  describe "argus-live classes":
  - one `it` per row of §10's table, e.g. `classify({oracle: "dead-end", money: true})` → `{cls: "A",
    labels: ["bug", "argus", "found-by:user"], severity: "S1"}`; `money: false` → S2; claim-race S1
    only with `movedTwice`; stale-view S1 with `money` or `stock`; status-coherence S2 with `actedOn`
    else S3; orphaned-work S3; interrupted-flow and viewport-locale `by outcome`; handoff with `rule` →
    `B(a)`, `class:business`, `workflow`, `at most S3`; without → `heuristic`, `ux`, `workflow`,
    `argus:needs-owner`; `CLASSES`' keys equal `ORACLES`.
- [ ] **Step 2–4:** run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `feat(sapu): argus-live repro files only at two of two, and classify gives a journey finding's class and starting severity`.

---

### Task 10: minimize

**Files:** Modify `plugins/sapu/scripts/argus-live-repro.mjs` (`minimize`), `plugins/sapu/scripts/argus-live.mjs`
(`repro <ref> --minimize`); Test `tests/argus-live-findings.test.ts` (stub `once`),
`tests/argus-live-repro.test.ts` (Chrome).

Interfaces:
- `export async function minimize(main, ref, {once = runOnce, max})` → `{code: 0, lines}`: decision
  10, each try a `runOnce` with the reduced `list`; writes `min.json` (the context element first) and
  `minimize.json` `{runs, max, stopped, from, to, confirmed, tried: [{label, exit}]}`; the last line
  `minimized <ref>: …`. No browser output is printed: only the `tried` labels (`role clerk`, `step 5`,
  `steps 4+5`) and exits.

- [ ] **Step 1: Failing tests:**
  findings file, describe "argus-live minimize": a stub `once` that answers 3 exactly when steps 2 and
  6 are absent → `min.json` lacks them, `stopped fixpoint`, `confirmed yes`; `max: 3` → `stopped
  budget`, two tries and the confirm run; a confirm run answering 0 → `confirmed no` and `min.json`
  not written; a trigger and the final never appear among the tried labels.
  repro file, describe "argus-live minimize in Chrome": the reversal repro padded with a `hover`, a
  `goto /stock` + `expect url /stock`, and a `read` nobody uses → `min.json` holds the original's
  essential steps only, exit 3 on its own `--once` run.
- [ ] **Step 2–4:** run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `feat(sapu): argus-live repro --minimize drops one role or step at a time, never a trigger, and confirms what it kept`.

---

### Task 11: the generated Playwright test

**Files:** Create `plugins/sapu/scripts/argus-live-redtest.mjs`, `tests/fixtures/argus-red/order-to-cash.handoff.spec.ts`;
Modify `plugins/sapu/scripts/argus-live.mjs` (`repro <ref> --test`); Test `tests/argus-live-findings.test.ts`.

Interfaces:
- `export function redTest({journey, oracle, ref, context, steps, settleMs})` → TypeScript text for
  `@playwright/test`: a header comment (`Generated by argus-live.mjs repro <ref> --test … RED until the
  defect is fixed. Wire signedIn, trigger, fact and mail to this repo's E2E helpers.`); `const SETTLE`;
  `const marker = \`argus-${Date.now().toString(36)}\``; stub helpers `signedIn(browser, account,
  context)`, `trigger(name, values)`, `fact(marker, field)`, `mail()` that throw `wire <name> to this
  repo's E2E helpers`; one `test("<journey>: <oracle> (<ref>)", async ({ browser }) => {…})` with one
  page per account (`const customer1 = await signedIn(browser, "customer.1", CONTEXT)`), each action as
  Playwright calls on `targetCode(target, <page variable>)`, `read`+`save` as `const <name> = (await
  …innerText()).trim()` (or `inputValue()`), expectations as `expect(…).toBeVisible|toBeHidden|
  toBeEnabled|toHaveText|toContainText|toHaveValue|toHaveCount|toHaveURL({ timeout: SETTLE })`,
  `fact-equals` and `mail` as `expect.poll`, `no-error` through a per-page error collector the test
  sets up, `parallel` as `await Promise.all([...])`. Every string is `JSON.stringify`'d; `{{name}}`
  becomes the variable.
- `repro <ref> --test` writes `red.spec.ts` (0600) from `min.json` when confirmed, else `repro.json`,
  and prints `red test: <absolute path>`.

- [ ] **Step 1: Failing tests** (describe "argus-live generated RED test"):
  - "the §10 example matches the golden file": `redTest` of the spec's list with `journey:
    "order-to-cash"`, `ref: "1.1.1"` → equals `tests/fixtures/argus-red/order-to-cash.handoff.spec.ts`
    byte for byte (the golden file is written from the first run and reviewed by hand before commit).
  - "the test is valid TypeScript": `stripTypeScriptTypes` does not throw and `node --check` passes on
    the result, for the golden case and for a list holding a `parallel` group, a `no-error`, a `mail`
    expectation and a context `{viewport: 390, locale: "de-DE"}`.
  - "strings never become code": a value `` `${process.exit()}` `` and a name `"); x("` appear only as
    JSON string literals (the stripped file's AST via `node --check` succeeds and the text contains the
    `JSON.stringify` form).
- [ ] **Step 2–4:** run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `feat(sapu): argus-live repro --test writes the Playwright test a sapu worker uses as its RED test`.

---

### Task 12: scrub — secrets, redaction, defanging

**Files:** Create `plugins/sapu/scripts/argus-live-scrub.mjs`; Modify `plugins/sapu/scripts/argus-live.mjs`
(`scrub`); Test `tests/argus-live-findings.test.ts`.

Interfaces:
- `export function scrubSecrets(main, {runId, env = process.env})` → `{"<class>:<label>": value}` for
  the classes `env file` (`loadLive(main).secrets` and `recordedSecrets`), `repo env file`
  (`ownerEnvFiles(main, loadContract(main))`), `role password`, `TOTP secret` (`.argus/live.json`
  roles, expanded), `cookie`, `header`, `storage` (`readLedger`; null → the refusal of decision 14),
  `environment variable <NAME>` (names matching `/TOKEN|SECRET|KEY|PASSWORD/i`).
- `export function redactIds(text, seen)` → `{text, count}` (decision 17).
- `export function defang(md)` → `{text, defanged, cut}` (decision 17; fences per CommonMark: an
  opening run of 3+ backticks or tildes, closed by the same character at least as long).
- `export async function scrub(main, {title, bodyFile, attach = [], create = false, labels = [],
  comment = null}, {env, gh = "gh", runner})` → `{code, out}`. This task: the run (the lock's, else the
  newest run directory), `secretHits` on the title and the body as given → `refused: scrub: the
  <title|body> holds a secret (<class>[, <class>…])` (exit 1, the file untouched, nothing else printed);
  then `redactIds` and `defang` on both, the body file rewritten in place, `scrub: ok; redacted <n>,
  defanged <n>, cut <n> line(s)` and `title: <the scrubbed title>` (exit 0).
- CLI `scrub --title <t> --body <file> [--attach <png>…] [--create [--label <l>…] | --comment <n>]`.

- [ ] **Step 1: Failing tests** (describe "argus-live scrub"; a `liveRun()` with a ledger written by
  `appendLedger`, an env file, a repo `.env`, roles with a password and a TOTP secret, `env:
  {GH_TOKEN: "ghp_scrubtest123456"}`):
  - "each secret class is refused, raw, URL-encoded, base64-encoded and split by spaces, in the title
    and in the body": 8 classes × 4 forms × 2 places, each → exit 1 with its class named, the body file
    byte for byte as before.
  - "a cuid or ULID the run saw stays; an unknown long token is redacted": seen holds
    `ck9a8b7c6d5e4f3g2h1i0j9k8` and `01HZX3J4K5M6N7P8Q9R0S1T2V3`; the body holds both,
    `sk_live_… (a fake 30-character key)`, a 40-hex sha and `abcdefghijklmnopqrstuvwxyzabcd` → only the
    `sk_live_…` is `<redacted>`, count 1.
  - "mentions, references and outside links are defanged outside code": `@octocat`, `#12`,
    `owner/repo#3`, `https://evil.example/x` → backticked; `http://localhost:3000/x` and
    `http://127.0.0.1:9/x` kept; `` `@x` `` and a ```` ```ts ```` block of 40 lines untouched; a
    ```` ```text ```` block of 25 lines → 20 lines and `… 5 lines cut`; a line ```` ``` ```` inside a
    ```` ~~~text ```` block does not close it.
  - "scrub needs the run's ledger": no `secrets.jsonl` → exit 1 with decision 14's wording.
- [ ] **Step 2–4:** run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `feat(sapu): argus-live scrub refuses any secret the run saw in any encoding, redacts unknown long tokens and defangs page text`.

---

### Task 13: screenshot verdicts, attachments, filing through gh

**Files:** Modify `plugins/sapu/scripts/argus-live-login.mjs` (stage `shot`), `plugins/sapu/scripts/argus-live-pw.mjs`
(`screenshot` writes the verdict), `plugins/sapu/scripts/argus-live-scrub.mjs` (`attachVerdict`, gh),
`tests/helpers/argus-live.ts` (`fakeGh()`); Test `tests/argus-live-repro.test.ts`,
`tests/argus-live-findings.test.ts`.

Interfaces:
- Stage `shot` → `{text: <body innerText, then every input/textarea/select value, one per line>,
  password: <a visible password input>, otp: <a visible one-time-code input>, error: <status ≥ 400 or
  a chrome-error: URL>}`.
- After a `screenshot` the CLI ran, `pw` runs `shot` and writes `<out>/<name>.verdict.json` (0600)
  `{t, passed, reasons}` (decision 18; `secret` from `secretHits(text, scrubSecrets(main, {runId}))`;
  a gone ledger counts as `secret`). `pw`'s output is unchanged.
- `export function attachVerdict(main, runId, file, {ghVersion, visibility, traces})` → `{attach:
  true}` or `{attach: false, reason}` (`gh older than 2.99`, `public repository`, `traces none`, `not a
  screenshot of this run`, `no verdict recorded`, `a secret on the page`, `a password field`, `a
  one-time-code field`, `an error page`).
- `scrub` gains: `attach: <name>` / `local: <name> (<reason>)` lines, the `Local evidence: <paths from
  MAIN>` line appended to the body; with `--create`: `gh issue create --title <scrubbed> --body-file
  <file> [--label <l>]… [--attach <png>]…`; with `--comment <n>`: `gh issue comment <n> --body-file
  <file> [--attach <png>]…`; stdout's first `https?://\S+/issues/\d+(#issuecomment-\d+)?` → `filed:
  <url>` / `commented: <url>` (exit 0, whatever gh's exit); none → `failed: gh issue create exited <k>
  before printing an issue URL` (exit 2). gh's version from `gh --version`, the visibility from `gh repo
  view --json visibility --jq .visibility`, `traces` from `resolvePolicy(loadContract(main))`.

- [ ] **Step 1: Failing tests.**
  repro file, describe "argus-live screenshot verdicts": `pw … goto /inject?echo=1` then `screenshot`
  → its verdict `{passed: false, reasons: ["secret"]}`; `anon goto /login` + `screenshot` →
  `password-field`; `goto /orders/new` + `screenshot` → `passed: true`; no verdict file holds
  `Quantity` or exceeds 200 bytes.
  findings file, describe "argus-live scrub — attachments and filing" (`fakeGh()`: a script on a
  given path recording argv and answering `--version`, `repo view` and `issue create|comment` as the
  test sets):
  - "a screenshot is attached only when every condition holds": one `it` per reason above → `local:`
    with that reason and the body's `Local evidence:` line; all conditions → `attach:` and gh saw
    `--attach <abs path>`.
  - "a non-zero gh exit after the URL counts as filed": gh prints the URL and exits 1 → exit 0
    `filed: https://github.com/o/r/issues/9`; gh prints nothing and exits 1 → exit 2.
  - "the needs-owner label goes through create": `--label argus:needs-owner` reaches gh's argv as
    `--label argus:needs-owner`.
  - "a refused scrub runs no gh".
- [ ] **Step 2–4:** run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `feat(sapu): argus-live screenshot verdicts at capture time; scrub attaches only what passed and files through gh, counting a printed URL as filed`.

---

### Task 14: `map-check`, refresh triggers, the catalog

**Files:** Create `plugins/sapu/scripts/argus-live-map.mjs`; Modify `plugins/sapu/scripts/argus-live.mjs`
(`map-check [--list]`); Test `tests/argus-live-findings.test.ts`.

Interfaces:
- `export const JOURNEYS_FILE = ".argus/journeys.json"`; `export function readJourneys(main)` →
  the object or null; malformed → `refused: .argus/journeys.json is not a journey map`.
- `export function mapCheck(main, {runner = run})` → `{kept, dropped: [{id, reason}], rolesUnchecked,
  newDrops}`; the file rewritten (decision 21); reasons: `step <i>: anchor <j> has fewer than 16
  non-space characters`, `step <i>: anchor <j> is not in <file> at HEAD`, `step <i>: anchor <j> occurs
  <k> times in <file> (at most 3)`, `step <i>: no route`, `step <i>: role <r> is not in live.roles`,
  `step <i>: no anchor in a route or permission file under roots names <segment>`, `step <i>: trigger
  <t> is not in live.triggers`, `step <i>: no anchor under roots`, `duplicate id`, `id is not
  kebab-case`.
- `export function refreshReasons(main, {newDrops, runner})` → `[]` or reasons: `no map`, `roots
  changed: <k> file(s) added, deleted or renamed`, `a momus report is newer than the map`, `the map's
  head is no longer in the history`, `new drops: <id>,…`.
- `export function catalog(main)` → lines: per domain `<domain>:`, per journey `  <id> — <title> —
  <role> → <role> …[ money][ global] — last cycle <n|never>, filed <k>`, then `dropped:` and
  `  <id>: <reason>`.
- CLI `map-check` → `dropped <id>: <reason>` lines, `catalog: <n> journeys, <k> dropped[, roles
  unchecked]`, `refresh: <reason>; …` or `refresh: none`; exit 1 `refused: no journey is selectable`
  when none is kept. `map-check --list` prints `catalog(main)` after the check. Neither takes the lock
  or starts anything.

- [ ] **Step 1: Failing tests** (describe "argus-live map-check"; a `committed()` repo with
  `src/routes/orders.js` (`router.post("/orders/new", requireRole("buyer"), createOrder);` on line 5),
  `src/jobs/settle.js`, `.argus/live.json` roles `buyer`, `clerk`, trigger `settle`):
  - one `it` per drop reason (a short anchor, a missing anchor, an anchor occurring four times, a user
    step with no route, a route segment matching no anchor, a `system` step with an unknown trigger, an
    unknown role, a duplicate id) → that journey dropped with that exact reason, a valid journey kept.
  - "line moves to the nearest occurrence": recorded `line: 3`, the text on line 5 → `line: 5` in the
    rewritten file.
  - "without .argus/live.json roles are unchecked": `catalog: 1 journeys, 0 dropped, roles unchecked`.
  - "refresh triggers": a file added under `src/routes` and committed → `roots changed: 1 file(s) …`;
    deleted; renamed; only modified → `refresh: none`; `.momus/report-x.md` touched after `head`'s
    commit → its reason; `head` set to an unknown sha → its reason; a new drop → `new drops: <id>`;
    the same drop again at the same head → `refresh: none`.
  - "map-check starts nothing": no `.argus/live/lock.json` appears; the runner saw only `git`.
  - "the catalog groups by domain and lists the drops".
- [ ] **Step 2–4:** run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `feat(sapu): argus-live map-check keeps only journeys anchored in HEAD's code, names its refresh triggers and prints the catalog`.

---

### Task 15: map mode — `up --map`, map slots, the map return

**Files:** Modify `-map.mjs` (`validateMap`, `mergeMap`), `-slots.mjs` (`mintMapSlot`; `tokenSlot`
returns the slot's `mode`), `-pw.mjs` (a map token's two commands), `-return.mjs` (`submit` and `intake`
of a map return), `-instance.mjs` (`upMap`; `upFresh`/`renewRun` refuse a map run; `status`), `argus-live.mjs`
(`up --map`, `slot <n> --map`, `map-check --merge <slot>`); Test `tests/argus-live-findings.test.ts`.

Interfaces:
- `export function validateMap(obj)` → `{value, errors}`: `{roots: [≤ 100 repo-relative paths, no
  `..`], journeys: [≤ 100 {id kebab-case, domain ≤ 60, title ≤ 120, money: boolean, global: boolean,
  goal ≤ 500, steps: [≤ 40 {role (ROLE_NAME, anon or system), route? (starts `/`, ≤ 200), trigger?,
  goal ≤ 500, claim?: boolean, sources: [1–10 {file repo-relative, line ≥ 1, text 16–500}]}]}], notes?}`;
  unknown keys are errors.
- `export function mergeMap(prev, value, {head})` → the new map: `head`; `roots` replaced; a journey
  of a known id gets the returned `domain`, `title`, `money`, `global`, `goal`, `steps` and keeps
  `lastCycle`, `lastHead`, `filed`; a new id is appended; every other journey and `dropped` kept.
- `export async function upMap(main, {runner, say})` → the summary `{runId, mode: "map", deadline,
  worktree}`: `up` step 1 (lock, `sapu-live.log` start line, reaper), step 4's worktree without
  setup, run.json `{runId, mode: "map", worktree, instanceId: null, groups: [], …}`; `up --fresh` and
  `renew` on it → `refused: cycle <run> is a map run (up --map); run down`.
- `export async function mintMapSlot(main, {slot})` → `{slot, token, generation: 1, mode: "map"}`:
  refused without a lock, past the deadline, when sealed, or when run.json has no worktree yet; run.json
  `slots[<n>] = {mode: "map", journey: null, generation, tokenHash, accounts: {}, retired: [],
  submitted: false}`; the slot directory holds `state.json` only.
- `pw` with a map token: `code` and `submit` only, also without an instance id (`refused: a map slot
  takes only code and submit` for anything else); budget and deadline as for an explorer.
- `submit` of a map slot validates with `validateMap` and prints `submitted: slot <n> generation <g>
  map journeys <k>`; `intake <n>` of a map return prints `slot <n> generation <g> map journeys <k>
  roots <k>`, then the fenced return.
- `map-check --merge <slot>` reads the newest generation of that map slot's return (the lock's run,
  else the newest run directory), validates it again, writes `mergeMap(readJourneys(main), …, {head:
  <MAIN's HEAD>})`, then runs `map-check`.
- `status` prints `mode: map` for a map run; `status --json` adds `mode` (`"map"` or `"live"`).

- [ ] **Step 1: Failing tests** (describe "argus-live map mode"):
  - "up --map takes the lock and a worktree and starts nothing": exit 0, the summary line with `mode:
    "map"`; run.json `groups: []`, no HOME directory, no proxy; `status --json` → `mode: "map"`;
    `down` → no worktree, `sapu-live.log` balanced.
  - "a map slot reads code and submits a map, nothing else": `slot 1 --map` → a token; `pw <t> code
    files src` → a fenced listing; `pw <t> buyer goto /` → `refused: a map slot takes only code and
    submit`; `pw <t> submit <valid map>` → `submitted: slot 1 generation 1 map journeys 1`; a map with
    an unknown key → `refused: return: …`, the token still live.
  - "a map slot can be minted while up is still starting": run.json with a worktree and no instance id
    → `mintMapSlot` succeeds; `mintSlot` (an explorer's) is refused there.
  - "map-check --merge keeps ids, lastCycle and the journeys the map did not return".
  - "up --fresh and renew refuse a map run".
  - "the guard lets the map agent Read committed files of a map run's worktree" (`tests/sapu-guard.test.ts`:
    run.json of a map run; the existing Read rule, unchanged, allows a committed file and refuses an
    untracked one).
- [ ] **Step 2–4:** run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `feat(sapu): argus-live map mode — up --map starts no app, a map token reads code and submits the map, map-check --merge writes it`.

---

### Task 16: SELECT — score and accounts

**Files:** Modify `plugins/sapu/scripts/argus-live-map.mjs` (`score`, `selectJourneys`),
`plugins/sapu/scripts/argus-live.mjs` (`select`); Test `tests/argus-live-findings.test.ts`.

Interfaces:
- `export function score(j, {cycle, flagged, commits})` → `(cycle − (j.lastCycle ?? 0)) × (j.money ?
  2 : 1) × (flagged.includes(j.id) ? 2 : 1) × (1 + commits)`, with `cycles_since_visit` at least 1.
- `export function selectJourneys(main, {cycle, flagged = [], ids = null, runner})` → `{picks: [{id,
  score, accounts}], waits: [{id, score, why}], displaced: [{id, score}]}`: ranked by score, then id;
  the first pick global → it alone; otherwise up to `limits.max_parallel_journeys` non-global ones;
  accounts per decision 22 (first pass one account per role the journey's steps name — `anon.1` with
  no user, a login-command role's `.1` once per cycle — second pass a second account for a role a
  `claim: true` step names, when one is free); `ids` (explicit) taken in their order, the score's picks
  they displaced listed. `why`: `global journey selected alone`, `a global journey waits for a cycle of
  its own`, `no free account for <role>`, `limit <max> reached`.
- CLI `select --cycle <n> [--flagged <id>,…] [--ids <id>,…]` → `select <id> score <s> accounts
  <role>.<k>=<user>|<role>.<k>,…` (the list `slot --accounts` takes), `wait <id> score <s> (<why>)`,
  `displaced <id> score <s>`; exit 1 `refused: no journey is selectable` with no pick; a user holding
  `${` → `refused: roles.<r>.users[<i>].user must be written literally for select`.

- [ ] **Step 1: Failing tests** (describe "argus-live select"):
  - "the score": cycle 100; `a` money, `lastCycle` 90, 2 commits to its anchors since `lastHead` → 60;
    `b` never visited → 100; `--flagged a` → 120.
  - "a global journey is selected alone, or waits".
  - "no account serves two journeys; a journey waits when its accounts cannot be allocated": `buyer`
    (2 users), `clerk` (1 user); journeys `x` and `y` each need `buyer` and `clerk` → `x` picked, `y`
    waits `no free account for clerk`.
  - "a claim step gets a second account when one is free".
  - "a login-command role serves one journey a cycle".
  - "explicit ids print what they displaced".
- [ ] **Step 2–4:** run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `feat(sapu): argus-live select ranks journeys by the map's score and allocates accounts no two journeys share`.

---

### Task 17: doc drift

**Files:** Create `plugins/sapu/scripts/argus-live-drift.mjs`; Modify `plugins/sapu/scripts/argus-live.mjs`
(`drift`); Test `tests/argus-live-findings.test.ts`.

Interfaces:
- `export function drift(main, {doc, code}, {runner = run})` → `{verdict: "code-newer"|"doc-newer"|
  "undecidable", why?}`: `git blame --porcelain -L <a>,<b> -- <file>` per range; the newest
  `committer-time` of the doc's lines against the newest of all code ranges'; a line not committed
  (`0000000…`), a file with no history or a git failure → `undecidable` (`uncommitted lines`, `no
  history`), equal times → `undecidable (same time)`. Ranges `<repo-relative file>:<a>-<b>`, no `..`.
- CLI `drift --doc <range> --code <range> [--code <range>…]` → `code-newer → needs-owner`,
  `doc-newer → class B(a)` or `undecidable (<why>) → needs-owner`.

- [ ] **Step 1: Failing tests** (describe "argus-live doc drift"; a repo whose commits carry
  `GIT_COMMITTER_DATE`): doc 2026-01-01, code 2026-03-01 → `code-newer`; reversed → `doc-newer`; the doc
  range edited and not committed → `undecidable (uncommitted lines)`; both in one commit → `undecidable
  (same time)`; a range with `..` → refused.
- [ ] **Step 2–4:** run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `feat(sapu): argus-live drift decides doc drift by line-level history`.

---

### Task 18: the CLI, the guard seam, one cycle end to end

**Files:** Modify `plugins/sapu/scripts/argus-live.mjs` (header comment and usage line: every command of
this phase); Test `tests/argus-live-pw.test.ts` (guard seam), `tests/argus-live-repro.test.ts`.

- [ ] **Step 1: Failing tests.**
  `tests/argus-live-pw.test.ts`, describe "argus-live up — the browser refusals and the guard seam"
  gains: `checkExplorerBash` refuses `node <WRAPPER> repro 1.1.1`, `… repro 1.1.1 --minimize`, `…
  scrub --title x --body /tmp/b`, `… map-check`, `… map-check --merge 1`, `… select --cycle 1`, `…
  classify --oracle dead-end`, `… drift --doc a:1-2 --code b:1-2`, `… up --map`, `… slot 1 --map`.
  `tests/argus-live-repro.test.ts`, describe "argus-live — findings end to end" (spawned CLI only):
  - "a candidate goes from an explorer's submit to a filed issue, and down leaves no secret": `appCycle()`
    with `double-release` on; `slot 1 --journey order-to-cash --accounts buyer.1=buyer1@example.test`;
    through spawned `pw`: `goto /storage`, `goto /orders/new`, place an order, `screenshot`, `submit` a
    return whose candidate holds the reversal repro; `repro 1.1.1` → exit 3, `run 1` and `run 2` lines,
    last line `REPRODUCED …`; `repro 1.1.1 --minimize` → `confirmed yes`; `repro 1.1.1 --test` → the
    file passes `stripTypeScriptTypes`; a body quoting the session's HttpOnly `sid` → `scrub` exit 1
    `(cookie)`; a clean body with the screenshot → `scrub … --create --label bug` through `fakeGh()` →
    `filed: …`, gh's argv holds `--attach`; `down` → no `secrets.jsonl`, no `.playwright/`,
    `state.json` or `lock` in any slot, `repro/1.1.1/` kept, no process whose command holds the run id;
    neither any stdout nor any file left under `.argus/live/<run>/` (traces aside) holds `APP_PW`'s
    value or the token.
- [ ] **Step 2–4:** run (FAIL), implement, run both files and `npx vitest run` (PASS).
- [ ] **Step 5: Commit** `feat(sapu): argus-live repro, scrub, map-check, select, classify and drift on the CLI, kept from the explorer by the guard`.

---

### Task 19: whole suite, phase-end team review, docs

- [ ] `npx vitest run` → PASS, every file (browser tests on the release machine's Chrome; none skipped).
- [ ] Phase-end review (owner's rule): `senior-dev-team:senior-qa-reviewer` and
  `senior-dev-team:senior-software-architect` read `git diff <phase 4 base>..HEAD` against this plan
  and spec §5, §6, §10, §12 and §14; the architect re-checks phase 3's carry-forward (the ledger, the
  driver shared, run.json key ownership, slot `r` in `slotDir`/`upFresh`, `status --json` enough for
  phase 5); findings fixed by the developer, re-reviewed, suite green.
- [ ] **Docs and diagrams check** (owner's rule: every behaviour change updates its docs and generated
  diagrams). `git grep -n -e argus-live -e journey -e ui-explorer -- README.md docs plugins/sapu/CONTRACT.md
  plugins/sapu/README.md docs/img/src` and read every hit against this phase's changes; update what
  phase 4 changed (expected: `plugins/sapu/CONTRACT.md`'s `sapu:ui-explorer` paragraph when it names
  only explorer runs — the map agent reads a map run's worktree under the same rule; the roadmap's row
  4). A diagram whose source under `docs/img/src/diagrams/` changes is rebuilt with `node
  docs/img/src/build.mjs <name>` and its light and dark SVGs committed. The user-facing journey docs and
  the lane's diagram are phase 5's; list in the as-built notes every phase-4 fact they must carry.
- [ ] Append "As built" sections to this plan for every interface that changed in implementation, fold
  the spec edits above (as built) into the spec, and commit `docs(sapu): argus journey lane phase 4 —
  as-built notes and the spec it settled`.

---

## Carried to Phase 5

- `journeys.md` must state decision 7's `final` templates, decision 9's verdicts (`NOT REPRODUCED
  runs=1/2` is the intermittent journal entry), the order `repro` → `--minimize` → `--test` → `classify`
  → `scrub --create`, `renew` before each `repro`, and PERSIST's writes of `lastCycle`, `lastHead`,
  `filed`.
- The explorer brief: repro lists use the five target kinds and `{{marker}}`; screenshots only as
  evidence (their verdict decides attachment).
- The map brief: map mode's two commands, `claim: true`, the return schema of `validateMap`.

---

## Self-review

- **Spec §10 coverage:**
  - repro format as data (T7: `parseRepro`); steps and `as`/`<role>.<n>` (T7, T8); the action list
    (T7 grammar, T8 run); `parallel` behind one barrier (T7, T8: `P.at`, probed skew ≤ 2 ms); targets
    with `nth` and `within` (T7); the expectation list, each waited up to `settle_ms` (T7, T8, decision
    11); `context` defaulting to `live` (T7, T8: slot `r`'s config per run);
  - literals only — `{{marker}}`, `{{<saved>}}` (T7 `substitute`, T8 test with quotes); the runner
    builds every command and locator and runs through the wrapper's paths — proxy, validation,
    sessions `<run>-r-<role>.<k>` (T2 driver, T5 slot `r`, T8);
  - every state-changing step proven, else exit 2 (T7 static, T8 dynamic, decision 6);
  - `final` from its oracle's template (T7 `FINAL_KINDS`, decision 7);
  - exit codes 0, 3 with `REPRODUCED step=… expected=… observed=…`, everything else a harness failure,
    an uncaught error mapped to 2, a failed login, a missing target (T8, decision 8);
  - reproduce: after every explorer returned (phase 5's order), each candidate from `up --fresh`,
    twice, filed only at 2 of 2, 1 of 2 intermittent, a CLI trace kept (T8, T9, decisions 9, 13);
  - minimize: one step or role at a time from `up --fresh`, a state-changing step with its `expect`,
    never a `trigger` or a role's only state-changing step, kept only on exit 3 with every remaining
    `expect`, at most `limits.minimize_runs`, where it stopped journalled, no browser work in the
    orchestrator's context (T7 `reductions`, T10);
  - classes and severity from the oracle (T9 `classify`); argus's adjustments, `Reachable-by`,
    `Automatable`, `Max <currency>`, `Blocked work:`, heuristic grounding, Nielsen's factors — the
    orchestrator's text (phase 5);
  - needs-owner: the label (phase 1); filing with it through `scrub --create --label` (T13);
  - scrub refuses each secret class — env_file, repo env files, role passwords and TOTP secrets,
    cookies and `Authorization`/`Set-Cookie`/`*-Token` values the run saw, storage values, orchestrator
    variables — raw, URL-encoded, base64 and with whitespace and punctuation removed (T4 ledger and
    matcher, T12); redacts other 24+ letter-and-digit strings unless the run saw them as a URL path
    segment or a response-body value (T3 ids, T4 `seen`, T12); page text in fenced blocks of at most
    20 lines, mentions, `#N` and outside URLs defanged (T12);
  - screenshots attached only with gh ≥ 2.99, a private or internal repo, `traces` allowing it, and at
    capture time a secret-free page and inputs, no password or one-time-code field, no error page;
    otherwise named locally (T13); a non-zero gh exit after the URL counts as filed (T13);
  - issue body additions: the generated Playwright test (T11); the trail, numbers and repro steps are
    the orchestrator's (phase 5), the files they come from are T8's records;
  - one defect per issue and `max_issues_per_cycle`: argus's gates, unchanged (phase 5's text).
- **Spec §6 coverage:** `map-check`'s every rule and its printed reasons (T14); refresh triggers and no
  second refresh for a recorded drop (T14); ids stable across a refresh (T15 `mergeMap`); `global`
  selected alone, the score, account allocation and waiting (T16); the catalog (T14); the map built by
  the explorer in map mode through `submit` (T15).
- **Spec §14 coverage:** "Repro" — each seeded defect 3 and its fix 0 with the class row (T8, T9), the
  claim race through `parallel` with two accounts (T8), viewport at 390 not 1440 (T8), the delayed
  handoff (T8), exit 2 on a broken target, a dropped prerequisite, a missing proving `expect` and an
  uncaught error (T8), a run's records absent from the next (T8), quoted values as literals (T8),
  minimize never dropping a `trigger` and keeping only exit-3 reductions (T7, T10), 2 of 2 (T9), the
  golden test (T11). "Scrub" — each class in each encoding in title and body (T12), the HttpOnly cookie
  (T18), cuid/ULID kept and unknown tokens redacted (T12), defanging (T12), screenshots not attached
  for a public repo, an older gh, a password field or an error page (T13), the URL rule (T13).
  "`map-check`" — every listed case, the refresh triggers, stable ids, `global`, allocation, `list`
  starting nothing (T14–T16). "Doc drift" — code newer, doc newer, no history, and the needs-owner label
  on the issue (T17, T13's label pass-through).
- **Carried from phase 3:** the ledger (T4), the driver (T2), slot `r` (T5), `-origin.mjs` (T1),
  `loginFailed` for repro (decision 4, T8), the instance split (T1), the in-daemon listener probed and
  built (T3).
- **Names defined once:** `exactHost`, `canonicalOrigin`, `originOf`, `BLOCKED_ERROR`, `checkUrl`,
  `sessionDriver`, `maskSecrets`, `configuredUser`, `MIN_SECRET`, `ledgerFile`, `ledgerEntries`,
  `appendLedger`, `readLedger`, `seenFile`, `appendSeen`, `readSeen`, `secretHits`, `FINAL_KINDS`,
  `parseRepro`, `substitute`, `stepCode`, `reductions`, `reproRef`, `runOnce`, `repro`, `minimize`,
  `redTest`, `CLASSES`, `classify`, `scrubSecrets`, `redactIds`, `defang`, `attachVerdict`, `scrub`,
  `JOURNEYS_FILE`, `readJourneys`, `validateMap`, `mapCheck`, `refreshReasons`, `catalog`, `mergeMap`,
  `score`, `selectJourneys`, `upMap`, `mintMapSlot`, `drift`.
- **Interfaces shared with earlier phases:** run.json is still written only through `updateRun`, each
  key by its owner (`mode` by `up --map`; `slots` by the slot writers); the guard's explorer rules are
  unchanged and its seam test grows (T18); `pw`'s output is unchanged byte for byte (T2).
