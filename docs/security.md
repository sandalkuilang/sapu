# Safety and trust

<sub><a href="../README.md">README</a> · <a href="usage.md">Install and use</a> · <a href="agents.md">How the agents work</a> · <b>Safety and trust</b> · <a href="contributing.md">Contributing</a></sub>

## Where sapu may run

Three layers, none of which assumes who the owner is:

1. **Project scope.** Install the plugin with `--scope project`, so that only a repo that commits its `enabledPlugins` loads it: a repo opts in explicitly. At user scope, the plugin — including its guard hook for subagents — is active in every repo on that machine; `projectScopeOnly: true` in the machine config makes sapu refuse to run in that state.
2. **Identity from the contract.** The repo contract (committed in the repo, or local in `~/.config/sapu/repos/<owner>__<name>/`, where no subagent may write) names its account (`ghUser`, `gitEmail`, `repo`). `sapu-contract.mjs check` refuses to run when the active `gh` account is not the contract's `ghUser`, when `git config --local user.email` is not the contract's `gitEmail`, or when `origin` is not the contract's `repo`.
3. **Machine limits (optional).** A per-machine config belonging to the person who uses that machine may restrict checkouts to certain roots and require project scope (next section). The contract cannot widen it, and `/sapu:init` refuses repos outside those roots.

## Restricting where sapu may run (optional)

It lives only at `~/.config/sapu/config.json`. `XDG_CONFIG_HOME` is deliberately ignored: env variables can be set by the `.claude/settings.json` a repo commits. For the same reason sapu refuses to run when `$HOME` is not your account's own home directory: a moved `HOME` would hide this file. This file belongs to one person on one machine and is never committed to any repo. sapu never reads it from a repo, so a repo contract cannot loosen it; a config that turns out to live inside the repo's own checkout is refused.

```json
{
  "allowedRoots": ["~/projects"],
  "projectScopeOnly": true
}
```

| Key | Meaning |
|---|---|
| `allowedRoots` | A list of directories, absolute or `~/…`. The main checkout must be **inside** one of them: symlinks are resolved on both sides, and the root itself does not count. |
| `projectScopeOnly` | `true` = refuse to run when the plugin is installed at user scope, or when its install scope cannot be determined. |

Both keys are optional. Without the file, there is no root limit and no user-scope refusal; only the identity from the contract is checked. An unknown key, a wrong type, or an empty `allowedRoots` is an error: sapu stops with its message, so that a typo never silently lifts a restriction. So is a file that exists but cannot be read, and a symlink on its path that does not end in a file (write `{}` when you really want no restriction).

Example: when one machine holds repos that may be swept and repos that may not, put the ones that may under one folder (e.g. `~/projects`) and write the config above. sapu then refuses to run outside that folder, whatever the repo contract says.

On a new machine, write this file again: it is never in a repo. [Install and use](usage.md#a-new-machine) lists everything a new machine needs.

### Public repositories

In a public repo anyone can open a PR or an issue and comment on both, and sapu works without asking. So only the **trusted set** steers it: the account that runs sapu (the contract's `ghUser`) plus the optional `trustedAuthors` in `.claude/sapu.json`, each written with its numeric GitHub id — `{"login": "alice", "id": 2}`, the id from `gh api users/alice --jq .id`. The id is what is compared everywhere, because a login can be renamed and re-registered by someone else; `sapu-contract.mjs check` stops when a recorded login no longer belongs to its id.

What an outsider (an account outside that set) **cannot** make sapu do:
- **Run their code on your machine.** A PR from a fork, opened by an outsider, or carrying an outsider's commit is never checked out, never gated (the gate runs the PR's tests) and never merged: `sapu-merge.sh` refuses it before it touches anything, agents cannot check it out or apply its diff, and the sweep lists it (number and author only) in its final report for you. So is a PR that closes or refs an issue sapu may not work.
- **Put their issue into a sweep.** sapu skips it until a trusted account applies the acceptance label (`sapu:accepted`, or the contract's `labels.accepted`) — and applying it is yours to do: no agent may touch that label. Any edit or new title by an outsider after that, or in the 10 minutes before it, undoes the acceptance (so does renaming or editing the label, even only its colour or description), and an agent reads the issue only from the same snapshot the check judged.
- **Steer an agent through a comment,** or hide a finding behind a decoy issue: comments are read only through `sapu-contract.mjs issue-trust <N> --comments`, which drops everyone else's, and an outsider's issue never counts as a duplicate.

What an outsider still **can** do: open PRs and issues sapu will not act on, and put text in the body of an issue you accepted. Agents treat all of it as data, never as instructions, but that is a rule for a model, not a sandbox: read an outsider's issue — and the last edit its verdict shows — before you apply the label.

Four things to decide yourself:
- **Who may accept.** Every agent works under the account that runs sapu, so a label that account applies could be an agent's — and top-level skills are not guarded. Set `labels.acceptors` to the human account(s) that accept (`{"login", "id"}`, like `trustedAuthors`) and leave the account sapu runs under out of it. If sapu runs under your own gh account, that separation is only possible by accepting from another account (or running sapu under its own bot account); otherwise acceptance rests on the skills' rule that no agent touches the label.
- **Signed commits.** Your `gitEmail` is public in the contract, and GitHub credits a commit to whichever account owns its email — so without signatures the commit check is only attribution. If you ever push an outsider's branch into your repo (to finish or adopt it), set `"requireSignedCommits": true` and sign your commits: then every PR commit must carry a signature GitHub verifies, by a trusted account. Commits GitHub signs itself (the web UI's "Update branch", accepted suggestions) are refused then; never trust the `web-flow` account to get them through. Replace them with your own signed commits instead: a signed `git rebase --force-rebase --gpg-sign` of the branch and a force-push ([the contract](../plugins/sapu/CONTRACT.md) has the commands).
- **Agent-filed issues.** argus, nemesis, momus, forge and the orchestrator file issues under the account that runs sapu, so they pass the trust check by author, and such an issue may quote outside material (a page, a response, a log line) nobody has read yet. Each carries the agent-filed label (`sapu:agent-filed`, or the contract's `labels.agentFiled`), which no agent may remove. Set `"agentFiledNeedsAcceptance": true` (it needs `policy.traces` `"visible"`) to have them wait like an outsider's issue: sapu works one only after an acceptor applied the acceptance label, only an acceptor may edit it after that, and the guard refuses a subagent's new issue without the agent-filed label. Under that setting the label counts once applied, even after someone removes it (`issue-trust` reads the issue's label history), and no author is trusted while the agent-filed label is missing from the repository: GitHub names a renamed or deleted label otherwise on every issue it was on, so rename it back, or re-create it. Without the setting the author alone decides. List the humans as `labels.acceptors` with it, or the agents' own account could accept and edit their issues. The orchestrator is not guarded: that it labels its own issues is a rule of the skill.
- **Bots.** Trusting an app (`github-actions[bot]`, a dependency bot, a coding agent) trusts whoever can make it act — list one in `trustedAuthors` only when only trusted people can.

gh's token stays with gh as far as the guard can see: it refuses every subagent the direct ways to it — `gh auth token`, `gh auth status --show-token` (`-t`), `gh auth git-credential`, `gh config get oauth_token`, `git credential …` and the `git-credential-*` helpers, and reading, copying or archiving gh's `hosts.yml` or git's store files (`~/.git-credentials`, `~/.config/git/credentials`) — because with the token `curl` reaches the GitHub API around every rule the guard keeps on `gh` (the labels, merges, new issues). It is not a sandbox: an interpreter reading the file (`python`, `node -e`, `perl`), an archiver or other tool whose own directory option moves where a path resolves (`tar -C`), the OS keychain read directly (`security find-internet-password`) and a script piped into `sh` are named limits in the guard. A token already in the environment (`GH_TOKEN`, `GITHUB_TOKEN`) is not hidden from an agent either, so let gh keep its own login rather than exporting one into the sessions sapu runs in.

Also protect the repo on GitHub itself: branch protection on the base branch (PRs required, no direct or force pushes), and approval before Actions workflows run on outside contributors' PRs. The full rules and their limits are in [`CONTRACT.md`](../plugins/sapu/CONTRACT.md) §Trusted authors.


## The journey lane

`/journey` drives your app through a real browser as every role a business journey needs, so it is the one skill that starts your app, signs in to it and reads what its pages say. Its rules start from one stance: `.argus/live.json` and the repo are yours and trusted, the pages are not. The checks below exist to catch a misconfiguration or an app default that would make a cycle touch your servers, services or data, and to keep page text from steering an agent. They are defence in depth, not a sandbox against a repo written to escape them.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="img/journey-boundary-dark.svg">
  <img src="img/journey-boundary.svg" alt="The journey lane's trust boundary: the orchestrator in the main session dispatches a guarded explorer whose Bash runs only the pw wrapper and whose Read reaches only files committed in the run's worktree; the wrapper drives one browser session per account through a filtering proxy to an isolated instance with its own worktree, ports, data and HOME, never the owner's servers; page text returns only inside nonce fences; and a candidate leaves the machine only after a script reproduced it two of two and scrub found no secret the run saw (its 0600 ledger) or the configuration holds in it; the smoke suite reaches the owner's repo only as a pull request that scrub's matcher has checked and the owner merges, its CI workflow runs read-only with pinned actions, and text from issues, docs and CI artifacts is read only as fenced data." width="100%">
</picture>

**An instance of its own.** `argus-live.mjs up` builds every cycle's instance: a worktree at HEAD, ports from the file's `port_range` (never one of `reserved_ports`), its own HOME and browser HOME, its own Docker client and Compose project, the one datastore `store` names (which `reset` recreates with synthetic data), and an environment holding only what the file names. One cycle runs per repo, under a lock with a deadline; a reaper runs `down` at that deadline if the session dies, and `down` stops only what `up` started. `up` refuses, and tears down whatever it already started:
- a base URL whose host does not resolve to loopback only;
- a `services` entry the instance environment does not move to an address of its own (the app would fall back to your service);
- a store that `guard.postgres` or `guard.databases` protects, and a `store_check` that prints any other store;
- an `env_file` whose name the committed contract's `guard.envFiles` does not hold (any agent could read it), or that git tracks or does not ignore;
- a password or TOTP secret written into the file itself, rather than as a `${NAME}` the env file gives;
- an environment value that reaches what your own env files (`.env`, `.env.local`, `guard.envFiles`) name, a protected port or database, a path inside your main checkout, or a port of the Docker host that is not the run's;
- a file without both of your statements (`confirmed.mocks`: outbound integrations run in test or mock mode; `confirmed.data`: the data `reset` creates is synthetic).

`argus-live.mjs check`, which `/sapu:init` runs on its draft, makes `up`'s checks of the file itself (its schema, every unset `${NAME}`, the base URLs, the `services`, a protected `store`, a literal password or TOTP secret, an env file git tracks or does not ignore) and of the env file against the draft contract's `guard.envFiles`, without starting anything.

After start-up, an egress check compares what the run's processes connect to with what the run allows, and a Docker runtime gate ends the cycle when anything touches a Docker object older than the cycle (your own work on the same daemon included). `renew` runs both again.

**The browser's network, in layers.** Every request of the run's browsers, loopback included, goes through the run's filtering proxy, which admits only the run's own origins and `allow_origins`; Chrome's host resolver maps every other host to nothing, WebRTC is held to the proxy, and Chrome's own background services are kept quiet. Origins are compared exactly, so `http://127.0.0.1:<port>` is not `http://localhost:<port>`.

**The explorer is confined.** The agent that walks a journey, `sapu:ui-explorer`, has three tools (Bash, Read, StructuredOutput), and the guard refuses every other tool it sees, Agent, Task and Workflow included. Its Bash runs only `node <wrapper> pw …`, the wrapper named by its real path in the plugin, with single-quoted or plain-word arguments: no `$`, backtick, glob, pipe, redirection or environment prefix, so no `curl`, `gh`, git or `printenv` either. Its Read reaches only files committed at HEAD in the run's worktree, outside `.argus/`; it has no Grep or Glob. The wrapper itself allowlists every command and flag, keeps every URL inside the run's origins, passes every value after `--` so none is read as an option, and offers no `run-code` or `eval`. It counts each explorer's calls against `limits.explorer_pw_calls`, stops a loop, and ends at the deadline. Each explorer gets a token of its own, printed once to the orchestrator; the run's files keep only its sha256. The lane's script itself is the orchestrator's: any other subagent runs only its reads (`status`, `status --json`, `check`, `smoke check`), and the guard refuses it `up`, `down`, `slot`, `repro`, `scrub` and every other verb.

**Page text is data.** Everything a page or an app command printed reaches the explorer inside a `<<<PAGE-…` fence with a fresh random nonce, and an explorer's return reaches the orchestrator only through `intake`, inside a `<<<RETURN-…` fence. Both read fenced text as data, never as instructions; text that tries to instruct is itself a candidate (stored injection). The orchestrator never reads the run's files or an explorer's final message: only `status --json` and `intake`.

**Secrets never travel as text.** A password or TOTP secret is a `${NAME}` in `.argus/live.json`, its value only in the env file the guard keeps from every agent. In a field the shell runs, `${NAME}` becomes a reference to `ARGUS_SECRET_<NAME>`, which only that command's environment carries, so the value is never written into a command line or a run file. Every line the lane prints is masked with the env file's values. The secrets a cycle meets on its own (session cookies, tokens, the passwords of accounts a journey created) go into the run's secret ledger, `.argus/live/<run>/logs/secrets.jsonl`, written 0600, kept by `down` and removed by the next `up`.

**Nothing leaves before two checks pass.** The explorer only suspects. A script replays each candidate on a freshly reset instance, and only a candidate that reproduces two of two goes on: it is minimized, turned into a Playwright RED test, and classified. Then `scrub`, the only way the lane files, checks the title and body against every secret the ledger and the configuration hold, in any encoding it knows. A hit refuses the issue and names where it is (`<title|body> <line>:<col> <class>`), never what it is. A run whose ledger is incomplete, gone or damaged, a map run, and a candidate that did not reproduce two of two file nothing at all. What passes still has long tokens the run never saw redacted, and mentions, issue references and outside links defanged. Every issue it files carries the agent-filed label, and it refuses one carrying the acceptance label or a policy with `fileIssues: false`.

**Screenshots and traces.** The explorer takes a screenshot only as a candidate's evidence, and the wrapper writes its verdict as it is taken: one showing a secret, a password field, a one-time-code field or an error page is never attached. `scrub` attaches the rest only to a private or internal repository, with the policy's traces visible and gh 2.99 or later; otherwise it keeps them on your machine and lists them in a `Local evidence:` line. Traces are never attached.

**Findings you rule on.** A finding only you can judge carries the needs-owner label, which `/sapu` skips. Removing that label, or closing the issue as not planned, is your ruling, and the guard refuses both to every subagent.

Known limits, in short: process groups bound every kill and listing, so a process that leaves its group (`setsid`, a double fork) is neither killed nor listed; the egress check samples, and does not list processes inside containers; a custom Docker bridge subnet escapes the host-name checks; a slot's token is in the process list while a browser call runs, so the lane assumes a single-user machine; and nothing is enforced by the operating system. The full list is in [`skills/journey/live.md`](../plugins/sapu/skills/journey/live.md#known-limits), and the guard's rules for the explorer are in [`CONTRACT.md`](../plugins/sapu/CONTRACT.md) §Engine floor.


## The smoke suite

`/journey smoke` leaves a test suite in your repo and a workflow in your CI, so it adds two things the exploratory lane does not have: code that runs on a CI runner with your secrets, and text from outside the machine (CI artifacts, issues, docs) that the lane reads back. The lane's own stance is unchanged: `.argus/live.json`, `.argus/smoke.json` and the repo are yours and trusted; pages, CI artifacts and issue text are not. The lower half of the trust-boundary diagram above shows where the new flows cross it. What each layer does and what it does not do:

**What reaches your repo, and how.**
- Every change to the suite (a path, a heal, a quarantine, a drop, a baseline, a regenerated file) is a pull request on an `argus/` branch, labelled agent-filed. sapu works issues and its own branches are not `argus/`, so it never merges one. Your merge is the acceptance. A pull request you close unmerged is remembered by the change's digest and is not proposed again.
- Before a push, `smoke propose` and `smoke baseline` run every file and the pull request body through `scrub`'s matcher over the secrets the run saw and the configuration holds. A hit refuses the whole proposal and names where, never what. PNG baselines cannot be scanned as text: the screenshot masks cover the values a path typed or read, and you review the images in the pull request.
- The suite is generated from data by the generator alone: every string of a path is a JSON literal or a variable, no path data goes into a template literal, and test titles hold only ids, step numbers and kinds. A password or TOTP secret that is not a `${NAME}` reference is refused when the suite is generated. A header digest in each generated file lets `smoke check` name a hand edit.
- `smoke propose` commits with `--no-verify`: a fresh worktree has none of your hook tooling installed. CI runs the suite either way.

**What runs in CI.**
- The workflow has `permissions: contents: read`, never `pull_request_target`, and checks out without persisted credentials. Every action is pinned to a full commit SHA, resolved when the file is printed. A pull request from a fork runs no job.
- Dispatch inputs reach the shell only through `env:` and are checked against fixed shapes first (`missing` or `changed`; journey ids joined by `|`).
- The secrets a job gets are the `${NAME}` names that `.argus/live.json` uses, passed by name, and only to jobs for same-repository events. The generated code reads them from the environment by name, and the workflow file holds names, never a value.
- The suite drives loopback only: the generated config throws unless its base URL is on a loopback host. The lane's isolation (its own worktree, ports, HOME, proxy and datastore) is not reproduced in CI. There, a disposable runner is the isolation, and the datastore holds the users `live.json` names.

**Sessions, traces and artifacts.**
- A signed-in state is a file of session cookies: `.auth/<role>.<k>.json` in the suite directory, written with mode 0600, gitignored by the suite's own `.gitignore` and never uploaded.
- A trace keeps every typed value, so nothing that types a password records one: the `setup` project signs each account in through the real sign-in page with no trace, and a test whose path has a `login` step (a password the path made itself) turns its trace off. No project records a video or a screenshot on failure; the `toHaveScreenshot` images of a failed comparison show a password field as the browser masks it. Every other test keeps a trace on the first retry; it holds what the page showed and the values the path typed (never a secret from `live.json`), stays in a CI artifact kept for 7 days, and `smoke ci` and `smoke baseline` never read it and never attach it to an issue.
- The lane reads a CI run only through the files it names: `results.json` and the screenshots and snapshots of the suite's own baseline names (a PNG under a size cap, never `msedge`, an ARIA file under a cap). It reads only runs of your own repository, never a fork's, and refuses a run whose branch has moved on. Text from a result (a check's key and detail, a failure message) is page text: it is fenced wherever it is printed, and the per-cycle report shows only triage lines of known shape, at most 200 characters each.

**Text from outside the machine.**
- A seed from an issue is read only when `sapu-contract.mjs issue-trust` passes for it, from the verdict's own snapshot. A seed from a doc is read from git's object for a regular tracked file at the cycle's worktree HEAD, never the working tree or a symlink.
- The text is cleaned and handed to the seeded map explorer in a `<<<SOURCE-…` fence. That explorer's token takes only `code`, `source` and `submit`; nothing in the text reaches a command line, a file name or a label. A journey the text names but your code does not anchor is dropped by `map-check`, and anything the explorer suspects still needs a two-of-two replay and your merge.
- **Fences are hygiene, not a boundary.** An injected instruction in an issue can at most waste the explorer's budget or yield a candidate that the replay refuses. The guarantees are the explorer's confinement (only the `pw` wrapper, no network out), the deterministic gates (`validateMap`, anchors, the two-of-two replay, the heal decision table) and your merge. sapu uses no model-based filter for this: such a filter is itself open to injection.

**Healing is reviewed.** A heal changes only how an action finds its control, at most `heal_max_steps` of them; it cannot add a step, change an expectation or a value, add a wait or skip a test. It is decided by re-running the unchanged expectations, never applied while a test runs, and arrives only as a pull request showing the old and new target.

**The commands.** The `smoke` verbs other than `check`, and `seed` and `report`, are the orchestrator's: the guard refuses them to every subagent. `smoke check` writes nothing and may be run by one. `smoke retire` records your ruling that a journey's break was intended, so the orchestrator runs it only on your word. The explorer's `pw` wrapper is unchanged; a seed token adds the read-only `source` command.

Known limits, in short:
- The guard binds subagents only. A skill you start yourself runs unguarded, and the smoke commands are the orchestrator's by the skills' rule and the guard's.
- A pull request from a branch in your repository runs its own copy of the suite and the workflow with your CI secrets. Whoever can push such a branch can read them from CI: keep the secrets to test accounts, protect the base branch, and review a pull request that touches the workflow or the suite before it runs, as you would any workflow change.
- A heal can pass off a regression as a UI change when a control moved to a place the role still reaches in the same number of steps. Read the old and new target and the `git log -S` evidence in the proposal.
- Screenshots are masked, not scanned: a secret that the app shows and the path never typed or read is visible in a baseline until you review it out.
- Every check exclusion has a fixture that pins it, and a result a script cannot decide is `manual`, not red. A check that still misfires is yours to silence with an `allow` entry, which sits in `.argus/smoke.json` for reviewers to see.
- `smoke perf` state (`.argus/perf.json`) is local, and a baseline measured on one machine is void on another.
- The full list for the lane the suite shares is in [`skills/journey/live.md`](../plugins/sapu/skills/journey/live.md#known-limits), and the guard's rules are in [`CONTRACT.md`](../plugins/sapu/CONTRACT.md) §Engine floor.
