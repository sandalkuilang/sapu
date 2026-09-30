#!/usr/bin/env bash
# scripts/merge-gate.sh — this repo's merge gate (`gate.merge` in .claude/sapu.json), run by the
# plugin's sapu-merge.sh inside the PR worktree: a clean install, then the full gate
# (manifest validation + every test). Nothing here touches anything outside the worktree.
set -euo pipefail
npm ci --no-audit --no-fund --silent
exec npm run gate
