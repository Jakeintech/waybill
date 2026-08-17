# Ledger Schemas

## Entry schema (`ledger.jsonl`, one JSON object per line)

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes | Unique. Use `wb-` + UTC timestamp + 4 random hex chars, e.g. `wb-20260815T142200Z-a3f1`. |
| `ts` | string | yes | ISO 8601 UTC timestamp of the event being recorded. |
| `kind` | enum | yes | `opened` \| `progress` \| `shipped` \| `correction`. |
| `supersedes` | string \| null | no | `id` of the entry this one corrects/replaces. |
| `title` | string | yes | Human-readable summary, e.g. "Retry logic for checkout webhook". |
| `tracker_key` | string \| null | no | e.g. `PLAT-482`. Null for untracked work. |
| `epic_key` | string \| null | no | e.g. `PLAT-401`. |
| `epic_name` | string \| null | no | e.g. "Checkout reliability". |
| `sprint` | string \| null | no | e.g. "2026-S17". |
| `repo` | string \| null | no | `org/name`. |
| `work_type` | enum | yes | `feature` \| `bug` \| `refactor` \| `review` \| `incident` \| `docs` \| `research` \| `other`. |
| `points` | number \| null | no | Story points as recorded in the tracker. Never self-assigned. |
| `artifacts` | object | yes | `{ "prs": [urls], "commits": [shas], "deploy": url-or-tag-or-null, "docs": [urls] }`. Empty arrays are fine; fabricated URLs are not. |
| `estimate_without_claude_hours` | object \| null | no | `{ "low": n, "high": n, "logged_at": iso-ts, "pre_registered": bool }`. `pre_registered` is true only if logged **before** the work was done with Claude. |
| `actual_hours` | number \| null | no | Wall-clock effort actually spent, if the user tracked it. |
| `claude_role` | enum | yes | `wrote` \| `co_wrote` \| `assisted` \| `reviewed` \| `researched` \| `none`. Definitions in `methodology.md`. |
| `sessions` | array | no | `[{ "session_id": str, "transcript_path": str }]` linking to Claude Code sessions. |
| `tokens` | object \| null | no | `{ "input": int, "output": int }` summed from transcripts or OTEL. Null if unknown — never estimated. |
| `time_saved_hours` | object \| null | no | `{ "low": n, "high": n, "confidence": "high"\|"medium"\|"low", "basis": "pre_registered"\|"baseline"\|"judgment" }`. |
| `notes` | string \| null | no | Free text. |

### Example: opening an entry (pre-registration)

```json
{"id":"wb-20260810T091200Z-7c2e","ts":"2026-08-10T09:12:00Z","kind":"opened","supersedes":null,"title":"Retry logic for checkout webhook","tracker_key":"PLAT-482","epic_key":"PLAT-401","epic_name":"Checkout reliability","sprint":"2026-S17","repo":"acme/platform","work_type":"feature","points":5,"artifacts":{"prs":[],"commits":[],"deploy":null,"docs":[]},"estimate_without_claude_hours":{"low":10,"high":16,"logged_at":"2026-08-10T09:12:00Z","pre_registered":true},"actual_hours":null,"claude_role":"none","sessions":[],"tokens":null,"time_saved_hours":null,"notes":"Estimate logged before starting work with Claude."}
```

### Example: shipping the same item

```json
{"id":"wb-20260812T163000Z-b911","ts":"2026-08-12T16:30:00Z","kind":"shipped","supersedes":"wb-20260810T091200Z-7c2e","title":"Retry logic for checkout webhook","tracker_key":"PLAT-482","epic_key":"PLAT-401","epic_name":"Checkout reliability","sprint":"2026-S17","repo":"acme/platform","work_type":"feature","points":5,"artifacts":{"prs":["https://github.com/acme/platform/pull/1932"],"commits":[],"deploy":"v2026.08.12","docs":[]},"estimate_without_claude_hours":{"low":10,"high":16,"logged_at":"2026-08-10T09:12:00Z","pre_registered":true},"actual_hours":4.5,"claude_role":"co_wrote","sessions":[{"session_id":"9f4c...","transcript_path":"~/.claude/projects/acme-platform/9f4c....jsonl"}],"tokens":{"input":812000,"output":94000},"time_saved_hours":{"low":5.5,"high":11.5,"confidence":"medium","basis":"pre_registered"},"notes":"time_saved = pre-registered range minus actual_hours."}
```

## `config.json` schema

```json
{
  "tracker": {
    "kind": "jira",
    "project_keys": ["PLAT", "DATA"],
    "base_url": "https://acme.atlassian.net"
  },
  "git": {
    "kind": "github",
    "repos": ["acme/platform"],
    "default_branch": "main"
  },
  "baseline": {
    "velocity_points_per_sprint": null,
    "median_cycle_time_days": null,
    "window": null,
    "derived_from": null
  },
  "allocations": [
    { "period": "2026-Q3", "tokens_granted": 50000000, "granted_at": "2026-07-01" }
  ],
  "last_sync": null
}
```

## Pending-session capture shape

Files in `pending-sessions/` contain the raw SessionEnd hook JSON from Claude
Code (fields such as `session_id`, `transcript_path`, `cwd`, `reason`), plus
`git_branch`, `captured_at`, and `mined` added by the capture script when `jq`
is available. Treat any file without `"mined": true` as unprocessed. After
mining, rewrite the file with `mined: true` rather than deleting it.
