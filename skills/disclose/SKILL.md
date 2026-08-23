---
name: disclose
description: >
  This skill should be used when the user needs to answer "was AI used on
  this work, and how much" — when they say "was AI used on PLAT-482",
  "build my AI disclosure", "AI disclosure register", "AI involvement
  report", "how much of this did Claude write", "declare AI assistance for
  this PR", or when a policy, client, reviewer, or open-source project
  asks them to state AI involvement. Renders the per-item disclosure the
  ledger already proves: claude_role, metered sessions and tokens, token
  share, evidence line. Owned by the individual and handed over per item —
  never a surveillance feed.
metadata:
  version: "2.1.0"
---

# Disclose

"Was AI used here?" is being asked by more policies every quarter —
journal submissions, open-source projects, client contracts, internal
AI-use registers. Most people can only answer from memory. A waybill user
answers from the meter: per shipped item, what Claude's role was and what
it metered, conservation-checked. The register is the individual's to
produce and hand over **per item, on their initiative** — disclosure is
something the user does, never something done to them.

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/waybill" mine --all      # catch-up metering first, always
"${CLAUDE_PLUGIN_ROOT}/bin/waybill" query report --from <iso> --to <iso> --audience internal
"${CLAUDE_PLUGIN_ROOT}/bin/waybill" query story <KEY>          # single-item disclosure
```

## Single item — "was AI used on KEY?"

One paragraph, from the item's shipped row (`query report`, or
`query story <KEY>` for the spend detail):

> **PLAT-482 — Retry logic for checkout webhook.** Claude role:
> **co-wrote**. 2 metered sessions, 1.5M tokens attributed
> ($4.20 list-price equivalent, rates 2026-08-01). Shipped 2026-08-12
> ([PR #1932](…)). Metering is deterministic and conservation-checked
> (`waybill verify`); attribution confidence and the event ids behind
> this statement are available on request.

`claude_role` is the user's own declaration, recorded at logging time —
say "recorded role", not a measured fraction of authorship. The measured
part is sessions/tokens; keep the two clearly labeled. A role of `none`
with metered tokens deserves one honest line ("tokens metered on this
story, role recorded as none — likely research/review context") rather
than silent omission.

## The register — a window's disclosure table

From `.data.shipped`, one row per item:

| Item | Role (recorded) | Sessions | Tokens | Token share | Shipped |
|---|---|---|---|---|---|
| KEY — title | co_wrote | 2 | 1.5M | 34% of window | date + PR |

- **Token share** = row `metered_tokens` / `costs.window_tokens` — label
  the denominator ("of this window's metered spend"). Never present it as
  "% of the code Claude wrote"; tokens measure assistance volume, not
  authorship.
- Include items with role `none` — a register that lists only AI-touched
  items can't prove a negative. "No AI assistance recorded" is the
  valuable answer for those rows.
- Footer, always: metering basis (deterministic, from local transcripts,
  conservation-checked), the window, `pricing_version` if dollars appear,
  and unattributed % — a register hiding unattributed spend isn't a
  register.

## Audiences

- Inside the org / a client who owns the work: `--audience internal`
  (keys, titles, PRs stay — the disclosure is *about* those items).
- Outside (journal, OSS maintainer, conference): `--audience external` —
  identifiers pseudonymized, numbers and roles survive; note that the
  named version exists on request. For a single public PR, quoting the
  one item with its real identifiers is the user's call — remind them
  which level the text was rendered at.
- Handing the register to a manager or compliance team is the user's
  decision, made per request. Never build a standing feed, never
  aggregate colleagues' disclosures, never answer "was AI used on
  <someone else's> work" — methodology §6 applies in full.

## Rules

- Roles are recorded declarations; tokens/sessions are metered facts;
  the two are never blended into an invented "AI percentage".
- Zero is a real answer. Memory is not — if an item predates metering
  (or its transcript was pruned: `meter_gap`), say the meter can't attest
  it rather than guessing.
- No peer comparisons, ever.
- This skill reads; it never writes ledger entries.
