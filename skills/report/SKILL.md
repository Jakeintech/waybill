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
  ledger. (Pure spend questions — "where did my tokens go", "what did
  PLAT-123 cost" — belong to the spend skill; this one builds the
  narrative report around those numbers.) Produces a one-page,
  receipt-backed report; never invents numbers.
metadata:
  version: "1.1.1"
---

# Report

Turn ledger facts into a report a decision-maker can verify in two minutes.
Brevity is part of the credibility: one page hard cap, every section has a
line budget below, and when in doubt cut the sentence, not the number.
Read `skills/ledger/references/methodology.md` first and enforce its
language rules throughout; read `references/schema.md` for field semantics.

The numbers come from the engine, never from estimation:

```bash
WAYBILL="${CLAUDE_PLUGIN_ROOT}/bin/waybill.mjs"
node "$WAYBILL" mine --all                 # catch-up metering first, always
node "$WAYBILL" query report --from <iso> --to <iso> [--audience <a>]
node "$WAYBILL" query spend  --from <iso> --to <iso>    # spend-ledger detail
node "$WAYBILL" query story <KEY>                       # "what did KEY cost"
```

You write the prose; the engine writes the numbers. Never recompute or
adjust a number the query returned.

## Resolve the request

- **Window**: default to the current sprint for "recap", the last full
  quarter for "quarterly", the review period the user names for a perf
  review, and the period since the last allocation (from
  `config.json.allocations`) for a token pitch. Confirm the window in the
  output header, not with a question, unless genuinely ambiguous.
- **Audience preset** (D12 redaction levels):
  - `token-pitch`, `perf-review` → `--audience internal` (keys and URLs
    stay; machine-local detail dropped).
  - anything the user will paste outside the org → `--audience external`
    (keys, titles, repos pseudonymized; numbers survive). Say in the footer
    that identifiers are pseudonymized and the internal version is
    available.
  - exploring their own data → `self` (the default).
- **Presets**: `token-pitch` (default when the goal is more tokens),
  `perf-review`, `sprint-recap`, `quarterly`.

## Cold start: the bootstrap report

If the ledger has fewer than 3 shipped entries for the window — or the user
asks for a "bootstrap report" or their "first report" — do not pad and do
not refuse. Run `node "$WAYBILL" bootstrap` for the zero-auth receipt; if MCP
servers are connected, run the `sync` skill's flow for ~90 days first
(confirm the window in one line), then produce a **facts-only** report.
State plainly that no time-saved claims exist yet, and close with one line
on how pre-registering upcoming tasks unlocks them. Never fabricate tier-3
claims to fill the gap.

## Render (markdown, one page, this order)

1. **Headline** — one sentence: outcome + strongest range, from
   `query report` totals. Example: *"Since the July grant: 34 points
   shipped across 2 epics, 11 PRs merged and deployed, an estimated 31–58
   hours saved (pre-registered basis), at 0.9M tokens per point."*
2. **Shipped, with receipts** — at most 5 lines, each
   `KEY title (pts) — [PR](url) merged <date>, deployed <tag>`, grouped
   under epic names, from `report.shipped`. Mark escrow-sealed items with
   "(pre-registered)". Everything else collapses to "+N more (ledger on
   request)".
3. **Efficiency** — tokens/point and tokens/PR from `report.efficiency`,
   with the previous window for trend if data exists (run a second query).
4. **Spend ledger** — from `report.spend_ledger`: total metered tokens, top
   accounts with confidence noted, open spend (tokens on not-yet-shipped
   stories), and the unattributed % — always shown, never hidden
   ("11% unattributed — shown, never hidden"). If the attribution inbox has
   open items, add one line offering to resolve them.
5. **Costs & caveats** — tokens spent vs. granted (utilization) from
   `report.costs`; USD only if `pricing_version` is set, labeled
   "list-price equivalent"; rework from `costs.reopened_count` ("1 item
   reopened after shipping") and waste from `costs.waste` ("14 retried
   commands, 79 repeated reads across the window") — the unflattering
   numbers are what make the flattering ones believable; one line on what
   was excluded (judgment-tier claims, in-flight work).
6. **The ask** (token-pitch only) — from the `forecast` skill's output if
   upcoming work is known; otherwise state that the forecast can be
   generated next.
7. **Methodology footnote** — one line naming the evidence tier of each
   number class, plus "metering: deterministic, conservation-checked
   (`waybill verify`)".

Preset adjustments: `perf-review` leads with epic-level outcomes across all
`work_type`s (including review, incident, and docs work), frames the
headline for the user's manager, and omits token-efficiency metrics unless
asked; `sprint-recap` drops the ask section entirely.

## Hard rules

- Every metric traceable to event `id`s; keep the mapping, produce on
  request. The engine's numbers are the numbers.
- Ranges stay ranges. No midpoints, no "approximately 45 hours".
- Tokens are the native unit (D6 — bundled Anthropic rates ship as defaults
  via `pricing import`; override with `pricing set`); dollars appear only
  when a pricing basis is configured, always labeled with the
  `pricing_version`.
- No peer comparisons, ever. Own-baseline and published team/industry
  benchmarks only.
- Delivered value includes only merged/deployed work. In-flight items
  appear only under a clearly labeled "In flight" line, and only if asked.
- No adjective without an artifact link.
- If the ledger is too thin for a section, say so in plain empty-state
  language: "Nothing shipped in this window. The ledger doesn't pad."

## Output handling

Print the report in the conversation. Offer, without doing it unprompted,
to save it to a file. **Confluence publishing is strictly opt-in**: only
when the user explicitly asks, publish via the Atlassian MCP tools, confirm
the destination space/page first, and remind them in one line which
audience level the report was rendered at before it leaves their machine.
