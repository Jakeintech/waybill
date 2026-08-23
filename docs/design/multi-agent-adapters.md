# Design: multi-agent ingestion adapters (D-04)

*Design only — no code in this release. The deterministic attribution
guarantee stays scoped to Claude Code until transcript fidelity is
proven per tool.*

## Persona & job-to-be-done

An engineer using more than one coding agent (Claude Code plus a
CLI/IDE agent from another vendor) who wants one spend picture. Their
job today is a spreadsheet; the top-of-funnel statistic ("all my AI
spend, one ledger") is the draw. ccusage-style parsers demonstrate the
demand and the mechanics.

## The honesty problem this design exists to solve

Waybill's core claim is *deterministic attribution from transcripts*.
Other tools' local logs vary wildly in fidelity: some record per-turn
token usage, some only per-request costs, some nothing durable. An
adapter that silently blended lower-fidelity data into the same streams
would spend the credibility the Claude Code path earned. So the design
is fidelity-labeled ingestion, never silent blending.

## Shape

- **Per-tool adapters** parse whatever the tool durably writes (local
  logs/exports) into usage events with `source` set per adapter (the
  existing `source: "transcript" | "otel"` pattern extends additively —
  new source values are a minor change for readers that switch on it).
- **Each adapter declares which guarantees it inherits**, and the doc
  table is the contract. Three tiers:
  1. *Metered + attributable* — per-turn usage with enough context
     (cwd/branch/keys) for the resolver ladder: full guarantee, same as
     Claude Code transcripts.
  2. *Metered only* — trustworthy token totals, no attribution context:
     events land as unattributed-by-construction; reports label the
     source share.
  3. *Reported only* — the tool self-reports costs without raw counts:
     ingested as tokens-only/priced-as-claimed, labeled, excluded from
     conservation (no receipt exists to conserve against).
- **Conservation stays per-source**: Σ attributed = Σ metered holds
  within sources that have receipts; `verify` never pretends a
  reported-only source conserves.
- Every projection that mixes sources says so: "N% of this window's
  volume is non-Claude-Code, tier 2/3" — the same disclosure posture as
  pricing coverage.

## Free vs paid

Adapters are free (individual's own data, individual's machine).
Nothing here is org-side.

## Invariants preserved

- Truthful mechanism claims: the README/positioning scope line
  ("guarantee scoped to Claude Code") holds until a tool's adapter
  demonstrably earns tier 1 with fixtures and a conformance check —
  the adapter conformance kit pattern already exists for trackers.
- Local-first, no telemetry: adapters read local files only.
- Honesty floor: source mix and fidelity tier are disclosed wherever
  the numbers appear.

## Open questions (for the issue)

Which tools have durable-enough local logs to start (candidates ranked
by log fidelity); whether tier-3 data should be ingestable at all or
only displayed alongside; how pricing tables for non-Anthropic models
enter config without bloating the bundled import.
