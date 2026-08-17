---
name: ledger
description: >
  This skill should be used for anything involving the waybill ledger's storage,
  entry schema, configuration, or integrity rules — when the user asks to
  "initialize my waybill ledger", "set up waybill", "what's in my ledger",
  "what have I logged", "show my ledger", "verify my ledger", or whenever
  another waybill skill (log, sync, report, forecast) needs to read or write
  ledger data.
metadata:
  version: "0.3.0"
---

# The Waybill Ledger

The ledger is a local, append-only record of the user's shipped work,
Claude's metered token usage, and the attribution joining the two. It exists
to make value claims *checkable*: every number in a report traces to an
event id, every event id recomputes from its content, and every metered
token is conserved (Σ attributed = Σ observed, per session).

## The engine

All deterministic operations go through the bundled dependency-free CLI —
never hand-build ids or hand-append JSONL (hand-built events fail
verification):

```bash
WAYBILL="node ${CLAUDE_PLUGIN_ROOT}/bin/waybill.mjs"
$WAYBILL init         # create/refresh the ledger home
$WAYBILL bootstrap    # receipt from local git history (zero auth)
$WAYBILL mine --all   # catch-up: meter every local transcript
$WAYBILL append --stream ledger --event '<json>' --commit   # the write path
$WAYBILL verify       # full integrity + conservation check
$WAYBILL query <question> --json   # projections for reports (see report skill)
```

## Storage layout

All data lives under `$WAYBILL_HOME`, defaulting to `~/.waybill/`, itself a
git repo (the audit trail). Streams are monthly-sharded, append-only JSONL;
every event has a deterministic ULID `id` and `schema_version: 2`:

```
~/.waybill/
├── config.json              # scope, pricing, budgets, metering rules
├── identity.json            # git emails, GitHub login, Jira accountId
├── streams/
│   ├── ledger/YYYY-MM.jsonl     # work entries, pins, corrections
│   ├── usage/YYYY-MM.jsonl      # metered usage events
│   ├── sessions/YYYY-MM.jsonl   # per-session receipts (source totals)
│   └── exceptions/YYYY-MM.jsonl # attribution inbox, discrepancies, gaps
├── meter_state.json         # per-session checkpoints
├── rollups/                 # derived caches; deletable
└── pending-sessions/        # raw SessionEnd captures awaiting mining
```

Read `references/schema.md` (in this skill's directory) before constructing
any entry, and `references/methodology.md` before making any claim about
time saved or work "with vs. without Claude".

## Initialization

When the user asks to initialize or set up the ledger:

1. Run `$WAYBILL init`. It creates the home as a git repo, seeds
   `identity.json` from `git config` (plus `gh` login if already
   authenticated — never start an auth flow), seeds the repo scope from the
   current repo, and reports the transcript-retention setting.
2. Relay the retention result faithfully: if `cleanupPeriodDays` is 0, warn
   that transcripts are deleted immediately and metering will only cover
   sessions mined before deletion; otherwise recommend raising it (e.g.
   99999) so history stays meterable. Never change the user's Claude Code
   settings yourself; tell them the exact edit.
3. Offer the zero-auth first value immediately: `$WAYBILL bootstrap` renders
   a receipt from local git history in under a minute.
4. Only then, optionally interview for the upgrade path (one question at a
   time, skip anything derivable): Jira project keys, GitHub repos, default
   branch, allocation history for utilization reporting. Update
   `config.json` fields the user confirms (read, modify the specific field,
   write back, validate with `jq -e .`).
5. Commit happens automatically; nothing else to do.

## Reading the ledger

Use `jq` over `streams/*/*.jsonl` for ad-hoc reads. Rules:

- Resolve supersedes: an event is authoritative iff no other event's
  `supersedes` points at its `id`. When multiple entries share a
  `tracker_key`, the latest authoritative one wins.
- Totals: sum `points` and token classes; sum `time_saved_hours.low` and
  `.high` **separately** — never average them into a single number.
- Metered token totals come from the usage stream (joined via
  `attribution.tracker_key`), not from the manual `tokens` field; label
  which one a report used.

## Writing to the ledger

1. Construct the event body per `references/schema.md` — without an `id`
   (ids are derived from content). Unknown values are `null`, never guessed.
   Never invent tracker keys, points, or PR URLs.
2. Append via `$WAYBILL append --stream <stream> --event '<json>' --commit`.
   It validates the envelope, seals pre-registered estimates with a SHA-256
   escrow hash, refuses backdated pre-registration, assigns the ULID,
   appends to the right shard, and commits.
3. Never edit or delete an existing line. Corrections are new events with
   `kind: "correction"` and `supersedes` set to the old event's `id`.

## Integrity invariants (enforce these everywhere)

- **Append-only.** History is the product; rewriting it destroys credibility.
- **Conservation.** Every metered token lands in exactly one account,
  including `unattributed`. Never re-bucket tokens by hand.
- **Evidence or null.** A `time_saved_hours` value requires a `basis`; an
  artifact list requires real URLs the user or MCP tools provided.
- **Ranges, not points.** Counterfactual estimates are always `{low, high}`.
- **Own data only.** The ledger records the user's work. Never query, store,
  or compare individual colleagues' issues, PRs, or stats — decline and point
  to `references/methodology.md` if asked.
- On any doubt about ledger health, run `$WAYBILL verify` and report its
  findings verbatim.
