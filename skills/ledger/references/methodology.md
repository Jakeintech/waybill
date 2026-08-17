# Value Measurement Methodology

The ledger's purpose is to win token allocations by being *more credible* than
a self-written pitch, not more flattering. One inflated number gets every
future number discounted. Apply these rules whenever recording or reporting
value.

## 1. The evidence hierarchy

Every quantitative claim carries the strength of its weakest source. Prefer
higher tiers; label the tier when reporting.

1. **Facts** — merge timestamps, deploy tags, issue transitions, story points
   as recorded in the tracker, token counts from transcripts/OTEL. Report
   these as plain numbers.
2. **Baseline deltas** — the user's own pre-Claude velocity or cycle time
   (from tracker history) versus the current period. Same person, same team,
   same point scale. Report as "X → Y over the same-length window".
3. **Pre-registered estimates** — a without-Claude estimate logged *before*
   the work was done (`pre_registered: true`). Time saved = estimate range
   minus actual hours. Report as a range with `confidence` at most "medium"
   unless the user has a track record of accurate estimates.
4. **Retrospective judgment** — "I think that would have taken me two days."
   Allowed in the ledger, but always `basis: "judgment"`, `confidence: "low"`,
   and reported separately (or excluded) in pitches.

## 2. Pre-registration

When the user opens a task they intend to do with Claude, ask for their
without-Claude estimate as a range **before** work starts, and log an
`opened` entry immediately. Refuse to backfill `pre_registered: true` — if
the estimate came after the fact, it is `judgment` tier. This is the single
biggest credibility lever the ledger has; protect it.

## 3. Ranges, never points

Counterfactuals are uncertain by nature. Store and report `{low, high}`.
Never collapse a range to its midpoint in a report; write "5.5–11.5 hours".
Sum lows and highs separately when aggregating.

## 4. The attribution ladder (`claude_role`)

- `wrote` — Claude produced substantially all of the artifact; the user
  reviewed and merged.
- `co_wrote` — meaningful interleaved contributions from both.
- `assisted` — the user drove; Claude accelerated (boilerplate, debugging,
  lookups).
- `reviewed` — Claude reviewed/critiqued user-written work.
- `researched` — Claude informed the approach; artifact is the user's.

When unsure between two rungs, pick the lower one. Reports may aggregate by
rung ("3 items co-written, 4 assisted") but must never upgrade a rung for
effect.

## 5. Shipped beats written

Value is claimed only for work that is merged to the default branch or
deployed. Open PRs and in-progress items belong in forecasts ("in flight"),
never in delivered-value totals. Lines of code are never a value metric.

## 6. No peer comparison

Never query, store, rank, or report individual colleagues' issues, PRs, or
statistics — even if the user asks. Reasons to give the user if they push:
story points are not comparable across people; scraping teammates' data
reads as surveillance and will poison the pitch politically; the user's own
trajectory against their own baseline is stronger evidence anyway. Team-level
aggregates that leadership already publishes, or public industry benchmarks
(e.g. DORA-style metrics), are acceptable reference points.

## 7. Report costs and misses

Every pitch includes what the value cost: tokens consumed, and any rework or
reopened issues on Claude-assisted work if known. Including the unflattering
number is what makes the flattering ones believable. If utilization of the
last allocation was low, say so and right-size the next ask.

## 8. Language rules for reports

- No adjective without an artifact link ("significantly faster" is banned;
  "PLAT-482 shipped in 4.5h against a 10–16h pre-registered estimate" is not).
- Every metric must be traceable to ledger entry `id`s; keep the mapping and
  produce it on request.
- State methodology in one footnote line: what tier each number came from.
- One page. Decision-makers reward brevity; the ledger holds the depth.
