# Roadmap

## Positioning

One engine, two jobs. The engine is an **evidence-tiered accomplishment
ledger**. The jobs it serves:

1. **The wedge — AI token-budget pitches.** Narrow and urgent: teams that
   allocate Claude tokens by demonstrated value give engineers a recurring
   "prove it" assignment. Org platforms answer it with estimated
   allocations; Waybill answers it with receipts the engineer owns —
   deterministic, verifiable, individual-first (the full field survey:
   [positioning](positioning.md)). This is the launch story.
2. **The market — brag documents.** Performance reviews, promo packets, and
   sprint reviews are the same problem (recall + credibility) for a much
   larger audience. Everything the wedge needs, the market reuses.

Scope test for any proposal: **does it make an individual engineer's claims
more checkable?** If it measures other people, adds a dashboard, or moves
data off the user's machine, it fails the test (see Non-goals).

The normative product specification — including the spend-attribution
engine — lives in [docs/product-spec.md](product-spec.md).

## Shipped — 2.2.0 (2026-08)

Multi-repo attribution completed (per-turn, rules v3 — closes the E-14
warning with the real fix), the dashboard cache-savings tile, the OTel
recipe validated live against a real collector, and the
pre-registration prose aligned with its mechanism end to end. Issues
#18, #20, #21 closed.

## Shipped — 2.1.0 (2026-08)

The launch-readiness release: subagent transcripts metered (the largest
single correctness fix the meter has had — previously invisible spend
now counts, as newly discovered sessions, no re-meter), verification
prose aligned with what each mechanism actually proves (plus a
write-time clock check and a verify warnings channel), meter gaps and
multi-repo sessions disclosed in verify and packs, `init` metering
history so the first receipt carries tokens, the `cache` skill and
`query cache` ("why is my bill like this" — the launch statistic's
engine), the SessionStart hook reduced to pure shell over a
miner-precomputed notice, positioning reframed to the defensible
receipts-not-estimates claim with a dated field survey
([positioning](positioning.md)), and four future directions written
down as design docs (`docs/design/`) instead of code. Full detail:
[CHANGELOG](../CHANGELOG.md).

## Shipped — 2.0.0 (2026-08)

0.3 "Believable + Metered" (M0+M1), 0.4 "Answerable" (M2), and 1.0
"Trustworthy at scale" (M3) are released: the deterministic metering and
attribution engine with conservation verification, escrow, the spend skill
and attribution inbox, budgets/pacing with session-start notices, the OTel
fallback, waste and rework diagnostics, trigger evals, and the schema v2
freeze ([migration policy](migration.md)).

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
([docs/architecture.md](architecture.md)). 1.6.0 shipped the
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
([docs/windows.md](windows.md)), the **OTel live-export recipe**
([docs/otel.md](otel.md)), every architecture-review
recommendation **closed with a recorded disposition**
([docs/architecture.md](architecture.md)), and the
**self-verifying release gate** (`npm run gate`, run in CI). The OSS
engineering scope is complete: changes from here are upkeep, not
construction. The distribution checklist below remains the launch
to-do — its items are repo-settings and publishing actions only the
repo owner can perform.

The sections below record the original plan; the
[CHANGELOG](../CHANGELOG.md) records what shipped.

## The committed path to complete

Recorded 2026-08-22, after the v1.5.0 release and its architecture review
([docs/architecture.md](architecture.md)). The completion thesis: a
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

## Under consideration (free side)

- **External time anchoring for escrow seals** — signing, a remote the
  verifier reads, or OpenTimestamps, so a seal can prove *when* an
  estimate was written rather than only that it hasn't changed since a
  copy was shared. Roadmap, not shipped: today write-time ordering is
  enforced at append (logged_at ≤ ts, wall-clock skew check,
  `appended_at` witness) and disclosed by verify.

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

## Distribution checklist (owner-side; updated at 2.1)

- [x] GitHub repo description starts with "Claude Code plugin"; topics set:
      `claude`, `claude-code`, `claude-plugin`, `mcp`, `jira`, `github`,
      `brag-document`, `performance-review`, `developer-productivity`,
      `ai-roi`, `engineering-metrics`.
- [x] Demo at the top of the README: `assets/demo.svg` — an animated
      terminal (pure SVG/CSS, no scripts, demo data labeled) that
      cold-opens on the payoff frame, holds the final frame, and
      degrades to the full static transcript wherever animation doesn't
      run (2.1). A screen recording of a real session can replace it
      later; the slot is filled.
- [ ] Social preview image set in repo settings — the asset is rendered
      (`assets/social-preview.png`, 1280×640, from the demo's final
      frame per [brand](brand.md)); uploading it in Settings → Social
      preview is the one remaining owner click.
- [ ] Submit to the **community marketplace** via
      <https://platform.claude.com/plugins/submit> (pre-filled answers:
      [directory-submission](directory-submission.md)). The official
      marketplace has no application process — community listing is the
      path.
- [ ] PR to community lists (awesome-claude-code and plugin directories).
- [ ] Launch write-up: *"I built a token meter, then ran it on the
      session that built it"* — **drafted with engine-generated numbers
      only** at [docs/launch-post.md](launch-post.md) (re-render from
      your own ledger if you prefer, then post per the distribution
      plan's rules — posting is the open half).
- [x] Seed 4–6 `good first issue`s — five seeded (#16–#20): adapter
      live-run reports, native-Windows report, a dashboard
      cache-savings tile, a community-adapter recipe, and OTel-recipe
      validation.
