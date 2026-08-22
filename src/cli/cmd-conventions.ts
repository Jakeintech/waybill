import { loadConfig } from "../core/config.ts";

/**
 * Receipt-friendly conventions, printed for the user (or a skill) to
 * install where they belong. Attribution quality is decided at commit
 * time: a branch that carries the story key, a commit subject that leads
 * with it, and a PR body with a closing keyword raise the resolver's
 * confidence from guesswork to evidence. The engine only PRINTS here — it
 * never writes outside its own home; installing the block or the hook is
 * the user's (or Claude's) explicit action in their repo.
 */
export function runConventions(home: string, args: string[], json: boolean): number {
  for (const a of args) {
    process.stderr.write(`waybill conventions: unknown option ${a}\n`);
    return 2;
  }
  const config = loadConfig(home);
  const pattern = config.metering.branch_key_pattern;
  const keys = config.tracker.project_keys;
  const example = keys.length > 0 ? `${keys[0]}-123` : "PLAT-123";

  const claudeMd = `## Commit & PR conventions (waybill receipts)

Work in this repo is metered and attributed by the waybill plugin. Keep
the receipts clean:

- Branch names carry the story key: \`feat/${example}-short-slug\`.
- Commit subjects lead with the key: \`${example}: what changed\`.
- PR bodies carry a closing keyword where one applies: \`Fixes #12\`.
- One story per session where practical; say "log it" when starting
  sizeable work so the estimate is pre-registered, and "pin this session
  to ${example}" when a session's account is ambiguous.
`;

  const hook = `#!/bin/sh
# waybill commit-msg hook: prefix the story key from the branch when the
# message doesn't already carry one. Install:
#   save as .git/hooks/commit-msg && chmod +x .git/hooks/commit-msg
branch=$(git symbolic-ref --short HEAD 2>/dev/null || git rev-parse --abbrev-ref HEAD 2>/dev/null) || exit 0
key=$(printf '%s' "$branch" | grep -oE '${pattern}' | head -n 1)
[ -n "$key" ] || exit 0
grep -qE '${pattern}' "$1" || {
  tmp="$1.waybill" && printf '%s: ' "$key" | cat - "$1" > "$tmp" && mv "$tmp" "$1"
}
exit 0
`;

  if (json) {
    process.stdout.write(JSON.stringify({ data: { claude_md: claudeMd, commit_msg_hook: hook } }, null, 2) + "\n");
    return 0;
  }
  process.stdout.write(
    "Receipt-friendly conventions — attribution improves because the inputs improve.\n\n" +
      "─── CLAUDE.md block (append to the repo's CLAUDE.md) " + "─".repeat(10) + "\n\n" +
      claudeMd +
      "\n─── commit-msg hook (optional; save as .git/hooks/commit-msg, chmod +x) ───\n\n" +
      hook +
      "\nEvery convention adopted raises resolver confidence and shrinks the inbox.\n",
  );
  return 0;
}
