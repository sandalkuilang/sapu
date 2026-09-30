# ARGUS fraud lane — the 🕵️ Auditor

Theft that needs **no** exploit: every request authorized, every response 200, and the money still leaves. Anything requiring forgery, escalation, IDOR or a bypassed guard is `sapu:nemesis`'s — refer it, don't drop it (SKILL.md §2 in this skill's directory).

Run every probe as a seeded staff account (`config.yml` `test_accounts.staff`). The principal exemption is split — SKILL.md §2; §4 below applies it. The repo's rules, matrix pairs, rotation, vectors, thresholds and detectors live in profile §Fraud: … sections (the profile index says which file); each section below names its hook.

**This pass runs every cycle, no exceptions.** If the lane touches money, stock or credit, run it there. If it doesn't (pure catalog UI, i18n, a11y), run it against the highest-priority overdue surface in §5. *"Nothing to steal in this lane"* is never a reason to skip — it only means the fraud pass happens somewhere else this cycle.

---

## §1 The two questions, on every surface that moves money, stock or credit

Hook: profile §Fraud: rules (which written rules these two questions test).

1. **Can one person complete a value-moving chain alone?** The repo's SoD rule. The failure that actually happens is not a broken `recorderId !== approverId` check — it is a user who *natively holds both halves*, which makes the 4-eyes gate vacuous while every code check still passes. §3 computes this mechanically instead of discovering it one surface at a time.
2. **If they did it, would the record convict them — and would anything carry the obligation?** The audit-every-change rule + the repo's reconciliation. An authorized action that leaves no attributable trace is a finding on its own. And after any mismatch, unmatched credit or partial payment, something durable must carry the obligation — the work-item test in reference.md §6.

**No control may be recorded as HOLDING without a `file :: symbol` locator pointing at the actual enforcement** — a DB CHECK constraint, a DB trigger, a permission-guard call, a service-layer throw, or a repo verification gate — plus which layer it is. Prose in CLAUDE.md or the threat model is the **rule**, never the proof. "Rule cited, enforcement not located" is itself a Class B candidate. *(CERT Common Sense Guide BP15: policy-level separation of duties is not separation of duties.)*

---

## §2 Heist rehearsal — invent the theft before you test for it

A checklist only catches what a previous cycle already imagined; a real employee invents schemes nobody wrote down. So before probing, write schemes **in first person as a specific seeded role, with a number attached**: *"I'm `<role>`. I legitimately hold X and Y. Here's how I take <amount> this month and leave books that reconcile."* (A worked opening in the repo's roles and currency: profile §Fraud: schemes.)

**Every scheme is two parts, and both get their own verdict.** Only ~11% of real occupational frauds involve no concealment at all, so a scheme without a concealment step is not a scheme:

- **Theft step** — how value leaves.
- **Concealment step** — named from the observed real-world methods, each of which is a concrete question about what mutations the app permits (the repo's instance of each: profile §Fraud: schemes): *altered transactions in the accounting system* (can a recorded payment be re-linked to another invoice, or its paid-at moved, post-hoc?) · *deleted or omitted transactions* (the append-only triggers are exactly the control that answers this — **test the trigger, don't assume it**) · *created fraudulent transactions* · *changed payment method for disbursements* (can a derived payment destination change between presses, and is the change audited?) · *forced or altered account reconciliations* · *created/altered/destroyed documents*.

**Stop rule, not a quota** (why: a fixed quota gets met with exactly that many paragraphs and nothing new). **Generate schemes until two consecutive ones are blocked by a control you can cite as `file :: symbol`, then stop.** Constraints that make this produce something new:

- **Persist every scheme to `.argus/schemes.json`**: id, verdict, blocking control locator, cycle. A repeat must cite `SCHEME_REUSED:<id>`. **A pass whose schemes are all previously-recorded-and-blocked counts as SKIPPED and must be redone.**
- **At least one scheme with no existing id.** If everything you thought of is already in the ledger, you didn't think — think again.
- **Ask what the role does all day**, not what the endpoint accepts. The best schemes come from routine, high-frequency, boring actions nobody reviews.
- **Assume patience.** Slow theft that reconciles daily is far more dangerous than one big grab, and much likelier from someone trusted.

Then test each: does the app *stop* it, or merely record it politely? Both outcomes go in the journal — blocked ones name the control that blocked them, with its locator and evidence mode `[live|test|read]`. Only the ones that work get filed. **A blocked verdict with no locator counts as untried.**

Log: `fraud=<surface>:<schemes>/<theft_blocked>/<concealment_blocked>` — a cycle that blocked the theft but left the concealment primitive open is then visible at a glance.

---

## §3 The SoD conflict matrix — compute it, don't discover it

Segregation of duties is a property of a **user's union of permissions**, not of role definitions. Where one user may hold many roles, the matrix gets violated in production without any role definition ever changing. This converts ARGUS's most valuable hunt from an O(surfaces) manual probe into a deterministic check that cannot miss a combination.

**Procedure (ORIENT step):** read the role → permission source **plus the live grant rows** (profile §Actors), and evaluate the repo's conflict table (profile §Fraud: SoD matrix) **per USER over the union of that user's roles** — never per role. A violating pair is a filed finding with zero probing required; the body cites the pair, both duty classes, and the scheme it enables. A static per-**role** SoD gate, where the repo has one (profile §Fraud: SoD matrix names it and its sanctioned both-halves exemptions), cannot see a per-user union; that is exactly the gap this step closes. An exempt role is not an exempt user: check the per-row guard it relies on.

Duty classes to separate: **AUT**horization · **REC**ording · **CUS**tody · **VER**ification. *(GAO Green Book 10.13: "authority, custody, and accounting of operations".)*

Each row of that table = `permission × permission | duties | scheme it enables` (e.g. order entry × payment recording | AUT × REC | skimming / lapping).

**Privilege creep is the mechanism that gets you there.** Grant a seeded user a second role, remove the first, then check: are the first role's permissions actually revoked? Do the grant *and* the revoke both write audit rows? Is there any surface where an operator can review the current **union** of permissions per user? *(CERT BP15: organizations routinely add the new job's access without revoking the old job's.)*

---

## §4 The override pass — run it on every control you confirm HOLDS

Hunting missing controls is only part of the job; **override of existing controls** is one of the largest single weakness categories behind real frauds, and it is the top category for owner/executive-level actors. So for every control ARGUS credits as holding, enumerate every path that turns it off or routes around it:

- a **role** that skips it;
- a **status** that exempts it (`draft`, `unpublished`, a legacy queue);
- a **numeric threshold** below which it never arms;
- an **env var or seeded credential** that disables or reconfigures it;
- a **break-glass or fallback branch** — including a fail-**open** default on a falsy input;
- a **comparison set** the same actor can write to (§7).

For each path the verdict is not "can it be blocked" but the Actor B bar: **does the override write an append-only row naming the actor, and does it raise an alert to someone who is not them?** Record the enumerated paths in the journal so the next cycle doesn't re-derive them.

Restated precisely for principal power: *the principal exercising principal power is by design and is not filed; a principal-power exercise that leaves no attributable append-only record, or raises no alert to a second party, **is** filed.*

**Delegation collapse.** The repo's SoD assumes one principal (profile §Actors). If that account is delegated, or that role granted to staff, every step-up, SoD and money-rail control (profile §Fraud: rules names them) evaporates at once and nothing in the app objects. Not a blind file — but on any principal-only surface, state in the journal what a delegated principal could do unobserved. That is the scenario the business actually fears.

---

## §5 Rotation — weight by real-world scheme, not round-robin recency

Score surfaces by `scheme frequency × median loss × velocity ÷ (cycles_since_last_covered + 1)`. The business's real scheme profile decides the top of the list — a recency carousel under-weights it. The repo's default order and the reasoning behind it: profile §Fraud: rotation.

> ⚠ **Figures discipline.** The per-scheme frequencies, median losses, velocities and detection latencies that motivate any such ordering come from the ACFE *Report to the Nations*, and **they are UNVERIFIED here** — this file has not read them in the source PDF. The scheme taxonomy in §6 comes from the Fraud Tree PDF, which is verified (standards.md). **Re-fetch the RTTN edition and quote the figure you actually read before any number goes into an issue body** — never quote a statistic from a search snippet or from this file.

`.argus/coverage.json` carries a `scheme_leaf` key so leaves rotate independently of the repo's areas. **A user-directed lane may defer the owed surface at most once**; the next cycle is then forced onto it (why: under prose-only tracking an owed surface stays owed indefinitely).

---

## §6 How money actually leaves

In most schemes the theft happens *outside* the app and the app is only used to make the books look right — so the finding is usually **"nothing here would ever contradict it."** The repo's numbered vectors, its retired vectors (`Retired | Why | Successor risk that is still live` — never lose the last column), and its payment-surface and volumetric probes: profile §Fraud: vectors. Read each through three rules: **test the detector, not the form**; **a reconciliation one account can both input and close is self-certifying** — attack the per-row guard, over HTTP, one account vs two; **attack an existing watcher or tie, don't re-file its existence** — §4's override pass per tie, not per bundle, and confirm its schedule actually fires.

**Payment-surface checklist** for any payments/invoice lane (`WSTG-BUSL-10`). Where a payment instrument is minted at a fixed amount (profile §Fraud: vectors gives the repo's), anything that changes the total *after* minting either desynchronises the instrument from the invoice or reprices goods the gateway already confirmed payment for. **Required first probe:** mint the instrument, then (a) add an order item, (b) change a quantity, (c) apply or remove a discount, (d) void and reissue the invoice — after each, assert instrument amount, invoice total and the snapshotted line price still agree. A diverged pair is an S1 with a clean 200 on every request. Also from that page: quantity tampering, price tampering, discount codes, breaking the payment flow, race conditions, two-step transfers, bulk/multi-input payments.

**Volumetric harm — the fully-authorized flow abused at scale** (`API6:2023`). For every endpoint in scope write one line in the charter: *"business flow exposed = X; harm if a legitimate counterparty automates it = Y."* Standing probe: profile §Fraud: vectors. Enumeration variant: can one counterparty session walk the entire catalogue and price list, harvesting another counterparty's commercial terms?

---

## §7 Numbers are targets — four ways past a threshold

The repo's thresholds and worked examples: profile §Fraud: thresholds.

1. **Structure around it.** Every rule with a number is a structuring target: two amounts under a 4-eyes threshold instead of one at it, a date backdated just inside a flag window, a discount split to stay under a cap. **File the split that works and cite the threshold's rule** — "the boundary held at exactly N" is not coverage if N+N/2 walks through.
2. **Escape its axis.** Splitting stays on the control's own axis. Ask which quantity the rule actually reads, and whether the harm is a *product* of that and something unwatched (e.g. unit cost watched, quantity × unit cost not). **For every numeric control, write out the arithmetic of the harm and check which factors the rule never loads.**
3. **Poison its baseline.** A control that derives its threshold from rows the same actor can create is not a control, it is a mirror. Ask what the comparison set is and who can write to it — filtered by status? by date? by author? A minimum-sample early return is the same weakness from the other side: whoever controls how many samples exist controls whether the rule is armed at all. Applies to every rolling average, cumulative window and "historical" comparison in the codebase.
4. **Compose past it.** A threshold that reads one item is escaped by composition across items — the per-item gate passes N times while the aggregate never gets evaluated.

**Value that moves with no identity attached.** A payment event with no payer identity makes the instrument a bearer instrument — nothing can compare who paid against whose order settled. **Find the field an auditor would need to attribute value, and check whether it is captured at all.** (The repo's worked, deliberately-not-filed instance: profile §Fraud: thresholds.)

---

## §8 Severity for an Auditor finding — latency × velocity

Derive it, don't narrate it. The two inputs are the **scheme's velocity** (how fast it drains per month) and the **latency of the weakest control that would actually fire**. Every Auditor issue carries a `Detection` block: the named detecting control (reconciliation / anomaly alert / audit-log review / counterparty complaint / **none** — the repo's named controls: profile §Fraud: detection), whether it is **active** or **passive**, its expected latency, and who receives it.

**Floor: any finding whose only detector is passive — a counterparty complains, discovered by accident, an outsider notifies us — is at least S2 regardless of loss**, because passive detection is where the multi-year, highest-median cases live. Duration maps almost linearly to loss.

**The caveat you must not skip:** a reconciliation looks like an active control, but it may be self-certifiable (§6). **Do not credit it with its nominal latency until you have personally tried and failed to input and close the same report as one account.** What the repo's reconciliation is (and is not) is stated in its own rules — read it there (profile §Fraud: detection); don't describe it as an anti-fraud control where the rules say otherwise.

**Active detectors — automated ledger ties.** For a scheme whose theft or concealment step touches an account an automated tie watches, the tie is a legitimate `Detection` block entry with its schedule's latency **if and only if** you have personally tried to defeat that specific tie this cycle (§6) — a tie's mere *existence* is not evidence it fires, per the same discipline §4 already applies to every other control. Do not let a detector make an old vector look safer than it is: a tie that checks the ledger against the app's own records says nothing about a self-certification problem. The repo's ties: profile §Fraud: detection.

---

## §9 BUSL-07 — what did the app record about *me*?

Your own aggressive probes are the test input. This costs no extra probing and produces a candidate every cycle.

Count the cycle's aggressive probes (N): failed authz attempts, out-of-order workflow calls, implausible values, rapid repeats. Then — **as the principal, querying the tables directly, never inferring from HTTP responses** ("a defence exists but is invisible to the attacker" and "no defence exists" look identical on the wire) — query the audit, login-attempt and alert tables (profile §Fraud: BUSL-07) filtered to the probe account and the cycle window (each query `LIMIT`ed — SKILL.md §7). Record `defended: X/N` and which responses fired: request blocked · extra authentication demanded · response delayed · account locked · alert raised · audit row written.

**`defended: 0/N` is a reportable finding on its own** (label `security`, cite `WSTG-BUSL-07` + `ASVS v5.0.0-2.4.1`), and the body must state which tables were queried over what window.
