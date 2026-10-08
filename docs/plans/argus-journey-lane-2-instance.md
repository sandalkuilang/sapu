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

Interfaces (as built; the runner parameter is `runner`, like the rest of the module):
Threat model (spec §8): the config and the repo are the owner's, trusted; the checks catch
misconfiguration and app defaults, not a malicious repo. Each check below is defence in depth.

- `export function dockerEnv({home, runner, ownerEnv})` → `{DOCKER_CONFIG, DOCKER_HOST}` for
  `instanceEnv({..., docker})`: `<home>/.docker` holding only links to the owner's
  `cli-plugins/docker-*` and a config.json without auths/credsStore/currentContext (only
  `cliPluginsExtraDirs`); DOCKER_HOST = the owner's current context's socket (`docker context
  inspect`), refused unless `unix://`. Without docker, only DOCKER_CONFIG. `instanceEnv` and
  `startEntry` refuse DOCKER_CONFIG, DOCKER_HOST and DOCKER_CONTEXT in env, pass_env and an entry's env.
  With `compose_files`, `instanceEnv` sets COMPOSE_FILE = the files joined with ":" and
  COMPOSE_PATH_SEPARATOR = ":" (`validateLive` refuses a `:` in a listed file; the instance's own
  Compose commands read only the checked files, not a tracked override) and refuses COMPOSE_FILE or
  COMPOSE_PATH_SEPARATOR in env, pass_env or a start entry's env.
- `export function checkCompose({worktree, env, ports, main, config, contract, secrets, runner})` →
  the service names of every project (`[]` without a Compose file). In order: (1) every command of
  `config` (setup, facts, mail, triggers, store_check, reset, start cmd/stop/health.cmd, role login
  commands) may not set or unset COMPOSE_*/DOCKER_*, run `docker` other than `docker compose`, or pass
  Compose `-p`/`-f`/`--project-directory`/`--env-file` or a variable before its subcommand (quotes
  and backslashes dropped first); (2) the files: `config.compose_files` when set (validated by
  `validateLive`: repo-relative, no `..`; each tracked, else refused), merged in its order from the
  root; else the COMPOSE_FILE the instance env or a tracked .env sets (read at the root, no `-f`;
  one inside MAIN refused); else every Compose file (`git ls-files` matching
  `(docker-)?compose[._-]*.y(a)ml` at any depth, plus default names at the root), per directory,
  with "list the files the instance uses in compose_files" appended to a refusal. None may spell a
  path inside MAIN anywhere (a `${VAR:-<path>}` default too) or reach one by a relative path;
  (3) `docker compose [-f …] --profile * config --format json`, refusing: another project name; `container_name`; a host port not the run's, or random;
  `network_mode` host/bridge/container:; `pid`/`ipc`/`cgroup` host or container:, `uts`/`userns_mode`
  host; `volumes_from` container:; `privileged`; `security_opt` seccomp/apparmor unconfined, label
  disable, systempaths=unconfined; `devices`; `cap_add` outside NET_BIND_SERVICE, CHOWN,
  SETUID, SETGID, DAC_OVERRIDE, FOWNER; a bind mount or local-volume device inside MAIN (or holding
  it), or a runtime/datastore socket or a directory holding one, or any `*.sock` under a Docker run
  directory (outside the worktree); a secret or
  config file or build context in MAIN; `extra_hosts` to the Docker host; an external network or
  volume, or one named outside `<project>_`; and each service's environment, command and entrypoint
  through checkStore's comparison as a container (loopback and paths its own; the Docker host
  refused off the run's ports). Docker missing or failing → refused, secrets masked.
- `export function daemonNow({env, runner})` → the daemon's clock, epoch ms (`docker info --format
  {{json .SystemTime}}`), or null without docker or a daemon.
- `export function checkDockerRuntime({since, env, main, worktree, ports, runner, skewMs})`: the runtime gate
  for what static scans cannot see. Lists every container (`docker ps -aq` + `inspect`), volume and
  network; one created or started since `since` (epoch ms from daemonNow, minus `skewMs` = 1 s) must carry
  `com.docker.compose.project=<COMPOSE_PROJECT_NAME>` (a volume may be a new anonymous one); such a
  container may mount only the run's volumes, join only its networks (or none), bind-mount nothing
  the Compose check refuses, not be privileged (`HostConfig.Privileged`), and publish only `ports`
  (`HostConfig.PortBindings` and the live `NetworkSettings.Ports`; a random host port, and `HostConfig.PublishAllPorts` (`-P`), refused). Then `docker events --since <since - skew> --until <daemonNow>` (container,
  volume, network): a container action (create, start, restart, kill, stop, die, destroy, pause,
  unpause, update, rename, exec_create, exec_start, archive-path, extract-to-dir) on a container without the run's label, unless it
  is that container's own healthcheck exec (`Config.Healthcheck.Test`, CMD or CMD-SHELL), or a
  volume/network destroy whose name is not `<project>_…` and which was not created in the window →
  refused. No docker or no daemon → nothing to check; any other docker failure → refused.
- `export function groupPids(pgids, {runner})` → every pid in those groups (`ps -A -o pid= -o pgid=`,
  one command on macOS and Linux, instead of `pgrep -g` / `ps -g`).
- `export function egressAllowed({config, env, ports})` → `host:port` strings: the run's ports on
  loopback (the only loopback endpoints allowed: the owner's dev servers listen there too); every
  non-loopback endpoint `env` and each `start[].env` name (URL, DSN, `X_HOST` + `X_PORT`); each
  non-loopback `allow_origins` origin; every endpoint, loopback included, a `pass_env` variable names
  (an `HTTPS_PROXY`).
- `export async function checkEgress({pids, allowed, runner, lookup, samples = 5, intervalMs = 500,
  expectListen, runDirs, main, contract})`: each sample lists TCP (`lsof -nP -a -iTCP -p <pids>
  -FpcnT`, else `ss -tanpH`) and unix sockets (`lsof -nP -U -Fpcdn` over every process, the client's
  `->0x<addr>` matched to the socket whose `d` is that address; `ss -xapH` first on Linux, peer inode
  to path). TCP: a connection whose local port the processes listen on is inbound and skipped; a
  host name in `allowed` stands for every address `lookup` gives it; a loopback connection to
  another listener of the same processes is allowed; anything else → `refused: <process> (<pid>)
  connects to <host:port>`. Unix: a peer path outside `runDirs` that is a datastore socket (name,
  default directory, a directory the owner's env files name for a socket, or inside MAIN; on macOS a
  peer lsof cannot see is named by `netstat -an -f unix`, whose addresses are lsof's; a netstat that
  fails there → `failed: …`) →
  `refused: … connects to the socket <path>`. `lsof` exiting 1 with anything but warnings on stderr,
  or (first sample) none of `expectListen` listening → `failed: …`. Missing both tools → `refused:
  neither lsof nor ss is available`. `waitHealth({..., egress})` runs a one-sample check between
  health tries.
- Store comparison (Task 5's, carried here from the Task 6 review): `sqlite:///x` is read both ways
  (relative and absolute) on both sides and refused when either hits; `jdbc:sqlite:` and
  `file://<host>/p` are file values; a percent-encoded libpq socket directory is decoded first; an
  instance libpq or MySQL-family value that leaves its host ("leaves its host…") or only its port
  ("leaves its port…") to the client's default is refused, and so is a client variable without its
  host variable (PGDATABASE/PGUSER/PGPASSWORD/PGPORT without PGHOST or PGHOSTADDR; MYSQL_PWD or
  MYSQL_TCP_PORT without MYSQL_HOST).

- [ ] Tests: a fake `docker` on `PATH` (a shell script in a temp dir printing JSON) — a published host
  port outside the run → refused; a `container_name` → refused; a compliant config → passes;
  egress: start the fixture app with no `CACHE_URL` while a test listener holds 46379 → refused
  naming 46379; with `CACHE_URL` pointing at a run port → passes; a fake `PATH` without lsof/ss →
  refused.
- [ ] Run (FAIL) → implement → run (PASS) → commit `feat(sapu): argus-live Compose and egress checks`.

---

### Task 7: run files, reaper, down, recovery

As built (where it differs from, or adds to, the interfaces below):
- `writeRunFiles(main, state, {runner, secrets})` writes run.json whole (temp file renamed into place,
  mode 0600), so `up` may rewrite it as the run grows; `worktree` may be null until it exists; keys
  beyond the listed ones pass through (`env` = the instance env and `since` = the daemon's clock at
  `up`, both for `down`'s runtime gate; `reaper`). Each group's `cmdline` and its `members` ({pid,
  cmdline}) are read from `ps -A -ww` as they stand, secret values masked: `/bin/sh -c <one command>`
  execs that command, so `/bin/sh -c …` as recorded at spawn would never match at recovery.
- `startEntry(entry, {…, stops})` pushes the entry's stop record `{name, cmd, cwd, env}` as soon as it
  started (before its health), so a failed health still gets its stop replayed.
- `logsDir(main, runId)` = `.argus/live/<runId>/logs` (kept by `down`); stop replays log to
  `stop.<name>.log`, the reaper to `reaper.log`.
- `startReaper(main, runId)` → pid, patched into run.json as `reaper`. `reap(main, runId, {pollMs})`
  re-reads the lock at least every 60 s. `argus-live.mjs` exists with `reap <runId>` only (Task 8 adds
  the rest).
- `down(main, {runId, record, secrets, runner, asyncRunner, graceMs, stopTimeoutMs, claimWaitMs})` →
  `{report}`: runtime gate (a finding reported) → reaper signalled (only while its pid still runs
  `argus-live.mjs reap <runId>`, never itself) → stops replayed last-started first (cwd must exist) →
  groups SIGTERM, SIGKILL after `graceMs` → its own worktree, HOME, setup log (a recorded worktree
  that is not `<sapu-live>/<repo>-<runId>` is left and reported) → run.json → the lock, under its
  claim → `end`. `record` (the in-memory run) replaces run.json, for an `up` that fails before its
  run files are written. It throws only when another process holds the lock's claim (after waiting
  `claimWaitMs` for a live, fresh holder): the teardown is done, the lock and the end line wait.
- `recover(main, {secrets, …})` → `{recovered, report}` takes no `stale` argument: it recovers every
  `staleRecords(main)` entry; `takeLock` returns them as `staleRuns` (the taken-over lock included;
  `stale` is kept). Spec §8 step 1's "process group whose recorded command line still matches" is
  read as: its leader's command line equals the recorded one, or, with the leader gone (a setup's
  daemon), one of its members has a recorded pid and command line — so the setup groups die too.
- `claimBusy`: a claim older than 30 s (mtime) counts as interrupted even when its pid is alive.

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
- Recovery replaying a stop record that runs Compose (carried from Task 6): `checkCompose` already
  refused `-p`/`--project-name` in every command, so a recorded stop acts on its recorded
  `COMPOSE_PROJECT_NAME` only; keep the `env.COMPOSE_PROJECT_NAME === argus-<runId>` test as the
  gate, and do not replay a stop whose recorded env lacks it.
- `down` runs `checkDockerRuntime({since: <the run's start, epoch ms>, env, main, worktree})` before it
  replays stops and reports a refusal in its output without stopping the teardown (carried from Task 6).
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

Carried from Task 7:
- Step 1: `recover(main, {secrets})` right after `takeLock` (when `staleRuns` is not empty) and
  before `up` writes its own run.json: run.json is one file, and recovery reads the stale run's.
- Write run.json early (right after recovery: `worktree` null, no groups) and again whenever a group or
  stop record is added (or at least after each step), so a session that dies mid-`up` leaves a record
  for the reaper and for recovery; start the reaper as soon as run.json exists. On a refusal or failure,
  `down(main, {runId, record: <the in-memory run>, secrets})` covers groups not yet written.
- `ctx` carries `stops: []` beside `groups`; `bringUpStore`/`bringUpRest` hand it to `startEntry`.
- run.json gets `env` (the instance env) and `since` (`daemonNow` or `Date.now()`), and every
  `writeRunFiles` call gets `{secrets}` (members' command lines are masked with them). The last write
  (step 11) comes after every health check, so the recorded command lines are the exec'd ones.
- `upFresh` stops the entries the way `down` does (replay their stops, SIGTERM/SIGKILL their groups):
  `replayStop` and `stopGroups` are module-private today; export a small helper rather than copy them.
- The CLI: `down` prints `report` line by line; a claimBusy refusal → exit 1.

Interfaces:
- Before `checkStore` compares services, `up` resolves each host name in the env values with
  `dns.lookup` (all addresses) and treats one that resolves only to loopback as `localhost`, so an
  alias such as `db.localtest.me` cannot slip past the loopback endpoint comparison (carried from
  the Task 5 review).
- Wiring Task 6 (carried from it): step 3 calls `dockerEnv({home})` right after `makeHome` and
  passes its result to `instanceEnv({..., docker})` (a refusal there comes before step 5). Step 5
  calls `checkCompose({worktree, env, ports, main, config: <expanded config>, contract, secrets})`
  and stores its result as `ctx.composeServices` before `bringUpStore(ctx)`, so both `checkStore`
  calls see it. Step 8, `upFresh` and `renew` (the CLI's) call `checkEgress({pids: groupPids(<every
  recorded pgid, setup groups included>), allowed: egressAllowed({config, env, ports}), runDirs:
  [worktree, home], main, contract, expectListen: [<base_url's port, when a start entry serves it>]})`;
  a refusal → `down`. Every `waitHealth` of steps 6 and 7 gets `egress: () => checkEgress({...same,
  pids: groupPids(<the groups so far>), samples: 1})`. `up` records `daemonNow({env})` (else
  `Date.now()`) as it starts, in run.json. After each egress check (step 8, `upFresh`, `renew`),
  `checkDockerRuntime({since: <that recorded start>, env, main, worktree, ports})`; a refusal → `down`. `up` step 2's "no
  `lsof`/`ss`" refusal can reuse that message.
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
