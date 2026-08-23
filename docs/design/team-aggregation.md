# Design: team aggregation (D-01)

*Design only — no code in this release. The future paid anchor
(Infracost-Cloud shape: the CLI stays free and complete; the org-side
roll-up is the product).*

## Persona & job-to-be-done

An engineering manager or platform lead who already receives Waybill
receipts from individuals — token pitches, verification packs — and now
wants the org view: spend by team/initiative, budget pacing across
grants, renewal planning. Their job: allocate the next AI budget with
evidence instead of vendor-dashboard per-user totals.

## Governing principle

**Aggregate receipts, never transcripts.** Individuals push signed,
derived receipts to an org-controlled store; no transcript ever leaves a
machine; self-hosted.

Concretely: the unit that travels is a *published ledger* — the
externally-redacted export or a verification pack the individual chose
to produce — never `~/.claude/` content, never raw session text, never
anything the individual didn't explicitly publish. The store is the
org's (self-hosted); Waybill-the-project operates no service.

## Shape

- Individuals run today's free Waybill unchanged. A `publish` action
  (explicit, per window, per audience level) signs a derived receipt
  bundle and pushes it to the org store — the same consent posture as
  handing over a pack today, made repeatable.
- The org side ingests only receipt bundles that verify (ids recompute,
  conservation holds, seals check) and aggregates: spend by
  team/epic/initiative, utilization vs grants, renewal calendar, pitch
  inbox (incoming verification packs).
- Roll-ups inherit the honesty floor: unattributed percentages,
  coverage, and confidence labels survive aggregation; ranges are never
  collapsed; nothing is imputed for engineers who didn't publish — the
  roll-up says "N of M engineers publishing" instead.

## Free vs paid

- **Free, forever:** everything an individual runs — metering,
  attribution, reports, packs, the publish/sign action itself (an
  individual must never need a paid seat to hand their own evidence to
  their own org).
- **Legitimately paid later:** the org-side store and views —
  aggregation, budget desk, showback, compliance roll-ups, SSO/retention
  for the store. Per the roadmap's rule: premium never sees a number an
  individual didn't publish, and free never loses a feature to upsell.

## Invariants preserved

- Local-first: the engine still makes no network calls; publishing is a
  separate, explicit, user-initiated push to a host the org controls.
- No surveillance: aggregation is a gift from ICs, never a tap on them;
  no per-individual peer comparison surfaces exist in the org views.
- Schema freeze: bundles are today's frozen event schema; the org side
  is a reader, adding nothing to the event contract.
- Verifiability: the org store re-runs `verify` on ingest — aggregation
  of unverified receipts is refused, not blended.

## Open questions (for the issue)

Signing key management (per-machine keys vs org-issued), bundle
revocation/supersession semantics across pushes, and whether the pitch
inbox is a store feature or an email convention. None block the free
side; all belong to the org product's design cycle.
