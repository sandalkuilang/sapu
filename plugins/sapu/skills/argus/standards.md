# ARGUS standards index — the outside authorities you may cite

When an internal document is wrong or silent about the outside world, an oracle built only on CLAUDE.md, the threat model and the code inherits the error — a wrong belief about how an external system behaves can survive in the code and its own docs until someone checks it against the vendor's own spec. This file exists so a Class B finding can be grounded on a published requirement when the repo has no written rule of its own (SKILL.md §1b, in this skill's directory).

**The security bar** (the repo's: profile §Written rules) — ASVS 5.0 and NIST SP 800-63B-4 sources are listed in the `sapu:nemesis` skill's reference.md § References; no skill yet records a fetched source for CIS or for a data-protection statute, so those follow the verification rule below before any clause enters an issue. The ASVS V2 business-logic rows ARGUS uses most are below.

## The verification rule — non-negotiable

**Quote only what you fetched.** Search-result snippets fabricate plausible "verbatim" quotes. Before a quote enters an issue body: fetch the page, read the sentence, paste it, and record the access date. A claim you could not fetch is written as **"unverified assumption"** and cannot carry severity above S3.

Every URL below is verified by an independent fetch, except the entries **marked ⚠** — those are recorded rather than deleted, because knowing a citation is unverified is worth more than quietly dropping it.

---

## Test design, oracles, sessions

| Use it for | Source |
|---|---|
| The oracle taxonomy (FEW HICCUPPS). *"an oracle is a way of recognizing a problem"* | Bolton, DevelopSense — https://developsense.com/blog/2012/07/few-hiccupps |
| Coverage as Product Elements × Quality Criteria (SFDIPOT); "a set of models that was too limited" as a named reason bugs get missed | Heuristic Test Strategy Model v6.0, Bach — https://www.developsense.com/resource/htsm.pdf |
| Charter format, ~90-minute sessions, the PROOF debrief, bugs-vs-issues, on-charter vs opportunity work. A session is *"an uninterrupted block of reviewable, chartered test effort"* | Session-Based Test Management, J. Bach, STQE 2000 — https://www.ida.liu.se/~TDDD04/labs/2020/exploratory_testing/stqe-sbtm.pdf |
| The named heuristic catalogue (CRUD, Count, Position, Selection, Goldilocks, Follow the Data, Multi-User, Input Method, …) | Test Heuristics Cheat Sheet, Hendrickson/Lyndsay/Emery — https://www.ministryoftesting.com/articles/test-heuristics-cheat-sheet |
| Checks confirm existing beliefs and are not coverage. *"Checking is the mechanistic process of verifying propositions about the product."* | Testing and Checking Refined, Bach & Bolton — https://www.satisfice.com/blog/archives/856 |
| Why "0 bugs found" is not a report; bug investigation trades directly against coverage | Why Didn't You Find That Bug?, Bolton — https://www.developsense.com/presentations/2011-04-06-LTG-WhyDidntYouFindThatBug.pdf |
| Exploratory testing is structured and accountable, not ad-hoc | Bach — https://www.satisfice.com/exploratory-testing |

## Verdicts without an expected value

| Use it for | Source |
|---|---|
| The oracle problem and the four oracle kinds (specified / derived / implicit / none) | Barr, Harman, McMinn, Shahbaz, Yoo — https://discovery.ucl.ac.uk/id/eprint/1471263/1/06963470.pdf |
| Metamorphic relations — the technique behind reference.md §5.1 | Chen, Kuo, Liu, Poon, Towey, Tse, Zhou survey — https://homes.cs.washington.edu/~rjust/courses/CSE503/2021_02_12-reading2.pdf |
| Stateful/model-based generation and shrinking (reference.md §5.3, §5.4) | Hypothesis docs — https://hypothesis.readthedocs.io/en/latest/stateful.html |
| Coverage ≠ assertion; mutate a control's predicate and ask whether any test fails. Also: filtering out "arid" findings is what makes a tool trusted rather than ignored | State of Mutation Testing at Google — https://static.googleusercontent.com/media/research.google.com/en//pubs/archive/46584.pdf |
| Prove a violation from a recorded history of operations rather than asserting it from code | Jepsen analyses — https://jepsen.io/analyses · Elle — https://arxiv.org/abs/2003.10554 |
| Always-on implicit oracles + a replayed corpus of interesting inputs | OSS-Fuzz — https://google.github.io/oss-fuzz/ |
| ⚠ QuickCheck's statement of the oracle problem — wording commonly attributed to this paper is **not on the page**. Re-read before citing | Hughes — https://www.cs.tufts.edu/~nr/cs257/archive/john-hughes/quick.pdf |

## Reporting, severity, triage

| Use it for | Source |
|---|---|
| Symptom is mandatory, diagnosis is optional — the OBSERVED / INFERRED split | Tatham, How to Report Bugs Effectively — https://www.chiark.greenend.org.uk/~sgtatham/bugs.html |
| Unique summary, check for duplicates as a separate act, unreproducible reports need unique information | Mozilla bug writing guidelines — https://bugzilla.mozilla.org/page.cgi?id=bug-writing.html |
| Severity keyed to workaround availability and share of users affected (S1…S4 wording) | Mozilla BMO bug fields — https://wiki.mozilla.org/BMO/UserGuide/BugFields |
| Named mitigating factors that each subtract one severity level | Chromium security severity guidelines — https://chromium.googlesource.com/chromium/src/+/main/docs/security/severity-guidelines.md |
| Base metrics alone are not a risk statement — rate against the deployed environment | CVSS v4.0 specification, FIRST — https://www.first.org/cvss/v4.0/specification-document |
| The `Automatable` decision point | CERT/CC SSVC deployer tree — https://certcc.github.io/SSVC/howto/deployer_tree/ |
| Business impact dominates technical impact; a tailored model beats a generic one | OWASP Risk Rating Methodology — https://owasp.org/www-community/OWASP_Risk_Rating_Methodology |
| A formal do-not-file tier with written entry criteria (P5 Informational) | Bugcrowd severity overview — https://docs.bugcrowd.com/customers/submission-management/severity-overview/ |
| Why a fabricated citation is more expensive than a missed bug | curl, *Death by a thousand slops* — https://daniel.haxx.se/blog/2025/07/14/death-by-a-thousand-slops/ |

## Business logic & API authorization — the Class B grounding set

Quote the requirement **verbatim with its version** when filing under SKILL.md §1b.

| ID | Covers | Source |
|---|---|---|
| `ASVS v5.0.0` V2 §2.3–2.4 | sequential step order, no skipping (2.3.1, L1) · business-logic limits per documentation (2.3.2, L2) · all-or-nothing rollback (2.3.3, L2) · locking for limited-quantity resources (2.3.4, L2) · multi-user approval on high-value flows (2.3.5, L3) · anti-automation (2.4.1, L2) | https://raw.githubusercontent.com/OWASP/ASVS/v5.0.0/5.0/en/0x11-V2-Validation-and-Business-Logic.md |
| `WSTG-BUSL-05` | limits on how many times a function can be used | https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/10-Business_Logic_Testing/05-Test_Number_of_Times_a_Function_Can_Be_Used_Limits |
| `WSTG-BUSL-06` | circumventing workflows; transact past a credit-granting point, then reverse | https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/10-Business_Logic_Testing/06-Testing_for_the_Circumvention_of_Work_Flows |
| `WSTG-BUSL-07` | defences against application misuse — the fraud.md §9 self-detection sweep | https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/10-Business_Logic_Testing/07-Test_Defenses_Against_Application_Misuse |
| `WSTG-BUSL-10 (master)` | payment functionality: quantity/price tampering, discount codes, adding items after payment initiation, race conditions, two-step transfers. **The `/latest` URL 404s — cite the master path** | https://raw.githubusercontent.com/OWASP/wstg/master/document/4-Web_Application_Security_Testing/10-Business_Logic_Testing/10-Test-Payment-Functionality.md |
| `API3:2023` | object property level authorization — excessive exposure and mass assignment as one property | https://owasp.org/API-Security/editions/2023/en/0xa3-broken-object-property-level-authorization/ |
| `API5:2023` | function level authorization; never infer admin-ness from a path | https://owasp.org/API-Security/editions/2023/en/0xa5-broken-function-level-authorization/ |
| `API6:2023` | unrestricted access to sensitive business flows — harm from fully authorized, never-erroring use | https://owasp.org/API-Security/editions/2023/en/0xa6-unrestricted-access-to-sensitive-business-flows/ |

## Accessibility — the Curator's grounding set

Normative source for every row: WCAG 2.2, W3C Recommendation 12 December 2024 — https://www.w3.org/TR/WCAG22/ (each SC links its *Understanding* page; quote from there). Level as printed on the normative page.

| SC | Level | Used for (aesthetics.md, or the smoke suite's checks) |
|---|---|---|
| 1.4.3 Contrast (Minimum) | AA | 4.5:1 body text, 3:1 large-scale (§3.2) |
| 1.4.10 Reflow | AA | no two-dimensional scrolling at 320 CSS px wide (§3.3) |
| 1.4.11 Non-text Contrast | AA | 3:1 for UI components and focus indicators (§3.3) |
| 1.4.12 Text Spacing | AA | no loss at line-height 1.5 / letter .12em / word .16em (§3.3) |
| 2.1.1 Keyboard | A | the smoke suite's keyboard pass: a target Tab cannot reach. *"All functionality of the content is operable through a keyboard interface without requiring specific timings for individual keystrokes, except where the underlying function requires input that depends on the path of the user's movement and not just the endpoints."* https://www.w3.org/WAI/WCAG22/Understanding/keyboard.html |
| 2.1.2 No Keyboard Trap | A | the smoke suite's modal check: Escape must leave a dialog Tab stays in. *"If keyboard focus can be moved to a component of the page using a keyboard interface, then focus can be moved away from that component using only a keyboard interface, and, if it requires more than unmodified arrow or tab keys or other standard exit methods, the user is advised of the method for moving focus away."* https://www.w3.org/WAI/WCAG22/Understanding/no-keyboard-trap.html |
| 2.4.3 Focus Order | A | the smoke suite reports a backward jump in tab order for a human, never as a failure: whether it keeps meaning is a judgement. *"If a web page can be navigated sequentially and the navigation sequences affect meaning or operation, focusable components receive focus in an order that preserves meaning and operability."* https://www.w3.org/WAI/WCAG22/Understanding/focus-order.html |
| 2.4.7 Focus Visible | AA | every keyboard stop shows focus (§3.3) |
| 2.4.11 Focus Not Obscured (Minimum) | AA, new in 2.2 | focused component not entirely hidden by author content (§3.3) |
| 2.5.5 Target Size (Enhanced) | AAA | 44×44 — the enhanced bar, never the requirement (§6) |
| 2.5.8 Target Size (Minimum) | AA, new in 2.2 | 24×24 CSS px, with spacing/equivalent/inline exceptions (§3.2, §6) |
| 3.2.4 Consistent Identification | AA | same function identified consistently — one enum, one badge colour (§4) |
| 3.3.1 Error Identification | A | the smoke suite's form cases: the field in error is identified, in text. *"If an input error is automatically detected, the item that is in error is identified and the error is described to the user in text."* https://www.w3.org/WAI/WCAG22/Understanding/error-identification.html |
| 4.1.2 Name, Role, Value | A | the smoke suite's names check: every action target has an accessible name. *"For all user interface components (including but not limited to: form elements, links and components generated by scripts), the name and role can be programmatically determined; states, properties, and values that can be set by the user can be programmatically set; and notification of changes to these items is available to user agents, including assistive technologies."* https://www.w3.org/WAI/WCAG22/Understanding/name-role-value.html |
| 4.1.3 Status Messages | AA | the smoke suite's toast check: a status message lives in a live region. *"In content implemented using markup languages, status messages can be programmatically determined through role or properties such that they can be presented to the user by assistive technologies without receiving focus."* https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html |

## Usability and workflow soundness — the journey lane's grounding set

Cited as **advice** beside the measured number, never as the verdict: a journey finding's class and severity come from its oracle (`argus-live.mjs classify`, journeys.md), and a heuristic finding with no written rule goes to the owner.

| Use it for | Source |
|---|---|
| Nielsen's ten usability heuristics, cited by number and name: 1 Visibility of System Status · 2 Match Between the System and the Real World · 3 User Control and Freedom · 4 Consistency and Standards · 5 Error Prevention · 6 Recognition Rather than Recall · 7 Flexibility and Efficiency of Use · 8 Aesthetic and Minimalist Design · 9 Help Users Recognize, Diagnose, and Recover from Errors · 10 Help and Documentation. *"They are called heuristics because they are broad rules of thumb and not specific usability guidelines."* | Nielsen, NN/g — https://www.nngroup.com/articles/ten-usability-heuristics/ |
| A usability problem's severity as frequency, impact and persistence, and the 0–4 scale (*"4 = Usability catastrophe: imperative to fix this before product can be released"*): recorded as measurements, never as the issue's severity | Nielsen, NN/g — https://www.nngroup.com/articles/how-to-rate-the-severity-of-usability-problems/ |
| The cognitive walkthrough behind the explorer's `cw` rows, one question per row: *"Will users be trying to produce whatever effect the action has?"* · *"Will users see the control (button, menu, switch, etc.) for the action?"* · *"Once users find the control, will they recognize that it produces the effect they want?"* · *"After the action is taken, will users understand the feedback they get, so they can go on to the next action with confidence?"* | Lewis and Rieman, *Task-Centered User Interface Design*, chapter 4 — https://hcibib.org/tcuid/chap-4.html |
| Workflow-net soundness, the ground of the dead-end, orphaned-work and unreachable-step oracles: *"(1) option to complete: for each case it is always still possible to reach the state which just marks place end, (2) proper completion: if place end is marked all other places are empty for a given case, and (3) no dead transitions: it should be possible to execute an arbitrary activity by following the appropriate route through the WF-net."* | van der Aalst, van Hee, ter Hofstede, Sidorova, Verbeek, Voorhoeve, Wynn, *Soundness of Workflow Nets: Classification, Decidability, and Analysis*, Formal Aspects of Computing — https://www.vdaalst.com/publications/p628.pdf |
| Naming a journey's shape (control-flow patterns: Sequence, Parallel Split, Cancel Task) and its allocation (resource patterns: Role-Based Distribution, Separation of Duties, Retain Familiar), by the catalogue's pattern names | Workflow Patterns Initiative (Russell, ter Hofstede, van der Aalst and others) — http://www.workflowpatterns.com/patterns/control/ · http://www.workflowpatterns.com/patterns/resource/ (plain http: the site answers no https) |

## Fraud, internal control, insider threat

| Use it for | Source |
|---|---|
| The scheme taxonomy used in fraud.md §5–6 (skimming vs cash larceny turns on whether the money was recorded first; noncash → false sales and shipping; billing → shell company; check and payment tampering → altered payee) | ACFE Fraud Tree — https://www.acfe.com/-/media/files/acfe/pdfs/rttn/2024/the-fraud-tree-2025.pdf |
| ⚠ **Frequencies, median losses, velocities, detection latencies, collusion and override rates.** The 2026 RTTN PDF exceeds the fetch size limit and is **not read here**, so every figure attributed to it is UNVERIFIED. Fetch it and quote what you read | https://www.acfe.com/-/media/files/acfe/pdfs/rttn/2026/2026-report-to-the-nations.pdf · press release (verified, case count) https://www.acfe.com/about-the-acfe/newsroom-for-media/press-releases/press-release-detail?s=occupational-fraud-2026-a-report-to-the-nations-pr |
| Separation of duties as a design principle: divide authority, custody and accounting | GAO Green Book (GAO-14-704G) 10.13 — https://www.gao.gov/assets/gao-14-704g.pdf |
| Policy-level SoD is not SoD; privilege creep when people change roles | CERT Common Sense Guide to Mitigating Insider Threats, BP15 — https://www.sei.cmu.edu/documents/619/2022_019_001_886876.pdf |
| The five-step conflict-matrix method behind fraud.md §3 (enumerate activities → classify → matrix → check every cell → remediate) | ISACA, *A Step-by-Step SoD Implementation Guide* — https://www.isaca.org/resources/isaca-journal/issues/2022/volume-5/a-step-by-step-sod-implementation-guide |

## Payments & ledgers — what integrators are told never to assume

| Use it for | Source |
|---|---|
| Idempotency keys: same key + different payload must error, not replay; concurrent same-key requests are not persisted idempotently | Stripe — https://docs.stripe.com/api/idempotent_requests |
| Event ordering is not guaranteed; a stale event can arrive after a newer one | Stripe — https://docs.stripe.com/webhooks |
| The **pull** leg: list events and reprocess those not successfully delivered — a push-only money path has exactly one detector | Stripe — https://docs.stripe.com/webhooks/process-undelivered-events |
| Duplicate webhooks are expected; dedupe on the provider's own event identifier; a slow handler manufactures a retry | Adyen — https://docs.adyen.com/development-resources/webhooks/handle-webhook-events/ |
| A discrepancy needs a durable work-item state (`unreconciled` / `partially_reconciled`), not just an alert | Modern Treasury — https://docs.moderntreasury.com/platform/reference/expected-payment-object |
| Immutability plus a sanctioned offsetting-entry correction path | Modern Treasury — https://www.moderntreasury.com/journal/enforcing-immutability-in-your-double-entry-ledger |
| Conservation arithmetic as the oracle for money and stock. ⚠ re-read the debit-credit page before quoting it — a quote from a summary is easily truncated; paraphrase otherwise | TigerBeetle — https://docs.tigerbeetle.com/reference/transfer/ · https://docs.tigerbeetle.com/concepts/debit-credit/ |

## Analytic rigor — not asserting things that are not true

| Use it for | Source |
|---|---|
| Analysis of Competing Hypotheses and the Key Assumptions Check (SKILL.md §0, CHARTER) | A Tradecraft Primer — https://www.govinfo.gov/content/pkg/GOVPUB-PREX3-PURL-gpo587/pdf/GOVPUB-PREX3-PURL-gpo587.pdf |
| Confirming evidence is usually consistent with several hypotheses; only inconsistent evidence discriminates | Heuer, *Psychology of Intelligence Analysis* — https://ia800501.us.archive.org/23/items/PsychologyOfIntelligenceAnalysis/Psychology_of_Intelligence.pdf |
| Describing source quality is part of the product; confidence and likelihood are separate and never mixed in one sentence | ICD 203 Analytic Standards — https://www.bmbs.org/salamanca/readings/ODNI_ICDs_203-206-208.pdf |
| Findings from automated tools need validation before they are reported; rules of engagement headings for the charter (scope, assumptions and limitations, risks) | NIST SP 800-115 §7.3 — https://nvlpubs.nist.gov/nistpubs/Legacy/SP/nistspecialpublication800-115.pdf |
| Why an agent guesses instead of abstaining unless abstention is explicitly scored as a good outcome | https://arxiv.org/pdf/2509.04664 |
