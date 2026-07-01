#!/usr/bin/env bash
# infra/aws/caddyfile-log-hygiene.integration.sh
#
# Integration/log-capture test for issue #158 (access-log hygiene on the
# invite-accept path, R-INV-12): runs the REAL production Caddyfile
# (infra/aws/Caddyfile) in a container, sends a request carrying a plaintext
# invite token in the query string, captures Caddy's actual stdout access
# log, and asserts:
#
#   1. the request succeeds end-to-end (proves the log-filter change did not
#      break routing/security headers), and
#   2. no line in the captured log contains the plaintext token.
#
# LOGALOT_DOMAIN is set to `localhost` so Caddy's automatic TLS uses its
# internal CA (no outbound ACME/Let's Encrypt call — safe for CI/offline use).
#
# Usage: infra/aws/caddyfile-log-hygiene.integration.sh
# Requires: docker

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CADDYFILE="$REPO_ROOT/infra/aws/Caddyfile"
NETWORK="logalot-caddy-loghygiene-$$"
WEB_CONTAINER="lg-caddy-loghygiene-web-$$"
CADDY_CONTAINER="lg-caddy-loghygiene-caddy-$$"
TOKEN="lginv_acme_$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"

cleanup() {
  docker rm -f "$CADDY_CONTAINER" "$WEB_CONTAINER" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo ">> creating isolated docker network"
docker network create "$NETWORK" >/dev/null

echo ">> starting stub 'web' backend (stands in for the BFF the Caddyfile forwards to)"
docker run -d --name "$WEB_CONTAINER" --network "$NETWORK" --network-alias web \
  caddy:2-alpine caddy respond --listen :3000 "web-ok" >/dev/null

echo ">> starting real production Caddyfile against the stub backend"
docker run -d --name "$CADDY_CONTAINER" --network "$NETWORK" -p 18443:443 \
  -e LOGALOT_DOMAIN=localhost -e LOGALOT_TLS_EMAIL=ops@example.com \
  -v "$CADDYFILE:/etc/caddy/Caddyfile:ro" \
  caddy:2-alpine >/dev/null

echo ">> waiting for Caddy to obtain its internal-CA certificate"
for _ in $(seq 1 30); do
  if docker logs "$CADDY_CONTAINER" 2>&1 | grep -q "certificate obtained successfully"; then
    break
  fi
  sleep 0.5
done

echo ">> sending GET /invite/accept?token=<secret>"
status="$(curl -sk -o /dev/null -w '%{http_code}' "https://localhost:18443/invite/accept?token=${TOKEN}")"
if [ "$status" != "200" ]; then
  echo "FAIL: expected 200 from /invite/accept, got $status" >&2
  docker logs "$CADDY_CONTAINER" >&2
  exit 1
fi

# Give the async access-log line a moment to flush to stdout.
sleep 1

logs="$(docker logs "$CADDY_CONTAINER" 2>&1)"

if echo "$logs" | grep -qF "$TOKEN"; then
  echo "FAIL: plaintext invite token found in Caddy access log" >&2
  echo "$logs" | grep -F "$TOKEN" >&2
  exit 1
fi

if ! echo "$logs" | grep -q '"uri":"/invite/accept?token=REDACTED"'; then
  echo "FAIL: expected the access log to show the redacted token query param" >&2
  echo "$logs" >&2
  exit 1
fi

echo "PASS: /invite/accept access log redacts the token query param (R-INV-12)"
