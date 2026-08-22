# Waybill

**Bring receipts.** Waybill is token accounting for AI-assisted work — a [Claude Code](https://code.claude.com) plugin that meters every token, attributes it to the Jira story it shipped, and turns the receipts into value reports, performance-review packets, and token-budget requests that survive scrutiny.

A *waybill* is the shipping document that itemizes cargo and its charges. You ship; Waybill keeps the itemized record.

[![CI](https://github.com/Jakeintech/waybill/actions/workflows/ci.yml/badge.svg)](https://github.com/Jakeintech/waybill/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-d97757)](https://code.claude.com/docs/en/plugins)

<!-- TODO: 60–90s demo GIF here — init → bootstrap receipt → the token pitch rendered as a receipt. -->

## Why

Two conversations decide a lot of an engineer's year, and both run on the same broken input:

- **"What was the AI budget worth?"** — more teams allocate Claude tokens by demonstrated value. Use them well, show it, get more.
- **"What did you accomplish this cycle?"** — performance reviews, promo packets, sprint reviews.

Humans answer both from memory, the night before, in adjectives. The person deciding can't tell honest claims from inflated ones, so they discount everything. Waybill fixes the *evidence*, not the persuasion: it records work as it happens, ties every claim to an artifact — a PR, an issue, a deploy tag, a transcript — and refuses to let you make the kind of claim that gets your next pitch ignored.

## Sixty seconds to your first receipt

```bash
claude plugin marketplace add Jakeintech/waybill
claude plugin install waybill@waybill
```

Then in a Claude Code session, say **"initialize my waybill ledger"**. That's
the whole setup: no accounts, no tokens, no OAuth. Waybill seeds your
identity from `git config`, imports Anthropic list-price rates so costs
appear from day one (dated model ids resolve to their family rate, and
`waybill status` names any model it can't price rather than showing a
quietly partial total), checks your transcript-retention setting, and
renders a **bootstrap receipt** from your local git history alone — your
shipped work, itemized, in under a minute.

### Updating

Claude Code doesn't push plugin-update notifications; updating is one
command whenever you like:

```bash
claude plugin update waybill@waybill
```

Then restart Claude Code. `waybill status` (or `waybill --version`) shows
the engine version you're running. Waybill never checks for updates on its
own — no network calls without you asking is a [commitment](#what-waybill-will-never-do),
not an oversight. Releases and changelogs live on the
[releases page](https://github.com/Jakeintech/waybill/releases); watch the
repo (Watch → Custom → Releases) if you want GitHub to email you.

### The upgrade path (optional, five minutes)

Connecting your tracker and git host turns commits into receipts with story
points, epics, and merge timestamps:

```bash
# Easiest — reuse your authenticated gh CLI:
export GITHUB_MCP_PAT="$(gh auth token)"
# Or mint a fine-grained read-only PAT (repos/PRs) at
# https://github.com/settings/personal-access-tokens and export it instead.
```

1. For Jira, either of:
   - **[acli](https://developer.atlassian.com/cloud/acli/) (preferred —
     scoped fields, small payloads):** install it, then
     `acli jira auth login --web`. Syncs fetch through it automatically.
   - **Atlassian MCP:** `/mcp` → complete the OAuth flow for `atlassian`
     (no token needed).
2. Say **"sync my ledger and give me a bootstrap report."**

Not sure what is or is not connected? `waybill status` says, and prints the
exact command to fix anything missing.

That imports your last ~90 days of *your own* issues and merged PRs and
produces a facts-only report — shipped items, points, PRs, deploys — before
you've changed a single habit. From then on, opening tasks through the
ledger unlocks the stronger claims (see tiers below).

## How it works

| Moment | What happens |
|---|---|
| You start a task | `log` records your **without-Claude estimate first** (pre-registration), sealed with a SHA-256 escrow hash |
| You work | A `SessionEnd` hook queues the session and a detached, dependency-free miner meters real token usage from the transcript — no model calls, no network, never blocking |
| Things merge | `sync` reconciles the ledger against your Jira issues and GitHub PRs (or Linear, GitLab, or plain local git) |
| You wonder where it went | `spend` answers by story/epic/model/week, files the attribution inbox one tap at a time, and tracks budget pacing — one line at 80%/100%, never nagging |
| It's 9:58 and standup is at 10 | `standup` turns the ledger into "what I did yesterday" bullets — shipped, in progress, started — every line traceable to a receipt; `--days 7` makes it a weekly digest |
| Work shipped without a ticket | `salvage` clusters the untracked spend with its receipts (sessions, branches, PRs), proposes what each group plainly was, and turns your one-tap confirmations into reconstructed entries — facts tier, never forged estimates |
| You just want to *look* | `waybill dashboard` writes a self-contained local page (spend, pacing, open work, last 7 days) the miner keeps fresh — reading your own numbers costs **zero tokens** |
| The sprint ends | `retro` runs the honest look back: estimates vs. actuals (over-range items named, not hidden), tokens-per-point by model, waste, rework, and what sat on the truck |
| You need to make a case | `report` builds a one-page, receipt-linked pitch; `forecast` sizes your next token ask from your own metered tokens-per-story-point |
| They should not have to trust you | `waybill export --pack` ships the **verification pack**: the verbatim events behind the numbers plus the engine itself, so the recipient re-runs the integrity checks offline — `node waybill.mjs verify --home .` |
| A client, a policy, or finance asks | `invoice` renders shipped work as billing paperwork (recorded hours, disclosed AI costs); `disclose` answers "was AI used here?" per item from the meter — recorded role, sessions, tokens, conservation-checked |

Every Claude Code token is metered deterministically from your local
transcripts and attributed to the story it served, with a per-event resolver
name and confidence, a conservation check (Σ attributed = Σ observed, per
session) you can re-run offline with `waybill verify`, an attribution inbox
for the ambiguous leftovers, and per-story waste diagnostics (what the
tokens bought — and what they wasted on retry loops). As of 1.0 the
[schema is frozen](docs/migration.md): the receipts are the contract.

### Evidence tiers (the whole idea)

Every number in a report states where it came from:

1. **Facts** — merge timestamps, deploy tags, story points, token counts.
2. **Baseline deltas** — your own pre-Claude velocity/cycle time vs. now.
3. **Pre-registered estimates** — logged *before* the work, reported as ranges.
4. **Retrospective judgment** — kept in the ledger, excluded from pitches by default.

Plus structural honesty: append-only storage (corrections supersede, never overwrite), ranges never collapse to midpoints, value counts only when merged or deployed, and costs (tokens spent, rework) appear in every pitch. Full rules: [methodology](skills/ledger/references/methodology.md).

## Report presets

- **`token-pitch`** — the ask, the receipts, the spend ledger, the efficiency trend, the forecast.
- **`perf-review`** — epic-level outcomes for a review period, including review/incident/docs work.
- **`sprint-recap`** / **`quarterly`** — the running record.
- **`grant-report`** — what the sponsorship shipped, for maintainers and their funders.
- **`incident`** — the receipts pack over an incident timeframe: timeline facts, no efficiency math.
- Beyond reports: the **career ledger** (externally-redacted full export that follows you between jobs — see the ledger skill's exit section) and the `invoice`/`disclose` skills above.

Reports render at three audience levels — `self`, `internal`, `external` —
with deterministic pseudonymization before anything leaves the org.

## What Waybill will never do

- **No manager mode, no surveillance.** It queries only *your* assigned issues and *your* authored PRs.
- **No peer ranking.** The methodology refuses individual colleague comparisons by design — you compete with your own baseline, not with Dave.
- **No hosted service, no telemetry.** Everything lives in `~/.waybill/` (a local git repo you own).
- **No time tracking.** It records outcomes and estimates, not keystrokes.

These are commitments, not gaps. See [ROADMAP.md](ROADMAP.md#non-goals).

## Pausing, quieting, leaving

Trust in a tool that logs your work includes knowing exactly how to stop
it. The full exit path, from turning it down to walking away:

- **Pause metering** (client engagement, shared machine, debugging): set
  `"metering": { "enabled": false }` in `~/.waybill/config.json`. Nothing
  is captured or metered while paused — `waybill status` reports
  `metering: PAUSED` so the state is never silent. Existing data is
  untouched; flip it back to resume.
- **Turn down the talking**: `"notices": { "level": "minimal" }` keeps
  only budget-threshold lines (`"off"` silences everything Waybill says
  unprompted — metering still runs). The renewal reminder
  (`budgets.renewal_reminder_days`, default 14) obeys the same switch.
- **Take your data**: `waybill export --format json` (or `csv`) emits the
  spend ledger; the entire ledger is already plain JSONL in `~/.waybill/`
  — a local git repo you own. Copy it anywhere; nothing is proprietary.
- **Uninstall the tool, keep the data**:
  `claude plugin uninstall waybill@waybill`, then restart Claude Code.
  Hooks and skills go away; `~/.waybill/` stays yours.
- **Delete everything**: `rm -rf ~/.waybill` (or `$WAYBILL_HOME` if you
  set one). That is the whole footprint — Waybill keeps no other state.
  Session transcripts under `~/.claude/` belong to Claude Code, not
  Waybill, and are governed by its `cleanupPeriodDays` setting.

## Compared to the alternatives

| | Memory / a spreadsheet brag doc | Org admin dashboards | Waybill |
|---|---|---|---|
| Captured when it happens | ✗ | ✓ | ✓ |
| Tied to PRs/issues/deploys | ✗ | partial | ✓ |
| Honest counterfactuals | ✗ | ✗ | ✓ (pre-registered, ranged) |
| Works bottom-up, for *you* | ✓ | ✗ | ✓ |
| Data you own locally | ✓ | ✗ | ✓ |

## Docs

- **Tutorial**: this README's quickstart, above.
- **How-to**: [swap Jira/GitHub for Linear, GitLab, Bitbucket, Azure DevOps…](docs/adapters.md) · [one ledger on several machines](docs/multi-machine.md) · [Windows](docs/windows.md) · [the OTel fallback](docs/otel.md)
- **Reference**: [ledger entry & config schema](skills/ledger/references/schema.md) · [skill reference](docs/skills.md) · [test plan](docs/testing.md) — the docs Claude reads are the docs you read.
- **Explanation**: [architecture & system design](docs/architecture.md) — how the pieces compose, the trust model, and the recorded 1.5.0 review · [value-measurement methodology](skills/ledger/references/methodology.md) · [roadmap & scope](ROADMAP.md) · [brand & voice](docs/brand.md) · [schema freeze & migration policy](docs/migration.md)
- **Spec**: [full product specification](docs/product-spec.md) — the normative design the shipped engine implements.

## FAQ

**Does it work without Jira or GitHub?** Yes — that's the default. Git-only mode needs zero configuration and zero auth: metering, attribution by branch/pin, and the bootstrap receipt all run from local data. Connecting a tracker/git host upgrades the receipts; any of them with an MCP server can be swapped in ([adapters](docs/adapters.md)).

**Can I use this for performance reviews if my company doesn't ration tokens?** Yes — that's the `perf-review` preset. The token pitch is one output of the ledger, not the point of it.

**Is my data private?** Local JSONL under your home directory. The engine itself makes no network calls; syncs go through the CLIs (`acli`, `gh`) or MCP servers you authorize, scoped to your own items, and `init`/`status` may invoke your locally authenticated `gh`/`acli` to read who you are — nothing of yours is ever sent anywhere you didn't point it.

**Why won't it compare me to teammates?** Story points aren't comparable across people, scraping colleagues reads as surveillance, and your own trajectory is stronger evidence anyway. ([methodology §6](skills/ledger/references/methodology.md))

**How do I justify AI spend to my manager?** Run `sync`, then "build my token pitch". Bring the one-pager; keep the ledger for the follow-up questions.

## Contributing

Issues and PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md), the [roadmap](ROADMAP.md), and issues labeled `good first receipt`. Adapter configs for other trackers are the most-wanted contribution. Please read the [Code of Conduct](CODE_OF_CONDUCT.md); security reports go through [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
