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
  version: "1.0.1"
---

# Spend

Answer spend questions from local facts, and keep the attribution inbox
empty. The engine computes every number; you write the prose around them
and never adjust a figure.

```bash
WAYBILL="node ${CLAUDE_PLUGIN_ROOT}/bin/waybill.mjs"
$WAYBILL mine --all      # catch-up metering first, always
```

Read `skills/ledger/references/methodology.md` for the language rules
(tokens are the native unit; USD only when priced, labeled with its
pricing version; unattributed is shown, never hidden).

## The canonical questions

| Question | Command |
|---|---|
| Where did tokens go (by story/epic/model/week)? | `$WAYBILL query spend [--from <date>] [--to <date>]` |
| What did `<KEY>` cost? | `$WAYBILL query story <KEY>` |
| How's my burn / pacing? | `$WAYBILL pace` |
| What's my open spend? | `query spend` → `.data.open_spend` |
| Attribution health? | `query spend` → `.data.attribution_health` |
| What's in my inbox? | `$WAYBILL query inbox` |

Render compactly, honest-auditor voice:

- **Where-did-it-go**: top accounts table (account, tokens, min confidence,
  resolvers), then one line each for unattributed % ("11% unattributed —
  shown, never hidden"), open spend (the at-risk number: tokens on stories
  not yet shipped), and the inbox count if nonzero. When an account's
  `waste` counts are nonzero, add them to its row ("8 retried commands,
  76 repeated reads") — what the tokens bought, and what they wasted.
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

1. `$WAYBILL query inbox` — each open item has an `id`, the session, the
   turn, and the `candidates` the resolver couldn't choose between.
2. Present each item as one line with its candidates and a suggestion if
   the evidence favors one; collect one answer per item.
3. Apply each answer:

```bash
$WAYBILL resolve --ambiguity <id> --account story:PLAT-482
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
  `$WAYBILL meter --otel <export.jsonl>` can still recover its totals.
  Never paper over a gap.
