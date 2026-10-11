# ARGUS reference — oracles, test design, template, state

Lookup for argus (SKILL.md in this skill's directory). Read §1 and §7 every cycle; the rest per lane. Repo specifics for §1, §3, §7 and §8 are in the profile's core file (profile §Oracle, §Glossary, §Template, §Filing); for §2, §4, §5 and §6 in profile §Coverage, §Test design, §Derived oracles and §Concurrency (the profile index says which file).

---

## §1 Oracles — how you know something is wrong

An oracle is *a way of recognizing a problem*. Two facts go in every finding: **where the oracle came from**, and **what kind of inconsistency** you saw.

**Provenance** (pick one, print it):

| | Means | Example (the repo's: profile §Oracle) |
|---|---|---|
| `specified` | A written rule | a numbered rule in CLAUDE.md, a threat-model ID, the API contract doc, an ASVS/WSTG ID from standards.md |
| `derived` | Two things that must agree, disagree | a metamorphic relation (§5.1), a redundant path (§5.2), behaviour before a commit |
| `implicit` | Obviously wrong, needs no spec | 5xx, unhandled rejection, DB trigger rejected the write, strict-schema 400, a console error |
| `none` | Your own sense of what the number should be | **Never a `bug`.** Downgrade to `ux`/`question` or journal it |

**Kind of inconsistency — FEW HICCUPPS** (Bolton's consistency oracles). Sweep the whole list once per charter; the four most easily skipped are marked ★:

**F**amiliarity (resembles a known failure pattern) · **E**xplainability (can't be explained coherently) · **W**orld (contradicts the world outside) · **H**istory ★ (differs from the previous release — a real regression with no written rule) · **I**mage (harms the business's reputation) · **C**omparable products ★ (how comparable products gate the same thing — profile §Oracle names the comparison) · **C**laims (contradicts what we wrote down — the internal-rule oracle) · **U**ser desires · **P**roduct (internally self-inconsistent — one screen contradicts another) · **P**urpose ★ (fails the implicit use, versus the documented one) · **S**tatutes and standards ★ (the tax, statute and contractual texts profile §Oracle lists).

Naming the oracle works both ways: it forces you to justify a claim (fewer wrong ones), and holding the list in mind primes you to notice problems you would otherwise walk past (more real ones).

**Checks vs tests.** A boundary that held is a *check* — it confirms an existing belief and produces no new information. Split the journal accordingly: `CHECKS (propositions verified — cheap, re-runnable)` and `TESTS (what was learned that we did not know)`, plus `unknowns remaining`. **A check you find yourself re-running across cycles is an automated-test PR against the repo's e2e guide (profile §Glossary), not a manual re-run.**

---

## §2 Coverage model — cover the product, not the feature list

Key `.argus/coverage.json` by **product element × quality criterion**, not by lane name, and have SELECT pick the least-covered *cell*. Lane names hide whole dimensions.

**Product elements (SFDIPOT):** Structure · Function · **Data** (transformations over a data entity's whole life: created, accessed, modified, deleted) · Interfaces · **Platform** (job-queue retry/duplicate delivery, presigned-URL expiry, DB triggers) · **Operations** (*disfavored use*: ignorant, mistaken, careless or malicious patterns) · **Time**.

**Quality criteria:** Capability · Reliability · Usability · Charisma · Security · Scalability · Compatibility · Performance · Installability · Development.

The cells that have no lane name, and therefore go unswept: **Time** (the repo's due dates, backdating windows, change delays, cron boundaries and zone offsets: profile §Coverage). **Data lifecycle** — run it straight at the append-only triggers. **Platform** — job retry and duplicate delivery. **Operations** — disfavored use is the whole Auditor lane, from the other side.

---

## §3 Implicit-oracle checklist — runs in every cycle, whatever the lane

Attach these to every request you make, no matter the focus. They need no expected value (the repo's regex, headers and wire forms: profile §Glossary):

- tail the API log for 5xx and unhandled rejections;
- read the browser console;
- assert no response body matches the sensitive-field regex;
- assert the mandated security headers are present;
- assert an unknown body field returns **400**, not 500 and not a silent drop (strict schema);
- assert every money field on the wire still has its lossless wire form.

Keep `.argus/corpus/*.json`: request bodies that have produced interesting behaviour — unknown-field payloads, giant paste, RTL/emoji, whitespace-only, negative and overflow numeric strings, reversed date pairs, the quantity × unit-cost extremes (profile §Oracle). **Replay the corpus at the start of every cycle, before the lane work.** Free regression coverage.

---

## §4 Test design

Per-subsection repo instances: profile §Test design.

### §4.1 Business process & workflow conformance (B)
Model the intended flow as a state machine from the repo's rules and blueprint docs (and the state-machine file, if one exists). Prove forbidden transitions are blocked, required steps unskippable, each step's permission gate held. Try to reach illegal states via ID manipulation, replay, back/forward navigation. Every process, not only the main one: processes with no state-machine file keep their guards in per-service code — `sapu:momus`'s business-process map lists them. Drive them over HTTP, never through the UI (ASVS 2.3.1). The journey lane ([journeys.md](${CLAUDE_PLUGIN_ROOT}/skills/argus/journeys.md)) walks the same flows through the UI as each role: it adds the user's side and replaces none of this rule.

**Forward/reverse pairs — the leg nobody tests.** For every transition that *consumes* a limited resource, test the reverse and assert the resource is released **exactly once** — not zero (permanent silent loss), not twice (free quota). Enumerate the pairs (quota, stock availability, credit utilisation, receivable…). **Know which quantity the rule says moves**: a rule may require the reverse to move *utilisation* while the *ceiling* stays unchanged — then assert on utilisation, and treat a moved ceiling as the defect. (`WSTG-BUSL-06`, `ASVS v5.0.0-2.3.3`.)

**Out-of-order external events.** Any state machine driven by externally-delivered events must be fed **backwards**, not merely twice: PAID then EXPIRED/FAILED for one reference; a second PAID before the first finishes. Assert the terminal state does not regress, and **report explicitly whether the handler reads the event timestamp at all** — if it does not, that is the finding. Ordering is never guaranteed by any gateway.

### §4.2 Forms & validation
Empty, boundary lengths, wrong types, unicode/RTL/emoji, whitespace-only, giant paste; client and server agree; human messages via the repo's i18n helpers, never hardcoded.

**Enumerate every field's semantic boundary and report each verdict — never leave the headline one implicit.** Percentage → `>100` and `<0`; quantity/quota → `0`, negative, over the DTO `.max()`; money → its currency ceiling; date-pair → reversed and equal; code/name → min-length, over-max, whitespace-only. If your report does not explicitly say whether `>100` was blocked, you did not test the field.

**Silent rejection is a `ux` bug.** A control that goes `aria-invalid` or disables Save with **no visible message** leaves the user with no path forward. Class A when it also lets a doomed value through to a 400; `ux` when it just blocks mutely.

**Named heuristics — declare in the charter which you will apply** (Hendrickson/Lyndsay/Emery): CRUD · Count (0, 1, many) · Position (first, middle, last) · Selection (some, none, all) · Goldilocks (too big, too small, just right) · Dependencies ("has a" relationships, then CRUD/Count/Position/Selection on them) · Follow the Data · Sequences · Interruptions · Flood · Multi-User · Constraints · Input Method · State Analysis · Variable Analysis · TouchPoints.

Four of them are near-guaranteed bug generators here:
1. **Input Method — GUI vs API.** Run every mutation both through the UI *and* by direct request. That is exactly the test for the rule that UI gating is UX and the backend is the enforcer, and it mechanically produces a Class B candidate wherever the two disagree.
2. **Dependencies + Count.** A parent with 0/1/many children, each child with 0/1/many lines; delete the last line then read; apply the parent's terminal action with 0, 1, many live dependents.
3. **Multi-User.** Simultaneous create/update/delete from two accounts, or the same account logged in twice — the cheapest probe of the ledger-sum, idempotency and append-only rules.
4. **Follow the Data.** Walk one entity through every hop it takes (entry → rendered document → reconciliation grouping → audit row → dashboard aggregate), asserting the money wire form survives every hop.

### §4.3 API & contract
Status codes correct (200/201/204/400/401/403/404/409/422/429/500); pagination/filter/sort behave; idempotency where promised.

**Leak questions are answered by a two-session diff, never by reading.** Call the same endpoint with two live sessions of different permission, diff the JSON key sets, paste the diff. Where a rule hides a field *except for users with a special permission*, a correct implementation is permission-**aware**, and a static allowlist is indistinguishable from a permission-aware mapper from a single session. Read the **response mapper**, never the input interface that feeds it (reading the input side yields wrong refutations), and confirm on the wire.

**Test the write half of the same property** (`API3:2023` fuses exposure and mass-assignment because they are one property seen from two sides): send each sensitive or derived field in the body — scope key, price, status, credit limit, paid-at, parent id — expect a strict-schema 400, **then re-read the object** to confirm nothing bound. A 200 that silently drops and a 200 that binds are the same status code.

**Role gating is a verb sweep, not a path read** (`API5:2023`). For every mutation route you confirm gated, re-issue it three ways and record each status: (a) same path, different verb — PUT/PATCH/DELETE where only POST is documented; (b) the next-lower-privileged seeded role; (c) an authenticated session with no relevant permission. Expected 403/405 everywhere; a 200/204 is the finding. **Never conclude a route is safe because it sits under an admin-looking path, or because the repo's UI-gating gate passes** — that gate covers UI controls, and the backend is the enforcer.

**A field the product never exposes anywhere can itself be the bug.** If a mandated control depends on a human seeing an artifact, "correctly hidden per the redaction rule" and "the reviewer cannot do their job" are the same code and opposite verdicts.

### §4.4 Data & state integrity
No orphans, no broken FKs, ledger/stock reconciles. Every table the append-only rule names must stay append-only — **probe every verb, not just UPDATE/DELETE**: UPDATE, DELETE, **TRUNCATE**, DROP TRIGGER, ALTER, `session_replication_role`. Recording "append-only holds" after testing UPDATE/DELETE alone leaves a TRUNCATE hole unseen.

**Immutability is only half the invariant.** After confirming UPDATE/DELETE is rejected, ask: *so how does a legitimate correction get made?* For each append-only table, name the sanctioned reversal operation, its permission gate, and whether both the original and the reversal survive. **"No reversal path" is filable even when every guard passed** — severity set by what staff would do instead (a manual DB edit, or an unrelated destructive operation like voiding an invoice).

**A status string is never evidence for a money or stock claim.** With no paired double-entry, no arithmetic can contradict a one-sided write: "the invoice reads paid" proves a column was set, never that value moved. Every money/stock finding carries a computed conservation line — `SUM(<stock ledger> per item×location) = X vs displayed Y`, or `SUM(payments applied) = X vs invoice total Y`. **A refutation based on a status field is not a refutation either.**

### §4.5 Money, time & i18n
Money keeps the repo's lossless representation, never float; time math respects the storage-vs-business-zone rule (a bare bucket on a naive timestamp is a bug); locale content resolves per the user's locale, never hardcoded; enum labels via the repo's helper, never a hardcoded ternary. The repo's exact rules: profile §Test design.

### §4.6 Auth, resilience, performance, a11y
IDOR via ID swap; expired/forged/absent session; tenant/counterparty-scope leaks (the scope key from the session, never the body); step-up on dangerous actions; logout/revoke truly invalidates. N+1 queries, pages that slow with data volume, requests with no timeout. Injection-style inputs to confirm neutralisation — the repo's DAST guide already owns the scanner baseline (reflected XSS, missing headers, open redirects); **extend it, don't re-derive it**. Keyboard-only, focus order, labels, contrast per the repo's accessibility runbook. Re-run the flows touched by recent commits.

---

## §5 Derived oracles — verdicts with no expected value

### §5.1 Metamorphic relations
Run the same business action twice under a transformation the invariants say must not change the result, and compare the two runs **to each other**. A violated relation is a bug even though neither output was ever known to be right. **Execute at least two per cycle** and print: source case, follow-up case, the relation, the invariant that makes it necessary, the divergence. (Which rule makes each relation necessary in this repo: profile §Derived oracles.)

| MR | Transformation | Must hold | Invariant |
|---|---|---|---|
| MR-1 **split-invariance** | 1× a value at a threshold vs 2× half of it | same balance **and** same control outcome | the 4-eyes threshold |
| MR-2 **commutativity** | two authorized actions in either order (record payment / mark shipped; promo apply / price snapshot) | identical stock-ledger sums, identical outstanding, same audit diff modulo ids+timestamps | ledger sum, price snapshot, audit-every-change |
| MR-3 **idempotence** | `f(f(x)) = f(x)` for any request with an idempotency key or a gateway callback | replay is a byte-identical no-op on state | idempotency key |
| MR-4 **locale invariance** | the same entity under each supported locale | identical money strings, identical enum semantics; any archived single-locale document agrees with the localized view | i18n |
| MR-5 **anti-MR (variance required)** | the identical request as the recording role and as its reviewing role | outcomes must **differ** wherever SoD is claimed — *sameness is the finding* | SoD |

MR-1 is what finally makes a passing threshold probe mean something: "the boundary held at exactly N" is not coverage if N+N/2 walks through.

### §5.2 Differential pairs — where one number has two producers
Disagreement **is** the bug; no rule citation needed, because the system contradicts itself. File as `Oracle: derived (differential)`. The repo's pairs, with their producers: profile §Derived oracles. Typical numbers with two producers: stock on hand, an invoice total (including **any archived document rendered by a worker no human reads** — the ideal differential target), a confirmed settlement vs the rows it summarizes, one money value under two locales, the permission matrix (seed · backend guards · UI gates), a GL control account vs its subledger — where an automated tie already computes the pair, a live disagreement means the tie is broken or its cron isn't running, which is the more interesting bug.

### §5.3 Stateful sweep
Define rules (the repo's value-moving transitions: profile §Derived oracles) plus a bundle of ids produced by earlier rules, so later rules act on real entities. Generate a legal sequence of 15–30 steps **with a recorded seed**, and after **every** step assert the standing set: stock == count/sum of the stock ledger per (item × location) · outstanding == snapshotted line total minus settled payments · an audit row exists carrying user id / IP / user agent / request id and a real before/after diff · no single user id has performed two consecutive links of the critical chain · every money field still has its wire form. Write the seed and the step list to the journal so a cold-start cycle can replay it. Bugs that live in orderings and accumulations are structurally unreachable by single-transition probing.

### §5.4 Minimize before filing
Strip one step, field, role or precondition at a time and re-run, keeping every removal that still reproduces. File the minimal sequence with *"Minimized from N steps to M; removing step X makes it pass"* — that sentence doubles as the causal evidence an Auditor finding otherwise lacks. **Cannot reproduce during minimization → it was noise; drop it and log `dropped_on_minimize`.**

---

## §6 Concurrency, idempotency & externally-delivered events

**Limited resources are a locking requirement with a standard behind it** (`ASVS v5.0.0-2.3.4`, `WSTG-BUSL-05`). A resource defined as the SUM of ledger rows has **no row to lock**, so every check-then-insert has a genuine race window; a quota counted live from line items has the same shape (the repo's: profile §Concurrency). A sequential boundary probe at the last unit will always pass — only true parallelism finds this.

**Procedure:** drive state to exactly one unit remaining, fire **N=10 genuinely parallel identical requests** (not a double-click), assert exactly one succeeds, and put the observed final SUM in the body. Resources: profile §Concurrency (stock at the last unit, quota at its last slot, credit at exactly its remaining headroom).

**Idempotency — replaying an identical payload is the test that always passes.** Three named cases, all three logged; a cycle that ran only the first logs `idempotency: partial`, never "holds":

| Case | Expected |
|---|---|
| identical replay | no-op |
| **same key, different amount** | explicit rejection **and a durable record** — a silent replay of the first outcome is filable |
| **concurrent same key** | exactly one effect |

**Name the dedupe key's cardinality — per-delivery, per-transaction, or per-invoice.** The rule: *the dedupe key must be at least as unique as the event it dedupes.* A key that is unique per invoice cannot, by construction, distinguish a redelivery from a second genuine credit of the same amount. So "we dedupe by idempotency key" is a design property to **probe**, not a control to accept — send two identical PAID callbacks and report whether a second real credit is representable **at all**. Probe against the repo's own statement of this gate, don't re-derive it (profile §Concurrency records what the repo's rules say about this gate).

**A detected discrepancy needs a durable work-item state, not a log line plus an alert.** After provoking any amount mismatch, unmatched credit or partial payment, query for a row whose *state* means unresolved-and-owed. **An alert that dedupes on a coarse key (e.g. type + entity id) is a notification, not a queue.** Assert every discrepancy kind lands in the repo's durable work-item (profile §Concurrency), and that a failed mint raises its own alert; a discrepancy kind with no such row is filable.

**Time the callback handler.** Providers retry on timeout (Adyen queues a retry after 10s with no response), so inline settlement work before the 2xx manufactures a provider-initiated retry racing the original execution. Note whether acknowledgement and processing are separated.

**Fault injection.** Deliver the callback twice and out of order; deliver it while a concurrent checkout for the same order is in flight; kill the API between the payment write and the audit write; force a job-queue retry; double-submit from two tabs on one session; expire the session mid-chain. Every concurrency/idempotency/fraud finding attaches a **history table** (`t · actor · request · status · resulting audit / ledger rows`) and states which invariant no interleaving of that history satisfies — prove the violation from the history, don't assert it from the code.

---

## §7 Issue body template

Placeholders filled per profile §Template (rule-citation form, URLs, test command, currency).

```markdown
## Summary
<One plain sentence: what's wrong and who it hurts. No hedge words without T1/T2 behind them.>

## Class & Severity
**Class:** 🅱️ Business-workflow nonconformance   (or 🅰️ Technical defect)
**Severity:** S2  (base S1 −1 collusion required) · **Priority:** P1 · **Confidence:** very likely
**Found by:** 📋 PM (confirmed real by 🔬 Senior QA)
**Would change my mind:** <the observation that would drop this rating>

## Oracle
**Provenance:** specified | derived | implicit    **Inconsistency:** <FEW HICCUPPS>
**Rule violated:** <verbatim quote + resolvable path: <rule id> / <threat-model id> / ASVS v5.0.0-2.3.4>
(No written rule? Open with: "<Repo> has no written invariant covering this. <STANDARD-ID> requires: "<verbatim>". Is this intentional?" and prefix the title `[no rule exists]`.)

## Environment
- Mode: **live** | static · API <api url> / web <web url> · commit `<short sha>` · branch `<name>`

## Steps to Reproduce  (minimized)
1. <minimal, exact, copy-pasteable>
Minimized from N steps to M; removing step X makes it pass.
**Reproduced: 2 of 2 attempts.**

## Expected / Actual
<the rule above, or correct output> / <exact status code, value, or illegal state reached>

## Evidence — OBSERVED
- [T1 wire] `POST <api>/shipments → 201 {"status":"shipped"}`  ← happily succeeded; that's the problem
- [T1 db] `SELECT ... FROM <audit table> WHERE entity_id='...' → 0 rows`
- [T1 conservation] `SUM(<stock ledger> item×location) = 118` vs displayed `120`
- [T2 test] `<test command> -- orders.service` → 1 failing

## Analysis — INFERRED
- [T3 code] `<path>/orders.service.ts :: markShipped` @ `<sha>` — <quoted line>
- Binding: `shipments.controller.ts` imports `markShipped` from `../orders/orders.service`  (2 definitions repo-wide)

## Refutation attempted
- **Kill-shot:** <the observation that would prove this wrong>
- **Ran:** <exact command / steps>
- **Result:** survived | killed
- **Discriminating observation:** <what rules out H2 harness-error and H3 documented-intent>

## Reachability & impact
- **Reachable-by:** `<seeded account>` (holds `<perm-a>` + `<perm-b>` natively per the role → permission source)
- **Automatable:** yes — repeatable per order with no second human
- **Max <currency> exposed per occurrence:** <amount> (<show the arithmetic>) · **Repeatable:** per order
- **Detection:** <named control> · <active|passive> · <latency> · nobody is notified
- **Sibling check:** prior issues of this mechanism are #<a> (S3), #<b> (S2); this is S2 because ___

## Affected sites (full enumeration of this mechanism)
- `path/to/a.ts :: fn` · `path/to/b.ts :: fn`   ← derived from `<the one query that finds them all>`

## Acceptance Criteria for the fix
- [ ] The fix enumerates every site by deriving the list from `<single source>`, and `<gate>` fails when a new site is added without it.
- [ ] <observable condition proving it's fixed>
- [ ] Regression: <the flow that must still work afterward>

<!-- argus-fp: B::orders::<rule-id>::missing-distinct-actor-guard -->
<!-- filed-by: ARGUS · cycle: <date>-<n> · mode: live -->
```

---

## §8 `gh` commands

`<repo>` = `config.yml` `github.repo`. Before any create or comment: the contract check of SKILL.md §5 gate 1.

```bash
gh auth status   # MUST show config.yml github.account — re-run immediately before EVERY create

# Dedup — fetch, don't search (the search sub-limit is 30/min and silently misses matches).
# --paginate reads every issue, however many the repo has (profile §Filing); the fingerprint is
# tested INSIDE jq, so neither title nor body is printed — an outsider's text never reaches you.
gh api "repos/<repo>/issues?state=all&per_page=100" --paginate \
  --jq '.[] | select(.pull_request | not) | select((.body // "") | test("argus-fp: B::orders::<rule-id>")) | {number, author: .user.login}'
# A match is a duplicate ONLY when its trust check passes; an outsider's match — a decoy carrying a
# real fingerprint — is ignored, and the finding is filed. Its title and body: this verdict's only.
node "${CLAUDE_PLUGIN_ROOT}/scripts/sapu-contract.mjs" issue-trust <n> --text > "$TMPDIR/argus-dup-<n>.json"

# Second pass: the symptom, not the fingerprint — endpoint path, rule id, service filename
gh api "repos/<repo>/issues?state=all&per_page=100" --paginate \
  --jq '.[] | select(.pull_request | not) | select(((.title // "") + " " + (.body // "")) | test("markShipped|<rule id>")) | {number, author: .user.login}'

# <agentFiled> = the contract's labels.agentFiled (default sapu:agent-filed; none with policy.traces "none"): every agent-filed issue carries it (CONTRACT.md, Agent-filed issues)
gh issue create --repo <repo> \
  --title "[S2][orders] <role> account can ship an order it created — <rule id>" \
  --label "bug,class:business,severity:s2,priority:p1,workflow,found-by:pm,argus,<agentFiled>" \
  --body-file .argus/tmp/issue-body.md

gh issue comment <n> --repo <repo> --body "Reconfirmed on <sha>: <new reproduction path>"

# Outcome loop — GitHub will never tell you a finding was wrong (argus issues close COMPLETED regardless)
gh pr list --repo <repo> --state merged --search "Closes #<n>" --json number --jq '.[].number'
node "${CLAUDE_PLUGIN_ROOT}/scripts/sapu-contract.mjs" pr-trust <pr> --text > "$TMPDIR/argus-pr-<pr>.json" \
  && jq -r .body "$TMPDIR/argus-pr-<pr>.json" | grep -Ei 'premise|misdiagnos|already fixed|unreachable|stale|latent'
```

On a dedup match whose `issue-trust` passed: **comment the new reproduction path onto the existing issue and re-rate severity if the new route is cheaper** — do not open a new issue, and do not silently skip. Never comment on, count or read an outsider's match: it does not suppress a finding.

---

## §9 `.argus/` state

| File | Written by | Read by | Contents |
|---|---|---|---|
| `config.yml` | owner (the one tracked file) | ORIENT | repo, URLs, accounts, scope/exclusions, business-truth docs, limits. **The only source of truth for oracle paths and labels** — verify with `test -f` and `gh label list` at ORIENT |
| `coverage.json` | PERSIST | SELECT | area/cell → `{lastCycle, lastTestedDate, verbs_probed, verbs_not_probed, strength: disproved\|unproven}` |
| `fingerprints.json` | PERSIST | ORIENT | one entry per candidate, **filed and refuted**. Refuted: `{fingerprint, cycle, claim, killed_by, quote, recheck_after_cycles}` |
| `open_questions.md` | PERSIST | SELECT | unproven probes; what would settle each |
| `live-debt.json` | static cycles | the next live cycle | questions only a running server can answer |
| `schemes.json` | the fraud pass | fraud.md §2 | rehearsed schemes: id, verdict, blocking control locator, cycle |
| `arid.md` | TRIAGE / on every wontfix | TRIAGE | finding *shapes* the owner rejects |
| `corpus/*.json` | EXECUTE | EXECUTE | interesting request bodies, replayed every cycle |
| `journal/<cycle>.md` | PERSIST | ORIENT | PROOF sections: Past · Results · Obstacles · Outlook · Feelings |
| `journal/<cycle>-candidates.md` | TRIAGE | audit | the candidate table |
| `referrals.md` | TRIAGE | the report, and NEMESIS | out-of-lane candidates + why, so nothing is silently discarded |
| `run.log` | PERSIST | audit | one line per cycle, format below (SKILL.md §6 assertion 4) |
| `live.json` | owner, through `/sapu:init` (tracked beside `config.yml`) | `argus-live.mjs` | the journey lane's isolated instance: setup, services, start entries, roles and their accounts, limits |
| `live.env` | owner (the `env_file`; never tracked) | `argus-live.mjs` | the values `live.json`'s `${NAME}` references take; no agent reads it |
| `journeys.json` | `argus-live.mjs map-check`, `visit` | SELECT (`select`) | the journey map: journeys, steps and their code anchors, `lastCycle`, `lastHead`, `filed` |
| `live/` | `argus-live.mjs` | `argus-live.mjs` | journey cycles' lock, run records, returns, repro records, secret ledgers and logs: read only through its commands (journeys.md) |

**`run.log` format**, date prefix included:
`<date> cycle=<id> mode=<live|static> focus=<area> candidates=N confirmed=N declined=N dropped_on_minimize=K filed=N issues=#a,#b referred=N fraud=<surface>:<schemes>/<theft_blocked>/<concealment_blocked> negatives=<control>@<locator>[live|test|read] method=...`
A journey cycle's line: `mode=live focus=journey:<ids> … fraud=-` (journeys.md: it owes no fraud pass).

**Recovery if state looks stale:** re-derive `fingerprints.json` from the argus-labelled issues (`gh issue list --state all --label argus --json number,author`, each read through `sapu-contract.mjs issue-trust <n> --text`; exit 1 = not argus's own, skip it) when state is missing but argus-labelled issues exist; none exist = a genuine first run. Start `coverage.json` fresh only for the missing areas. Don't rewrite history you can still read.

---

## §10 Maintaining these files

This section is the one home for skill-edit rules; SKILL.md §6 assertion 3 points here. A cycle edits only the profile files (`<profiles>/argus*.md`); an **engine-level** addition — a rule that belongs in these shared skill files, not in one repo's profile — is instead filed as an issue on the **plugin's own repository** (the `repository` in the plugin's `.claude-plugin/plugin.json`; the exact commands are in SKILL.md §6 assertion 3, where the plugin root is already filled in), in the same PERSIST step, so it never dies in the gitignored journal. Three hard gates before that `gh issue create`:
1. **Account** — `gh api user` equals the contract's `ghUser`. Otherwise file nothing, never `gh auth switch` (it flips the global keyring other sessions use), and list the unfiled proposal in the cycle report.
2. **Dedup** — fetch the plugin repo's open issues (never `--search`); an open issue already carrying the rule means file nothing.
3. **No repo data** — the body is the proposed engine diff plus a one-line reason, nothing else: no findings, paths, accounts, issue numbers, URLs or names from the repo under test. The plugin repo is another audience, and the engine stays knowledge-free.

The same rules bind both.

- **Net-zero growth.** An addition pairs with a deletion, a merge, or `kept: <reason>`. These files are read *every cycle*; every line costs context before a single probe.
- **Compress war stories to rules.** In a profile: `RULE: <imperative>. (why: ≤15 words, cycle <id>, #<issue>)` — provenance kept, narrative dropped. In the engine: the rule plus a present-tense reason only — no cycle, count or story; the provenance goes to profile §Provenance.
- **Never restate CLAUDE.md** — it is in every agent's context; cite the rule or section by number (SKILL.md §0).
- **No bare line numbers.** Cite `file :: symbol` plus the grep that finds it (SKILL.md §0).
- **Surface-existence is a precondition of probing.** Before running a vector, resolve the model/route/permission it names. Gone? Delete the bullet in the same cycle, log `retired=<vector> per #NNNN`, **and name the successor risk** — deleting a vector without saying what replaced it is not allowed.
- **Every catalog entry carries `last-verified: <cycle-id>`;** unverified for 5 cycles → demote to a one-line stub.
- Profile edits are proposed as a diff in the journal and applied to the profile files at the **end** of the cycle, never mid-hunt; an engine-level addition is filed as a plugin-repo issue in that same PERSIST step (above), not applied to the skill files by the cycle itself.

**Existing coverage — build on it, don't duplicate:** `config.yml` `business_truth.existing_qa_refs` (what each covers: profile §Glossary). A gap in one of these is usually worth more as a PR against the guide than as a one-off finding.
