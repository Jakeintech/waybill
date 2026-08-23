---
name: cache
description: >
  This skill should be used for any question about what the Claude bill is
  actually made of — when the user asks "why is my bill like this", "what
  am I actually billed for", "cache usage", "how much of my spend is cache
  reads", "what did caching save me", "cache hit rate", "effective vs list
  cost", or wonders why token totals look huge next to the invoice.
  Answers come from `waybill query cache` — deterministic volume by cache
  tier plus a derived effective-vs-list cost view, never estimates.
metadata:
  version: "2.2.0"
---

# Cache

Most of a Claude Code bill is not what people picture. Cache reads are
billed at a tenth of the input rate and usually dominate the volume;
cache writes carry premiums (1.25× for 5-minute, 2× for 1-hour entries).
This skill answers "why is my bill like this" from the metered ledger.
The engine computes every number; you write the prose around them and
never adjust a figure.

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/waybill" mine --all    # catch-up metering first, always
"${CLAUDE_PLUGIN_ROOT}/bin/waybill" query cache [--from <date>] [--to <date>]
```

The payload (`data`):

- `tokens` — volume by class: input, output, cache_read, cache_creation
  (with the 5m/1h write split); `cache_read_pct` is reads as a share of
  total volume.
- `by_model` — the same per model, each with a derived `effective_usd`
  (null when no rate resolves — never $0).
- `billed` — the cost view, **derived from the current rate table** and
  labeled so (`basis: "list_price_equivalent_derived"`):
  `effective_usd` (the tokens priced as billed), `list_equivalent_usd`
  (the same tokens with no caching at all), `saved_usd` (the NET saving,
  write premiums already paid for), `cache_read_share_of_billed_pct`,
  and `covered_pct` (how much of the volume the dollar math covers).
- `unattributed_pct` — the honesty floor; it travels on every payload.

## Rendering rules

Honor the `detail` axis (config `detail_default`, `--detail` override):

- **terse** (1–3 lines): total volume, the cache-read share, and the net
  saving with its `basis` label. Even at terse, never drop the
  unattributed %, `covered_pct` when below 100, or the derived-basis
  label — those survive every level.
- **standard**: the above plus the tier table (input / output / reads /
  5m writes / 1h writes) and the effective-vs-list pair.
- **full**: everything, including per-model rows.

Language rules (methodology): "saved" is always *derived, list-price
equivalent* — say so; it is not a stored fact and not a promise about
the actual invoice. When `covered_pct` < 100, name the unpriced models
(`waybill status` lists them with fixes) rather than presenting a
partial dollar figure as complete. Ranges stay ranges; the unattributed
share is shown, never hidden.

## The canonical questions

| Question | Answer from |
|---|---|
| Why is my bill like this? | `billed.effective_usd` vs `billed.list_equivalent_usd`, and `tokens` by tier |
| What am I actually billed for? | the tier table — reads at 0.1×, writes at 1.25×/2×, in/out at list |
| What did caching save me? | `billed.saved_usd` (net; labeled derived) |
| How much of my volume is cache reads? | `cache_read_pct` |
| Which model drives the bill? | `by_model` sorted by volume, with per-model `effective_usd` |

One habit worth offering once: the cache-read share is the number that
makes raw token totals legible to a budget owner — "N tokens" sounds
alarming until the receipt shows most of it was tenth-rate cache reads.
