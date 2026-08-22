---
name: standup
description: >
  This skill should be used when the user wants a short digest of what they
  actually did in a recent window — when they say "what did I do
  yesterday", "prep my standup", "standup notes", "what did I work on
  yesterday", "what did I accomplish this week", "daily summary", or
  "weekly digest". Renders ledger facts — shipped items, metered work in
  progress, sessions, tokens — as standup-ready bullets. (Formal artifacts
  — "build my token pitch", performance-review packets — belong to the
  report skill; this one answers the daily "what did I do" from the same
  receipts.) Every bullet traces to a ledger event; nothing is padded or
  invented.
metadata:
  version: "1.6.0"
---

# Standup

Answer "what did I do" from the ledger instead of memory. The engine
returns the facts for the window; render them as bullets a person would
actually read out in standup — short, concrete, artifact-linked.

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/waybill" mine --all      # catch-up metering first, always
"${CLAUDE_PLUGIN_ROOT}/bin/waybill" query standup [--date yesterday|today|YYYY-MM-DD] \
    [--days <n>] [--from <iso> --to <iso>]
```

## Resolve the window

- Default (no window words): `--date yesterday`.
- **Monday standup**: "yesterday" would miss the weekend. `--days <n>`
  covers the last n days **ending today**, so use `--days 4` (Friday
  through today) — or explicit `--from <Friday> --to <Sunday>` to exclude
  today. Always say which days the digest covers, from the returned
  `.data.window`.
- "this week" / "weekly digest": `--days 7`.
- A named day ("what did I do Tuesday"): `--date <YYYY-MM-DD>`.
- Day math is local-calendar (the engine's `--date`/`--days` handle it);
  pass explicit `--from`/`--to` only for odd ranges.

## Render (bullets, in this order)

Work from the returned `.data`:

1. **Shipped** (`.data.shipped`) — one bullet per item:
   `KEY — title (points, PR links)`. These are the strongest lines; lead
   with them.
2. **In progress** (`.data.progressed`) — items with metered spend that
   did not ship in the window: `KEY — title (n sessions)`. Rows with
   `shipped_earlier: true` are follow-up on an already-shipped item —
   say "follow-up on KEY", not "in progress". Mention token counts only
   if the user asks or the audience is themselves — teammates want the
   work, not the meter.
3. **Started** (`.data.opened`) — newly opened entries, with
   "estimate pre-registered" noted where true.
4. **Blockers / attention** — only from `.data.attention`: open
   attribution-inbox items or a notable unattributed share are *ledger*
   blockers; real work blockers the user must add themselves (ask if a
   "blockers" line is wanted, don't invent one).

Close with one summary line when useful:
`n sessions · n turns · N tokens` (add `$X (rates <pricing_version>)` only
when `.data.tokens.cost_usd` is present). If `.data.tokens.unpriced_tokens`
is non-zero, say so and relay the fix `waybill status` prints — `pricing
import` covers Anthropic models; a model outside the bundle needs
`pricing set <model-id> ...`; either way `waybill meter --all` re-prices.
Costs are never silently partial.

Empty window: "Nothing recorded for <window>. The ledger doesn't pad." —
then offer the likely fixes (were sessions mined? `waybill status`).

## Rules

- Facts only. Every bullet must trace to a ledger event; no adjectives
  without an artifact, no recalled-from-memory items mixed in unlabeled.
  If the user adds context ("also did prod support"), include it but mark
  it theirs, not the ledger's.
- The digest is the user's own data for their own standup. Pasting it to
  a team channel is the user's call — if they ask for a shareable
  version, re-run with `--audience internal` (or `external` outside the
  org) rather than hand-editing identifiers.
- No peer comparisons, ever.
- Never write ledger entries from this skill — it reads; `log` writes.
