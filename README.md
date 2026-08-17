# Waybill

**Bring receipts.** Waybill is token accounting for AI-assisted work — a [Claude Code](https://code.claude.com) plugin that meters every token, attributes it to the Jira story it shipped, and turns the receipts into value reports, performance-review packets, and token-budget requests that survive scrutiny.

A *waybill* is the shipping document that itemizes cargo and its charges. You ship; Waybill keeps the itemized record.

[![CI](https://github.com/YOUR_GITHUB_USERNAME/waybill/actions/workflows/ci.yml/badge.svg)](https://github.com/YOUR_GITHUB_USERNAME/waybill/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-d97757)](https://code.claude.com/docs/en/plugins)

<!-- TODO before launch: 60–90s demo GIF here — sync → bootstrap report → the token pitch rendered as a receipt. -->

## Why

Two conversations decide a lot of an engineer's year, and both run on the same broken input:

- **"What was the AI budget worth?"** — more teams allocate Claude tokens by demonstrated value. Use them well, show it, get more.
- **"What did you accomplish this cycle?"** — performance reviews, promo packets, sprint reviews.

Humans answer both from memory, the night before, in adjectives. The person deciding can't tell honest claims from inflated ones, so they discount everything. Waybill fixes the *evidence*, not the persuasion: it records work as it happens, ties every claim to an artifact — a PR, an issue, a deploy tag, a transcript — and refuses to let you make the kind of claim that gets your next pitch ignored.

## Five minutes to your first report

```bash
claude plugin marketplace add YOUR_GITHUB_USERNAME/waybill
claude plugin install waybill@waybill
export GITHUB_MCP_PAT=github_pat_...   # fine-grained PAT, read access to your repos/PRs
```

Then in a Claude Code session:

1. `/mcp` → complete the OAuth flow for `atlassian`.
2. Say **"initialize my waybill ledger"** (Jira project keys, repos — 60 seconds).
3. Say **"sync my ledger and give me a bootstrap report."**

That last step imports your last ~90 days of *your own* issues and merged PRs and produces a facts-only report immediately — shipped items, points, PRs, deploys — before you've changed a single habit. From then on, opening tasks through the ledger unlocks the stronger claims (see tiers below).

## How it works

| Moment | What happens |
|---|---|
| You start a task | `log` records your **without-Claude estimate first** (pre-registration) |
| You work | A `SessionEnd` hook silently queues session metadata; transcripts are mined later for what happened and real token usage |
| Things merge | `sync` reconciles the ledger against your Jira issues and GitHub PRs |
| You need to make a case | `report` builds a one-page, receipt-linked pitch; `forecast` sizes your next token ask from your own historical tokens-per-story-point |

Coming per the [spec](docs/product-spec.md) (0.3–0.4): automatic token metering with story-level spend attribution, budgets, and pacing — every token itemized to the work it paid for, maintained with zero manual effort.

### Evidence tiers (the whole idea)

Every number in a report states where it came from:

1. **Facts** — merge timestamps, deploy tags, story points, token counts.
2. **Baseline deltas** — your own pre-Claude velocity/cycle time vs. now.
3. **Pre-registered estimates** — logged *before* the work, reported as ranges.
4. **Retrospective judgment** — kept in the ledger, excluded from pitches by default.

Plus structural honesty: append-only storage (corrections supersede, never overwrite), ranges never collapse to midpoints, value counts only when merged or deployed, and costs (tokens spent, rework) appear in every pitch. Full rules: [methodology](skills/ledger/references/methodology.md).

## Report presets

- **`token-pitch`** — the ask, the receipts, the efficiency trend, the forecast.
- **`perf-review`** — epic-level outcomes for a review period, including review/incident/docs work.
- **`sprint-recap`** / **`quarterly`** — the running record.

## What Waybill will never do

- **No manager mode, no surveillance.** It queries only *your* assigned issues and *your* authored PRs.
- **No peer ranking.** The methodology refuses individual colleague comparisons by design — you compete with your own baseline, not with Dave.
- **No hosted service, no telemetry.** Everything lives in `~/.waybill/` (a local git repo you own).
- **No time tracking.** It records outcomes and estimates, not keystrokes.

These are commitments, not gaps. See [ROADMAP.md](ROADMAP.md#non-goals).

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
- **How-to**: [swap Jira/GitHub for Linear, GitLab, Bitbucket…](docs/adapters.md)
- **Reference**: [ledger entry & config schema](skills/ledger/references/schema.md) · [skill reference](docs/skills.md) — the docs Claude reads are the docs you read.
- **Explanation**: [value-measurement methodology](skills/ledger/references/methodology.md) · [roadmap & scope](ROADMAP.md) · [brand & voice](docs/brand.md)
- **Spec**: [full product specification](docs/product-spec.md) — automatic token metering, story-level spend attribution, budgets and pacing (shipping in 0.3–0.4).

## FAQ

**Does it work without Jira or GitHub?** Yes, degraded: manual logging and `git log` still work; you lose auto-sync. Any tracker/git host with an MCP server can be swapped in ([adapters](docs/adapters.md)).

**Can I use this for performance reviews if my company doesn't ration tokens?** Yes — that's the `perf-review` preset. The token pitch is one output of the ledger, not the point of it.

**Is my data private?** Local JSONL under your home directory; the only network calls are the MCP calls you authorize, scoped to your own items.

**Why won't it compare me to teammates?** Story points aren't comparable across people, scraping colleagues reads as surveillance, and your own trajectory is stronger evidence anyway. ([methodology §6](skills/ledger/references/methodology.md))

**How do I justify AI spend to my manager?** Run `sync`, then "build my token pitch". Bring the one-pager; keep the ledger for the follow-up questions.

## Contributing

Issues and PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md), the [roadmap](ROADMAP.md), and issues labeled `good first issue`. Adapter configs for other trackers are the most-wanted contribution. Please read the [Code of Conduct](CODE_OF_CONDUCT.md); security reports go through [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
