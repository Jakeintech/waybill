---
name: sync
description: >
  This skill should be used when the user wants to reconcile their waybill
  ledger with their tracker and git host — when they say "sync my ledger",
  "pull my Jira activity", "update the ledger from GitHub", "reconcile my
  ledger", "import my recent tickets", "bootstrap my ledger", "import my
  history", or after a period of unlogged work.
  Works zero-config from local git history; the Atlassian CLI (acli), the
  gh CLI, or the Atlassian/GitHub MCP servers bundled with this plugin
  upgrade it. Jira fetches prefer acli — scoped fields, small payloads.
metadata:
  version: "1.5.0"
---

# Sync

Pull the objective backbone — issues and merged PRs — from the user's
tracker and git host, and reconcile it with the ledger. The reconciliation
itself is deterministic: a CLI or MCP tool fetches raw JSON, the engine
normalizes and diffs it, you present the plan, one confirmation applies it.
Prefer CLIs (acli, gh) over MCP tools for the fetch: the same facts arrive
with scoped fields in a fraction of the payload, saved to files instead of
flowing through context.

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
   `identity.json` lacks `jira_account_id` and the Atlassian MCP is
   connected, fetch the current user's accountId once and write it back —
   future queries stay scoped to it. (The acli path needs no accountId:
   `currentUser()` in the JQL scopes the fetch at the source.)
2. **Tracker — Jira.** Two fetch paths; prefer the CLI when it is
   authenticated (`acli jira auth status` exits 0 — `waybill status` also
   reports this):

   **acli (Atlassian CLI) — preferred.** Two steps keep the payload
   minimal: search returns only keys, then each item is fetched with
   exactly the fields sync needs (search's flattened JSON cannot carry
   custom fields; `view` is REST-shaped and can):

   ```bash
   acli jira workitem search --json --limit 200 --fields key \
     --jql 'assignee = currentUser() AND project IN (<keys>) AND updated >= "<date>"' \
     > /tmp/waybill-keys.json
   jq -r '(.issues // .) | .[].key' /tmp/waybill-keys.json | while read -r KEY; do
     acli jira workitem view "$KEY" --json --fields \
       "summary,status,resolutiondate,created,updated,issuetype,parent,assignee,customfield_10016,customfield_10026,customfield_10002,customfield_10020,customfield_10010,customfield_10014,customfield_10011"
   done | jq -s '.' > /tmp/waybill-items.json
   ```

   Each `view` output is a REST-shaped issue saved verbatim; `jq -s` only
   composes them into an array (a shape the jira adapter accepts) — never
   edit or annotate the objects themselves. The custom field ids are the
   common story-points/sprint/epic candidates; if this site rejects one,
   drop it from `--fields` and continue — points and sprint stay null
   rather than guessed. `currentUser()` in the JQL scopes the fetch to the
   user's own items at the source.

   **Atlassian MCP — fallback (no acli):** search issues assigned to the
   current user in the configured projects, updated since `last_sync` —
   the same JQL. Request fields: summary, status, resolutiondate, created,
   updated, issuetype, parent, story points and sprint custom fields. Save
   the raw JSON response verbatim to `/tmp/waybill-items.json`.

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
3. **Git host — GitHub.** Prefer an authenticated gh CLI (`gh auth
   status`): one command, exactly the fields the adapter needs —

   ```bash
   gh pr list -R <org/name> --author "@me" --state merged \
     --search "merged:>=<date> base:<default_branch>" --limit 200 \
     --json url,title,headRefName,mergedAt,body > /tmp/waybill-changes.json
   ```

   (Repeat per repo; concatenate arrays with `jq -s 'add'` if needed.
   Request the **body** — closing keywords there, "Fixes #12", are how PRs
   link to GitHub issues.) **GitHub MCP fallback:** search PRs authored by
   the user in configured repos merged since `last_sync` into the default
   branch (e.g. `is:pr author:@me is:merged merged:>=<date>
   repo:<org/name>`), requesting the body along with
   url/title/branch/merged_at, and save the raw JSON to the same temp
   file — the adapter accepts both shapes. **Neither available?** Use the
   git-local floor —
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

If a fetch path is unavailable or errors, say which one, do the half that
works (the git-local floor always works), and never substitute guessed
data for the missing half. Then help the user connect it — with commands,
not links: for GitHub, `export GITHUB_MCP_PAT="$(gh auth token)"` when an
authenticated gh CLI exists (check with `gh auth status`), else a
fine-grained read-only PAT from github.com/settings/personal-access-tokens;
for Jira, either `acli jira auth login --web` (install:
developer.atlassian.com/cloud/acli — the lighter path) or `/mcp` and the
Atlassian OAuth flow. `"${CLAUDE_PLUGIN_ROOT}/bin/waybill" status` prints
the same remediation.
