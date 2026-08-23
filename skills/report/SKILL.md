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
  a request to summarize their own shipped work as a formal artifact
  should go through the ledger. (Pure spend questions — "where did my
  tokens go", "what did PLAT-123 cost" — belong to the spend skill;
  quick "what did I do yesterday / this week" digests belong to the
  standup skill; this one builds formal one-page artifacts around those
  numbers.) Produces a one-page, receipt-backed report; never invents
  numbers.
metadata:
  version: "2.1.0"
---

# Report

Turn ledger facts into a report a decision-maker can verify in two minutes.
Brevity is part of the credibility: one page hard cap, every section has a
line budget below, and when in doubt cut the sentence, not the number.
The **detail level** scales the budgets (`config.detail_default`, or
`--detail` / the user asking for a terse or full version): `terse` = the
headline numbers in 1–3 lines per section (never dropping unattributed %,
confidence, `low_confidence` labels, evidence tiers, or ranges — shorter
never means less honest); `standard` = the budgets below; `full` = no
collapse, every receipt and caveat rendered, still one claim per line.
Read `skills/ledger/references/methodology.md` first and enforce its
language rules throughout; read `references/schema.md` for field semantics.

The numbers come from the engine, never from estimation:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/waybill" mine --all                 # catch-up metering first, always
"${CLAUDE_PLUGIN_ROOT}/bin/waybill" query report --from <iso> --to <iso> [--audience <a>]
"${CLAUDE_PLUGIN_ROOT}/bin/waybill" query spend  --from <iso> --to <iso>    # spend-ledger detail
"${CLAUDE_PLUGIN_ROOT}/bin/waybill" query story <KEY>                       # "what did KEY cost"
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
  `perf-review`, `sprint-recap`, `quarterly`, `grant-report` (maintainers:
  what the sponsorship shipped), `incident` (a windowed receipts pack
  over an incident timeframe). (Billing paperwork belongs to the
  `invoice` skill; per-item AI-involvement statements to `disclose`.)

## Cold start: the bootstrap report

If the ledger has fewer than 3 shipped entries for the window — or the user
asks for a "bootstrap report" or their "first report" — do not pad and do
not refuse. Run `"${CLAUDE_PLUGIN_ROOT}/bin/waybill" bootstrap` for the zero-auth receipt; if MCP
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
   When `report.model_mix.by_model` has 2+ rows, one line on
   tokens-per-point by dominant model ("opus-carried stories: 0.9M/pt;
   sonnet-carried: 0.4M/pt") — own history only, and rows built on a
   single story are anecdotes, said as such. When
   `report.calibration.with_actuals` > 0, one line on estimate
   calibration: coverage plus positions — and any `above` items (work
   that exceeded its no-Claude range) named, never dropped; that honesty
   is what makes the `below` items credible.
4. **Spend ledger** — from `report.spend_ledger`: total metered tokens, top
   accounts with confidence noted, open spend (tokens on not-yet-shipped
   stories), and the unattributed % — always shown, never hidden
   ("11% unattributed — shown, never hidden"). If the attribution inbox has
   open items, add one line offering to resolve them.
5. **Costs & caveats** — tokens spent vs. granted (utilization) from
   `report.costs`; USD using bundled Anthropic list rates by default (labeled
   "list-price equivalent"); rework from `costs.reopened_count` ("1 item
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
asked; `sprint-recap` drops the ask section entirely. `grant-report`
("what did the sponsorship fund") windows on the grant period, leads with
shipped items and closed issues (GitHub-issues keys render naturally),
includes the AI-cost line as spend transparency, drops the ask unless the
user is renewing, and defaults to `--audience internal` since maintainer
work is public anyway — offer `export --pack` as the funder's
verification. `incident` windows tightly on the incident timeframe the
user names, filters shipped rows to `work_type: "incident"` (plus
anything the user tags in; in-flight incident work under a labeled "In
flight" line only if asked), leads with the timeline facts (sessions,
turns, tokens over the window — when work started, how long it ran), and
skips efficiency metrics entirely — nobody prices a fire by the
token.

## Hard rules

- Every metric traceable to event `id`s; keep the mapping, produce on
  request. The engine's numbers are the numbers.
- Ranges stay ranges. No midpoints, no "approximately 45 hours".
- Tokens are the native unit (D6 — bundled Anthropic rates ship as defaults
  via `pricing import`; override with `pricing set`); dollars appear only
  when a pricing basis is configured, always labeled with the
  `pricing_version` — and when `spend_ledger.pricing_coverage.priced_pct`
  is below 100, with what the dollars cover ("$412 covers 92% of tokens;
  the rest unpriced"). A silently partial total is a broken receipt.
- No peer comparisons, ever. Own-baseline and published team/industry
  benchmarks only.
- Delivered value includes only merged/deployed work. In-flight items
  appear only under a clearly labeled "In flight" line, and only if asked.
- No adjective without an artifact link.
- If the ledger is too thin for a section, say so in plain empty-state
  language: "Nothing shipped in this window. The ledger doesn't pad."

## Output handling

Print the report in the conversation. Offer, without doing it unprompted,
to save it to a file — a saved report is the **export pack**: Markdown,
written by this skill. If the user wants a formatted document (HTML, DOCX,
PDF), hand off to the host's document tooling (e.g. a docx/pdf skill when
one is available) — document rendering is deliberately not an engine
feature (see [docs/skills.md](../../docs/skills.md), "the export-pack
boundary"): the engine supplies the numbers, never the presentation.
**Confluence publishing is strictly opt-in**: only
when the user explicitly asks, publish via the Atlassian MCP tools, confirm
the destination space/page first, and remind them in one line which
audience level the report was rendered at before it leaves their machine.

## Arm the recipient: the verification pack

When the report's audience is a decision-maker (token pitch, review
packet), offer — in one line, without doing it unprompted — to attach the
**verification pack**:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/waybill" export --pack --from <iso> --to <iso> --out <dir>
```

It writes a directory holding the verbatim event lines behind the
report's numbers, the engine itself, and a README whose one command —
`node waybill.mjs verify --home .` — lets the recipient re-run id
determinism, escrow seals, and conservation offline. Two things to say
when offering it: the engine refuses to build a pack from a ledger that
doesn't verify green, and pack contents are **unredacted by design**
(redaction would break the id checks), so it travels only where the
internal report would.
