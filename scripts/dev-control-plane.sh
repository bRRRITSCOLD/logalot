#!/usr/bin/env bash
# dev-control-plane.sh — run the control-plane (Node/Fastify) for local dev.
#
# The control-plane is NOT containerized (compose only runs infra + the slice's
# ingest/processor/query). The web UI's login/admin/alerts pages need it, so this
# script runs it via the workspace `dev` script (tsx watch) in the background,
# reading config from .env. State lives under ./.dev (gitignored).
#
#   scripts/dev-control-plane.sh start   # boot it (idempotent), wait for healthz
#   scripts/dev-control-plane.sh stop    # kill it
#   scripts/dev-control-plane.sh logs    # tail its log
#   scripts/dev-control-plane.sh status  # report up/down
#
# Env (from .env, with sane dev defaults): LOGALOT_APP_DATABASE_URL, JWT_SECRET,
# CONTROL_PLANE_PORT.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DEV_DIR="$ROOT/.dev"
PID_FILE="$DEV_DIR/control-plane.pid"
LOG_FILE="$DEV_DIR/control-plane.log"
mkdir -p "$DEV_DIR"

# Load .env if present (export every assignment).
if [ -f "$ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/.env"
  set +a
fi

: "${LOGALOT_APP_DATABASE_URL:=postgres://logalot_app:logalot_app@localhost:5432/logalot?sslmode=disable}"
: "${JWT_SECRET:=dev-jwt-secret-change-me-0123456789}"
: "${CONTROL_PLANE_PORT:=8082}"

is_up() {
  curl -fsS -m 2 -o /dev/null "http://localhost:${CONTROL_PLANE_PORT}/healthz" 2>/dev/null
}

case "${1:-start}" in
  start)
    if is_up; then
      echo "control-plane already healthy on :${CONTROL_PLANE_PORT}"
      exit 0
    fi
    echo "starting control-plane on :${CONTROL_PLANE_PORT} ..."
    LOGALOT_APP_DATABASE_URL="$LOGALOT_APP_DATABASE_URL" \
    JWT_SECRET="$JWT_SECRET" \
    CONTROL_PLANE_PORT="$CONTROL_PLANE_PORT" \
    NODE_ENV="${NODE_ENV:-development}" \
      nohup pnpm --filter @logalot/control-plane dev >"$LOG_FILE" 2>&1 &
    echo $! >"$PID_FILE"
    for _ in $(seq 1 30); do
      if is_up; then echo "control-plane up → http://localhost:${CONTROL_PLANE_PORT}"; exit 0; fi
      sleep 1
    done
    echo "control-plane did not become healthy in 30s — see $LOG_FILE" >&2
    tail -20 "$LOG_FILE" >&2 || true
    exit 1
    ;;
  stop)
    if [ -f "$PID_FILE" ]; then
      kill "$(cat "$PID_FILE")" 2>/dev/null || true
      rm -f "$PID_FILE"
      echo "control-plane stopped"
    else
      # fall back to whatever holds the port
      pkill -f "@logalot/control-plane" 2>/dev/null || true
      echo "no pidfile; sent best-effort kill"
    fi
    ;;
  logs)
    tail -f "$LOG_FILE"
    ;;
  status)
    if is_up; then echo "control-plane: UP (:${CONTROL_PLANE_PORT})"; else echo "control-plane: DOWN"; fi
    ;;
  *)
    echo "usage: $0 {start|stop|logs|status}" >&2
    exit 2
    ;;
esac
