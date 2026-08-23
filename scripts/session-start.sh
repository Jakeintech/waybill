#!/usr/bin/env bash
# waybill: SessionStart hook.
#
# Serves at most one precomputed notice block — a budget-pacing threshold,
# the renewal reminder, or the metered-but-nothing-logged one-shot — from
# rollups/next-notice, where the detached miner queued it at SessionEnd
# (src/cli/notice.ts). Thresholds cross when tokens land, i.e. at session
# end, so serving the queued file here changes nothing about when a notice
# appears. The one state the engine cannot precompute (no ledger exists
# yet) is owned here in shell, announced once ever.
#
# Design rules (E-12, same spirit as capture-session.sh):
#   - Never block, never fail: always exit 0, and never run engine work —
#     pure shell, so "neither hook blocks" stays true.
#   - config.notices.level is honored at queue time by the miner.

set -u

LEDGER_HOME="${WAYBILL_HOME:-$HOME/.waybill}"
NOTICE="$LEDGER_HOME/rollups/next-notice"
FIRST_RUN="$LEDGER_HOME/rollups/first-run.json"

# A queued notice: print it once, consume it.
if [ -s "$NOTICE" ]; then
  cat "$NOTICE" 2>/dev/null || true
  rm -f "$NOTICE" 2>/dev/null || true
  exit 0
fi

# Not initialized and never announced: the static nudge, once ever. The
# marker shape matches cli/notice.ts's first-run state, so the engine and
# this script share one memory.
if [ ! -f "$LEDGER_HOME/config.json" ] && [ ! -f "$FIRST_RUN" ]; then
  printf 'waybill: not initialized. Say "initialize my waybill ledger" — 60s, no auth.\n'
  mkdir -p "$LEDGER_HOME/rollups" 2>/dev/null || exit 0
  printf '{"uninitialized_announced":true}\n' > "$FIRST_RUN" 2>/dev/null || true
fi

exit 0
