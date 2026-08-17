---
name: sync
description: >
  This skill should be used when the user wants to reconcile their waybill
  ledger with their tracker and git host — when they say "sync my ledger",
  "pull my Jira activity", "update the ledger from GitHub", "reconcile my
  ledger", "import my recent tickets", "bootstrap my ledger", "import my
  history", or after a period of unlogged work.
  Requires the Atlassian and/or GitHub MCP servers bundled with this plugin
  (or equivalents) to be connected.
metadata:
  version: "0.1.0"
---

# Sync

Pull the objective backbone — issues and merged PRs — from the user's tracker
and git host, and reconcile it with the ledger. Follow the schema and
integrity rules from the `ledger` skill; read its `references/schema.md`
before writing.

Let `LEDGER_HOME` mean `${WAYBILL_HOME:-$HOME/.waybill}`.

## Scope rule (non-negotiable)

Query **only the current user's own items**: issues assigned to them, PRs
authored by them, in the projects/repos listed in `config.json`. Never fetch,
store, or summarize individual colleagues' issues, PRs, or statistics, even
on request — explain briefly per `references/methodology.md` §6 and continue
with the user's own data.

## Procedure

1. Read `config.json` for `project_keys`, `repos`, `default_branch`, and
   `last_sync`. If `last_sync` is null, default the window to the last 30
   days and say so.
2. **Tracker (Atlassian MCP):** search issues assigned to the current user in
   the configured projects, updated since `last_sync` — e.g. JQL
   `assignee = currentUser() AND project IN (<keys>) AND updated >= "<date>"`.
   Collect: key, summary, story points, epic link and name, sprint, status,
   and resolution date for anything that reached Done.
3. **Git host (GitHub MCP):** search PRs authored by the user in configured
   repos merged since `last_sync` into the default branch (e.g.
   `is:pr author:@me is:merged merged:>=<date> repo:<org/name>`). Collect: PR
   URL, title, branch name, merged_at, additions/deletions.
4. **Reconcile.** Link PRs to issues by tracker key found in PR title or
   branch name. Then, against the ledger:
   - Existing `opened` entries whose issue is now Done and PR merged →
     propose `shipped` entries (superseding), carrying artifacts and points.
   - Merged PRs or Done issues with **no** ledger entry → list these
     "orphans" compactly and offer to log each via the log flow (any
     time-saved on these is at best `judgment` tier — say so once).
   - Field drift (points changed in Jira, epic reassigned) → propose
     `correction` entries.
5. Present the full proposed change set as a short table and get one
   confirmation before writing anything.
6. Write entries (validate each with `jq -e`, append, never edit), update
   `last_sync` in `config.json` to the sync start time, and `git commit` in
   `LEDGER_HOME`.
7. Close with a two-line summary: entries added/corrected, orphans remaining,
   and the new `last_sync`. On a first-ever sync, offer the bootstrap report
   (see the `report` skill): a facts-only summary of the imported window, so
   the user leaves day one with a usable artifact.

## Optional: deriving a baseline

If `config.json`'s `baseline` is null and the user agrees, derive it from
their own tracker history: points resolved per sprint and median
created→resolved cycle time over a pre-Claude window the user names. Record
the window and query used in `baseline.derived_from`. This becomes the
tier-2 evidence for reports.

## Failure handling

If an MCP server is not connected or errors, say which one, do the half that
works, and never substitute guessed data for the missing half.
