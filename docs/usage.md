# Install and use

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

When the marketplace repo is private, cloning it uses your existing git credentials (`gh auth git-credential`), so the active `gh` account must have access to that repo.

Once installed, run `/sapu:init` in a new session to write a draft contract. Review that draft, then commit it together with `.claude/settings.json`.

The draft also holds project-level aliases `.claude/skills/<name>/SKILL.md` (never in `~/.claude/skills`), so typing `/sapu`, `/forge`, … is enough instead of `/sapu:sapu`, `/sapu:forge`, ….

## Usage

### Once per repo

1. Install the plugin at project scope (see above), then **start a new session**. A plugin loads when a session starts.
2. Type `/sapu:init`. It scans the repo and writes a draft contract: `.claude/sapu.json` and the profiles `.claude/sapu/*.md`. It also creates the short aliases `/sapu`, `/forge`, and so on. Every question it asks is one you really have to decide: the account, the gate commands, the protected databases, and the nemesis targets.
3. Review the draft, then merge it through a PR. From then on the skills below can be used.

Each profile's `##` section headings are English and match exactly what `sapu-contract.mjs profiles --list` prints for that skill.

Repo requirements:
- a GitHub remote, with the account its contract names (`ghUser`, `gitEmail`, `repo`);
- real tests that can run as the merge gate;
- a `CLAUDE.md`.

A repo without tests can only use `/dream`.

### Day to day

| To do what | Type | What happens |
|---|---|---|
| Clean up every open PR and issue | `/sapu` | **Phase A:** every open PR is reviewed, fixed, or closed. **Phase B:** each issue is one Workflow call, up to `lanes` in flight (from the machine's cores and memory). Every PR is reviewed by an agent that is not its author, and a merge happens only after a green gate. Every issue ends *merged*, *skipped* (with a reason), or *blocked* (with a reason). |
| Work one issue through to a PR | `/forge 123` | Creates a branch, implements + tests, then opens a PR. This skill never merges on its own. |
| Hunt bugs, fraud gaps and UI defects in the running dev app | `/argus` | Needs the dev app running and `.argus/config.yml`. Findings are filed as deduplicated issues. |
| Release-readiness audit | `/momus` | Produces a report per area. Issues are filed only when you ask for it. |
| Try to break into the dev app (red team) | `/nemesis` | Attacks only the targets in a `.nemesis/authorization.yml` you signed yourself, and only dev hosts (localhost). |
| Full audit before release: momus → argus → nemesis | `/inspector` | Runs the three in sequence (never at the same time), each with its own model and effort, then one combined summary plus a security roll-up. `/inspector payments` narrows all three to one area and adds a read-only team review. The prerequisites of `/momus`, `/argus`, and `/nemesis` apply. |
| Research where technology is heading (auth, security, UI/UX, databases, payments, …) and experiment ideas for this project | `/dream` | One local report in `dreams/` holding sourced findings, hypotheses with kill conditions, and a month of experiments; changes no code and writes nothing to GitHub. |

Without the aliases, the full names are `/sapu:sapu`, `/sapu:forge`, and so on. Plain chat ("run sapu", "work issue 123 with forge") also triggers the matching skill.

`/sapu` tips:
- Run it in a **new session**, and only one sapu session per repo at a time.
- To skip certain PRs: `/sapu skip PR #<number>`.
- A session ends between waves once its context passes about 750k tokens (600k at the end of Phase A). Its summary is written to project memory, then you are asked to start a new session with `/sapu`, which continues from that summary.
- The final report holds the PR and issue tables, the decisions taken with their sources, and the metrics per session: tokens and their cost in dollars at API prices (a weight for quota use on a subscription), per merged PR.

What is enforced, and by what:
- **The merge script** (`sapu-merge.sh`, the only way sapu merges) gates or merges only a PR that `sapu-contract.mjs pr-trust` passes (see "Public repositories"), only after a green gate, pinned to the gated commit. Each merge it makes is recorded in `.git/sapu-merges.log` of the main checkout, which the session metrics count merged PRs from, and every gate run, red ones too, in `.git/sapu-gates.log`: a red run names its failing test files and a flake verdict (`known-flake` when each of them is proven flaky: red, then green on the same tree, in another PR).
- **The guard hook** refuses a worker or reviewer agent's direct push or force-push to the main branch, a merge, the common ways to bring a PR's or a fork's code into a worktree (`gh pr checkout`, fetching PR refs, applying a PR's diff, cloning), any change to the acceptance label, touching the dev database or `.env` files, and writing into the main checkout, also when the command runs through context-mode's `ctx_*` tools; it also reminds a worker at 120 tool calls to hand off to a fresh one — the exact list, and what it does not trace, is in [`CONTRACT.md`](plugins/sapu/CONTRACT.md) §Engine floor. It reads commands, not intent: built for honest mistakes, it is not a sandbox against an agent set on getting around it. And it guards **subagents only**: a skill you start yourself (`/sapu`, `/forge`, `/argus`, `/momus`, `/nemesis`) runs at the top level, unguarded, with your gh token — there only the skills' own rules hold.
- **The scope lock** (`sapu-contract.mjs check`) refuses to run in a checkout outside the roots the machine config allows, or with the wrong account.
- Everything else in the skills — what to read, what counts as instructions — is a rule for the agents, not a lock.

### Specialist agents

Reviewers and advisers (the 🔴 review pair, forge's QA, the `/inspector` team review) are called by role: `qa`, `architect`, `db`, `developer`, `ux`, `writer`, `product`. The plugin ships built-in agents for all seven (`sapu:sapu-qa`, `sapu:sapu-architect`, …), so sapu runs on any machine without extra agents. A repo that has stronger agents of its own can map roles to them through the optional `specialists` field of `.claude/sapu.json`, e.g. `"specialists": {"qa": "my-qa-agent"}`; roles it does not name keep the built-in. The format is in [`CONTRACT.md`](plugins/sapu/CONTRACT.md) §Specialist agents.


### Updating the plugin

Auto-update is off, so a new version only arrives when you pull it yourself:

```bash
claude plugin marketplace update sapu
```

```bash
claude plugin update sapu@sapu --scope project
```

Then start a new session. Both commands also work for a marketplace from a local folder: the first re-reads that folder, and the second copies its new version into the cache. When the version did not go up, nothing is copied. To check that the installed copy matches its source:

```bash
claude plugin list --json
```

Take the `installPath` of the `sapu@sapu` entry, then compare that folder with `plugins/sapu` in the clone using `diff -rq`.

### Common problems

| Message | What it means |
|---|---|
| `…/.claude/sapu.json not found … (run /sapu:init)` | This repo has no contract yet. Run `/sapu:init`. |
| `refusing to run here: … is outside the allowed roots in …/sapu/config.json` | This checkout is outside your machine config's `allowedRoots`, and is refused on purpose. Move the checkout, or change the machine config; a repo contract cannot change it. |
| `machine config … is invalid` | The machine config is malformed (an unknown key, a wrong type, or an empty `allowedRoots`). Fix it per the section "Restricting where sapu may run". |
| `… installed at USER scope …` / `cannot confirm the plugin's install scope` | The machine config sets `projectScopeOnly`, and the plugin is installed at user scope (or `claude plugin list --json` failed / shows no project-scope install). Uninstall it (`claude plugin uninstall sapu@sapu --scope user`), then install it with `--scope project` in the repo that opts in. |
| `active gh account is "…", the contract needs "…"` | The active `gh` account is wrong. Switch it yourself with `gh auth switch --user <the contract's ghUser>`, then try again. |
| A wave stops with a "canary" reason | The guard hook is not active. Make sure `claude plugin list` shows `sapu@sapu` enabled at project scope, then start a new session. |
| A wave item blocked with `PR #… fails pr-trust: … no reviewer dispatched` | The worker's own `pr-trust` check refused its PR, usually a `#` written in prose (`invariant #6`) that names an issue outside the trusted set. Edit the PR body (`invariant 6`, or put the number in backticks); the next session's Phase A picks the PR up. |
| `refusing untrusted PR #… (rule: …)` | `pr-trust` refused it: a fork, an author or commit author outside the trusted set, an unsigned commit (with `requireSignedCommits`), or an issue it closes or refs that fails `issue-trust`. sapu never gates or merges it: review it yourself, or, when its author should be trusted, add `{"login", "id"}` to `trustedAuthors`. |
| `issue #… untrusted: …` | The issue's author is outside the trusted set, and no trusted account applied the acceptance label (or it was removed, or an outsider edited the text since). Read it; to let sapu work it, apply `sapu:accepted` (or the contract's `labels.accepted`). |
| `trustedAuthors: "…" now resolves to …` | A trusted login was renamed, deleted, or taken by another account. Find out who that account is now, then fix or remove the entry. |
| A merge exits with code 3 | The PR is already merged, but the repo's own cleanup (`mergeAfter`) failed. Read its message and fix it before the next merge. |
| A merge exits with code 75 / "gate setup failed" | The infrastructure is not ready (for example, the DB container is down). This is not a PR defect: get the infrastructure ready, then try again. |

