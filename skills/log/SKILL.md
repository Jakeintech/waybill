---
name: log
description: >
  This skill should be used when the user wants to record work in their waybill
  ledger — when they say "log this to my ledger", "log my work", "log today's
  work", "record what we shipped", "log this — the PR merged", "add this to
  the waybill ledger", "open a ledger entry for this ticket", "I'm starting
  PLAT-123, log it", "process my pending sessions", "pin this session to
  PLAT-123", or "unpin this session".
  Also use it at a natural stopping point after shipping something in a
  session, by offering (once, briefly) to log it.
metadata:
  version: "1.6.0"
---

# Log Work

Record work in the ledger at the moment it happens. Follow the storage and
schema rules from the `ledger` skill (`skills/ledger/SKILL.md` in this
plugin, with `references/schema.md` and `references/methodology.md`). Read
both references before writing entries.

Use the engine for every write — invoke it as
`"${CLAUDE_PLUGIN_ROOT}/bin/waybill" <command>`.

If `${WAYBILL_HOME:-$HOME/.waybill}/config.json` does not exist, run ledger
initialization first (see the `ledger` skill).

## Determine the mode

1. **Opening** — the user is about to start a task ("I'm starting PLAT-482").
2. **Closing** — a task just shipped ("log this, the PR merged").
3. **Pinning** — the user asserts this session's spend belongs to a key
   ("pin this session to PLAT-482", "unpin").
4. **Mining** — the user asks to process pending sessions, or unmined files
   exist in `pending-sessions/` when another log request comes in (mention
   the count, offer to mine them).

## Opening a task (pre-registration — the important one)

1. Ask the user for their **without-Claude estimate as a range in hours**,
   before any work with Claude begins. This is required; explain in one line
   why (it is what makes later time-saved claims credible).
2. If Atlassian MCP tools are connected, fetch the issue to fill `points`,
   `epic_key`, `epic_name`, `sprint`. Otherwise ask only for what's needed
   and leave the rest `null`.
3. Build the `opened` entry body (no `id`) with `pre_registered: true`,
   `claude_role: "none"`, empty artifacts, and append it:
   `"${CLAUDE_PLUGIN_ROOT}/bin/waybill" append --stream ledger --event '<json>' --commit`.
   The engine seals the estimate in a SHA-256 escrow automatically and
   refuses backdated pre-registration.
4. Confirm in one line, mentioning the seal the first time:
   `Opened PLAT-482 (5 pts) — estimate 10–16h, sealed in escrow.`

## Closing a task

1. Find the matching `opened` entry by `tracker_key` (or title) in
   `streams/ledger/`. If none exists, say so plainly — the item can still be
   logged, but any time-saved claim will be `judgment` tier per the
   methodology.
2. Gather facts, preferring tools over memory:
   - PR URLs and merge state via GitHub MCP tools if connected, else from
     the user or `git log`.
   - Issue status/points via Atlassian MCP tools if connected.
   - Metered tokens per key: run `"${CLAUDE_PLUGIN_ROOT}/bin/waybill" mine --all` (catch-up), then read
     the usage stream totals for the key. Never hand-estimate tokens.
3. Ask the user only for what cannot be derived: `actual_hours`, and
   `claude_role` (offer the ladder from the methodology; when they hesitate
   between two rungs, record the lower).
4. Compute `time_saved_hours` only if a basis exists: pre-registered range
   minus `actual_hours` → `basis: "pre_registered"`. Otherwise ask whether
   to record a `judgment`-tier estimate or leave it `null`.
5. Append a `shipped` entry with `supersedes` pointing at the `opened`
   entry's id, carrying the same escrow object forward, via
   `"${CLAUDE_PLUGIN_ROOT}/bin/waybill" append --stream ledger --event '<json>' --commit`.
6. Confirm with one line plus running sprint totals (points shipped, metered
   tokens).

## Pinning a session

A pin binds this session's spend to an account at confidence 1.0 — the top
of the attribution ladder.

1. Identify the session id. For "this session" / "that last session", take
   the most recent capture or receipt — either works:

   ```bash
   jq -r '.session_id // empty' "${WAYBILL_HOME:-$HOME/.waybill}"/pending-sessions/*.json 2>/dev/null | tail -1
   ```

   or the newest `session_id` in `streams/sessions/*.jsonl`. If both are
   empty (the session hasn't ended yet), say so and offer to pin the most
   recent *metered* session instead — never guess an id.
2. Append the pin:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/waybill" append --stream ledger --commit --event '{
  "ts": "<now, ISO UTC>", "kind": "pin",
  "session_id": "<session uuid>",
  "account": "story:PLAT-482", "tracker_key": "PLAT-482",
  "range": null, "notes": null
}'
```

3. Re-meter so the pin takes effect: `"${CLAUDE_PLUGIN_ROOT}/bin/waybill" mine --all`. The pin changes
   the attribution-inputs fingerprint, so the affected session re-meters
   even though its transcript hasn't grown; corrected usage events
   supersede the old attribution and history is preserved.
4. **Unpin** = append a `correction` superseding the pin's id, then
   `"${CLAUDE_PLUGIN_ROOT}/bin/waybill" mine --all` again.
5. For "everything after 3pm belongs to X", set
   `range: {"from": "<iso>", "to": null}`.

## Mining pending sessions

Run `"${CLAUDE_PLUGIN_ROOT}/bin/waybill" mine --queue` (just the queued captures) or
`"${CLAUDE_PLUGIN_ROOT}/bin/waybill" mine --all` (every local transcript — the catch-up used before
reports). The miner is deterministic: it meters token usage per turn,
attributes it via the resolver ladder, writes session receipts, and marks
captures `mined: true`. It never reads transcript text into the ledger —
counts, timestamps, and identifiers only.

After mining, surface what changed in one line: sessions metered, tokens
attributed, and the attribution-inbox count if any ambiguities queued
(`streams/exceptions/`, kind `ambiguity`, status open). Offer one-tap
resolutions: each answer becomes a `resolution` event and, at the user's
option, a durable pin or repo default.

## Rules

- Never fabricate keys, points, URLs, or token counts; unknown is `null`.
- Never set `pre_registered: true` on an estimate given after the fact —
  the engine refuses it, and so should you.
- Never hand-append JSONL or invent event ids; always go through
  `"${CLAUDE_PLUGIN_ROOT}/bin/waybill" append`.
- Keep the interaction light: one confirmation, one-line summaries. Logging
  must cost the user less than the value it records.
