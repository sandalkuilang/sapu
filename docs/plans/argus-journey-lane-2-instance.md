# Argus journey lane — Phase 2: Instance — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `argus-live.mjs up | up --fresh | renew | down | status` start and stop an isolated
instance of the repo's app — its own worktree outside the repo, environment, ports, datastore and
services — that never touches the owner's servers, services or data, and always gets torn down.

**Architecture:** Three zero-dependency Node ESM modules in `plugins/sapu/scripts/`:
`argus-live-config.mjs` (load, validate and expand `.argus/live.json`), `argus-live-instance.mjs`
(lock, live log, ports, worktree, environment, processes, health, store, Compose and egress checks,
run files, reaper, teardown, recovery) and the CLI `argus-live.mjs`. Every external command goes
through one injectable runner so tests can substitute shims (`docker`, `lsof`). A fixture app under
`tests/fixtures/journey-app/` plays the repo's app. Logins (§8 step 10) and the filtering proxy
(step 9) arrive in phase 3; phase 2's `up` ends after the egress check and the run files.

**Tech Stack:** Node ≥ 20 ESM (`node:child_process`, `node:net`, `node:fs`, `node:crypto`), Bash,
git worktrees, vitest.

Spec: [docs/specs/argus-journey-lane.md](../specs/argus-journey-lane.md) §8 (all of it), §12 (the
instance rows), §14 ("`up`", "Egress", "Lifecycle"). Phase 1 interfaces this phase must honour:
- the guard reads `<MAIN>/.argus/live/run.json` → `worktree` (absolute path) — `sapu-guard.mjs`
  `liveWorktree`;
- `sapu-merge.sh` reads `<MAIN>/.git/sapu-live.log`: `<run> start <epoch s> deadline <epoch s>` (at
  lock time), `<run> deadline <epoch s>` (each renew), `<run> end <epoch s>` (failed `up`, `down`);
  run ids unique — `live_overlap`;
- role names match `^[a-z][a-z0-9_-]*$`; `anon` and `system` are reserved.

Every path under `.argus/live/` is resolved from `<MAIN>` (`findMain` from `sapu-contract.mjs`),
never from the session's cwd.

---

## File structure

| File | Responsibility |
|---|---|
| `plugins/sapu/scripts/argus-live-config.mjs` | `loadLive(main)`: read `.argus/live.json` and `env_file`; `validateLive(obj)` → errors (unknown keys, types, role names, reserved roles, required keys, `confirmed`, local `base_url`); `expand(value, {ports, secrets})` for `{port:<name>}`, `{port:<name>=<n>}`, `${NAME}` |
| `plugins/sapu/scripts/argus-live-instance.mjs` | `run(cmd, opts)` injectable runner; lock and live log; `allocatePorts`; `makeWorktree`; `instanceEnv`; `startEntry`/`waitHealth`; `checkStore`; `checkCompose`; `checkEgress`; `writeRunFiles`; `startReaper`; `down`; `recover`; `up`; `upFresh`; `renew`; `status` |
| `plugins/sapu/scripts/argus-live.mjs` | CLI: parses `up [--fresh]`, `down`, `renew`, `status`; prints one line per step; exit codes 0 ok, 1 refused (reason printed), 2 failed (step and quoted error printed) |
| `tests/fixtures/journey-app/server.mjs` | the fixture app's server: `PORT`, `DATA_DIR` (its "store"), `CACHE_URL` (else connects to a fixed loopback port 46379), `/health`, `--which-store`, `--reset` |
| `tests/argus-live.test.ts` | all phase 2 tests |

The plugin has no dependencies: no YAML, no npm packages. JSON only.

---

### Task 1: config — load, validate, expand

**Files:** Create `plugins/sapu/scripts/argus-live-config.mjs`; Test `tests/argus-live.test.ts`.

Interfaces:
- `export function validateLive(c)` → `string[]` (empty = valid). Keys exactly those of spec §8's
  example (`setup, services, start, base_url, login_url, logged_in, env_file, env, pass_env, store,
  store_check, reset, facts, mail, triggers, confirmed, allow_origins, port_range, reserved_ports,
  login_spacing_ms, timezone, locale, fixtures, roles, viewports, locales, settle_ms, prohibited,
  limits`); unknown keys at any level of the known objects are errors.
- Required: `start` (non-empty), `base_url`, `login_url`, `logged_in`, `store`, `store_check`,
  `reset`, `confirmed` with `mocks === true` and `data === true`, `roles`, `limits.max_cycle_minutes`.
- `start[]`: `{name, cmd, phase?: "store", stop?, env?, health?: {url}|{cmd}}`, unique names.
- `roles`: keys match `^[a-z][a-z0-9_-]*$`; `anon` allowed only as `{}`; `system` refused as a key;
  a role has `users: [{user, password, totp_secret?}]` (non-empty) or `login: {command}`, not both
  (except `anon`).
- `facts`, `mail`, `triggers.<name>`: `{argv: string[], args?: string[]}`; every `args` entry compiles
  as a RegExp.
- `export function expand(value, {ports, secrets})` → string: `{port:<name>}` → `ports[name]`;
  `{port:<name>=<n>}` → `n` (and records the fixed port); `${NAME}` → `secrets[NAME]`; an unknown
  `${NAME}` throws `unset NAME` (the name only, never a value).
- `export function parseEnvFile(text)` → object (`KEY=value`, `#` comments, optional quotes).
- `export function loadLive(main)` → `{config, errors, secrets}` reading `<main>/.argus/live.json` and
  `<main>/<env_file>`.

- [ ] **Step 1: Write the failing tests** — in `tests/argus-live.test.ts`, a describe "argus-live
  config" with: the spec §8 example (as a JS object in the test) is valid; each required key missing
  → an error naming it; an unknown top-level key and an unknown key inside a `start` entry → errors;
  `confirmed.mocks: false` → error; role `customer.2` and `Sales` → errors; role `system` → error;
  `anon: {users: […]}` → error; a role with both `users` and `login` → error; duplicate `start`
  names → error; a `triggers` `args` entry `"("` → error; `expand("x{port:web}y", …)` → port
  substituted; `expand("{port:db=5433}", …)` → `5433`; `expand("${PW}", {secrets: {PW: "s"}})` → `s`;
  `expand("${NOPE}")` throws `/unset NOPE/` and the message holds no secret value; `parseEnvFile`
  handles comments, blank lines, `KEY="a b"`, `KEY='x'`.
- [ ] **Step 2: Run** `npx vitest run tests/argus-live.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement** `argus-live-config.mjs` to the interfaces above.
- [ ] **Step 4: Run** the file, then `npx vitest run` → PASS.
- [ ] **Step 5: Commit** `git add plugins/sapu/scripts/argus-live-config.mjs tests/argus-live.test.ts`;
  `git commit -m "feat(sapu): argus-live config — load, validate and expand .argus/live.json"`.

---

### Task 2: lock, live log, renew

**Files:** Create `plugins/sapu/scripts/argus-live-instance.mjs` (first part); Test `tests/argus-live.test.ts`.

Interfaces:
- `export function takeLock(main, {maxCycleMinutes, now})` → `{runId, start, deadline}`; writes
  `<main>/.argus/live/lock.json` `{runId, start, deadline}` and appends
  `<runId> start <start> deadline <deadline>` to `<main>/.git/sapu-live.log` (epoch seconds,
  `deadline = start + maxCycleMinutes*60 + 900`). Run id: `<yyyymmddhhmmss>-<8 hex>` (unique).
  A lock whose deadline is in the future → throws `refused: cycle <runId> holds the lock until <iso>`.
  A lock past its deadline → returns `{stale: <old lock>}` alongside, for `recover` (Task 7). A lock
  naming run R is replaced or removed only by the holder of `.argus/live/claim-<R>.json` (created
  with link(2)); a takeover keeps that claim as R's record for `recover`, which must also honour
  the claim rule when `down` removes a lock. If the live-log append fails, the lock is rolled back.
  `maxCycleMinutes` is 1–1440 and lock times must be sane epochs, else `refused:`.
- `export function renew(main, {runId, maxCycleMinutes, now})` → refuses when the lock names
  another run; new deadline = `min(deadline + maxCycleMinutes*60, start + 3*maxCycleMinutes*60 +
  900)`; under `claim-<runId>.json` re-reads the lock, appends `<runId> deadline <new>`, rewrites the
  lock; when the deadline cannot move (cap reached) throws `cap reached`.
- `export function appendEnd(main, runId, now)` appends `<runId> end <now>`.

- [ ] **Step 1: Failing tests** — a temp git repo as MAIN: `takeLock` writes the lock and one start
  line matching `^\d{14}-[0-9a-f]{8} start \d{9,10} deadline \d{9,10}$`; a second `takeLock` with a
  live lock throws `refused`; a lock with a past deadline is returned as `stale`; `renew` appends a
  `deadline` line and caps at start + 3 × max + 15 min; `appendEnd` appends `end`; **seam test**: for a
  renewed run, the exact awk of `live_overlap` (read it out of `plugins/sapu/scripts/sapu-merge.sh`
  between the `awk -v s="$1" -v e="$2" '` line and its closing `'`, run with `/usr/bin/awk` or `awk`
  over the written log) reports overlap for a gate after the first deadline and before the renewed
  one.
- [ ] **Step 2–4:** run (FAIL), implement, run file and suite (PASS).
- [ ] **Step 5: Commit** `feat(sapu): argus-live lock, live log and renew`.

---

### Task 3: ports

Interfaces:
- `export async function allocatePorts(names, {range: [lo, hi], reserved, fixed, probe})` →
  `{<name>: port}`. Free = a `net.createServer().listen(port, "127.0.0.1")` succeeds and is closed
  again; skips `reserved`; a `fixed` port (`{port:<name>=<n>}`) that is taken → throws
  `refused: port <n> (<name>) is taken by <process>` with the holder from `lsof -nP -iTCP:<n>
  -sTCP:LISTEN` (or `ss -ltnp`), `unknown` when neither is available.
- Names come from every `{port:<name>}` in the expanded config strings (collect before expanding).
- `validateLive` requires `port_range` whenever a `{port:<name>}` is used; `allocatePorts` refuses
  (never crashes) without one. One port fixed for two names, or one name fixed at two ports, is
  refused by both `portNames` and `allocatePorts`.

- [ ] Tests: allocation avoids `reserved` and a port held by a test listener; a fixed taken port →
  refused naming the holder (the test's own node process); range exhaustion → refused; collecting
  names from the spec example yields `api, web, pg, redis, smtp`.
- [ ] Run (FAIL) → implement → run (PASS) → commit `feat(sapu): argus-live port allocation`.

---

### Task 4: worktree outside the repo, setup, environment

Interfaces:
- `export function makeWorktree(main, runId)` → absolute path `$TMPDIR/sapu-live/<repo>-<runId>` via
  `git -C <main> worktree add --detach <path> HEAD`; the path's parent created; returns
  `fs.realpathSync.native(path)`.
- `export function instanceEnv({config, ports, secrets, runId, home})` → a plain object holding ONLY
  `PATH, USER, SHELL, TMPDIR, LANG, LC_*` (from `process.env` when set), each `pass_env` name, every
  expanded `env` entry, `COMPOSE_PROJECT_NAME=argus-<runId>` (lower case, `[a-z0-9_-]`), and
  `HOME=<home>` (`makeHome(main, runId)`: an empty directory `$TMPDIR/sapu-live/<repo>-<runId>.home`,
  mode 0700, outside MAIN, so a setup may link into it). `$TMPDIR/sapu-live` is created 0700 and
  refused when it is a symlink, another user's, or inside MAIN (checked again after realpath).
- `export function runSetup(worktree, config, env, {deadline, secrets, log})`: each `setup` argv via
  `spawnSync` with `{cwd: worktree, env}`, no shell, its output appended to `log` (default
  `<worktree>.setup.log`), each bounded by the time left before the lock's `deadline` (`failed:
  setup <cmd> timed out`), every non-empty `secrets` value masked as `***` in any message; then
  `refuseLinksIntoMain(worktree, main)`: walk the worktree (skip `.git`), any symlink whose target,
  followed through every link (broken ones too), is inside `<main>` or contains it (an ancestor,
  `/`) → throws `refused: <link> points into the main checkout`.

- [ ] Tests: the worktree is outside MAIN, at HEAD, holds no gitignored file (a `.env` written in MAIN
  and ignored there is absent in the worktree); `instanceEnv` contains no other variable (set a
  sentinel `ARGUS_TEST_LEAK=1` in `process.env` and assert it is absent), `HOME` is the empty dir,
  `COMPOSE_PROJECT_NAME` is set; a `setup` argv runs with that env (the fixture `setup` writes
  `printenv` output to a file in the worktree; assert the variable set); a symlink into MAIN created
  by `setup` → refused.
- [ ] Run (FAIL) → implement → run (PASS) → commit `feat(sapu): argus-live worktree outside the repo and a minimal environment`.

---

### Task 5: fixture app, processes, health, store

Fixture `tests/fixtures/journey-app/server.mjs` (no dependencies): `node server.mjs` listens on
`PORT`; `GET /health` → 200; stores state under `DATA_DIR`; `node server.mjs --which-store` prints
`basename(DATA_DIR)`; `node server.mjs --reset` empties `DATA_DIR` and writes `seed.json` (refusing
when `basename(DATA_DIR)` does not end in `_explore`); connects (TCP, keeps the socket) to
`CACHE_URL` (`tcp://127.0.0.1:<p>`) or, when unset, to `127.0.0.1:46379`; `--spawn-child` starts a
grandchild process that also sleeps (for the process-group test).

Interfaces:
- `export function expandConfig(config, {ports, secrets})` (config module) → a deep copy with every
  string expanded; everything below takes the expanded config. Shell fields (`store_check`, `reset`,
  `start[].cmd|stop|health.cmd`, `roles.<r>.login.command`) go through `expandShell`: `${NAME}` →
  a reference to `ARGUS_SECRET_<NAME>`, quoted for its context; `secretEnv(cmd, secrets)` gives that
  command (and only it) the values. Recorded cmdlines therefore never hold a secret; setup's are
  recorded with secrets masked.
- `export async function startEntry(entry, {worktree, env, logs, groups})` → `{pid, pgid, log, exit}`:
  refuses first when the entry's health already answers (a `url` that responds: `refused: something
  already serves <url>`; a `cmd` that exits 0 within 5 s) and when its `env` names HOME or
  COMPOSE_PROJECT_NAME; then `spawn("/bin/sh", ["-c", cmd],
  {cwd: worktree, env: {...env, ...entryEnv}, detached: true, stdio: [ignore, log, log]})`, logged to
  `<logs>/<name>.log` (`up` passes `.argus/live/<runId>/logs`); `pgid = pid`, pushed to `groups`.
- `export async function waitHealth(entry, started, {timeoutS, aliveAfterMs, worktree, env})`: `{url}`
  → GET until 2xx; `{cmd}` → run until exit 0; omitted → alive after `aliveAfterMs` (5 s). A process
  that exits before health passes → throws unless it exited 0 and the entry has `stop`.
- `export async function checkStore({config, env, worktree, main, contract, deadline, timeoutS,
  composeServices})`: refuses a `store` that `guard.postgres` protects; runs `store_check` (shell,
  cwd worktree, bounded by `timeoutS`, its group killed after, stdout read until the process exits
  plus a short drain) under `env` and again under each start entry's own env → each trimmed stdout
  must equal `store`. Then (defence in depth) every value in `env` and in every `start[].env` is
  read and must not reach what MAIN's env files name (`.env`, `.env.local`, the contract's
  `guard.envFiles`): a non-http service on the same host:port whatever its database (no opt-in; an
  endpoint without host or port never matches, except a libpq or MySQL-family value with no host,
  which is the local server on its default port; a single-label host in `composeServices` is exempt);
  an http(s) URL equal up to its query, or on the same loopback endpoint, unless its origin is in
  `allow_origins`; a file or socket path equal to one they name, or any path inside MAIN. `X_HOST` +
  `X_PORT` are one endpoint, a bare instance `*PORT` a loopback one. Nor may it name a port or
  database `guard.postgres` protects (bare port numbers; bare database names only under
  `PGDATABASE`, `*_DB`, `*DATABASE*`, `*_DB_NAME`, `*_DBNAME`) → else throws `refused: …` naming the
  key only. Hosts are compared by name (canonical, loopback merged); resolving a host name to
  loopback is `up`'s job (Task 8).
- `export async function bringUpStore(ctx)` / `bringUpRest(ctx)`: the order inside `up` — store-phase
  entries (started and healthy one by one) → `checkStore` → `reset` (its group recorded too); then
  the remaining entries → health → `checkStore` again. Every group lands in `ctx.groups` as it starts.
- Setup in process groups (carried from the Task 4 review): `runSetup` spawns each `setup` argv
  asynchronously and detached (its own process group), records its pgid before waiting, and on a
  timeout or a failure kills the whole group (`kill -pgid`). Every setup group stays recorded, so
  a setup that leaves a daemon behind in its group is also killed at `down` (Task 7). Test: a
  timed-out setup with a grandchild leaves no process.

- [ ] Tests (fixture app): a `phase: "store"` entry starts first (its log line precedes `reset`);
  `checkStore` refuses a `store_check` printing another name and `reset` never runs (a sentinel file
  in `DATA_DIR` survives); an `env` URL equal to one in MAIN's `.env` → refused naming the key;
  health `url` already answering → refused; an entry exiting at once without `stop` → fails, with
  `stop` → passes; health timeout → fails naming the entry.
- [ ] Run (FAIL) → implement → run (PASS) → commit `feat(sapu): argus-live processes, health and the store check; fixture app`.

---

### Task 6: Compose and egress checks

Carried from the Task 5 review: the Compose check passes the worktree's Compose service names
(`docker compose config --format json` → `services` keys) to `checkStore` as `composeServices`,
whose single-label hosts are then the instance's own; and it refuses a Compose project that joins an
`external` network (its services could reach, or be reached as, the owner's).

Interfaces:
- `export function checkCompose({worktree, env, ports, run})`: when the worktree has `compose.yaml`,
  `compose.yml`, `docker-compose.yaml` or `docker-compose.yml`, run `docker compose config --format
  json` (cwd worktree, env) and refuse when any service has `container_name`, or publishes a host
  port (`ports[].published`) not among this run's allocated ports.
- `export function checkEgress({pids, allowed, run})`: `lsof -nP -a -i -p <comma pids>` (else
  `ss -tnp`), parse established/connect TCP endpoints; allowed = the run's ports on loopback, every
  host:port named by a URL in `env`, and each `allow_origins` host:port; anything else → throws
  `refused: <process> (<pid>) connects to <host:port>`. Missing both tools → throws `refused: neither
  lsof nor ss is available`. The pids are every process in the run's process groups (`ps -o pid=
  -g <pgid>` on Linux, `pgrep -g <pgid>` on macOS).

- [ ] Tests: a fake `docker` on `PATH` (a shell script in a temp dir printing JSON) — a published host
  port outside the run → refused; a `container_name` → refused; a compliant config → passes;
  egress: start the fixture app with no `CACHE_URL` while a test listener holds 46379 → refused
  naming 46379; with `CACHE_URL` pointing at a run port → passes; a fake `PATH` without lsof/ss →
  refused.
- [ ] Run (FAIL) → implement → run (PASS) → commit `feat(sapu): argus-live Compose and egress checks`.

---

### Task 7: run files, reaper, down, recovery

Interfaces:
- `export function writeRunFiles(main, state)`: `.argus/live/run.json` = `{runId, instanceId,
  worktree, ports, origins, groups: [{name, pgid, cmdline}], stops: [{name, cmd, cwd, env}],
  sessions: []}` (written with mode 0600; `worktree` absolute, matching the guard's `liveWorktree`).
- `export function startReaper(main, runId)`: `spawn(process.execPath, [<argus-live.mjs>, "reap",
  runId], {detached: true, stdio: "ignore"}).unref()`; `reap` sleeps until the lock's deadline
  (re-reading it, so `renew` moves it), then runs `down` only when `lock.json` still names `runId`;
  exits without acting otherwise. Its pid goes into `run.json` as `reaper`.
- `export function down(main, {runId})`: replays each stop record exactly (shell, recorded cwd and
  env); SIGTERM every recorded group (`process.kill(-pgid)`), SIGKILL after 10 s; kills the reaper;
  `git worktree remove --force <worktree>` only when `<worktree>` is the run's own (path under
  `$TMPDIR/sapu-live/`); removes the run's HOME (`$TMPDIR/sapu-live/<repo>-<runId>.home`) and its
  `<worktree>.setup.log`; removes `run.json` and `lock.json`; appends `end`.
- `export function recover(main, stale)`: for a stale lock: replays only stop records whose `cwd`
  exists and whose `env.COMPOSE_PROJECT_NAME` is `argus-<runId>` (others journalled, never run);
  kills a recorded group only when `ps -o command= -p <pgid>` still equals the recorded `cmdline`;
  removes the old worktree and its HOME; appends `end` for the old run.
- Stop records replay their `cmd` with `secretEnv(cmd, secrets)` (a stop is a shell field: its
  recorded command holds variable references, never values).
- Process groups: `down` and `recover` kill every recorded group, the setup groups included
  (`kill -pgid`, SIGTERM then SIGKILL), so a daemon a setup left behind in its group dies too.
- Stale records (carried from the Task 2 review): `recover` (and `takeLock`'s return) scans every
  `.argus/live/claim-*.json` that has a `lock` field whose run is not the current lock's run,
  returns them all as stale records, and deletes each claim only after its recovery replayed. This
  covers a takeover whose live-log append failed and was rolled back, and a session that died
  before `recover` ran.
- `claimBusy`: a claim older than N seconds by mtime (the critical section takes milliseconds)
  counts as interrupted even when its pid is alive (pid reuse), so the owner gets the
  "remove <path>" instruction instead of "try again" forever.
- `down` and `reap` take `claim-<run>.json` when they remove the lock (the Task 2 claim rule: only
  the claim holder replaces or removes a lock naming its run) and surface the same orphaned-claim
  message instead of failing teardown silently.

- [ ] Tests: the three review carry-overs above (an orphaned rolled-back claim is returned as stale; an old claim with a live pid → "remove"; `down` under a held claim refuses with that message); `down` kills the fixture app and its `--spawn-child` grandchild (process group); replays
  a stop record with its own cwd and env (the stop writes `pwd` and `$COMPOSE_PROJECT_NAME` to a file);
  removes the worktree, run files and lock; appends `end`; recovery skips a stop record whose cwd is
  gone or whose env lacks the right `COMPOSE_PROJECT_NAME`, and does not kill a pid whose command line
  changed; the reaper (`reap` with a deadline 2 s ahead) runs `down`; a reaper whose run lost the lock
  exits without acting; `renew` moves the reaper's wake-up.
- [ ] Run (FAIL) → implement → run (PASS) → commit `feat(sapu): argus-live run files, reaper, down and recovery`.

---

### Task 8: `up`, `up --fresh`, `status`, the CLI, and the guard seam

Interfaces:
- Before `checkStore` compares services, `up` resolves each host name in the env values with
  `dns.lookup` (all addresses) and treats one that resolves only to loopback as `localhost`, so an
  alias such as `db.localtest.me` cannot slip past the loopback endpoint comparison (carried from
  the Task 5 review).
- `export async function up(main, {fresh: false})` in spec §8's order, minus steps 9–10 (phase 3):
  1 lock (recover a stale one first), 2 refusals (config errors, unset `${NAME}`, `base_url` and role
  hosts resolving to loopback via `dns.lookup`, `~/.playwright/cli.config.json` present, no
  `lsof`/`ss`), 3 environment, 4 worktree + setup + links check, 5 ports + Compose check, 6 store
  phase + `checkStore` + `reset`, 7 remaining entries + health + `checkStore`, 8 egress check,
  11 run files + reaper. Any refusal or failure after the lock → `down` (which appends `end`) and
  rethrows. (The browser and Chrome checks of step 2 join in phase 3.)
- `upFresh(main)`: keeps lock, worktree, ports and reaper; stops every entry (running `stop`), then
  store phase → `checkStore` → `reset` → rest → `checkStore` → egress; new `instanceId`.
- `status(main)` prints the run id, deadline, worktree and each entry's state.
- CLI `argus-live.mjs`: `up [--fresh]`, `down`, `renew`, `status`, `reap <runId>` (internal); exit 0
  / 1 refused / 2 failed; never prints a secret value.

- [ ] Tests: a full `up` on the fixture app (store phase via a second fixture process, `CACHE_URL` to
  a run port) succeeds, writes `run.json`, and `down` leaves no process, no worktree, and a balanced
  start/end in `sapu-live.log`; a failing step after the lock (bad `store_check`) leaves an `end`
  line and no worktree; `up` with a live lock → exit 1; `up --fresh` keeps the worktree path and the
  lock, changes `instanceId`, and resets `DATA_DIR`; **guard seam**: after `up`, `decide({agent_type:
  "sapu:ui-explorer", tool_name: "Read", tool_input: {file_path: <worktree>/<a tracked file>}, cwd:
  main})` from `sapu-guard.mjs` returns null, and for `<worktree>/.argus/live.json` a refusal; the
  CLI never prints the value of `${PW}` (scan stdout/stderr and the logs).
- [ ] Run (FAIL) → implement → run (PASS) → commit `feat(sapu): argus-live up, up --fresh, status and the CLI`.

---

### Task 9: whole suite and phase-end team review

- [ ] `npx vitest run` → PASS, every file.
- [ ] Phase-end review (owner's rule): senior-dev-team QA reviewer and architect read
  `git diff <phase 2 base>..HEAD`; fixes by the developer; re-review; suite green.

## Self-review

- Spec §8 coverage: lock and recovery (T2, T7), refusals (T1, T3, T8), environment (T4), worktree
  (T4), ports and Compose (T3, T6), store (T5), start and health (T5), egress (T6), run files and
  reaper (T7), renew (T2, T7), `up --fresh` (T8), `down` (T7), beside a sweep — the writer side (T2
  seam test). Deferred to phase 3 with their reasons: the filtering proxy (step 9), proving logins
  (step 10), the Chrome check and `~/.playwright` guard's browser half.
- Interfaces shared across tasks: `run.json` keys (T7) are what the guard reads (`worktree`) and
  what phase 3 extends (`sessions`, tokens); `sapu-live.log` lines (T2) match `live_overlap`.
