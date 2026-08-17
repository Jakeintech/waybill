#!/usr/bin/env bash
# waybill: SessionStart hook.
#
# Emits at most one line of context — a budget-pacing notice when a
# threshold (80%, 100%) was newly crossed (FR-B3), or a one-shot first-run
# pointer (not initialized / metered-but-nothing-logged), each state at
# most once ever. config.notices.level turns all of it down or off.
# Surfaced at a natural moment, never nagging, never blocking.
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
