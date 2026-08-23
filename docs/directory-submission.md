# Plugin-directory submission — everything pre-filled

Submissions go to the **community marketplace** through
<https://platform.claude.com/plugins/submit>. Only the repo owner can
submit. The official marketplace (the plugins available by default in
every Claude Code install) has **no application process** — there is
nothing to apply to there; community listing is the path. Everything
the form is likely to ask is collected here — copy-paste and send.

> An earlier draft pointed at a `clau.de/plugin-directory-submission`
> form; that URL is dead. If the submission surface moves again, the
> pre-filled answers below still apply.

## Validating before you submit (the two-manifest wrinkle)

`claude plugin validate --strict` validates whichever manifest it finds
first, and this repo carries **two** in `.claude-plugin/` — the
marketplace manifest (`marketplace.json`) and the plugin manifest
(`plugin.json`). Run it twice so both are actually checked:

1. At the repo root: validates the **marketplace** manifest.
2. Against a copy of the tree with `.claude-plugin/marketplace.json`
   removed: validates the **plugin** manifest.

Both must pass (CI's gate runs the suite; the second variant is the one
a submission reviewer effectively sees).

## Form answers

| Field | Value |
|---|---|
| Plugin name (immutable slug) | `waybill` |
| Display name | Waybill |
| One-line description | Token accounting for AI-assisted work: every Claude Code token metered deterministically and itemized to the story it shipped — receipt-backed value reports, standups, invoices, AI-disclosure registers, and token-budget pitches the recipient can verify offline. |
| Category | `productivity` |
| Source repository | <https://github.com/Jakeintech/waybill> |
| Homepage / docs | <https://github.com/Jakeintech/waybill> (README + full product spec in `docs/`) |
| Author | Jakeintech (<https://github.com/Jakeintech>) |
| License | MIT |
| Current version | 2.0.0 (see [Releases](https://github.com/Jakeintech/waybill/releases)) |
| MCP servers bundled | GitHub (`api.githubcopilot.com`, PAT via `GITHUB_MCP_PAT`, optional) and Atlassian (`mcp.atlassian.com`, OAuth, optional) — both are sync *upgrades*; the plugin is fully functional with zero auth |
| Install (today) | `claude plugin marketplace add Jakeintech/waybill` then `claude plugin install waybill@waybill` |

## The paragraph version (if the form has a free-text pitch)

> Waybill is token accounting for AI-assisted work. A SessionEnd hook
> queues each session and a detached, dependency-free engine meters the
> transcript — no model calls, no network, all data local in
> `~/.waybill/`. Every token is attributed to the Jira/GitHub/Linear/
> GitLab/Azure DevOps story it served, with a per-event resolver name
> and confidence, a conservation check (Σ attributed = Σ observed per
> session), SHA-256-sealed pre-registered estimates, and append-only
> storage. Twelve skills render the receipts for different readers:
> standup digests, one-page token pitches and perf-review packets,
> sprint retros with estimate calibration, invoices, AI-disclosure
> registers, and a verification pack (`export --pack`) that lets the
> *recipient* re-run the integrity checks offline. Hard commitments,
> tested: no peer comparison, no surveillance, no telemetry, no hosted
> service. 192-test suite, reproducible build, adversarial architecture
> review recorded in-repo.

## Quality/security review notes (for the reviewer)

- The shipped engine is a single stdlib-only Node bundle
  (`bin/waybill.mjs`); CI proves it matches `src/` byte-for-byte, and
  the validator fails if it references `node_modules`.
- Hooks never block: the capture script exits 0 on every input
  (7-case hook suite in CI).
- The metering path makes zero network calls; the only child processes
  are local `git` invocations. MCP servers are optional upgrades used
  by the sync skill only.
- Security posture details: `docs/architecture.md` (trust model + a
  recorded 15-agent adversarial review), `docs/VALIDATION.md` (release
  gates), `docs/testing.md` (invariant→suite map).

## Community-list PRs (same material)

For [awesome-claude-code](https://github.com/hesreallyhim/awesome-claude-code)-style
lists, the one-liner:

> **[Waybill](https://github.com/Jakeintech/waybill)** — token
> accounting for AI-assisted work: deterministic metering, story-level
> spend attribution, and receipt-backed reports (standup → token pitch →
> perf review), verifiable offline by the recipient. MIT.
