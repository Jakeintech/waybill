# Ledger Schemas (v2)

Schema version: **2** (every event carries `schema_version: 2`). The fact
schemas are the semver compatibility surface: additive changes are minor
releases, migrations are major.

## Storage layout

All data lives under `$WAYBILL_HOME`, defaulting to `~/.waybill/`, which is
itself a git repository (the audit trail):

```
~/.waybill/
├── config.json              # scope, pricing, budgets, metering rules
├── identity.json            # who "me" is across systems (identity map)
├── streams/                 # append-only fact streams, monthly-sharded
│   ├── ledger/2026-08.jsonl     # work entries, pins, corrections
│   ├── usage/2026-08.jsonl      # metered usage events
│   ├── sessions/2026-08.jsonl   # per-session receipts (source totals)
│   └── exceptions/2026-08.jsonl # attribution inbox, discrepancies, gaps
├── meter_state.json         # per-session checkpoints; rules/pricing versions
├── rollups/                 # derived caches; deletable, always rebuildable
└── pending-sessions/        # raw SessionEnd captures awaiting mining
```

**Sharding rule.** An event is appended to `streams/<stream>/<YYYY-MM>.jsonl`
where `YYYY-MM` is the UTC month of the event's `ts`. Events are never moved
between shards; a shard is append-only.

**Envelope.** Every event in every stream has at least:

| Field | Type | Notes |
|---|---|---|
| `id` | string | 26-char Crockford-base32 ULID. Deterministic: timestamp bits from `ts`, entropy bits from SHA-256 of the stream name + the event's canonical content (excluding `id`). Same content ⇒ same id, always. |
| `ts` | string | ISO 8601 UTC timestamp of the event being recorded. |
| `kind` | string | Stream-specific enum, below. |
| `schema_version` | number | `2`. |
| `supersedes` | string \| null | `id` of the event this one corrects/replaces. |

**Append-only.** Never edit or delete a line. Corrections are new events
with `supersedes` set. The authoritative event for a logical item is the
latest non-superseded one.

## Ledger stream (`streams/ledger/`)

`kind`: `opened` | `progress` | `shipped` | `correction` | `pin`.

Work entries (`opened`/`progress`/`shipped`/`correction`) carry the envelope
plus:

| Field | Type | Required | Notes |
|---|---|---|---|
| `title` | string | yes | Human-readable summary. |
| `tracker_key` | string \| null | no | e.g. `PLAT-482`. Opaque string; pattern configurable. Null for untracked work. |
| `epic_key` | string \| null | no | e.g. `PLAT-401`. |
| `epic_name` | string \| null | no | e.g. "Checkout reliability". |
| `sprint` | string \| null | no | e.g. `2026-S17`. |
| `repo` | string \| null | no | `org/name`, or a local path identity for git-only mode. |
| `work_type` | enum | yes | `feature` \| `bug` \| `refactor` \| `review` \| `incident` \| `docs` \| `research` \| `other`. |
| `points` | number \| null | no | Story points as recorded in the tracker. Never self-assigned. |
| `artifacts` | object | yes | `{ "prs": [urls], "commits": [shas], "deploy": url-or-tag-or-null, "docs": [urls] }`. Empty arrays are fine; fabricated URLs are not. |
| `estimate_without_claude_hours` | object \| null | no | `{ "low": n, "high": n, "logged_at": iso-ts, "pre_registered": bool }`. `pre_registered` is true only if logged **before** the work was done with Claude. |
| `escrow` | object \| null | no | Present when a pre-registered estimate was sealed. See below. |
| `actual_hours` | number \| null | no | Wall-clock effort actually spent, if the user tracked it. |
| `claude_role` | enum | yes | `wrote` \| `co_wrote` \| `assisted` \| `reviewed` \| `researched` \| `none`. Definitions in `methodology.md`. |
| `sessions` | array | no | `[{ "session_id": str, "transcript_path": str }]`. |
| `tokens` | object \| null | no | Manual override only; metered totals joined via `attribution.tracker_key` are preferred and labeled as such. Null if unknown — never estimated. |
| `budget_tokens` | number \| null | no | Optional per-item token envelope. |
| `time_saved_hours` | object \| null | no | `{ "low": n, "high": n, "confidence": "high"\|"medium"\|"low", "basis": "pre_registered"\|"baseline"\|"judgment" }`. |
| `notes` | string \| null | no | Free text. |
| `reopened` | boolean | no | Set by sync corrections when the tracker reopened an item after it shipped; reports count these without erasing the shipped work. Absent unless set (additive, 1.0). |

### Escrow (pre-registration seal)

When an `opened` entry records a pre-registered estimate, seal it:

```
payload = "estimate.v1|" + (tracker_key ?? title) + "|" + low + "|" + high
        + "|hours|" + logged_at
escrow  = { "algo": "sha256", "payload": "estimate.v1",
            "sha256": hex(sha256(payload)) }
```

The estimate stays cleartext; the hash makes any later edit detectable.
`waybill verify` recomputes every escrow hash, and the ledger repo's git
history is the second, independent witness. Backfilling
`pre_registered: true` remains forbidden regardless of escrow.

### Pins

`kind: "pin"` binds a session (or time range) to an account at
confidence 1.0 for the attribution resolver:

```json
{"id":"01J5PZ8Q2R6VJ1XKQ0YB3W9T4D","ts":"2026-08-17T10:20:00Z","kind":"pin",
 "schema_version":2,"supersedes":null,"session_id":"9f4c1e2a-77aa-4b02-9d31-5c2f8ab9d001",
 "account":"story:PLAT-482","tracker_key":"PLAT-482",
 "range":null,"notes":null}
```

`range` may be `{"from": iso-ts, "to": iso-ts|null}` to pin only part of a
session. Unpinning is a `correction` superseding the pin.

### Example: opening an entry (pre-registration, sealed)

```json
{"id":"01J5KQZ0F1H9M2N3P4Q5R6S7T8","ts":"2026-08-10T09:12:00Z","kind":"opened","schema_version":2,"supersedes":null,"title":"Retry logic for checkout webhook","tracker_key":"PLAT-482","epic_key":"PLAT-401","epic_name":"Checkout reliability","sprint":"2026-S17","repo":"acme/platform","work_type":"feature","points":5,"artifacts":{"prs":[],"commits":[],"deploy":null,"docs":[]},"estimate_without_claude_hours":{"low":10,"high":16,"logged_at":"2026-08-10T09:12:00Z","pre_registered":true},"escrow":{"algo":"sha256","payload":"estimate.v1","sha256":"9d24f5b8a0c1e7d6f3a2b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8"},"actual_hours":null,"claude_role":"none","sessions":[],"tokens":null,"budget_tokens":null,"time_saved_hours":null,"notes":"Estimate logged before starting work with Claude."}
```

### Example: shipping the same item

```json
{"id":"01J5R2M8T9V0W1X2Y3Z4A5B6C7","ts":"2026-08-12T16:30:00Z","kind":"shipped","schema_version":2,"supersedes":"01J5KQZ0F1H9M2N3P4Q5R6S7T8","title":"Retry logic for checkout webhook","tracker_key":"PLAT-482","epic_key":"PLAT-401","epic_name":"Checkout reliability","sprint":"2026-S17","repo":"acme/platform","work_type":"feature","points":5,"artifacts":{"prs":["https://github.com/acme/platform/pull/1932"],"commits":[],"deploy":"v2026.08.12","docs":[]},"estimate_without_claude_hours":{"low":10,"high":16,"logged_at":"2026-08-10T09:12:00Z","pre_registered":true},"escrow":{"algo":"sha256","payload":"estimate.v1","sha256":"9d24f5b8a0c1e7d6f3a2b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8"},"actual_hours":4.5,"claude_role":"co_wrote","sessions":[{"session_id":"9f4c1e2a-77aa-4b02-9d31-5c2f8ab9d001","transcript_path":"~/.claude/projects/acme-platform/9f4c1e2a.jsonl"}],"tokens":null,"budget_tokens":null,"time_saved_hours":{"low":5.5,"high":11.5,"confidence":"medium","basis":"pre_registered"},"notes":"time_saved = pre-registered range minus actual_hours."}
```

## Usage stream (`streams/usage/`)

`kind`: `usage` | `correction`. One event per (turn, model, attribution
account); a turn is the span from one user prompt to the next, and subagent
activity within a turn rolls up to that turn's account. Never split a turn.

| Field | Type | Notes |
|---|---|---|
| `session_id` | string | From the transcript's own `sessionId` (never the hook payload). |
| `turn` | object | `{ "index": n, "first_message_id": str, "last_message_id": str, "prompt_id": str\|null }`. |
| `repo` | string \| null | Repo identity active for the turn. |
| `model` | string | Model id as recorded in the transcript. |
| `tokens` | object | `{ "input", "output", "cache_read", "cache_creation", "cache_creation_5m", "cache_creation_1h" }` — all integers; the 5m/1h split is 0/0 when the source lacks it. |
| `cost_usd` | object \| null | `{ "value": number, "pricing_version": str }`; **null when the model is missing from the pricing table** — tokens reported, cost never guessed. |
| `attribution` | object | `{ "account", "tracker_key", "resolver", "confidence", "rules_version" }`. Account is `story:<KEY>`, `adhoc:<label>`, or `unattributed`. |
| `source` | string | `"transcript"` or `"otel"` (the OTel secondary source fills only sessions with no transcript; a session never mixes sources). |
| `transcript_version` | string \| null | Claude Code version that wrote the transcript lines (null for OTel events). |
| `raw_extra` | object \| null | Unknown source usage fields, preserved, never dropped. |
| `waste` | object \| null | Turn-level waste diagnostics, carried once per turn on its first model event: `{ "retried_commands": n, "repeated_reads": n }` — counts only, never commands or paths. Absent on pre-1.0 events (additive; see `docs/migration.md`). |

```json
{"id":"01J5T0A1B2C3D4E5F6G7H8J9K0","ts":"2026-08-17T10:15:03Z","kind":"usage","schema_version":2,"supersedes":null,"session_id":"9f4c1e2a-77aa-4b02-9d31-5c2f8ab9d001","turn":{"index":3,"first_message_id":"msg_01AAA","last_message_id":"msg_01AAC","prompt_id":"prompt_7"},"repo":"acme/platform","model":"claude-opus-4-6","tokens":{"input":41200,"output":6300,"cache_read":181000,"cache_creation":22000,"cache_creation_5m":22000,"cache_creation_1h":0},"cost_usd":null,"attribution":{"account":"story:PLAT-482","tracker_key":"PLAT-482","resolver":"active_entry","confidence":0.9,"rules_version":"1"},"source":"transcript","transcript_version":"2.1.229","raw_extra":null}
```

## Sessions stream (`streams/sessions/`)

`kind`: `session` | `correction`. One durable receipt per metered session,
written when the meter completes (and superseded if the session is re-metered
after growing). This is what keeps conservation checkable after Claude Code
prunes the transcript.

| Field | Type | Notes |
|---|---|---|
| `session_id` | string | Transcript `sessionId` (or OTel `session.id`). |
| `transcript_path` | string | Where the source lived (empty string for OTel receipts, which also carry a synthetic single-turn shape and no branches). |
| `transcript_version` | string \| null | e.g. `"2.1.229"`. |
| `cwd` | string \| null | Session working directory. |
| `repo` | string \| null | Repo identity, when derivable. |
| `branches` | array | Git branches observed across the session's lines. |
| `models` | array | Model ids observed. |
| `first_ts` / `last_ts` | string | First/last source timestamps. |
| `turns` | number | Turn count. |
| `messages` | number | Unique assistant API messages metered. |
| `totals` | object | Source-side sums `{ input, output, cache_read, cache_creation }` — the conservation reference. |
| `source` | string | `"transcript"` or `"otel"` — a transcript receipt supersedes any earlier otel receipt for the same session (transcript wins). |

## Exceptions stream (`streams/exceptions/`)

`kind`: `ambiguity` | `resolution` | `meter_discrepancy` | `meter_gap`.
User-facing name: the **attribution inbox** (never "exceptions queue" in
user-facing text).

- `ambiguity` — a resolver rule matched multiple candidates:
  `{ session_id, turn, rule, candidates: ["story:A","story:B"], status: "open" }`.
- `resolution` — closes an ambiguity: `{ resolves: <ambiguity id>, account,
  durable: null | {"type":"pin"} | {"type":"repo_default","repo":str} }`.
  Written as a new event; the ambiguity itself is never edited.
- `meter_discrepancy` — conservation check failed for a session:
  `{ session_id, expected: totals, observed: totals, detail }`.
- `meter_gap` — a session is known to exist but its transcript is gone:
  `{ session_id, reason: "transcript_pruned" | "unreadable" }`. Gaps are
  visible, never papered over.

## `identity.json` (the identity map)

Who "me" is in each system — used to scope every query to the user's own
work, never anyone else's:

```json
{
  "schema_version": 2,
  "git_emails": ["info@jakeawilliams.com"],
  "git_names": ["Jakeintech"],
  "github_login": "Jakeintech",
  "jira_account_id": null
}
```

`git_emails`/`git_names` are seeded from `git config` at init;
`github_login` is filled from an already-authenticated `gh` CLI if present
(no auth flow is ever started); `jira_account_id` is filled by the first
`sync` from the tracker's "who am I" response.

## `config.json` (v2)

```json
{
  "schema_version": 2,
  "tracker": { "kind": null, "project_keys": [], "base_url": null },
  "git": { "kind": "local", "repos": [], "default_branch": "main" },
  "baseline": {
    "velocity_points_per_sprint": null,
    "median_cycle_time_days": null,
    "window": null,
    "derived_from": null
  },
  "allocations": [],
  "metering": {
    "enabled": true,
    "sources": ["transcript"],
    "branch_key_pattern": "[A-Z][A-Z0-9]+-[0-9]+",
    "repo_defaults": {}
  },
  "pricing": {
    "version": null,
    "unknown_model_policy": "tokens_only",
    "models": {}
  },
  "budgets": { "allocation": "inherit", "epics": {}, "renewal_reminder_days": 14 },
  "audience_default": "self",
  "last_sync": null
}
```

- **Zero-config default** is exactly the object above with `repos` seeded
  from the current repo: git-only mode, no tracker, no auth. `sync` upgrades
  `tracker.kind`/`git.kind` when MCP servers are connected.
- `pricing.models` maps model id → `{ "input_per_mtok", "output_per_mtok",
  "cache_read_per_mtok", "cache_write_5m_per_mtok", "cache_write_1h_per_mtok" }`
  (USD per million tokens). A model absent from the table ⇒ `cost_usd: null`
  on its events. Tokens are the native unit; USD is a labeled list-price
  equivalent for subscription users.
- `allocations`: `[{ "period": "2026-Q3", "tokens_granted": 50000000,
  "granted_at": "2026-07-01" }]`. Periods `YYYY-Qn` and `YYYY-MM` parse
  exactly for pacing windows; anything else falls back to
  `granted_at` + 90 days.
- `budgets`: optional per-epic token envelopes plus
  `renewal_reminder_days` — how many days before the allocation period ends
  `waybill pace --notice` nudges (once) to draft the pitch.
- `audience_default`: `self` | `internal` | `external` — the redaction level
  reports use when none is requested (see `docs/skills.md` and the report
  skill for what each level strips).

## `meter_state.json`

```json
{
  "schema_version": 2,
  "sessions": {
    "9f4c1e2a-77aa-4b02-9d31-5c2f8ab9d001": {
      "transcript_path": "~/.claude/projects/acme-platform/9f4c1e2a.jsonl",
      "file_bytes": 183220,
      "last_message_id": "msg_01AAC",
      "transcript_version": "2.1.229",
      "metered_through_ts": "2026-08-17T10:15:03Z",
      "rules_version": "1",
      "pricing_version": "2026-08-01",
      "attribution_inputs": "9d24f5…"
    }
  }
}
```

Checkpoints make the meter incremental and idempotent. A session is skipped
only when **all** of these are unchanged: the transcript's byte size, the
`rules_version` and `pricing_version` it was last metered under (compared
per session, so a version bump re-meters every stale session), and
`attribution_inputs` — a fingerprint of the pins, open entries, repo
defaults, and applied inbox resolutions. Pinning or resolving after a
session ends changes the fingerprint, so the next meter run emits
superseding corrected events. A stale session is fully re-parsed;
unchanged events recompute to identical ids and are skipped, changed ones
supersede. A full re-run from empty state reproduces the identical fact
stream (the determinism harness asserts this in CI).

## Pending-session capture shape

Files in `pending-sessions/` contain the raw SessionEnd hook JSON from
Claude Code (fields such as `session_id`, `transcript_path`, `cwd`,
`reason`), plus `git_branch`, `repo` (org/name from the cwd's git remote —
the miner's attribution hint), `captured_at`, and `mined` added by the
capture script when `jq` is available. Treat any file without
`"mined": true` as unprocessed. After mining, the miner rewrites the file
with `"mined": true` rather than deleting it. Session identity always comes
from the transcript's own `sessionId`; the capture is a queue ticket, not a
source of truth.

## Integrity contract (what `waybill verify` checks)

1. Every line in every shard parses as JSON and carries a valid envelope.
2. Shard placement matches each event's `ts` month.
3. Ids are unique across all streams and match their content (deterministic
   ULID recomputation).
4. Every `supersedes` target exists.
5. Every escrow hash recomputes.
6. **Conservation**: for each metered session, Σ tokens over its usage
   events equals the session receipt's `totals`, per token class. Any
   mismatch is reported (and should already exist as a `meter_discrepancy`).
7. `pre_registered: true` estimates have `logged_at` ≤ their entry's `ts`.
