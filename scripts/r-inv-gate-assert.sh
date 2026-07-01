#!/usr/bin/env bash
# r-inv-gate-assert.sh — security review gate for issue #161 (R-INV
# Critical/High sign-off). Statically asserts that every Critical and High
# R-INV requirement from docs/security/threat-model-user-invites.md is
# discharged by at least one *named, non-skipped* test (`it('... (R-INV-N)'`)
# somewhere in the invite-touching test suites. This is the drift guard: if a
# future change deletes or comments-out the test that proves an invariant
# while leaving the identifier in a stray comment, this script fails instead
# of silently losing coverage.
#
# This assertion is intentionally cheap (no Docker, no DB) so it can gate
# every PR. The invariants themselves are proven by running the real test
# suites (`make node-test` for unit + `pnpm --filter @logalot/control-plane
# test:integration` for the Docker-backed integration suite, both required
# to be green alongside this script — see .github/workflows/ci.yml).
#
# Usage:
#   ./scripts/r-inv-gate-assert.sh [repo-root]
#
# Exit codes:
#   0 — every Critical/High R-INV id has a live discharging test
#   1 — one or more ids has no test (coverage regression / gate failure)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${1:-$(cd "$SCRIPT_DIR/.." && pwd)}"

# Critical: must-pass-or-gate-blocks (spec + threat-model §Rank: Critical).
CRITICAL_IDS=(1 2 3 7 8 15)
# High: must-pass-or-gate-blocks (spec + threat-model §Rank: High).
HIGH_IDS=(4 5 6 10 11 12 13 17)

# Test files that legitimately carry `it('... (R-INV-N)')` discharge markers.
# Grep is restricted to these so an unrelated file mentioning "R-INV-N" in
# prose (e.g. a doc) can't be mistaken for a live test.
TEST_GLOBS=(
  "$REPO_ROOT/services/control-plane/test/unit"
  "$REPO_ROOT/services/control-plane/test/integration"
  "$REPO_ROOT/packages/contracts/src"
  "$REPO_ROOT/apps/web/src"
)

for dir in "${TEST_GLOBS[@]}"; do
  if [[ ! -d "$dir" ]]; then
    echo "ERROR: expected test directory not found: $dir" >&2
    exit 1
  fi
done

pass=0
fail=0

# Returns the count of *enabled* it(...)/test(...) blocks whose title
# contains the given R-INV id, across all TEST_GLOBS. Deliberately excludes
# it.skip / xit / it.todo so a disabled test does not count as coverage.
count_live_tests() {
  local id="$1"
  local total=0
  local hit
  for dir in "${TEST_GLOBS[@]}"; do
    hit=$(grep -rEc "(^|[^.a-zA-Z])it\(['\"].*R-INV-${id}([^0-9]|\$)" "$dir" \
      --include="*.test.ts" --include="*.test.tsx" 2>/dev/null | awk -F: '{s+=$2} END{print s+0}')
    total=$((total + hit))
  done
  echo "$total"
}

assert_discharged() {
  local id="$1"
  local rank="$2"
  local n
  n=$(count_live_tests "$id")
  if [[ "$n" -gt 0 ]]; then
    echo "  PASS: R-INV-${id} ($rank) — ${n} live test(s)"
    ((pass++)) || true
  else
    echo "  FAIL: R-INV-${id} ($rank) — no live 'it(...)' test found" >&2
    ((fail++)) || true
  fi
}

echo "=== R-INV gate: Critical requirements ==="
for id in "${CRITICAL_IDS[@]}"; do
  assert_discharged "$id" "Critical"
done

echo "=== R-INV gate: High requirements ==="
for id in "${HIGH_IDS[@]}"; do
  assert_discharged "$id" "High"
done

echo ""
echo "R-INV gate: ${pass} passed, ${fail} failed"

if [[ "$fail" -gt 0 ]]; then
  echo "FAIL: one or more Critical/High R-INV requirements has no live discharging test — merge gate blocked." >&2
  exit 1
fi

echo "PASS: every Critical/High R-INV requirement is discharged by a live, named test."
