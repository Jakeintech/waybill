#!/usr/bin/env bash
# Validates the plugin structure the way `claude plugin validate` would,
# plus project-specific checks. Used by CI and contributors.
#
# Usage: bash scripts/validate-plugin.sh
# Exits non-zero on any failure.

set -u
cd "$(dirname "$0")/.." || exit 1

FAILURES=0
ok()   { printf 'OK   %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1"; FAILURES=$((FAILURES + 1)); }

if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq is required to run the validator." >&2
  exit 1
fi

# --- Manifests -------------------------------------------------------------

if [ -f .claude-plugin/plugin.json ] && jq -e . .claude-plugin/plugin.json >/dev/null 2>&1; then
  ok ".claude-plugin/plugin.json is valid JSON"
  if jq -e '.name | test("^[a-z0-9]+(-[a-z0-9]+)*$")' .claude-plugin/plugin.json >/dev/null 2>&1; then
    ok "plugin name is kebab-case"
  else
    fail "plugin name must be kebab-case (lowercase letters, numbers, hyphens)"
  fi
  if jq -e '.version | test("^[0-9]+\\.[0-9]+\\.[0-9]+")' .claude-plugin/plugin.json >/dev/null 2>&1; then
    ok "plugin version is semver"
  else
    fail "plugin version must be semver (MAJOR.MINOR.PATCH)"
  fi
else
  fail ".claude-plugin/plugin.json missing or invalid JSON"
fi

if [ -f .claude-plugin/marketplace.json ]; then
  if jq -e '.plugins | type == "array" and length > 0' .claude-plugin/marketplace.json >/dev/null 2>&1; then
    ok ".claude-plugin/marketplace.json is valid with a plugins array"
  else
    fail ".claude-plugin/marketplace.json invalid or missing plugins array"
  fi
fi

# --- Component configs -----------------------------------------------------

if [ -f .mcp.json ]; then
  if jq -e '.mcpServers | type == "object"' .mcp.json >/dev/null 2>&1; then
    ok ".mcp.json is valid with an mcpServers object"
  else
    fail ".mcp.json invalid or missing mcpServers object"
  fi
fi

if [ -f hooks/hooks.json ]; then
  if jq -e '.hooks | type == "object"' hooks/hooks.json >/dev/null 2>&1; then
    ok "hooks/hooks.json is valid and wraps events in a top-level \"hooks\" key"
  else
    fail "hooks/hooks.json must wrap event config in a top-level \"hooks\" key"
  fi
fi

# --- Skills ----------------------------------------------------------------

found_skill=0
for dir in skills/*/; do
  [ -d "$dir" ] || continue
  found_skill=1
  skill_md="${dir}SKILL.md"
  if [ ! -f "$skill_md" ]; then
    fail "$dir is missing SKILL.md"
    continue
  fi
  if [ "$(head -1 "$skill_md")" = "---" ] \
     && grep -q '^name:' "$skill_md" \
     && grep -q '^description' "$skill_md"; then
    ok "$skill_md has frontmatter with name and description"
  else
    fail "$skill_md frontmatter must start with --- and include name and description"
  fi
  fm_name="$(grep -m1 '^name:' "$skill_md" | sed 's/^name:[[:space:]]*//')"
  dir_name="$(basename "$dir")"
  if [ "$fm_name" = "$dir_name" ]; then
    ok "$skill_md name matches its directory"
  else
    fail "$skill_md frontmatter name ('$fm_name') must match directory ('$dir_name')"
  fi
done
if [ "$found_skill" -eq 0 ]; then
  fail "no skills found under skills/"
fi

# --- Skill naming rules (D19, docs/skills.md) ------------------------------

# Keep in lockstep with docs/skills.md: the plugin name, every engine
# subcommand, and surfaces that are not skills.
RESERVED_SKILL_NAMES="waybill init bootstrap mine meter append resolve verify query pace status export pricing sync-plan inbox"
for dir in skills/*/; do
  [ -d "$dir" ] || continue
  skill_name="$(basename "$dir")"
  if printf '%s' "$skill_name" | grep -Eq '^[a-z]+$'; then
    ok "skill name '$skill_name' is a single lowercase word"
  else
    fail "skill name '$skill_name' must be a single lowercase word (D19)"
  fi
  for reserved in $RESERVED_SKILL_NAMES; do
    if [ "$skill_name" = "$reserved" ]; then
      fail "skill name '$skill_name' is a reserved word (docs/skills.md)"
    fi
  done
done

# --- Shipped engine --------------------------------------------------------

if [ -f bin/waybill.mjs ]; then
  if [ -x bin/waybill.mjs ]; then
    ok "bin/waybill.mjs is executable"
  else
    fail "bin/waybill.mjs is not executable (chmod +x)"
  fi
  if head -1 bin/waybill.mjs | grep -q '^#!/usr/bin/env node'; then
    ok "bin/waybill.mjs has a node shebang"
  else
    fail "bin/waybill.mjs must start with #!/usr/bin/env node"
  fi
  if grep -q 'node_modules' bin/waybill.mjs; then
    fail "bin/waybill.mjs references node_modules — the shipped engine must be dependency-free (D1)"
  else
    ok "bin/waybill.mjs is dependency-free (no node_modules references)"
  fi
else
  fail "bin/waybill.mjs missing — run npm run build"
fi

if [ -f bin/waybill ]; then
  if [ -x bin/waybill ]; then
    ok "bin/waybill launcher is executable"
  else
    fail "bin/waybill launcher is not executable (chmod +x)"
  fi
  if head -1 bin/waybill | grep -q '^#!/bin/sh'; then
    ok "bin/waybill launcher has a POSIX sh shebang"
  else
    fail "bin/waybill launcher must start with #!/bin/sh"
  fi
else
  fail "bin/waybill launcher missing — skills invoke the engine through it"
fi

# The launcher exists so skills never need the node-prefix incantation;
# a reintroduced WAYBILL= variable resurrects the zsh word-splitting bug class.
if grep -rn 'WAYBILL="\|node "[$]WAYBILL"' skills/ >/dev/null 2>&1; then
  fail "skills reference the old node/\$WAYBILL incantation — use \"\${CLAUDE_PLUGIN_ROOT}/bin/waybill\" instead"
else
  ok "skills invoke the engine via the bin/waybill launcher only"
fi

# --- Scripts ---------------------------------------------------------------

for script in scripts/*.sh; do
  [ -f "$script" ] || continue
  if [ -x "$script" ]; then
    ok "$script is executable"
  else
    fail "$script is not executable (chmod +x)"
  fi
  if bash -n "$script" 2>/dev/null; then
    ok "$script passes bash syntax check"
  else
    fail "$script has bash syntax errors"
  fi
done

# --- Docs-as-tests: schema example entries must parse ----------------------

schema_doc="skills/ledger/references/schema.md"
if [ -f "$schema_doc" ]; then
  entry_count=0
  while IFS= read -r line; do
    entry_count=$((entry_count + 1))
    if printf '%s' "$line" | jq -e '.id and .ts and .kind and .schema_version == 2' >/dev/null 2>&1; then
      ok "schema.md example entry $entry_count is valid (id: $(printf '%s' "$line" | jq -r .id))"
    else
      fail "schema.md example entry $entry_count is invalid JSON or missing envelope fields (id, ts, kind, schema_version)"
    fi
  done < <(grep -o '^{.*}$' "$schema_doc")
  if [ "$entry_count" -eq 0 ]; then
    fail "schema.md contains no parseable example entries"
  fi
fi

# --- Result ----------------------------------------------------------------

echo
if [ "$FAILURES" -gt 0 ]; then
  echo "Validation failed: $FAILURES problem(s)."
  exit 1
fi
echo "Validation passed."
