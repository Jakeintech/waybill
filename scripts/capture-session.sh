#!/usr/bin/env bash
# waybill: SessionEnd hook.
#
# Claude Code pipes the hook event JSON to stdin (session_id, transcript_path,
# cwd, reason, ...). This script saves it to a pending queue so the log
# skill can later mine the transcript for accomplishments and token usage.
#
# Design rules:
#   - Never block, never fail: always exit 0.
#   - Never lose the raw input: save first, enrich second.
#   - No dependencies required; jq is used only if present.

set -u

LEDGER_HOME="${WAYBILL_HOME:-$HOME/.waybill}"
QUEUE_DIR="$LEDGER_HOME/pending-sessions"

mkdir -p "$QUEUE_DIR" 2>/dev/null || exit 0

STAMP="$(date -u +%Y%m%dT%H%M%SZ 2>/dev/null || echo unknown)"
OUT="$QUEUE_DIR/${STAMP}-$$.json"

# 1) Save the raw hook input verbatim.
cat > "$OUT" 2>/dev/null || exit 0

# Discard empty captures.
if [ ! -s "$OUT" ]; then
  rm -f "$OUT" 2>/dev/null
  exit 0
fi

# 2) Best-effort enrichment (git branch of the session's working dir).
if command -v jq >/dev/null 2>&1; then
  BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")"
  TMP="$(mktemp 2>/dev/null)" || exit 0
  if jq --arg branch "$BRANCH" --arg captured_at "$STAMP" \
        '. + {git_branch: $branch, captured_at: $captured_at, mined: false}' \
        "$OUT" > "$TMP" 2>/dev/null; then
    mv "$TMP" "$OUT" 2>/dev/null || rm -f "$TMP" 2>/dev/null
  else
    rm -f "$TMP" 2>/dev/null
  fi
fi

exit 0
