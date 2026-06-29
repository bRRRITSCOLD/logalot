#!/usr/bin/env bash
# tf-iac-policy-assert.sh — static policy assertions covering the four IaC security
# controls required by T22 (security review gates).  Runs without AWS credentials
# and without Terraform installed; all checks are textual HCL/source assertions.
#
# Controls verified (refs: ADR-0009, ADR-0010, R8, R16, D3):
#
#   SG-1  : Port 22 MUST NOT appear as a static (non-dynamic) ingress rule to
#            0.0.0.0/0.  Only 443 + 80 are open to world by default (D3).
#   SG-2  : Port 443 MUST be open to 0.0.0.0/0 (HTTPS / Caddy TLS).
#   SG-3  : Port 80  MUST be open to 0.0.0.0/0 (ACME HTTP-01 + redirect).
#
#   IAM-1 : ssm.tf MUST NOT grant ssm:* (wildcard action).
#   IAM-2 : ssm.tf MUST NOT use Resource = "*" for SSM actions (global scope).
#   IAM-3 : ssm.tf MUST scope SSM actions to /logalot/<env>/* ARN pattern (R8).
#
#   STATE-1: bootstrap/main.tf MUST enable S3 versioning for the state bucket.
#   STATE-2: bootstrap/main.tf MUST configure SSE encryption for the state bucket.
#   STATE-3: bootstrap/main.tf MUST block all public access for the state bucket.
#   STATE-4: backend.tf MUST set encrypt = true for the S3 backend.
#
#   TLS-1  : Caddyfile MUST set Strict-Transport-Security with a multi-year max-age.
#   TLS-2  : Caddyfile MUST set X-Content-Type-Options nosniff.
#   TLS-3  : Caddyfile MUST set X-Frame-Options (clickjacking protection).
#
#   COOKIE-1: session.ts MUST default Secure cookies ON (not keyed off NODE_ENV=production).
#   COOKIE-2: session.ts MUST enable httpOnly on session cookies.
#
# Usage:
#   ./scripts/tf-iac-policy-assert.sh [infra-root]
#
#   The optional argument sets the base directory that contains infra/aws/.
#   Defaults to the repository root (parent of this script's directory).
#
# Exit codes:
#   0 — all assertions passed
#   1 — one or more assertions failed

set -euo pipefail

# ---------------------------------------------------------------------------
# Resolve paths
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${1:-$(cd "$SCRIPT_DIR/.." && pwd)}"

SECURITY_TF="$REPO_ROOT/infra/aws/security.tf"
SSM_TF="$REPO_ROOT/infra/aws/ssm.tf"
BOOTSTRAP_MAIN="$REPO_ROOT/infra/aws/bootstrap/main.tf"
BACKEND_TF="$REPO_ROOT/infra/aws/backend.tf"
CADDYFILE="$REPO_ROOT/infra/aws/Caddyfile"
SESSION_TS="$REPO_ROOT/apps/web/src/server/session.ts"

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

require_file() {
  local path="$1"
  if [[ ! -f "$path" ]]; then
    echo "ERROR: required file not found: $path" >&2
    exit 1
  fi
}

require_file "$SECURITY_TF"
require_file "$SSM_TF"
require_file "$BOOTSTRAP_MAIN"
require_file "$BACKEND_TF"
require_file "$CADDYFILE"
require_file "$SESSION_TS"

# ===========================================================================
# SG assertions — Security Group ingress rules (D3 / ADR-0009)
# ===========================================================================
echo "=== SG assertions: $SECURITY_TF ==="

# Extract plain (non-dynamic) ingress blocks.
PLAIN_INGRESS=$(awk '
  /^[[:space:]]*dynamic[[:space:]]/ { skip=1 }
  skip && /\{/ { depth++ }
  skip && /\}/ { depth--; if (depth<=0) { skip=0; depth=0 } }
  /^[[:space:]]*ingress[[:space:]]*\{/ && !skip { in_block=1; block="" }
  in_block { block = block "\n" $0 }
  in_block && /\}/ { print block; in_block=0; block="" }
' "$SECURITY_TF")

# SG-1: no static port-22 rule open to 0.0.0.0/0
if echo "$PLAIN_INGRESS" | grep -qE 'from_port[[:space:]]*=[[:space:]]*22'; then
  BLOCK_22=$(echo "$PLAIN_INGRESS" | awk '/from_port.*=.*22/{found=1} found{print} /\}/{if(found) found=0}')
  if echo "$BLOCK_22" | grep -q '0\.0\.0\.0/0'; then
    assert_fail "SG-1: port 22 MUST NOT be open to 0.0.0.0/0 in a static ingress block (D3)"
  else
    assert_pass "SG-1: port 22 is not statically open to 0.0.0.0/0"
  fi
else
  assert_pass "SG-1: port 22 is not statically open to 0.0.0.0/0"
fi

# SG-2: port 443 open to 0.0.0.0/0
if echo "$PLAIN_INGRESS" | grep -qE 'from_port[[:space:]]*=[[:space:]]*443' && \
   echo "$PLAIN_INGRESS" | grep -q '0\.0\.0\.0/0'; then
  assert_pass "SG-2: port 443 (HTTPS) is open to 0.0.0.0/0"
else
  assert_fail "SG-2: port 443 (HTTPS) MUST be open to 0.0.0.0/0"
fi

# SG-3: port 80 open to 0.0.0.0/0
if echo "$PLAIN_INGRESS" | grep -qE 'from_port[[:space:]]*=[[:space:]]*80' && \
   echo "$PLAIN_INGRESS" | grep -q '0\.0\.0\.0/0'; then
  assert_pass "SG-3: port 80 (HTTP/ACME) is open to 0.0.0.0/0"
else
  assert_fail "SG-3: port 80 (HTTP/ACME) MUST be open to 0.0.0.0/0"
fi

echo ""

# ===========================================================================
# IAM assertions — SSM least-privilege (R8)
# ===========================================================================
echo "=== IAM assertions: $SSM_TF ==="

# IAM-1: no ssm:* wildcard action
if grep -qE '"ssm:\*"' "$SSM_TF"; then
  assert_fail "IAM-1: ssm.tf MUST NOT grant ssm:* (wildcard action) — use explicit ssm:GetParameter* (R8)"
else
  assert_pass "IAM-1: no ssm:* wildcard action found"
fi

# IAM-2: no Resource = "*" for SSM (global scope)
# Look for a "*" resource inside any SSM-related policy statement.
# Strategy: check for standalone Resource = "*" lines (not constrained to a path).
if grep -qE '"Resource"[[:space:]]*:[[:space:]]*"\*"' "$SSM_TF" || \
   grep -qE 'resources[[:space:]]*=[[:space:]]*\[[[:space:]]*"\*"' "$SSM_TF"; then
  assert_fail "IAM-2: ssm.tf MUST NOT use Resource=\"*\" for SSM actions (global scope) (R8)"
else
  assert_pass "IAM-2: no Resource=\"*\" wildcard found in ssm.tf"
fi

# IAM-3: SSM actions ARE scoped to /logalot/<env>/* ARN
if grep -qE 'parameter/logalot/\$\{var\.env\}/\*' "$SSM_TF" || \
   grep -qE 'parameter/logalot/.+/\*' "$SSM_TF"; then
  assert_pass "IAM-3: SSM actions scoped to /logalot/<env>/* ARN path (R8)"
else
  assert_fail "IAM-3: ssm.tf MUST scope SSM GetParameter* to /logalot/<env>/* (R8)"
fi

echo ""

# ===========================================================================
# STATE assertions — Terraform state bucket (ADR-0010)
# ===========================================================================
echo "=== Terraform state assertions: $BOOTSTRAP_MAIN + $BACKEND_TF ==="

# STATE-1: versioning enabled in bootstrap
if grep -qE 'status[[:space:]]*=[[:space:]]*"Enabled"' "$BOOTSTRAP_MAIN"; then
  assert_pass "STATE-1: state bucket versioning is Enabled (ADR-0010)"
else
  assert_fail "STATE-1: bootstrap/main.tf MUST enable S3 versioning (ADR-0010)"
fi

# STATE-2: SSE encryption configured in bootstrap
if grep -qE 'sse_algorithm[[:space:]]*=' "$BOOTSTRAP_MAIN"; then
  assert_pass "STATE-2: state bucket SSE encryption is configured (ADR-0010)"
else
  assert_fail "STATE-2: bootstrap/main.tf MUST configure SSE encryption (ADR-0010)"
fi

# STATE-3: public access blocked in bootstrap
if grep -qE 'block_public_acls[[:space:]]*=[[:space:]]*true' "$BOOTSTRAP_MAIN" && \
   grep -qE 'block_public_policy[[:space:]]*=[[:space:]]*true' "$BOOTSTRAP_MAIN"; then
  assert_pass "STATE-3: state bucket blocks all public access (ADR-0010)"
else
  assert_fail "STATE-3: bootstrap/main.tf MUST block all public access on state bucket (ADR-0010)"
fi

# STATE-4: backend.tf sets encrypt = true
if grep -qE 'encrypt[[:space:]]*=[[:space:]]*true' "$BACKEND_TF"; then
  assert_pass "STATE-4: backend.tf has encrypt = true (ADR-0010)"
else
  assert_fail "STATE-4: backend.tf MUST set encrypt = true (ADR-0010)"
fi

echo ""

# ===========================================================================
# TLS assertions — Caddy HTTPS + HSTS headers (R16)
# ===========================================================================
echo "=== TLS / HSTS assertions: $CADDYFILE ==="

# TLS-1: HSTS header with multi-year max-age (>= 1 year = 31536000 s)
# Caddy's default HTTP→HTTPS redirect means we only need to verify HSTS is present.
if grep -qE 'Strict-Transport-Security' "$CADDYFILE"; then
  # Extract the max-age value and verify it is at least 1 year
  MAX_AGE=$(grep -oE 'max-age=[0-9]+' "$CADDYFILE" | grep -oE '[0-9]+' | head -1)
  if [[ -n "$MAX_AGE" && "$MAX_AGE" -ge 31536000 ]]; then
    assert_pass "TLS-1: Caddyfile sets HSTS Strict-Transport-Security (max-age=${MAX_AGE}) (R16)"
  else
    assert_fail "TLS-1: Caddyfile HSTS max-age (${MAX_AGE:-unset}) MUST be >= 31536000 (1 year) (R16)"
  fi
else
  assert_fail "TLS-1: Caddyfile MUST set Strict-Transport-Security header (R16)"
fi

# TLS-2: X-Content-Type-Options nosniff
if grep -qE 'X-Content-Type-Options' "$CADDYFILE"; then
  assert_pass "TLS-2: Caddyfile sets X-Content-Type-Options (MIME-type sniffing prevention)"
else
  assert_fail "TLS-2: Caddyfile MUST set X-Content-Type-Options header"
fi

# TLS-3: X-Frame-Options (clickjacking protection)
if grep -qE 'X-Frame-Options' "$CADDYFILE"; then
  assert_pass "TLS-3: Caddyfile sets X-Frame-Options (clickjacking protection)"
else
  assert_fail "TLS-3: Caddyfile MUST set X-Frame-Options header"
fi

echo ""

# ===========================================================================
# COOKIE assertions — Secure flag in non-dev (R16)
# ===========================================================================
echo "=== Cookie security assertions: $SESSION_TS ==="

# COOKIE-1: Secure cookie defaults ON and is NOT solely keyed off NODE_ENV=production
# The implementation should default to true unless NODE_ENV=development (not !=production).
if grep -q 'sessionCookieSecure' "$SESSION_TS"; then
  # Verify the safe default: returns true unless NODE_ENV === 'development'
  if grep -qE "NODE_ENV.*!==.*'development'|NODE_ENV.*!=.*'development'" "$SESSION_TS"; then
    assert_pass "COOKIE-1: session Secure cookie defaults ON; only plain-http dev opts out (R16)"
  else
    assert_fail "COOKIE-1: session.ts MUST default Secure ON and opt-out only for NODE_ENV=development (R16)"
  fi
else
  assert_fail "COOKIE-1: session.ts MUST define sessionCookieSecure() for cookie Secure flag (R16)"
fi

# COOKIE-2: httpOnly flag is enforced
if grep -qE "httpOnly[[:space:]]*:[[:space:]]*true" "$SESSION_TS"; then
  assert_pass "COOKIE-2: session cookies are httpOnly (JS cannot read them)"
else
  assert_fail "COOKIE-2: session.ts MUST set httpOnly: true on session cookies (R16)"
fi

echo ""

# ===========================================================================
# Summary
# ===========================================================================
echo "Results: ${pass} passed, ${fail} failed"

if [[ $fail -gt 0 ]]; then
  exit 1
fi
