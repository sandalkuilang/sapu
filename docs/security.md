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

gh's token stays with gh: the guard refuses every subagent `gh auth token`, `gh auth status --show-token` (`-t`), `gh auth git-credential`, `git credential …` and reading gh's `hosts.yml`, because with the token `curl` reaches the GitHub API around every rule the guard keeps on `gh` (the labels, merges, new issues). A token already in the environment (`GH_TOKEN`, `GITHUB_TOKEN`) is not hidden from an agent, so let gh keep its own login rather than exporting one into the sessions sapu runs in.

Also protect the repo on GitHub itself: branch protection on the base branch (PRs required, no direct or force pushes), and approval before Actions workflows run on outside contributors' PRs. The full rules and their limits are in [`CONTRACT.md`](../plugins/sapu/CONTRACT.md) §Trusted authors.

