# Forge reference — priority, commands, labels, templates

Lookup material for the forge skill (SKILL.md in this skill's directory). Repo facts come from the contract `.claude/sapu.json` and the repo profile `.claude/sapu/forge.md` (cited as *profile §…*); the placeholders `<repo>`, `<base>`, `<inProgress>`, `<done>`, `<queued>`, `<blocked>`, `<tier label>` are defined in SKILL.md §Scope lock.

## Issue priority ladder

Only consider issues that are open, not `needs-clarification`/`<blocked>`, not already owned by an open PR, and passing `sapu-contract.mjs issue-trust <n>` (a trusted author, or the contract's acceptance label applied by a trusted login). `needs-ai` (and any legacy spelling of it in profile §Labels) does **not** exclude an issue — it means the work starts with a research dossier instead of with code.

1. **p0** — production broken, security, data loss, `<base>` build red.
2. **p1** — high-value bug or committed feature.
3. **p2** — normal features, smaller bugs.
4. **p3** — tech debt, docs, tests, chores.

(Priority label names: profile §Labels.) Tie-breakers in order: smaller/clearer scope first (ship momentum) → unblocks other work → oldest. **Prefer the issue you can finish completely and safely over the flashy one you can only half-finish** — one merged PR beats three abandoned branches. If an issue is bigger than one coherent PR, ship the first self-contained slice and file follow-ups for the rest.

**Rolling / multi-item issues (e.g. a NEMESIS hardening backlog):** fix one item per PR and use `Refs #N`, never a closing keyword — the PR must NOT close the issue while items remain. ⚠️ GitHub's linked-issue parser matches the bare token `close/closes/closed/fix/fixes/fixed/resolve/resolves/resolved #N` **even when negated** — writing "does not close #N" in a PR body/commit auto-closes #N on merge (the incident: profile §Incidents). So don't put the string `close #N` (or any of those verbs + `#N`) in the body at all for a rolling issue; write "Refs #N — this slice does not complete the issue" with the verb kept away from the `#N`.

## Implementation standards

- Conventions over preferences — the repo's existing patterns win, always.
- Types are non-negotiable — no `any` escape hatches, no silencing the type checker.
- Errors handled with grace — no swallowed exceptions, no empty catches.
- No secrets in code, ever — env only, never logged.
- Migrations are additive and reversible by default; a destructive/data-mutating migration is automatically 🔴.
- Tests are part of "done" — new behavior ships with tests, bug fixes ship with a regression test that fails before the fix.
- **"Test bypass" rule** (origin: profile §Bypass classes): a service test proves a business rule is *correct*; it does not prove the HTTP *route* actually wires that rule to the session — a controller reading `reviewerId` from the body, skipping the service, or gating the wrong permission all pass a service-only suite. Every data-mutating route (POST/PUT/PATCH/DELETE) enforcing a business rule needs **at least one route test** (over HTTP with a real logged-in session — the repo's harness is in profile §Bypass classes) proving, so far as relevant: actor identity from session not body (extra `userId`/`reviewerId`/other identity fields in the body → 400, strict DTO), self-approve rejected over HTTP, wrong role → 403, and the route's core rule rejected over HTTP. **An acceptance criterion phrased as "UI hides/disables X" is not satisfied without its pair "API rejects X (route test)"** — pattern example in profile §Bypass classes. A PR that only adds/updates a service test for a mutating route is incomplete until the direct-HTTP counterpart exists.
- **Six recurring bypass classes** (origin and incident list: profile §Bypass classes) — the test-bypass rule only proves ONE malformed request is rejected; many real gaps pass that exact test, because the attack is sequencing, concurrency, timing or identity, not a single bad shape. For any cumulative/threshold/cross-row-uniqueness rule you write or touch: (A) **window direction** — a date-based cap must be evaluated both directions, not just "counting backward from today"; (B) **TOCTOU** — the threshold read must be inside the writer's transaction under a lock (row lock, per-subject advisory lock, or a DB constraint), never a bare count/aggregate/lookup outside the transaction (the repo's ORM spelling: profile §Bypass classes); (C) **no re-check at execution** — validated at submission is not validated at approval/activation/apply/issue; re-run the check at every step that acts on it; (D) **splitting / side-channel** — a threshold or 4-eyes gate must be enforced identically across EVERY endpoint that produces the same effect, not just the one route the reviewer had in mind; (E) **UI-only rule** — the web app disables/hides it, the API doesn't (profile §Bypass classes names the static check that exists to catch this); (F) **actor = subject / value from body** — an actor mutating their own record, or an identity/amount/tax-id field trusted from the request body instead of re-derived server-side. For a rule matching A–D, the mandatory route-test set from the bullet above grows by four **beyond** the single-violating-request test already required: **concurrent requests (e.g. `Promise.all`)**, **reverse-chronological submission order**, **facts changing between submit and approve**, and **actor = subject (rejected unless the exempt role named in profile §Bypass classes)**.
- **Security bar (profile §Security bar; epic = contract `securityEpic`)** — applies to every issue, whatever its domain:
  - Name the **outsider** attack (internet attacker, phishing, stolen session, bot) and the **insider** attack (legitimately logged-in staff incl. high roles, whoever holds server/DB access, colluding staff) that the change opens, closes, or leaves untouched.
  - Cite the requirement IDs of the repo's security standard (profile §Security bar) it touches.
  - Take security decisions by the standards listed there without asking the repo owner, and record decision + source in the PR's Security section.
  - Never weaken an existing control to make a feature work.
- Watch for N+1 queries, unbounded loops, injection, missing authz, unvalidated input — even when the issue didn't ask. Spotted one out of scope? Don't silently expand the PR: a security gap → issue under the contract's `securityEpic` (null → a standalone issue labelled `security`); anything else → file an issue (standalone) or note it in the PR (under sapu, which files nothing but security gaps).
- Dependency patch/minor bumps needed for the fix are fine; a major bump is 🔴.

## Git & PR workflow

- Worktree + branch per issue off `origin/<base>`; never commit directly to `<base>`, never `checkout`/`pull`/`stash` in the main checkout. Never force-push a shared/protected branch or rewrite published history.
- Conventional commits, atomic and self-describing.
- Squash-merge to keep `<base>` linear; delete the branch after.
- One issue → one branch → one PR. Small PRs, small blast radius — even with no human reading them.

```bash
gh issue list --repo <repo> --state open --label "<queued>" --json number,author   # no titles: they come from the verdict
node "${CLAUDE_PLUGIN_ROOT}/scripts/sapu-contract.mjs" issue-trust <n> --text --comments > "$TMPDIR/issue-<n>.json"   # exit 1 = never start it (SKILL.md step 2)
jq -r '.title, .body' "$TMPDIR/issue-<n>.json"; jq '.comments[-2:]' "$TMPDIR/issue-<n>.json"   # the text the verdict judged; full history only if needed
gh issue edit <n> --repo <repo> --add-label "<inProgress>" --remove-label "<queued>"
git fetch origin <base> && git worktree add <MAIN>/.claude/worktrees/wt-<n> -b fix/<n>-<slug> origin/<base>
# ... worktree setup (profile §Worktree), implement, gate.fast, self-review ...
# contract `check` (SKILL.md §Scope lock) right before each push / PR / issue create / merge below
git push -u origin HEAD            # never --no-verify (profile §Merge gate: what the pre-push hook runs)
gh pr create --repo <repo> --base <base> --label "<tier label>" --title "..." --body-file "$TMPDIR/pr-body-<n>.md"
<merge gate> 2>&1 | tail -60       # profile §Merge gate — command + env; paste the summary into the PR
git -C <MAIN> worktree remove <MAIN>/.claude/worktrees/wt-<n> && gh pr merge <pr> --squash --delete-branch   # from <MAIN>
gh issue comment <n> --repo <repo> --body "..."   # progress / blockers / decisions
```

## Filing new issues (proactive backlog)

Dedup first — **fetch, don't search** (the search endpoint's 30-req/min sub-limit silently misses matches):
```bash
gh api "repos/<repo>/issues?state=all&per_page=100" --paginate --jq '.[] | select(((.title // "") + " " + (.body // "")) | test("<key words>"; "i")) | {number, author: .user.login}'   # tested inside jq: no text printed
node "${CLAUDE_PLUGIN_ROOT}/scripts/sapu-contract.mjs" issue-trust <n> --text > "$TMPDIR/dup-<n>.json"   # a candidate match; exit 1 = an outsider's issue: not a duplicate, not read
```
Never add, remove, rename or create the acceptance label (`labels.accepted`): accepting an issue is the owner's own act.
File only well-formed issues: title, context, repro or rationale, clear acceptance criteria, a priority label, severity if relevant. No spam — if everything's fine, file nothing. Never open a 🔴-tier issue and auto-merge your own fix for it in the same breath; red stays red regardless of who opened it.

```bash
gh issue create --repo <repo> --title "..." --body "..." --label "<type>,<priority>"   # label names: profile §Labels
```

## State & labels

Stateless between runs — GitHub is the source of truth. Every transition is a label change **plus** a one-line issue comment. Which labels exist in the repo, and their exact names: profile §Labels.

- **Agent lifecycle:** `<queued>` · `<inProgress>` · `<blocked>` · `<done>`.
- **Research gates:** `needs-ai` · `needs-clarification` · `security`. `needs-ai` means "decide this from a research dossier, not from memory". A legacy label meaning the same (profile §Labels) survives only on closed items; relabel it to `needs-ai` if you ever meet it open, and never apply it.
- **Risk:** `<tier label>` — `labels.tierPrefix` + `green` · `yellow` · `red`.
- **Model override:** `model:opus` · `model:sonnet` — see `/sapu:sapu` §Model & effort.
- **Type** and **Priority** (`p0..p3`): names and repo-specific notes in profile §Labels. The commit-type prefix already carries test/chore; don't duplicate it at the issue level unless the profile says the repo has such labels.

## PR description template

```markdown
## What
<one-paragraph summary of the change>

## Why
Closes #<issue-number>
<the problem this solves, in plain language>

## How
<key implementation decisions; anything a reviewer should understand>

## Decisions and sources
<label `needs-ai` or tier 🔴: each decision → its sources (URL + access date) → the alternative rejected and why (SKILL.md §`needs-ai`); otherwise "none">

## Attack plan
<🟡/🔴, written BEFORE the first edit: one row per AC and per bypass class A–F (§Inline review angle 4) that applies, scope edges included (existing data or periods, rollout, date bounds), each both ways>
- <AC or class> — <concrete scenario> — refused: <test file:line> — legitimate still passes: <test file:line>

## Testing
- [ ] Unit/integration tests added or updated
- [ ] Diff-scoped tests pass locally (full suite only if step 8 escalated)
- <how to verify manually, if relevant>

## Risk
Tier: 🟢 / 🟡 / 🔴
Rollback: <how to undo this if it goes wrong — required for 🟡 and 🔴>

## Security
Outsider: <attack opened / closed / untouched, and why>
Insider: <attack opened / closed / untouched, and why>
Security standard (profile §Security bar): <requirement IDs touched, or "none">
Decisions: <security decisions taken + standard/source, or "none">

## Notes
<follow-ups filed, known limitations, out-of-scope items>
```

## Inline review — the review checklist (every tier)

Review angles, worked sequentially by one reviewer: forge step 9/11's QA specialist (🟢/🟡), the `needs-ai` refutation pair (🔴), the step 11 fix-delta re-check, and sapu A3.5. **First read the repo profile `.claude/sapu/forge.md`** — angles 4, 5 and 7 use its §Invariants, §Inline review and §Security bar. Read the full diff plus the enclosing function of every hunk, then go angle by angle and write findings as `file:line — claim — concrete failure scenario`. Only findings you can trigger with named inputs/state count; everything else is a note, not a finding.

1. **Line-by-line** — inverted/wrong condition, off-by-one, null/undefined deref, missing `await`, falsy-zero check, wrong-variable copy-paste, swallowed catch, unescaped regex.
2. **Removed behavior** — for every deleted/replaced line, name the invariant it enforced and find where the new code re-establishes it. Dropped guard, narrowed validation, deleted test = finding.
3. **Cross-file** — Grep callers of every changed symbol; new precondition, changed return shape, new throw, ordering dependency. Tests that still point at a moved/renamed file.
4. **Guard-mirror** (how often it bites in this repo, and its usual twins: profile §Inline review) — a rule enforced on one path but missing on its twin: API vs UI gate, one locale's dictionary vs another's, create vs update DTO, service vs DB CHECK constraint, **service test vs route test ("test bypass" rule above — a service-only suite never proves the controller wires session identity/role/self-approve correctly)**. For any cumulative/threshold/uniqueness rule the diff touches, run the **six bypass classes** by name: window direction (A), TOCTOU — threshold read outside the writer's transaction/lock (B), no re-check at approve/activate/apply/issue (C), a sibling endpoint with the same effect that skips the same gate (D), UI-only enforcement (E), actor=subject or an identity/amount field trusted from the body (F).
5. **Repo rules** — every invariant in profile §Invariants the diff touches, quoted rule + offending line only; plus each repo-specific check listed under angle 5 in profile §Inline review.
6. **Reuse / simplification** — re-implemented helper that already exists nearby; derivable state; dead code left behind; test that asserts the mechanism instead of the invariant.
7. **Security bar** (profile §Security bar) — the PR's Security section exists and is true. For every new read or write path, ask who could abuse it from outside and who from inside: a legitimately logged-in staff member, or the holder of server/DB access. A weakened or bypassed existing control is a finding, not a note.

Route each confirmed finding by the step-11 rule (invariant domain → specialist; trivial 🟢 elsewhere → inline fix), re-verify, done. **Reviewer choice never varies with diff size or difficulty** — it follows risk alone (§Model & effort): 🟢/🟡 always one QA specialist (`specialists.qa`, Opus/high), 🔴 always the Opus `needs-ai` pair.
