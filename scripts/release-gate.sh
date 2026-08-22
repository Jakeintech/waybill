#!/usr/bin/env bash
# The self-verifying release gate (architecture review rec. 7): the claims
# a release makes about itself — test counts, changelog coverage, doc
# links, eval coverage — are checked mechanically, not asserted. Run it
# before tagging: bash scripts/release-gate.sh
set -u
cd "$(dirname "$0")/.." || exit 1

fails=0
ok()   { printf 'OK   %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1"; fails=$((fails + 1)); }

# 1. The version being released has a changelog section.
version="$(node -p "require('./package.json').version")"
if grep -q "^## \[$version\]" CHANGELOG.md; then
  ok "CHANGELOG.md has a [$version] section"
else
  fail "CHANGELOG.md is missing a section for version $version"
fi

# 2. VALIDATION.md's headline test count matches the suite that actually
#    runs — a stale count is a false claim in the audit record.
test_out="$(npm test --silent 2>&1 | tail -20)"
actual_pass="$(printf '%s\n' "$test_out" | sed -n 's/.*ℹ pass \([0-9]*\).*/\1/p' | head -1)"
actual_fail="$(printf '%s\n' "$test_out" | sed -n 's/.*ℹ fail \([0-9]*\).*/\1/p' | head -1)"
claimed="$(sed -n 's/.*\*\*\([0-9]*\) \/ [0-9]* pass\*\*.*/\1/p' VALIDATION.md | head -1)"
if [ -z "$actual_pass" ]; then
  fail "could not read the test count from npm test"
elif [ "${actual_fail:-1}" != "0" ]; then
  fail "test suite is red ($actual_fail failing) — nothing to gate"
elif [ "$claimed" = "$actual_pass" ]; then
  ok "VALIDATION.md's headline count ($claimed) matches the suite ($actual_pass)"
else
  fail "VALIDATION.md claims $claimed tests; the suite runs $actual_pass"
fi

# 3. Every relative markdown link in the user-facing docs resolves.
check_links() {
  src="$1"
  dir="$(dirname "$src")"
  # [text](path) — skip http(s), mailto, and pure #anchors; strip #anchors.
  grep -o '](\([^)]*\))' "$src" | sed 's/^](//; s/)$//' | while read -r link; do
    case "$link" in
      http://*|https://*|mailto:*|"#"*) continue ;;
    esac
    target="${link%%#*}"
    [ -z "$target" ] && continue
    # Placeholder example links in skill prose ("[PR](url)", "(…)") are
    # not paths: a real relative target contains a slash or a dot.
    case "$target" in
      */*|*.*) ;;
      *) continue ;;
    esac
    if [ ! -e "$dir/$target" ] && [ ! -e "$target" ]; then
      echo "$src -> $link"
    fi
  done
}
broken=""
for f in README.md ROADMAP.md CHANGELOG.md VALIDATION.md DECISIONS.md docs/*.md skills/*/SKILL.md skills/*/references/*.md; do
  [ -f "$f" ] || continue
  broken="$broken$(check_links "$f")"
done
if [ -z "$broken" ]; then
  ok "every relative doc link resolves"
else
  fail "broken doc links:"
  printf '%s\n' "$broken" | sed 's/^/       /'
fi

# 4. Every skill has a trigger eval (prompt + criteria).
for dir in skills/*/; do
  name="$(basename "$dir")"
  if [ -f "evals/trigger-$name/prompt.md" ] && [ -f "evals/trigger-$name/graders/criteria.md" ]; then
    ok "skill '$name' has a trigger eval"
  else
    fail "skill '$name' is missing evals/trigger-$name/{prompt.md,graders/criteria.md}"
  fi
done

# 5. The ROADMAP's Shipped heading tracks the released minor.
minor="${version%.*}"
if grep -q "^## Shipped — $minor" ROADMAP.md; then
  ok "ROADMAP.md Shipped heading matches $minor"
else
  fail "ROADMAP.md Shipped heading does not mention $minor"
fi

echo
if [ "$fails" -eq 0 ]; then
  echo "Release gate passed."
  exit 0
else
  echo "Release gate FAILED: $fails check(s)."
  exit 1
fi
