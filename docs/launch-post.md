# I asked for a bigger Claude budget — with receipts

<!-- Launch-post draft (ROADMAP distribution checklist). Before posting:
     1. Replace the sample report below with YOUR real render:
        `waybill query report` → the report skill's token-pitch output.
     2. Adjust the numbers in the prose to match yours.
     3. Suggested venues: dev.to, r/ClaudeAI, Hacker News (Show HN),
        the Claude Discord. Title works as "Show HN: Waybill — token
        accounting for AI-assisted work (Claude Code plugin)". -->

My team allocates Claude Code tokens the way finance allocates anything:
you get a grant, and at renewal someone asks what it was worth. Last
cycle I watched a colleague answer that question from memory, in
adjectives, the night before. They got discounted — not because the work
wasn't real, but because nothing they said was *checkable*.

So I built the boring thing: an accounting system. **Waybill** is a
Claude Code plugin that meters every token from the local transcripts,
attributes each one to the story it served, and renders the receipts
into the two artifacts that decide an engineer's year — the token-budget
pitch and the review packet.

## The pitch it produces

This is the actual one-pager (demo data here; yours renders from your
ledger with `"build my token pitch"`):

> **Since the July grant: 34 points shipped across 2 epics, 11 PRs
> merged and deployed, an estimated 31–58 hours saved (pre-registered
> basis), at 0.9M tokens per point.**
>
> - PLAT-482 Retry logic for checkout webhook (5 pts) — PR #1932,
>   merged 08-12, deployed v2026.08.12 *(pre-registered)*
> - PLAT-495 Config hardening (3 pts) — PR #1951, merged 08-19 …
>   *+9 more (ledger on request)*
>
> Spend ledger: 41.2M tokens metered · top account story:PLAT-482
> (1.5M, conf ≥ 0.9) · **8% unattributed — shown, never hidden** ·
> 62% of grant spent · 1 item reopened after shipping · 14 retried
> commands, 79 repeated reads.
>
> *Methodology: facts (merge/deploy timestamps, metered tokens);
> pre-registered ranges, never midpoints. Metering deterministic,
> conservation-checked (`waybill verify`).*

Notice what's in there *against* me: the unattributed share, the
reopened item, the retry waste. That's the design. The unflattering
numbers are what make the flattering ones believable.

## How it stays honest

The interesting problems were all honesty problems:

- **Counterfactuals are gameable**, so "hours without Claude" estimates
  only count when they're **pre-registered** — logged *before* the work,
  SHA-256-sealed at write time. A backdated estimate fails its seal.
  There is deliberately no way to add tier-3 evidence after the fact.
- **Meters drift**, so every session's per-turn usage must sum exactly
  to the session receipt's totals — a conservation law, re-checkable
  offline. Event ids are content hashes; edit a line and it no longer
  matches its own id.
- **History gets rewritten**, so the ledger is append-only JSONL in a
  local git repo. Corrections supersede; nothing is edited.
- **And the recipient shouldn't have to trust any of this**, so
  `waybill export --pack` ships the verbatim events behind a report
  plus the engine itself. The person reading your pitch runs
  `node waybill.mjs verify --home .` and re-checks the seals and the
  conservation themselves. No network, no install.

The metering path has no model calls and no network at all — it's one
dependency-free Node bundle reading your own transcripts on your own
machine. Claude's part is rendering prose around numbers it is never
allowed to compute.

## What it refuses to do

No manager dashboards, no peer comparison, no hosted service, no time
tracking. It reads *your* assigned issues and *your* authored PRs;
the adapters drop other people's records even when a mis-scoped query
fetches them. Those are commitments in the spec, with tests.

## Try it

```bash
claude plugin marketplace add Jakeintech/waybill
claude plugin install waybill@waybill
# then, in Claude Code:
#   "initialize my waybill ledger"   (60s, zero auth, works offline)
#   "sync my ledger"                 (Jira/GitHub/Linear/GitLab/ADO/Bitbucket optional)
#   "what did I do yesterday"        (standup from the ledger)
#   "build my token pitch"
```

Repo: <https://github.com/Jakeintech/waybill> — MIT, engine + skills +
the full product spec and the recorded adversarial architecture review.
Honest limits and all: the adapters table says exactly which paths have
live end-to-end reports and which still want one. Bring receipts.
