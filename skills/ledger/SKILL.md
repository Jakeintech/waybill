---
name: ledger
description: >
  This skill should be used for anything involving the waybill ledger's storage,
  entry schema, configuration, or integrity rules — when the user asks to
  "initialize my waybill ledger", "set up waybill", "what's in my ledger",
  "what have I logged", "show my ledger", or whenever another waybill
  skill (log, sync, report, forecast) needs to read or write ledger data.
metadata:
  version: "0.1.0"
---

# The Waybill Ledger

The ledger is a local, append-only record of the user's shipped work and
Claude's contribution to it. It exists to make value claims *checkable*:
every number in a report or token pitch must trace back to an entry here,
and every entry must trace back to evidence (a PR, an issue, a transcript,
a timestamp).

## Storage layout

All data lives under `$WAYBILL_HOME`, defaulting to `~/.waybill/`:

```
~/.waybill/
├── config.json            # tracker/repo scope, baseline, allocation history
├── ledger.jsonl           # one JSON entry per line, append-only
├── pending-sessions/      # raw SessionEnd captures awaiting mining
└── .git/                  # the ledger is itself a git repo (audit trail)
```

Read `references/schema.md` (in this skill's directory) before constructing
any entry, and `references/methodology.md` before making any claim about
time saved or work "with vs. without Claude".

## Initialization

When the user asks to initialize or set up the ledger:

1. Create the directory: `mkdir -p "${WAYBILL_HOME:-$HOME/.waybill}/pending-sessions"`.
2. Run `git init` inside it and add a `.gitignore` containing nothing (all
   files are meant to be versioned). Commit after every write session with a
   plain message like `ledger: 3 entries added`.
3. Interview the user briefly (one question at a time, skip anything already
   known) to build `config.json`:
   - Jira project keys they work in (e.g. `["PLAT", "DATA"]`).
   - GitHub repos they ship to (e.g. `["acme/platform"]`).
   - Default branch name if not `main`.
   - Optional baseline: their pre-Claude velocity (points/sprint) and median
     cycle time, if they know it. If they don't, offer to derive it later
     from tracker history via the sync skill.
   - Optional allocation history: tokens granted and period, for utilization
     reporting.
4. Write `config.json` (schema in `references/schema.md`), validate with
   `jq -e . config.json`, and commit.

## Reading the ledger

Use `jq` over `ledger.jsonl`. Useful recipes:

- All shipped entries in a window:
  `jq -c 'select(.kind == "shipped" and .ts >= "2026-08-01")' ledger.jsonl`
- Resolve supersedes: when multiple entries share a `tracker_key`, the entry
  with the latest `ts` that is not itself superseded is authoritative.
- Totals: sum `points`, `tokens.input + tokens.output`, and sum
  `time_saved_hours.low` and `.high` **separately** — never average them into
  a single number.

## Writing to the ledger

1. Construct the entry per `references/schema.md`. Unknown values are `null`,
   never guessed. Never invent tracker keys, points, or PR URLs.
2. Validate the line with `jq -e .` before appending.
3. Append as a single line: `printf '%s\n' "$ENTRY" >> ledger.jsonl`.
4. Never edit or delete an existing line. Corrections are new entries with
   `kind: "correction"` and `supersedes` set to the old entry's `id`.
5. Commit to git after the write session.

## Integrity invariants (enforce these everywhere)

- **Append-only.** History is the product; rewriting it destroys credibility.
- **Evidence or null.** A `time_saved_hours` value requires a `basis`; an
  artifact list requires real URLs the user or MCP tools provided.
- **Ranges, not points.** Counterfactual estimates are always `{low, high}`.
- **Own data only.** The ledger records the user's work. Never query, store,
  or compare individual colleagues' issues, PRs, or stats — decline and point
  to `references/methodology.md` if asked.
