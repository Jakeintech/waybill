---
name: report
description: >
  This skill should be used whenever the user wants any summary, pitch, or
  review of their accomplishments built from the waybill ledger — when they
  say "generate my value report", "build my token pitch", "make my case for
  more tokens", "sprint recap", "quarterly Claude report", "what did Claude
  help me ship this month", "show my impact", "help me with my performance
  review", "draft my promo packet", "what did I accomplish this quarter", or
  "give me a bootstrap report". Use it even when they don't say "report" —
  any request to summarize their own shipped work should go through the
  ledger. Produces a one-page, receipt-backed report; never invents numbers.
metadata:
  version: "0.1.0"
---

# Report

Turn ledger entries into a report a decision-maker can verify in two minutes.
Read `skills/ledger/references/methodology.md` first and enforce its language
rules throughout; read `references/schema.md` for field semantics.

Let `LEDGER_HOME` mean `${WAYBILL_HOME:-$HOME/.waybill}`.

## Resolve the request

- **Window**: default to the current sprint for "recap", the last full
  quarter for "quarterly", the review period the user names for a perf
  review, and the period since the last allocation (from
  `config.json.allocations`) for a token pitch. Confirm the window in the
  output header, not with a question, unless genuinely ambiguous.
- **Audience preset**: `token-pitch` (default when the goal is more tokens),
  `perf-review` (performance reviews and promo packets), `sprint-recap`, or
  `quarterly`.

## Cold start: the bootstrap report

If the ledger has fewer than 3 shipped entries for the window — or the user
asks for a "bootstrap report" or their "first report" — do not pad and do
not refuse. Run the `sync` skill's flow for roughly the last 90 days
(confirm the window in one line), then produce a **facts-only** report:
shipped items with receipts, points, merged PRs, deploys, and tokens where
available. State plainly in the caveats that no time-saved claims exist yet,
and close with one line on how pre-registering upcoming tasks unlocks them.
Never fabricate tier-3 claims to fill the gap.

## Compute (jq over `ledger.jsonl`, facts only)

Using authoritative entries in the window (latest non-superseded per
`tracker_key`, `kind: "shipped"`):

- Shipped items grouped epic → story, with points, PR links, deploy tags.
- Totals: points, merged PRs, deploys, tokens (input+output).
- Efficiency: tokens per point and tokens per merged PR, for this window and
  the previous equal-length window if data exists.
- Time saved: sum `time_saved_hours.low` and `.high` separately, **only** for
  entries with basis `pre_registered` or `baseline`. Tally `judgment`-basis
  totals separately; include them only if the user asks, clearly labeled.
- Baseline delta if `config.json.baseline` exists: velocity and cycle time,
  then vs. now.
- Costs: tokens consumed vs. tokens granted (utilization), rework/reopened
  count if recorded.

## Render (markdown, one page, this order)

1. **Headline** — one sentence: outcome + strongest range. Example: *"Since
   the July grant: 34 points shipped across 2 epics, 11 PRs merged and
   deployed, an estimated 31–58 hours saved (pre-registered basis), at 0.9M
   tokens per point — down 22% from last quarter."*
2. **Shipped, with receipts** — at most 5 lines, each
   `KEY title (pts) — [PR](url) merged <date>, deployed <tag>`. Group under
   epic names. Everything else collapses to "+N more (ledger on request)".
3. **Efficiency** — two lines or a 2×3 table: tokens/point, tokens/PR, trend.
4. **Costs & caveats** — tokens spent and utilization %, rework if any, and
   one line on what was excluded (judgment-tier claims, in-flight work).
5. **The ask** (token-pitch only) — pull from the `forecast` skill's output
   if upcoming work is known; otherwise state that the forecast can be
   generated next.
6. **Methodology footnote** — one line naming the evidence tier of each
   number class, per the methodology.

Preset adjustments: `perf-review` leads with epic-level outcomes across all
`work_type`s (including review, incident, and docs work), frames the headline
for the user's manager, and omits token-efficiency metrics unless asked;
`sprint-recap` drops the ask section entirely.

## Hard rules

- Every metric traceable to entry `id`s; keep the mapping, produce on request.
- Ranges stay ranges. No midpoints, no "approximately 45 hours".
- No peer comparisons, ever. Own-baseline and published team/industry
  benchmarks only.
- Delivered value includes only merged/deployed work. In-flight items appear
  only under a clearly labeled "In flight" line, and only if asked.
- No adjective without an artifact link.
- If the ledger is too thin for a section (e.g. fewer than 3 shipped entries),
  say so in that section rather than padding, in plain empty-state language:
  "Nothing shipped in this window. The ledger doesn't pad."

## Output handling

Print the report in the conversation. Offer, without doing it unprompted, to
save it to a file or publish it to Confluence via the Atlassian MCP tools.
