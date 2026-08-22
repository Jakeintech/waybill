---
name: salvage
description: >
  This skill should be used when the user wants untracked work turned into
  ledger receipts — when they say "group my untracked work", "salvage my
  untracked work", "clean up my unattributed spend", "what did I forget to
  log", "turn these PRs into tasks", "reconstruct my ledger", or when
  another waybill answer shows a large unattributed or untracked share.
  The engine clusters unattributed sessions, unlogged story keys, and
  adhoc spend into candidate work items with their receipts; titles are
  proposed from the receipts only, and one tap per cluster appends
  reconstructed entries. Facts tier only — pre-registration is never
  backfilled.
metadata:
  version: "2.0.0"
---

# Salvage

Work that shipped without a ticket still burned real tokens and produced
real receipts. Salvage recovers it: the engine groups the unmanifested
spend, you propose names for what each group plainly was, the user
confirms one group at a time, and the ledger gains reconstructed —
honestly labeled — entries.

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/waybill" mine --all      # catch-up metering first, always
"${CLAUDE_PLUGIN_ROOT}/bin/waybill" query untracked [--from <iso>] [--to <iso>]
```

`.data.clusters` is the worklist: each cluster carries its kind
(`story_key` — a key seen in branches but never logged or synced;
`branch` — unattributed sessions grouped by branch; `adhoc`;
`unattributed`), its receipts (sessions, branches, repo, time window,
keys seen), and its tokens. `.data.untracked_pct` is the headline.

## Correlate with real artifacts (optional, recommended)

For clusters with a repo, fetch the merged changes for the cluster's time
window so titles and artifacts come from real receipts:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/waybill" sync-plan --local-repo <path> --since <cluster.first_ts> \
  > /tmp/waybill-salvage-changes.json
```

Match changes to clusters by branch name or key. A matched change gives
the cluster a real title (the commit/PR subject) and a real artifact.

## Propose, then apply — one tap per cluster

For each cluster, in token order, present one line — proposed title,
kind, tokens, sessions, date range, the receipt it came from — and ask
one question: log it (as `story:<KEY>` when a key exists, else as an
adhoc label or a keyless entry), or leave it. **Titles come from the
receipts only**: branch names, commit subjects, keys. Never invent a
tracker key, a title, or an estimate.

To apply a confirmed cluster:

1. For `branch`/`unattributed` clusters, pin each session to the chosen
   account so the spend re-attributes (skip for `story_key`/`adhoc` —
   already attributed):

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/waybill" append --stream ledger --commit --event '{
  "ts": "<cluster.last_ts>", "kind": "pin",
  "session_id": "<session_id>", "account": "<story:KEY | adhoc:label>",
  "tracker_key": <"KEY" | null>, "range": null,
  "notes": "salvage: reconstructed from receipts"
}'
```

2. Append the entry (see `skills/ledger/references/schema.md` for the
   full shape): kind `opened`, the receipt-derived title,
   `estimate_without_claude_hours: null`, `claude_role` as the user
   states it (default `"none"` if unsure),
   `notes: "reconstructed from receipts (salvage)"`. If a matched merged
   change exists, append a superseding `shipped` entry carrying its
   URL/sha in `artifacts`.

3. After all clusters: `"${CLAUDE_PLUGIN_ROOT}/bin/waybill" mine --all`
   re-attributes the pinned sessions, then close with one line — tokens
   reclaimed, untracked share before → after.

## Rules

- **Never backfill pre-registration.** Reconstructed entries carry
  `estimate_without_claude_hours: null` and no escrow — salvage produces
  tier-1 facts; a backdated "estimate" would be forged tier-3 evidence
  and `waybill verify`/`append` treat it as such.
- Titles, keys, and artifacts come from receipts (branches, commits,
  PRs) or from the user — never from inference about what the work
  "probably was".
- One confirmation per cluster; never bulk-apply.
- If the user adds context the receipts don't show ("that spike was for
  the auth migration"), record it in `notes`, attributed to them.
- No peer comparisons, ever.
