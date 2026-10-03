# MOMUS reference — per-area checklist, templates, state

Each section says what the area's checks look for; this repo's commands for them are in the profile (`<profiles>/momus.md`, `## Area A`–`## Area I`). Commands are starting points to adapt to what actually matches in the running tree, not output to copy verbatim into a report — §0 rule 2 (SKILL.md in this skill's directory) still applies: never paste a command's output unless you actually ran it this pass. Globs in `--include` are quoted because the user's shell may be zsh (an unquoted `--include=*.ts` aborts with "no matches found").

## §A Tenant-Scope Isolation

- Every data-access call on a model whose rows belong to one tenant.
- For each hit, walk up to the caller: is the tenant id in the `where` clause read from the session/auth context (the scope helper, or the equivalent helper the route already installs) or from request body/params/query? A tenant id in a DTO field is a finding regardless of whether the handler currently ignores it — the tenant-isolation invariant requires it never be readable from the body in the first place, not merely unused.
- Nested relations 2+ hops from the tenant root: does the model at hop 3 (e.g. an order item's price snapshot, an invoice's payment rows) trust the parent's already-filtered tenant id, or does its OWN query re-derive/re-check it? A find-by-id with no tenant filter at any hop below the top is the leak this area exists to catch.
- Object-storage file access: is the URL a raw public key, or generated per-request with a short-lived presigned URL scoped to the requesting session's tenant?

Output table (mandatory): one row per hit — the file:line, the model, whether the tenant filter is present, and where the id comes from; the profile `## Area A` gives the exact (localised) column headers.

- Personal data (the data-protection law the profile names) — which fields exist, who can read them (where role grants live: profile), is the read audited? For each GET route / server-fn that returns one of those fields: is there an audit write on the READ path?

Second table (mandatory when personal data is in scope): one row per personal-data field — the file:line, the field, which roles can read it, and whether the read is audited; headers per the profile `## Area A`.

## §B Authentication & Authorization

- Enumerate every route file and server function — a server-fn that moves state is a map row too.
- For each: does it call the permission guard / scope helper before the handler body runs, or only after some work already happened? A permission check after a DB write already executed is not a guard.
- Cross-check the UI-gating rule: every mutation control in the web app should be wrapped in the SAME permission the backend route enforces (run the repo's gate for it).
- Authentication strength (NIST SP 800-63B-4; targets: profile): every path that mints a session — does each demand the second factor first? Idle / absolute / cookie TTL / step-up window. Cookie flags: Secure, HttpOnly, SameSite, `__Host-` prefix.
- Business-process map (ASVS 2.3.1): every route that changes state, and the services that write a status (last counts: profile). Per row: allowed-previous-state check in the service, the permission guard on the route, actor !== approver, a route test hitting it over HTTP, and — for any cumulative/threshold/uniqueness rule — the bypass-class reading (inside the writer's transaction under a lock or DB constraint? both date directions? re-evaluated at approve/apply? every same-effect endpoint behind the same gate?)

## §C Data & Migrations

- Migration status + schema validation — read-only against whatever the database URL points at.
- Schema/migration drift — the drift check replays every migration into a throwaway shadow DB (test DB only, §G); plus the recent history of the schema file and the newest migrations.
- Destructive migrations: `DROP COLUMN`, `DROP TABLE`, `ALTER COLUMN … TYPE`.
- Business-unique fields enforced only in application code (race-condition surface): list the DB-level unique constraints; then, for a field that SHOULD be there but isn't, grep the service layer for a manual "does this code already exist" check before insert — that's the race.
- Delete behaviour on every relation from a model a top-privilege action can delete.

## §D Error Handling & Information Leakage

- Raw errors reaching the client: catch blocks that neither log nor audit; handlers that send the error object itself.
- Empty catches.
- Multi-step writes with no surrounding transaction — consecutive create/update calls in the same function body not wrapped in one transaction.

For each service file with multiple sequential writes: read whether they share one transaction, and if not, what state a request left mid-sequence would look like (the class in the profile's `## Reference incidents`).

## §E Configuration & Secrets

- Every env var read.
- Which ones have no schema default and would silently misbehave rather than fail-closed if unset (the class the profile's `## Reference incidents` records) — read the env schema and check every optional / no-default field against how its consumer branches.
- Hardcoded secrets — the repo's secrets gate first, then the raw grep for what its patterns miss.
- Was a `.env` ever committed — full history, excluding the files the profile says are committed on purpose (review their diff, do not flag them).
- Dev-vs-production branches that may never have actually run the production branch.
- Deploy config vs CIS Benchmarks — read-only; production state is UNVERIFIED until the pre-release checklist records it: deploy scripts, compose files, the DB privileges that defeat the append-only controls, the audit-trail custody runbook.
- Dependency supply chain: packages with install scripts, the hosts the lockfile resolves from, CVE alerting between merges (an alert feed that is disabled = nobody is told about a new CVE between merges).

## §F Resilience & Silent-Wrong-Number Risk

Code-read (always possible) + live probe (only in `mode=live`, servers up):

- DB drop mid-write: does the write sit inside a transaction, and does the caller handle the rejection, or does it hang/silently half-apply?
- Upload failure partway: does the DB row get created before or after the object-storage upload confirms? A row pointing at a URL that was never actually written is the failure mode to look for.
- Input fuzzing on the main forms the profile names: empty, over-length, negative quantity, future-dated, unusual characters — read the request DTO schema for each field and note which constraints exist vs. which are assumed by the UI only.
- Concurrent edit: is there row-level locking or optimistic versioning, or does the second writer just overwrite the first with no warning?
- **Silently-wrong computed figures** (the profile's list). For each, construct an incomplete-data input (a missing price snapshot, a partial promo window, an order with zero items) and read what the calculation function does — throws, or returns a number that looks plausible and is wrong.

## §G Test Coverage

Test DB only (SKILL.md §7): suite, build and fast gate run with the database URLs pinned inline to a throwaway `*test*` database — the command, and why the explicit URL wins, are in the profile.

Paste all outputs as-run, including every warning line. A runner reporting "No test files found" usually means global setup failed (read stderr), not a clean run. Then, not a coverage percentage: name the core business flows (the profile's list) and state which have zero test coverage — a grep for `describe(` in that domain returning nothing is the signal.

## §H Operational Readiness

- Where logs land and what they contain: log calls that mention an amount, phone, tax or national ID, token or password.
- Security logging (ASVS V16): logins, permission changes, personal-data reads — actor + IP + request id? Count the audit writes in the identity/user modules.
- Test-harness residue (SKILL.md Area H): leaked per-worker databases and buckets — count them read-only (naming patterns and the last count: profile).

Any log hit is a candidate leak — cross-check against the repo's log redactor: a nested key the redactor can't reach is the shape the profile's `## Reference incidents` records. For rollback: the newest migrations — is the most recent one reversible without data loss, and does anything document how to run it backward?

## §I Contracts, Interfaces & Code Health

- (1) Contract drift — producer vs consumer: documented routes vs the route files; a request-DTO file with no strict-mode validation at all is a lead; the i18n and UI-gating gates (paste output; a passing gate whose pattern rotted is the finding, not the pass); each server-fn from §B — does its return shape match the route it mirrors?
- (2) Code health — LOW only: `TODO`/`FIXME`/`XXX` (count only; list the ones that already shipped); comments describing a past state ("no longer", "removed", "deprecated", "used to") — does the code still match?

For each contract candidate, name **both ends** (`file::symbol` producer, `file::symbol` consumer) and the field that disagrees — one end alone is not a break. A comment contradicting the code beside it is filed under (1), not (2). Health findings are one LOW line per family, never one per site.

## Finding template

```
[SEVERITY] [CONFIDENCE] Short title, the symptom not the fix
Location: file:line
Evidence: <verbatim code excerpt or real command output>
Impact: <what the tenant/customer experiences if this happens>
Reproduction: <exact steps or request>
Standard: <ASVS 5.0 ID / NIST SP 800-63B-4 / CIS / data-protection law article — or "—" for a non-security finding>
Attacker: <outsider / insider / —>
Suggested fix: <1–2 sentences, no code>
```

## Filing — GitHub issue template (§5, opt-in only)

```
Title: [MOMUS][<BLOCKER|HIGH|MEDIUM|LOW>] <actor/flow> — <symptom, not the fix>
Labels: momus, severity:s<1-4 per SKILL.md §5 mapping>, found-by:momus

## Summary
## Location — file:line, verbatim code
## Impact — what a tenant/customer experiences
## Reproduction — exact steps
## Evidence — OBSERVED (T1/T2, or explicit UNVERIFIED)
## Confidence — CERTAIN / LIKELY / SUSPECTED, and why
## Standard & attacker — ASVS 5.0 ID(s) / NIST / CIS / data-protection-law article, and outsider or insider (security findings only; their body opens with the securityEpic reference line from the profile `## Security bar` — `securityEpic` null → add the `security` label instead)
## Cross-check against the decision documents — quote what you found, or state you found nothing
## Suggested remediation — 1-2 sentences, no code
```

## `gh` commands

`<repo>` = `github.repo` in `.momus/config.yml`; `<securityEpic>` = `securityEpic` in `.claude/sapu.json`.

```bash
# Dedup — fetch, don't --search (30/min sub-limit silently misses matches). Fetch the WHOLE history:
# on a large tracker a --limit 200 page sees only the newest slice (this repo's size: profile `## Tracker`).
gh api "repos/<repo>/issues?state=all&per_page=100" --paginate \
  --jq '.[] | select(.pull_request | not) | select(((.title // "") + " " + (.body // "")) | test("momus-fp: <area>::<mechanism>|<key words>"; "i")) | {number, author: .user.login}'
# tested inside jq: no title or body is printed. A candidate's title and body only through the trust
# check: exit 1 = an outsider's issue no trusted login accepted — not a duplicate, and not read
node "<plugin root>/scripts/sapu-contract.mjs" issue-trust <N> --text > "$TMPDIR/momus-<N>.json"

# Known security gaps: the open children of the security epic — a match is [TRACKED #NNNN], not new
node "<plugin root>/scripts/sapu-contract.mjs" issue-trust <securityEpic> --text > "$TMPDIR/momus-epic.json"

# Cross-check the sibling skills' own ledgers before filing (gitignored — main checkout only)
cat <main-checkout>/.argus/fingerprints.json
cat <main-checkout>/.nemesis/state/findings.json

# Before the first write: the contract check (SKILL.md §5) — non-zero exit = stop
node "<plugin root>/scripts/sapu-contract.mjs" check   # the exact command in SKILL.md §5, where the plugin root is already filled in
gh issue create --repo <repo> --title "..." --body-file "$TMPDIR/momus-issue.md" \
  --label "momus,severity:s1,found-by:momus"
```

## `.momus/` state

All but `config.yml` are gitignored and live only in the main checkout.

- `config.yml` — tracked (mirrors `.argus/config.yml`'s shape: repo/account, app_under_test, scope, business_truth docs, limits).
- `ledger.json` — one entry per area: `{area, last_audited_commit, last_audited_date, verdict: "clean"|"findings", accepted_deviations: [{mechanism, doc_citation}], fingerprints: [...]}`. Read at ORIENT so a repeat pass knows what was already settled and doesn't re-litigate a documented deviation it already cross-checked once (§0 rule 7) — re-verify it's still accurate against current HEAD, don't just trust the ledger's old quote.
- `run.log` — one line per pass: `<date> pass=<id> mode=<live|static> areas_covered=<A,B,...> areas_deferred=<...> findings=<blocker>/<high>/<medium>/<low> filed=<N or "report-only">`.
- `report-<pass-id>.md` — the §6 report as delivered.
