#!/usr/bin/env bash
# /root/agents/pre-commit-check.sh
#
# Shared check script — runs full test suite + verify-framework gates.
# Called by git pre-commit hooks AND manually (`bash /root/agents/pre-commit-check.sh`).
#
# Fails fast on first issue so commits don't land with regressions.
# Exit 0 = safe to commit. Non-zero = block.

set -u # strict unset — but NOT -e (we want to emit our own error messages)

AGENTS_DIR="/root/agents"
START=$(date +%s)

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
red()  { printf '\033[31m%s\033[0m\n' "$1"; }
green(){ printf '\033[32m%s\033[0m\n' "$1"; }
dim()  { printf '\033[2m%s\033[0m\n' "$1"; }

bold "════════════════════════════════════════════════════════════════════"
bold " Kurukshetra pre-commit check"
bold "════════════════════════════════════════════════════════════════════"

# 1. Unit tests
dim "[1/2] Running unit tests (all *.test.js)..."
if ! node "${AGENTS_DIR}/test/run-all.js" > /tmp/pre-commit-tests.log 2>&1; then
  red  "✗ Unit tests FAILED"
  tail -30 /tmp/pre-commit-tests.log
  red  "Fix the failing tests before committing."
  exit 1
fi
PASS_COUNT=$(grep -c '^  ✓' /tmp/pre-commit-tests.log || echo 0)
green "✓ Unit tests green (${PASS_COUNT} assertions)"

# 2. Verify-framework gates
dim "[2/2] Running verify-framework (all gates)..."
if ! node "${AGENTS_DIR}/verify-framework.js" > /tmp/pre-commit-verify.log 2>&1; then
  red  "✗ verify-framework FAILED"
  tail -30 /tmp/pre-commit-verify.log
  red  "One or more invariants violated. Run: node ${AGENTS_DIR}/verify-framework.js"
  exit 1
fi
GATE_RESULT=$(grep '^RESULT:' /tmp/pre-commit-verify.log | head -1)
green "✓ ${GATE_RESULT}"

END=$(date +%s)
DUR=$((END - START))
bold  "════════════════════════════════════════════════════════════════════"
green "✓ ALL CHECKS PASSED (${DUR}s) — safe to commit"
bold  "════════════════════════════════════════════════════════════════════"
exit 0
