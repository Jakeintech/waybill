# Design: engagement/client tagging (D-02)

*Design only — no code in this release. Free tier.*

## Persona & job-to-be-done

Consultants, agencies, and fractional engineers who work several client
engagements from one machine. Their job: answer "what did the Acme
engagement cost in AI spend, and what shipped for it" — per client, with
a client-facing export that discloses AI use without leaking the other
clients' existence.

## Shape

- **One additive optional entry field**: `engagement` (string key, e.g.
  `"acme-2026q3"`) on ledger entries — a minor release per the schema
  freeze (new optional field). Pins gain the same optional field so
  whole sessions can be booked to an engagement directly.
- **Per-engagement rollup**: the existing projections learn an
  `--engagement <key>` filter (spend, report, invoice-backing data). No
  new stream, no new event kind: an engagement is a grouping of entries
  the user already writes.
- **Client-facing export at `audience external`**: the existing
  redaction path already pseudonymizes tracker keys/repos and drops
  titles; an engagement-filtered external report is the client
  deliverable. The filter must be *subtractive before redaction*: events
  outside the engagement never enter the payload, so no cross-client
  identifier — even pseudonymized — appears.
- The `invoice` and `disclose` skills accept the same filter, so billing
  paperwork and AI-disclosure registers become per-client documents.

## Free vs paid

All of it free: this is an individual's own ledger sliced by their own
tag. (If team aggregation later exists, engagement keys aggregate like
epics — nothing here creates a paid dependency.)

## Invariants preserved

- Schema freeze: additive optional field only; absent on every existing
  event; ids never churn.
- Honesty floor: per-engagement reports keep the unattributed share *of
  that engagement's window*, and state the filter in the header — a
  filtered report must say it is filtered.
- No fabrication: engagement membership is only ever explicit (field on
  the entry or pin). No inference from repo names or clients guessed
  from branch text — a wrong client attribution is worse than an
  unattributed one.
- Local-first: nothing new leaves the machine; the client export is a
  file the user hands over, same as today's reports.

## Open questions (for the issue)

Whether `--engagement` also filters `query cache` (probably yes, same
mechanics); whether an engagement registry (names, date ranges) belongs
in config.json or stays convention; how the invoice skill should label
mixed windows (entries with and without the field).
