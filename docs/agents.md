# How the agents work

<sub><a href="../README.md">README</a> · <a href="usage.md">Install and use</a> · <b>How the agents work</b> · <a href="security.md">Safety and trust</a> · <a href="contributing.md">Contributing</a></sub>

<sub>A picture tour of each skill. What to type is in the <a href="usage.md#day-to-day">usage table</a>.</sub>

The plugin is the **engine** — skills, the worker agents, a guard hook and a merge script — and it knows nothing about any one repo. Its specialists (reviewers and advisers) come from the [senior-dev-team](../plugins/senior-dev-team/README.md) plugin, installed with sapu. Each repo brings a **contract** (`.claude/sapu.json` + `.claude/sapu/*.md` profiles, written by `/sapu:init`; committed, or kept local outside the repo); an optional per-machine config decides where sapu may run.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="img/overview-dark.svg">
  <img src="img/overview.svg" alt="How the sapu engine, the per-repo contract, the optional machine config and the senior-dev-team specialists fit together, and which skill calls which" width="100%">
</picture>

### /sapu — sweep the backlog

Locks its scope first (Step 0) and holds the repo's sweep marker, so a second /sapu session on the same repo stops there; drains open PRs (Phase A), then works open issues in parallel lanes (Phase B): each issue is one Workflow call running a **forge** worker in its own worktree, up to as many lanes as the machine carries, and a new lane starts as soon as one returns. Every PR is reviewed by the `qa` specialist (`senior-dev-team:senior-qa-reviewer` unless the repo maps its own) at Opus/high, or by an adversarial Opus pair on 🔴 and on any diff that touches a red area. 🟢/🟡 findings get at most two fix cycles; 🔴 may go on up to five, but past the second only while it converges (each review reports fewer findings than the one before, and no finding is reported by three reviews in a row), else it is blocked with the reason; a worker past its step budget hands off to a fresh one of the same tier. Workers never merge: the orchestrator queues ready PRs through `sapu-merge.sh` (gate, flake ledger, merge, `mergeAfter`), one at a time. Each session ends by rewriting the `sapu-sweep-state` memory page (and cleans up merged branches when the repo's policy says `session`); the last one runs the cleanup the policy asks for, the final gate, and the report. A defect of the engine itself is never patched around in the repo: the orchestrator files it on the plugin's own repository, and the report lists it.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="img/sapu-dark.svg">
  <img src="img/sapu.svg" alt="The sapu orchestrator: Step 0 scope lock and one sweep per repo, Phase A drains PRs, Phase B runs one Workflow lane per issue with a worker, qa review or the red pair and fix cycles (two; up to five on red while they converge) and a handoff past the step budget, a merge queue through sapu-merge.sh, then the end-of-session state page, and the finish with a final gate, cleanup per policy and the report, engine defects filed on the plugin's repo" width="100%">
</picture>

### The specialists — senior-dev-team

Reviewers and advisers are called by role. By default each role is an agent of the [senior-dev-team](../plugins/senior-dev-team/README.md) plugin, installed with sapu; a repo can map any role to its own agent ([Specialist agents](usage.md#specialist-agents)).

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="img/senior-dev-team-dark.svg">
  <img src="img/senior-dev-team.svg" alt="The eight senior-dev-team agents and how sapu dispatches them by role: qa reviews every PR, a qa plus domain-specialist Opus pair reviews the red tier, and a scoped /inspector run adds a read-only team review" width="100%">
</picture>

### /inspector — full sweep before release

Runs momus, then argus, then nemesis — one phase finished before the next starts, each on its own model and effort. momus's business-process gap rows become priority targets for the other two; a scoped run adds a read-only team review. One combined summary and a security roll-up at the end. Its argus phase never runs the journey lane, which runs only from the main session.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="img/inspector-dark.svg">
  <img src="img/inspector.svg" alt="inspector sequences momus then argus then nemesis, each on its own model and effort, ending with one combined summary and a security roll-up" width="100%">
</picture>

### /dream — where is this heading

Read-only research: researches 2–3 of nine technology domains per run (stalest first, or weighted to a focus with ~20% outside it), then forms 8–12 falsifiable hypotheses each with a cited reasoning chain and a kill condition, then grounds two or three into one-month experiments for this project. It modifies no code and opens no issues; its only write is the report.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="img/dream-dark.svg">
  <img src="img/dream.svg" alt="dream: deep research, then falsifiable hypotheses with kill conditions, then grounding into one-month experiments; read-only, one local report" width="100%">
</picture>

### /argus — autonomous QA

One bounded cycle of eleven phases (ORIENT → ROTATE), applying five review lenses and six bypass classes. Every claim is graded by evidence tier and falsified before it becomes a de-duplicated GitHub issue. Tests, never fixes; the dev app and seeded accounts only.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="img/argus-dark.svg">
  <img src="img/argus.svg" alt="argus runs one eleven-phase QA cycle with five lenses and evidence tiers, filing de-duplicated issues; it tests but never fixes" width="100%">
</picture>

### /journey — the user's side of the workflows

argus's journey lane, with its own door. One bounded cycle walks the app's business journeys through the real UI, as every role each one needs, on an isolated instance argus starts itself (its own worktree, ports, data and HOME), never on your servers. The journey catalog is generated from the code, every step anchored in a line at HEAD, and rebuilt by a map-mode explorer when it is stale (files added, deleted or renamed under its roots, a newer momus report, a journey that no longer anchors); SELECT picks the top journeys and allocates their accounts; one `sapu:ui-explorer` agent per journey walks it through the lane's browser wrapper and only suspects. A script then replays every candidate on a fresh instance, and only one that reproduces two of two is minimized, turned into a Playwright RED test, classified, checked by `scrub` for any secret the run saw, and filed. `down` stops what `up` started; PERSIST records each journey's visit and the next picks. A journey that is not in the smoke suite yet is charted with `path: wanted`: when its explorer reaches the goal, it also returns the steps as a *path* for `smoke admit` (next section). `/journey seed --issue <n>` and `/journey seed --doc <file>:<a>-<b>` point a map-mode explorer at a trusted issue or at a doc range tracked at HEAD, read as data, and add the journeys it names that the code anchors to the catalog; `report` writes the cycle's record to `.argus/reports/`.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="img/journey-dark.svg">
  <img src="img/journey.svg" alt="One journey cycle: argus's journey lane checks the catalog, brings up an isolated instance of its own, picks the top journeys, walks each with a ui-explorer agent through the browser wrapper only, reproduces every candidate two of two on a fresh instance, minimizes it into a RED test, classifies it, files it only after scrub finds no secret the run saw, tears the instance down and records the visit; an explorer that reached the goal of a journey charted for the smoke suite also returns a path, which two runs admit before it is proposed as a pull request." width="100%">
</picture>

### /journey smoke — the regression net

The same lane, in `smoke` mode, turns the journeys it has walked into a generated Playwright suite that your CI runs with no LLM. One cycle plans which journeys the suite should hold, captures a path from an explorer and admits it only after two runs (fresh, then used), re-runs the suite's paths and measures performance on the lane's own Chrome, reads CI's last run, and decides what each break is: a flake is quarantined, never hidden; a moved control is healed (a heal changes only how an action finds its control, and a script re-runs the unchanged expectations to decide); a lost control or a failed expectation is a regression candidate that goes through the usual two-of-two replay. A heal proposal you close becomes a pending regression: the journey is quarantined and a needs-owner issue filed until a fix holds it or you rule the change intended (`smoke retire`). Every change to the suite, screenshot baselines included, is proposed as a pull request on an `argus/` branch that you merge or close. CI's baseline run, on the pinned Playwright container, is the only thing that writes a baseline. The commands, checks and rules are in [Install and use](usage.md#the-smoke-suite), and the trust boundaries in [Safety and trust](security.md#the-smoke-suite).

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="img/smoke-dark.svg">
  <img src="img/smoke.svg" alt="The smoke cycle: the journey lane captures a path from an explorer, admits it after two runs, and proposes it as a generated suite in a pull request that the owner reviews and merges; CI runs the suite per browser project on every pull request and uploads its results; the lane reads those results, decides whether a break is a flake, a UI change or a bug, and proposes a quarantine, a heal or a baseline, or files a regression, again as a pull request." width="100%">
</picture>

### /momus — release-readiness audit

One pass across nine areas (A–I), each read with a security lens for outsiders and insiders and graded by a four-level severity ladder. The deliverable is a written report; it files issues only when asked and never writes a ship/no-ship verdict.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="img/momus-dark.svg">
  <img src="img/momus.svg" alt="momus audits nine areas A to I with a security lens and a four-level severity ladder; the deliverable is a written report" width="100%">
</picture>

### /nemesis — authorized red-team

Attacks the local dev app only. A hard gate — signed, unexpired authorization; allowlisted targets resolving to loopback (or an owner-attested private dev address); dev environments only; no STOP file — must pass before any active testing, and a kill switch halts the run mid-cycle. Then passes 0–7 from residue intake and recon through business logic to detection-integrity, plus six bypass classes every cycle. Files security issues; non-destructive, seeded low-privilege accounts only.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="img/nemesis-dark.svg">
  <img src="img/nemesis.svg" alt="nemesis: a hard gate, then passes 0 to 7 from residue intake and recon to detection-integrity with six bypass classes, filing security issues against the dev app only" width="100%">
</picture>

