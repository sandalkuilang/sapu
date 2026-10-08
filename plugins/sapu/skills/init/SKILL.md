---
name: init
description: Use when a repo needs the sapu contract before /sapu:sapu, /sapu:forge, /sapu:argus, /sapu:momus or /sapu:nemesis can run in it — scans the repo, drafts .claude/sapu.json and the .claude/sapu/<skill>.md profiles, checks each skill's prerequisites, and asks the owner to confirm the account and the gates (nemesis targets are never filled or confirmed by init: the owner signs .nemesis/authorization.yml). Refuses any repo outside the allowed roots of the owner's machine config. Triggers: "/sapu:init", "set up sapu".
---

# init — the repo contract for the sapu plugin

The other skills in this plugin are engines without repo knowledge; they read every repo fact from the contract (`${CLAUDE_PLUGIN_ROOT}/CONTRACT.md` — read it first, in full). `init` builds that contract. It is the only sapu skill that **asks the owner**: accounts and gates are the owner's decisions, not guesses; attack targets do not even go through init — the owner signs them personally in `.nemesis/authorization.yml`. Questions, summaries and the report are in the language CLAUDE.md sets for people (default English).

## 1. Preflight — refuse first, then work

`node "${CLAUDE_PLUGIN_ROOT}/scripts/sapu-contract.mjs" preflight` from the repo root. It prints JSON: `main`, `allowedRoot`, `machineConfig`, `projectScopeOnly`, `origin`, `ghLogin`, `gitEmail`, `userScopeInstall`, `hasContract`. Non-zero exit (a malformed machine config) → **stop** and report its message; never guess what that config meant.

- `allowedRoot: false` → **stop.** This repo is outside the roots the owner's machine config allows (`machineConfig`); on this machine sapu is not used in that repo. Never offer a way around it, and never suggest changing that config for this repo's sake — that is the owner's decision, outside init.
- `allowedRoot: null` → no root restriction on this machine. Continue, but tell the owner once: sapu will run in any checkout whose contract matches; to restrict it, write `~/.config/sapu/config.json` (the only location; `XDG_CONFIG_HOME` is ignored because `env` in a repo's settings can set it) holding `{"allowedRoots": ["<folder>"], "projectScopeOnly": true}` (the plugin README, section "Restricting where sapu may run").
- Install scope — init follows `check` exactly; the machine config decides:
  - `userScopeInstall: true` + `projectScopeOnly: true` → **stop**: ask the owner to run `claude plugin uninstall sapu@sapu --scope user`, then `claude plugin install sapu@sapu --scope project` in this repo.
  - `userScopeInstall: null` (scope cannot be determined) + `projectScopeOnly: true` → **stop**: ask the owner to check `claude plugin list` and install sapu with `--scope project` in this repo.
  - `userScopeInstall: true` without `projectScopeOnly` → continue with a **loud warning** at the top of the report: the plugin is installed at user scope, so its guard hook is now active for subagents in **every repo on this machine**, not only the repos that opted in. The fix: `claude plugin uninstall sapu@sapu --scope user`, then `claude plugin install sapu@sapu --scope project` in each repo that opts in.
  - `userScopeInstall: null` without `projectScopeOnly` → continue with a one-line note: the install scope cannot be determined.
- `origin: null` (no GitHub remote) → sapu and forge cannot run (PRs, issues, merges). Report it; dream still can.
- `hasContract: true` → update mode: read the existing contract and profiles, keep the owner's decisions in them, only complete what is missing or stale.

## 2. Scan the repo — evidence, not assumptions

One `ctx_batch_execute` (or one shell command) for all of it, output trimmed:
- Identity: `gh repo view --json nameWithOwner,defaultBranchRef`, `gh api user --jq .login`, `git config user.email`.
- Stack: dependency manifests (`package.json` + lockfile, `pyproject.toml`, `go.mod`, `Cargo.toml`, …), ORM/migrations (e.g. `prisma/`), `docker-compose*.yml` (services, DB ports), the env files present (`.env*`, **names only — never read their content**), CI config, `CLAUDE.md`/`AGENTS.md`.
- Gates: the existing lint/typecheck/test scripts, whether real tests run (the number of test files, one short capped run), gate scripts that already exist.
- GitHub: `gh label list --limit 200`, a security epic issue that may already exist (`gh issue list --state all --search "security in:title" --limit 20 --json number,author` — numbers and authors only; the owner confirms which one is the epic). Never add, remove, rename or create the acceptance label (`labels.accepted`): accepting an issue is the owner's own act.
- `git check-ignore -v .claude/sapu.json .claude/sapu/x.md` — the contract must be committable.

## 3. Prerequisites per skill

| Skill | Required |
|---|---|
| sapu, forge | a GitHub remote with the account the owner confirms for the contract; tier + lifecycle labels; a `gate.merge` that runs **real tests**, a `gate.fast` (may be static) + a diff-scoped test command in the `worker.md` profile §Test; a `gate.infra` probe when the tests need running infrastructure (DB, containers); CLAUDE.md |
| argus, momus | the above + the skill's profile + the config `.argus/config.yml` / `.momus/config.yml` |
| nemesis | the above + its profile + a `.nemesis/authorization.yml` **signed by the owner** (gitignored; holding `scope`, `forbidden`, `expires_on`, `environments_allowed`, an attestation) as the official record of targets — init may draft its template, but **never** fills `scope`/`forbidden` or attests itself (no file with an attestation ⇒ nemesis refuses to run) |
| inspector | the prerequisites of argus, momus and nemesis together |
| dream | none |

A repo without real tests: **never** write a fake `gate.merge` (e.g. lint only) so that sapu can run — autonomous merging without a test gate is forbidden. Report the missing prerequisites and stop for sapu/forge; the other skills whose prerequisites are met may still be set up.

## 3b. Policy — the owner decides how sapu behaves here (popup)

Every `policy` field (CONTRACT.md §Policy) is the owner's choice, asked with **AskUserQuestion**; nothing is hard-wired off, a default only pre-selects an option marked "(Recommended)". Evidence first, in the scan's batch:
- `gh api repos/<repo> --jq '{type: .owner.type, owner: .owner.login}'` — someone else's repo (an organization, or an owner that is not the gh account)?
- `gh api repos/<repo>/branches/<base>/protection --jq '.required_pull_request_reviews.required_approving_review_count // 0'` (403/404 = unknown) — do people have to approve?
- `CODEOWNERS` (`.github/`, root, `docs/`) — reviewer candidates; `.github/pull_request_template.md` — the PR shape the repo expects.
- `gh issue list --assignee <ghUser> --json number --limit 100` — does the owner work from assigned issues?
- The slash commands and skills listed in this session (the Skill tool's list) — candidates for a required pre-PR step.

Defaults: the owner's own repo → the behaviour before policies (`repo`, `sapu`, `trusted`, `visible`, file issues, every skill whose prerequisites hold, no pre-PR step, cleanup at the end of the sweep). Someone else's repo → `local`, `human`, `assigned`, `none`, no issue filing, `sapu` + `forge`. Evidence overrides a default (branch protection with approvals → `human`).

- **Popup 1** (4 questions): where the contract lives (`repo` committed / `local` = `~/.config/sapu/repos/<owner>__<name>/`, nothing in the repo) · who merges (`sapu` after a green gate / `human`: sapu hands the PR to reviewers) · which issues (all trusted / assigned to me / one label — Other = the label) · traces on GitHub (`visible` / `none`).
- **Popup 2**: may sapu file new issues · which skills may run (**multiSelect**: sapu, forge, argus, momus, nemesis, inspector, dream) · a required pre-PR command (none / each detected candidate, e.g. `/dev-review`; Other = any `/command args`) · when merge is `human`: reviewers to request (from CODEOWNERS/branch protection; Other = logins).
- **Popup 3**: cleanup of sapu's merged branches and worktrees (at the end of the sweep (Recommended) / also after every session / never) · with a pre-PR command only: which severities must reach **0** before the PR is handed in (**multiSelect** critical, medium, low) · where its output goes (PR body / PR comment). There is no round limit to ask about: the loop runs until zero and stops only on a contradiction.

Write exactly the answers into `policy` (omit a field only when the answer equals its default). Show the resulting block in the step 5 summary.

## 4. Draft

- **`.claude/sapu.json`**: every CONTRACT.md field filled with a decision, none left at a default. What the scan cannot settle (e.g. `securityEpic`, `invariantDomains`, the protected targets) → ask the owner, one question per decision, with a proposal already grounded in evidence. `guard.postgres`/`envFiles`/`deny` = every target that, if a worker touched it, would damage data or other sessions. `gate.merge` runs in the PR's worktree, so its logic must live in a file the merge pins to the base branch (CONTRACT.md "Which file is run"): when `show --working-tree` warns `gate.merge … pins no repo file` (`npm test`, `go test ./...`, `uv run pytest`), propose a gate script run by path or by an interpreter, or a make/just target, that runs the same steps; an owner who keeps the unpinned form is told what it means in the report.
- **`specialists`** — the only optional field (CONTRACT.md §Specialist agents). Fill a role only when the repo or the owner already has a stronger agent for that role **and** init can confirm that agent exists right now: its subagent type is listed among the agents the `Agent` tool offers in this session (project agents in this repo's `.claude/agents/`, or user-level agents on this machine). A user-level agent exists only on this machine: propose it to the owner first, and say that every machine that runs sapu for this repo then needs that agent. Nothing confirmed → never write the field (every role uses its senior-dev-team default, installed with sapu). `redAreaSpecialists[].agent` is written as a role (`architect`, `db`, `developer`, `ux`).
- **Profiles `.claude/sapu/<skill>.md`** for every skill whose prerequisites are met: `node "${CLAUDE_PLUGIN_ROOT}/scripts/sapu-contract.mjs" profiles --list` prints the sections (`## …`) each skill's engine reads. Write every section from the scan and CLAUDE.md (reference CLAUDE.md, never copy it). A section that genuinely does not apply in this repo: write one line saying why, never delete it.
- **Aliases** so that the owner only types `/<name>`, not `/sapu:<name>`: for each skill the repo enables (except `init` — `/init` belongs to Claude Code), write `.claude/skills/<name>/SKILL.md` = an exact copy of `${CLAUDE_PLUGIN_ROOT}/skills/init/alias-template.md` with `<name>` replaced (a separate file: the argument placeholder in it would be substituted if it were written in this SKILL.md). Project level only, **never** `~/.claude/skills` (that reaches every repo on this machine); a name already used by another skill in this repo is skipped and reported.
- A contract that is ignored → propose `.gitignore` exceptions (`!/.claude/sapu/`, `!/.claude/sapu.json`) as part of the draft.
- **`local` home**: write `sapu.json` and the profiles into `~/.config/sapu/repos/<owner>__<name>/` (created by init, never by a worker) instead of `.claude/`; nothing is committed, no PR. Aliases go to `.claude/skills/` only when that path is ignored; otherwise add it to `<MAIN>/.git/info/exclude` (local, never committed) first. Never edit the repo's `.gitignore` for a local home.
- Labels that do not exist yet → propose `gh label create` for each contract label; create them only after the owner agrees.
- **Session settings (this machine)** → `.claude/settings.local.json` in the main checkout, merged into what is there (keep every existing key). Never `.claude/settings.json`: committed, it would change `cd` for every person's sessions in the repo, and a `local` home or `policy.traces: "none"` leaves no file in the repo. First `git check-ignore -q .claude/settings.local.json`; not ignored → add `/.claude/settings.local.json` to `<MAIN>/.git/info/exclude` (local, never committed).
  - `env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: "1"`: the main session returns to the project directory after every Bash/PowerShell command, so a `cd` into a worktree never leaves the agents it spawns next there (their memory and settings come from the cwd).
  - `worktree.symlinkDirectories` gains `.claude/agent-memory` and `.claude/agent-memory-local`, so an agent in a new worktree reads `<MAIN>`'s memory — each only when `git ls-files <dir>` is empty (a tracked memory dir must stay a directory: a commit would replace it with the link) and `git check-ignore -q <dir>` passes as written, without a trailing slash (a pattern ending in `/` does not ignore a link: it would show as untracked, `sapu-cleanup.mjs` would keep the worktree and a worker's `git add -A` would commit it). Not ignored → add `/<dir>` (no trailing slash) to `<MAIN>/.git/info/exclude` first; tracked → leave it out and say so. Copy in the entries `.claude/settings.json` already lists there, so a local array that replaces the shared one loses nothing.
  - Both take effect from the next session. Whether a Workflow's `isolation: 'worktree'` worktrees honour `symlinkDirectories` is not yet probed; the guard keeps memory written inside a worktree in `<MAIN>` either way.

## 5. Owner confirmation, then verification

Show a summary: identity (repo, gh account, git email), `gate.fast`, `gate.merge`, `gate.infra`, the protected targets, the security epic, the session settings for `.claude/settings.local.json` (and any line for `.git/info/exclude`), the status of `.nemesis/authorization.yml` (present/signed/expired — init does not confirm its content), and the prerequisites not yet met. Ask the owner to confirm the **account** explicitly. **init does not fill nemesis targets:** the owner personally fills `scope`/`forbidden` and signs `.nemesis/authorization.yml` — that file is the record, not the profile. At most, init offers an empty template; without that file with an attestation, nemesis refuses to run.

A `local` home: `sapu-contract.mjs show`, `profiles` and `home` (must print `local`) read it directly and must be green now; there is no PR. A `repo` home: from the init branch's checkout, `sapu-contract.mjs show --working-tree` (schema) and `sapu-contract.mjs profiles --working-tree` (profile sections) must be green — without `--working-tree` both read the main checkout's HEAD, which does not hold the contract yet. `sapu-contract.mjs check` (scope lock) and the other skills read the contract **committed** at the main checkout's HEAD, so they only go green after the init PR is merged; until then, `preflight` is the key evidence. Write the files on a new branch and open a PR (not a commit to the base branch), or hand the diff to the owner if they choose to review it themselves. The final report: the files written, decisions + their sources, the prerequisites still missing per skill.

## Prohibitions

- Never runs outside the roots the machine config allows, and never installs the plugin at user scope.
- Never writes, creates, or loosens the machine config (`~/.config/sapu/config.json`); it belongs to the owner, not to the repo.
- Never reads the content of env files, secrets, or credentials; the file name is enough.
- Never invents gates, targets, or accounts to "complete" the contract.
