---
name: forecast
description: >
  This skill should be used when the user wants to size or draft a token
  request — when they say "forecast my token needs", "draft my token request",
  "how many tokens should I ask for", "token budget for next sprint", "what
  should I pitch for next quarter", or when the report skill needs an "ask"
  section. Combines upcoming tracker work with historical rates from the
  waybill ledger.
metadata:
  version: "2.1.0"
---

# Forecast

Produce a right-sized, defensible token ask: upcoming committed work × the
user's own historical token cost per unit of work, with the buffer stated.
Read `skills/ledger/references/methodology.md` first; forecasts follow the
same honesty rules as reports.

## Gather upcoming work

1. Preferred: via Atlassian MCP, pull issues assigned to the user in the next
   sprint, or children of an epic the user names — key, summary, points.
2. Fallback: the user lists the items. Points missing in the tracker are the
   tracker's problem, not the forecast's: ask the user to estimate them and
   mark those rows `(self-estimated)` in the output.

## Compute historical rates (metered, never manual)

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/waybill" mine --all          # catch-up metering first
"${CLAUDE_PLUGIN_ROOT}/bin/waybill" query forecast
```

The engine returns, from metered + attributed usage joined to shipped
entries:

- `tokens_per_point`: median over the most recent shipped stories with both
  points and metered tokens (manual `tokens` fields are an override, not the
  source). If `low_confidence` is true (fewer than 5 such stories), label
  the whole forecast **low confidence** and say why in one line:
  "Fewer than 5 shipped stories with token data — this forecast is labeled
  low confidence, because it is."
- `hours_saved_per_point`: from `time_saved_hours` ranges with basis
  `pre_registered` or `baseline` only, kept as a low–high range.
- `utilization_pct`: metered tokens ÷ tokens granted for the current
  allocation, if configured.

Never adjust the returned numbers; you write the prose around them.

## Compute the ask

`ask = round_up(total_points × tokens_per_point × 1.2)` — always state the
1.2 planning buffer explicitly; let the user adjust it. If utilization of the
last grant was under ~70%, recommend a smaller buffer or a smaller ask and
say so: right-sized asks are what make bigger future asks credible.

## Render (compact, in this order)

1. **Committed work** — table: key | title | points, with a total row and
   any `(self-estimated)` flags.
2. **The ask** — one line: *"~X tokens for the sprint (Y points × Z
   tokens/point, ×1.2 buffer)."*
3. **Basis** — one line: *"Z = median of last N shipped items
   (window dates); last grant utilization: U%."*
4. **Projected return** — hours-saved range for the committed points, from
   `hours_saved_per_point`, clearly labeled with its evidence tier.
5. **Risk framing** — one line, capacity not promises: which items are at
   risk of slipping without the grant. Never guarantee delivery.

## Rules

- Never inflate: no rates without ledger evidence, no invented points.
- Ranges stay ranges; confidence labels are mandatory when data is thin.
- If the ledger has no token data at all, say the forecast cannot be rate-based
  yet, propose logging 2–3 sprints first, and offer only a clearly labeled
  rough placeholder if the user still wants a number now.
