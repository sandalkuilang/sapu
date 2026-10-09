# Argus journey lane — Phase 4: Findings — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a candidate becomes a finding only through scripts. `argus-live.mjs repro` replays a
candidate's repro steps — data, never code — on a freshly reset instance, twice, and answers
reproduced, not reproduced or harness failure by exit code; `--minimize` shrinks a reproduced list one
step or role at a time; `--test` writes the Playwright test a sapu worker uses as its RED test.
`scrub` refuses an issue that carries any secret the run saw, in any encoding — naming where, never
what — redacts unknown long tokens, defangs mentions, references and outside links, decides which
screenshots may be attached, and files through `gh`, also after `down`. `map-check` keeps only journeys whose every step is anchored in HEAD's code,
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

**Revision (after the QA review of 9e46024: not approved, no Critical).** Tasks 1, 2 and 5
were cleared to start before this revision; their text is unchanged by it (where a later task needs
more of them — the driver's drain, `upFresh`'s drain — that later task adds it). The owner's decisions
on the review are folded in: scrub refuses only what is secret-like and says where, never what
(decisions 14, 17); short configuration secrets are matched as whole tokens (decision 17); the ledger
loses nothing silently, lives under `logs/`, survives `down` and is removed by the next `up` (decision
14); traces start after sign-in, are never filed and are pruned by `down` (decision 13); the seen-id
exemption is narrower (decision 15); the `login` step has a shape (decision 26); the tests the review
found wrong are fixed (Tasks 8, 10, 11). The core path's end-to-end task moved ahead of the map work:
it is now Task 14, and `map-check`, map mode, SELECT and doc drift follow as Tasks 15–18.

---

## Verified against @playwright/cli 0.1.22, Chrome and gh 2.102.0

Probed live (macOS, Google Chrome, the pinned CLI from
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
   (`repro.json`, `run-<i>.json` — `{exit, step, expected, observed, ms, saved, traces}`, `saved` the
   values `save` produced (masked as `pw` masks), `traces` the trace files the run wrote —,
   `steps-<i>.jsonl`, `min.json`, `minimize.json`, `red.spec.ts`), kept by `down`; the teardown's
   slot-file pass skips `repro/` like `logs/` and `returns/`.
3. **Repro sessions** live in slot `r` (`.argus/live/<run>/r/`), named `<run>-r-<role>.<k>`
   (`sessionName(runId, "r", account)`). The accounts are the candidate's slot allocation (run.json
   `slots[<slot>].accounts`). Slot `r`'s CLI config is written at the start of every run with the
   repro's context (`slotConfig` with `locale`, `timezone` and `viewports: [viewport]` overridden).
   The runner closes its sessions at the end of every run; `up --fresh` closes (after draining it,
   decision 14) every session whose slot is not `up`; `putSession`'s instance-id rule covers every slot but `up`.
4. **`loginFailed` and repro.** An account in run.json `loginFailed` (the explore phase's, or an
   earlier repro's) makes the run exit 2 at once with `HARNESS: <role>.<k> cannot sign in this cycle`,
   no browser opened for it. A repro's own failed sign-in of a configured account is recorded there
   too (`login`'s default `runFailures`), so it blocks every later repro of the cycle: never retried
   (lockout). A `login` step's failure (an account the journey created, decision 26) is not: it goes to
   slot `r`'s state.json `createdFailed`, as `pw` keeps an explorer's, and ends that run with exit 2.
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
   viewport-locale → `visible` or `enabled`. (The spec gives no template for unreachable-step.) In the
   claim-race template each account of the `parallel` group proves its action with `visible` on a
   target with `nth: 0` (one row or two may match, and a bare target fails strict mode on two).
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
    run's origins and `allow_origins` never count, nor does any `Failed to load resource: the server
    responded with a status of <k>` console line (a 4xx is the app answering; a 5xx counts once, from the
    response listener).
12. **Placeholders.** `read` saves an element's value (`inputValue` of an input, textarea or select,
    else its trimmed `innerText`, at most 500 characters) under `save` (`^[a-z][a-z0-9_]{0,31}$`, not
    `marker`); `{{marker}}` is `argus-<8 hex>`, fresh per run; a `{{name}}` used before its `read` is a
    static error. Substitution is textual in string fields only, the result a literal. The values `save`
    produced are recorded in `run-<i>.json` `saved` (decision 2).
13. **Traces.** A repro account's `tracing-start` runs only after its sign-in (right after its open for
    `anon` and for an account whose first step is a `login`); a `login` step stops the account's trace
    before it and starts a new one after it, so no trace holds a password typed into a form or a
    sign-in's request. `tracing-stop` runs before the close. The files stay in `r/out/traces/` (the
    slot's 0700 directory) and are named in `run-<i>.json` `traces`. They still hold the session's
    cookies and requests, so they are never attached to an issue (`attachVerdict` refuses any file
    under a `traces/` directory) and never filed. `down` deletes every trace file but those a run that
    exited 2 names (`pruneTraces`): a run that exited 0 or 3 needs no diagnosis, an H2 run keeps its
    traces under `r/out/traces/`, local only.
14. **The secret ledger** is `.argus/live/<run>/logs/secrets.jsonl` (0600), one `{"c": <class>, "v":
    <value>}` per line, appended by the session driver's drains. Classes: `cookie`, `header`, `storage`
    (the ledger classes, `LEDGER_CLASSES`), `created password` (a `login`'s password, from `pw` or a
    repro, decision 26) and the marker `incomplete`.
    - **What is recorded.** `Authorization` and `Proxy-Authorization` values whole and without their
      scheme word, `*-token` header values whole; a cookie (from `ctx.cookies()`, a `Cookie` header's
      pair, a `Set-Cookie` value before its first `;`) only when its name matches `SECRET_KEY`, it is
      flagged HttpOnly or Secure (the `Set-Cookie` attributes, or `ctx.cookies()` for that name), or its
      value is high-entropy; a storage item only when its key matches `SECRET_KEY` or its value is
      high-entropy — a value that parses as a JSON object or array is never taken whole, each string
      leaf goes through the same rule under its own key. `SECRET_KEY` =
      `/password|passwd|secret|token|auth|session|sid|jwt|bearer|api[-_]?key|credential|sig|cookie/i`;
      high-entropy (`highEntropy`) = at least 16 characters, at least 3 of lower case, upper case, digit
      and other, no whitespace. Every value is cut to its first `MAX_SECRET` (4096) characters (a prefix
      still finds its own leak). A ledger-class value shorter than `MIN_SECRET` (6) is not recorded (it
      would refuse every issue; `pw`'s fence still masks it); the floor is the ledger classes' only
      (decision 17).
    - **Nothing lost silently.** The hook dedupes in the daemon with a `Set` of every value it recorded
      (no count cap that drops values); past a byte cap (`capBytes`, 4 MiB of distinct values per
      context) it records nothing more and sets `overflow`, and the drain that reads it appends
      `{"c": "incomplete", "v": "<session> passed <cap> bytes"}`. Each `pw` call and each repro step ends
      with a drain (the `observe` stage, or the step template's own) and sets the account's state
      `drained: true` (`false` while a command runs). `up --fresh` and `down` drain every session they
      close before closing it (`drainSessions`); a session found gone with `drained: false` appends
      `incomplete` (`<session> lost before its drain`); one gone between commands lost nothing.
    - **Lifecycle.** The ledger lives under `logs/`, which `down` keeps, so it survives `down` and
      `scrub` never needs the run live. The next `up`'s step 1 (`up --map`'s too) deletes every earlier
      run's `logs/secrets.jsonl` (`dropLedgers`). There is no `down --purge`, and none is added. A kept
      ledger holds the dead instance's session values, 0600 under the run's 0700 directory, until then.
    - **Scrub's reading.** `readLedger` → `{entries, incomplete}`; scrub refuses when the file is gone
      (`refused: scrub: the run's secret ledger is gone (a later up removed it); nothing from this run is
      filed`), when it holds an `incomplete` marker (`refused: scrub: the run's secret ledger is
      incomplete (<why>); nothing from this run is filed`) and on a line it cannot read (`refused:
      scrub: the run's secret ledger is damaged`).
15. **Ids the run saw** go to `logs/seen.jsonl` (kept): the path segments of the pages' requests to the
    run's origins and the JSON response leaves that are 24+ characters mixing letters and digits,
    filtered on the Node side (`seenIds`) from the raw `paths: [[previous segment, segment]]` and
    `leaves: [[key, value]]` the hook drains. Never a seen id: a leaf under a key matching `SEEN_SKIP_KEY`
    = `/token|secret|key|pass|session|auth|csrf|cookie|bearer|value|jwt|credential|sig|signature|code|otp|nonce/i`;
    a segment whose previous segment matches
    `/reset|verify|invite|magic|token|confirm|activate|unsubscribe/i` (`/password-reset/<x>`,
    `/verify-email/<x>`); a value starting `eyJ` (a JWT or other base64 JSON). Scrub leaves the seen ids
    readable; anything wrongly left out of them is only redacted.
16. **The in-daemon hook.** `hook`, a new stage of `loginCode`, runs once after every session open of
    an explorer or repro slot (not the proving logins): it installs, once per context (`ctx.__argus`),
    the request and response listeners (header values, 5xx, ids), `console`/`pageerror` listeners on
    every page, and a `domcontentloaded` listener on every page and popup that evaluates
    `SIGNAL_SCRIPT` again — so a `target=_blank` popup is watched from its first document (phase 3's
    known limit, spec §7, goes). Header values: a `Set` of every value recorded plus the values not yet
    drained, no count cap, `capBytes` per context (decision 14); errors 200 and raw ids 2000 per drain (a
    lost id costs one redaction, never a secret). `observe` and every step template drain them.
17. **Scrub's text rules.** Classes: the ledger's (`cookie`, `header`, `storage`), `created password`
    (the ledger's too), and the configuration secrets — `env file` (every value of `env_file`: the owner
    declared them secrets), `repo env file` and `environment variable <NAME>` (both only under a
    `SECRET_KEY` name or with a high-entropy value: those sources mix configuration with secrets),
    `role password` and `TOTP secret`. Empty values are ignored. A value of 6 characters or more is
    refused when `secretPattern` finds it or when the text and the value, each stripped of whitespace,
    punctuation and symbols, contain it. A configuration secret or created password shorter than 6 (the
    6-character floor is the ledger classes' only) is refused as a whole token — not preceded or followed
    by a letter or digit — raw, URL-decoded, as its base64 (a whole token) and spelled out with
    whitespace, punctuation or symbols between its characters; never as a part of a longer word. A
    refusal prints one line per hit, `<title|body> <line>:<col> <class>` (1-based; a hit in a stripped
    or decoded form is placed at its first character in the text as given), then `refused: scrub: <k>
    secret(s) in the issue; nothing is filed` — never the value, never the text around it. Redaction: every run of 24+ `[A-Za-z0-9_-]` holding a letter and a digit, not all hex, not in
    the seen ids → `<redacted>`. Defanging, outside fenced blocks and code spans as CommonMark reads
    them: `@name`, `#<n>`, `owner/repo#<n>` and every `http(s)` URL whose host is not loopback are
    wrapped in backticks. Fenced blocks whose info string is `ts`, `typescript` or `json` (the generated
    test, the repro) are left whole; every other fenced block keeps at most 20 lines (`… <k> lines cut`
    inside it). The title gets the same treatment.
18. **Screenshots.** After `pw … screenshot`, the wrapper drains first (`observe`, so the ledger holds
    the page's values before the verdict reads it), then runs a `shot` stage and writes, beside the PNG,
    `<name>.verdict.json` (0600) `{t, sha256, passed, reasons}` — `sha256` of the PNG's bytes as
    written: `secret` (the text of the page and of every frame, iframes included, or an input value
    holds a scrub secret at that moment; a gone or incomplete ledger counts as `secret`),
    `password-field`, `one-time-code-field`, `error-page` (status ≥ 400 or a `chrome-error:` page).
    Never the text. Scrub attaches a screenshot only when it lies in a slot's `out/` of the run and not
    under a `traces/` directory, its verdict passed, its bytes still hash to the verdict's `sha256`,
    `gh --version` ≥ 2.99, `gh repo view` says `PRIVATE` or `INTERNAL`, and the contract's policy
    `traces` is not `none`; the others are named in a `Local evidence:` line scrub appends to the body.
19. **Scrub files.** `scrub … --create [--label <l>…]` and `scrub … --comment <n>` run `gh issue
    create|comment --body-file` (no shell) once the text passed; an issue or comment URL in gh's stdout
    means filed, whatever its exit code (`filed: <url>`); no URL means not filed (exit 2). Without
    either flag scrub only checks and rewrites.
20. **Map mode.** `argus-live.mjs up --map` takes the lock and builds the worktree at HEAD — no setup,
    store, app, proxy, HOME or logins — and writes run.json with `mode: "map"`. `slot <n> --map` mints a
    map token in any run whose run.json has a worktree (a map run, or a full `up` still starting), so
    `/sapu:journey` can refresh the map while `up` brings the app up. A map token takes `code` and
    `submit` only, before an instance id too; its `submit` validates the map schema (`validateMap`).
    `map-check --merge <slot>` merges the newest generation's map into `.argus/journeys.json` with `head`
    the commit of the map run's worktree (the code the map agent read, not MAIN's HEAD, which may have
    moved meanwhile) and checks it. `up --fresh` and `renew` refuse a map run. The guard needs nothing new: the map agent's Read is
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
    blame comparison, by **author** time: a rebase or cherry-pick rewrites the committer time, not when
    the line was written): `code-newer` (needs-owner), `doc-newer` (class B(a)), or `undecidable
    (<why>)` (needs-owner).
25. **Module split.** `argus-live-instance.mjs` keeps `up`, `up --fresh`, `up --map`, `renew` and
    `status`; the bring-up blocks (ports, worktree, HOME, environment, setup, start, health, store)
    move whole to `argus-live-start.mjs`. `canonicalOrigin`, `exactHost` (from `-proxy.mjs`),
    `originOf`, `BLOCKED_ERROR` and `checkUrl` (from `-pw.mjs`) move to the leaf `argus-live-origin.mjs`;
    `secretsOf` and `configuredUser` move from `-pw.mjs` to `-session.mjs` (as `maskSecrets`,
    `configuredUser`), shared with the runner.
26. **The `login` step** is `{"as": "<role>.<k>", "do": "login", "user": <string>, "password":
    <string>}` — the owner's `{action: "login", role: "<role.k>", user, password}` in the DSL's
    `as`/`do` spelling. `as` is an account of the allocation written with its number; `user` and
    `password` are literal or hold `{{marker}}` and `{{<saved>}}` placeholders (values an earlier `read`
    saved or the run created); after substitution `user` must not be a configured user
    (`configuredUser`). The runner appends the substituted password to the ledger as `created password`
    before the sign-in (so scrub refuses it after `down` too, when slot `r`'s state.json is gone; `pw`'s
    `login` does the same for an explorer's), then signs that account's session in as the created user
    through the driver's `signIn` with slot `r`'s state.json `createdFailed` as its failure record, as
    `pw` does; a failure ends the run with exit 2 `HARNESS: step <n> <role.k> login failed` and never
    touches run.json `loginFailed`. An account whose first step is a `login` is opened without signing
    its allocated user in. A `login` always changes state (decision 6).

**Spec edits this plan needs** (folded in by the final task, as built): §5 — `drift`; §6 — the
journey fields `lastHead`, `filed` and the step field `claim`, map mode (`up --map`, map slots,
`map-check --merge`), the exact `map-check` rules (decision 21), `select`'s inputs and output,
`map-check --list` as the catalog, `map-check --merge` stamping the map run's worktree commit as
`head`; §7 — the popup known limit removed (decision 16); §8 — run.json `mode` and `worktreeHead`, `up --map`, map slots,
the ledger under `logs/` kept by `down` and removed by the next `up`'s step 1, `up --fresh` and `down`
draining every session before they close it, `down` pruning `r/out/traces/` to the traces of runs that
exited 2, the teardown skipping `repro/`, `status` naming a map run; §9 — slot `r` and its sessions,
the `hook` stage (the in-daemon `Set`, `capBytes`, the drain), the screenshot verdict with its
`sha256`, the map token's two commands; §10 — decisions 1–15, 17–19, 23 and 26 (the `login` step, the
`created password` class, traces only after sign-in and never filed); §12 — rows for a repro account in
`loginFailed`, a `login` step that failed (slot `r`'s `createdFailed`, exit 2, the cycle unaffected), a
gone, damaged or incomplete ledger, a run's ledger after `down` (kept 0600 under `logs/`, scrub of
that run still works, the next `up` removes it and scrub of the old run then refuses), a screenshot
changed after its verdict, `up --fresh` refusing a map run; §14 — the test names as built; §16 —
`argus-live.mjs`: `repro`, `map-check` and `scrub` as listed, and these **additions to the spec's list**:
`up --map`, `slot --map`, `select`, `classify`, `drift`. Roadmap row 4 — map mode, `classify` and
`drift` added.

---

## File structure

| File | Responsibility |
|---|---|
| `plugins/sapu/scripts/argus-live-origin.mjs` | new leaf: `exactHost`, `canonicalOrigin`, `originOf`, `BLOCKED_ERROR`, `checkUrl` |
| `plugins/sapu/scripts/argus-live-start.mjs` | new: the bring-up blocks moved from `-instance.mjs` |
| `plugins/sapu/scripts/argus-live-session.mjs` | new: `sessionDriver`, `maskSecrets`, `configuredUser` (from `pw`'s `call`); `drainSessions` (Task 4) |
| `plugins/sapu/scripts/argus-live-ledger.mjs` | new: `MIN_SECRET`, `MAX_SECRET`, `SECRET_KEY`, `SEEN_SKIP_KEY`, `LEDGER_CLASSES`, `highEntropy`, `ledgerFile`, `ledgerEntries`, `appendLedger`, `readLedger`, `dropLedgers`, `seenFile`, `seenIds`, `appendSeen`, `readSeen`, `secretHits` |
| `plugins/sapu/scripts/argus-live-steps.mjs` | new: the repro DSL — `parseRepro`, `FINAL_KINDS`, `substitute`, `stepCode`, `reductions` |
| `plugins/sapu/scripts/argus-live-repro.mjs` | new: `reproRef`, `runOnce`, `repro`, `minimize` |
| `plugins/sapu/scripts/argus-live-redtest.mjs` | new: `redTest` |
| `plugins/sapu/scripts/argus-live-classes.mjs` | new leaf: `CLASSES`, `classify` |
| `plugins/sapu/scripts/argus-live-scrub.mjs` | new: `scrubSecrets`, `redactIds`, `defang`, `attachVerdict`, `scrub` |
| `plugins/sapu/scripts/argus-live-map.mjs` | new: `JOURNEYS_FILE`, `readJourneys`, `validateMap`, `mapCheck`, `refreshReasons`, `catalog`, `mergeMap`, `score`, `selectJourneys` |
| `plugins/sapu/scripts/argus-live-drift.mjs` | new: `drift` |
| `plugins/sapu/scripts/argus-live-proxy.mjs`, `-login.mjs`, `-pw.mjs`, `-browser.mjs`, `-cli.mjs`, `-run.mjs`, `-slots.mjs`, `-return.mjs`, `-instance.mjs`, `argus-live.mjs` | modified (each task names its change) |
| `tests/fixtures/journey-app/server.mjs` | modified: `/storage`, `/api/me`, `/api/items/<id>`, `/api/reset/<x>`, stock, inbox, claim, approve, ship, cancel, signup, the order note's echo, the seeded defects behind `$DEFECTS_FILE` |
| `tests/fixtures/argus-red/order-to-cash.handoff.spec.ts` | new: the golden generated test, written by hand from Task 11's text before `redTest` exists |
| `tests/helpers/argus-live.ts` | modified: `appCycle()` (a full `up` on the fixture app with its defects file), `candidate()` (a minted slot's return holding repros), `fakeGh()` |
| `tests/argus-live-findings.test.ts` | new: tests that need no browser (DAG, DSL, red test, classes, ledger matcher, scrub, map, select, drift; the CLI shim where a session is involved) |
| `tests/argus-live-repro.test.ts` | new: tests in Chrome (hook, ledger, repro, minimize, screenshot verdicts, the end-to-end cycle) |
| `tests/argus-live.test.ts`, `tests/argus-live-pw.test.ts`, `tests/argus-live-browser.test.ts` | modified: imports from the modules symbols moved to |

Module DAG after this phase (each module imports only modules to its left; leaves import no
`argus-live-*` module): proc → lock → endpoints → docker/egress and cli → run → {browser, proxy,
hooks, slots, start, map, ledger, scrub, drift} → return → login → session → {pw, steps} →
{instance, redtest} → repro → `argus-live.mjs`. Leaves: `fence`, `targets`, `origin`, `classes`.
`ledger` imports only `fence`, `lock` (`liveDir`) and `run` (`logsDir`: the ledger and `seen.jsonl`
both live under the run's `logs/`); `run` takes the teardown's drain as a `drain` parameter of `down`
and `reap` (supplied by `argus-live.mjs` from `-session.mjs`), never an import; `scrub` imports `config`, `endpoints`, `run`, `ledger`,
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

**Files:** Modify `plugins/sapu/scripts/argus-live-login.mjs` (stages `hook`, `observe`,
`HELPERS.drain`), `plugins/sapu/scripts/argus-live-session.mjs` (`open()` runs `hook`; `capBytes`),
`tests/fixtures/journey-app/server.mjs` (`/storage`, `/api/me`, `/api/items/<id>`, `/api/reset/<x>`);
Test `tests/argus-live-repro.test.ts` (Chrome), `tests/argus-live-findings.test.ts` (shim).

Interfaces:
- Stage `hook` (payload `{runOrigins, signals: SIGNAL_SCRIPT, capBytes}`; returns `{installed:
  true|false}`, false when `ctx.__argus` existed): creates `ctx.__argus = {seen: new Set(), bytes: 0,
  overflow: false, headers: [], errors: [], leaves: [], paths: []}`; `ctx.on("request")` records
  `[name, value]` for `cookie`, `authorization`, `proxy-authorization` and `*-token` headers
  (`request.allHeaders()`), and `[previous segment, segment]` pairs of the URL's path for a run origin;
  `ctx.on("response")` records `set-cookie`, a `{kind: "5xx", status, url}` error for a status ≥ 500,
  and for a `json` content type `[key, value]` for each string leaf of 24+ characters mixing letters
  and digits (decision 15's shape; its key and segment rules are `seenIds`', on the Node side). A
  header value (cut to `MAX_SECRET`) is pushed to `headers` only when `seen` lacks `name\0value`; it
  is then added to `seen` and its length to `bytes`; past `capBytes` nothing more is recorded and
  `overflow` is set (decisions 14, 16). A page hook (for `ctx.pages()` and `ctx.on("page")`) adds
  `console` errors and `pageerror` (`{kind: "console"|"pageerror", text ≤ 500, url}`) and a
  `domcontentloaded` listener evaluating `P.signals`.
- `HELPERS.drain(ctx)` (in `-login.mjs`, shared with Task 7's step templates) → `{cookies:
  [{name, value, httpOnly, secure}] from ctx.cookies(), storage: [{key, value}] of every page's
  localStorage and sessionStorage, headers, leaves, paths, errors, overflow}`, emptying the pending
  arrays (never `seen`). Stage `observe` additionally returns `secrets: <drain>`.
- `sessionDriver({…, capBytes = 4 * 2 ** 20})` (the parameter added here; a test passes a small one);
  `open()` runs `hook` right after `openSession` (a failure → `harness: hook failed` among the open's
  events; the session is used all the same).
- The fixture: `/storage` (signed in) sets `localStorage.jwt` to 32 random hex and
  `localStorage.theme` to `dark-mode-on`, fetches `/api/me` with `Authorization: Bearer <32 hex>`, and
  again 2000 ms after load with a second bearer (each bearer 32 random hex chosen once at the fixture's
  start and kept in `DATA_DIR/bearer.json`, so a test can read them), `/api/reset/rk7b6a5c4d3e2f1g0h9i8j7k6` and `/api/items/ck9a8b7c6d5e4f3g2h1i0j9k8`
  answering `{"id": "ck9a8b7c6d5e4f3g2h1i0j9k8", "token": "tok_<32 hex>", "code":
  "cd4e5f6a7b8c9d0e1f2a3b4c5d", "ref": "eyJhbGciOiJIUzI1NiJ9x1y2z3a4b5"}`; nothing of it is rendered.

- [ ] **Step 1: Probe first (done, see "Verified against"); re-run on the release machine** the
  linked-popup case below before writing the code.
- [ ] **Step 2: Failing tests.**
  `tests/argus-live-repro.test.ts`, describe "argus-live hook — every document watched" (phase 3's
  `browserRun()` and `mintSlot`, moved to the helpers file if it is still local):
  - "a popup a link opened is watched from its first document": `pw <t> buyer.1 goto /popup`, `click
    'getByRole('\''link'\'', { name: '\''Open linked details'\'' })'`, wait 6 s (the toast comes at 4 s
    and goes at 5 s), `pw <t> buyer.1 tab-list` → the fence holds `signal status: Linked ready`.
  - "the hook installs once per context": a test `runCode` after the first `pw` call reads
    `ctx.listenerCount("request")`, `ctx.listenerCount("response")` and `ctx.listenerCount("page")`; a
    second `pw` call, then the same read → each count's delta is 0 (the CLI may hold listeners of its
    own, so no absolute count is asserted), and `Object.keys(page.context().__argus)` is decision 16's.
  - "header values are recorded once, and overflow is flagged": two `pw … goto /storage` (the same
    bearer twice) → the drained headers hold that bearer once; a driver opened in-process with
    `capBytes: 64` on `/storage` → its drain answers `overflow: true`.
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
appends to the ledger and `seen.jsonl` and keeps `drained`; `reopen` marks a session lost mid-command;
`drainSessions`), `-pw.mjs` (`login`'s password to the ledger), `-instance.mjs` (`upFresh` drains every
session it closes; `up`'s step 1 runs `dropLedgers`), `-run.mjs` (`down` and `reap` take `drain`; the
teardown's slot-file pass skips `repro/`), `argus-live.mjs` (`down` and `reap` pass `drainSessions`);
Test `tests/argus-live-findings.test.ts`, `tests/argus-live-repro.test.ts`.

Interfaces:
- `export const MIN_SECRET = 6`, `export const MAX_SECRET = 4096`, `export const SECRET_KEY`,
  `export const SEEN_SKIP_KEY`, `export const LEDGER_CLASSES = ["cookie", "header", "storage"]`,
  `export function highEntropy(v)` (decision 14).
- `export function ledgerFile(main, runId)` → `<logsDir>/secrets.jsonl`;
  `export function seenFile(main, runId)` → `<logsDir>/seen.jsonl`.
- `export function ledgerEntries({cookies = [], storage = [], headers = []})` (cookies `{name, value,
  httpOnly, secure}`, storage `{key, value}`, headers `[name, value]`) → `[{c, v}]` per decision 14
  (the cookie and storage rules, values cut to `MAX_SECRET`, values under `MIN_SECRET` dropped,
  duplicates dropped).
- `export function appendLedger(main, runId, entries)`: appends the entries not already in the file
  (`{c: "created password"}` and `{c: "incomplete"}` entries included), as one write, mode 0600;
  `export function readLedger(main, runId)` → `{entries: [{c, v}], incomplete: <the first marker's v> |
  null}`, `null` when the file is gone, throws `refused: scrub: the run's secret ledger is damaged` on
  a line that is not `{c, v}` JSON.
- `export function dropLedgers(main, {keep})` → removes `logs/secrets.jsonl` of every run directory
  under `.argus/live/` but `keep` (the new run's id); `up`'s step 1 calls it after the lock is taken.
- `export function seenIds({paths = [], leaves = []})` → the ids decision 15 keeps;
  `export function appendSeen(main, runId, values)`, `export function readSeen(main, runId)` → `Set`.
- `export function secretHits(text, secrets)` (`secrets` is `[{cls, v}]`) → `[{line, col, cls}]`,
  sorted by line, column and class, distinct: a value of a class in `LEDGER_CLASSES` counts only at
  `MIN_SECRET` or more; any value of 6 or more is found by `secretPattern` or, stripped of
  `[\s\p{P}\p{S}]`, as a substring of `text` stripped the same way (an index map places the hit in
  `text`); any other value shorter than 6 is found only as a whole token, raw, URL-decoded, as its
  base64 and spelled out (decision 17).
- `export async function drainSessions(main, runId, records, {runner, cliRunner})` (in
  `-session.mjs`): for each record whose daemon runs, the `observe` stage and its values appended
  (ledger, `seen.jsonl`); a record whose daemon is gone with its account's state `drained: false` →
  `{"c": "incomplete", "v": "<session> lost before its drain"}`; an `observe` that fails on a live daemon
  → `incomplete` (`<session> could not be drained`). `upFresh` calls it on the sessions it closes, right
  before `closeSessions` (after Task 5 those are every slot's but `up`'s); `down(main, {…, drain})` and
  `reap` call `drain` on the run's recorded sessions before the teardown closes them (`drain` absent —
  only a test's call — closes them undrained and appends `incomplete`).
- `observe()` sets the account's state `drained: true` after it appended; `pw` sets `drained: false`
  before it runs a command. `pw`'s `login <user> <password>` appends `{c: "created password", v:
  <password>}` before it signs in.

- [ ] **Step 1: Failing tests.**
  describe "argus-live ledger" (findings file):
  - "ledgerEntries takes only secret-like cookies and storage, and every secret header": cookies
    `[{name: "sid", value: "COOKIEVALUE_abc123", httpOnly: true}, {name: "theme", value:
    "dark-mode-on"}, {name: "prefs", value: "Xy7_kq9Lm2Pz8Wv4"}, {name: "sid2", value: "abc12"}]`,
    storage `[{key: "app", value: '{"jwt":"LS_TOKEN_98765","n":1,"label":"hello world"}'}, {key:
    "theme", value: "dark"}]`, headers `[["authorization", "Bearer AUTHVALUE_112233"], ["cookie",
    "sid=abcdef123456; theme=dark-mode-on"], ["set-cookie", "zz=zzzzzz999999; Path=/; HttpOnly"],
    ["x-csrf-token", "CSRFVAL_9988"], ["x-api-token", "T".repeat(10_000)]]` → exactly
    `COOKIEVALUE_abc123` and `Xy7_kq9Lm2Pz8Wv4` (`cookie`), `LS_TOKEN_98765` (`storage`; the JSON
    never whole), `Bearer AUTHVALUE_112233`, `AUTHVALUE_112233`, `abcdef123456`, `zzzzzz999999`,
    `CSRFVAL_9988` and 4096 `T`s (`header`); never `dark-mode-on`, `dark`, `hello world` or `abc12`.
  - "secretHits finds a value raw, URL-encoded, base64-encoded and split by spaces, and says where":
    `{cls: "header", v: "AUTHVALUE_112233"}` in `x AUTHVALUE_112233 y` → `[{line: 1, col: 3, cls:
    "header"}]`; in `ok\n  AUTHVALUE%5F112233` → line 2, col 3; `QVVUSFZBTFVFXzExMjIzMw` and
    `A U T H V A L U E _ 1 1 2 2 3 3` → one hit each; `{cls: "header", v: "db"}` and `db` in the text →
    `[]`.
  - "a short configuration secret is matched as a whole token only": `{cls: "role password", v:
    "pw1"}` → a hit in `use pw1 here`, `p-w-1`, `p%771`, `cHcx`; none in `pw123`, `xpw1` or `cHcxZ`.
  - "seenIds keeps the ids and none of the tokens": paths `[["items", "ck9a8b7c6d5e4f3g2h1i0j9k8"],
    ["reset", "rk7b6a5c4d3e2f1g0h9i8j7k6"], ["verify-email", "ve1a2b3c4d5e6f7g8h9i0j1k2"]]`, leaves
    `[["id", "01HZX3J4K5M6N7P8Q9R0S1T2V3"], ["code", "cd4e5f6a7b8c9d0e1f2a3b4c5d"], ["nonce",
    "nn4e5f6a7b8c9d0e1f2a3b4c5d"], ["ref", "eyJhbGciOiJIUzI1NiJ9x1y2z3a4b5"]]` → exactly the cuid and the
    ULID.
  - "a damaged ledger refuses; a gone one is null; an incomplete one says why".
  - "drainSessions marks what it could not drain": a record whose daemon is gone and state `drained:
    false` → the ledger's `incomplete` names it; the same with `drained: true` → no marker; down's
    teardown without `drain` → a marker.
  describe "argus-live ledger in Chrome" (repro file):
  - "observation records the HttpOnly cookie, the jwt and the bearer token, never in pw's output":
    `pw <t> buyer.1 goto /storage` → `logs/secrets.jsonl` (mode 0600) holds the `sid` the fixture
    issued (from `sessions.json`), `localStorage.jwt` and the first bearer from `bearer.json`, not
    `dark-mode-on`; `pw`'s output holds none of the three.
  - "the ids the run saw are kept, tokens are not": `logs/seen.jsonl` holds
    `ck9a8b7c6d5e4f3g2h1i0j9k8`, not the `tok_` value, the `/reset/` segment, the `code` leaf or the
    `eyJ` value.
  - "down drains every session before it closes it": `pw <t> buyer.1 goto /storage` returns before the
    second `/api/me`; wait 3 s; `down` → the ledger holds the second bearer.
  - "up --fresh drains every session it closes": the same with `upFresh` in place of `down`.
  - "the ledger survives down and the next up removes it": after `down`, `logs/secrets.jsonl` (0600)
    and `logs/seen.jsonl` remain; the next `up` → the earlier run's `secrets.jsonl` is gone, its
    `seen.jsonl` remains.
  - "a created account's password is in the ledger": `pw <t> buyer.1 login new@example.test
    Secret-pw-1` (no such account: `login: failed`) → the ledger holds `{"c": "created password", "v":
    "Secret-pw-1"}`; run.json `loginFailed` is unchanged.
- [ ] **Step 2–4:** run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `feat(sapu): argus-live records the run's secret-like cookie, header and storage values in a 0600 ledger that loses nothing silently, survives down and goes at the next up, and the ids its pages saw`.

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
- **Echo.** `/orders/new` takes an optional `Note` (a textbox labelled `Note`, at most 500
  characters); `/orders/<id>` shows it verbatim, HTML-escaped, in `data-testid=note` — the field Task
  8's literal-values test reads back.
- **Signup.** `/signup` (anon) takes `Email` and `Password` and a `Sign up` button; it creates a
  `buyer` account (kept in `DATA_DIR/accounts.json`, signed in through `/login` like any other) and
  shows `Welcome <email>`; an email of a configured user, or one already signed up, answers 409 —
  the account Task 8's `login` step uses.
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
  two parallel claims → 409 for one (off) / `claims: 2` in `--facts` (on); "the note is echoed as
  written": a note `O'Brien "x" \ <b>` → the order page's `note` element's text is exactly that; "a
  signed-up account signs in": `/signup` then `/login` with it → signed in as `buyer`; signing up
  `buyer1@example.test` → 409.
- [ ] **Step 2–4:** run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `feat(sapu): the journey-app fixture's seeded oracle defects — handoff, dead end, reversal, claim race, stale view, orphaned work, viewport — each with its fixed variant, plus signup and an echoed note`.

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
  an account the journey created, never a configured user` (a literal `user`; a placeholder is checked
  again after substitution, Task 8), `login's as names an account (<role>.<k>)`, `login takes a user
  and a password (strings, placeholders allowed)` (decision 26), `trigger <name> is not in live.triggers`,
  `trigger <name> takes <k> value(s)`, `viewport must be from 200 to 4000`, `locale is not a BCP 47
  tag`, `timezone is not one Intl knows`, `at most 100 steps`. Every string ≤ 500 characters, no
  control characters.
- `export function substitute(step, vars)` → a copy with every `{{name}}` in its string fields replaced
  by `vars[name]` (a literal).
- `export function stepCode(step, {settleMs, at = null, runOrigins})` → the `async page => {…}` text
  of the `step` template: `const P = <JSON>;`, `const T = (pg) => <targetCode(step.target, "pg")>;` (or
  `null`), the shared `HELPERS`, then the action or the expectation's poll (decision 11). Actions answer
  `{ok, changed, method, value?, errors, drain}` or `{ok: false, why: "missing-target"|"timeout"|
  "error", detail, drain}`; expectations `{held, observed, detail, errors, drain}` (`observed` per
  decision 8; `drain` = `HELPERS.drain(ctx)`, so every step drains the hook's buffers without a call of
  its own, decision 14). `P.at` (epoch ms) is the `parallel` barrier. A `login` step has no template:
  the runner signs it in through the driver (decision 26).
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
  - "a login step has its shape": `{as: "customer.1", do: "login", user: "{{marker}}@example.test",
    password: "pw-{{marker}}"}` followed by an `expect` as `customer.1` parses; `as: "customer"` →
    `login's as names an account (<role>.<k>)`; `user: "buyer1@example.test"` (a configured user) →
    `login takes an account the journey created, never a configured user`; no `password` → `login takes
    a user and a password (strings, placeholders allowed)`.
  - "every step template drains": the `stepCode` text of an action and of an expectation each call
    `HELPERS.drain` in every answer path.
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
(`repro <ref> --once`), `plugins/sapu/scripts/argus-live-run.mjs` (`pruneTraces`, run by `down`'s
teardown), `tests/helpers/argus-live.ts` (`appCycle()`, `candidate()`); Test
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
     account's driver `ensure()` (first use: open, signed in unless `anon` or its first step is a
     `login`, then `tracing-start` — never before the sign-in, decision 13), `substitute`, then the
     browser step through `driver.code(stepCode(…))` with the state `drained: false` around it and its
     answer's `drain` appended (ledger, `seen.jsonl`, the account's error buffer, `drained: true`), or
     `trigger` through `runHook` (its values through `fillArgv`), `fact-equals`/`mail` polled through
     `runHook`, `no-error` from the account's error buffer, `login` per decision 26 (`tracing-stop`, the
     substituted `user` checked against `configuredUser` — exit 2 `HARNESS: step <n> login takes an
     account the journey created, never a configured user` —, the password appended to the ledger as
     `created password`, `driver.signIn({user, password})` with slot `r`'s `createdFailed` as
     `failures`, a failure → exit 2 `HARNESS: step <n> <role.k> login failed`, then `tracing-start`); a
     `read`'s value kept in `saved`; a session lost (`logged_in` gone on the page and in a probe) → exit 2
     `HARNESS: step <n> <role.k> lost its session`; a `click`/`dblclick`/`press` with `changed` and no
     proving expect → exit 2 `HARNESS: step <n> changed state (a <METHOD> request) with no proving
     expect` (decision 6); a missing target → `HARNESS: step <n> missing target`; an
     `expect` before the final that fails → `HARNESS: step <n> expectation failed before the final step`;
  6. the final: held → exit 0 `NOT REPRODUCED`; failed → exit 3 with the fence and `REPRODUCED …`;
  7. `finally`: for each opened account `observe()` (the last drain), `tracing-stop`, `closeSessions`;
     `run-<i>.json` `{exit, step, expected, observed, ms, saved, traces}` (decision 2; `saved` masked
     with `maskSecrets` and the run's created passwords) and `steps-<i>.jsonl` (0600) written.
  Any throw → exit 2 `HARNESS: failed: <message, masked>` (the top-level handler).
- `pruneTraces(main, runId)` (`-run.mjs`, run by `down`'s teardown after it closed the sessions):
  removes every file under `r/out/traces/` that no `repro/*/run-*.json` with `exit: 2` names in
  `traces` (decision 13); it reads those records as JSON, imports nothing above `run`.
- CLI: `repro <ref> --once` prints `lines` (each already masked; the fence's nonce never re-masked)
  and exits with `code`.

- [ ] **Step 1: Failing tests** (describe "argus-live repro — one run", Chrome; `appCycle()` = phase
  3's end-to-end setup (`homeWithCli()`, spawned `up`) with roles `buyer` (buyer1, buyer2) and `clerk`
  (clerk1 TOTP, clerk2), `settle_ms: 3000`, triggers `settle`, `facts`, `mail`, and `$DEFECTS_FILE`;
  `candidate(main, {slot, accounts, repro})` mints a slot and submits a return holding that repro):
  - "each seeded oracle defect reproduces, and its fixed variant does not": for each of handoff
    (`missing-handoff`), dead end, reversal (`double-release`), claim race (a `parallel` group of
    `clerk.1` and `clerk.2` clicking `Claim`, each proved by `visible {testId: "claim", nth: 0}`, the
    final `count {testId: "claim"} 1`), stale view, orphaned work — the repro written in the test from
    §10's templates; defect on → exit 3, last line matches `^REPRODUCED step=\d+ expected=[a-z-]+(:\d+)?
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
  - "a run's records are absent from the next run": run 1 places an order; run 2 is `clerk.1 goto
    /inbox`, `expect count {testId: "inbox-item"} 0`, then a final `visible {role: "heading", name:
    "Inbox"}` (`discoverability`) → exit 0 and `step 2 clerk.1 count: held`.
  - "values with quotes are substituted as literals": `fill {label: "Note"}` with `O'Brien "x" \
    {{marker}}` on `/orders/new`, `Place order`, then a `text-equals {testId: "note"}` of the same
    string → it holds with the marker substituted; `run-1.json` `saved` holds the order number a `read`
    saved; a `trigger settle` value `;id` → exit 2 naming the value's regex, the hook never ran.
  - "a login step signs in an account the run created, and its failure is the run's only": `anon`
    signs up `{{marker}}@example.test` / `pw-{{marker}}` on `/signup`, `expect visible` its `Welcome`;
    `buyer.2` (`as`, first step) `login` with those, `expect visible {text: "Signed in as"}`, then a
    final → no `HARNESS`; the ledger holds `pw-<marker>` as `created password`; a second repro whose
    `login` uses a password never signed up → exit 2 `HARNESS: step <n> buyer.2 login failed`, slot
    `r`'s state.json `createdFailed` names it and run.json `loginFailed` is unchanged.
  - "an account whose login failed this cycle is never retried": run.json `loginFailed
    {"buyer/buyer1@example.test": "rejected"}` → exit 2 `HARNESS: buyer.1 cannot sign in this cycle`; the
    fixture's `/__test/stats` shows no new `POST /login`.
  - "the run leaves a trace, begun after sign-in, and no session": `run-1.json` `traces` names files
    under `r/out/traces/` that exist; no trace file's bytes hold the role's password or the
    `POST /login` body; no process command holds `cliDaemon.js <run>-r-`; run.json `sessions` holds none
    of slot `r`.
  - "down keeps only the traces of runs that exited 2": one run exiting 0 and one exiting 2 (`{testId:
    "nope"}`), then `down` → the exit-0 run's traces are gone, the exit-2 run's remain.
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
  - "each seeded defect's class line" (spec §14 "Repro": a seeded defect's class row): for each defect
    Task 8 reproduces, the spawned `classify` with that oracle and the flags the fixture's defect
    implies → exactly its line: `handoff` (no `--rule`) → `class heuristic labels
    ux,workflow,argus:needs-owner,argus,found-by:user severity at most S3 because …`; `dead-end
    --money` → `class A labels bug,argus,found-by:user severity S1 …`; `reversal --stock` (double
    release), `claim-race --moved-twice`, `stale-view --stock`, `orphaned-work` and `viewport-locale` →
    their rows' lines, each written out in the test.
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
  findings file, describe "argus-live minimize": an 8-step list (`buyer`: 1 `goto`, 2 `fill`, 3
  `hover`, 4 `click` with `changed`, 5 its proving `expect`; `clerk`: 6 `goto`, 7 `hover`, 8 the
  final) whose essential steps are 2 and 6, and a stub `once` that answers 3 exactly while steps 2 and
  6 are both in the list it is given (0 once either is gone) → `min.json` keeps 2, 6, `buyer`'s only
  state-changing step 4 with its expect 5 (never offered) and the final 8, and drops 1, 3 and 7;
  `tried` shows `role buyer`, `step 6` and `step 2` answering 0 and `step 7`, `step 3`, `step 1`
  answering 3; `stopped fixpoint`, `confirmed yes`. (A stub answering 3 while 2 and 6 are absent would
  pass a minimizer that drops every step, so it is not the test.) `max: 3` → `stopped budget`, two
  tries and the confirm run; a confirm run answering 0 → `confirmed no` and `min.json` not written; on
  §10's example a trigger and the final never appear among the tried labels.
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
  `const CONTEXT` (the repro's context as JSON: `viewport` → `{"width": <w>, "height": 900}`, as
  `slotConfig` sets it, `locale`, `timezone` → `timezoneId`); `const marker =
  \`argus-${Date.now().toString(36)}\``; stub helpers `signedIn(browser, account, context)`,
  `trigger(name, values)`, `fact(key, field)`, `mail()` that throw `wire <name> to this repo's E2E
  helpers`, and `readValue(target)` (decision 12's reading: an input's, textarea's or select's value,
  else the trimmed `innerText`, at most 500 characters); one `test("<journey>: <oracle> (<ref>)", async
  ({ browser }) => {…})` with one page per account (`const customer1 = await signedIn(browser,
  "customer.1", CONTEXT)`), each action as Playwright calls on a locator in `targetCode`'s form on the
  page variable, `read`+`save` as `const saved_<name> = await readValue(…)` (the `saved_` prefix keeps a
  saved name from colliding with `marker`, `SETTLE`, `CONTEXT`, a helper, a page variable or a reserved
  word), expectations as `expect(…).toBeVisible|toBeHidden|toBeEnabled|toHaveText|toContainText|
  toHaveValue|toHaveCount|toHaveURL({ timeout: SETTLE })`, `fact-equals` and `mail` as `expect.poll`,
  `no-error` through a per-page error collector the test sets up, `parallel` as `await
  Promise.all([...])`, the final preceded by the comment `// final (<oracle>): the correct behaviour,
  RED while the defect is there`. Every string is `JSON.stringify`'d; a string that is one placeholder
  becomes its variable (`marker`, `saved_<name>`), one that mixes text and placeholders a `+`
  concatenation of JSON literals and variables — never a template literal.
- `repro <ref> --test` writes `red.spec.ts` (0600) from `min.json` when confirmed, else `repro.json`,
  and prints `red test: <absolute path>`.

- [ ] **Step 1: Write the golden file by hand, then the failing tests.** The golden file is written
  first, from this text, before `redTest` exists — never generated by the implementation it checks.
  `tests/fixtures/argus-red/order-to-cash.handoff.spec.ts`, exactly, less this plan's four-space indent
  (40 lines, ending in one newline; checked while writing this plan: `stripTypeScriptTypes` takes it
  and `node --check` passes on the result):

    ```ts
    // Generated by argus-live.mjs repro 1.1.1 --test: journey order-to-cash, oracle handoff.
    // RED until the defect is fixed. Wire signedIn, trigger, fact and mail to this repo's E2E helpers.
    import { test, expect } from "@playwright/test";
    import type { Browser, BrowserContextOptions, Locator, Page } from "@playwright/test";

    const SETTLE = 3000;
    const CONTEXT: BrowserContextOptions = {"viewport": {"width": 1440, "height": 900}, "locale": "en-US", "timezoneId": "UTC"};
    const marker = `argus-${Date.now().toString(36)}`;

    async function signedIn(browser: Browser, account: string, context: BrowserContextOptions): Promise<Page> {
      throw new Error("wire signedIn to this repo's E2E helpers");
    }
    async function trigger(name: string, values: string[]): Promise<void> {
      throw new Error("wire trigger to this repo's E2E helpers");
    }
    async function fact(key: string, field: string): Promise<unknown> {
      throw new Error("wire fact to this repo's E2E helpers");
    }
    async function mail(): Promise<unknown[]> {
      throw new Error("wire mail to this repo's E2E helpers");
    }
    async function readValue(target: Locator): Promise<string> {
      const v = await target.evaluate((e) => e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement || e instanceof HTMLSelectElement ? e.value : (e as HTMLElement).innerText);
      return v.trim().slice(0, 500);
    }

    test("order-to-cash: handoff (1.1.1)", async ({ browser }) => {
      const customer1 = await signedIn(browser, "customer.1", CONTEXT);
      const sales1 = await signedIn(browser, "sales.1", CONTEXT);
      await customer1.goto("/orders/new");
      await customer1.getByLabel("Quantity").fill("2");
      await customer1.getByRole("button", {"name": "Place order"}).click();
      const saved_order = await readValue(customer1.getByTestId("order-number"));
      await expect(customer1.getByText(saved_order)).toBeVisible({ timeout: SETTLE });
      await trigger("payment-settles", [saved_order]);
      await expect.poll(() => fact(saved_order, "status"), { timeout: SETTLE }).toBe("paid");
      await sales1.goto("/");
      // final (handoff): the correct behaviour, RED while the defect is there
      await expect(sales1.getByText(saved_order)).toBeVisible({ timeout: SETTLE });
    });
    ```

  The reviewer of this task checks the file against §10's example line by line before the
  implementation starts; a later change to it is a reviewed change of the generator's contract, not a
  re-recording.
  describe "argus-live generated RED test":
  - "the §10 example matches the golden file": `redTest` of the spec's list (its context element
    first) with `journey: "order-to-cash"`, `oracle: "handoff"`, `ref: "1.1.1"`, `settleMs: 3000` and
    accounts `customer` → `customer.1`, `sales` → `sales.1` → equals the golden file byte for byte.
  - "saved names never collide": a `save: "marker"` is refused by `parseRepro` (decision 12); `save:
    "settle"` and `save: "customer1"` become `saved_settle` and `saved_customer1`; `"x {{order}}"`
    becomes `"x " + saved_order`.
  - "the test is valid TypeScript": `stripTypeScriptTypes` does not throw and `node --check` passes on
    the result (written as `.mjs`), for the golden case and for a list holding a `parallel` group, a `no-error`, a `mail`
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
- `export function scrubSecrets(main, {runId, env = process.env})` → `{secrets: [{cls, label, v}],
  refusal: null | <decision 14's refusal>}` for the classes of decision 17: `env file`
  (`loadLive(main).secrets` and `recordedSecrets`, every value), `repo env file`
  (`ownerEnvFiles(main, loadContract(main))`, only a `SECRET_KEY` name or a `highEntropy` value),
  `role password`, `TOTP secret` (`.argus/live.json` roles, expanded), `environment variable <NAME>`
  (only a `SECRET_KEY` name or a `highEntropy` value), and the ledger's `cookie`, `header`, `storage`
  and `created password` (`readLedger`; gone, incomplete or damaged → `refusal`). Empty values dropped.
- `export function redactIds(text, seen)` → `{text, count}` (decision 17).
- `export function defang(md)` → `{text, defanged, cut}` (decision 17; fences per CommonMark: an
  opening run of 3+ backticks or tildes, closed by the same character at least as long).
- `export async function scrub(main, {title, bodyFile, attach = [], create = false, labels = [],
  comment = null}, {env, gh = "gh", runner})` → `{code, out}`. This task: the run (the lock's, else the
  newest run directory — a run that is down is read the same way: scrub never needs it live);
  `scrubSecrets`' `refusal` → that line (exit 1); `secretHits` on the title and the body as given →
  one line per hit `<title|body> <line>:<col> <class>`, then `refused: scrub: <k> secret(s) in the
  issue; nothing is filed` (exit 1, the file untouched, no value and no text around it printed); then
  `redactIds` and `defang` on both, the body file rewritten in place, `scrub: ok; redacted <n>, defanged
  <n>, cut <n> line(s)` and `title: <the scrubbed title>` (exit 0).
- CLI `scrub --title <t> --body <file> [--attach <png>…] [--create [--label <l>…] | --comment <n>]`.

- [ ] **Step 1: Failing tests** (describe "argus-live scrub"; a `liveRun()` with a ledger written by
  `appendLedger` (a `cookie`, a `header`, a `storage` and a `created password` value), an env file, a
  repo `.env` holding `DB_PASSWORD=Repo-Secret-77` and `PORT=3000`, roles with a password and a TOTP
  secret, `env: {GH_TOKEN: "ghp_scrubtest123456", HOME: "<a home directory, built in the test>", BUILD_ID:
  "Ab3$xYz9Qw2!Lm5Np"}`):
  - "each secret class is refused, raw, URL-encoded, base64-encoded and split by spaces, in the title
    and in the body": 9 classes × 4 forms × 2 places, each → exit 1 with a `<title|body> <line>:<col>
    <class>` line placing it, the body file byte for byte as before.
  - "a refusal says where, never what": a body whose line 3 holds the cookie value at column 7 → the
    output is exactly `body 3:7 cookie` and `refused: scrub: 1 secret(s) in the issue; nothing is filed`;
    no output line holds the value or any other text of the body.
  - "configuration that is not secret-like is not a secret": a body holding `3000`, the test HOME path
    and `dark-mode-on` → exit 0; `Repo-Secret-77` (a `SECRET_KEY` name) and `Ab3$xYz9Qw2!Lm5Np`
    (high-entropy under a plain name) → refused, `repo env file` and `environment variable BUILD_ID`.
  - "a short configuration secret is refused as a whole token, never inside a word": a role password
    `pw1` → `use pw1 here` refused (`role password`), `pw123` and `xpw1` kept; a 5-character ledger
    cookie value is never matched (the floor is the ledger's).
  - "a cuid or ULID the run saw stays; an unknown long token is redacted": seen holds
    `ck9a8b7c6d5e4f3g2h1i0j9k8` and `01HZX3J4K5M6N7P8Q9R0S1T2V3`; the body holds both,
    `sk_live_… (a fake 30-character key)`, a 40-hex sha and `abcdefghijklmnopqrstuvwxyzabcd` → only the
    `sk_live_…` is `<redacted>`, count 1.
  - "mentions, references and outside links are defanged outside code": `@octocat`, `#12`,
    `owner/repo#3`, `https://evil.example/x` → backticked; `http://localhost:3000/x` and
    `http://127.0.0.1:9/x` kept; `` `@x` `` and a ```` ```ts ```` block of 40 lines untouched; a
    ```` ```text ```` block of 25 lines → 20 lines and `… 5 lines cut`; a line ```` ``` ```` inside a
    ```` ~~~text ```` block does not close it.
  - "scrub needs the run's whole ledger": no `logs/secrets.jsonl` → exit 1 with decision 14's `gone`
    wording; an `incomplete` marker → exit 1 with its `incomplete (<why>)` wording; a damaged line →
    `damaged`.
  - "scrub works on a run that is down": the same run after its lock is released (no `lock.json`, the
    run directory and its `logs/` kept) → a clean body → exit 0; the cookie in it → exit 1.
- [ ] **Step 2–4:** run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `feat(sapu): argus-live scrub refuses any secret-like value the run saw in any encoding, naming where and never what, redacts unknown long tokens and defangs page text`.

---

### Task 13: screenshot verdicts, attachments, filing through gh

**Files:** Modify `plugins/sapu/scripts/argus-live-login.mjs` (stage `shot`), `plugins/sapu/scripts/argus-live-pw.mjs`
(`screenshot` drains, then writes the verdict), `plugins/sapu/scripts/argus-live-scrub.mjs`
(`attachVerdict`, gh), `tests/fixtures/journey-app/server.mjs` (`/frame?echo=1` framing
`/inject?echo=1`; `/storage?show=1` rendering the second bearer once fetched), `tests/helpers/argus-live.ts`
(`fakeGh()`); Test `tests/argus-live-repro.test.ts`,
`tests/argus-live-findings.test.ts`.

Interfaces:
- Stage `shot` → `{text: <the body's innerText of the page and of every frame (`page.frames()`,
  iframes included), then every input/textarea/select value of each, one per line>, password: <a
  visible password input in any frame>, otp: <a visible one-time-code input in any frame>, error:
  <status ≥ 400 or a chrome-error: URL>}`.
- After a `screenshot` the CLI ran, `pw` first drains (`observe()`, its values appended to the ledger),
  then runs `shot` and writes `<out>/<name>.verdict.json` (0600) `{t, sha256, passed, reasons}`
  (decision 18; `sha256` of the PNG's bytes; `secret` when `secretHits(text, scrubSecrets(main,
  {runId}).secrets)` is not empty or `scrubSecrets` answered a `refusal`). `pw`'s output is unchanged.
- `export function attachVerdict(main, runId, file, {ghVersion, visibility, traces})` → `{attach:
  true}` or `{attach: false, reason}` (`gh older than 2.99`, `public repository`, `traces none`, `a
  trace, never attached` (any file under a `traces/` directory), `not a screenshot of this run`, `no
  verdict recorded`, `the screenshot changed after its verdict` (its sha256 differs), `a secret on the
  page`, `a password field`, `a one-time-code field`, `an error page`).
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
  `password-field`; `goto /orders/new` + `screenshot` → `passed: true` and `sha256` equal to the PNG's;
  a page holding the env file's value only inside an iframe (`/frame?echo=1`, a fixture page framing
  `/inject?echo=1`) + `screenshot` → `secret`; `goto /storage?show=1` (the page also shows the second
  bearer once its delayed fetch ran), wait 3 s, `screenshot` → `secret` (the second bearer reached the
  ledger only through the screenshot call's own drain, so this proves the drain runs before `shot`); no
  verdict file holds `Quantity` or exceeds 200 bytes.
  findings file, describe "argus-live scrub — attachments and filing" (`fakeGh()`: a script on a
  given path recording argv and answering `--version`, `repo view` and `issue create|comment` as the
  test sets):
  - "a screenshot is attached only when every condition holds": one `it` per reason above (a PNG
    rewritten after its verdict for `the screenshot changed after its verdict`, a file under
    `r/out/traces/` for `a trace, never attached`) → `local:` with that reason and the body's `Local
    evidence:` line; all conditions → `attach:` and gh saw `--attach <abs path>`.
  - "a non-zero gh exit after the URL counts as filed": gh prints the URL and exits 1 → exit 0
    `filed: https://github.com/o/r/issues/9`; gh prints nothing and exits 1 → exit 2.
  - "the needs-owner label goes through create": `--label argus:needs-owner` reaches gh's argv as
    `--label argus:needs-owner`.
  - "a refused scrub runs no gh".
- [ ] **Step 2–4:** run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `feat(sapu): argus-live screenshot verdicts at capture time, hashed and over every frame; scrub attaches only what passed, never a trace, and files through gh, counting a printed URL as filed`.

---

### Task 14: the core path on the CLI, the guard seam, one cycle end to end

The repro → minimize → test → classify → scrub path is finished and proven end to end before any map
work starts (Tasks 15–18 add `map-check`, map mode, `select` and `drift`, each adding its commands to
the usage line and the guard seam test).

**Files:** Modify `plugins/sapu/scripts/argus-live.mjs` (header comment and usage line: `repro`,
`classify`, `scrub`); Test `tests/argus-live-pw.test.ts` (guard seam), `tests/argus-live-repro.test.ts`.

- [ ] **Step 1: Failing tests.**
  `tests/argus-live-pw.test.ts`, describe "argus-live up — the browser refusals and the guard seam"
  gains: `checkExplorerBash` refuses `node <WRAPPER> repro 1.1.1`, `… repro 1.1.1 --minimize`, `…
  repro 1.1.1 --test`, `… scrub --title x --body /tmp/b`, `… classify --oracle dead-end`.
  `tests/argus-live-repro.test.ts`, describe "argus-live — findings end to end" (spawned CLI only):
  - "a candidate goes from an explorer's submit to a filed issue, and down leaves no secret outside the
    ledger": `appCycle()`
    with `double-release` on; `slot 1 --journey order-to-cash --accounts buyer.1=buyer1@example.test`;
    through spawned `pw`: `goto /storage`, `goto /orders/new`, place an order, `screenshot`, `submit` a
    return whose candidate holds the reversal repro; `repro 1.1.1` → exit 3, `run 1` and `run 2` lines,
    last line `REPRODUCED …`; `repro 1.1.1 --minimize` → `confirmed yes`; `repro 1.1.1 --test` → the
    file passes `stripTypeScriptTypes`; `classify --oracle reversal --stock` → its class line; a body
    quoting the session's HttpOnly `sid` → `scrub` exit 1 with a `body <line>:<col> cookie` line and no
    line holding the `sid`; a clean body with the screenshot → `scrub … --create --label bug` through
    `fakeGh()` → `filed: …`, gh's argv holds `--attach` and nothing under `traces/`; `down` →
    `logs/secrets.jsonl` kept (0600), no `.playwright/`, `state.json` or `lock` in any slot, no file
    under `r/out/traces/` (both runs exited 3), `repro/1.1.1/` kept, no process whose command holds the
    run id; after `down`, `scrub` of the `sid` body still exits 1 and of the clean body exits 0
    (scrub never needs the run live); neither any stdout nor any file left under
    `.argus/live/<run>/` holds `APP_PW`'s value or the slot token (the ledger holds neither: role
    passwords are configuration, matched from `.argus/live.json`, never recorded).
- [ ] **Step 2–4:** run (FAIL), implement, run both files and `npx vitest run` (PASS).
- [ ] **Step 5: Commit** `feat(sapu): argus-live repro, classify and scrub on the CLI, kept from the explorer by the guard, one cycle end to end`.

---

### Task 15: `map-check`, refresh triggers, the catalog

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
  - the guard seam test (`tests/argus-live-pw.test.ts`) gains `… map-check` and `… map-check --list`;
    the usage line gains `map-check [--list]`.
- [ ] **Step 2–4:** run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `feat(sapu): argus-live map-check keeps only journeys anchored in HEAD's code, names its refresh triggers and prints the catalog`.

---

### Task 16: map mode — `up --map`, map slots, the map return

**Files:** Modify `-map.mjs` (`validateMap`, `mergeMap`), `-slots.mjs` (`mintMapSlot`; `tokenSlot`
returns the slot's `mode`), `-pw.mjs` (a map token's two commands), `-return.mjs` (`submit` and `intake`
of a map return), `-instance.mjs` (`upMap`; `up`'s step 4 and `upMap` record `worktreeHead`;
`upFresh`/`renewRun` refuse a map run; `status`), `argus-live.mjs`
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
  worktree}`: `up` step 1 (lock, `sapu-live.log` start line, reaper, `dropLedgers`), step 4's worktree without
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
  <the run's worktreeHead>})`, then runs `map-check`. `worktreeHead` is a new run.json key, owned by
  `up`'s step 4 and `upMap`: the worktree's commit (`git -C <worktree> rev-parse HEAD`) once it is
  built, so a merge after `down` (the worktree gone) still stamps the code the map agent read, never
  MAIN's HEAD, which may have moved while the map was built (decision 20). A run without it → `refused:
  map-check --merge: run <id> recorded no worktree commit`.
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
  - "map-check --merge stamps the worktree's commit, not MAIN's HEAD": `up --map`, a commit on MAIN
    meanwhile, submit, `down`, `map-check --merge 1` → `.argus/journeys.json` `head` is the commit
    `up --map` built the worktree at.
  - "up --fresh and renew refuse a map run".
  - the guard seam test gains `… up --map`, `… slot 1 --map`, `… map-check --merge 1`; the usage line
    gains them.
  - "the guard lets the map agent Read committed files of a map run's worktree" (`tests/sapu-guard.test.ts`:
    run.json of a map run; the existing Read rule, unchanged, allows a committed file and refuses an
    untracked one).
- [ ] **Step 2–4:** run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `feat(sapu): argus-live map mode — up --map starts no app, a map token reads code and submits the map, map-check --merge writes it`.

---

### Task 17: SELECT — score and accounts

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
  - "users must be literal": a user `${BUYER_USER}` → the `${` refusal above, nothing selected.
  - the guard seam test gains `… select --cycle 1`; the usage line gains `select`.
- [ ] **Step 2–4:** run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `feat(sapu): argus-live select ranks journeys by the map's score and allocates accounts no two journeys share`.

---

### Task 18: doc drift

**Files:** Create `plugins/sapu/scripts/argus-live-drift.mjs`; Modify `plugins/sapu/scripts/argus-live.mjs`
(`drift`); Test `tests/argus-live-findings.test.ts`.

Interfaces:
- `export function drift(main, {doc, code}, {runner = run})` → `{verdict: "code-newer"|"doc-newer"|
  "undecidable", why?}`: `git blame --porcelain -L <a>,<b> -- <file>` per range; the newest
  `author-time` of the doc's lines against the newest of all code ranges' (decision 24); a line not committed
  (`0000000…`), a file with no history or a git failure → `undecidable` (`uncommitted lines`, `no
  history`), equal times → `undecidable (same time)`. Ranges `<repo-relative file>:<a>-<b>`, no `..`.
- CLI `drift --doc <range> --code <range> [--code <range>…]` → `code-newer → needs-owner`,
  `doc-newer → class B(a)` or `undecidable (<why>) → needs-owner`.

- [ ] **Step 1: Failing tests** (describe "argus-live doc drift"; a repo whose commits carry
  `GIT_AUTHOR_DATE`): doc at time T1, code at a later T2 → `code-newer`; reversed → `doc-newer`; the doc
  range edited and not committed → `undecidable (uncommitted lines)`; both in one commit → `undecidable
  (same time)`; a range with `..` → refused; "author time decides, not committer time": the doc
  authored at T1 but committed (`GIT_COMMITTER_DATE`, as a rebase leaves it) at T3 > T2, code
  authored and committed at T2 → `code-newer`.
  The guard seam test gains `… drift --doc a:1-2 --code b:1-2`; the usage line gains `drift`.
- [ ] **Step 2–4:** run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `feat(sapu): argus-live drift decides doc drift by line-level history`.

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
- The orchestrator scrubs and files **before `down`** wherever it can (scrub works after `down` too —
  the ledger survives it — but the next `up` removes the ledger, and an issue not filed by then cannot
  be scrubbed again), and runs `renew` before a long filing stretch so the lock's deadline does not
  end the cycle mid-filing. A scrub refusal names `<title|body> <line>:<col> <class>`: the orchestrator
  rewrites that place and scrubs again, never pastes the value anywhere to check it. An `incomplete`
  ledger means nothing of that run is filed; the journal says so.
- `journeys.md`'s claim-race template: each account of the `parallel` group proves its action with
  `visible` and `nth: 0` (decision 7); the `login` step's shape (decision 26).
- The explorer brief: repro lists use the five target kinds and `{{marker}}`; screenshots only as
  evidence (their verdict decides attachment); traces are never evidence in an issue.
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
    an uncaught error mapped to 2, a failed login (a configured account's: run.json `loginFailed`; a
    `login` step's: slot `r`'s `createdFailed`), a missing target (T8, decisions 4, 8, 26);
  - the `login` action: its shape, placeholders, the configured-user refusal, the `created password`
    class (T7, T8, T4 for `pw`'s, decision 26);
  - reproduce: after every explorer returned (phase 5's order), each candidate from `up --fresh`,
    twice, filed only at 2 of 2, 1 of 2 intermittent, a CLI trace kept for H2 diagnosis — begun after
    sign-in, never filed, pruned by `down` to the runs that exited 2 (T8, T9, decisions 9, 13);
  - minimize: one step or role at a time from `up --fresh`, a state-changing step with its `expect`,
    never a `trigger` or a role's only state-changing step, kept only on exit 3 with every remaining
    `expect`, at most `limits.minimize_runs`, where it stopped journalled, no browser work in the
    orchestrator's context (T7 `reductions`, T10);
  - classes and severity from the oracle (T9 `classify`); argus's adjustments, `Reachable-by`,
    `Automatable`, `Max <currency>`, `Blocked work:`, heuristic grounding, Nielsen's factors — the
    orchestrator's text (phase 5);
  - needs-owner: the label (phase 1); filing with it through `scrub --create --label` (T13);
  - scrub refuses each secret class — env_file, repo env files, role passwords and TOTP secrets,
    created passwords, cookies and `Authorization`/`Set-Cookie`/`*-Token` values the run saw, storage
    values, orchestrator variables — raw, URL-encoded, base64 and with whitespace and punctuation
    removed (T4 ledger and matcher, T12), narrowed by decision 14/17 to what is secret-like (a
    `SECRET_KEY` name, an HttpOnly/Secure cookie or a high-entropy value) where a source mixes
    configuration with secrets, short configuration secrets as whole tokens, and a refusal that says
    where and never what (T4, T12); the ledger complete or scrub refuses (T3 `Set`/`capBytes`, T4
    drains, T12), and alive after `down` (T4, T12, T14); redacts other 24+ letter-and-digit strings
    unless the run saw them as a URL path segment or a response-body value, never a token-like one
    (T3 raw ids, T4 `seenIds`, T12); page text in fenced blocks of at most 20 lines, mentions, `#N` and
    outside URLs defanged (T12);
  - screenshots attached only with gh ≥ 2.99, a private or internal repo, `traces` allowing it, and at
    capture time (after a drain, every frame read) a secret-free page and inputs, no password or
    one-time-code field, no error page, its bytes unchanged since; otherwise named locally (T13); a
    non-zero gh exit after the URL counts as filed (T13);
  - issue body additions: the generated Playwright test (T11); the trail, numbers and repro steps are
    the orchestrator's (phase 5), the files they come from are T8's records;
  - one defect per issue and `max_issues_per_cycle`: argus's gates, unchanged (phase 5's text).
- **Spec §6 coverage:** `map-check`'s every rule and its printed reasons (T15); refresh triggers and no
  second refresh for a recorded drop (T15); ids stable across a refresh (T16 `mergeMap`, `head` the map
  run's worktree commit); `global` selected alone, the score, account allocation and waiting (T17);
  the catalog (T15); the map built by the explorer in map mode through `submit` (T16) — kept in this
  phase because §6 needs the map returned through `submit` without the app, and ordered after the core
  path (T14).
- **Spec §14 coverage:** "Repro" — each seeded defect 3 and its fix 0 (T8: one `it` per defect, on and
  off) with its class row (T9: "each seeded defect's class line", one exact `classify` line per defect
  T8 reproduces), the claim race through `parallel` with two accounts (T8), viewport at 390 not 1440
  (T8), the delayed handoff (T8), exit 2 on a broken target, a dropped prerequisite, a missing proving
  `expect` and an uncaught error (T8), a run's records absent from the next (T8, the count read after
  `goto /inbox`), quoted values as literals (T8, through the fixture's echoed note), minimize never
  dropping a `trigger` and keeping only exit-3 reductions (T7, T10, its stub answering 3 only while the
  essential steps remain), 2 of 2 (T9), the golden test (T11, the golden file written by hand first).
  "Scrub" — each class in each encoding in title and body (T12), the HttpOnly cookie (T14), cuid/ULID
  kept and unknown tokens redacted (T12), defanging (T12), screenshots not attached for a public repo,
  an older gh, a password field or an error page (T13), the URL rule (T13). "`map-check`" — every
  listed case, the refresh triggers, stable ids, `global`, allocation, `list` starting nothing
  (T15–T17). "Doc drift" — code newer, doc newer, no history, and the needs-owner label on the issue
  (T18, by author time; T13's label pass-through).
- **Carried from phase 3:** the ledger (T4), the driver (T2), slot `r` (T5), `-origin.mjs` (T1),
  `loginFailed` for repro (decision 4, T8), the instance split (T1), the in-daemon listener probed and
  built (T3).
- **The QA review of 9e46024, and where each finding went:** scrub over-refusal → decisions 14, 17,
  T4, T12; short secrets → decision 17, T4 `secretHits`, T12; ledger loss → decisions 14, 16, T3, T4;
  ledger lifecycle → decision 14, T4, T12, T14, the §12 row, "Carried to Phase 5"; traces → decision
  13, T8, T13, T14; seen-id exemption → decision 15, T4; the `login` step → decision 26, T7, T8, T6
  signup; T10's stub, T8's count, T6's echo → fixed in place; claim-race `nth: 0` → decision 7, T8;
  4xx console lines → decision 11; screenshot `sha256`, drain before `shot`, frames → decision 18,
  T13; `saved` in `run-<i>.json` → decisions 2, 12, T8; `mergeMap`'s `head` → decision 20, T16; the
  `saved_` prefix → T11; author time → decision 24, T18; T3's listener delta → T3; T11's golden file
  by hand → T11; the §14 claim for T8 → made true by T9's per-defect class lines; the ledger's
  imports → the DAG statement (`run` for `logsDir`). Not changed: Tasks 1, 2 and 5 (cleared to start).
- **Names defined once:** `exactHost`, `canonicalOrigin`, `originOf`, `BLOCKED_ERROR`, `checkUrl`,
  `sessionDriver`, `maskSecrets`, `configuredUser`, `drainSessions`, `MIN_SECRET`, `MAX_SECRET`,
  `SECRET_KEY`, `SEEN_SKIP_KEY`, `LEDGER_CLASSES`, `highEntropy`, `ledgerFile`, `ledgerEntries`,
  `appendLedger`, `readLedger`, `dropLedgers`, `seenFile`, `seenIds`, `appendSeen`, `readSeen`,
  `secretHits`, `FINAL_KINDS`, `parseRepro`, `substitute`, `stepCode`, `reductions`, `reproRef`,
  `runOnce`, `repro`, `minimize`, `pruneTraces`, `redTest`, `CLASSES`, `classify`, `scrubSecrets`,
  `redactIds`, `defang`, `attachVerdict`, `scrub`, `JOURNEYS_FILE`, `readJourneys`, `validateMap`,
  `mapCheck`, `refreshReasons`, `catalog`, `mergeMap`, `score`, `selectJourneys`, `upMap`,
  `mintMapSlot`, `drift`.
- **Interfaces shared with earlier phases:** run.json is still written only through `updateRun`, each
  key by its owner (`mode` by `up --map`; `worktreeHead` by `up`'s step 4 and `upMap`; `slots` by the
  slot writers); the guard's explorer rules are unchanged and its seam test grows (T14–T18); `pw`'s
  output is unchanged byte for byte (T2); `down`'s new work (drain, `pruneTraces`) runs inside the
  existing teardown, and what it keeps (`logs/`, `returns/`, `repro/`) only grows by the ledger.

## As built (phase 4)

- **Task 1.** `shown` (how a refusal shows an explorer's argument) moved with `checkUrl` and is
  exported from `-origin.mjs`: `pw`'s `checkArg` words its other refusals with it too, so it is
  imported, not copied. `-start.mjs` imports `config`, `egress`, `endpoints`, `lock`, `proc`, `run` and
  `sapu-contract.mjs`; `-instance.mjs` keeps `up`, `up --fresh`, `renew` and `status` (523 lines), its
  header the DAG above, with the modules later tasks add named in their places. `canonicalOrigin`'s own
  default ports fill `ws:` and `wss:` too (the endpoints table has neither); no caller passes them.
- **Task 2.** `credentials` is optional: by default the driver's `credentials()` (also exposed, `pw`
  reads it for the HARNESS check) is those of an account the journey created (the slot's state.json
  `created`), else the allocated user's from `slotRec`, so the lookup moved out of `pw` whole.
  `failures` reaches `login` for a created account only (never as `null`, which would replace login's
  default). `gone(res, record)` holds `pw`'s whole test, a failed command first. `relogin(o)` closes
  the record `ensure()` (or the last open) gave, as `pw` did. `createdFailures` stays in `pw` (its
  writes re-check the run under `pw`'s `ifLive`) and is passed as `failures`; `logProbe` and
  `NOT_OPEN` moved to the driver. The tests' CLI is the shim behind a wrapper whose `open` leaves a
  stand-in daemon (a process whose command names `cliDaemon.js <session>`), which `openSession`
  records and `down` stops.
- **Task 3.** The probe, re-run with the pinned CLI and the local Chrome: a `run-code` hook whose
  `ctx.on("page")` listener evaluates the signal script at every `domcontentloaded` caught `Linked ready`
  in the linked popup; the hook added one `request` and one `page` listener (the CLI holds a `page`
  listener of its own), and a second hook call answered `{installed: false}` and added none. The plan's
  popup test passes without the hook (the click's own observation evaluates the signal script in the
  popup long before its 4 s toast), so the fixture's `/popup` gained the link "Open quick details"
  (`/popup/quick`, a toast 200 ms after load, gone 300 ms later) and both popup tests use it: they fail
  without the hook. The header-once test drives buyer.1's session driver in-process (`pw` keeps no drain
  until Task 4), and the small cap is that session reopened by a driver with `capBytes: 64`.
  `ensure()` answers `{record, opened, events}` (`harness: hook failed`), which `pw` prints with its
  other events; `reopen` and a login-command role's re-login add them too. In the page the hook keeps
  only path segments and JSON leaves of the id shape (24+ characters, a letter and a digit) and drops a
  pair already pending, so the 2000 per drain hold ids, not every segment; `runOrigins` are spelled as
  `URL.origin` spells them. The fixture keeps both bearers and the jwt in `bearer.json` as `{bearers,
  jwt}`. Phase 3's `browserRun`, its pw-in-Chrome run (`pwBrowserRun`) and the Chrome suites' cleanup
  (`browserCleanup`, `browserLeftovers`) moved to the helpers file.
- **Task 4.** A Cookie header's pairs and a Set-Cookie value's first pair are class `header` (the
  plan's test lists them there); the context's cookies are class `cookie`. `-run.mjs` sits below the
  ledger, so a teardown without a `drain` (a test's `down`, and recovery) appends its own marker,
  `<session> closed undrained`, one per recorded session with a daemon, to `logs/secrets.jsonl` itself.
  `up`'s failure path (`tearDown`) passes the drain to its `down` too. `drainSessions` takes `js` (else
  run.json's) and `capBytes`; `CAP_BYTES` is exported from `-session.mjs`, the driver's default. `observe()`
  keeps its drain through one helper (`keepDrain`: the ledger, the overflow marker, `seen.jsonl`), the
  one `drainSessions` uses. `appendLedger` creates the file even with nothing to add (a drained run has
  a ledger, so scrub's "gone" means a later `up` removed it) and skips empty values; `seen.jsonl` holds
  one JSON string a line (0600). `secretHits` takes the stripped form only when the stripped value is
  at least `MIN_SECRET` long, else matches that stripped value as a short one (whole token), so a value
  of punctuation and a few letters never matches inside every word. `pw` sets `drained: false` right
  after `ensure()` (a sign-in and a `login` run in the context too), so a reopen inside a call marks the
  session lost; `reopen` checks the state before the open replaces it. `drainSessions` reads a record's
  account state from the record's `cwd` (its slot's directory). Phase 3's `cycle()` (a full `up` of the
  fixture through the CLI) moved to the helpers file as `appCycle({clerk, mark})`, with `fixtureProcs`;
  the ledger's cycle tests run `down` and `up --fresh` through the CLI, and assert first that the `pw`
  call's own drain ran before the page's second bearer.
- **Task 5.** "up --fresh closes repro sessions" is an `r` record added to phase 3's `up --fresh` test
  in `tests/argus-live.test.ts` (its title now names the repro sessions): `upFresh` needs a whole
  instance, which that file's harness brings up; the findings file holds slot `r` itself, the
  instance-id rule and `down`. `openSession`'s, `sessionName`'s and the teardown's slot-file pass
  comments name slot `r`.
- **Task 6.** `--facts` prints `{status, quantity, stock, claims}`, so phase 3's facts tests read the two
  new fields too. A refused order action (cancel, claim, approve, ship) answers 409 with the order page
  and an alert, so a proving expect on the order number holds in both variants; cancel is the order's
  buyer's, claim, approve and ship a clerk's (403 otherwise), `/inbox` a clerk's (403), and ship needs
  `approved` (409). Approve's hidden `rendered` field is sent, never read: the fixed variant checks the
  order itself. `/signup` does not sign the browser in. Task 8 gave the inbox `/inbox/rows` and a 500 ms
  refresh of its rows (shown anew only when they changed): on a static inbox page an expectation's poll
  cannot see a handoff that lands 2000 ms after the order, so the delayed-handoff test would prove nothing.
- **Task 7.** `-steps.mjs` imports, beyond the plan's four, `-session.mjs` (`configuredUser`),
  `-slots.mjs` (`accountOf`) and `-origin.mjs` (`BLOCKED_ERROR`), all to its left in the DAG; the DAG
  test pins that list and that it reaches neither `pw` nor `instance`. A context fault reads `refused:
  repro: context: <reason>`. A parallel group's members are numbered as steps and carry `group`
  (1-based). Reasons the plan did not word: `the last step must be an expect naming its oracle (final)`,
  `final is not an oracle`, `save takes a name (…, not marker)`, `press takes a key (…)`, `<kind> takes
  <fields>`, `count takes a target and a whole number`, `url takes a path (/…)`, and a trigger's own
  `trigger changes state: an expect must follow before the next state-changing step`; a trigger's literal
  values meet its regexes before any browser work, in `fillArgv`'s words. `provingExpect(steps, n,
  changed)` and `CLICKS` are exported (the runner and `reductions` share them). Every answer of a step
  template leaves through `finish`, which drains, a throw included (the test pins that structure); an
  expectation also answers `shown` (what the page showed: the URL, the count, the text) and `observed:
  "error"` when its last poll threw (a strict-mode violation), which the runner never counts as
  reproduced. Phase 3's target-shape regex cannot hold a `}` inside a quoted name, so the DSL test's copy
  lets the options hold JSON strings.
- **Task 8.** Probe (the pinned CLI, the local Chrome): `tracing-start` and `tracing-stop` write
  `trace-<ms>.trace`, `.network` and `.stacks`, `resources/<sha1>.<ext>` and
  `screencast/page@<id>-<ms>.jpeg` under `<outputDir>/traces/`; a step template's click on a form that
  POSTs answered `changed: true, method: "POST"`, a count expectation `observed: "count:1", shown: 1`, a
  text-equals `held`. `run-<i>.json` also holds `changed` (the click-family steps that changed state,
  minimize's input, decision 10), and `traces` names the run's new files plus every `resources/` file
  (a resource is written once and shared by later traces); `pruneTraces` runs in the teardown's "the
  run's directories" step, so `TEARDOWN_STEPS` is unchanged. A ref `reproRef` refuses is thrown as a
  refusal (the CLI's exit 1), not a HARNESS; a `fresh` that throws without a step is `HARNESS: failed:
  <message>`. The CLI prints each line as it is made (`say`). The runner holds slot `r`'s lock for the
  whole run. A failing step of a signed-in account checks the session first (`observe`, then a probe):
  gone → `HARNESS: step <n> <role.k> lost its session`; a hook that failed at an open → `HARNESS: step
  <n> <role.k> hook failed`; any other failed action → `HARNESS: step <n> <action> failed
  (timeout|error)`. `keepDrain` is exported from `-session.mjs`. The tests run each repro as a candidate
  of one return (`candidate(main, {slot, accounts, repros})` → the refs; one cycle per test) through the
  CLI, with `appCycle({repro: true})`; `clerk.1` is clerk2 and `clerk.2` clerk1, so only the claim race
  waits for a TOTP step. The delayed-handoff run opens the clerk's inbox before the order is placed (and
  shares the viewport test's cycle); the trace test and the `down` test are one test.
- **Task 9.** `repro` passes its other options through to `once` (the CLI gives `say`, so each run's lines
  are printed as they are made) and leaves a fence whole: only the lines outside it get `run <i> `. An exit 3
  whose last line is not a valid `REPRODUCED …` reads `HARNESS: run <i>: exit 3 without its REPRODUCED line`,
  any exit but 0, 2 and 3 `HARNESS: run <i>: exit <k>`; `verdict.json` is 0600. `classify`'s `because`
  words are the table row's (`dead end on a money journey`, `handoff signal with no written rule`, …);
  a flag that does not move an oracle's row is accepted and ignored (`reversal --stock` is S1 either way),
  a flag given twice is refused. The CLI reads `labels.needsOwner` through `loadContract` (none → the
  default; an invalid contract is refused, as `up` refuses it).
- **Task 10.** "Same `final`" is read as "fails the final the way the reproducing run did": the same
  `expected`, `observed` and `shownSha256`, a digest `runOnce` now records in `run-<i>.json` of what the
  failed final showed, the values of the placeholders the final names (`{{marker}}`, a saved id) put back
  as those placeholders. Without it the reversal repro loses its cancel: with no cancel the stock is 2 under
  `{{before}}`, with the defect 2 over, and both fail `fact-equals` as `differs`. The base is the newest
  `run-<i>.json` of the whole list that exited 3 (refused without one: `refused: repro: <ref> has no
  reproducing run (repro <ref> first)`), not `verdict.json`, so a `--once` run is enough to minimize from;
  `run-<i>.json` gains `reduced` (a run of a minimizer's list), which is never a base. Each try and the
  confirm run is a `runOnce` numbered after the candidate's records (`run-<i>.json` as `pruneTraces` reads
  them), and `repro.json` is written only by a run of the whole list. Each unit is tried once (by its
  label, numbered as the whole list is): with none left untried it stopped at its fixpoint; the budget is
  checked before a unit, so a unit the static checks would skip still counts as budget-stopped. A skipped
  unit's line is `try <label>: skipped (the static checks refuse it)` (a reason would name the reduced
  list's step numbers) and its `tried` exit `null`. `min.json` always starts with the context element (the
  parsed context, defaults included) and is removed when a later minimize does not confirm. The fixture's
  repro cycle sets `limits.minimize_runs` 6, so the Chrome test stops at its budget after the four pads and
  the cancel: it puts the pads after the cancel's proving expect, where minimize starts.
