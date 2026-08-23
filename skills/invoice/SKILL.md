---
name: invoice
description: >
  This skill should be used when the user wants their ledger rendered as
  billing paperwork — when they say "prepare my invoice", "invoice my
  client", "build my invoice pack", "billable summary for the client",
  "monthly AI expense report", "expense my Claude usage", "AI costs for
  finance", or "what do I bill for this month". Two renderings over the
  same receipts: the client invoice pack (shipped work as line items with
  recorded hours and disclosed AI costs) and the personal expense receipt
  (metered token costs for a period, CSV-ready for a finance tool). Facts
  only; it never sets prices or invents hours.
metadata:
  version: "2.2.0"
---

# Invoice

A freelancer's invoice dispute is the same problem as a token-budget
pitch: claims that need receipts. The ledger already holds the receipts —
shipped items, recorded hours, metered AI costs. This skill renders them
as billing paperwork and stops exactly at the line where pricing begins:
**what to charge is the user's business decision; what happened is the
ledger's.**

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/waybill" mine --all      # catch-up metering first, always
"${CLAUDE_PLUGIN_ROOT}/bin/waybill" query report --from <iso> --to <iso> --audience internal
"${CLAUDE_PLUGIN_ROOT}/bin/waybill" export --format csv --from <iso> --to <iso>   # expense mode
```

**Window**: the billing period the user names; default the last full
calendar month. State it in the header.

**Audience**: `internal`. For a freelancer, the client is the org — the
work items ARE the client's project, so keys/titles/PR links belong on
the invoice; machine-local detail (paths, session ids) is dropped.
`external` would pseudonymize the very titles the client is paying for —
wrong tool. What leaves the machine is the rendered document below,
never raw ledger files.

## Mode 1 — the client invoice pack

From `query report`'s `.data.shipped`, one line item per shipped entry:

| Item | Delivered | Hours (recorded) | AI assistance |
|---|---|---|---|
| KEY — title | PR/deploy link, ship date | `actual_hours` or "—" | role + `metered_cost_usd` (or tokens when unpriced) |

Then three closing lines:

- **Totals** — items, points if the client uses them, summed recorded
  hours (sum only entries that HAVE `actual_hours`; say how many don't),
  and total disclosed AI cost from the rows' `metered_cost_usd`
  (labeled with `pricing_version`, list-price equivalent).
- **AI disclosure** — one sentence: which items Claude touched
  (`claude_role` ≠ "none"), verifiable per item via the disclose skill.
  Billing transparency on AI use is fast becoming a client expectation —
  an invoice that discloses it with receipts beats one that hopes nobody
  asks.
- **Verification offer** — if the client relationship warrants it,
  `export --pack` gives them the one-command integrity check
  (see the report skill). Mention, don't build unprompted.

Rules for this mode:

- Hours are `actual_hours` — recorded facts. NEVER present
  `estimate_without_claude_hours` or `time_saved_hours` as billable
  hours; they are counterfactuals. If no actuals were recorded, the
  hours column says so; it is never back-filled from estimates.
- No rates, no line-item prices, no totals in the client's currency
  unless the user supplies the rate — then the arithmetic is theirs,
  shown as `hours × their-rate`, clearly attributed.
- In-flight work appears only under a separate "In progress (not yet
  billed)" line, and only if the user asks.

## Mode 2 — the personal expense receipt

For "expense my Claude usage" / "AI costs for finance": the user's own
metered costs for the period, shaped for an expense tool:

1. `query spend --from <iso> --to <iso>` — relay total cost with
   `pricing_coverage` honesty (a partial-coverage total names what it
   omits) and the by-model breakdown.
2. `export --format csv --from <iso> --to <iso>` writes the per-account
   rows finance can ingest; tell the user the path, or paste the CSV if
   they ask.
3. One caveat line, always: these are **list-price equivalents** from the
   bundled/configured rate table (`pricing_version`), not a provider
   invoice — the number to reimburse comes from the actual Anthropic/API
   bill; this receipt shows what the spend was *for*, per story and
   model, which is the part a provider invoice can't say.

## Rules

- Facts tier only. Every cell traces to a query field; empty cells say
  "—", never a guess.
- The ledger's job ends at evidence: no payment terms, no tax advice, no
  price suggestions.
- No peer comparisons, ever.
- The salvage skill first if the period has a notable untracked share —
  an invoice built on holey attribution undersells the work.
