# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/) — the ledger entry schema is the
compatibility surface.

## [Unreleased]

## [0.4.0] - 2026-08-16

Milestone M2 "Answerable". Every canonical spend question is now one
interaction away, and attribution corrections flow through the same
deterministic engine as everything else.

### Added
- **`spend` skill** — "where am I spending", "what did PLAT-482 cost",
  "how's my burn", and one-tap attribution-inbox resolution.
- **`waybill resolve`** — files an inbox item as a `resolution` event that
  becomes a resolver input (rule 0, user assertion, confidence 1.0), makes
  it durable as a pin or repo default on request, and re-meters the session
  so corrected usage events supersede. Resolutions survive every future
  re-meter.
- **Budgets & pacing** — `waybill pace`: spend vs. linear pace across the
  allocation period, work-weighted pace (points shipped vs. committed),
  per-epic envelopes; `pace --notice` emits at most one line, only when an
  80%/100% threshold is newly crossed. A SessionStart hook surfaces it at a
  natural moment — never nagging, never blocking.
- **OpenTelemetry secondary source** — `waybill meter --otel <export>`
  ingests `claude_code.token.usage` OTLP-JSON for sessions whose
  transcripts are gone. The transcript is the source of truth where one was
  metered; a session never mixes sources.
- **Linear adapter** (bundled, conformance-tested): estimates → points,
  cycles → sprint, projects → epic name; cancelled issues excluded.
- **`sync-plan --local-repo`** — the git-local floor is now self-contained:
  the engine reads local history itself, no intermediate files.
- Acceptance tests scripting the product-spec §8 UX flows 1–4.

### Fixed
All ten adversarially-verified review findings, each with a regression
test: per-session checkpoint versions (a pricing/rules bump re-meters every
stale session); an attribution-inputs fingerprint (pins/resolutions/repo
defaults invalidate the meter fast path — the documented pin flow was a
silent no-op); supersession-chain-aware shipped classification (corrections
no longer drop stories from reports or misclassify open spend); idempotent
supersession (no chain growth on forced re-meters); inclusive, validated
date-only query windows; authoritative story queries; an atomic exclusive
metering lock shared by mine/meter/resolve; deterministic meter-gap
timestamps; per-stream kind validation in `append`; adapter-level own-data
filters; adhoc pseudonymization and numeric-field-safe redaction; escrow
verification across key/title identity changes; macOS repo enrichment in
the capture hook.

### Changed
- Inbox queueing is gated: turns settled at evidence strength or better
  don't nag; genuinely uncertain ones do.
- Zero-token usage rows (synthetic placeholder messages) are skipped at
  parse time and filtered from projections.

## [0.3.0] - 2026-08-16

Milestones M0 "Believable" and M1 "Metered". The deterministic engine
ships: TypeScript (strict) compiled to a single dependency-free
`bin/waybill.mjs`; no model calls and no network anywhere in the
metering/attribution path.

### Added
- **Schema v2**: monthly-sharded append-only streams
  (`streams/{ledger,usage,sessions,exceptions}/YYYY-MM.jsonl`) with
  deterministic content-derived ULID ids and `schema_version` on every
  event; durable per-session receipts keep conservation checkable after
  Claude Code prunes transcripts.
- **`waybill init`** — ledger home as a git repo, identity map
  (git emails, GitHub login, Jira accountId slot), repo scope from the
  current checkout, and a transcript-retention check (surfaces
  `cleanupPeriodDays`, recommends raising it, warns on 0).
- **`waybill bootstrap`** — the zero-auth bootstrap receipt from local git
  history alone (< 60 s first value; measured 0.52 s).
- **`waybill mine`** — detached, dependency-free miner spawned by the
  SessionEnd hook at queue time; session identity from the transcript's
  own `sessionId`; meter gaps recorded for pruned transcripts; lockfile
  against concurrent miners; never blocks a session.
- **`waybill meter`** — deterministic metering: per-(turn, model, account)
  usage events with input/output/cache-read/cache-creation (5m/1h split),
  streaming-duplicate dedupe by message id, sidechain rollup to the parent
  turn, unknown numeric usage fields preserved as summed `raw_extra`,
  incremental re-metering via id dedupe + supersession, retroactive
  `--all` bootstrap, and a conservation self-check.
- **Attribution resolver ladder** (rules_version 1): pin 1.00 →
  active-entry 0.90 → transcript-evidence 0.75 (applies strictly forward;
  a turn is never split) → session-branch 0.60 → repo-default 0.40 →
  unattributed 1.00; ambiguities queue to the attribution inbox and never
  drop tokens.
- **SHA-256 pre-registration escrow** — estimates sealed at the write
  path (`waybill append`), backdating refused, seals verified and carried
  through sync.
- **`waybill verify`** — the integrity contract: envelopes, shard
  placement, unique + recomputable ids, supersedes resolution, escrow
  seals, backdated pre-registration, per-session token conservation.
- **Contract-first adapters** with a conformance kit (determinism,
  ordering, key legality, no fabrication): Jira, GitHub, and the
  zero-auth git-local floor.
- **`waybill sync-plan`** — deterministic reconciliation into
  shipped/correction/orphan proposals with one-confirmation apply and
  median-based baseline derivation (velocity, cycle time).
- **`waybill query`** — spend by account/model/week with confidence,
  story cost with cache-read share, open spend, attribution health and
  inbox, report data (receipts, efficiency, ranged time-saved kept
  separate by basis, utilization), metered tokens-per-point forecasts
  with low-data labeling.
- **Audience redaction** (self / internal / external): external output is
  deterministically pseudonymized (keys, epics, repos, titles, URLs) while
  every number survives.
- **Pricing**: exact e4 fixed-point USD derivation from a configured
  per-model table with `pricing_version`; unknown model ⇒ tokens only,
  `cost_usd: null`, labeled list-price equivalent.
- CI **engine job**: strict typecheck, 69-test suite (unit, golden,
  determinism, conservation, e2e), and a reproducible-build check —
  the committed `bin/waybill.mjs` must match `src/` byte-for-byte.
- `DECISIONS.md` (judgment log) and `VALIDATION.md` (gate evidence).

### Changed
- Skills (`ledger`, `log`, `sync`, `report`, `forecast`) rewritten against
  the engine: all writes go through `waybill append` (deterministic ids,
  escrow), reports and forecasts consume `waybill query` numbers verbatim,
  sync applies deterministic plans. `log` gains session pinning.
- README quickstart now leads with the zero-auth sixty-second path;
  MCP servers are the upgrade, not the entry fee.
- Validator enforces D19 skill naming (single lowercase word, reserved
  words) and the dependency-free engine.

[0.3.0]: https://github.com/Jakeintech/waybill/compare/v0.2.1...v0.3.0

## [0.2.1] - 2026-08-16

### Changed
- **Renamed the project to Waybill** after a naming/brand pass: the former
  name collided with Web3/ESG products, and a waybill — the shipping document
  that itemizes cargo and charges — matches the product exactly. Plugin name,
  skill namespace (`/waybill:*`), data directory (`~/.waybill/`,
  `WAYBILL_HOME`), and docs updated; ledger id prefix in docs/examples is now
  `wb-`. No released data formats affected.
- **Skill naming finalized** to single plain words: `log-work` is now `log`
  (`/waybill:log`); scheme and rules recorded in `docs/skills.md`.
- User-facing voice: the attribution "exceptions queue" is now the
  **attribution inbox** (same rigor, friendlier name); empty states use plain
  language per the new brand guide.

### Added
- `docs/skills.md`: skill reference — naming scheme, invocation table,
  canonical triggers, and reserved words.
- `docs/brand.md`: name decision record, token-accounting positioning, voice
  rules and microcopy, and the receipt-based visual identity.
- Full product specification (`docs/product-spec.md`): deterministic token
  metering, story-level spend attribution with per-event confidence,
  budgets and pacing, spend analytics, and milestones M1–M3.

## [0.2.0] - 2026-08-16

### Added
- `perf-review` report preset — the ledger now serves performance reviews and
  promo packets, not only token pitches.
- **Bootstrap report**: facts-only report generated from ~90 days of synced
  Jira/GitHub history, so first-run users get value in minutes.
- Community health files: CONTRIBUTING, CODE_OF_CONDUCT, SECURITY, issue
  forms, PR template.
- CI (GitHub Actions): plugin structure validation, ShellCheck, hook tests.
- `scripts/validate-plugin.sh` and `tests/test-capture-session.sh` (the
  schema doc's example entries are now validated in CI).
- `docs/adapters.md` — how to swap Jira/GitHub for other trackers/git hosts.
- `ROADMAP.md` with explicit scope, non-goals, and launch checklist.

### Changed
- README rewritten as a landing page (quickstart, evidence tiers, non-goals,
  comparison, FAQ).
- Plugin/marketplace metadata expanded for discoverability
  (brag-document, performance-review, ai-roi keywords).
- `sync` offers the bootstrap report after a first-ever sync.

## [0.1.0] - 2026-08-16

### Added
- Initial release: `ledger` (schema + methodology references), `log`
  with pre-registration, `sync` (Atlassian + GitHub MCP), `report`,
  `forecast`, SessionEnd capture hook, bundled `.mcp.json`, marketplace
  manifest.

[Unreleased]: https://github.com/Jakeintech/waybill/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/Jakeintech/waybill/compare/v0.3.0...v0.4.0
[0.2.1]: https://github.com/Jakeintech/waybill/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Jakeintech/waybill/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Jakeintech/waybill/releases/tag/v0.1.0
