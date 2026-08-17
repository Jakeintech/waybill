# Waybill — Product Specification

| | |
|---|---|
| **Status** | Draft for implementation (releases 0.3 → 1.0) |
| **Owner** | Jakeintech |
| **Last updated** | 2026-08-16 |
| **Scope of this document** | The full product, with normative detail on the spend-attribution engine (new in 0.3) |

## 1. Summary

Waybill is a Claude Code plugin that answers two questions with evidence
instead of recall: **"what did I ship?"** and **"what did each token buy?"**
It maintains — automatically — a local, append-only ledger that meters every
token Claude Code consumes, attributes that spend to the business unit of
work it served (a Jira story, an epic, a sprint), reconciles the work itself
against tracker and git-host receipts, and generates one-page reports:
token-budget pitches, performance reviews, sprint recaps, and spend
analytics.

Existing usage trackers stop at descriptive totals — spend by day, model,
activity type, or project directory. A directory is not a unit of business
value. The unmet need, and this product's core, is **attribution**: joining
token spend to tracked work items and their outcomes (points shipped, PRs
merged, deploys), maintained with zero manual effort, honest about its own
uncertainty, and reconcilable to the token.

## 2. Users

- **Priya, IC engineer (primary).** Uses Claude Code daily. Her org
  allocates tokens by demonstrated value; she also has quarterly reviews.
  She will not maintain a spreadsheet. Everything must be automatic or
  one-line.
- **Sam, budget holder (reader).** Approves token grants and reads perf
  packets. Has been burned by inflated claims; rewards verifiable brevity.
  Never touches the tool — only its outputs.
- **A contributor (secondary).** Adapts the plugin to another tracker or
  git host; needs clean seams and deterministic components to test.

## 3. Product pillars and principles

**Pillars:** (P1) automatic metering & attribution of spend, (P2) the
evidence ledger of work, (P3) outputs — reports, pitches, forecasts, spend
analytics.

**Principles (normative):**

1. **Conservation of tokens.** Every metered token lands in exactly one
   attribution account, including the explicit `unattributed` account.
   Per-session sums must reconcile with the raw source. No token is dropped,
   double-counted, or silently guessed into a story.
2. **Deterministic before intelligent.** Metering and attribution are pure,
   scriptable functions of (inputs, rules_version): no LLM calls, replayable,
   testable. Claude is used only to resolve *flagged ambiguities*
   interactively and to write prose.
3. **Evidence tiers everywhere.** Facts (token counts, timestamps) are
   reported plainly; inferences (attribution) carry a resolver name and a
   confidence; counterfactuals stay ranged and pre-registered. Uncertainty is
   displayed, never averaged away.
4. **Local-first, own-data-only.** All data under `$WAYBILL_HOME`.
   Network access is limited to MCP calls the user authorizes, scoped to
   their own items. No telemetry, no hosted service.
5. **Zero-effort steady state.** After setup, a user who never runs a manual
   command still accumulates a correct, attributed spend ledger. Manual
   actions only *improve* precision (pinning, pre-registration).
6. **Append-only.** Facts and corrections accumulate; nothing is rewritten.
   Every rollup is a rebuildable projection of the fact streams.

## 4. Goals and non-goals

**Goals**

- G1. Meter 100% of Claude Code token usage on the machine, exact to the
  source records, within one session of it occurring.
- G2. Attribute ≥ 85% of metered tokens to a tracker key or named ad-hoc
  account at confidence ≥ 0.6 after two weeks of normal use, with the
  remainder explicitly `unattributed` (never misassigned).
- G3. Answer "what did `<story>` cost?" and "where did this week's tokens
  go?" in one interaction, from local data.
- G4. Track spend against the granted allocation (and optional per-epic
  envelopes) with pacing, surfaced at natural moments — never as nagging.
- G5. Feed metered rates into forecasts (tokens per story point) with no
  manual token entry.
- G6. Keep first-run time-to-value under five minutes (bootstrap report).
- G7. Remain fully functional degraded: no tracker/git MCP → metering and
  attribution by branch/pin still work.

**Non-goals (permanent, by design)**

- No manager dashboards, surveillance, activity monitoring, or peer
  comparison. Individual attribution exists to serve the individual.
- No multi-assistant coverage. Depth on Claude Code over breadth across
  tools; the schema is source-tagged so this could change, but it is not a
  goal.
- No real-time rate-limit pacing of rolling usage windows. Budgets here are
  allocation-period budgets tied to business work, a different job.
- No hosted service, accounts, or telemetry. No keystroke/time tracking.
- No backfilled `pre_registered` estimates and no fabricated attribution:
  `unattributed` is a respectable account.

## 5. Functional specification

### 5.1 Metering (FR-M)

- **FR-M1 — Primary source: session transcripts.** The meter streams Claude
  Code's local session records and extracts, per assistant message: message
  id, timestamp, model, and the usage block — `input_tokens`,
  `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`,
  and, when present, the cache-write duration split
  (`cache_creation.ephemeral_5m_input_tokens`,
  `ephemeral_1h_input_tokens`). Unknown extra fields are preserved
  under `raw_extra` rather than dropped.
- **FR-M2 — Secondary source: OpenTelemetry (optional).** When the user has
  Claude Code telemetry enabled, per-request token metrics (broken down by
  type and model) and the per-prompt correlation id MAY be ingested.
  **Dedupe rule:** the transcript is the source of truth for any session
  that has one; OTel fills only sessions/periods with no transcript (e.g.
  pruned files). Each usage event records its `source`; a session never
  mixes sources.
- **FR-M3 — Incremental & idempotent.** `meter_state.json` checkpoints each
  session (last processed message id + byte offset). Re-running the meter
  processes only new messages; a full re-run from empty state reproduces the
  identical fact stream (given the same `rules_version` and inputs).
- **FR-M4 — Automatic trigger.** The SessionEnd hook queues the session and
  invokes the meter asynchronously (fire-and-forget; never blocks or fails
  the session). Any spend/report/forecast skill first runs a catch-up pass,
  so results are current even if a background run was missed.
- **FR-M5 — Pricing.** Cost in USD is derived as tokens × the effective
  pricing table in config (per-model rates for input, output, cache read,
  and 5-minute/1-hour cache writes, with effective dates and a
  `pricing_version`). Unknown model → tokens reported, `cost_usd: null`,
  never guessed. For subscription users, token-denominated reporting is the
  default and USD is labeled "list-price equivalent."
- **FR-M6 — Aggregation grain.** One usage event per (turn, model,
  attribution account). A turn is the span from one user prompt to the next;
  subagent activity within a turn rolls up to that turn's account.

### 5.2 Attribution (FR-A)

- **FR-A1 — Accounts.** `story:<KEY>` (rolls up to `epic:<KEY>` and sprint
  via sync data), `adhoc:<label>` (named untracked work), `unattributed`.
- **FR-A2 — Resolver precedence.** For each metered turn, the first rule
  that fires assigns the account and confidence:

  | # | Resolver | Signal | Confidence |
  |---|---|---|---|
  | 1 | `pin` | User pinned this session/time-range to a key ("pin this session to PLAT-482") | 1.00 |
  | 2 | `active_entry` | Exactly one `opened` ledger entry matches the session's repo | 0.90 |
  | 3 | `transcript_evidence` | Tracker key in branch checkouts, commit messages, or PR operations found in the session's tool calls; applies forward from the evidence point | 0.75 |
  | 4 | `session_branch` | Key parsed (via `branch_key_pattern`) from the git branch captured by the SessionEnd hook | 0.60 |
  | 5 | `repo_default` | `config.metering.repo_defaults[repo]` mapping | 0.40 |
  | 6 | `none` | — | `unattributed`, 1.00 |

- **FR-A3 — Segmentation.** Rule-3 evidence splits a session: turns after a
  detected branch/key switch attribute to the new key. A turn is never
  split; it belongs to the account active at the turn's start.
- **FR-A4 — Ambiguity handling.** If a rule yields multiple candidates
  (e.g. two open entries for the repo), the resolver falls through to the
  next rule and appends the turn to an **attribution inbox**. The next
  interactive spend/log session presents queued exceptions for one-tap
  resolution; resolutions are written as `correction` events and, at the
  user's option, as a durable pin or repo default.
- **FR-A5 — Re-attribution.** Corrections are new events with `supersedes`.
  Changing rules or configs never rewrites history; the user may request a
  re-run that emits corrections computed under the new `rules_version`.
- **FR-A6 — Conservation check.** After metering a session:
  Σ(usage events) must equal Σ(source usage). Mismatches emit a
  `meter_discrepancy` record and surface in the next interaction. This check
  is CI-tested with fixture transcripts.

### 5.3 Data model (FR-L)

Fact streams (append-only JSONL) and projections under
`$WAYBILL_HOME`:

```
ledger.jsonl        # work entries (existing schema: opened/shipped/…)
usage.jsonl         # usage events (new)
exceptions.jsonl    # queued attribution ambiguities + resolutions
meter_state.json    # per-session checkpoints, rules/pricing versions
config.json         # scope, pricing, budgets, metering rules
rollups/            # derived caches; deletable, always rebuildable
pending-sessions/   # raw SessionEnd captures (existing)
```

**Usage event schema (v2, normative):**

```json
{"id":"ue-20260817T101503Z-9a2c","ts":"2026-08-17T10:15:03Z",
 "session_id":"9f4c…","turn":{"first_message_id":"…","last_message_id":"…","prompt_id":null},
 "repo":"acme/platform","model":"<model-id>",
 "tokens":{"input":41200,"output":6300,"cache_read":181000,
           "cache_creation":22000,"cache_creation_5m":22000,"cache_creation_1h":0},
 "cost_usd":{"value":0.3121,"pricing_version":"2026-08-01"},
 "attribution":{"account":"story:PLAT-482","tracker_key":"PLAT-482",
                "resolver":"active_entry","confidence":0.9,"rules_version":"1"},
 "source":"transcript","kind":"usage","supersedes":null}
```

Field naming follows the same input/output/cache-read/cache-creation
taxonomy as OpenTelemetry's GenAI conventions and Claude Code's own records,
so the schema round-trips cleanly to a warehouse later (team mode).

**Config v2 additions:**

```json
{"metering":{"enabled":true,"sources":["transcript"],
             "branch_key_pattern":"[A-Z][A-Z0-9]+-[0-9]+",
             "repo_defaults":{"acme/platform":null}},
 "pricing":{"version":"2026-08-01","unknown_model_policy":"tokens_only",
            "models":{"<model-id>":{"input_per_mtok":0,"output_per_mtok":0,
              "cache_read_per_mtok":0,"cache_write_5m_per_mtok":0,
              "cache_write_1h_per_mtok":0}}},
 "budgets":{"allocation":"inherit","epics":{"PLAT-401":5000000}}}
```

Ledger schema changes: work entries gain optional `budget_tokens`; the
manual `tokens` field remains as an override but metered totals (joined via
`attribution.tracker_key`) are preferred and labeled as such.

### 5.4 Budgets & pacing (FR-B)

- FR-B1. The allocation in `config.allocations` is the default budget;
  optional per-epic envelopes refine it.
- FR-B2. Pacing = spend-to-date vs. linear pace across the period, plus a
  work-weighted pace when sprint commitments are known ("62% of grant spent,
  40% of committed points shipped").
- FR-B3. Surfacing: in every report's Costs section; on demand ("how's my
  burn?"); and as a one-line notice at the start of the next interactive
  session after a threshold (80%, 100%) is crossed. Hooks never interrupt or
  block work to nag.

### 5.5 Spend analytics — canonical questions (FR-Q)

Each must be answerable in one interaction from local projections:

1. Spend by story / epic / sprint / model / week (tokens and, when priced,
   USD), with attribution-confidence noted.
2. "What did `<KEY>` cost?" — total, by model, cache-read share, and cost
   per story point if shipped.
3. Top-N accounts by spend for a window; `unattributed` always shown, never
   hidden.
4. **Open spend**: tokens attributed to stories not yet shipped — the
   at-risk number.
5. Efficiency trends: tokens per shipped point, per merged PR; cache-read
   ratio per account.
6. Attribution health: % attributed by confidence band; attribution inbox
   size.

### 5.6 Reports & forecast integration (FR-R)

- FR-R1. `token-pitch` gains a **Spend ledger** section: allocation,
  spend-to-date and pacing, top accounts with receipts, open spend, and
  unattributed %. Honesty rules apply: confidence bands stated, tokens-first
  denomination.
- FR-R2. `forecast` computes tokens-per-point from metered, attributed data
  (last ≥5 shipped stories), replacing manual token entry; low-data labeling
  unchanged.
- FR-R3. Bootstrap report includes a spend section from day one, since
  transcripts predate installation: historical sessions are metered
  retroactively, attributed at rule-3/4 confidence.

### 5.7 Skill surface (FR-S)

| Skill | New/changed | Canonical triggers |
|---|---|---|
| `spend` | **new** | "where am I spending", "tokens by story", "what did PLAT-482 cost", "how's my burn", "spend report", "resolve attribution exceptions" |
| `log` | + pinning | "pin this session to PLAT-482", "unpin" |
| `report` | + spend ledger section | unchanged |
| `forecast` | metered rates | unchanged |
| `sync` | + story→epic/sprint map refresh | unchanged |

The meter itself is **not** a skill: it is a deterministic script
(`scripts/meter`, POSIX-runnable, stdlib-only) invoked by the hook and by
skills, so the automatic path involves no model calls.

## 6. Pipeline architecture

```
SessionEnd hook ──► pending-sessions/ ──► scripts/meter (async, deterministic)
                                              │  reads transcripts + checkpoints
                                              │  resolves attribution (rules_version)
                                              ▼
                              usage.jsonl / exceptions.jsonl / meter_state.json
                                              │
            skills (spend / report / forecast / log)
            run catch-up meter, read facts, rebuild rollups/,
            resolve exceptions interactively, write corrections
```

Failure isolation: the hook only queues (exit 0 always); a meter crash
leaves checkpoints intact and is retried at next catch-up; skills degrade to
last-known facts and say so.

## 7. Non-functional requirements

- **NFR-1 Accuracy.** Metering is exact to source records (asserted by the
  conservation check). Attribution accuracy is *expressed*, not promised:
  every event carries resolver + confidence; the target in G2 is measured by
  the attribution-health query.
- **NFR-2 Performance.** Streaming, O(new messages); typical per-session
  catch-up < 2s; a 90-day retroactive bootstrap completes in one sitting on
  commodity hardware.
- **NFR-3 Idempotency & reproducibility.** Same inputs + rules_version +
  pricing_version ⇒ byte-identical fact stream. `rollups/` is disposable.
- **NFR-4 Reliability.** The hook path can never block, slow, or fail a
  session; all writes are line-atomic appends.
- **NFR-5 Privacy.** Local-only data; metering reads transcripts on the
  user's machine and stores counts, ids, keys, and models — never prompt or
  response content — in `usage.jsonl`.
- **NFR-6 Auditability.** Any number in any report is traceable to fact-event
  ids on request; corrections preserve the full history.
- **NFR-7 Compatibility.** The fact schemas are the semver surface: additive
  = minor, migration = major (this spec introduces schema v2 as a minor,
  additive change).
- **NFR-8 Portability.** Tracker keys are opaque strings matched by
  configurable pattern; nothing assumes Jira beyond the bundled defaults.

## 8. UX flows (acceptance narratives)

1. **Zero-touch week.** Priya installs, initializes, and works normally for
   a week without a single ledger command. She asks "where did this week's
   tokens go?" → per-story table with confidence bands, unattributed 11%,
   two exceptions offered for one-tap resolution.
2. **Story cost.** "What did PLAT-482 cost?" → 2.9M tokens ($X list-price
   equivalent), 61% cache reads, shipped at 5 points → 0.58M tokens/point,
   below her trailing median; one line, receipts linked.
3. **Pacing nudge.** She crosses 80% of the grant with 55% of the sprint's
   points shipped. Next session opens with one line: pacing status + the
   biggest open-spend story. No pop-ups, no blocking.
4. **The pitch.** "Build my token pitch" → one page: shipped-with-receipts,
   efficiency trend from metered data, spend ledger with pacing, forecasted
   ask. Sam can audit any number in two clicks.

## 9. Success metrics

- Attribution coverage ≥ 85% at confidence ≥ 0.6 by week two (G2), with
  `unattributed` trending down, not hidden.
- Conservation check: zero unexplained discrepancies in steady state.
- Time-to-first spend report < 5 minutes from install (G6).
- Steady-state manual maintenance: zero required actions per week.
- Exceptions queue: median time-to-empty < one interactive session.

## 10. Edge cases & decisions

| Case | Decision |
|---|---|
| Story switch mid-turn | Turn attributes to the account active at turn start; never split a turn. |
| Two open entries, same repo | Ambiguity → fall through + attribution inbox (FR-A4). |
| Unknown model pricing | Tokens reported; `cost_usd: null`; report labels it. Never guess. |
| Transcript pruned/rotated | OTel fallback if configured; otherwise a `meter_gap` record — gaps are visible, not papered over. |
| Both transcript and OTel present | Transcript wins for the session (FR-M2); no mixing. |
| Subagents / parallel work | Roll up to the parent turn's account; correlate via the per-prompt id when available. |
| Context compaction overhead | Metered like any usage, attributed to the surrounding account; visible in cache/input ratios. |
| Subscription (no per-token billing) | Token-first display; USD shown only as labeled list-price equivalent. |
| Multi-repo session | Rule-3 evidence segments by repo/branch switches; otherwise per-repo defaults. |
| User disputes an attribution | One-tap correction → `correction` event + optional durable pin/default; history preserved. |

## 11. Milestones & acceptance criteria

**M1 — 0.3 "Metered" (core engine).** `scripts/meter` with transcript
source, checkpoints, resolver rules 1–6, conservation check, retroactive
bootstrap; `usage.jsonl`/`exceptions.jsonl`/config v2; hook invokes meter
async. *Accept:* fixture-transcript CI suite proves conservation,
idempotency, segmentation, and every resolver rule; a 90-day retro run on a
real machine completes and reconciles.

**M2 — 0.4 "Answerable".** `spend` skill (all FR-Q questions + exception
resolution), pinning in `log`, budgets/pacing, spend ledger in
`report`, metered rates in `forecast`, OTel secondary source. *Accept:* UX
flows 1–4 pass as scripted acceptance tests; pitch renders with spend
ledger from real data.

**M3 — 1.0 "Trustworthy at scale".** Skill trigger evals in CI; per-account
waste diagnostics (retry loops, duplicate reads — deterministic pattern
detection over tool calls); allocation-cycle reminder flow; schema
freeze + migration policy documented. *Accept:* trigger-eval pass rate
thresholds met; docs complete; two external adapter configs tested.

## 12. Open questions

1. Should rule-3 evidence also read PR/issue references from MCP tool calls
   (tracker operations inside the session), and at what confidence?
2. Per-epic envelope defaults: derive from forecast automatically, or
   config-only?
3. Retention: offer optional compaction of usage events older than N months
   into signed monthly rollups (still append-only)?
4. Pricing-table update UX: manual edit only, or a guided refresh flow with
   a documented source-of-truth?

## 13. Glossary

**Account** — the attribution target of spend (`story:KEY`, `adhoc:label`,
`unattributed`). **Turn** — one user prompt and everything until the next.
**Conservation** — Σ attributed = Σ observed, per session. **Projection** —
a derived, rebuildable rollup of fact streams. **Pin** — a user assertion
binding a session/time-range to an account at confidence 1.0.
**Open spend** — tokens attributed to not-yet-shipped stories.
