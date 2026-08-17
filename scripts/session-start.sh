#!/usr/bin/env bash
# waybill: SessionStart hook.
#
# Emits at most one line of context — a budget-pacing notice when a
# threshold (80%, 100%) was newly crossed, per FR-B3: surfaced at a natural
# moment, once per crossing, never nagging, never blocking.
#
# Design rules (same as capture-session.sh):
#   - Never block, never fail: always exit 0, fast.
#   - Zero dependencies beyond node (which Claude Code requires anyway).

set -u

if command -v node >/dev/null 2>&1 && [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] \
   && [ -f "$CLAUDE_PLUGIN_ROOT/bin/waybill.mjs" ]; then
  node "$CLAUDE_PLUGIN_ROOT/bin/waybill.mjs" pace --notice 2>/dev/null || true
fi

exit 0
