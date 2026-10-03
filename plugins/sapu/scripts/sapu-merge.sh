#!/usr/bin/env bash
# sapu-merge.sh — one-command merge for a reviewed PR (sapu skill, SKILL.md §A5), in any repo
# with a sapu contract (.claude/sapu.json, see CONTRACT.md).
#
# WHY THIS EXISTS. Merging one PR by hand was ~15-20 orchestrator steps, and every step
# re-sends the whole orchestrator context (hundreds of thousands of tokens late in a session). This script
# performs the exact same checks in one process. It weakens NOTHING: the repo's merge gate
# (`gate.merge`) still runs at the PR tip, a red gate never merges, and the A3.5 review
# comment is still mandatory.
#
# USAGE (from the main checkout or any of its worktrees)
#   sapu-merge.sh <PR> <review-comment-file> [--workers N] [--dry-run]
#
#   <review-comment-file>  the A3.5 review summary; must contain the literal heading
#                          "Notes (recorded, not filed)". The gate summary is appended to a
#                          COPY of it before it is posted (the input file is not modified).
#   --workers N            passed to the gate as SAPU_WORKERS (default 8; use 4 while another
#                          worker is running tests).
#   --dry-run              run the read-only checks (contract, scope lock, comment
#                          heading, PR lookup, trust, worktree resolution) and print the plan; no
#                          side effects besides fetching origin/<base>, which the checks read.
#
# TRUST. A public repo takes PRs from anyone, and the gate runs the PR's code on this machine. So
# before anything touches the PR (child retargeting, worktree, fetch of its head, gate, merge) —
# in --dry-run too — `sapu-contract.mjs pr-trust` must pass it (the one implementation of the PR
# rules, CONTRACT.md §Trusted authors): not from a fork; its author, and every author of every
# commit, a trusted id (no GitHub account = gitEmail only); with requireSignedCommits, every commit
# signed by a trusted id; every issue it closes or refs passing `issue-trust`. After the fetch,
# origin's head must be the head that verdict read.
#
# EXIT: 0 = merged (or dry-run plan clean); 2 = gate red; 3 = merged, but mergeAfter failed
# (fix what it reported before the next merge); other non-zero = stopped, one-line reason on
# stderr — including a gate that exits 75 (EX_TEMPFAIL: it could not even start, not a PR
# defect). On a red gate the worktree is KEPT for diagnosis, and `mergeAfter` decides what else
# it keeps.
#
# SAFETY. In <MAIN> only `git merge --ff-only origin/<base>`, after a merge, on the base branch,
# with a clean tree; never checkout/pull/stash/reset there. Uses only the existing gh/git
# credentials. This script is the backstop against tampering (the guard hook only catches honest
# mistakes): it trusts nothing local. The contract is read from a FRESHLY FETCHED origin/<base>,
# and the repo file a contract command runs (a relative first word with a `/`, or an interpreter's
# script word) must be byte-identical in <MAIN> to origin/<base>'s blob (git hash-object --no-filters, so
# skip-worktree, assume-unchanged or a local commit cannot hide a change) — or, when origin has no
# such file yet, the PR's copy runs. So neither a PR nor another session can relax the hooks that
# judge it; <MAIN>'s own refs and index are never consulted for that.
set -euo pipefail

HEADING="Notes (recorded, not filed)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

die() { printf 'sapu-merge: %s\n' "$*" >&2; exit 1; }
say() { printf 'sapu-merge: %s\n' "$*" >&2; }

# --- args ---------------------------------------------------------------------------------
PR=""; COMMENT_FILE=""; WORKERS=8; DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --workers) [ $# -ge 2 ] || die "--workers needs a value"; WORKERS="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,45p' "$0"; exit 0 ;;
    -*) die "unknown flag $1" ;;
    *) if [ -z "$PR" ]; then PR="$1"; elif [ -z "$COMMENT_FILE" ]; then COMMENT_FILE="$1"; else die "unexpected argument $1"; fi; shift ;;
  esac
done
[ -n "$PR" ] && [ -n "$COMMENT_FILE" ] || die "usage: sapu-merge.sh <PR> <review-comment-file> [--workers N] [--dry-run]"
case "$PR" in ''|*[!0-9]*) die "PR must be a number, got '$PR'" ;; esac
case "$WORKERS" in ''|*[!0-9]*) die "--workers must be a number" ;; esac
[ "$WORKERS" -ge 1 ] || die "--workers must be >= 1"
command -v jq >/dev/null || die "jq is required"

BLOCKERS=0
# In a dry run a failed check is reported and counted instead of aborting, so one run
# shows every problem; a real run aborts on the first.
check_fail() { if [ "$DRY" = 1 ]; then say "WOULD REFUSE: $*"; BLOCKERS=$((BLOCKERS+1)); else die "$*"; fi; }
plan() { [ "$DRY" = 1 ] && printf 'PLAN  %s\n' "$*" >&2 || true; }

# --- contract ---------------------------------------------------------------------------------
# <MAIN> = the first entry of `git worktree list` seen from the cwd (resolved first: the lock lives in its .git).
# awk reads to the end (no `exit`): an early exit would SIGPIPE git, and pipefail would fail the assignment.
MAIN="$(git worktree list --porcelain 2>/dev/null | awk 'NR==1 && $1=="worktree"{sub(/^worktree /,""); print}')"
[ -n "$MAIN" ] && [ -d "$MAIN" ] || die "run this from inside the repo (cannot resolve <MAIN> from git worktree list)"
# Only the base branch's NAME comes from <MAIN>'s own contract. The contract itself is read from a
# freshly fetched origin/<base> (an explicit refspec, so a rewritten fetch config cannot redirect
# it), and origin's contract must name the same base.
BASE="$(cd "$MAIN" && node "$SCRIPT_DIR/sapu-contract.mjs" get baseBranch)" || die "no valid sapu contract in <MAIN> (see above)"
git -C "$MAIN" fetch --quiet --no-tags origin "+refs/heads/$BASE:refs/remotes/origin/$BASE" >/dev/null 2>&1 \
  || die "git fetch of origin/$BASE failed: the contract is read from origin, so no fetch, no merge"
BASE_SHA="$(git -C "$MAIN" rev-parse --verify -q "refs/remotes/origin/$BASE^{commit}")" || die "origin/$BASE missing after fetch"
CONTRACT="$(cd "$MAIN" && node "$SCRIPT_DIR/sapu-contract.mjs" show --ref "$BASE_SHA")" || die "no valid sapu contract on origin/$BASE (see above)"
cget() { printf '%s' "$CONTRACT" | jq -r "$1 // empty"; }
[ "$(cget .baseBranch)" = "$BASE" ] || die "origin/$BASE's contract names base '$(cget .baseBranch)', <MAIN>'s names '$BASE': reconcile them first"
REPO="$(cget .repo)"; GH_USER="$(cget .ghUser)"; GIT_EMAIL="$(cget .gitEmail)"
# origin commits whose files <MAIN>'s copies may equal: the fetched origin/<base>, and after the merge the new one.
TRUSTED=("$BASE_SHA")
GATE_MERGE="$(cget .gate.merge)"; SUMMARY_START="$(cget .gate.summaryStart)"; RED_IF="$(cget .gate.redIf)"
RED_AREAS="$(cget .redAreas)"; MERGE_AFTER="$(cget .mergeAfter)"
L_IN_PROGRESS="$(cget .labels.inProgress)"; L_DONE="$(cget .labels.done)"

CONTRACT_FILE=".claude/sapu.json"

# The index of the word of a contract command that names repo code, or nothing: a relative first
# word with a `/` (`scripts/gate.sh`), or an interpreter's script — its first non-option word
# (node's --import/--require/-r/--loader values skipped, deno/bun `run` skipped) when that is
# relative with a `/`. An absolute first word (`/bin/bash`) runs as-is.
protected_index() { # <words...>
  [ "$#" -gt 0 ] || return 0
  case "$1" in /*) ;; */*) echo 0; return 0 ;; esac
  local prog="${1##*/}" j=1 n=$#
  local -a w=("$@")
  case "$prog" in bash|sh|zsh|dash|node|tsx|python|python3|ruby|perl|deno|bun) ;; *) return 0 ;; esac
  while [ "$j" -lt "$n" ]; do
    case "${w[$j]}" in
      -r|--require|--import|--loader|--experimental-loader) j=$((j+2)); continue ;;
      -*) j=$((j+1)); continue ;;
      run) case "$prog" in deno|bun) j=$((j+1)); continue ;; esac ;;
    esac
    case "${w[$j]}" in /*) ;; */*) echo "$j" ;; esac
    return 0
  done
}

# The repo path a contract command protects (see protected_index), or nothing.
protected_path() { # <command>
  local -a w; local k
  read -r -a w <<<"$1"
  [ "${#w[@]}" -gt 0 ] || return 0
  k="$(protected_index "${w[@]}")"
  [ -z "$k" ] || printf '%s\n' "${w[$k]}"
}

blob_at() { git -C "$MAIN" rev-parse -q --verify "$1:$2" 2>/dev/null; } # <commit> <path>: its blob id
on_origin() { local r; for r in "${TRUSTED[@]}"; do blob_at "$r" "$1" >/dev/null && return 0; done; return 1; }

# Run a contract command (split on whitespace, no shell syntax) with cwd <dir>. Its protected word
# runs <MAIN>'s copy when origin/<base> has that file (main_mismatch proved the copy identical),
# else <fallback>'s copy; with no fallback it does not run (see SAFETY).
run_contract() { # <dir> <fallback-dir or ""> <command> [extra args...]
  local dir="$1" fb="$2" cmd="$3" k; shift 3
  local -a w
  read -r -a w <<<"$cmd"
  k="$(protected_index "${w[@]}")"
  if [ -n "$k" ]; then
    if on_origin "${w[$k]}"; then w[$k]="$MAIN/${w[$k]}"
    elif [ -n "$fb" ]; then say "warning: origin/$BASE has no ${w[$k]} yet; using $fb's copy"; w[$k]="$fb/${w[$k]}"
    else say "${w[$k]} is not on origin/$BASE: not running an unverified copy"; return 127; fi
  fi
  (cd "$dir" && "${w[@]}" "$@")
}

# The files the merge takes from <MAIN> — the contract and every protected word of gate.merge,
# mergeAfter and redAreas — whose content in <MAIN> is not the blob origin/<base> holds,
# comma-separated; empty when all match. Content, not git status: `git hash-object` reads the
# file itself, so skip-worktree, assume-unchanged and a local commit hide nothing. A path origin
# lacks is never run from <MAIN> (run_contract), so it is not compared.
main_mismatch() {
  local -a p=("$CONTRACT_FILE") bad=()
  local c x r have ok
  for c in "$GATE_MERGE" "$MERGE_AFTER" "$RED_AREAS"; do
    [ -n "$c" ] || continue
    x="$(protected_path "$c")"
    [ -z "$x" ] || p+=("$x")
  done
  for x in "${p[@]}"; do
    on_origin "$x" || continue
    # --no-filters: a clean filter (from <MAIN>'s .git/info/attributes + config) could emit origin's blob for any content.
    have="$(git -C "$MAIN" hash-object --no-filters -- "$x" 2>/dev/null || true)"
    ok=0
    for r in "${TRUSTED[@]}"; do
      if [ -n "$have" ] && [ "$have" = "$(blob_at "$r" "$x" || true)" ]; then ok=1; fi
    done
    [ "$ok" = 1 ] || bad+=("$x")
  done
  if [ "${#bad[@]}" -gt 0 ]; then (IFS=,; printf '%s' "${bad[*]}"); fi
}

mismatch_msg() { # <files>
  local hint=""
  if [ "$(git -C "$MAIN" rev-parse HEAD 2>/dev/null)" != "$BASE_SHA" ] && git -C "$MAIN" merge-base --is-ancestor HEAD "$BASE_SHA" 2>/dev/null; then
    hint=" (<MAIN> is behind origin/$BASE: fast-forward it)"
  fi
  printf "<MAIN>'s copy of %s differs from origin/%s%s: the contract and the hooks run from <MAIN> must be exactly what origin/%s holds — restore them before merging (git -C '%s' checkout origin/%s -- <file>)" "$1" "$BASE" "$hint" "$BASE" "$MAIN" "$BASE"
}

# --- shared state + exit trap --------------------------------------------------------------------
LOCK=""; LOCK_HELD=0
AFTER_PENDING=0   # 1 from the moment gate.merge starts until mergeAfter has run once
WT=""; MAIN_OLD_HEAD=""; FF_OK=0; AFTER_FAILED=0

run_after() { # <merged|not-merged>
  AFTER_PENDING=0
  [ -n "$MERGE_AFTER" ] || return 0
  # The gate may have run for minutes: re-check that <MAIN>'s copy is still origin's.
  local bad; bad="$(main_mismatch)"
  if [ -n "$bad" ]; then
    AFTER_FAILED=1
    say "WARNING: mergeAfter NOT run (outcome=$1): $(mismatch_msg "$bad") — then clean up what gate.merge prepared by hand"
    return 0
  fi
  # cwd <MAIN>; a hook <MAIN> does not have yet runs from the PR worktree, which exists on every path here.
  SAPU_PR="$PR" SAPU_MAIN="$MAIN" SAPU_WT="$WT" SAPU_WORKERS="$WORKERS" SAPU_BASE="$BASE" \
    SAPU_OUTCOME="$1" SAPU_FF_OK="$FF_OK" SAPU_MAIN_OLD_HEAD="$MAIN_OLD_HEAD" \
    run_contract "$MAIN" "$WT" "$MERGE_AFTER" || { AFTER_FAILED=1; say "WARNING: mergeAfter ($MERGE_AFTER) failed with outcome=$1 — read its output above"; }
}

on_exit() {
  local rc=$?
  trap - EXIT
  [ "$AFTER_PENDING" = 0 ] || run_after not-merged
  [ "$LOCK_HELD" = 0 ] || rmdir "$LOCK" 2>/dev/null || true
  exit "$rc"
}
trap on_exit EXIT

# One real run at a time (shared resources of the repo's gate, worktrees). The lock is a fixed
# path under <MAIN>/.git — NOT $TMPDIR, which differs between sandboxed and unsandboxed
# processes and would let two runs miss each other.
if [ "$DRY" = 0 ]; then
  LOCK="$MAIN/.git/sapu-merge.lock"
  mkdir "$LOCK" 2>/dev/null || die "another sapu-merge run holds $LOCK. If a previous run was killed (SIGKILL/power loss) and none is active, remove it: rmdir '$LOCK'"
  LOCK_HELD=1
fi

# --- 1. scope lock (contract identity + machine config) + repo scope -------------------------
LOCK_MSG="$(cd "$MAIN" && node "$SCRIPT_DIR/sapu-contract.mjs" check --ref "$BASE_SHA" 2>&1 >/dev/null)" || check_fail "$LOCK_MSG"
ACTIVE="$(gh api user --jq .login 2>/dev/null || true)"
NWO="$(gh repo view "$REPO" --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)"
[ "$NWO" = "$REPO" ] || check_fail "repo resolves to '${NWO:-none}', need $REPO"

# --- 2. review comment (A3.5 may not be skipped) ---------------------------------------------
[ -f "$COMMENT_FILE" ] || check_fail "review comment file not found: $COMMENT_FILE"
if [ -f "$COMMENT_FILE" ] && ! grep -qF "$HEADING" "$COMMENT_FILE"; then
  check_fail "review comment lacks the literal heading '$HEADING' (A3.5 step 4)"
fi

# --- 2b. the contract and its hooks in <MAIN> are exactly origin/<base>'s ----------------------------
MISMATCH="$(main_mismatch)"
[ -z "$MISMATCH" ] || check_fail "$(mismatch_msg "$MISMATCH")"
# Nobody commits in <MAIN>: a commit there that origin lacks is a tamper signal, not work.
if [ "$(git -C "$MAIN" symbolic-ref --quiet --short HEAD 2>/dev/null || true)" = "$BASE" ] && ! git -C "$MAIN" merge-base --is-ancestor HEAD "$BASE_SHA"; then
  check_fail "<MAIN>'s $BASE has local commits origin/$BASE lacks (read them: git -C '$MAIN' log origin/$BASE..HEAD); nothing is ever committed in <MAIN>"
fi

# --- 3. trust + PR facts (see TRUST above) ----------------------------------------------------
# ONE implementation of the PR rules: `sapu-contract.mjs pr-trust`, reading the contract at the
# fetched origin/<base>. It always prints a JSON verdict, and its facts (state, branches, head SHA,
# the issues it closes) are the ones used below — the head is later pinned to that SHA. A refusal is
# final, in --dry-run too, not a blocker collected for the plan: nothing below may touch the PR.
trust_of() { # <PR number>: its pr-trust verdict (JSON), even when the command refuses
  local out
  out="$(cd "$MAIN" && node "$SCRIPT_DIR/sapu-contract.mjs" pr-trust "$1" --ref "$BASE_SHA" 2>/dev/null || true)"
  jq -e 'type == "object"' <<<"$out" >/dev/null 2>&1 && printf '%s' "$out" || printf '{"trusted":false,"rule":"unreadable","reason":"pr-trust printed no verdict"}'
}
PR_JSON="$(trust_of "$PR")"
jget() { printf '%s' "$PR_JSON" | jq -r "$1 // empty"; }
if [ "$(jq -r '.trusted' <<<"$PR_JSON")" != true ]; then
  die "refusing untrusted PR #$PR (rule: $(jget .rule)): $(jget .reason) — never checked out, gated or merged; the owner reviews it by hand"
fi
STATE="$(jget .state)"; HEAD="$(jget .headRefName)"; PR_BASE="$(jget .baseRefName)"
[ -n "$HEAD" ] || die "PR #$PR has no head branch"
# The issues the body closes, relabelled after the merge ('Refs #N' is judged by pr-trust, not relabelled).
ISSUES="$(jq -r '.closes[]?' <<<"$PR_JSON")"
plan "trust OK: author $(jget .author.login) (id $(jget .author.id)), $(jget .commits) commit(s), closes: $(printf '%s' "${ISSUES:-none}" | paste -sd, -), refs: $(jq -r '.refs | map(tostring) | join(",") | if . == "" then "none" else . end' <<<"$PR_JSON")"

[ "$STATE" = "OPEN" ] || check_fail "PR #$PR is $STATE, not OPEN"
[ "$(jget .isDraft)" != "true" ] || check_fail "PR #$PR is a draft"
[ "$PR_BASE" = "$BASE" ] || check_fail "PR #$PR base is '$PR_BASE', not $BASE (retarget/merge parent first)"
case "$HEAD" in "$BASE"|main|master) check_fail "PR head branch is '$HEAD'" ;; esac

# Children stacked on this head: retarget to the base BEFORE merging, else --delete-branch
# closes them permanently (A5 step 0). Only a same-repo child by a trusted author is touched: a fork
# or an outsider's PR aimed at this branch is left alone (--delete-branch closes it) and never
# stops this merge. A list at its limit may be cut short, and a child whose verdict cannot be read
# may be a trusted one: both stop the merge rather than let --delete-branch close a PR unseen.
CHILD_LIMIT=1000
CHILDREN="$(gh pr list --repo "$REPO" --state open --base "$HEAD" --limit "$CHILD_LIMIT" --json number --jq '.[].number' 2>/dev/null)" \
  || die "cannot list the child PRs based on $HEAD"
[ "$(printf '%s\n' $CHILDREN | grep -c . || true)" -lt "$CHILD_LIMIT" ] || die "$CHILD_LIMIT or more child PRs are based on $HEAD: the list may be cut short; retarget them by hand first"
for c in $CHILDREN; do
  CRULE="$(trust_of "$c" | jq -r 'if .trusted == true then "" else (.rule // "unreadable") end')"
  case "$CRULE" in
    fork|author)
      say "not retargeting child PR #$c ($CRULE): not a trusted same-repo PR; --delete-branch closes it"
      continue ;;
    unreadable) die "cannot judge child PR #$c (its pr-trust verdict could not be read): retarget or close it by hand, then run again" ;;
  esac
  plan "gh pr edit $c --base $BASE   (child stacked on $HEAD)"
  [ "$DRY" = 1 ] || gh pr edit "$c" --repo "$REPO" --base "$BASE" >/dev/null || die "could not retarget child PR #$c"
done

# --- 4. worktree resolution ---------------------------------------------------------------------

# Path of the worktree that already holds refs/heads/<HEAD>, if any.
worktree_for_branch() {
  git -C "$MAIN" worktree list --porcelain | awk -v ref="refs/heads/$1" '
    $1=="worktree"{sub(/^worktree /,""); p=$0}
    $1=="branch" && $2==ref && !found {print p; found=1}'
}

WT="$(worktree_for_branch "$HEAD")"
CREATED_WT=0
if [ -n "$WT" ]; then
  [ "$WT" != "$MAIN" ] || check_fail "branch $HEAD is checked out in <MAIN>; refusing to operate there"
  plan "reuse worktree $WT (holds $HEAD)"
  if [ -d "$WT" ] && [ -n "$(git -C "$WT" status --porcelain)" ]; then
    check_fail "worktree $WT is dirty"
  fi
else
  WT="$MAIN/.claude/worktrees/wt-pr-$PR"
  CREATED_WT=1
  plan "git worktree add --no-track $WT from origin/$HEAD"
  # A stale registration is pruned only in a real run; a dry run mutates nothing.
  if [ -e "$WT" ]; then
    if [ "$DRY" = 1 ]; then check_fail "path $WT already exists (a real run would prune stale registrations first)"
    else git -C "$MAIN" worktree prune; [ ! -e "$WT" ] || check_fail "path $WT already exists"; fi
  fi
fi

# --- 5..: everything below has side effects; a dry run stops here with the plan -------------
if [ "$DRY" = 1 ]; then
  plan "git fetch origin $BASE $HEAD; rebase onto origin/$BASE only if every commit origin/$BASE..HEAD is by $GIT_EMAIL, else merge; push only after a green gate (--force-with-lease only after rebase)"
  if [ -n "$RED_AREAS" ]; then plan "red-area check (<MAIN>: $RED_AREAS --ref <sha>): red areas without a 'Review tier: red' first line in the comment = refuse"
  else plan "no red-area classifier in the contract (redAreas: null)"; fi
  plan "gate in $WT: $GATE_MERGE  (env SAPU_PR SAPU_MAIN SAPU_WT SAPU_WORKERS=$WORKERS SAPU_BASE; red = stop, keep worktree; exit 75 = setup failed, stop)"
  plan "(real runs hold a lock dir $MAIN/.git/sapu-merge.lock; a second run dies)"
  plan "green: append gate summary to review comment, gh pr comment, gh pr merge $PR --squash --delete-branch --match-head-commit <gated SHA>"
  plan "relabel issues from every 'Closes/Fixes/Resolves #N[, #M...]' in PR body: $L_IN_PROGRESS -> $L_DONE (Refs #N untouched)"
  plan "after merge: fetch origin $BASE; git -C $MAIN merge --ff-only origin/$BASE ONLY if <MAIN> is on $BASE with a clean tree (else WARNING, continue)"
  if [ -n "$MERGE_AFTER" ]; then plan "mergeAfter once on every exit after the gate started, while $WT still exists: $MERGE_AFTER (SAPU_OUTCOME=merged|not-merged)"; fi
  plan "then remove worktree $WT (merged only)"
  if [ "$BLOCKERS" -gt 0 ]; then say "dry-run: $BLOCKERS problem(s) — a real run would refuse"; exit 1; fi
  say "dry-run OK: PR #$PR head=$HEAD account=$ACTIVE"
  exit 0
fi

# --- identity guard (rebase/merge commits must not carry another identity) ---------------------
[ "$(git -C "$MAIN" config --local user.email || true)" = "$GIT_EMAIL" ] \
  || die "local git user.email is not $GIT_EMAIL (set it in the repo config first)"

git -C "$MAIN" fetch origin "$BASE" "$HEAD" >/dev/null 2>&1 || die "git fetch failed"
git -C "$MAIN" rev-parse --verify -q "refs/remotes/origin/$HEAD" >/dev/null || die "origin/$HEAD missing after fetch"
# The commits the trust check read are the commits gated: a head that moved since is not run.
PR_OID="$(jget .headRefOid)"
[ -n "$PR_OID" ] && [ "$(git -C "$MAIN" rev-parse "refs/remotes/origin/$HEAD")" = "$PR_OID" ] \
  || die "origin/$HEAD is not the head GitHub reported for PR #$PR (${PR_OID:-none}) when its trust was checked: it moved — run again"

if [ "$CREATED_WT" = 1 ]; then
  if git -C "$MAIN" rev-parse --verify -q "refs/heads/$HEAD" >/dev/null; then
    # A local branch exists but is checked out nowhere: reuse only if it holds nothing origin lacks.
    git -C "$MAIN" merge-base --is-ancestor "refs/heads/$HEAD" "refs/remotes/origin/$HEAD" \
      || die "local branch $HEAD has commits not on origin/$HEAD; read them first"
    git -C "$MAIN" worktree add --no-track -B "$HEAD" "$WT" "refs/remotes/origin/$HEAD" >/dev/null 2>&1 || die "worktree add failed"
  else
    git -C "$MAIN" worktree add --no-track -b "$HEAD" "$WT" "refs/remotes/origin/$HEAD" >/dev/null 2>&1 || die "worktree add failed"
  fi
fi
# A pre-existing worktree must match origin (or be ahead of it only by unpushed work we push).
# Behind only is normal: a sapu-wave.js fixer works in its own worktree and pushes HEAD:<branch>,
# leaving the original worker's worktree behind. Catch that up by fast-forward; a worktree with
# commits origin lacks (diverged) holds someone's unpushed work and is never overwritten — except
# this script's own leftover: a red gate keeps the worktree at step 5's local rebase, which is
# pushed only when green. When every commit of it past origin/<base> has a patch-equal twin on
# origin/<HEAD> (`git cherry` prints no `+`) and nothing is uncommitted, restart from origin.
if [ "$CREATED_WT" = 0 ] && ! git -C "$WT" merge-base --is-ancestor "refs/remotes/origin/$HEAD" HEAD \
  && git -C "$WT" diff --quiet HEAD \
  && ! git -C "$WT" cherry "refs/remotes/origin/$HEAD" HEAD "refs/remotes/origin/$BASE" | grep -q '^+'; then
  git -C "$WT" reset -q --hard "refs/remotes/origin/$HEAD" || die "reset of $WT to origin/$HEAD failed"
fi
if [ "$CREATED_WT" = 0 ] && ! git -C "$WT" merge-base --is-ancestor "refs/remotes/origin/$HEAD" HEAD; then
  git -C "$WT" merge-base --is-ancestor HEAD "refs/remotes/origin/$HEAD" \
    || die "worktree $WT has diverged from origin/$HEAD; reconcile by hand"
  git -C "$WT" merge --ff-only "refs/remotes/origin/$HEAD" >/dev/null 2>&1 || die "fast-forward of $WT to origin/$HEAD failed"
fi

# --- 5. sync with origin/<base> ------------------------------------------------------------------------
REBASED=0
# Full refs from here on: a local branch named origin/<x> would shadow the remote-tracking ref.
if ! git -C "$WT" merge-base --is-ancestor "refs/remotes/origin/$BASE" HEAD; then
  OTHERS="$(git -C "$WT" log --format=%ae "refs/remotes/origin/$BASE..HEAD" | sort -u | grep -vxF "$GIT_EMAIL" || true)"
  if [ -z "$OTHERS" ]; then
    git -C "$WT" rebase "refs/remotes/origin/$BASE" >/dev/null 2>&1 || { git -C "$WT" rebase --abort >/dev/null 2>&1 || true; die "rebase onto origin/$BASE conflicted (aborted); resolve by hand"; }
    REBASED=1
  else
    git -C "$WT" merge --no-edit "refs/remotes/origin/$BASE" >/dev/null 2>&1 || { git -C "$WT" merge --abort >/dev/null 2>&1 || true; die "merge of origin/$BASE conflicted (aborted; commits by another author present)"; }
  fi
fi
SHA="$(git -C "$WT" rev-parse HEAD)"
# The lease is origin's head as fetched above, so a push made after the gate still refuses to
# overwrite anything that landed on the branch in the meantime.
LEASE="$(git -C "$MAIN" rev-parse "refs/remotes/origin/$HEAD")"

# The synced commit is pushed only after the gate is green (step 8): the gate is what prepares the
# worktree (dependencies, DB), and a repo pre-push hook that typechecks or tests fails in a worktree
# nothing has prepared yet. The gate runs on the local commit (the red-area check and the gate read
# the shared object store), and the merge is pinned to that same SHA.
push_synced() {
  [ "$SHA" != "$LEASE" ] || return 0
  ACTIVE="$(gh api user --jq .login 2>/dev/null || true)"
  [ "$ACTIVE" = "$GH_USER" ] || die "gh account flipped to '${ACTIVE:-none}' before push"
  # The push output is kept, never discarded: a refusal (a lease that moved, a protected branch, a
  # repo pre-push hook) is otherwise indistinguishable from any other, and the operator has to
  # reproduce it by hand.
  if [ "$REBASED" = 1 ]; then
    PUSH_OUT="$(git -C "$WT" push --force-with-lease="$HEAD:$LEASE" origin "HEAD:refs/heads/$HEAD" 2>&1)" \
      || die "push (force-with-lease) failed: $(printf '%s' "$PUSH_OUT" | tail -n 12)"
  else
    PUSH_OUT="$(git -C "$WT" push origin "HEAD:refs/heads/$HEAD" 2>&1)" || die "push failed: $(printf '%s' "$PUSH_OUT" | tail -n 12)"
  fi
}

# --- 6. red areas need the 🔴 pair (A3 NEEDS-AI) -------------------------------------------------------------
# Fail-closed backstop for the review-tier raise (sapu-wave.js): the diff is classified by the
# repo's own classifier run from <MAIN> (`--ref`: the PR's commits are in the shared object store),
# so a PR cannot relax the rules it is judged by. A PR touching a red area must carry the pair's
# review, whose comment starts with "Review tier: red" (sapu-wave.js writes it; SKILL.md A3.5
# point 4 for Phase A). "Could not classify" refuses the merge.
MISMATCH="$(main_mismatch)"
[ -z "$MISMATCH" ] || die "$(mismatch_msg "$MISMATCH")"
if [ -n "$RED_AREAS" ]; then
  # No fallback to the PR's copy: a classifier origin/<base> lacks means the red areas are unknown.
  RED="$(run_contract "$MAIN" "" "$RED_AREAS" --ref "$SHA" 2>/dev/null | jq -er '.redAreas | join(", ")')" \
    || die "red-area check failed: a PR whose red areas are unknown is not merged"
  # Line 1 only: sapu-wave.js writes it there, and reviewer text further down must not satisfy it.
  # Here-strings, not pipes into `grep -q`: an early-exiting reader SIGPIPEs the writer under pipefail.
  if [ -n "$RED" ] && ! grep -q '^Review tier: red' <<<"$(head -n 1 "$COMMENT_FILE")"; then
    die "PR touches red areas ($RED) but the review comment has no 'Review tier: red' line: it needs the adversarial pair (A3)"
  fi
fi

# --- 7. merge gate ------------------------------------------------------------------------------------------------
LOG="${TMPDIR:-/tmp}/gate-pr$PR.log"
say "gate running at $SHA (workers=$WORKERS) — log: $LOG"
GATE_RC=0
AFTER_PENDING=1
GATE_START=$SECONDS
SAPU_PR="$PR" SAPU_MAIN="$MAIN" SAPU_WT="$WT" SAPU_WORKERS="$WORKERS" SAPU_BASE="$BASE" \
  run_contract "$WT" "$WT" "$GATE_MERGE" >"$LOG" 2>&1 || GATE_RC=$?
# Gate wall-clock goes into the merges log: SKILL.md B3 drops an overlapping wave to one test runner
# when the gate measures more than 50% slower.
GATE_SECS=$((SECONDS - GATE_START))
# 75 (EX_TEMPFAIL) = the gate could not even start (infra, DB setup, a PR that needs a clean
# install first): not a verdict on the PR, so not "GATE RED".
if [ "$GATE_RC" = 75 ]; then
  LAST="$(grep -v '^[[:space:]]*$' "$LOG" | tail -n 1 || true)"
  die "gate setup failed (not a PR defect): ${LAST:-the gate printed nothing} — log: $LOG — worktree $WT kept"
fi
START="$(grep -nE -m1 "$SUMMARY_START" "$LOG" | cut -d: -f1 || true)"
SUMMARY="$([ -n "$START" ] && tail -n "+$START" "$LOG" || true)"
RED=""
[ "$GATE_RC" = 0 ] || RED="gate exited $GATE_RC"
# A summary line matching gate.redIf is red even on exit 0 (e.g. a DB-backed check that skipped).
# A here-string, not `printf | grep -q`: grep -q exits at the first match, and a summary larger
# than the pipe buffer would SIGPIPE printf, fail the pipeline under pipefail, and read as no match.
if [ -n "$RED_IF" ] && grep -qE "$RED_IF" <<<"$SUMMARY"; then RED="${RED:+$RED; }a summary line matches gate.redIf ($RED_IF)"; fi
[ -n "$SUMMARY" ] || RED="${RED:+$RED; }no gate summary in log (gate.summaryStart: $SUMMARY_START)"
if [ -n "$RED" ]; then
  FAILED="$(printf '%s\n' "$SUMMARY" | grep -E "^✗${RED_IF:+|$RED_IF}" | sed 's/ [0-9.]*s.*//' | paste -sd, - || true)"
  say "GATE RED ($RED) failed: ${FAILED:-see log} — log: $LOG — worktree $WT kept"
  exit 2
fi

# --- 8. green: push the synced commit, comment, merge (pinned to the gated SHA), then clean up -------------------------------
push_synced
GATE_LINE="$(printf '%s\n' "$SUMMARY" | grep -E '[0-9]+ passed' | tail -1 || true)"
FULL_COMMENT="$(mktemp "${TMPDIR:-/tmp}/sapu-merge-comment-$PR.XXXXXX")"
{
  cat "$COMMENT_FILE"
  printf '\n\n**Merge gate** (`%s`, workers=%s) at `%s`:\n\n```\n%s\n```\n' "$GATE_MERGE" "$WORKERS" "$SHA" "$SUMMARY"
} >"$FULL_COMMENT"
ACTIVE="$(gh api user --jq .login 2>/dev/null || true)"
[ "$ACTIVE" = "$GH_USER" ] || die "gh account flipped to '${ACTIVE:-none}' before commenting"
gh pr comment "$PR" --repo "$REPO" --body-file "$FULL_COMMENT" >/dev/null || die "gh pr comment failed"
rm -f "$FULL_COMMENT"

# Issues closed by the PR body (ISSUES, read at 3b): every issue number in a Closes/Fixes/Resolves
# list ("Closes #1, #2 and #3"); 'Refs #N' is deliberately not relabelled.

# --match-head-commit: a commit pushed while the gate ran must NOT ride along ungated; if the
# PR head moved, GitHub refuses and the worktree stays for a re-run.
ACTIVE="$(gh api user --jq .login 2>/dev/null || true)"
[ "$ACTIVE" = "$GH_USER" ] || die "gh account flipped to '${ACTIVE:-none}' before merging"
gh pr merge "$PR" --repo "$REPO" --squash --delete-branch --match-head-commit "$SHA" >/dev/null \
  || die "gh pr merge failed (PR head may have moved since $SHA); worktree $WT kept"
# One line per merge that really happened: sapu-metrics --merges-log counts merged PRs from this,
# because a transcript only records the merge commands, not which of them merged.
printf '%s %s %s gate=%ss\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$PR" "$SHA" "$GATE_SECS" >>"$MAIN/.git/sapu-merges.log" 2>/dev/null \
  || say "warning: merged, but could not record it in $MAIN/.git/sapu-merges.log"

RELABELED=""
for i in $ISSUES; do
  if gh issue edit "$i" --repo "$REPO" --remove-label "$L_IN_PROGRESS" --add-label "$L_DONE" >/dev/null 2>&1; then
    RELABELED="$RELABELED #$i"
  else
    say "warning: could not relabel #$i"
  fi
done

# --- 9. post-merge: fast-forward <MAIN>, then the repo's mergeAfter ------------------------------------------------
# A <MAIN> that is never updated drifts behind origin/<base>, and with it whatever the repo builds
# from it. So <MAIN> is fast-forwarded here, but ONLY with --ff-only, ONLY on the base branch,
# and ONLY when its tree is clean: another session may be using it. Anything else is a warning,
# never a die (the PR is already merged), and never a reset/stash/checkout/pull.
# A failed fetch leaves origin/<base> stale, so no fetch = no ff (mergeAfter sees SAPU_FF_OK=0).
FETCH_OK=0
if git -C "$MAIN" fetch --quiet --no-tags origin "+refs/heads/$BASE:refs/remotes/origin/$BASE" >/dev/null 2>&1; then
  FETCH_OK=1
  TRUSTED+=("$(git -C "$MAIN" rev-parse "refs/remotes/origin/$BASE")") # the merged hooks are trusted too
else say "warning: post-merge fetch failed — not fast-forwarding <MAIN>"; fi
MAIN_OLD_HEAD="$(git -C "$MAIN" rev-parse HEAD 2>/dev/null || true)"
MAIN_BRANCH="$(git -C "$MAIN" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
# The PR worktrees under .claude/worktrees/ (this one still exists: mergeAfter runs before it is
# removed) are not <MAIN>'s changes.
MAIN_DIRTY="$(git -C "$MAIN" status --porcelain -- . ':(exclude).claude/worktrees' 2>/dev/null || echo 'status failed')"
if [ "$FETCH_OK" != 1 ]; then
  :
elif [ "$MAIN_BRANCH" != "$BASE" ]; then
  say "WARNING: <MAIN> is on '${MAIN_BRANCH:-a detached HEAD}', not $BASE — not fast-forwarding it"
elif [ -n "$MAIN_DIRTY" ]; then
  say "WARNING: <MAIN> has uncommitted or untracked changes — not fast-forwarding it"
elif ! git -C "$MAIN" merge-base --is-ancestor HEAD "refs/remotes/origin/$BASE"; then
  say "WARNING: <MAIN> has local commits origin/$BASE lacks — not fast-forwarding it (read them: git -C '$MAIN' log origin/$BASE..HEAD)"
elif git -C "$MAIN" merge --ff-only "refs/remotes/origin/$BASE" >/dev/null 2>&1; then
  FF_OK=1
  say "<MAIN> fast-forwarded to origin/$BASE ($(git -C "$MAIN" rev-parse --short HEAD))"
else
  say "WARNING: git merge --ff-only origin/$BASE failed in <MAIN> (diverged?) — left as it was"
fi
run_after merged

# The PR is already merged: a cleanup failure must not skip the report — warn loudly and go on.
# Removed only now, so mergeAfter saw SAPU_WT on this path too.
LEFTOVER=""
if ! git -C "$MAIN" worktree remove --force "$WT" >/dev/null 2>&1; then
  LEFTOVER="$WT"
  say "WARNING: merged, but could not remove worktree $WT — remove it by hand (git worktree remove --force)"
fi
git -C "$MAIN" branch -D "$HEAD" >/dev/null 2>&1 || true # best effort; may be checked out elsewhere

# --- 10. report -------------------------------------------------------------------------------------------------------------------------
printf 'PR #%s merged (squash)\nSHA: %s\nGate: %s\nMerged: yes\nRelabelled %s:%s\n' \
  "$PR" "$SHA" "${GATE_LINE:-$(printf '%s\n' "$SUMMARY" | tail -1)}" "$L_DONE" "${RELABELED:- none}"
[ -z "$LEFTOVER" ] || printf 'WARNING leftover worktree (remove by hand): %s\n' "$LEFTOVER"
[ "$AFTER_FAILED" = 0 ] || { say "merged, but mergeAfter failed: fix what it reported before the next merge"; exit 3; }
