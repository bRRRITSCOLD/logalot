#!/usr/bin/env bash
# tf-sg-policy-assert.sh — static policy assertions on the Terraform security-group
# definition (security.tf). Runs without AWS credentials; parses HCL with grep/awk.
#
# Assertion contract (ADR-0009):
#   PASS 1 — port 22 MUST NOT appear as a static (non-dynamic) ingress rule.
#   PASS 2 — port 443 MUST appear as an open ingress rule (0.0.0.0/0).
#   PASS 3 — port 80  MUST appear as an open ingress rule (0.0.0.0/0).
#
# These checks are intentionally conservative textual assertions on the source HCL,
# not a live plan, so they can run in CI without AWS access.
#
# Usage:
#   ./scripts/tf-sg-policy-assert.sh [path/to/security.tf]
#
# Exit codes:
#   0 — all assertions passed
#   1 — one or more assertions failed

set -euo pipefail

SECURITY_TF="${1:-infra/aws/security.tf}"

if [[ ! -f "$SECURITY_TF" ]]; then
  echo "ERROR: file not found: $SECURITY_TF" >&2
  exit 1
fi

pass=0
fail=0

assert_pass() {
  local desc="$1"
  echo "  PASS: $desc"
  ((pass++)) || true
}

assert_fail() {
  local desc="$1"
  echo "  FAIL: $desc" >&2
  ((fail++)) || true
}

echo "=== SG policy assertions: $SECURITY_TF ==="

# ---------------------------------------------------------------------------
# Assertion 1: no static ingress rule for port 22 to 0.0.0.0/0
# ---------------------------------------------------------------------------
# The dynamic block for SSH wraps port 22 in a for_each, so it never appears
# as a plain ingress{} block with from_port = 22 alongside cidr_blocks = ["0.0.0.0/0"].
# We detect an unsafe rule as: any ingress block that has BOTH "22" (from/to port)
# AND "0.0.0.0/0" without being inside a `dynamic` wrapper.
#
# Strategy: extract each non-dynamic ingress block and check for the combination.

# Use awk to extract content of plain ingress { } blocks (not inside dynamic { })
PLAIN_INGRESS=$(awk '
  /^[[:space:]]*dynamic[[:space:]]/ { skip=1 }
  skip && /\{/ { depth++ }
  skip && /\}/ { depth--; if (depth<=0) { skip=0; depth=0 } }
  /^[[:space:]]*ingress[[:space:]]*\{/ && !skip { in_block=1; block="" }
  in_block { block = block "\n" $0 }
  in_block && /\}/ { print block; in_block=0; block="" }
' "$SECURITY_TF")

if echo "$PLAIN_INGRESS" | grep -qE 'from_port[[:space:]]*=[[:space:]]*22' ; then
  # Found a plain ingress with port 22 — check if it also has 0.0.0.0/0
  BLOCK_22=$(echo "$PLAIN_INGRESS" | awk '/from_port.*=.*22/{found=1} found{print} /\}/{if(found) found=0}')
  if echo "$BLOCK_22" | grep -q '0\.0\.0\.0/0'; then
    assert_fail "Port 22 must NOT be open to 0.0.0.0/0 in a static ingress block"
  else
    assert_pass "Port 22 is not open to 0.0.0.0/0 in any static ingress block"
  fi
else
  assert_pass "Port 22 is not open to 0.0.0.0/0 in any static ingress block"
fi

# ---------------------------------------------------------------------------
# Assertion 2: port 443 is open to 0.0.0.0/0
# ---------------------------------------------------------------------------
if echo "$PLAIN_INGRESS" | grep -qE 'from_port[[:space:]]*=[[:space:]]*443' && \
   echo "$PLAIN_INGRESS" | grep -q '0\.0\.0\.0/0'; then
  assert_pass "Port 443 (HTTPS) is open to 0.0.0.0/0"
else
  assert_fail "Port 443 (HTTPS) MUST be open to 0.0.0.0/0"
fi

# ---------------------------------------------------------------------------
# Assertion 3: port 80 is open to 0.0.0.0/0
# ---------------------------------------------------------------------------
if echo "$PLAIN_INGRESS" | grep -qE 'from_port[[:space:]]*=[[:space:]]*80' && \
   echo "$PLAIN_INGRESS" | grep -q '0\.0\.0\.0/0'; then
  assert_pass "Port 80 (HTTP/ACME) is open to 0.0.0.0/0"
else
  assert_fail "Port 80 (HTTP/ACME) MUST be open to 0.0.0.0/0"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "Results: ${pass} passed, ${fail} failed"

if [[ $fail -gt 0 ]]; then
  exit 1
fi
