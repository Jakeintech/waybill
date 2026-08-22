---
name: spend
description: >
  This skill should be used for any question about where Claude Code tokens
  went or what work cost — when the user says "where am I spending", "where
  did my tokens go", "tokens by story", "what did PLAT-123 cost", "how's my
  burn", "spend report", "what's my open spend", "show my attribution
  inbox", "resolve my attribution inbox", "resolve attribution exceptions",
  or asks about token usage by model, week, epic, or story. Answers come
  from the local metered ledger — deterministic numbers, never estimates.
metadata:
  version: "1.7.0"
---

# Spend

Answer spend questions from local facts, and keep the attribution inbox
empty. The engine computes every number; you write the prose around them
and never adjust a figure.

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/waybill" mine --all      # catch-up metering first, always
```

Read `skills/ledger/references/methodology.md` for the language rules
(tokens are the native unit; USD appears by default using bundled
Anthropic list rates, labeled with its pricing version; unattributed is
shown, never hidden).

## The canonical questions

| Question | Command |
|---|---|
| Where did tokens go (by story/epic/model/week)? | `"${CLAUDE_PLUGIN_ROOT}/bin/waybill" query spend [--from <date>] [--to <date>]` |
| What did `<KEY>` cost? | `"${CLAUDE_PLUGIN_ROOT}/bin/waybill" query story <KEY>` |
| How's my burn / pacing? | `"${CLAUDE_PLUGIN_ROOT}/bin/waybill" pace` |
| What's my open spend? | `query spend` → `.data.open_spend` |
| Attribution health? | `query spend` → `.data.attribution_health` |
| Overall ledger health? | `"${CLAUDE_PLUGIN_ROOT}/bin/waybill" status` |
| What's still in flight / sitting? | `"${CLAUDE_PLUGIN_ROOT}/bin/waybill" query manifest` |
| What never got tracked? | `query untracked` — then hand off to the salvage skill |
| Share the ledger as a file? | `"${CLAUDE_PLUGIN_ROOT}/bin/waybill" export --format csv` (respects --audience) |
| What did caching save me? | `query spend` → `.data.cache_savings` (derived, labeled) |
| Prove the numbers to a recipient? | `"${CLAUDE_PLUGIN_ROOT}/bin/waybill" export --pack` — see the report skill's verification-pack section |
| What's in my inbox? | `"${CLAUDE_PLUGIN_ROOT}/bin/waybill" query inbox` |

Render compactly, honest-auditor voice. Length follows the **detail
level** — the query envelope echoes it (`config.detail_default`, overridden
per invocation by `--detail` or the user asking for "the terse/full
version"):

| Level | Length | Floor rule |
|---|---|---|
| `terse` | 1–3 lines: the asked-for number plus what qualifies it | may NEVER drop unattributed %, confidence values, `low_confidence` labels, evidence-tier labels, or ranges — shorter must never mean less honest |
| `standard` | the default below | — |
| `full` | no collapse: every account row, every caveat, every receipt | — |

At `standard`, default to the number the user asked for plus at most three
supporting lines; the tables below are the MAXIMUM, not the template —
expand only when asked. Numbers first, prose second, nothing twice:

- **Where-did-it-go**: top accounts table (account, tokens, min confidence,
  resolvers), then one line each for unattributed % ("11% unattributed —
  shown, never hidden"), open spend (the at-risk number: tokens on stories
  not yet shipped), and the inbox count if nonzero. When an account's
  `waste` counts are nonzero, add them to its row ("8 retried commands,
  76 repeated reads") — what the tokens bought, and what they wasted.
  When a USD total appears and `.data.pricing_coverage.priced_pct` < 100,
  say what it covers ("$41.20 covers 92% of tokens; the rest is unpriced —
  models: <list>") — a dollar figure that silently omits events is not a
  receipt. `waybill status` prints the fix for any unpriced model.
  When `.data.overhead.tokens` > 0, one line itemizes the plugin's own
  keep ("waybill overhead: 41,000 tokens, 0.4% — itemized") — the
  accountant bills for its own hours.
  When the user asks about caching (or `full` detail), one line from
  `.data.cache_savings`: "cache reads were 61% of volume, saving ~$118 vs.
  uncached list rates — **derived** at current rates, covering
  `covered_pct`% of cache volume". Always labeled derived, never added
  into cost totals; skip the dollars when `saved_usd` is null.
- **Story cost**: one line — total tokens, cache-read share, and
  tokens-per-point if shipped ("PLAT-482: 2.9M tokens, 61% cache reads,
  shipped at 5 pts → 0.58M/pt"). USD only if priced, labeled.
- **Burn**: relay `pace` verbatim: spend vs. linear pace, work-weighted
  pace when sprint data exists, per-epic envelopes if configured.
  "62% of the grant spent, 40% of committed points shipped. Worth a look,
  not an alarm." Never nag; never extrapolate beyond what pace returns.

## The attribution inbox (one tap each)

When the user asks to resolve their inbox — or any spend answer shows open
items — walk them through it, one item per line:

1. `"${CLAUDE_PLUGIN_ROOT}/bin/waybill" query inbox` — each open item has an `id`, the session, the
   turn, and the `candidates` the resolver couldn't choose between.
2. Present each item as one line with its candidates and a suggestion if
   the evidence favors one; collect one answer per item.
3. Apply each answer:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/waybill" resolve --ambiguity <id> --account story:PLAT-482
```

   Add `--pin` if the whole session belongs to that account (durable), or
   `--repo-default org/name` if every future session in that repo should
   default there. The engine records the resolution, re-meters the session
   (corrected usage events supersede — history preserved), and reports what
   changed.
4. Close with one line: items filed, tokens re-attributed, inbox size now.

## Rules

- Never re-bucket tokens by hand; only `resolve` changes attribution.
- Unattributed is a respectable account — report it, don't apologize for it.
- No peer comparisons, ever.
- If metering is behind (mine reports new sessions), say the numbers just
  refreshed; if a transcript was pruned (`meter_gap` in exceptions), say
  which session's tokens are missing and mention the OTel fallback: with
  Claude Code telemetry exporting to a file,
  `"${CLAUDE_PLUGIN_ROOT}/bin/waybill" meter --otel <export.jsonl>` can still recover its totals.
  Never paper over a gap.
