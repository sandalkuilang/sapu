# How the agents work

<sub>A picture tour of each skill. What to type is in the <a href="usage.md#day-to-day">usage table</a>.</sub>

The plugin is the **engine** — skills, agents, a guard hook and a merge script — and it knows nothing about any one repo. Each repo brings a committed **contract** (`.claude/sapu.json` + `.claude/sapu/*.md` profiles, written by `/sapu:init`); an optional per-machine config decides where sapu may run.

<img src="img/overview.svg" alt="How the sapu engine, the per-repo contract and the optional machine config fit together, and which skill calls which" width="100%">

### /sapu — sweep the backlog

Drains open PRs first (Phase A), then works open issues in parallel waves (Phase B). Each wave runs a **forge** worker per issue in its own worktree; every PR gets independent review chosen by risk tier (🟢/🟡/🔴; a pair for 🔴), with up to two fix cycles. Workers never merge — only the orchestrator does, through the merge gate.

<img src="img/sapu.svg" alt="The sapu orchestrator: Phase A drains PRs, Phase B runs waves of forge workers with tiered review, and only the orchestrator merges through the merge gate" width="100%">

### /inspector — full sweep before release

Runs momus, then argus, then nemesis — one phase finished before the next starts, each on its own model and effort. momus's business-process gap rows become priority targets for the other two; a scoped run adds a read-only team review. One combined summary and a security roll-up at the end.

<img src="img/inspector.svg" alt="inspector sequences momus then argus then nemesis, each on its own model and effort, ending with one combined summary and a security roll-up" width="100%">

### /dream — where is this heading

Read-only research: researches 2–3 of nine technology domains per run (stalest first, or weighted to a focus with ~20% outside it), then forms 8–12 falsifiable hypotheses each with a cited reasoning chain and a kill condition, then grounds two or three into one-month experiments for this project. It modifies no code and opens no issues; its only write is the report.

<img src="img/dream.svg" alt="dream: deep research, then falsifiable hypotheses with kill conditions, then grounding into one-month experiments; read-only, one local report" width="100%">

### /argus — autonomous QA

One bounded cycle of eleven phases (ORIENT → ROTATE), applying five review lenses and six bypass classes. Every claim is graded by evidence tier and falsified before it becomes a de-duplicated GitHub issue. Tests, never fixes; the dev app and seeded accounts only.

<img src="img/argus.svg" alt="argus runs one eleven-phase QA cycle with five lenses and evidence tiers, filing de-duplicated issues; it tests but never fixes" width="100%">

### /momus — release-readiness audit

One pass across nine areas (A–I), each read with a security lens for outsiders and insiders and graded by a four-level severity ladder. The deliverable is a written report; it files issues only when asked and never writes a ship/no-ship verdict.

<img src="img/momus.svg" alt="momus audits nine areas A to I with a security lens and a four-level severity ladder; the deliverable is a written report" width="100%">

### /nemesis — authorized red-team

Attacks the local dev app only. A hard gate — signed, unexpired authorization; allowlisted targets resolving to loopback (or an owner-attested private dev address); dev environments only; no STOP file — must pass before any active testing, and a kill switch halts the run mid-cycle. Then passes 0–7 from residue intake and recon through business logic to detection-integrity, plus six bypass classes every cycle. Files security issues; non-destructive, seeded low-privilege accounts only.

<img src="img/nemesis.svg" alt="nemesis: a hard gate, then passes 0 to 7 from residue intake and recon to detection-integrity with six bypass classes, filing security issues against the dev app only" width="100%">

