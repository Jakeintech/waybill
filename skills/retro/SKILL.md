---
name: retro
description: >
  This skill should be used when the user wants an honest look back at a
  finished sprint or period — when they say "run my retro", "sprint retro",
  "retrospective", "how did the sprint actually go", "how did my estimates
  hold up", "estimate calibration", "what did the sprint cost", "which
  model earns its tokens", or "what sat idle". Renders the sprint-retro
  pack from ledger facts: shipped work with cost, pre-registered estimates
  vs. actuals (calibration), model mix, waste and rework, cache economics,
  and what sat unshipped. (Formal artifacts for a decision-maker belong to
  the report skill; the daily "what did I do" belongs to standup; this one
  is the periodic look in the mirror.) Facts only — the unflattering
  numbers are the point.
metadata:
  version: "2.2.0"
---

# Retro

A retro that runs on memory rehashes opinions; one that runs on the ledger
starts from what actually happened. The engine returns the facts for the
window; render them as a short pack the user can bring to their own retro —
including the numbers that didn't go well. No blame, no peers, no spin.

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/waybill" mine --all      # catch-up metering first, always
"${CLAUDE_PLUGIN_ROOT}/bin/waybill" query report --from <iso> --to <iso>
"${CLAUDE_PLUGIN_ROOT}/bin/waybill" query manifest
"${CLAUDE_PLUGIN_ROOT}/bin/waybill" query untracked --from <iso> --to <iso>
```

**Window**: the sprint the user names; "last sprint" from
`config.baseline.window` sprint length if known, else the last 14 days —
state the window in the header either way.

## Render (short sections, in this order)

Work from `query report`'s `.data`:

1. **Shipped** — one line per item from `.data.shipped` (key, title,
   points, PR); then the totals line: points, PRs, tokens, cost if priced.
2. **Estimates vs. reality** — from `.data.calibration`: coverage first
   ("4 of 5 shipped items pre-registered — 80%"), then the positions:
   `below` = the work came in under the no-Claude range (the claimed
   saving held in full), `within` = partial, `above` = **the item took
   longer than the no-Claude estimate** — name those items and say it
   plainly; a retro that hides the above-range items is theater. If
   `with_actuals` lags `pre_registered`, one line: recording
   `actual_hours` at ship time is what makes next sprint's claims
   checkable.
3. **Model mix** — from `.data.model_mix`: tokens-per-point by dominant
   model ("opus-carried stories: 0.9M/pt over 4 stories; sonnet-carried:
   0.4M/pt over 2"). Note `mixed` stories separately. Own history only;
   two rows with one story each is an anecdote, not a comparison — say so.
4. **Waste & rework** — `.data.costs.waste` (retried commands, repeated
   reads) and `.data.costs.reopened_count`, each with one factual line.
   Zero is worth stating ("nothing reopened").
5. **Cache economics** — from `.data.spend_ledger.cache_savings`: one line
   ("cache reads were 61% of volume and saved ~$118 vs. uncached list
   rates — derived at today's rates, covering 94% of cache volume").
   Always label it derived; skip the dollars when `saved_usd` is null.
6. **Still on the truck** — from `query manifest`: open items with spend,
   flagging `sitting` rows ("PLAT-510: 1.2M tokens, idle 16 days"). From
   `query untracked`: the untracked share, with a one-line handoff to the
   salvage skill when it is notable.
7. **Close** — at most three factual process observations drawn ONLY from
   the numbers above (e.g. "estimates covered 80% of shipped work, up
   from nothing", "two items sat idle past the demurrage line"). No
   advice the numbers don't support; the user draws the conclusions —
   it's their retro.

## Rules

- Facts only; every line traces to a query field. If the user adds
  context ("the reopen was a spec change"), include it marked as theirs.
- Above-range calibration entries are never softened or omitted — they
  are the section's reason to exist.
- No peer comparisons, ever. Model mix compares models, not people.
- Sharing beyond the user's own retro: re-run the queries with
  `--audience internal` (or `external`) rather than hand-editing.
- This skill reads; it never writes ledger entries.
