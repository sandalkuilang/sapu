# `.argus/live.json` — the journey lane's instance

`.argus/live.json` tells `argus-live.mjs` how to build the isolated instance a journey cycle runs on: its own worktree, ports, data, environment and HOME, never the owner's servers. JSON (the plugin has no YAML parser), beside `.argus/config.yml`: tracked in a repo home (`!/.argus/live.json` beside the `config.yml` exception), never tracked in a local home. The lane reads only this file, never `config.yml`. **Unknown keys are errors at every level**, as in the sapu contract. `/sapu:init` drafts it with the owner; `live check` verifies it (below).

`live <cmd>` stands for `node "${CLAUDE_PLUGIN_ROOT}/scripts/argus-live.mjs" <cmd>`, run from the main checkout.

## Example

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

## Top-level keys

Required: `start`, `base_url`, `login_url`, `logged_in`, `store`, `store_check`, `reset`, `confirmed`, `roles`, `limits`.

- `setup` — argv lists (no shell), run in the worktree under the instance environment before anything starts; each bounded by the time left before the lock's deadline.
- `services` — `{<name>: {"env": <VAR>}}`, one per backing service the app reads (database, cache, queue, object store, search engine, mail server): the variable holding its address. `up` refuses one that `env` (or a set `pass_env` name) does not set: the app would fall back to its default address, the owner's service.
- `start` — a non-empty list of start entries (below), started in order, each in its own process group.
- `base_url` — the app's URL: http(s), its host resolving to loopback only.
- `login_url` — the sign-in page, a path on `base_url` or a full URL.
- `logged_in` — a Playwright locator visible only when signed in; `login_open` — a control to click before the login form shows. Both of the getBy family or `locator('<css>')`, optionally chained and with `.first()`, `.last()` or `.nth(<n>)`; never a snapshot ref or a bare CSS string (the wrapper parses them and builds its own login code).
- `env_file` — the repo-relative, gitignored file (`up` refuses one git tracks or does not ignore) holding the values `${NAME}` takes (`KEY=value` lines; `#` comments, `export ` and outer quotes allowed): their only source, never the process environment. Its file name must be in the contract's `guard.envFiles`, so no agent reads it.
- `env` — the instance environment, names to strings. Every command gets only `PATH`, `USER`, `SHELL`, `TMPDIR`, `LANG`/`LC_*`, the `pass_env` names, `env`, the run's `COMPOSE_PROJECT_NAME`, its own empty `HOME` and its own Docker client. `env`, `pass_env` and a start entry's `env` may not name `HOME`, `COMPOSE_PROJECT_NAME`, `DOCKER_CONFIG`, `DOCKER_HOST` or `DOCKER_CONTEXT`.
- `pass_env` — names passed through from the owner's environment (an npm cache, a proxy): the owner's choice to share them.
- `store` — the one datastore `reset` may touch; never one the contract's `guard.postgres` protects. `store_check` — a shell command printing the store the app's own configuration resolves to: it must print `store`, under the instance environment and under each start entry's. `reset` — a shell command recreating the store's synthetic data. `/sapu:init` never invents either command.
- `facts` — `{argv, args}`: prints an object's facts (status coherence on server-rendered pages). `mail` — `{argv}`: prints the run's mail as a JSON array of `{to, subject, text}`. `triggers` — `{<name>: {argv, args}}`: the commands a `system` step runs (a scheduler, webhook, queue or expiry). No shell: each value replaces one placeholder (`{1}`, `{2}`…) and must match that placeholder's regex in `args` (a default one when `args` has none); a leading `-` is refused whatever the regex. `seed: true` marks one a smoke path may start with.
- `confirmed` — `{"mocks": true, "data": true}`, the owner's two statements (below); anything else is refused.
- `allow_origins` — full origins (`scheme://host:port`, never a bare host) pages may load from, such as a font CDN.
- `port_range` — `[low, high]`, required whenever a `{port:<name>}` is used. `reserved_ports` — the repo's dev and E2E ports, never allocated.
- `login_spacing_ms` — 0 to 60 000 between the proving logins. `timezone` — an IANA zone; `locale` — a BCP 47 tag.
- `fixtures` — a repo-relative directory (no absolute path, no `..`) holding the files `upload` may use.
- `roles` — below. `viewports` — widths from 200 to 4000; the first is the explorers'. `locales` — the locales the viewport-and-locale oracle repeats a critical step in.
- Smoke suite: `test_id_attribute` — the app's test-id attribute (`data-testid`); `pseudo_locales` — codes the app serves as pseudo-locales (`en-XA`); `tokens` — `{css|json: <tracked file>}`, its design tokens.
- `settle_ms` — 0 to 120 000: how long anything judged missing is waited for.
- `prohibited` — actions the explorer must never take, copied into its charter.
- `limits` — below.
- `compose_files` — the Compose files the instance uses (repo-relative, tracked, no `..` and no `:`), in Compose's `-f` order: only those are checked, and the run's `COMPOSE_FILE` names them. Without it, `up` checks the `COMPOSE_FILE` the instance environment (or a tracked `.env`) sets, else every Compose file of the worktree, and a refusal then asks for this list.

## `limits`

- `max_cycle_minutes` (required, at most 1440) — the lock's deadline is the start plus this plus 15 minutes; `renew` moves it by this, never past the start plus three times this plus 15 minutes.
- `max_parallel_journeys` — the journeys SELECT picks per cycle (2 when unset).
- `live_health_timeout_s` — bounds each health wait and each `store_check`.
- `explorer_pw_calls` — 1 to 10 000: an explorer token's `pw` budget; past it every call answers `BUDGET`.
- `minimize_runs` — the runs `repro --minimize` may spend on one candidate.

## A start entry

`name` (required, unique), `cmd` (required, a shell command), `phase` (`"store"`: started before `store_check` and `reset`), `stop` (a shell command `down` replays), `env` (added to the instance environment for this entry), `health` (`{"url": <url>}` answering or `{"cmd": <command>}` exiting 0; without it the process alive after 5 s). `up` refuses an entry whose health answers before its command ran (something else serves there), and fails one whose process exits before its health passes, unless it exited 0 and has `stop` (a detached starter such as `docker compose up -d`).

## Roles

`roles.<name>`: names match `^[a-z][a-z0-9_-]*$` (no `.`: `<role>.<k>` names an account). `anon` is reserved for the signed-out visitor and is `{}`; `system` is reserved for scheduled and external steps; the wrapper's role-free commands `submit`, `code`, `trigger`, `facts` and `mail` are not role names. Every other role signs in by exactly one of:
- `users` — a non-empty list of `{user, password, totp_secret?}`: `user` written literally (SELECT prints the accounts), `password` and `totp_secret` as `${NAME}`. Account `<role>.<k>` is the k-th user, from 1.
- `login` — `{"command": <command>}`, run at every session open, printing a fresh Playwright storage state (`{cookies, origins}`). One journey a cycle may use such a role.

A role may also set `code_role` (the role's name in the code's role → permission source, read by the map agent), `base_url`, `login_url`, `logged_in` and `login_open`, overriding the top level. `up` proves every account with one login before the cycle, and refuses on the first that fails.

## Expansion

- `{port:<name>}` takes a free port from `port_range` outside `reserved_ports`, the same for every use of the name; `{port:<name>=<n>}` fixes one (taken → refused, naming its holder; one port fixed for two names, or one name at two ports, refused). They expand in every string.
- `${NAME}` expands in every string from `env_file`. An unset or empty name refuses `up`, naming it, never its value.
- In a field run by the shell (`store_check`, `reset`, a start entry's `cmd`, `stop` and `health.cmd`, `roles.<r>.login.command`), `${NAME}` becomes a reference to `ARGUS_SECRET_<NAME>`, which only that command's environment carries: the value is never written into the command text, a recorded command line or run.json, and the shell reads it as one word of data. `${NAME}` inside single quotes or a heredoc is refused (that shell would not expand it); a field handing the value to an inner shell writes `"$ARGUS_SECRET_<NAME>"` there, and passes it into a container by name (`-e ARGUS_SECRET_<NAME>`).
- Argv lists (`setup`, `facts`, `mail`, `triggers`) and `env` values get the value itself: a secret in an argv list is visible in `ps` while that command runs, and so is one a shell command puts into another program's arguments. That is the owner's choice.

## The owner's two statements

`/sapu:init` asks each in these words and writes the answer; `up` refuses unless both are true.
- `mocks` — every outbound integration (payments, email, messaging, identity checks) runs in test or mock mode under `env`, because a browser cannot see server-side calls.
- `data` — the data `reset` creates is synthetic (no real personal or business data), so screenshots and page text may appear in issues.

## The run's origins

The origins of `base_url`, of each `roles.<r>.base_url`, and of every `{port:<name>}` allocated this run on those URLs' hosts. Pages reach only them and `allow_origins`; every login is checked for a redirect anywhere else.

## Known limits

The checks of `up`, `renew` and `down` catch a misconfiguration or an app default that would touch the owner's servers, services or data. The repo and this file are the owner's and trusted; the checks are defence in depth, not a sandbox:
- Static scans read what this file and the tracked Compose files say; a script they call is seen only through what it does (the egress check and the Docker runtime gate).
- Process groups bound every kill and every listing: a process that leaves its group (`setsid`, a double fork) is neither killed nor listed.
- The egress check samples: a connection opened and closed between two samples is not seen, and processes inside containers are not listed.
- A host name stands for the addresses it resolves to when the check runs; `allow_origins` is matched for every process of the run, not only for pages.
- A container reaches the Docker host only by the names and addresses the checks know; a custom bridge subnet and some runtimes' host aliases escape them.
- The Docker runtime gate judges objects by when they were created: touching an object older than the cycle ends it, the owner's own work on the same daemon included.
- The run's Docker client uses the local unix socket of the owner's current context (tcp or ssh is refused), with no credentials: pull private images beforehand.
- A slot's token is in the process list while a `pw` call runs: the lane assumes a single-user machine.
- The worktree and HOME live under `$TMPDIR`; on a Linux whose `/tmp` is a tmpfs, point `TMPDIR` at a disk-backed directory of your own.
- Nothing is enforced by the operating system.

## Verifying it

`live check` runs the checks `up` makes before it touches anything — the schema, every unset `${NAME}` (by name), the base URLs resolving to loopback only, a `services` variable the instance env does not set, a protected `store`, a literal password or TOTP secret, an `env_file` git tracks or does not ignore — and that the contract's `guard.envFiles` covers `env_file` (the draft's; `up` asks the committed contract, so a `note:` says when only the draft covers it). One `refused: …` line per fault (exit 1), else `live: ok — <r> roles, <a> accounts, <s> start entries`. It takes no lock, starts and writes nothing, and prints no value. The machine checks (a Chrome-family browser, `lsof` or `ss`, no `~/.playwright/cli.config.json`, the pinned browser CLI) run at `up`.
