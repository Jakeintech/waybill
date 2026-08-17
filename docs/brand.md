# Waybill — Brand & Voice

This document keeps the product's language, positioning, and visual identity
consistent across the README, skills, reports, and launch material. The
product's differentiator is trust; the brand's job is to make honesty *felt*,
not claimed.

## The name

A **waybill** is the shipping document that travels with cargo and itemizes
what's aboard and what it costs. Engineers ship; Waybill keeps the itemized
record — every token attributed to the story it shipped. The metaphor carries
both halves of the product (shipping + itemized charges), and the document
itself gives us the visual identity for free.

- Written **Waybill** in prose, **waybill** in code, commands, and package
  names. Skill namespace: `/waybill:log`, `/waybill:spend`.
- Tagline: **"Bring receipts."** Secondary line: *"Every token, itemized to
  the story it shipped."*
- Rejected during the naming pass (2026-08-16): the previous working name
  (colonized by Web3 carbon-credit and ESG products, plus trademark adjacency
  to a major crypto hardware brand); a designation-of-funds word (live
  commercial collision with an AI product-management assistant in the Jira
  space, plus a well-known markdown library); a ship's-bookkeeper word
  (dormant historical collision in cost tooling); several receipt/accounting
  words with live collisions (forms, logging, insurance, attestation).
- Clearance status: searched for live collisions in developer/AI tooling —
  none found; remaining owner checklist before publishing: GitHub org, npm
  and PyPI names, .dev/.app domains, and a trademark screening search (this
  checklist is screening, not legal advice).

## Category & positioning

**Category: token accounting** — bookkeeping for AI-assisted work. Name the
category in launch material and the README; unnamed categories don't get
remembered or searched.

Positioning statement: *For engineers who have to justify their AI budget —
and their year — Waybill is token accounting for AI-assisted work: it meters
every token, attributes it to the story it shipped, and turns receipts into
one-page pitches and reviews. Unlike usage dashboards that stop at totals by
model and project, it connects spend to shipped outcomes — with honesty
enforced in the data model.*

Message hierarchy — always in this order:
1. **Outcome**: win the budget, win the review.
2. **Mechanism**: attribution — every token itemized to a story.
3. **Trust**: the conservation invariant, evidence tiers, pre-registration.

Standing objections, answered up front:
- *"Is this surveillance?"* Own-data-only, by design; no manager mode, ever.
- *"Can't I game it?"* Pre-registration cannot be backfilled; retrospective
  claims are labeled and excluded from pitches by default.
- *"I'm on a subscription — why care about cost?"* Tokens are the currency of
  your allocation either way; USD is shown only as a labeled list-price
  equivalent.

## Brand pillars

1. **Evidence over adjectives.** Every claim carries a receipt or a tier
   label; language without an artifact link doesn't ship.
2. **Your books, not your boss's.** Local-first, own-data-only; the non-goals
   are commitments and part of the brand.
3. **Deterministic where it counts.** Metering and attribution are pure,
   replayable functions; the model writes prose, never the numbers.

## Voice

An honest auditor who's on your side: precise, dry, warm underneath. Numbers
before adjectives. Uncertainty stated plainly, never averaged away. Wit is
allowed; salesmanship is not.

Microcopy patterns:

| Moment | Copy |
|---|---|
| Empty report section | "Nothing shipped in this window. The ledger doesn't pad." |
| Attribution coverage | "11% unattributed — shown, never hidden." |
| Ambiguity handling | "2 sessions in your attribution inbox — one tap each to file them." |
| Budget pacing | "62% of the grant spent, 40% of committed points shipped. Worth a look, not an alarm." |
| Low-data forecast | "Fewer than 5 shipped stories with token data — this forecast is labeled low confidence, because it is." |

Concept names (use consistently): *evidence tiers*, *conservation of tokens*,
*pre-registration*, *open spend*, *attribution inbox* (never "exceptions
queue" in user-facing text), *bootstrap report*.

## Visual identity

The receipt **is** the design system:
- Reports and social assets render as a thermal receipt: monospace type,
  perforated top/bottom edge, ITEMS / SUBTOTAL sections, and a footer line
  such as `EVIDENCE TIER: PRE-REGISTERED · RANGES NOT MIDPOINTS`.
- Palette: paper cream background, ink black text, one audit-highlighter
  accent (marker yellow) used sparingly for the number that matters.
- Wordmark: lowercase monospace `waybill` with a perforation mark; the social
  preview card is simply a receipt.
- The demo GIF needs no narration if it ends on the receipt.

## Launch language

- Launch post: *"I asked for a bigger Claude budget — with receipts."* End on
  the real generated receipt image.
- Talk title: *"Conservation of Tokens: accounting principles for AI
  engineering."*
- Starter issues label: `good first receipt`.
- Competing tools are referred to only as a category ("usage trackers",
  "coding-agent dashboards") — never by name — in all repo-facing material.
