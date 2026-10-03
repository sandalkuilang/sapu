---
name: inspector
description: Use when running a full release-readiness sweep of the current repo by chaining momus, argus, and nemesis in one sequence — momus first for a safe read-only baseline, argus second to hunt bugs against that baseline, nemesis last for live exploitation so its aggressive probing isn't confused with anything the first two should already have caught. Every phase is held to the repo's security bar (OWASP ASVS 5.0, NIST SP 800-63B-4, CIS, the data-protection law — as each phase's profile sets it; known gaps from the contract's securityEpic), outsider and insider alike. Each phase automatically runs on its own model and reasoning effort. Needs the repo contract and the momus, argus and nemesis profiles (/sapu:init writes them). Triggers: "run inspector", "run a full audit", "audit everything before release", "run momus argus nemesis", "full release sweep", "full security audit".
---

# INSPECTOR — Sequencer for MOMUS → ARGUS → NEMESIS

Not a fourth methodology. INSPECTOR has no evidence rules, no severity ladder, and no findings of its own — it dispatches the other three, in a fixed order, one fully finished before the next starts, each on its own model/effort, and hands back one combined summary at the end.

This skill is the engine and knows no repo. It carries no profile of its own: every repo fact reaches the phases through their own profiles (`<profiles>/momus.md`, `argus.md`, `nemesis.md`), and the repo and security epic come from the contract (`.claude/sapu.json`, `${CLAUDE_PLUGIN_ROOT}/CONTRACT.md`).

## Step 0 — before dispatching anything

From the main checkout:

1. `node "${CLAUDE_PLUGIN_ROOT}/scripts/sapu-contract.mjs" check` — the scope lock plus the contract schema. Non-zero → stop, report its message, dispatch nothing. Never `gh auth switch`: a wrong account is a stop, not something to fix yourself.
2. `node "${CLAUDE_PLUGIN_ROOT}/scripts/sapu-contract.mjs" wave-args` → `{"main","pluginRoot","contract"}` (`contract.specialists` = the resolved specialist map the team review dispatches).
3. The three phase profiles exist: `<profiles>/momus.md`, `argus.md`, `nemesis.md` (`<profiles>` = `dir` of `node "${CLAUDE_PLUGIN_ROOT}/scripts/sapu-contract.mjs" home`; in the repo they must be committed). One missing → stop and tell the user to run `/sapu:init`. Each phase would stop on it anyway; this stops before three agents pay their start-up cost for nothing.

## How this is invoked — automatic, not manual sequencing

**Whenever this skill is invoked, after Step 0, call the Workflow tool:**

```js
Workflow({ name: "sapu:inspector", args: { ...<output wave-args>, scope: "<the user's arguments, if any>" } })
```

Do not manually run momus, then argus, then nemesis one at a time in the current session — the whole point of this skill is that the model/effort decision below happens automatically, every time, without being re-derived or re-asked. This IS the skill's own explicit instruction to call Workflow, which is itself the legitimate opt-in Workflow's own gating rules require ("the user invoked a skill... whose instructions tell you to call Workflow") — no separate "use a workflow" phrasing needs to be re-obtained from the user each time this skill runs.

The user's arguments, if any, are a free-text scope (any area — `"authentication & sessions"`, `"HR"`, `"payments"`): pass them verbatim as `scope` to narrow all three phases to it; a scoped run also ends with a read-only team review (product, UI/UX, tests). No arguments → omit `scope`. The script refuses unknown or malformed args (a bare scope string included) — fix the call, never drop a key to make it pass.

## Model and effort per phase — decided once, applied every run

| Phase | Model | Effort | Why |
|---|---|---|---|
| **momus** | Opus (`opus`, the newest) | high | Dense cross-referencing against the repo's genuinely subtle "is this a bug or a recorded decision" distinctions. Breadth-first, not deep chained logic — high is enough, doesn't need max. |
| **argus** | Sonnet (`sonnet`, the newest) | high | Continuous, many-cycle bug-hunting. The triage/severity call deserves good reasoning without needing the top tier. |
| **nemesis** | Opus (`opus`, the newest) | high | Highest-stakes phase — live exploitation plus multi-step business-logic chaining, where a wrong call is either a missed real vulnerability or a false alarm. Raise to `max` in `MODELS` of `workflows/inspector.js` if runs need to go deeper on Pass 5 chaining. |
| **team** (scoped runs only) | Opus (`opus`, the newest) | high | Read-only product / UI-UX / tests review of the scoped area by the `product`, `ux` and `qa` specialists (the contract's `specialists` map, resolved by `wave-args`; built-in `sapu:sapu-<role>`) after the three phases. |

Changing any of these is a one-line edit to `MODELS` in the plugin's `${CLAUDE_PLUGIN_ROOT}/workflows/inspector.js` (a plugin change, through the plugin's own PR gate; its `tests/inspector.test.ts` pins this table against the script) — don't re-litigate the choice inline each time the skill runs; edit the script once if the decision changes.

## Why sequential, never parallel

All three can touch the same running dev app and the same database. Running them at the same time risks the classic shared-database failure: two test suites running concurrently drop and reprovision each other's worker databases, and the few real failures drown in bogus ones. Same risk here — nemesis's live exploitation, argus's live probing, and momus's read/write commands (migration status, the test suite) can all step on the same dev database if they run at once. The workflow script enforces this itself (each `agent()` call is `await`ed before the next begins) — never restructure it to run them concurrently.

## The order, and why it's this order

1. **momus (`/sapu:momus`) first.** Safest phase — mostly reading code and running non-destructive commands. Establishes a clean baseline: is config sane, are migrations fine, nothing structurally broken. Its Area B business-process map — every state-changing endpoint in every domain — goes to argus and nemesis as priority targets: breadth from source first, then live proof straight at the API.
2. **argus (`/sapu:argus`) second.** Hunts for bugs on top of a now-known-good baseline.
3. **nemesis (`/sapu:nemesis`) last.** The most aggressive phase — it actually tries to break in. Going last means any mess it makes isn't confused with a pre-existing bug the first two phases should already have surfaced.

## Security bar — every phase, every run

The bar all three phases audit against is the repo's own, read from each phase's profile (momus `## Security bar`, argus `## Written rules`, nemesis `## Security bar`): OWASP ASVS 5.0 at the levels the repo sets, NIST SP 800-63B-4, CIS Benchmarks, and the data-protection law it names — against outsiders and insiders alike. The workflow appends one `SECURITY_BAR` block to every phase prompt, and each skill carries the same bar, so a standalone momus/argus/nemesis run holds it too. The open children of the contract's `securityEpic` (`null` → the open issues labelled `security`) are known gaps: a phase re-confirms them, never refiles them.

## At the end

The workflow returns `{ momus, argus, nemesis, team, failed, notRun }`. One combined summary, not three separate walls of text: momus's severity counts plus its full report, then argus's filed issue numbers plus counts, then nemesis's filed issue numbers plus counts, then (scoped runs) the team's three reviews. Inside inspector momus files nothing (the workflow does not opt it into filing), so its §5 dedup never runs here; argus and nemesis dedup against their own state (`.argus/fingerprints.json`, `.nemesis/state/findings.json`, gitignored — main checkout only). If the same mechanism was flagged by more than one phase, cross-check that it was filed once, and say so once instead of listing it three times.

Then a **security roll-up**: new security findings grouped by attacker (outsider / insider) with their ASVS 5.0 IDs (`issues_filed[].attacker` / `.asvs`), plus the known-gap issues each phase re-observed as still open (`known_gaps_reconfirmed`). A security finding that arrived without an attacker or an ASVS ID is named as such in the roll-up, never passed through silently.

## Rails

- No new state directory of its own. Each phase's own state (`.momus/`, `.argus/`, `.nemesis/`) already persists what matters — INSPECTOR carries no config and files no issues of its own.
- Each phase's own gates still apply in full inside its dispatched agent — momus's evidence rules, argus's ORIENT checks, nemesis's authorization gate are never skipped just because the phase is running inside a workflow. A phase one of its gates stopped comes back `status: "blocked"` with `blocked_reason`: the sequence continues (the next phase is told when momus established no baseline), and the summary names the block — a blocked phase is never reported as clean.
- If a phase's agent call returns null (killed, or the subagent died on a terminal error), the workflow stops there: `failed` names exactly which phase failed and `notRun` what never started. Report exactly that and stop — don't silently treat a null as "clean" in the combined summary, and don't re-run the later phases by hand.
