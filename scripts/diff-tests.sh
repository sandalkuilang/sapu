#!/usr/bin/env bash
# scripts/diff-tests.sh — this repo's `gate.fast` (.claude/sapu.json): the tests the diff touches, never the
# whole suite. tests/engine.test.ts runs only the suites its changed files belong to (`-t`), and
# tests/sapu-merge.test.ts is never run whole (minutes): it names the case to run instead.
# The full suite is the merge gate's (scripts/merge-gate.sh). Run in the worktree; SAPU_BASE = the base branch.
set -euo pipefail
base="origin/${SAPU_BASE:-main}"
changed="$( { git diff --name-only "$base"...HEAD; git diff --name-only HEAD; git ls-files -o --exclude-standard; } | sort -u)"
[ -n "$changed" ] || { echo "diff-tests: no change against $base"; exit 0; }

files=(); eng=(); note=()
has() { grep -Eq "$1" <<<"$changed"; }
add() { case " ${files[*]-} " in *" $1 "*) ;; *) files+=("$1");; esac; }
suite() { eng+=("$1"); }

has '^plugins/sapu/scripts/sapu-guard\.mjs$|^tests/sapu-guard\.test\.ts$' && add tests/sapu-guard.test.ts
has '^plugins/sapu/scripts/sapu-contract\.mjs$|^tests/sapu-contract\.test\.ts$' && add tests/sapu-contract.test.ts
has '^plugins/sapu/workflows/sapu-wave\.js$|^tests/sapu-wave\.test\.ts$' && add tests/sapu-wave.test.ts
has '^plugins/sapu/workflows/inspector\.js$|^tests/inspector\.test\.ts$' && add tests/inspector.test.ts
has '^plugins/sapu/scripts/argus-live[^/]*\.mjs$|^tests/argus-live[^/]*\.test\.ts$' && add tests/argus-live.test.ts
has '^plugins/sapu/scripts/sapu-metrics\.ts$|^tests/sapu-metrics\.test\.ts$' && add tests/sapu-metrics.test.ts
has '^plugins/sapu/scripts/sapu-cleanup\.mjs$|^tests/sapu-cleanup\.test\.ts$' && add tests/sapu-cleanup.test.ts
has '^plugins/sapu/scripts/sapu-merge\.sh$|^tests/sapu-merge\.test\.ts$' && note+=("tests/sapu-merge.test.ts takes minutes whole: run the cases you touched with  npx vitest run tests/sapu-merge.test.ts -t \"<name>\"")

# tests/engine.test.ts: one suite per kind of file (the describe names in that file).
has '^plugins/sapu/(skills|agents)/.*\.md$' && { suite "context budgets"; suite "profile sections"; suite "states no machine-tuned number"; suite "carries no repo history"; suite "are English"; suite "trust commands"; }
has '^plugins/sapu/(\.claude-plugin/|workflows/|hooks/)|^\.claude-plugin/' && suite "manifests"
has '^plugins/sapu/CONTRACT\.md$|^README\.md$|^docs/[^/]*\.md$' && { suite "states no machine-tuned number"; suite "carries no repo history"; suite "are English"; suite "assumes no owner"; }
has '^docs/img/' && { suite "diagram"; suite "a11y"; }
has '^tests/engine\.test\.ts$' && note+=("tests/engine.test.ts changed: also run the cases you added or changed with  npx vitest run tests/engine.test.ts -t \"<name>\"")

[ ${#files[@]} -eq 0 ] || npx vitest run "${files[@]}" 2>&1 | tail -40
if [ ${#eng[@]} -gt 0 ]; then
  re="$(printf '%s\n' "${eng[@]}" | sort -u | paste -sd'|' -)"
  npx vitest run tests/engine.test.ts -t "$re" 2>&1 | tail -20
fi
has '^plugins/|^\.claude-plugin/|^scripts/rule-guard' && node scripts/rule-guard.ts 2>&1 | tail -5
[ ${#note[@]} -eq 0 ] || printf 'diff-tests: %s\n' "${note[@]}"
[ ${#files[@]} -gt 0 ] || [ ${#eng[@]} -gt 0 ] || echo "diff-tests: no test selected for this diff (nothing under plugins/, docs/, README or a mapped test)"
