#!/usr/bin/env bash
# Scripted vertical-slice demo (issue #9): open a live tail, POST a log with the
# dev API key, and show it arrive on the tail within ~2s. Driven by `make
# slice-demo` after `make slice-up`.
#
# Tenancy proof in one run: the log is POSTed with the DEV tenant's key, so it is
# tenant-scoped end to end. The hermetic cross-tenant isolation lock lives in the
# e2e test (`make slice-test`); this script is the human-visible happy path.
set -euo pipefail

# Load .env so INGEST_PORT/QUERY_PORT match the running stack.
if [[ -f .env ]]; then
  set -a; . ./.env; set +a
fi
INGEST_PORT="${INGEST_PORT:-8080}"
QUERY_PORT="${QUERY_PORT:-8081}"

# Dev API key minted by migrations/seeds/dev_tenant.sql (DEV ONLY).
API_KEY="lgk_dev_devkey001_devsecret0123456789"
INGEST="http://localhost:${INGEST_PORT}"
QUERY="http://localhost:${QUERY_PORT}"
CANARY="slice-demo-$(date +%s)"

echo ">> opening live tail on ${QUERY}/v1/tail (SSE) ..."
TAIL_OUT="$(mktemp)"
curl -sN -H "Authorization: Bearer ${API_KEY}" \
        -H "Accept: text/event-stream" \
        "${QUERY}/v1/tail" >"${TAIL_OUT}" &
TAIL_PID=$!
trap 'kill "${TAIL_PID}" 2>/dev/null || true; rm -f "${TAIL_OUT}"' EXIT
sleep 1  # let the SUBSCRIBE register (pub/sub has no replay)

echo ">> POST ${INGEST}/v1/ingest  (canary=${CANARY})"
curl -sS -X POST "${INGEST}/v1/ingest" \
     -H "Authorization: Bearer ${API_KEY}" \
     -H "Content-Type: application/json" \
     -d "{\"message\":\"${CANARY}\",\"level\":\"info\",\"service\":\"demo\"}"
echo

echo ">> waiting up to 2s for the event on the live tail ..."
for _ in $(seq 1 20); do
  if grep -q "${CANARY}" "${TAIL_OUT}"; then
    echo "LIVE TAIL RECEIVED (<2s):"
    grep "${CANARY}" "${TAIL_OUT}"
    exit 0
  fi
  sleep 0.1
done

echo "FAILED: canary did not appear on the live tail within 2s" >&2
echo "--- tail output so far ---" >&2
cat "${TAIL_OUT}" >&2
exit 1
