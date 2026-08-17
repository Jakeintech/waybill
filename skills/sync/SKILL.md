---
name: sync
description: >
  This skill should be used when the user wants to reconcile their waybill
  ledger with their tracker and git host — when they say "sync my ledger",
  "pull my Jira activity", "update the ledger from GitHub", "reconcile my
  ledger", "import my recent tickets", "bootstrap my ledger", "import my
  history", or after a period of unlogged work.
  Works zero-config from local git history; the Atlassian and/or GitHub MCP
  servers bundled with this plugin (or equivalents) upgrade it.
metadata:
  version: "1.1.1"
---

# Sync

Pull the objective backbone — issues and merged PRs — from the user's
tracker and git host, and reconcile it with the ledger. The reconciliation
itself is deterministic: MCP tools fetch raw JSON, the engine normalizes and
diffs it, you present the plan, one confirmation applies it.

Invoke the engine as `"${CLAUDE_PLUGIN_ROOT}/bin/waybill" <command>`.

## Scope rule (non-negotiable)

Query **only the current user's own items**: issues assigned to them, PRs
authored by them, in the projects/repos listed in `config.json`. Never
fetch, store, or summarize individual colleagues' issues, PRs, or
statistics, even on request — explain briefly per
`skills/ledger/references/methodology.md` §6 and continue with the user's
own data.

## Procedure

1. Read `config.json` for `project_keys`, `repos`, `default_branch`, and
   `last_sync`, and `identity.json` for the identity map. If `last_sync` is
   null, default the window to the last 90 days and say so. If
   `identity.json` lacks `jira_account_id` and Atlassian MCP is connected,
   fetch the current user's accountId once and write it back — future
   queries stay scoped to it.
2. **Tracker (Atlassian MCP):** search issues assigned to the current user
   in the configured projects, updated since `last_sync` — e.g. JQL
   `assignee = currentUser() AND project IN (<keys>) AND updated >= "<date>"`.
   Request fields: summary, status, resolutiondate, created, updated,
   issuetype, parent, story points and sprint custom fields. Save the raw
   JSON response verbatim to a temp file (e.g. `/tmp/waybill-items.json`).
   **GitHub Issues as the tracker** (`tracker.kind: "github-issues"`):
   fetch with the gh CLI instead —

   ```bash
   gh issue list -R <org/name> --state all --limit 200 \
     --json number,title,state,stateReason,closedAt,createdAt,updatedAt,labels,milestone,assignees,url \
     > /tmp/waybill-items.json
   ```

   Save exactly what the command returns — never edit or annotate the
   payload; the adapter derives `owner/repo#number` keys from the issue
   URLs itself, and the conformance contract depends on the payload being
   raw. The REST `/issues` shape works too.
3. **Git host (GitHub MCP):** search PRs authored by the user in configured
   repos merged since `last_sync` into the default branch (e.g.
   `is:pr author:@me is:merged merged:>=<date> repo:<org/name>`). Save the
   raw JSON to a temp file. **No MCP servers?** Use the git-local floor —
   the engine reads local history itself, no files needed:
   `"${CLAUDE_PLUGIN_ROOT}/bin/waybill" sync-plan --local-repo <path-to-repo> --baseline` (repeat
   `--local-repo` per repo; `--since <iso>` overrides the window). Or skip
   changes entirely — do the half that works.
4. **Plan (deterministic):**

   ```bash
   "${CLAUDE_PLUGIN_ROOT}/bin/waybill" sync-plan --tracker jira --items /tmp/waybill-items.json \
     --git github --changes /tmp/waybill-changes.json --baseline \
     > /tmp/waybill-plan.json
   ```

   (The plan prints to stdout — the redirect is what step 6 applies.)

   The plan JSON contains: `shipped` proposals (open entries whose issue is
   Done and PR merged — escrow and estimates carried forward), `corrections`
   (field drift — points, epic, sprint — plus rework transitions: an item
   reopened after shipping gets `reopened: true`, and a later re-resolve
   clears it; reports count these), `orphans` (Done items with no ledger
   entry, marked "Claude involvement unrecorded"), `unmatched_changes`
   (merged PRs with no tracker key — surfaced, never silently dropped), and
   a derived `baseline` when requested. Other trackers/hosts swap in the
   same flow: `--tracker linear`, `--tracker github-issues`, `--git gitlab`.
5. Present the plan as a short table and get **one confirmation**. If the
   user excludes rows, delete them from the plan JSON before applying.
6. **Apply:** `"${CLAUDE_PLUGIN_ROOT}/bin/waybill" sync-plan --apply /tmp/waybill-plan.json` — appends
   the entries with deterministic ids (re-applying is a safe no-op), updates
   `config.baseline` if derived, sets `last_sync`, and commits.
7. Close with a two-line summary: entries added/corrected, orphans and
   unmatched changes remaining. On a first-ever sync, offer the bootstrap
   report (see the `report` skill) so the user leaves day one with a usable
   artifact.

## Deriving a baseline

Pass `--baseline` to derive tier-2 evidence from the user's own history:
median points per sprint and median created→resolved cycle time over the
fetched window. Applying the plan records it in `config.baseline` with the
window and derivation noted. For a *pre-Claude* baseline, run a second
fetch over a window the user names (e.g. the two quarters before they
started using Claude Code) and apply only its baseline.

## Failure handling

If an MCP server is not connected or errors, say which one, do the half
that works (the git-local floor always works), and never substitute guessed
data for the missing half. Then help the user connect it — with commands,
not links: for GitHub, `export GITHUB_MCP_PAT="$(gh auth token)"` when an
authenticated gh CLI exists (check with `gh auth status`), else a
fine-grained read-only PAT from github.com/settings/personal-access-tokens;
for Atlassian, `/mcp` and its OAuth flow. `"${CLAUDE_PLUGIN_ROOT}/bin/waybill" status` prints
the same remediation.
