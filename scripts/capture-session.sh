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

# 2) Best-effort enrichment (git branch + repo identity of the session's cwd).
if command -v jq >/dev/null 2>&1; then
  BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")"
  REMOTE="$(git remote get-url origin 2>/dev/null || echo "")"
  # Two-step: strip a .git suffix, then keep the last org/name segments.
  # (Single-step lazy quantifiers are not portable to BSD sed.)
  REPO="$(printf '%s' "$REMOTE" | sed -E 's#\.git$##; s#.*[:/]([^/:]+/[^/:]+)$#\1#' 2>/dev/null || echo "")"
  printf '%s' "$REPO" | grep -Eq '^[^/:[:space:]]+/[^/:[:space:]]+$' || REPO=""
  TMP="$(mktemp 2>/dev/null)" || exit 0
  if jq --arg branch "$BRANCH" --arg repo "$REPO" --arg captured_at "$STAMP" \
        '. + {git_branch: $branch, repo: (if $repo == "" then null else $repo end), captured_at: $captured_at, mined: false}' \
        "$OUT" > "$TMP" 2>/dev/null; then
    mv "$TMP" "$OUT" 2>/dev/null || rm -f "$TMP" 2>/dev/null
  else
    rm -f "$TMP" 2>/dev/null
  fi
fi

# 3) Mine at queue time (D8): spawn the dependency-free miner, fully
#    detached — it must never block, slow, or fail the ending session.
if command -v node >/dev/null 2>&1 && [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] \
   && [ -f "$CLAUDE_PLUGIN_ROOT/bin/waybill.mjs" ]; then
  nohup node "$CLAUDE_PLUGIN_ROOT/bin/waybill.mjs" mine --queue \
    >/dev/null 2>&1 &
fi

exit 0
