# Roadmap

## Positioning

One engine, two jobs. The engine is an **evidence-tiered accomplishment
ledger**. The jobs it serves:

1. **The wedge — AI token-budget pitches.** Narrow, urgent, and currently
   unserved: teams that allocate Claude tokens by demonstrated value give
   engineers a recurring "prove it" assignment with no tooling. This is the
   launch story.
2. **The market — brag documents.** Performance reviews, promo packets, and
   sprint reviews are the same problem (recall + credibility) for a much
   larger audience. Everything the wedge needs, the market reuses.

Scope test for any proposal: **does it make an individual engineer's claims
more checkable?** If it measures other people, adds a dashboard, or moves
data off the user's machine, it fails the test (see Non-goals).

The normative product specification — including the spend-attribution
engine — lives in [docs/product-spec.md](docs/product-spec.md).

## Shipped — 1.4.0 (2026-08)

0.3 "Believable + Metered" (M0+M1), 0.4 "Answerable" (M2), and 1.0
"Trustworthy at scale" (M3) are released: the deterministic metering and
attribution engine with conservation verification, escrow, the spend skill
and attribution inbox, budgets/pacing with session-start notices, the OTel
fallback, waste and rework diagnostics, trigger evals, and the schema v2
freeze ([migration policy](docs/migration.md)).

1.1.x added `waybill status`, `waybill export`, and `waybill pricing`.
1.2.0 reversed D6: **bundled Anthropic list rates** auto-import on
`waybill init`; `waybill pricing import` refreshes on demand. Pricing is
configured by default, not an onboarding hurdle. 1.3.0 closed the whole
UX-issue batch (#6–#15): a real metering pause switch, `notices.level`,
first-run one-shot lines, the `detail` axis, the `bin/waybill` launcher,
honest `--json`, the status next-actions menu, and the documented exit
path. 1.4.0 made GitHub Issues a first-class tracker: the `github-issues`
adapter (derivation-verified `owner/repo#N` keys) and closing-keyword
linkage ("Fixes #12" in PR/commit bodies pairs changes with items — squash
commits included).

The sections below record the original plan; the
[CHANGELOG](CHANGELOG.md) records what shipped.

## Foundation — 0.2.x (scaffold)

- Core loop: pre-registered `log`, SessionEnd capture + transcript
  mining, Jira/GitHub `sync`, `report` (token-pitch, perf-review,
  sprint-recap, quarterly), `forecast`.
- **Bootstrap report**: a facts-only report from ~90 days of tracker/git
  history on first sync, so the first five minutes deliver value before any
  habit change.
- Gold-star repo baseline: CI, validator, tests, community health files.

## Next — 0.3 "Believable + Metered" (spec M0 + M1)

- **Trust scaffolding (M0)**: identity map, ledger init as a git repo with
  monthly-sharded streams, transcript-retention check, git-local adapter +
  bootstrap receipt (< 60 s, zero auth, zero config), SessionEnd hook with a
  detached dependency-free miner, SHA-256 pre-registration escrow.
- **Deterministic metering engine (M1)** (`bin/waybill.mjs meter`): exact
  token counts from local session records, incremental with checkpoints,
  retroactive ~90-day bootstrap, conservation check enforced in CI with
  fixture transcripts.
- **Attribution engine**: spend assigned to Jira stories/epics via the
  pin → active-entry → transcript-evidence → branch → repo-default resolver
  chain, confidence on every event, and an attribution inbox for ambiguity.
- **Schema v2**: `usage.jsonl` fact stream, config pricing table, budgets
  (additive — minor release).

## Then — 0.4 "Answerable" (spec M2)

- **`spend` skill**: "where am I spending", "what did PLAT-482 cost",
  "how's my burn", one-tap attribution-exception resolution.
- **Budgets & pacing** against the allocation and optional per-epic
  envelopes, surfaced without nagging.
- **Spend ledger** section in the token pitch; **metered rates** in the
  forecast (manual token entry becomes an override, not a requirement).
- **OpenTelemetry as secondary source** for sessions without transcripts.
- **Confluence publisher** (opt-in) and the **first community adapter**
  (Linear or GitLab), with a tested-config table in `docs/adapters.md`.

## Later — 1.0 "Trustworthy at scale" (spec M3)

- **Skill trigger evals in CI**: scripted `claude -p` checks that each
  skill's description actually triggers on its canonical phrases (skills
  chronically undertrigger; descriptions are the UI).
- **Per-account waste diagnostics**: deterministic detection of retry loops
  and duplicate reads over tool-call patterns, rolled up per story — what
  this story's tokens bought, and what they wasted.
- **Rework/reopen tracking** on Claude-assisted items (quality
  counterevidence — the "but is the code good?" answer).
- **Allocation-cycle automation**: a scheduled reminder flow that drafts the
  pitch N days before each grant renewal recorded in `config.json`.
- **Export packs**: perf-review output as Markdown from the report skill;
  spend ledger as CSV/JSON via `waybill export`. *(Shipped 1.0/1.1.)*
- **Schema freeze** and a documented migration policy.

## Exploring (not committed)

- **Team mode, opt-in only**: individuals *choose* to publish their ledgers
  to a shared warehouse; semantic views (e.g. Snowflake) bridge tracker +
  git + usage domains for org-level AI ROI analytics. Ships only with an
  explicit consent model — aggregation must be a gift from ICs, never a tap
  on them. This is where the original "semantic analytics over Snowflake
  semantic layers" idea lives.

## Non-goals

Permanent, by design — these are the product's promises:

- No manager dashboards, surveillance, or activity monitoring.
- No individual peer comparison or ranking, ever.
- No hosted service, accounts, or telemetry; data stays local.
- No time tracking (outcomes and estimates, not keystrokes).
- No support for backfilling `pre_registered: true` — the tier system is
  only worth something if it cannot be gamed.

## Distribution checklist (0.2 launch)

- [ ] GitHub repo description starts with "Claude Code plugin"; topics set:
      `claude`, `claude-code`, `claude-plugin`, `mcp`, `jira`, `github`,
      `brag-document`, `performance-review`, `developer-productivity`,
      `ai-roi`, `engineering-metrics`.
- [ ] 60–90s demo (GIF or asciinema) at the top of the README:
      sync → bootstrap report → token pitch.
- [ ] Social preview image set in repo settings.
- [ ] Submit to the official plugin directory
      ([anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official))
      — it's available by default in every Claude Code install.
- [ ] PR to community lists (awesome-claude-code and plugin directories).
- [ ] Launch write-up: *"I asked for a bigger Claude budget with receipts"* —
      include the actual generated report as the artifact. Post to dev.to /
      r/ClaudeAI / Hacker News / the Claude Discord.
- [ ] Seed 4–6 `good first issue`s (adapters, report templates, test cases).
