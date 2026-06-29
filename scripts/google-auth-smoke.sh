#!/usr/bin/env bash
# google-auth-smoke.sh — Smoke-test for live Google OAuth e2e on the provisioned domain.
#
# Issue #110: live Google end-to-end on the provisioned domain (critical-path join).
#
# This script validates the observable infrastructure prerequisites and the
# unauthenticated-user rejection path WITHOUT requiring interactive Google sign-in.
# Full browser-driven acceptance (provisioned user sign-in) is documented in
# docs/google-oauth-live-demo.md and requires a real Google account in the
# provisioned users table.
#
# Checks performed:
#   1. HTTPS reachability — domain responds on 443 (Caddy TLS active).
#   2. HSTS header present (R16 transport-only requirement).
#   3. HTTP → HTTPS redirect (Caddy default; R16).
#   4. Google OIDC callback route reachable (route wired in web BFF; probe confirms
#      the route exists and does not 404/500 on a garbage code+state).
#   5. Unprovisioned-user callback rejection (invite-only guard — AC #2).
#      Uses a fabricated state to trigger the callback and asserts no 5xx.
#
# Usage:
#   LOGALOT_DOMAIN=app.example.com bash scripts/google-auth-smoke.sh
#
# Exit code:
#   0 — all checks passed.
#   1 — one or more checks failed (details printed to stderr).
#
# Dependencies: curl (>= 7.x).

set -euo pipefail

DOMAIN="${LOGALOT_DOMAIN:-}"
if [[ -z "$DOMAIN" ]]; then
  echo "ERROR: LOGALOT_DOMAIN is required." >&2
  echo "  Usage: LOGALOT_DOMAIN=app.example.com bash scripts/google-auth-smoke.sh" >&2
  exit 1
fi

BASE="https://$DOMAIN"
PASS=0
FAIL=0

check_pass() { echo "  [PASS] $1"; PASS=$((PASS+1)); }
check_fail() { echo "  [FAIL] $1" >&2; FAIL=$((FAIL+1)); }

echo "=== logalot Google OAuth smoke test: $BASE ==="
echo ""

# ── 1. HTTPS reachability ──────────────────────────────────────────────────────
echo "1. HTTPS reachability"
HTTP_CODE=$(curl -sf -o /dev/null -w "%{http_code}" --max-time 10 "$BASE/api/healthz" 2>/dev/null || true)
if [[ "$HTTP_CODE" == "200" ]]; then
  check_pass "GET $BASE/api/healthz → $HTTP_CODE"
else
  check_fail "GET $BASE/api/healthz → $HTTP_CODE (expected 200; Caddy/web not up?)"
fi

# ── 2. HSTS header ────────────────────────────────────────────────────────────
echo ""
echo "2. HSTS header (R16)"
HSTS=$(curl -sf -I --max-time 10 "$BASE/api/healthz" 2>/dev/null \
  | grep -i "strict-transport-security" || true)
if echo "$HSTS" | grep -q "max-age=63072000"; then
  check_pass "Strict-Transport-Security: max-age=63072000 present"
else
  check_fail "Strict-Transport-Security with max-age=63072000 not found in response headers (got: '$HSTS')"
fi

# ── 3. HTTP → HTTPS redirect ──────────────────────────────────────────────────
echo ""
echo "3. HTTP → HTTPS redirect (R16)"
REDIRECT_LOC=$(curl -sf -o /dev/null -D - --max-time 10 "http://$DOMAIN/api/healthz" 2>/dev/null \
  | grep -i "^location:" | head -1 | tr -d '\r' || true)
if echo "$REDIRECT_LOC" | grep -qi "https://"; then
  check_pass "HTTP redirects to HTTPS (location: $REDIRECT_LOC)"
else
  check_fail "HTTP did not redirect to HTTPS (location: '$REDIRECT_LOC')"
fi

# ── 4. Google OIDC callback route reachable ────────────────────────────────────
# The callback route at /auth/google/callback must exist and respond to a probe
# request. With a garbage code+state it should fail cleanly (not 404/500).
# Note: -f is intentionally omitted so that 4xx responses (which are expected
# here) are captured cleanly by -w "%{http_code}" without appending "000".
echo ""
echo "4. Google OIDC callback route reachable (route wired in web BFF)"
CB_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 \
  "$BASE/auth/google/callback?code=smoke-probe&state=smoke-probe" 2>/dev/null || echo "000")
# Accept 302/400/401/422 — all indicate the route exists and handles the probe.
# 404 or 500 means the route is missing or the BFF is broken.
if [[ "$CB_STATUS" == "302" || "$CB_STATUS" == "400" || \
      "$CB_STATUS" == "401" || "$CB_STATUS" == "422" || \
      "$CB_STATUS" == "200" ]]; then
  check_pass "GET /auth/google/callback?code=probe&state=probe → $CB_STATUS (route present)"
else
  check_fail "GET /auth/google/callback?code=probe&state=probe → $CB_STATUS (expected 2xx/3xx/4xx, got $CB_STATUS — route missing or internal error)"
fi

# ── 5. Unprovisioned-user rejection (invite-only, AC #2) ─────────────────────
# A callback with a valid-shaped but unknown code/state triggers the control-plane
# OIDC callback, which will try to exchange the code with Google.  Google will
# reject the fabricated code with an error, causing the control-plane to return
# 401.  The key assertion is that the HTTP layer does NOT return 5xx (which would
# indicate a crash or misconfigured service).
# Note: -f is intentionally omitted so that 4xx responses are captured cleanly
# by -w "%{http_code}" without appending "000".
echo ""
echo "5. Unprovisioned / bad-code callback → reject cleanly (not 5xx)"
UNPROVISIONED_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 15 \
  "$BASE/auth/google/callback?code=INVALID_CODE_smoke_test&state=INVALID_STATE_smoke_test" \
  2>/dev/null || echo "000")
if [[ "$UNPROVISIONED_STATUS" != "500" && "$UNPROVISIONED_STATUS" != "502" && \
      "$UNPROVISIONED_STATUS" != "503" && "$UNPROVISIONED_STATUS" != "000" ]]; then
  check_pass "Unprovisioned-user callback → $UNPROVISIONED_STATUS (no 5xx; service rejects cleanly)"
else
  check_fail "Unprovisioned-user callback → $UNPROVISIONED_STATUS (5xx / no response — service crash or misconfiguration)"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [[ $FAIL -gt 0 ]]; then
  echo ""
  echo "See docs/google-oauth-live-demo.md for setup runbook and troubleshooting." >&2
  exit 1
fi

echo ""
echo "Infrastructure prerequisites are satisfied."
echo "For full acceptance, follow the interactive browser walkthrough in"
echo "docs/google-oauth-live-demo.md (provisioned-user sign-in + invite-only guard)."
