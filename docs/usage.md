# Install and use

<sub><a href="../README.md">README</a> · <b>Install and use</b> · <a href="agents.md">How the agents work</a> · <a href="security.md">Safety and trust</a> · <a href="contributing.md">Contributing</a></sub>

## Install

Add the marketplace, from GitHub:

```bash
claude plugin marketplace add sandalkuilang/sapu
```

or from a local clone:

```bash
claude plugin marketplace add <path-to-clone>
```

When installed, the plugin is **copied** into Claude Code's cache (`~/.claude/plugins/cache/<marketplace>/<plugin>/<version>`), also when the marketplace is a local folder. Edits in the clone reach the repos that use it only after the version is raised and the plugin is updated (see "Updating the plugin"). To try edits without installing, run `claude --plugin-dir <path-to-clone>/plugins/sapu`, which loads that folder directly.

Then, from the main checkout of the repo that opts in:

```bash
claude plugin install sapu@sapu --scope project
```

sapu depends on the [senior-dev-team](../plugins/senior-dev-team/README.md) plugin from the same marketplace, so this command installs and enables it too, at the same scope. Its agents are sapu's default specialists ("Specialist agents", below).

When the marketplace repo is private, cloning it uses your existing git credentials (`gh auth git-credential`), so the active `gh` account must have access to that repo.

Once installed, run `/sapu:init` in a new session to write a draft contract. Review that draft, then commit it together with `.claude/settings.json` (a local contract, below, is not committed). It also writes `.claude/settings.local.json` for this machine, never committed: the main session returns to the project directory after every command, and new worktrees link `<MAIN>`'s agent memory when that directory is untracked and can be ignored as a link.

The draft also holds project-level aliases `.claude/skills/<name>/SKILL.md` (never in `~/.claude/skills`), so typing `/sapu`, `/forge`, … is enough instead of `/sapu:sapu`, `/sapu:forge`, ….

## Usage

### Once per repo

1. Install the plugin at project scope (see above), then **start a new session**. A plugin loads when a session starts.
2. Type `/sapu:init`. It scans the repo and writes a draft contract: `.claude/sapu.json` and the profiles `.claude/sapu/*.md`. It also creates the short aliases `/sapu`, `/forge`, and so on. Every question it asks is one you really have to decide: the account, the gate commands, the protected databases, the security epic, the merge method (only when the repo does not allow squash merges), the end-of-wave net and the teardown command (see "How a merge works", below), and the repo's **policy** (next list). It proposes creating the labels the contract names (the acceptance, needs-owner and agent-filed labels too) and creates them only when you agree. It never fills in nemesis targets: you sign those yourself in `.nemesis/authorization.yml`.
3. Review the draft, then merge it through a PR. From then on the skills below can be used. A local contract needs no PR: it works as soon as init has verified it.

The policy is asked in popups, one choice per field; the full table is in [`CONTRACT.md`](../plugins/sapu/CONTRACT.md) §Policy:
- **Where the contract lives:** committed in the repo, or local in `~/.config/sapu/repos/<owner>__<name>/` so that nothing about sapu enters the repo (for a repo that is not yours).
- **Who merges:** sapu after a green gate, or people (`sapu-merge.sh` runs the gate, requests your reviewers and hands the PR over).
- **Which issues:** every trusted issue, only issues assigned to you, or only issues with one label.
- **Traces on GitHub:** visible, or none (no sapu labels, comments or wording on GitHub; review records stay in `.git/`).
- **Filing issues, which skills may run, and an optional pre-PR command** that must report zero findings at the severities the owner picks before a PR is handed in.
- **Cleanup** of sapu's merged branches and worktrees: at the end of the sweep (the default), also at the end of every session, or never (see "Cleaning up branches").

Each profile's `##` section headings are English and match exactly what `sapu-contract.mjs profiles --list` prints for that skill.

When you enable `journey` among the skills (with `argus`, which it runs under: `/journey` checks both, and init selects `argus` with it), init also drafts `.argus/live.json`, the instance the journey lane builds for itself (its format is [`skills/journey/live.md`](../plugins/sapu/skills/journey/live.md)):
- **From the scan, each fact confirmed by you:** a `services` entry for every local service the repo's config names (cache, queue, object store, search engine, mail server), the roles from `.argus/config.yml`'s `test_accounts`, the repo's dev and E2E ports as `reserved_ports`, and a `port_range` of its own.
- **Secrets stay out of it:** passwords and TOTP secrets are written as `${NAME}`. Init writes `.argus/live.env` with those names and empty values for you to fill, and adds its file name to the contract's `guard.envFiles`, so no agent reads it. Init never reads or writes a value.
- **Your two confirmations,** asked in these words: every outbound integration (payments, email, messaging, identity checks) runs in test or mock mode under `env`, because a browser cannot see server-side calls; and the data `reset` creates is synthetic (no real personal or business data), so screenshots and page text may appear in issues. The lane refuses to start unless both are true.
- **`store_check` and `reset` are never invented:** a repo without commands that select and reset a separate datastore gets the prerequisite reported missing, and init leaves `journey` off until the repo adds them.
- **Verified with `node "${CLAUDE_PLUGIN_ROOT}/scripts/argus-live.mjs" check`**, which runs the lane's checks of the file (its schema, an unset `${NAME}`, the base URLs resolving to loopback only, the `services`) and of the contract's `guard.envFiles` without starting anything, and prints `live: ok — <r> roles, <a> accounts, <s> start entries`, or one `refused: …` line per fault. It reads the draft contract; `up` reads the committed one, so check adds a `note:` line until the contract that covers `env_file` is committed, and `up` refuses until then. A `${NAME}` you have not filled yet is reported as yours to fill, not as a failure of init.

Repo requirements:
- a GitHub remote, with the account its contract names (`ghUser`, `gitEmail`, `repo`);
- real tests that can run as the merge gate;
- a `CLAUDE.md`.

A repo without tests can only use `/dream`.

### Day to day

| To do what | Type | What happens |
|---|---|---|
| Clean up every open PR and issue | `/sapu` | **Phase A:** every open PR is reviewed, fixed, or closed. **Phase B:** each issue is one Workflow call (a *lane*), up to `lanes` in flight, from the machine's cores, memory and current load. Every PR is reviewed by an agent that is not its author, and merged one at a time through `sapu-merge.sh`, only after a green gate. Every issue ends *merged*, *skipped* (with a reason), or *blocked* (with a reason). |
| Work one issue through to a merged PR | `/forge 123` | Creates a branch, implements + tests, opens a PR, has it reviewed by an agent that is not its author, then gates and merges it through `sapu-merge.sh` when its risk tier allows (🔴 only through the `needs-ai` protocol). Under `/sapu`, a worker stops at the open PR instead. |
| Hunt bugs, fraud gaps and UI defects in the running dev app | `/argus` | Needs the dev app running and `.argus/config.yml`. Findings are filed as deduplicated issues. Run from the main session with `.argus/live.json` in place, a cycle may pick the journey lane instead (next row). |
| Walk the app's business journeys through the real UI, as every role they need | `/journey` | One bounded cycle on an isolated instance argus starts itself (its own worktree, ports, data and HOME), never on your servers: the journey catalog refreshed from the code when it is stale, the top journeys walked by `sapu:ui-explorer` agents, every candidate reproduced two of two by a script before anything is filed. `/journey list` prints the catalog and starts no app (`list --rebuild` rebuilds it); `/journey <id> …` walks the journeys named. Needs `argus` and `journey` both allowed in `policy.skills`, argus's profile and `.argus/config.yml`, `.argus/live.json` from `/sapu:init`, a Chrome-family browser (Google Chrome or Microsoft Edge), macOS or Linux with `lsof` or `ss`, and Docker only when the instance uses Compose. Run it from the main session, never inside `/inspector`. |
| Release-readiness audit | `/momus` | Produces a report per area. Issues are filed only when you ask for it. |
| Try to break into the dev app (red team) | `/nemesis` | Attacks only the targets in a `.nemesis/authorization.yml` you signed yourself, and only dev hosts (localhost). |
| Full audit before release: momus → argus → nemesis | `/inspector` | Runs the three in sequence (never at the same time), each with its own model and effort, then one combined summary plus a security roll-up. `/inspector payments` narrows all three to one area and adds a read-only team review. The prerequisites of `/momus`, `/argus`, and `/nemesis` apply. Its argus phase never runs the journey lane: run `/journey` yourself. |
| Research where technology is heading (auth, security, UI/UX, databases, payments, …) and experiment ideas for this project | `/dream` | One local report in `dreams/` holding sourced findings, hypotheses with kill conditions, and a month of experiments; changes no code and writes nothing to GitHub. |

Without the aliases, the full names are `/sapu:sapu`, `/sapu:forge`, and so on. Plain chat ("run sapu", "work issue 123 with forge") also triggers the matching skill.

`/journey` tips:
- **One invocation is one bounded cycle**, within `limits.max_cycle_minutes`, on up to `limits.max_parallel_journeys` journeys; a pass over the whole catalog is that many invocations. The report ends with the next picks.
- **To watch,** run the `argus-live.mjs show` command the cycle prints, in a terminal of your own: it opens the browser CLI's dashboard on the cycle's sessions and blocks until Ctrl-C. The cycle never runs it itself.
- **A finding only you can rule on** (a doc that contradicts coherent behaviour, a usability heuristic with no written rule) carries the needs-owner label (`labels.needsOwner`, default `argus:needs-owner`), and `/sapu` and `/forge` skip it. Remove the label to accept the finding, or close the issue as not planned to rule the behaviour intended. No agent does either: the guard refuses both to every subagent.
- **A cycle running beside a sweep** shares the machine's CPU with the sweep's gates: a gate that overlapped a cycle is logged with ` live=1` in `.git/sapu-gates.log` and never counts toward a flake proof.

`/sapu` tips:
- Run it in a **new session**, and only one sapu session per repo at a time: a second `/sapu` session on the same repo stops at Step 0 while the first holds the repo's sweep marker (see "Common problems").
- To skip certain PRs: `/sapu skip PR #<number>`.
- A defect of the engine itself (a skill's rule, the guard, a workflow, `sapu-merge.sh`, `sapu-contract.mjs`) is never patched around in your repo: no local copy of a plugin file, no profile rule that contradicts the engine. The orchestrator files it on the plugin's own repository, with no data from your repo, after checking for an open duplicate there; when the policy forbids filing (`fileIssues: false`, or `traces: "none"`) or the active account is not the contract's, it only proposes it in the final report. The final report lists each engine defect as filed, a duplicate, or unfiled. The format is in [`CONTRACT.md`](../plugins/sapu/CONTRACT.md) §Engine defects go upstream.
- A session ends between waves once its context passes its limit (by default 75% of the model's context window, 60% at the end of Phase A; `sapu-contract.mjs tuning` prints it). sapu then rewrites one project-memory page, `sapu-sweep-state` (whole, at most 40 lines, only what is still open: skipped and blocked items with their reasons, next candidates, decisions waiting for you, an unresolved red net, open base flakes), runs the branch cleanup when the policy says `session` (below), and asks you to start a new session with `/sapu`, which continues from that page.
- The sweep finishes in the session whose triage finds no work and no open PR left: a branch cleanup (unless the policy says `never`), a final full gate on the base branch, and the final report.
- The final report holds the PR and issue tables, the decisions taken with their sources, and the metrics per session: tokens and their cost in dollars at API prices (a weight for quota use on a subscription), per merged PR.

How a lane works: a forge worker from the ladder (`sapu-sonnet-medium` … `sapu-opus-high`, picked by difficulty) implements the issue in its own worktree and opens a PR. The `qa` specialist (by default `senior-dev-team:senior-qa-reviewer`) reviews it at Opus/high on every tier; a 🔴 issue, or a diff that touches a red area, gets an adversarial Opus pair instead (`qa` + a domain specialist). A worker whose own red-area check finds a red area raises the tier before review starts. Findings go to a fresh fixer of the same tier (one step up for an invariant domain) for fix cycles, each followed by a review of the new commits: at most two on 🟢/🟡; on 🔴 up to five, but past the second only while the work converges, meaning each review reports fewer findings than the one before and no finding is reported by three reviews in a row. Otherwise the issue is blocked with the reason (a NEEDS-FIX PR in Phase A follows the same rule). A judgment call the issue does not settle sends the work one step up the ladder, once. A worker past its step budget (the guard reminds it; contract `tuning`) hands off: it commits its work in progress, tears down its test resources, and a fresh worker of the same tier continues from its note (at most two handoffs per step). To follow a running lane, open its run: the card shows only the workflow's fixed description, while the run's log names the issue, its tier and worker, then every finished step with its result and the PR. The orchestrator also posts one status line per lane in the chat when it launches the lane and when the lane returns.

How a merge works: each ready PR goes through `sapu-merge.sh`, one at a time. The orchestrator runs it as a background command and waits for its notification; it never polls. The script runs the merge gate, records the run in the flake ledger, merges, and calls the repo's `mergeAfter`.
- **A red gate** names its failing test files and a verdict. A PR gets at most one re-run. When it is red again, the failing files run on a fresh checkout of the base branch: red there too means a flaky test on the base branch (a *base flake*), which gets one `flake: <test file>` issue and is fixed at its source, never by a retry or a looser assertion; green there means the PR broke it.
- **The end-of-wave net** runs the repo's full suite on the base branch after every fourth merge and when the queue drains, to catch regressions per-PR gates miss. The profile's `## End-of-wave net` can set another cadence (for example once per session) or `none`; `/sapu:init` asks which one, and asks for the one teardown command each worker runs (a form the step budget lets through as a handoff, such as `npm run teardown -- <ID>`).

Requirements and limits (any repo, any stack, but these hold):
- **Host:** Node ≥ 22.18, bash, git, jq and an authenticated `gh` on macOS or Linux (POSIX paths); a Claude Code version with the Workflow tool and `agent_type`/`agent_id` in hook input (without the Workflow tool, sapu falls back to the Agent tool).
- **GitHub:** github.com, or a GitHub Enterprise host named in the contract's `host` (every `gh` call then goes there through `GH_HOST`). An SSH host alias for `origin` (`git@github-work:owner/app.git`) works when `ssh -G` resolves it to that host. `origin` must be the repository itself: a fork with the repository as `upstream` is not supported (sapu pushes to `origin` and refuses PRs from forks); clone the repository itself instead.
- **Merge method:** squash by default; a repo that allows only merge commits or rebase merges sets `mergeMethod` in the contract (`/sapu:init` reads it from the repo's settings). A refused merge quotes GitHub's message.
- **Checkout layouts:** a plain clone, a submodule, or a `--separate-git-dir` checkout (sapu's locks and ledgers live in the git directory; for `--separate-git-dir`, run `git config core.worktree <checkout>` once so worktrees can find the main checkout). A bare clone with worktrees is not supported: sapu needs a main checkout of the base branch.
- **The merge gate's own logic is pinned only when it lives in a file:** a gate script run by path or by an interpreter (also behind `uv run`, `poetry run`, `pipenv run`, `npx`, `pnpm exec`, `env`), or a `make`/`just` target, runs the base branch's copy. A gate such as `npm test`, `go test ./...`, `cargo test` or `uv run pytest` runs the PR's own package scripts and config: `sapu-contract.mjs show` warns about it, and `/sapu:init` proposes a pinned form.
- **The flake ledger reads the default console output of vitest/jest, pytest, `go test` (a package), cargo test and nextest (a test path), rspec, mocha (the test file in each failure's stack), and Maven Surefire or Gradle (a test class).** Other runners and reporters still record every gate run, but their failures get no names and so never a `known-flake` verdict; a failure line none of these can name (a package that did not build, a doc test) keeps the verdict `unknown` (the safe side).
- **What the machine and the model decide:** `sapu-contract.mjs lanes` computes, per machine and at that moment, the number of lanes (the smaller of cores ÷ 4 and (memory − 8 GB) ÷ 3 GB, between 1 and 4, and one fewer while the machine is already busy: load above its core count, or less than 20% of memory free) and the merge gate's test workers (80% of the cores, 40% beside a lane running tests or while the machine is busy). The worker step budget and the context limits come from the contract's optional `tuning` (CONTRACT.md §Tuning): set `contextWindow` when the orchestrator's model has a window other than 1M tokens, and the limits follow as fractions of it; `sapu-contract.mjs tuning` prints what applies.
- **The cleanup knows sapu's own branch names** (`<type>/issue-<N>-…`, `worktree-wf_*`, `worktree-agent-*`, `sapu-*`); a branch named any other way is kept.
- **The engine's own floor knows JS package managers, Prisma and Postgres.** Other stacks are protected through the contract: `guard.databases` for a MySQL/MariaDB, MongoDB, Redis/Valkey or SQLite dev database, `guard.deny` for destructive commands. `/sapu:init` proposes both from `sapu-contract.mjs stack` (Rails, Django, Alembic, Laravel, Go migration tools, Node ORMs, Compose files); a stack it does not know needs its rules written by hand.
- **argus, `/journey`, momus and nemesis** are written for a web application with users and data; on a library or CLI repo, use `/sapu` and `/forge` only.
- **The journey lane** drives a Chrome-family browser (Google Chrome or Microsoft Edge) through a pinned browser CLI (`@playwright/cli`), which is not installed with the plugin: the first `up` installs it once per user into the user's cache (`~/Library/Caches/sapu` on macOS, `$XDG_CACHE_HOME/sapu` or `~/.cache/sapu` on Linux) with `npm ci --ignore-scripts` from the lockfile the plugin ships, so that first run needs the network or a warm npm cache. It needs macOS or Linux, `lsof` or `ss`, and `ps` that prints start times; Docker only when the instance uses Compose. A slot's token is visible in the process list while a browser call runs, so the lane assumes a single-user machine. The worktree and HOME of each run live under `$TMPDIR`: on a Linux whose `/tmp` is a tmpfs, point `TMPDIR` at a disk-backed directory. A `~/.playwright/cli.config.json` of your own stops the lane (the CLI would merge it under the run's config): move it aside.

What is enforced, and by what:
- **The merge script** (`sapu-merge.sh`, the only way sapu merges) gates or merges only a PR that `sapu-contract.mjs pr-trust` passes (see "Public repositories"), only after a green gate, pinned to the gated commit. Each merge it makes is recorded in `.git/sapu-merges.log` of the main checkout, which the session metrics count merged PRs from, and every gate run, red ones too, in `.git/sapu-gates.log`: a red run names its failing test files, its failed summary steps (`steps=`, e.g. `npm_audit` when only a non-test step went red) and a flake verdict (`known-flake` when each of them is proven flaky: red, then green on the same tree, in another PR). A step that is red on the base branch too (a new dependency advisory, say) is a base break: sapu files one `base: <step>` issue and works it as the next lane.
- **The guard hook** refuses a worker or reviewer agent's direct push or force-push to the main branch, a merge, the common ways to bring a PR's or a fork's code into a worktree (`gh pr checkout`, fetching PR refs, applying a PR's diff, cloning), any change to the acceptance label, touching the dev database or `.env` files, writing into the main checkout, writing the plugins agents run under (the installed copies, the marketplace clones, Claude Code's user settings, `claude plugin install|update|…`), and git config keys or variables that make git run a program. Each command is judged by the repo it acts on (after a `cd`, `git -C`, a write's target), with that repo's contract, not by the session's folder; a git command that changes files in a directory the guard cannot tell (a path in a variable or a `$( )`, such as `git -C $(pwd) commit`) is refused. It checks `Bash`, `Monitor`, `PowerShell`, the file tools (`Read`, `Write`, `Edit`, `MultiEdit`, `NotebookEdit`), the search tools (`Grep`, `Glob`) and every MCP tool: context-mode's `ctx_*` tools are checked as the Bash and Read calls they amount to, and any other MCP tool is judged by the verbs in its name and its fields. For a worker it also counts tool calls: by default at 120 it refuses one call as a reminder to hand off, again every 15 calls up to 170 and every 5 after that (the contract's `tuning.stepBudget` changes these numbers). It never stops a worker for good: the re-issued call passes, and a handoff command is never the one refused. The exact list, and what it does not trace, is in [`CONTRACT.md`](../plugins/sapu/CONTRACT.md) §Engine floor. It reads commands, not intent: built to stop honest mistakes, it is not a sandbox against an agent set on getting around it. And it guards **subagents only**: a skill you start yourself (`/sapu`, `/forge`, `/argus`, `/momus`, `/nemesis`) runs at the top level, unguarded, with your gh token, and so does a session started with `claude --agent` — there only the skills' own rules hold.
- **The scope lock** (`sapu-contract.mjs check`) refuses to run in a checkout outside the roots the machine config allows, with the wrong account, or with a `$HOME` that is not your account's own home directory.
- **The sweep marker** (`sapu-contract.mjs sweep`, in `.git/sapu-sweep.json` of the main checkout) stops a second `/sapu` session on the same repo at Step 0. Only the orchestrator honours it; `sapu-merge.sh` keeps its own lock, so two merges never overlap.
- **The cleanup script** (`sapu-cleanup.mjs`) deletes only what the next section describes, and only with `--apply` (without it, it still fetches with `--prune` and prunes stale worktree records).
- **The journey lane's script** (`argus-live.mjs`) builds the isolated instance and refuses to start one that would touch your servers, services or data; the guard keeps its explorer to that script's browser wrapper and to files committed in the run's worktree; and `scrub`, the only way the lane files, refuses an issue holding a secret the run saw. What each layer does, and its known limits: [Safety and trust](security.md#the-journey-lane).
- Everything else in the skills — what to read, what counts as instructions — is a rule for the agents, not a lock.

### Specialist agents

Reviewers and advisers (the 🔴 review pair, forge's QA, the `/inspector` team review) are called by role. By default each role is an agent of the senior-dev-team plugin, which is installed with sapu; sapu itself ships only the worker ladder (`sapu-sonnet-medium` … `sapu-opus-high`) and the journey lane's explorer (`sapu:ui-explorer`, dispatched only by a journey cycle, never by hand):

| Role | Default agent |
|---|---|
| `qa` | `senior-dev-team:senior-qa-reviewer` |
| `architect` | `senior-dev-team:senior-software-architect` |
| `db` | `senior-dev-team:senior-fullstack-database-engineer` |
| `developer` | `senior-dev-team:senior-fullstack-developer` |
| `ux` | `senior-dev-team:senior-ui-ux-designer` |
| `writer` | `senior-dev-team:senior-technical-writer` |
| `product` | `senior-dev-team:product-manager` |

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="img/senior-dev-team-dark.svg">
  <img src="img/senior-dev-team.svg" alt="The eight senior-dev-team agents and how sapu dispatches them by role: qa reviews every PR, a qa plus domain-specialist Opus pair reviews the red tier, and a scoped /inspector run adds a read-only team review" width="100%">
</picture>

A repo that has stronger agents of its own can map roles to them through the optional `specialists` field of `.claude/sapu.json`, e.g. `"specialists": {"qa": "my-qa-agent"}`; roles it does not name keep the default. The format is in [`CONTRACT.md`](../plugins/sapu/CONTRACT.md) §Specialist agents.

### Cleaning up branches

A sweep leaves local branches and worktrees behind. When sapu removes them is the repo's `policy.cleanup`, which you choose once in `/sapu:init`:
- **`finish`** (the default): at the end of the sweep, in its last session.
- **`session`**: also at the end of every session that asks you to start a new one.
- **`never`**: never; the final report says the branches and worktrees were kept.

A cleanup runs `node "${CLAUDE_PLUGIN_ROOT}/scripts/sapu-cleanup.mjs"` from the main checkout, which prints its plan, then the same command with `--apply`, which carries it out.

The script deletes a local branch only when both hold:
- **It is one of sapu's own:** `<type>/issue-<N>-…` (a worker's branch), `worktree-wf_*`, `worktree-agent-*` or `sapu-*`.
- **Every commit of it is proven merged:** its tip is in the base branch, or its tip is (or is an ancestor of) the head of a PR merged into the base. Nothing weaker counts: a merged PR with the same name or a closed issue would lose a reused name, a later local commit or a second attempt. Every deleted branch keeps its tip under `refs/sapu-trash/<branch>` (hidden from `git branch`; `git branch <name> refs/sapu-trash/<name>` brings it back).

It never touches the base branch, the branch the main checkout is on, a branch with an open PR, or a branch it cannot prove merged. A branch's worktree is removed only when it has no uncommitted or untracked change, no ignored env file (`.env*`), is not the script's own directory and saw no git activity in the last hour (never `--force`); otherwise the branch stays too. With policy `cleanup: "never"` the script refuses to run.

### Updating the plugin

Auto-update is off, so a new version only arrives when you pull it yourself:

```bash
claude plugin marketplace update sapu
```

```bash
claude plugin update sapu@sapu --scope project
```

```bash
claude plugin update senior-dev-team@sapu --scope project
```

The team updates at the scope it was installed at: `--scope project` when it came with a project-scope install of sapu, `--scope user` when you installed it at user scope. `update` does not install a dependency that was not there before: upgrading from a sapu older than 2.6.0, install the team once instead (user scope makes it available in every project, and it satisfies sapu at project scope too):

```bash
claude plugin install senior-dev-team@sapu --scope user
```

Then start a new session. These commands also work for a marketplace from a local folder: `marketplace update` re-reads that folder, and `plugin update` copies a new version into the cache. When the version did not go up, nothing is copied. To check that the installed copy matches its source:

```bash
claude plugin list --json
```

Take the `installPath` of the `sapu@sapu` entry, then compare that folder with `plugins/sapu` in the clone using `diff -rq`.

#### Upgrading from a version before 2.9.0

After updating, start a new session in each repo and run `/sapu:init` once: with a contract in place it only completes what is missing, such as this machine's `.claude/settings.local.json` (the working-directory reset, the agent-memory links, `GH_HOST` for a GitHub Enterprise host) and the agent-filed and needs-owner labels on GitHub. It also asks which skills may run again, now with `journey` in the list, and drafts `.argus/live.json` only when you enable it. Then read the warnings of `sapu-contract.mjs show`: it now says when `gate.merge` pins no file, or when its pinned file finds the tree from its own location instead of its cwd or `SAPU_WT` ([`CONTRACT.md`](../plugins/sapu/CONTRACT.md) §`sapu-merge.sh`).

What behaves differently:
- **The guard re-reads a command that an unquoted `$( )` or backtick cuts** as one whole command, the substitution counted as a word the shell builds. So `git -C $(pwd) commit` is now refused exactly as `git -C "$(pwd)" commit` already was: a git command that changes files must name its worktree literally. The same rule refuses `gh issue edit 1 $(…) sapu:accepted` and any word the shell builds beside a literal owner label, as are the words `xargs`, `find -exec` and `parallel` fill in at run time (`… | xargs gh label edit --name x`).
- **The guard refuses more:** git config keys and variables that make git run a program (`core.pager`, `credential.helper`, `GIT_EDITOR`, `GIT_SSH_COMMAND`, …; a no-op value such as `GIT_EDITOR=true` or `-c core.pager=cat` still passes on one command), writing the plugins agents run under and `claude plugin install|update|…`, `patch` other than its dry run, `gh release download`, `degit`/`tiged`, a `curl`/`wget` download piped into `tar` or `unzip`, and the `gh api`, GraphQL and MCP routes that replace or clear an issue's labels. Each call is judged by the repo it touches, with that repo's contract: in a second repo, that repo's rules apply, and a broken contract there refuses every call that touches it.
- **The guard keeps gh's token from subagents' direct reads:** it refuses every subagent `gh auth token`, `gh auth status --show-token` (`-t`), `gh auth git-credential`, `gh config get oauth_token`, `git credential …` and the `git-credential-*` helpers (`git credential-cache exit` still passes), and reading, copying or archiving gh's `hosts.yml` or git's `~/.git-credentials` and `~/.config/git/credentials`, because with the token `curl` reaches the GitHub API around every rule the guard keeps on `gh`. Listing gh's config directory (`ls ~/.config/gh`) and a fixture that is only named like it (`test/fixtures/gh/hosts.yml`) pass. Interpreters reading the file (`python`, `node -e`), tools whose own directory option moves where a path resolves (`tar -C`), the OS keychain read directly and a script piped into `sh` are named limits of the guard, not closed. `gh auth status` without `-t` still shows who is signed in; an agent that needs the API uses `gh api`. The words `fd -x`/`-X`, `sem` and `rush` fill in are read as shell-built too, like those of `xargs`, `find -exec` and `parallel`.
- **Agent-filed issues carry a label:** every issue an agent files carries `labels.agentFiled` (default `sapu:agent-filed`; the journey lane's `scrub` adds it itself), and no subagent adds, removes or replaces it, the acceptance label or the needs-owner label on an existing issue; a new issue never carries the acceptance label. With `agentFiledNeedsAcceptance: true`, the guard also refuses a subagent's new issue (`gh issue create`, `gh api` POST `…/issues`, an MCP create tool) that does not carry the agent-filed label written literally, and every GraphQL `createIssue`; such an issue steers sapu only once an acceptor applied the acceptance label.
- **`issue-trust` reads an issue's whole label and title history** under `agentFiledNeedsAcceptance` whenever the agent-filed label is not on it now, trusted authors included, so a label applied once and removed still counts; under that setting it also trusts no author while the agent-filed label is missing from the repository (renamed or deleted: rename it back, or re-create it). Without the setting the author decides, and no history is read for the label. When it cannot read a history it needs whole (GitHub cannot be read, or more than 50 pages of 100 events), it refuses: the issue is skipped, and a PR that closes or refs it fails `pr-trust`. It also refuses an acceptance when an outsider edited or retitled the issue less than 10 minutes before the label was applied, and any edit of the acceptance label itself (a new colour or description too) voids the acceptances made before it: apply the label again.
- **`pr-trust` reads a plain mention of another repository as information:** only one in a `Closes`/`Fixes`/`Resolves` or `Refs` list still refuses the PR.
- **One sweep per repo:** a second `/sapu` session on the same repo stops at Step 0 (see "Common problems").
- **The scope lock refuses a moved `HOME`:** `check`, `preflight` and the merge stop when `$HOME` is not your account's own home directory.
- **Numbers come from the machine and the contract:** the merge gate's test workers from the cores (`sapu-contract.mjs lanes` prints `gateWorkers`), the context limits and the worker step budget from the optional `tuning` (`sapu-contract.mjs tuning` prints them). The step budget and the context limits keep their old values by default, while the gate workers now follow the machine's cores; set `tuning.contextWindow` when the orchestrator's model has a window other than 1M tokens.
- **The journey lane** (`/sapu:journey`) is new, and runs only where you set it up. An explicit `policy.skills` list keeps it off until it names `journey` (and `argus`, which the lane runs under): answer `/sapu:init`'s skills question again. Without a `policy.skills` field every skill is allowed, and the lane still stops until `.argus/live.json` exists. That file's format ships with the plugin, in [`skills/journey/live.md`](../plugins/sapu/skills/journey/live.md), and `argus-live.mjs check` verifies a draft of it. `up` refuses an `env_file` whose name the committed contract's `guard.envFiles` does not hold, so commit init's contract before the first cycle. An argus cycle you start from the main session may pick the lane once the file is there; `/inspector`'s argus phase never does.
- **The needs-owner label** (`labels.needsOwner`, default `argus:needs-owner`) marks a journey finding only you can rule on. `/sapu:init` proposes creating it, and `/sapu` and `/forge` skip every issue that carries it. Remove the label to accept the finding; close the issue as not planned to rule the behaviour intended.
- **Owner rulings are yours alone:** the guard refuses every subagent adding or removing the needs-owner label on an existing issue or PR, creating, editing, deleting or cloning that label, and closing an issue as not planned by any route (`gh issue close --reason`/`-r`, `gh api`, GraphQL `closeIssue`, an MCP tool). A plain close still passes, and so does filing a new issue with the needs-owner label. It also refuses an issue write whose body it cannot read (`gh api -X PATCH …/issues/<n> --input <file>`, `-F body=@<file>`) and a close reason the shell builds (`gh issue close <n> -r "$R"`): edit an issue's body with `gh issue edit <n> --body-file <file>`. The orchestrator keeps the same rule as a rule of its skills.
- **Stricter owner labels:** `sapu-contract.mjs` now refuses a `labels.accepted` or `labels.needsOwner` that contains spaces or any of `, = " ' / [ ] { } ( ) %`, equals `labels.inProgress` or `labels.done` (in any letter case), or starts with `labels.tierPrefix`; the needs-owner and acceptance labels must also differ. A contract that 2.8.x accepted can fail here: rename the label on GitHub and in the contract, as `sapu-contract.mjs show` names it.
- **Merge gates beside a journey cycle:** a gate run that overlapped a cycle (recorded in `.git/sapu-live.log`) ends its `.git/sapu-gates.log` line with ` live=1`, never counts toward a flake proof, and a red verdict says it ran beside a journey cycle.
- **The guard reads more forms:** a git long option written as an unambiguous prefix (`rebase --exe`) and a short option inside a bundle (`rebase -qx`) count as the option that names a program; `git send-email --to-cmd|--cc-cmd|--header-cmd|--sendmail-cmd|--smtp-server` and `git instaweb --httpd|-d` are judged like the config keys they stand for; a git config key the shell builds (`git -c "$K=…"`, `git config "$K" …`) is refused whatever its value. git's own files, `~/.gitconfig`, `~/.config/git/`, the machine config and the plugin folders are matched in any letter case (on a case-insensitive disk `.GIT` is `.git`). A first `cd -` is read as staying in the command's directory. `claude` with options before `plugin`, and the CLI run through `npx`, `bunx` or `pnpm dlx` (`@anthropic-ai/claude-code`, `claude-code`), is read as the same CLI; and a git command that changes files (checkout, reset, pull, restore, commit, …) in a plugin folder or a marketplace clone is refused like a write there, while reads (`log`, `status`) pass.
- **New contract keys** need 2.9.0 or later: `mergeMethod`, `host`, `tuning`, `guard.databases`, `labels.agentFiled`, `agentFiledNeedsAcceptance` and `labels.needsOwner`, and `journey` as a value of `policy.skills`. An older plugin stops on them (on `journey` as an unknown skill), so remove them before [rolling back](#rolling-back-to-a-previous-version).

### Rolling back to a previous version

Every version is tagged `v<version>` on GitHub (the Releases page lists them, newest first), so going back means pointing the marketplace at an older tag. Do it between sweeps: a running session keeps the version it started with.

From GitHub, pin the marketplace to the tag. A marketplace that is already added keeps its source when you add it again, so remove it first. Removing it uninstalls sapu and senior-dev-team from every repo on this machine, so reinstall in each repo that uses them:

```bash
claude plugin marketplace remove sapu
```

```bash
claude plugin marketplace add sandalkuilang/sapu#v<previous-version>
```

```bash
claude plugin install sapu@sapu --scope project
```

From a local clone, check out the tag instead, then update as usual:

```bash
git -C <path-to-clone> checkout v<previous-version>
```

```bash
claude plugin marketplace update sapu
```

```bash
claude plugin update sapu@sapu --scope project
```

Start a new session, and check the version with `claude plugin list --json` (the `version` of `sapu@sapu`). When `update` says the plugin is already at the latest version although the version differs, uninstall it at that scope and install it again. To return to the newest version, add the marketplace again without `#<tag>` (or check out the base branch in the clone) and repeat the same steps. A rollback changes only the plugin: the repo's contract and profiles stay as they are, and a contract key the older version does not know makes it stop with "unknown key", so remove that key while you run the older version.

### A new machine

Everything sapu needs on a machine, in order. The repos themselves hold their contract and profiles (unless the contract is local, step 5), so nothing else has to be copied over.

1. **Tools:** Node ≥ 22.18, bash, git, jq, and `gh` signed in with the account the repos' contracts name (`gh auth login`; for a private marketplace also `gh auth setup-git`, so that Claude Code's git can clone it without a prompt).
2. **The marketplace:** `claude plugin marketplace add sandalkuilang/sapu` (or `<path-to-clone>` for a local clone; `#v<version>` to pin a version, above).
3. **Each repo that uses sapu:** `claude plugin install sapu@sapu --scope project` from its main checkout. A repo whose committed `.claude/settings.json` already enables sapu still needs this once on a new machine: Claude Code does not fetch a plugin that only project settings enable. Then `git config --local user.email <gitEmail of the contract>`.
4. **The machine config (optional):** `~/.config/sapu/config.json` with `allowedRoots` and `projectScopeOnly` ([Safety and trust](security.md#restricting-where-sapu-may-run-optional)). It belongs to this machine and is never in a repo, so write it again; without it, sapu runs in any checkout whose contract matches.
5. **Local contracts:** a repo with a local contract keeps it in `~/.config/sapu/repos/<owner>__<name>/` on the old machine only. Copy that folder over, or run `/sapu:init` there again.
6. **Per-repo session settings:** in a new session in each repo, run `/sapu:init`. With a contract in place it only completes what is missing, and it writes this machine's `.claude/settings.local.json` (the working-directory reset, the agent-memory links, `GH_HOST` for a GitHub Enterprise host) and the `.git/info/exclude` lines, which are never committed.
7. **The journey lane, where a repo uses it:** a Chrome-family browser and `lsof` or `ss` on the machine, and the repo's env file (`.argus/live.env` as `/sapu:init` writes it), which is never committed: fill in its values again (`.argus/live.json` names them), then run `argus-live.mjs check` from the main checkout.
8. **Contributors to this repo:** recreate `.sapu-banned` at the root of the clone, if you keep one ([Contributing](contributing.md)): it is gitignored, so it does not come with the clone.

Then check one repo: in a session there, `/sapu:init`'s preflight reports the account, the install scope and the allowed root; `claude plugin list` shows `sapu@sapu` and `senior-dev-team@sapu` enabled.

### Common problems

| Message | What it means |
|---|---|
| `…/.claude/sapu.json not found … (run /sapu:init)` | This repo has no contract yet. Run `/sapu:init`. |
| `refusing to run here: … is outside the allowed roots in …/sapu/config.json` | This checkout is outside your machine config's `allowedRoots`, and is refused on purpose. Move the checkout, or change the machine config; a repo contract cannot change it. |
| `machine config … is invalid` | The machine config is malformed (an unknown key, a wrong type, or an empty `allowedRoots`). Fix it per the section "Restricting where sapu may run". |
| `… installed at USER scope …` / `cannot confirm the plugin's install scope` | The machine config sets `projectScopeOnly`, and the plugin is installed at user scope (or `claude plugin list --json` failed / shows no project-scope install). Uninstall it (`claude plugin uninstall sapu@sapu --scope user`), then install it with `--scope project` in the repo that opts in. |
| `HOME is …, not this account's home directory …` | `$HOME` points somewhere else than your account's own home directory (often through `env` in a settings file), which would hide the machine config. Run sapu with `HOME` set to the path the message names. |
| `gate.merge (…) pins no repo file …` or `gate.merge's pinned file … finds the tree from its own location …` (from `show` or `check`) | A warning, not a stop. The first: the merge gate runs the PR's own copy of its logic, so a PR can change the gate that judges it; write the gate as a repo script or a `make`/`just` target. The second: the pinned file runs from the main checkout's path, so a gate that finds the tree from its own location tests the main checkout; find it through the cwd or `$SAPU_WT` instead. |
| `active gh account is "…", the contract needs "…"` | The active `gh` account is wrong. Switch it yourself with `gh auth switch --user <the contract's ghUser>`, then try again. |
| A `senior-dev-team:…` agent is not found | The dependency is missing or disabled. Run `claude plugin install senior-dev-team@sapu` (`--scope user` to use it in every project, `--scope project` for this repo only), then start a new session. `claude plugin update` does not install it. |
| `… moves the session's cwd into the linked worktree …` or `an Agent call starts its agents in your cwd …` | The main session tried to `cd` into a worktree (or dispatch from one). Agents start in the session's cwd and take their project memory from that checkout, so their notes would land in a worktree and be lost with it. Run worktree commands as `git -C <wt> …` or `( cd <wt> && … )`. `/sapu:init` sets `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1` in `.claude/settings.local.json`, which makes Claude Code reset the cwd after every command (from the next session); the guard then skips its `cd` check. |
| A lane stops with a "canary" reason | The guard hook is not active. Make sure `claude plugin list` shows `sapu@sapu` enabled at project scope, then start a new session. |
| The wave log shows `WARNING #…: step budget off — …` | The guard is live, but it cannot count that worker's tool calls, so no hand-off reminder comes and a long worker grows its context unchecked. `off: this hook input carries no agent_id` = this Claude Code version does not pass `agent_id` to the hook of a Workflow agent (update Claude Code); `off: … sapu-steps cannot be written` = fix that path's permissions; `off: no step_budget in its return` = the worker did not report what the canary told it (read its trail). The sweep goes on. The first sweep after an upgrade is the check: no such line means the budget counts. |
| A lane's issue blocked with `PR #… fails pr-trust: … no reviewer dispatched` | The worker's own `pr-trust` check refused its PR, usually a `#` written in prose (`invariant #6`) that names an issue outside the trusted set. Edit the PR body (`invariant 6`, or put the number in backticks); the next session's Phase A picks the PR up. |
| `refusing untrusted PR #… (rule: …)` | `pr-trust` refused it: a fork, an author or commit author outside the trusted set, an unsigned commit (with `requireSignedCommits`), or an issue it closes or refs that fails `issue-trust`. sapu never gates or merges it: review it yourself, or, when its author should be trusted, add `{"login", "id"}` to `trustedAuthors`. |
| `issue #… untrusted: …` | The issue's author is outside the trusted set, and no trusted account applied the acceptance label (or it was removed, or an outsider edited the text since). Read it; to let sapu work it, apply `sapu:accepted` (or the contract's `labels.accepted`). |
| `cannot read issue #… from GitHub (…): its trust is unknown, so it is refused` | `issue-trust` could not read the issue whole, so it refuses it (fail closed). Usually GitHub did not answer: try again. `… has more timeline events than can be checked` = more than 50 pages of label and title events; work that issue by hand. |
| A worker's trail shows `` `git commit` in a directory that cannot be told … `` | The guard cannot tell which checkout a git command that changes files acts on: a path in a variable, after a `cd` inside a pipeline, or in a `$( )` (`git -C $(pwd) commit`, quoted or not). The worker writes the literal path of its worktree instead; no action needed unless a profile tells workers to use that form. |
| `trustedAuthors: "…" now resolves to …` | A trusted login was renamed, deleted, or taken by another account. Find out who that account is now, then fix or remove the entry. |
| A merge exits with code 2 (gate red) | Not merged; the worktree is kept for diagnosis. The last lines name the failing test files and a flake verdict from `.git/sapu-gates.log`. sapu re-runs a PR's gate at most once, then checks the failing files on the base branch (see "How a merge works"). |
| `another sapu sweep holds this repo: sapu-run-…, last heartbeat … min ago` | Another `/sapu:sapu` session is sweeping this repo (its marker is `.git/sapu-sweep.json` in the main checkout), so this one stops before touching anything: two would race for the same issues and merges. Let it finish. A marker whose heartbeat is older than 3 hours is stale and taken over by the next session; when that session is gone sooner (closed, crashed), remove it yourself with the `sweep clear` command the message prints. |
| `another sapu-merge run holds …/sapu-merge.lock` | Another merge is running. When none is (a previous run was killed), remove the lock with the `rmdir` command the message prints. |
| A merge exits with code 3 | The PR is already merged, but the repo's own cleanup (`mergeAfter`) failed. Read its message and fix it before the next merge. |
| `test infrastructure is down: gate.infra (…) exited …` | `wave-args` ran the contract's `gate.infra` probe and it failed, so no lane is built (a worker would only wait on it). Start the infrastructure as the profile's Step 0 says (e.g. the DB container), then try again. |
| A merge says "gate setup failed" (the gate exited 75; the script exits 1) | The infrastructure is not ready (for example, the DB container is down). This is not a PR defect: get the infrastructure ready, then try again. |
| `refused: cycle <run> holds the lock until <time>` | Another journey cycle runs on this repo (its lock is `.argus/live/lock.json` in the main checkout). Let it finish. If its session is gone, its reaper runs `down` at that time, and the next `up` recovers whatever is left; never remove the lock by hand. |
| `refused: ${NAME} is unset (<env_file> gives it no value)` | A secret `.argus/live.json` names has no value yet. Fill it in the env file (`.argus/live.env` as `/sapu:init` writes it) yourself (no agent reads that file), then run `argus-live.mjs check` again. |
| `refused: env_file … is not in the contract's guard.envFiles (/sapu:init adds it)` | The guard would let agents read your env file, so `check` and `up` refuse it. Run `/sapu:init`, which adds its file name to `guard.envFiles`, and commit the contract: `up` reads the committed one. |
| `refused: …/.playwright/cli.config.json exists; …` | A browser CLI config of your own would merge underneath the run's config. Move it aside while you use the lane. |
| `refused: no Chrome-family browser (Google Chrome or Microsoft Edge) is installed; …` | Install Google Chrome, or run the `install-browser chrome` command the message prints. |
| `refused: the pinned browser CLI (@playwright/cli …) cannot be installed: …` | The first `up` installs the browser CLI with npm, and npm failed (its error follows). Make the network or the npm cache available, then start the cycle again. |
| `refused: neither lsof nor ss is available` | The lane checks what the run's processes connect to and who holds a port with `lsof` or `ss`. Install one of them. |
| `refused: scrub: the run's secret ledger is incomplete (…); nothing from this run is filed` (or `… is gone …`) | `scrub` cannot prove an issue holds no secret the run saw, so nothing from that run is filed; the cycle's journal keeps its candidates. Run another cycle. |
| A journey cycle was cut short (the session died, or `up` ended without its summary line) | Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/argus-live.mjs" down` from the main checkout; `status` shows what is still running. Without it, the reaper runs `down` at the cycle's deadline. |

