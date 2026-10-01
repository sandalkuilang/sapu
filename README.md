<p align="center">
  <img src="docs/img/logo.svg" alt="sapu" width="120">
</p>

<h1 align="center">sapu</h1>

<p align="center">
  <strong>Sweep your GitHub backlog clean.</strong><br>
  A Claude Code plugin that turns open PRs and issues into tested, reviewed, merged work, driven by a per-repo contract.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-14b8a6.svg" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/Claude%20Code-plugin-4f46e5.svg" alt="Claude Code plugin">
  <img src="https://img.shields.io/badge/node-%E2%89%A5%2022.18-339933.svg" alt="Node 22.18 or newer">
  <a href="https://github.com/sandalkuilang/sapu/stargazers"><img src="https://img.shields.io/github/stars/sandalkuilang/sapu?style=flat&color=fde68a" alt="GitHub stars"></a>
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#the-skills">Skills</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="docs/usage.md">Docs</a>
</p>

<p align="center">
  <img src="docs/img/overview.svg" alt="How the sapu engine, the per-repo contract and the optional machine config fit together, and which skill calls which" width="100%">
</p>

## What you get

- 🧹 **One command, clean backlog.** `/sapu` drains every open PR, then works every issue in parallel waves.
- 🔍 **Independent review.** Every PR is reviewed by an agent that is not its author, chosen by risk tier.
- 🚦 **Merge only on green.** Workers never merge; one merge script does, after the gate passes.
- 📜 **Zero repo knowledge in the plugin.** Each repo brings its own contract: account, gate commands, protected data.
- 🛡️ **Safe by default.** Guard hook for subagents, scope lock per machine, trusted-author checks for public repos.

## Quick start

```bash
claude plugin marketplace add sandalkuilang/sapu
```

```bash
claude plugin install sapu@sapu --scope project
```

Start a **new session** in that repo, then:

```
/sapu:init     # scans the repo, writes a draft contract; review it and merge it through a PR
/sapu          # sweep the backlog
```

Needs a GitHub remote, real tests to use as the merge gate, and a `CLAUDE.md`. Full steps: [Install and use](docs/usage.md).

## The skills

| Skill | Job |
|---|---|
| 🧹 `/sapu:sapu` | Orchestrator: drains every open PR, then works every issue in parallel waves until the backlog is clean. |
| 🔨 `/sapu:forge` | One issue → one tested PR. |
| 👁️ `/sapu:argus` | Autonomous QA against the local dev app. |
| ⚖️ `/sapu:momus` | Release-readiness audit. |
| 🗡️ `/sapu:nemesis` | Red team against the local dev app (explicitly authorized targets only). |
| 🔎 `/sapu:inspector` | Runs momus → argus → nemesis in sequence, each on its own model and effort, with one combined summary. |
| 🔮 `/sapu:dream` | Forward-looking research: current engineering practice and rising repos, then falsifiable hypotheses and near-term experiments for this project; read-only. |
| ⚙️ `/sapu:init` | Sets up the repo contract so that the skills above can run. |

Short aliases (`/sapu`, `/forge`, …) are created by `/sapu:init`.

## How it works

The plugin is an **engine**: skills, agents, a guard hook and a merge script. It keeps no knowledge of any particular repo. Every repo fact lives in that repo's **contract** (`.claude/sapu.json` + `.claude/sapu/*.md`), in the format of [`plugins/sapu/CONTRACT.md`](plugins/sapu/CONTRACT.md).

<img src="docs/img/sapu.svg" alt="The sapu orchestrator: Phase A drains PRs, Phase B runs waves of forge workers with tiered review, and only the orchestrator merges through the merge gate" width="100%">

A picture tour of every skill: [How the agents work](docs/agents.md).

## Docs

| | |
|---|---|
| [Install and use](docs/usage.md) | Setup, day-to-day commands, updating, common problems |
| [Safety and trust](docs/security.md) | Where sapu may run, machine config, public repositories |
| [How the agents work](docs/agents.md) | One diagram per skill |
| [Contributing](docs/contributing.md) | Repo layout, the gate, rule guard, versioning |
| [Contract format](plugins/sapu/CONTRACT.md) | What a repo's contract holds |

## License

MIT. See [LICENSE](LICENSE).
