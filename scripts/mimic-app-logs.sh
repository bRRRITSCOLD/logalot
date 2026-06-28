#!/usr/bin/env bash
# mimic-app-logs.sh — emit a realistic, continuous stream of logs into the platform
# as if a real application were calling it. Feeds the UI (live tail + search) and
# the alert evaluator with believable traffic for local dev/demo.
#
# Posts single events to the ingest API with the DEV tenant's API key. Varied
# services, weighted levels (mostly info/debug, some warn, fewer error/fatal),
# and plausible per-service messages. Watch them arrive on /explorer (live tail).
#
#   scripts/mimic-app-logs.sh            # ~5 logs/sec, forever (Ctrl-C to stop)
#   RATE=20 scripts/mimic-app-logs.sh    # ~20 logs/sec
#   COUNT=200 scripts/mimic-app-logs.sh  # emit exactly 200 then stop
#
# Env: RATE (logs/sec, default 5), COUNT (0 = infinite, default 0),
#      INGEST_PORT (from .env, default 8080), API_KEY (default dev seed key).
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Load .env so INGEST_PORT matches the running stack.
if [[ -f .env ]]; then set -a; . ./.env; set +a; fi

INGEST_PORT="${INGEST_PORT:-8080}"
INGEST="http://localhost:${INGEST_PORT}/v1/ingest"
# Dev API key minted by migrations/seeds/dev_tenant.sql (DEV ONLY).
API_KEY="${API_KEY:-lgk_dev_devkey001_devsecret0123456789}"
RATE="${RATE:-5}"
COUNT="${COUNT:-0}"

SERVICES=(api-gateway auth-service checkout-service payments-worker user-service \
          search-indexer notification-worker billing-cron)

# Level pool, weighted toward normal traffic (info/debug common; error/fatal rare).
LEVELS=(info info info info info debug debug debug warn warn error trace)

# Plausible messages; one is picked at random per event.
MESSAGES=(
  "request completed status=200 dur_ms=$((RANDOM%200+5))"
  "request completed status=204 dur_ms=$((RANDOM%80+2))"
  "cache hit key=session:$((RANDOM%9999))"
  "cache miss key=user:$((RANDOM%9999)) — falling back to db"
  "db query took ${RANDOM:0:2}ms rows=$((RANDOM%50))"
  "user authenticated user_id=$((RANDOM%9999)) method=jwt"
  "rate limit near threshold tenant=dev remaining=$((RANDOM%20))"
  "payment captured amount_cents=$((RANDOM%50000)) currency=usd"
  "retrying upstream call attempt=$((RANDOM%3+1))"
  "slow query detected dur_ms=$((RANDOM%2000+800))"
  "validation failed field=email reason=format"
  "connection reset by peer — reconnecting"
  "job enqueued queue=notifications id=$((RANDOM%99999))"
  "feature flag evaluated flag=new_checkout value=true"
  "unhandled exception in handler: nil pointer dereference"
)

pick() { local arr=("$@"); echo "${arr[RANDOM % ${#arr[@]}]}"; }

# Sleep between posts to approximate RATE/sec. bc if present, else coarse fallback.
delay() {
  if command -v bc >/dev/null 2>&1; then
    awk "BEGIN{printf \"%.4f\", 1/$RATE}"
  else
    echo 1
  fi
}
SLEEP="$(delay)"

echo ">> emitting logs -> ${INGEST}  (rate≈${RATE}/s, count=${COUNT:-∞}); Ctrl-C to stop"
n=0
trap 'echo; echo ">> stopped after ${n} logs"; exit 0' INT TERM

while :; do
  svc="$(pick "${SERVICES[@]}")"
  lvl="$(pick "${LEVELS[@]}")"
  msg="$(pick "${MESSAGES[@]}")"
  # error/fatal messages read better with a failure-ish body
  if [[ "$lvl" == "error" ]]; then msg="unhandled exception in handler: nil pointer dereference"; fi

  code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$INGEST" \
    -H "Authorization: Bearer ${API_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"service\":\"${svc}\",\"level\":\"${lvl}\",\"message\":\"${msg}\"}" || true)"

  n=$((n+1))
  if [[ "$code" != "202" && "$code" != "200" ]]; then
    echo "  [warn] ingest returned HTTP ${code} (is the stack up? 'make dev-up')" >&2
    sleep 1
  fi
  [[ "$COUNT" -gt 0 && "$n" -ge "$COUNT" ]] && { echo ">> done — emitted ${n} logs"; exit 0; }
  sleep "$SLEEP"
done
