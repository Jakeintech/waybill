#!/usr/bin/env bash
# Tests for scripts/capture-session.sh. Dependency-free (jq optional: one
# test is skipped without it). Exits non-zero if any test fails.

set -u
cd "$(dirname "$0")/.." || exit 1

SCRIPT="scripts/capture-session.sh"
PASS=0
FAIL=0

check() { # check <description> <condition-exit-code>
  if [ "$2" -eq 0 ]; then
    printf 'PASS %s\n' "$1"; PASS=$((PASS + 1))
  else
    printf 'FAIL %s\n' "$1"; FAIL=$((FAIL + 1))
  fi
}

SAMPLE='{"session_id":"test-abc","transcript_path":"/tmp/nope.jsonl","cwd":"/tmp","reason":"exit"}'

# 1. Valid input creates exactly one capture file and exits 0. -------------
TMP="$(mktemp -d)"
export WAYBILL_HOME="$TMP/ledger"
printf '%s' "$SAMPLE" | bash "$SCRIPT"
check "exits 0 on valid input" $?
count="$(find "$TMP/ledger/pending-sessions" -type f 2>/dev/null | wc -l | tr -d ' ')"
if [ "$count" = "1" ]; then rc=0; else rc=1; fi
check "creates exactly one capture file" $rc

# 2. The capture preserves the session_id. ---------------------------------
grep -q '"session_id"' "$TMP/ledger/pending-sessions/"*.json 2>/dev/null
check "capture contains session_id" $?

# 3. With jq available, enrichment adds mined:false. ------------------------
if command -v jq >/dev/null 2>&1; then
  jq -e '.mined == false and .captured_at' "$TMP/ledger/pending-sessions/"*.json >/dev/null 2>&1
  check "jq enrichment adds mined:false and captured_at" $?
else
  printf 'SKIP jq enrichment test (jq not installed)\n'
fi
rm -rf "$TMP"

# 4. Empty input creates no file and still exits 0. --------------------------
TMP="$(mktemp -d)"
export WAYBILL_HOME="$TMP/ledger"
printf '' | bash "$SCRIPT"
check "exits 0 on empty input" $?
count="$(find "$TMP/ledger/pending-sessions" -type f 2>/dev/null | wc -l | tr -d ' ')"
if [ "$count" = "0" ]; then rc=0; else rc=1; fi
check "creates no file on empty input" $rc
rm -rf "$TMP"

# 5. Unwritable destination still exits 0 (must never break a session). -----
export WAYBILL_HOME="/proc/waybill-cannot-exist"
printf '%s' "$SAMPLE" | bash "$SCRIPT"
check "exits 0 when ledger home is unwritable" $?
unset WAYBILL_HOME

# ---------------------------------------------------------------------------
echo
echo "Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
