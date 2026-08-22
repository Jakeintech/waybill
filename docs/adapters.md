# Adapters: using other trackers and git hosts

Waybill's core is tool-agnostic: the ledger schema, evidence tiers, and
report logic don't care where receipts come from. Jira and GitHub are just
the bundled defaults, and **git-local** — reading your own commits and
merges straight from local repos, zero auth — is the zero-config floor that
always works. Fetches prefer official CLIs where one exists (`acli` for
Jira, `gh` for GitHub Issues): a CLI call requests exactly the fields sync
needs and writes to a file, where an MCP tool result carries the provider's
full payload through model context. The adapters accept both — the payload
shape, not the transport, is the contract. Coupling lives in exactly four
places:

1. **`.mcp.json`** — which MCP servers are available.
2. **`~/.waybill/config.json`** — `tracker.kind` and `git.kind`, plus
   project/repo scope.
3. **The adapter contracts** (`src/adapters/contract.ts`) — TypeScript
   interfaces every adapter implements: a tracker adapter normalizes raw
   items into `WorkItem`s, a git-host adapter into `MergedChange`s. The
   normalizers are pure, deterministic functions with fixture tests; a
   **conformance kit** (`src/adapters/conformance.ts`) runs any adapter
   against the contract's invariants (no fabricated keys/points/URLs,
   stable ordering, determinism). Own-data scoping lives in the adapters
   themselves — each drops records naming someone else when the matching
   `identity.json` field is set (GitHub login, Jira accountId, GitLab
   username, Linear user id) — and the kit checks it directly
   (`checkOwnDataScoping`, v1.7): given a fixture with a foreign record,
   the record must vanish when identity is set, must *survive* when no
   identity is configured (the adapter is defense-in-depth, never the
   primary filter — over-dropping would hide the user's own data), and
   identity may only ever narrow the output. The kit refuses a fixture
   whose foreign record never appears — a scoping check that never sees
   foreign data proves nothing. Bundled adapters — Jira, Linear, GitHub,
   GitLab, git-local — all pass the same kit, and CI runs it against the
   sync skill's exact documented fetch shapes (acli view compositions,
   `gh pr list` / `gh issue list` JSON).
4. **The `sync` skill's query examples** — JQL for Jira, search syntax for
   GitHub. The skill treats these as examples; with a different server
   connected, Claude adapts to that server's tools, but tested guidance makes
   it reliable.

## Swapping a server

Edit `.mcp.json` (in your local plugin install, or fork the repo) to point at
the equivalent MCP server, for example:

```json
{
  "mcpServers": {
    "linear": { "type": "http", "url": "https://mcp.linear.app/mcp" },
    "gitlab": { "command": "npx", "args": ["-y", "@zereight/mcp-gitlab"],
               "env": { "GITLAB_PERSONAL_ACCESS_TOKEN": "${GITLAB_TOKEN}" } }
  }
}
```

> Verify current server URLs/packages against each vendor's own docs before
> use — endpoints move (Atlassian retired its original SSE endpoint in 2026).

Then update `config.json` (`tracker.kind`, `git.kind`) and re-run
"initialize my waybill ledger" if scope changed.

## What a sync adapter must provide

For the `sync` skill to do its job, the connected servers must be able to
answer, scoped to the current user:

- **Tracker**: my issues updated since \<date\> in \<projects\>, with key,
  title, points/estimate, epic/parent, iteration, status + resolution date.
- **Git host**: my merged PRs/MRs since \<date\> into the default branch of
  \<repos\>, with URL, title, source branch, merge timestamp — **and the
  body/description**: closing keywords there ("Fixes #12") are GitHub's and
  GitLab's real issue↔PR linkage, and the adapters parse them into
  `closes` refs (`owner/repo#number`) that reconcile pairs against tracker
  items. A keyword closes exactly the one reference that follows it,
  mirroring GitHub's own grammar; the conformance kit rejects a `closes`
  ref with no closing keyword in the raw payload. git-local reads commit
  bodies too: a squash-merged commit that says "Fixes #12" counts as a
  merged change even with linear history.

Trackers without story points: leave `points` null and lean on the
cycle-time baseline instead — do not invent a point scale.

## Contributing a tested adapter

Open a PR that adds:

1. The `.mcp.json` server block (auth via env vars, documented).
2. Query-syntax notes for the `sync` skill (the equivalent of the JQL /
   GitHub-search examples).
3. A row in the table below, after actually running init → sync →
   bootstrap report end-to-end.

| Tracker / Git host | MCP server | Status | Notes |
|---|---|---|---|
| git-local | none — reads local `git log` directly | ✅ bundled, default | Zero auth; commits and merges by your own `git config` identities |
| Jira (Atlassian Cloud) | [acli](https://developer.atlassian.com/cloud/acli/) — `acli jira auth login --web` | ✅ bundled adapter, preferred path | `workitem search` for keys, `workitem view --fields …` per item (REST-shaped, custom fields included) — scoped fields, small payloads; see the sync skill |
| Jira + Confluence (Atlassian Cloud) | `https://mcp.atlassian.com/v1/mcp/authv2` (official, OAuth) | ✅ bundled | Points, epics, sprints all available; fallback when acli isn't installed |
| GitHub | the `gh` CLI (`gh pr list --json …`), or `https://api.githubcopilot.com/mcp/` (official, PAT header) | ✅ bundled | gh CLI preferred (scoped fields, small payloads); the adapter accepts REST and gh shapes alike. Fine-grained read-only PAT recommended for the MCP path |
| GitHub Issues (as tracker) | the GitHub server above, or the `gh` CLI directly | ✅ bundled adapter, conformance-tested | Keys are GitHub's own `owner/repo#number` syntax, derived from the issue URL (see note below); labels → `work_type`, milestone → `sprint`; no estimates, so `points` stays null |
| Linear | `https://mcp.linear.app/mcp` (official, OAuth) | ✅ bundled adapter, conformance-tested | Estimates → `points`, cycles → `sprint`, projects → `epic_name`; a live end-to-end test report is a welcome first contribution |
| GitLab | `npx @zereight/mcp-gitlab` (community, PAT) | ✅ bundled adapter, conformance-tested | MRs map to `artifacts.prs`; a live end-to-end test report is a welcome contribution |
| Bitbucket (Cloud) | Atlassian's server, or save the REST 2.0 `pullrequests?state=MERGED` page to a file | ✅ bundled adapter, conformance-tested | Merged PRs map to `artifacts.prs`; the PR object has no `merged_on`, so `updated_on` of a MERGED PR stands in for merge time (documented approximation, verbatim leaf); no closing-keyword linkage, so `closes` is omitted. Own-data via `identity.json.bitbucket_username` (the author nickname). Live end-to-end report welcome |
| Azure DevOps | save the REST `wit/workitems?$expand=links` (or WIQL) response to a file | ✅ bundled adapter, conformance-tested | Work item ids are the keys (`AB#123`-style branch refs match the numeric pattern); StoryPoints/Effort → `points`, iteration path tail → `sprint`, ClosedDate/terminal states → `done`. Own-data via `System.AssignedTo.uniqueName` against the identity map's git emails. Live end-to-end report welcome |

### Composed keys and the no-fabrication check

GitHub issues have no Jira-style key, and their only pattern-shaped payload
leaf (`number: 15`) is useless as a global identifier. The `github-issues`
adapter therefore mints GitHub's own canonical cross-repo reference,
`owner/repo#number` — and the conformance kit holds it to the same
no-fabrication standard as a verbatim key: the adapter declares
`deriveKey(url)`, a pure projection from the issue's URL, and the kit
re-runs it against the `url` leaf (which must itself appear verbatim in the
raw payload) and requires an exact match. An adapter may also declare its
own `keyPattern` when its tracker's key shape differs from
`metering.branch_key_pattern` — the branch pattern governs what metering
extracts from branch names and commit evidence, and is deliberately not
widened for this. Community adapters composing keys should follow the same
pair: declare the shape, derive from a verbatim leaf.
