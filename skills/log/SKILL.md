---
name: log
description: >
  This skill should be used when the user wants to record work in their waybill
  ledger — when they say "log this to my ledger", "log my work", "log today's
  work", "record what we shipped", "add this to the waybill ledger", "open a
  ledger entry for this ticket", "I'm starting PLAT-123, log it", or "process
  my pending sessions". Also use it at a natural stopping point after shipping
  something in a session, by offering (once, briefly) to log it.
metadata:
  version: "0.1.0"
---

# Log Work

Record work in the ledger at the moment it happens. Follow the storage and
schema rules from the `ledger` skill (`skills/ledger/SKILL.md` in this plugin,
with `references/schema.md` and `references/methodology.md`). Read both
references before writing entries.

Let `LEDGER_HOME` mean `${WAYBILL_HOME:-$HOME/.waybill}` in every
command below. If `LEDGER_HOME/ledger.jsonl` does not exist, run ledger
initialization first (see the `ledger` skill).

## Determine the mode

1. **Opening** — the user is about to start a task ("I'm starting PLAT-482").
2. **Closing** — a task just shipped ("log this, the PR merged").
3. **Mining** — the user asks to process pending sessions, or unmined files
   exist in `LEDGER_HOME/pending-sessions/` when another log request comes in
   (mention the count, offer to mine them).

## Opening a task (pre-registration — the important one)

1. Ask the user for their **without-Claude estimate as a range in hours**,
   before any work with Claude begins. This is required; explain in one line
   why (it is what makes later time-saved claims credible).
2. If Atlassian MCP tools are connected, fetch the issue to fill `points`,
   `epic_key`, `epic_name`, `sprint`. Otherwise ask only for what's needed and
   leave the rest `null`.
3. Write an `opened` entry with `pre_registered: true`, `claude_role: "none"`,
   empty artifacts.
4. Confirm in one line: `Opened PLAT-482 (5 pts) — your estimate: 10–16h.`

## Closing a task

1. Find the matching `opened` entry by `tracker_key` (or title). If none
   exists, say so plainly — the item can still be logged, but any time-saved
   claim will be `judgment` tier per the methodology.
2. Gather facts, preferring tools over memory:
   - PR URLs and merge state via GitHub MCP tools if connected, else from the
     user or `git log`.
   - Issue status/points via Atlassian MCP tools if connected.
   - Token usage and session ids from mined sessions (below) when available.
3. Ask the user only for what cannot be derived: `actual_hours`, and
   `claude_role` (offer the ladder from the methodology; when they hesitate
   between two rungs, record the lower).
4. Compute `time_saved_hours` only if a basis exists: pre-registered range
   minus `actual_hours` → `basis: "pre_registered"`. Otherwise ask whether to
   record a `judgment`-tier estimate or leave it `null`.
5. Write a `shipped` entry with `supersedes` pointing at the `opened` entry.
6. Validate with `jq -e`, append, `git commit` in `LEDGER_HOME`, and confirm
   with one line plus running sprint totals (points shipped, tokens used).

## Mining pending sessions

For each file in `LEDGER_HOME/pending-sessions/` without `"mined": true`:

1. Read the capture; if `transcript_path` exists on disk, scan the transcript
   JSONL for:
   - what was worked on: user goals, files edited, tracker keys matching
     `[A-Z][A-Z0-9]+-[0-9]+` in branch names, commit messages, or prompts;
   - PR URLs mentioned or created;
   - token usage: sum `usage.input_tokens` and `usage.output_tokens` across
     assistant messages when those fields are present.
2. Match findings to existing `opened` entries by tracker key; propose
   attaching `sessions` and `tokens` to them, or propose new entries for
   unmatched work. Present the proposals compactly and get a quick yes/no —
   do not write ledger entries from transcripts without confirmation.
3. After writing, rewrite the capture file with `"mined": true`.

## Rules

- Never fabricate keys, points, URLs, or token counts; unknown is `null`.
- Never set `pre_registered: true` on an estimate given after the fact.
- Keep the interaction light: one confirmation, one-line summaries. Logging
  must cost the user less than the value it records.
