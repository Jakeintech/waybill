# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/) — the ledger entry schema is the
compatibility surface.

## [1.5.0] - 2026-08-22

The tested-feedback batch: the standup digest, honest pricing end to end,
and CLI-first Jira syncs — plus a recorded architecture review
([docs/architecture.md](docs/architecture.md)).

### Added
- **Standup digest** — "what did I do yesterday", answered from the ledger
  instead of memory: `waybill query standup` (shipped items windowed on
  ship time, metered work in progress by account, newly opened entries,
  session/token totals, waste, and attention items), with local-calendar
  window words (`--date yesterday|today|YYYY-MM-DD`, `--days <n>`,
  `--now` injectable for determinism) and the query envelope's audience
  redaction. A new `standup` skill renders the bullets ("prep my
  standup", "weekly digest" = `--days 7`; Monday standups use `--days 4`
  — Friday through today), with a trigger eval. Facts only — an empty
  window says so; the ledger doesn't pad.
- **CLI-first sync fetches** — the sync skill now prefers official CLIs
  over MCP tools for both halves. Jira via Atlassian's acli when
  authenticated: `workitem search --fields key` for the JQL window, then
  `workitem view --json --fields <exactly what sync needs>` per item —
  REST-shaped with custom fields, composed verbatim into a bare array the
  jira adapter already accepts (conformance-tested against an
  acli-composed fixture). GitHub PRs via the gh CLI: `gh pr list --json
  url,title,headRefName,mergedAt,body` — the github adapter now accepts
  gh's camelCase rows alongside both REST shapes, deriving the repo from
  the PR's own URL (conformance-tested). Same facts as the MCP paths in a
  fraction of the payload; the MCP flows remain the documented fallbacks,
  and `waybill status` reports which Jira path is active with the exact
  setup command for the lighter one.
- **Pricing coverage** — `query spend` (and the report's spend ledger)
  now carries `pricing_coverage`: priced/unpriced tokens, priced %, and
  the unpriced models, so a USD total always says what it covers. The
  spend/report skills state coverage whenever it is below 100%.

### Fixed
- **Rates really are auto-configured now** — three gaps behind the
  "pricing claims to be configured but costs stay tokens-only" report:
  (1) rate lookup was exact-match, so dated transcript model ids
  (`claude-opus-4-6-20260120`) missed undated table keys — lookup now
  resolves date stamps deterministically (exact key, then the undated
  family key, then the latest dated variant; never across families,
  never guessed); (2) `waybill init` auto-imported bundled rates only on
  a fresh install, silently leaving pre-1.2.0 ledgers rate-less — it now
  imports whenever the rate table is empty, still never touching a table
  holding any rate; (3) nothing named the gap — `waybill status` and
  `pricing show` now cross-check the table against the models actually
  metered and print each unpriced model with the exact fix, and init
  lists missing pricing under "Needs action". A `meter_version` joined
  the per-session checkpoints, so upgraded engines re-meter stale
  sessions once, automatically — existing tokens-only events gain costs
  via superseding corrections on the next `mine`/`meter` run, no
  `--force` needed.
- **Review-hardening batch** — confirmed findings from the recorded
  architecture review ([docs/architecture.md](docs/architecture.md)),
  each with a regression test: rate lookups and meter checkpoints use
  own-property access (a transcript claiming model `"constructor"` can
  no longer crash a meter run); checkpoints carry a pricing-table digest
  (a `pricing set` under an unchanged version string now re-prices as
  promised); `meter_state.json` writes atomically and a torn state file
  loads as empty instead of stalling metering forever; duplicate
  transcript files sharing one sessionId no longer take turns superseding
  each other's receipts; a torn stream line no longer makes every command
  throw (verify reports it instead); verify also flags forked supersession
  chains, non-ISO timestamps, and timestamp-less pre-registrations
  instead of crashing or waving them through; `query`/`export`/`pace`
  reject typo'd flags, missing values, and non-ISO window bounds that
  previously produced silently empty or unbounded "filtered" output;
  `standup --date` refuses impossible calendar dates and labels follow-up
  spend on already-shipped items (`shipped_earlier`); a second
  `resolve --pin` on one session supersedes the first pin instead of
  siring conflicting siblings, and `resolve` honors the metering pause;
  git-local `merged_at` uses the committer date (a squash-merged branch
  no longer predates its own merge); GitLab and Linear adapters gained
  the same own-data defense-in-depth as GitHub/Jira (via optional
  `identity.json` fields); `bootstrap --to` actually bounds the receipt;
  image-only prompts count as turn boundaries; unsplit cache-write
  remainders price at the 5m rate instead of zero; init survives a
  missing pricing bundle, ignores the transient capture queue in the
  ledger repo, reads `settings.local.json` for retention, and labels
  bundled rates as bundled on re-init; the validator enforces
  plugin.json/package.json version agreement.

## [1.4.0] - 2026-08-17

### Added
- **`github-issues` tracker adapter** — GitHub Issues as the tracker of
  record: `waybill sync-plan --tracker github-issues`. Keys are GitHub's
  own cross-repo syntax (`owner/repo#15`), derived purely from the issue
  URL leaf; the conformance kit gained a matching derivation check (a
  composed key passes only when re-deriving it from the verbatim URL leaf
  reproduces it exactly) and adapters may now declare their tracker's own
  `keyPattern` — the metering branch pattern is deliberately untouched.
  Labels map to `work_type`, milestones to `sprint`, `not_planned`
  closures are dropped as cancelled work, PR rows from the REST `/issues`
  endpoint are skipped, and `points` stays null (GitHub has no estimates;
  a point scale is never invented). Both the gh CLI and REST payload
  shapes are accepted. Own-data scoping keeps unassigned issues and drops
  issues assigned only to someone else.
- **Closing-keyword linkage** — `MergedChange` gains `closes`:
  "Fixes #12" in a PR body, MR description, or commit body now pairs the
  change with its tracker item (GitHub's actual linkage mechanism —
  title/branch pattern matching alone was structurally blind to it).
  Keyword-per-reference grammar mirrors GitHub exactly; bare `#15` expands
  against the change's own repo. git-local now captures commit bodies and
  treats a squash-merged commit carrying a closing ref as a merged change,
  so linear-history GitHub-flow repos get receipts too. The conformance
  kit verifies every `closes` ref against a closing keyword in the raw
  payload.

## [1.3.0] - 2026-08-17

The open-issue batch: every UX issue filed against 1.1.1 (#6–#15),
implemented with a regression test each.

### Added
- **A real pause switch (#6)** — `metering.enabled: false` now stops
  everything: the SessionEnd hook captures nothing, `mine` and `meter`
  (all paths, `--otel` included) exit 0 without touching the ledger, and
  `waybill status` reports `metering: PAUSED` so the state is never
  silent. The never-read `metering.sources` field is removed rather than
  left as a decoy; old configs carrying it load unchanged.
- **First-run one-shots (#8)** — the SessionStart path now speaks at the
  two highest-intent moments: not-initialized (“say 'initialize my
  waybill ledger' — 60s, no auth”) and metered-but-nothing-logged (“say
  'sync my ledger' for a receipt from your git history”). At most one
  line per session, each state at most once ever, never stacked on a
  pacing notice.
- **`notices.level` (#9)** — one switch for everything Waybill says
  first: `normal` (default), `minimal` (pacing thresholds and errors
  only — the renewal reminder obeys it), `off` (metering runs, Waybill
  never speaks unprompted). Documented in the README next to the privacy
  commitments, with `budgets.renewal_reminder_days` surfaced alongside.
- **`detail` level (#10)** — `terse` / `standard` / `full`, mirroring
  `audience`: `detail_default` in config, `--detail` on `query`, echoed
  in the query envelope for the rendering layer, with rendering tables in
  the spend/report skills. Floor rule: `terse` may never drop
  unattributed %, confidence values, `low_confidence` labels,
  evidence-tier labels, or ranges — shorter never means less honest.
- **`bin/waybill` launcher (#11)** — a POSIX-sh launcher execs the
  bundled engine, so every skill now invokes
  `"${CLAUDE_PLUGIN_ROOT}/bin/waybill" <command>` — the `node <path>.mjs`
  incantation, its zsh word-splitting caveat, and the per-skill setup
  block are gone. The validator rejects any reintroduction of the old
  idiom.
- **Status is the menu (#15)** — `waybill status` ends with a
  state-derived `next:` line of skill trigger phrases (resolve the inbox
  when it has items, process pending captures when they wait, sync for
  the first receipt, build the pitch once entries exist), so the health
  screen teaches the conversational UI, not just engine subcommands.
- **The exit path, documented (#7)** — a README section covering pause,
  quiet, export, uninstall (`claude plugin uninstall waybill@waybill`),
  and full deletion (`rm -rf ~/.waybill` is the whole footprint).

### Fixed
- **`--json` is honest everywhere (#13)** — `mine --json` emits the
  structured run summary (`mined_new`, `remetered`, `gaps`,
  `already_current`, plus `paused`/`locked` states), `export --json`
  means `--format json`, and contradictory flags (`--json --format csv`)
  are an exit-2 error instead of a silent choice.

## [1.2.0] - 2026-08-17

### Added
- **Bundled Anthropic pricing (D6, reversed)** — `waybill init` now
  auto-imports current Anthropic list rates on a fresh install, and
  `waybill pricing import [--model <id-or-alias>]` loads them any time
  (`references/anthropic-pricing.json`, exact dated model ids, with
  family-alias resolution like `claude-sonnet-4` → `claude-sonnet-4-6`).
  The original 1.1.0 call — no prices ship, the user cites every rate — is
  reversed: bundled rates are the default now, and `waybill pricing set`
  still overrides any single model's rate whenever a different basis
  applies.
- **`waybill init` setup summary** — a "Configured" / "Needs action" report
  covering the ledger, identity, repo scope, pricing basis, transcript
  retention, and whether `GITHUB_MCP_PAT` is set (with the exact export/PAT
  instructions when it isn't). Idempotent: re-running `init` on an existing
  ledger never re-imports pricing or touches a rate set by hand.
- **`waybill pricing import`** — load bundled Anthropic list rates on
  demand, with optional `--model <id-or-alias>` filter (family aliases
  like `claude-sonnet-4` resolve to dated model ids).

### Changed
- Skills, docs, and ROADMAP updated for the D6 reversal: pricing is
  configured by default, not an onboarding hurdle.

## [1.1.1] - 2026-08-17

### Fixed
- **Clean install, clean panel** — the bundled GitHub MCP server used a
  hard `${GITHUB_MCP_PAT}` reference, so every fresh install showed a red
  "missing environment variable" plugin error before any PAT existed. It
  now expands with a default (`${GITHUB_MCP_PAT:-}`): the plugin loads
  clean, and the GitHub upgrade simply stays inactive until a token is set.

### Added
- **Credential help in `waybill status`** — when `GITHUB_MCP_PAT` is
  missing, status says so and prints the exact fix, generating the token
  from an already-authenticated gh CLI when one exists
  (`export GITHUB_MCP_PAT="$(gh auth token)"`), else the fine-grained-PAT
  URL; plus the Atlassian `/mcp` OAuth pointer. Env checks only — Waybill
  still never phones home.
- **`waybill --version`** and the engine version in the `status` header
  (embedded at build time), plus a README "Updating" section:
  `claude plugin update waybill@waybill`, restart, done — Claude Code does
  not push update notifications, and Waybill will not check on its own.
- **The full test plan** ([docs/testing.md](docs/testing.md)): invariant →
  suite map, golden protocol, CI matrix, the manual test matrix, the
  FINALPASS release gate, adversarial-review cadence, and honest coverage
  gaps.

## [1.1.0] - 2026-08-17

Driven by a hands-on user critique — every item below was reproduced in a
real session before it was fixed.

### Added
- **`waybill status`** — one screen of ledger health: initialized?,
  retention (with the exact settings edit), sessions metered and through
  when, unmined captures, meter gaps, unattributed %, inbox size, and a
  verify verdict. The command to run when unsure.
- **`waybill export`** — the spend ledger as CSV or JSON
  (`--from/--to`, `--audience` redaction included): receipts you can hand
  over without hand-written jq.
- **`waybill pricing show|set`** — pricing onboarding without editing
  config.json. All five rates plus a cited `--version` date are required;
  no prices ship with the plugin — an accounting tool doesn't guess rates.
- **`bootstrap --from/--to`** — align the receipt window with
  `query report` windows.

### Fixed
- **zsh-safe skill invocations** — the documented `$WAYBILL verify` idiom
  silently failed on zsh (no word splitting of parameter expansions);
  every skill now uses `node "$WAYBILL" <command>`.
- **Key plausibility gating (rules_version 2)** — the liberal key pattern
  let a commit message mentioning SHA-256 mint a `story:SHA-256` account
  holding real tokens. A stoplist of technical prefixes (SHA, UTF, ISO,
  HTTP, RFC, BASE, …) filters every extraction site, and configured
  `tracker.project_keys` become an authoritative prefix allowlist. The
  rules bump re-meters stale sessions on the next run, superseding
  phantom attributions — history preserved, as always.
- **Reconciling `mine` output** — `mined: N new · M re-metered (inputs
  changed) · K gap(s) · P already current`, so back-to-back runs explain
  themselves.
- **Report field naming** — `totals.metered_tokens` (shipped-work scope)
  is now `totals.shipped_metered_tokens`, so nobody headlines "0 tokens
  metered" while `costs.window_tokens` sits at billions.
- Spend/report skills carry an explicit brevity default: the number
  first, at most three supporting lines, expand only on request.

## [1.0.1] - 2026-08-16

A second adversarial review pass (four lenses over the 0.4/1.0 delta, one
verifier per finding — 12 confirmed) plus a docs-currency sweep.

### Fixed
- **OTel cumulative temporality** — `meter --otel` now reads
  `aggregationTemporality`: cumulative series (Claude Code's counters, and
  the default when absent) take the latest point per (session, model,
  type) instead of summing re-emitted snapshots; delta series still sum.
  Re-ingesting a grown collector file supersedes the prior events instead
  of double-counting, and a transcript appearing later retires a session's
  OTel events entirely via superseding corrections — transcript wins,
  sources never mix, in either order.
- **Reconcile classifies by supersession chain**, not surface kind: a
  correction over an open entry still gets its shipped proposal, and an
  item re-resolved after a reopen gets a correction clearing the flag.
- **Pacing commitments window on the chain-origin ts**, so a late
  correction never re-dates committed points in or out of the period.
- **Stale-lock takeover is race-free** (atomic rename — exactly one
  reaper wins); `resolve` rejects `--pin` together with `--repo-default`;
  a degenerate all-zero duplicate transcript line can no longer clobber
  real usage; unparseable period + granted_at can no longer throw in the
  SessionStart hook path.
- Docs and skills brought fully current: README no longer promises shipped
  features, the frozen schema reference documents `waste`, `reopened`,
  `source: "otel"`, and `budgets.renewal_reminder_days`, CLI help lists
  `--otel` and all adapter enums, report/spend skills render the waste and
  rework numbers, spend owns its trigger phrases, skill versions and the
  lockfile match the release, and dead CHANGELOG links are gone.

## [1.0.0] - 2026-08-16

Milestone M3 "Trustworthy at scale". **Schema v2 is frozen** — see
[docs/migration.md](docs/migration.md) for what additive vs. breaking means
from here on. The receipts are the contract; the reports are the rendering.

### Added
- **Per-account waste diagnostics** — deterministic detection of retry
  loops (identical commands re-run) and duplicate file reads per turn,
  deduped by tool block id, counts only (never commands or paths, per the
  ledger content policy). Rolled up per account in `query spend` and into
  report costs: what this story's tokens bought, and what they wasted.
- **Rework/reopen tracking** — sync detects tracker-reopened shipped items
  and proposes a flagged correction; reports count reopens without erasing
  the shipped work. Quality counterevidence, on the record.
- **Skill trigger evals** — an eval case per skill's canonical phrases plus
  an overtrigger negative (`evals/`), runnable with
  `claude plugin eval waybill@waybill`; CI job gated behind an API-key
  variable so forks stay green.
- **Allocation-cycle reminder** — `pace --notice` nudges once, N days
  before the grant renews (`budgets.renewal_reminder_days`, default 14):
  build the pitch while the receipts are fresh.
- **GitLab adapter** (bundled, conformance-tested): merged MRs →
  `artifacts.prs`.
- **Schema freeze + migration policy** (`docs/migration.md`).

### Notes
- Usage events gain optional `waste`; ledger entries gain optional
  `reopened`. Additive: pre-1.0 events are grandfathered unchanged;
  `waybill meter --all --force` backfills waste on historical sessions if
  wanted.
- Export packs: perf-review reports save as Markdown from the report skill;
  a receipt-styled HTML renderer remains deliberately out of the
  deterministic engine (prose is Claude's job, numbers are the engine's).

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

[Unreleased]: https://github.com/Jakeintech/waybill/compare/v1.5.0...HEAD
[1.5.0]: https://github.com/Jakeintech/waybill/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/Jakeintech/waybill/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/Jakeintech/waybill/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/Jakeintech/waybill/compare/v1.1.1...v1.2.0
[1.1.1]: https://github.com/Jakeintech/waybill/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/Jakeintech/waybill/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/Jakeintech/waybill/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/Jakeintech/waybill/compare/v0.4.0...v1.0.0
[0.4.0]: https://github.com/Jakeintech/waybill/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Jakeintech/waybill/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/Jakeintech/waybill/releases/tag/v0.2.1
