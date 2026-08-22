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

## Shipped — 2.0.0 (2026-08)

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
commits included). 1.5.0 shipped the tested-feedback batch: the
**standup digest** (`query standup` + the `standup` skill — "what did I
do yesterday" from the ledger), **honest pricing end to end** (date-stamp
rate resolution, empty-table auto-import for upgraders, unpriced models
named by `status`/`pricing show`, `pricing_coverage` on every spend
payload), **CLI-first Jira syncs** via Atlassian's acli (scoped fields,
small payloads; MCP fallback kept), and a recorded architecture review
([docs/architecture.md](docs/architecture.md)). 1.6.0 shipped the
first leg of the committed path below: **salvage** (untracked work →
receipts), **conventions**, the **zero-token dashboard**,
**manifest/demurrage**, **overhead tagging** (waybill bills itself), and
the unified timestamp module. 1.7.0 shipped the second leg: the
**verification pack** (`export --pack` — the recipient re-runs the
integrity checks themselves), **estimate calibration** and **model mix**
on `query report`, **cache economics** on every spend payload, the
**retro** skill, the **multi-machine ledger** (union-merge attributes +
the local-refs-only remote line in `status`), and the conformance kit's
**own-data scoping check**. 1.8.0 shipped the third leg — the same
receipts, new audiences, at the cost of three additive report fields:
the **invoice** and **disclose** skills, the **grant-report** and
**incident** report presets, and the documented **portable career
ledger**. 2.0.0 delivered the final leg: **Azure DevOps and Bitbucket
adapters** (conformance- and own-data-tested), the **Windows story**
([docs/windows.md](docs/windows.md)), the **OTel live-export recipe**
([docs/otel.md](docs/otel.md)), every architecture-review
recommendation **closed with a recorded disposition**
([docs/architecture.md](docs/architecture.md)), and the
**self-verifying release gate** (`npm run gate`, run in CI). The OSS
engineering scope is complete: changes from here are upkeep, not
construction. The distribution checklist below remains the launch
to-do — its items are repo-settings and publishing actions only the
repo owner can perform.

The sections below record the original plan; the
[CHANGELOG](CHANGELOG.md) records what shipped.

## The committed path to complete

Recorded 2026-08-22, after the v1.5.0 release and its architecture review
([docs/architecture.md](docs/architecture.md)). The completion thesis: a
real waybill serves everyone who touches the shipment — the performance
review is *one* reader of the receipts, not the product. The scope test
above is unchanged; every item below passes it.

### v1.6 "Salvage" — untracked AI work becomes first-class ✅ shipped 2026-08-22

- **Salvage**: `waybill query untracked` deterministically clusters
  unattributed sessions, branch-only spend, and adhoc accounts (repo +
  branch affinity + time adjacency), each cluster carrying its receipts;
  a `salvage` skill has Claude propose a title per cluster **from the
  receipts only** and one tap appends reconstructed `opened→shipped`
  entries marked as reconstructed. Pre-registration is never backfilled —
  salvage produces facts, not fake tier-3 estimates.
- **Conventions**: `waybill conventions` prints a receipt-friendly
  CLAUDE.md block (key-prefixed branches/commits, closing keywords in PR
  bodies, the "log it" habit) and a `commit-msg` hook template — resolver
  confidence rises because the inputs improve. Salvage fixes the past;
  this prevents the future.
- **The zero-token dashboard**: `waybill dashboard` templates a
  self-contained static page into `rollups/dashboard.html` (spend,
  pacing, open-work manifest, 7-day standup), refreshed by the detached
  miner — reading your own numbers costs no tokens, ever.
- **Manifest & demurrage**: `query manifest` shows what's still on the
  truck (open entries, open spend, age); an item sitting too long earns
  one factual line in `status`.
- **The lightweight doctrine**: the meter tags turns that invoke the
  waybill binary itself, so `spend` can print the receipt that proves the
  plugin's near-zero overhead — the accountant bills for its own hours,
  itemized.
- **One strict timestamp module** — the architecture review's top
  recommendation, retiring the duplicate-window-logic failure class.

### v1.7 "Bill of lading" — arm the recipient ✅ shipped 2026-08-22

- **Verification pack**: `export --pack` bundles a report with the event
  lines it cites and a one-command check, so the *recipient* of a pitch
  or review packet re-runs conservation and escrow themselves.
- **Cache economics** (what cache reads saved vs. uncached list price,
  labeled derived) and **model mix** (tokens-per-shipped-point by model,
  own history only).
- **Estimate calibration** (pre-registered ranges vs. actuals over time)
  and a **retro skill** rendering the honest sprint-retro pack.
- **Multi-machine ledger**: documented private-remote sync for the ledger
  home; `status` reports configured/ahead/behind.
- **Own-data loop closed**: a conformance-kit identity-scoping check plus
  a test running the sync skill's exact documented fetch shapes through
  the adapters.

### v1.8 "Many readers" — the same receipts, new audiences ✅ shipped 2026-08-22

Rendering presets over data the engine already holds: **invoice pack**
(freelancers/agencies: shipped items + hour ranges + AI costs as
client-billable line items), **expense receipt** (personal-key tokens
priced monthly, CSV for finance), **AI-disclosure register** (per shipped
item: claude_role, sessions, token share — the "was AI used here?"
answer, owned by the IC and handed over per item), **maintainer grant
report** (what the sponsorship shipped), **portable career ledger**
(externally-redacted full export that follows your career), and an
**incident-receipts recipe** (a windowed report over the incident
timeframe).

### v2.0 "Delivered" — the free side complete ✅ shipped 2026-08-22 (engineering scope)

- Coverage matrix filled: Azure DevOps and Bitbucket adapters
  (conformance-tested), a Windows story for the hooks, the OTel
  live-export recipe. ✅
- The remaining architecture-review recommendations closed; the release
  gate self-verifying (test counts, doc links, eval criteria). ✅
- The distribution checklist below: **owner-side, outstanding** — repo
  settings, demo recording, directory submissions, and the launch
  write-up are publishing actions, not code.
- With those executed, the OSS project is **complete**: changes are
  upkeep, not construction.

## Beyond the free side (not part of the OSS project)

**Waybill Premium** — the org-side product the receipts make possible,
grown from the old "team mode, opt-in only" exploration: a consent
warehouse (individuals *choose* to publish redacted ledgers — aggregation
is a gift from ICs, never a tap on them), org rate cards replacing
list-price equivalence, a budget desk for account managers (allocations,
renewal calendars, pitch inboxes arriving as verification packs),
showback and procurement views, and compliance roll-ups with SSO and
retention. Built against the frozen receipt schema as a separate product,
so the free side stays whole and finished without it. The rule that makes
both sides work: **premium never sees a number an individual didn't
publish, and free never loses a feature to upsell.**


## Non-goals

Permanent, by design — these are the OSS product's promises. A premium
org-side product (above) never weakens them: its views exist only over
ledgers individuals chose to publish.

- No manager dashboards, surveillance, or activity monitoring.
- No individual peer comparison or ranking, ever.
- No hosted service, accounts, or telemetry; data stays local.
- No time tracking (outcomes and estimates, not keystrokes).
- No support for backfilling `pre_registered: true` — the tier system is
  only worth something if it cannot be gamed. Salvage (v1.6) reconstructs
  facts; it never forges estimates.

## Distribution checklist (executed at v2.0)

- [x] GitHub repo description starts with "Claude Code plugin"; topics set:
      `claude`, `claude-code`, `claude-plugin`, `mcp`, `jira`, `github`,
      `brag-document`, `performance-review`, `developer-productivity`,
      `ai-roi`, `engineering-metrics`.
- [x] Demo at the top of the README: `assets/demo.svg` — an animated
      terminal (pure SVG/CSS, no scripts, demo data labeled) walking
      init → sync → standup → token pitch → verify. A screen recording
      of a real session can replace it later; the slot is filled.
- [ ] Social preview image set in repo settings.
- [ ] Submit to the official plugin directory
      ([anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official))
      — it's available by default in every Claude Code install.
- [ ] PR to community lists (awesome-claude-code and plugin directories).
- [ ] Launch write-up: *"I asked for a bigger Claude budget with receipts"* —
      **drafted** at [docs/launch-post.md](docs/launch-post.md) (swap in
      your real `query report` render, then post to dev.to / r/ClaudeAI /
      Hacker News / the Claude Discord — posting is the open half).
- [x] Seed 4–6 `good first issue`s — five seeded (#16–#20): adapter
      live-run reports, native-Windows report, a dashboard
      cache-savings tile, a community-adapter recipe, and OTel-recipe
      validation.
