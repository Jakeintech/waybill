# Positioning — the defensible claim

*Written 2026-08 for the 2.1.0 launch. The competitor characterizations
below decay; re-check them before quoting anywhere new.*

## The claim

> Waybill deterministically attributes AI coding-agent token spend to the
> work item that shipped — metered from local transcripts and git
> history, never estimated. Vendor dashboards stop at per-user/per-day;
> engineering-intelligence platforms spread daily spend across tickets
> proportionally. Waybill's numbers are receipts, not estimates.

Every word is load-bearing:

- **deterministically** — the same transcripts and ledger always produce
  the same events, ids and totals; `waybill verify` re-derives them
  offline. No sampling, no model calls, no heuristics in the metering
  path.
- **to the work item that shipped** — attribution lands on tracker keys
  (Jira/GitHub/Linear/GitLab/Azure DevOps/Bitbucket items), each usage
  event carrying its resolver name and confidence; the unattributed
  remainder is shown, never spread.
- **never estimated** — where Waybill cannot attribute, it says
  `unattributed`. It does not prorate a day's spend across the day's
  tickets, and it does not guess.

## What the claim is *not*

An earlier draft said nobody attributes token spend to work items. That
is falsifiable and, as of August 2026, false — several products allocate
AI spend to issues or initiatives. The defensible difference is **how**:
estimation versus receipts.

## The field, evidence-tiered

Waybill's own rule applies to this table: every characterization states
its tier. These are **third-party claims** — drawn from vendor
announcements and public product descriptions as of 2026-08, collected in
the strategic market memo behind this release, and not independently
re-verified from inside this repo. Treat them as *Judgment* tier until
you re-check them; none of them is a fact the engine produced.

| Product | What it does with AI spend (as of 2026-08, third-party claims) | Mechanism |
|---|---|---|
| Vendor usage dashboards (Anthropic Console and peers) | Per-user / per-day / per-model usage and cost | Direct metering, but stops above the work item |
| Swarmia (AI spend allocation, beta announced 2026-08-05) | Allocates AI spend to issues/initiatives | Proportional / heuristic estimation |
| minware | Allocates AI/engineering cost to tickets and initiatives | Proportional modeling over activity data |
| Faros AI | Engineering-intelligence roll-ups incl. AI spend by initiative | Aggregation + allocation models |
| Milestone AI | Attributes AI spend to work streams | Heuristic allocation |
| **Waybill** | Attributes each metered token to the story it served, from the transcript itself; unattributed share disclosed | **Deterministic metering + receipt-backed attribution** (Facts tier — the engine's own output) |

Two structural differences no dashboard row captures:

1. **Local-first, individual-first.** The others are org products reading
   org data. Waybill runs on the engineer's machine, over their own
   transcripts, producing evidence *they* own and hand over — no
   telemetry, no server (see "What Waybill will never do", README).
2. **Verifiability.** A recipient can re-run the integrity checks
   themselves (`export --pack` → `node waybill.mjs verify --home .`,
   offline). An estimate cannot be verified, only trusted.

## Scope honesty

- The deterministic attribution guarantee is scoped to **Claude Code
  transcripts** (subagent transcripts included, 2.1). Other agents'
  usage is roadmap (see the multi-agent adapters design doc) and will be
  labeled by source fidelity, never blended silently.
- Attribution below 100% is normal and disclosed: the unattributed
  percentage appears in every report. That disclosure is the credibility
  of everything else.

## Where the words appear

- README first screen: one clause of the claim, after the real receipt.
- The launch post: the full claim plus engine-generated numbers only.
- This file: the reasoning and the dated field survey.

Sweep rule: the absolute form ("nobody / no tooling / first") must not
appear anywhere in the repo — if you find one, it is a bug in the docs.
