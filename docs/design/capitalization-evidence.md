# Design: capitalization / R&D evidence pack (D-03)

*Design only — no code in this release. Explicit caveat, load-bearing:
**evidence formatting only, no tax advice** — Waybill produces
contemporaneous records; what qualifies, capitalizes, or amortizes is a
question for the org's accountants. Partner posture, not a tax product.*

## Persona & job-to-be-done

A finance or engineering-operations lead assembling evidence for
software-development cost treatment (US Section 174-style amortization,
IFRS/GAAP capitalization, or R&D credit substantiation — jurisdiction
varies, the evidence need doesn't). Their job: show *contemporaneous*
records tying development cost to identifiable projects and time
periods. Today they reconstruct this from Jira exports and payroll
allocations months later; auditors discount reconstructions.

## Why Waybill is unusually suited

The ledger is already everything an evidence pack wants to cite:

- **Contemporaneous** — events are append-only, content-addressed, and
  (2.1) carry an `appended_at` write-time witness; backdating is
  detectable and disclosed.
- **Project-tied** — spend attributes to tracker items with resolver
  and confidence; work items carry type (feature/bug/refactor —
  relevant because maintenance vs development treatment differs).
- **Verifiable** — the recipient (an auditor!) can re-run the integrity
  checks offline from a verification pack. That is a genuinely novel
  property for this audience.

## Shape

A rendering preset over data the engine already holds (the v1.8
"many readers" pattern — no new events):

- **`capex-evidence` report preset**: per window and per work item —
  work_type, shipped artifacts (PRs/deploys with timestamps), metered
  AI cost (tokens and priced USD with coverage disclosed), recorded
  hours where present, evidence-tier labels on everything. Explicitly
  NOT included: any qualification judgment, any percentage-eligible
  claim, any tax vocabulary beyond neutral labels.
- Ships with the caveat rendered into the document header, not just the
  docs: "contemporaneous activity evidence generated from an
  append-only local ledger; qualification and treatment are your
  advisors' determinations."
- Partner posture: the pack is designed to be *handed to* accountants
  and R&D-credit firms as input, and the doc invites those firms to
  specify column needs via issues — Waybill formats evidence, partners
  interpret it.

## Free vs paid

The preset is free (it is a reader over the individual's own ledger,
same as invoice/disclose). An org-level, multi-engineer evidence roll-up
belongs to the team-aggregation product (D-01) and its rules.

## Invariants preserved

- No fabrication: only recorded facts render; missing hours stay
  missing (no imputation from tokens to hours, ever).
- Honesty floor: unattributed spend and pricing coverage appear in the
  pack; ranges stay ranges.
- Truthful mechanism claims: the pack describes the ledger's properties
  exactly (append-only, content-addressed, write-time witnessed) — the
  E-01 lesson applies doubly where auditors read.

## Open questions (for the issue)

Which columns partner firms actually need; whether `work_type` needs a
`maintenance` value distinct from `bug`/`refactor` (schema-additive if
so); how multi-currency pricing should be labeled.
