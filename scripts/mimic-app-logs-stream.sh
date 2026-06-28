#!/usr/bin/env bash
# mimic-app-logs-stream.sh — stream logs at RANDOM (jittered) intervals, so the
# traffic looks bursty/irregular like a real app rather than a fixed metronome.
#
# Thin wrapper over mimic-app-logs.sh (the same emitter engine): it just turns on
# the engine's jitter mode by setting JITTER_MIN/JITTER_MAX. Each event waits a
# random gap in [MIN, MAX] seconds.
#
#   scripts/mimic-app-logs-stream.sh            # random 0.2–3s gaps, forever
#   MIN=0.05 MAX=1 scripts/mimic-app-logs-stream.sh   # tighter, burstier
#   COUNT=100 scripts/mimic-app-logs-stream.sh        # 100 events then stop
#
# Env: MIN (min gap sec, default 0.2), MAX (max gap sec, default 3),
#      COUNT (0 = forever) — plus anything mimic-app-logs.sh accepts.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

export JITTER_MIN="${MIN:-0.2}"
export JITTER_MAX="${MAX:-3}"

exec "$DIR/mimic-app-logs.sh"
