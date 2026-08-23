# Decisions

Judgment calls made during implementation, per the dispatch brief: where the
brief conflicts with the scaffold the brief wins; where neither resolves a
question, the choice that best preserves checkability and local-first privacy
wins. Format: date, question, choice, rationale.

## 2026-08-16 — Brief §4–§12 detail reconstructed

**Question.** The dispatched copy of the FINALPASS brief abbreviates §4–§12
("refer to the full spec document"), and no separate full-text document was
provided beyond the scaffold.

**Choice.** Treat the scaffold's `docs/product-spec.md` as the normative
product detail (the brief itself names it as part of the starting tree),
apply decisions D1–D20 and the brief's §10 execution order on top, and
record every reconstruction below. Where the two disagree, the brief wins.

**Rationale.** The brief explicitly designates the scaffold docs as spec
inputs and itself as the tiebreaker; this maximizes fidelity without
inventing requirements.

## 2026-08-16 — Milestone naming: M0 "Believable" + M1 "Metered"

**Question.** The scaffold's product-spec §11 numbers milestones M1
"Metered" (0.3) / M2 "Answerable" (0.4) / M3 (1.0); the brief orders work as
M0 "Believable" then M1 "Metered", tagging `v0.3.0` after M1.

**Choice.** The brief's numbering governs delivery: M0 "Believable"
(identity map, ledger init, retention check, git-local adapter, bootstrap
receipt, hooks + detached miner, escrow in `log`) and M1 "Metered" (the
metering/attribution engine, adapters, sync, report, forecast) both ship in
`v0.3.0`. The product-spec's M2/M3 remain the 0.4 / 1.0 roadmap under new
numbers (M2 "Answerable", M3 "Trustworthy at scale").

**Rationale.** Brief wins over scaffold; the scaffold's own 0.3 scope is a
superset match for the brief's M1.

## 2026-08-16 — Event ids: deterministic ULIDs

**Question.** D-stream says ULID ids; scaffold schema used
`wb-<UTCstamp>-<hex4>`. Random ULIDs would violate invariant 8 (identical
inputs ⇒ byte-identical output) for meter-derived events.

**Choice.** All events use 26-char Crockford-base32 ULIDs. For derived
events (usage, sessions, exceptions, sync-generated entries) the timestamp
component comes from the event `ts` and the 80-bit entropy component is the
first 10 bytes of SHA-256 over the stream name plus the event's canonical
content (excluding `id`). Interactively written ledger entries use the same
construction — ids are a pure function of content everywhere.

**Rationale.** Keeps ULID sortability and uniqueness while making the whole
fact stream replayable byte-for-byte. No 0.2.x data formats were ever
released (CHANGELOG), so no migration is needed.

## 2026-08-16 — Monthly-sharded streams layout

**Question.** D10 requires monthly-sharded JSONL streams; the scaffold
described flat `ledger.jsonl` / `usage.jsonl`.

**Choice.** `$WAYBILL_HOME/streams/<stream>/<YYYY-MM>.jsonl` for streams
`ledger`, `usage`, `sessions`, `exceptions`, sharded by the UTC month of
each event's `ts`. `sessions` is new: one durable per-session record with
source totals, so conservation stays verifiable after Claude Code prunes the
transcript. Meter discrepancies and gaps are events in `exceptions`
(kinds `meter_discrepancy`, `meter_gap`) alongside attribution ambiguities.

**Rationale.** Brief wins on sharding; the sessions stream is the
checkability-preserving answer to transcript retention (D7): the receipt
outlives the source.

## 2026-08-16 — Escrow design (D13)

**Question.** "Pre-registration escrow with SHA-256" — mechanism unspecified.

**Choice.** When an `opened` entry records a pre-registered estimate, the
entry carries `escrow: {algo:"sha256", payload:"estimate.v1", sha256:<hex>}`
where the hash covers the canonical string
`estimate.v1|<tracker_key-or-title>|<low>|<high>|hours|<logged_at>`.
The estimate itself stays cleartext in the entry. `waybill verify`
recomputes every escrow hash; the ledger's git history provides the second,
independent tamper witness.

**Rationale.** A commitment that can always be re-verified locally beats
secrecy schemes; two independent witnesses (content hash + git history) make
backdated or edited estimates detectable, which is the point of
pre-registration.

## 2026-08-16 — "T2 harness" interpretation

**Question.** Brief §10 orders "resolver + T2 harness" without defining T2.

**Choice.** Implemented as the table-driven (T2 = table-type-2) resolver
test harness: a declarative case table covering every resolver rule (1–6),
every fall-through path, segmentation on evidence switches, and ambiguity
routing, executed by one runner.

**Rationale.** Matches the position in the build order (immediately after
the resolver) and the spec's demand that "every resolver rule" be
fixture-proven.

## 2026-08-16 — Single `bin/waybill.mjs` CLI

**Question.** How to ship the deterministic engine under D1 (zero runtime
deps in shipped bin/).

**Choice.** One committed, esbuild-bundled, stdlib-only Node ESM executable
`bin/waybill.mjs` with subcommands (`init`, `bootstrap`, `mine`, `meter`,
`verify`, `query`, `sync-plan`, …). TypeScript sources in `src/`; CI
rebuilds the bundle and fails on diff, so the committed artifact provably
matches the sources. Tests run with `node --test` on native type-stripped
TS (erasable syntax only); `tsc --noEmit` typechecks.

**Rationale.** One artifact keeps the reproducible-build check trivial and
the hook path dependency-free; Node is guaranteed present wherever Claude
Code runs.

## 2026-08-16 — Miner writes, then best-effort commits

**Question.** The detached miner (D8) appends events inside the
`~/.waybill` git repo; should it also commit?

**Choice.** The miner appends (line-atomic), then attempts a single
`git add -A && git commit` in `$WAYBILL_HOME`, silently tolerating failure
(e.g. lock contention); the next writer's commit picks up anything left
dirty. Files, not git, are the source of truth; git is the audit trail.

**Rationale.** Zero-touch steady state must not depend on a skill running,
and a hook-spawned process must never fail loudly or fight over locks.

## 2026-08-16 — Pins live in the ledger stream

**Question.** Where does resolver rule 1's pin (session/time-range →
account, confidence 1.0) persist?

**Choice.** As ledger events, `kind: "pin"` (schema v2 addition), with
`session_id` and optional time range; unpin is a `correction` superseding
the pin. The resolver reads pins from the ledger stream only.

**Rationale.** Pins are user assertions — exactly what the ledger stream
holds; append-only supersession preserves the audit trail.

## 2026-08-16 — Zero-config default scope (D3/D4)

**Question.** What does `init` produce with zero answers and zero auth?

**Choice.** `config.json` with `tracker.kind: null`, `git.kind: "local"`,
`repos` seeded from the repo containing the working directory (if any),
identity map seeded from `git config` emails/names plus `gh api user` login
when the gh CLI is already authenticated (no auth flow is ever started).
The bootstrap receipt renders from local git history alone.

**Rationale.** D3/D4 verbatim: first value from git history alone, under
60 seconds, zero auth; MCP servers are the upgrade path, not the entry fee.

## 2026-08-16 — Placeholder identity

**Question.** Scaffold placeholders `YOUR NAME` / `YOUR_EMAIL@example.com`.

**Choice.** `Jakeintech` and `info@jakeawilliams.com`, from the machine's
git config and gh auth (the account the brief names).

**Rationale.** Matches the identity that signs the commits (DCO).

## 2026-08-16 — Incremental metering by recompute, not byte-offset streaming

**Question.** FR-M3 sketches checkpoints as "last processed message id +
byte offset". Resuming a parse mid-file requires carrying parser context
(current turn, branch, session identity) inside the checkpoint, which makes
the checkpoint itself a correctness liability.

**Choice.** The meter re-parses the whole transcript deterministically and
achieves incrementality through content-derived ids: unchanged turns
produce identical events (skipped), changed turns produce superseding
events, and `meter_state.json` keeps `file_bytes` per session as the
fast-path short-circuit (size unchanged + same rules/pricing versions ⇒
skip the file entirely).

**Rationale.** O(session bytes) per changed file is comfortably inside
NFR-2 (<2 s/session; the real-machine retro run metered 14 sessions in
about a second), and idempotency-by-id is provable with golden tests
rather than trusted to resume bookkeeping.

## 2026-08-16 — raw_extra: unknown numeric usage fields, summed per turn

**Question.** FR-M1 says unknown usage fields are "preserved under
raw_extra rather than dropped", but a usage event aggregates many source
messages.

**Choice.** Unknown *numeric* usage fields are flattened to dot-paths
(e.g. `server_tool_use.web_search_requests`) and summed per (turn, model);
non-numeric unknowns are not copied (the transcript remains the archive,
and D11 bars content-like values from the ledger).

**Rationale.** Sums are meaningful, deterministic, and audit-friendly;
copying arbitrary structures per event would bloat the stream and risk
carrying text.

## 2026-08-16 — Bootstrap receipt renders; it never writes ledger entries

**Question.** Should the M0 git-local bootstrap create `shipped` entries
from commit history?

**Choice.** No. `waybill bootstrap` is a rendered report (receipt) over
git facts and any metered usage; ledger entries are only written through
`log`/`sync` flows with explicit confirmation, and history-imported
orphans are marked `claude_role: "none"` with a note that Claude
involvement is unrecorded.

**Rationale.** Zero-auth first value must not seed the ledger with
weak-evidence entries; the ledger's credibility is the product.

## 2026-08-16 — Pricing in e4 fixed-point

**Question.** Float arithmetic put half-cases (e.g. $0.047850) on the
wrong side of the rounding boundary depending on binary representation.

**Choice.** Rates are converted to integer e4 units (1/10000 USD per
mtok); token×rate products stay integral, and the 4-decimal rounding is
exact. Rates with more than four decimals fall back to float math.

**Rationale.** An accounting tool's rounding should be reproducible by a
reviewer with a calculator.

## 2026-08-16 — Spend questions live in `waybill query` until 0.4

**Question.** The `spend` *skill* is reserved for 0.4, but M1 must answer
the FR-Q spend questions.

**Choice.** The deterministic engine answers them now (`waybill query
spend | story <KEY> | inbox`), and the `report` skill fronts them
conversationally; the dedicated `spend` skill ships in 0.4 as planned.

**Rationale.** Keeps the 0.4 scope promise while making every canonical
question answerable from local data in 0.3.

## 2026-08-16 — GitHub release created alongside the v0.3.0 tag

**Question.** The brief mandates tagging `v0.3.0`; it does not mention a
GitHub release object.

**Choice.** Tag and a GitHub release with the CHANGELOG excerpt, since the
repo's own CONTRIBUTING documents tagged releases as the distribution
mechanism for a public plugin.

**Rationale.** A public marketplace plugin without a visible release is
harder to audit; the release notes are the receipt.
## 2026-08-16 — Inbox queueing is gated on unsettled turns

**Question.** FR-A4 literally read says every multi-candidate rule match
queues an ambiguity, but that nags: a session on a clearly-named branch
with two open entries would queue every turn even though transcript
evidence settled the attribution at 0.75+.

**Choice.** The resolver still reports every ambiguity; the meter queues it
to the inbox only when the turn's final resolver is weaker than
`transcript_evidence` (i.e. `session_branch`, `repo_default`, or `none`).
Settled turns don't nag; genuinely uncertain ones do.

**Rationale.** FR-B3's "never as nagging" and the flow-1 narrative ("two
exceptions offered") outrank a literal reading of FR-A4; the ambiguity is
still visible in the resolver's output for anyone re-deriving.

## 2026-08-16 — OTel ingestion shape

**Question.** FR-M2 requires an OTel secondary source without specifying
the transport.

**Choice.** `waybill meter --otel <file>` parses OTLP-JSON lines (the shape
a file-exporting collector writes) for `claude_code.token.usage` data
points, aggregates per (session.id, model), and emits `source: "otel"`
usage events + session receipts only for sessions with no transcript-based
receipt. Turn granularity is a single synthetic turn 0 (OTel has no turns);
cache 5m/1h split is unavailable and recorded as 0; attribution runs the
ladder minus transcript-only signals.

**Rationale.** File-based OTLP is the only transport that keeps the
no-network invariant; "transcript wins, never mix" is enforced by
construction.

## 2026-08-16 — Waste diagnostics: counts on the turn's first model event

**Question.** Waste (retry loops, duplicate reads) is turn-level, but the
usage grain is (turn, model).

**Choice.** Tool blocks are deduped by block id (streamed lines repeat),
tallied per turn, and the counts ride once — on the turn's
lexicographically-first model event — as an optional `waste` field; D11
means counts only, never command text or paths (asserted by a
string-absence test).

**Rationale.** One carrier per turn keeps rollups double-count-free while
staying inside the frozen additive-schema rules.

## 2026-08-16 — OTel temporality and re-ingestion (1.0.1)

**Question.** The 0.4 OTel ingest summed every data point and never
superseded on re-ingest — a growing collector file (the normal setup)
over-counted cumulative series and double-counted sessions.

**Choice.** Temporality-aware parsing: DELTA series sum; CUMULATIVE (and
absent-temporality, the OTLP-counter default) series take the latest point
per (session, model, type). Re-ingest supersedes the prior otel event per
(session, model) and the prior receipt, with the same unchanged-modulo-
supersedes guard as the transcript path. If a transcript later appears for
an otel-metered session, transcript metering retires every otel event via
superseding corrections — transcript wins, sources never mix.

**Rationale.** Conservation is the product; both paths now converge to one
authoritative account of a session no matter the ingest order or cadence.

## 2026-08-16 — Reconcile classifies by chain, not surface kind (1.0.1)

**Question.** A correction over an *open* entry was treated as shipped, and
an item re-resolved after a reopen was never recorded.

**Choice.** Ship-state comes from the supersession chain (effectiveShipped);
open-chained corrections get shipped proposals when the item is done, and a
done item whose entry says `reopened: true` gets a correction clearing the
flag (`re-resolved in tracker`), fields refreshed. Pacing's committed points
window on the chain-origin ts so corrections never re-date commitments.

**Rationale.** The chain is the truth the schema freeze promises; surface
kinds are just the latest edit.

## 2026-08-17 — Tested-user-feedback batch (1.1.0)

**Question.** A hands-on external-perspective run surfaced: the documented
`$WAYBILL verify` idiom silently fails on zsh; the liberal key pattern
minted `story:SHA-256` (118M tokens) from this repo's own commit messages;
ledger health required ~6 hand-assembled commands; `mine` output didn't
reconcile; `totals.metered_tokens` next to `costs.window_tokens` invited a
"0 tokens metered" headline; no export, no pricing onboarding, no
bootstrap windowing.

**Choice.** Skills invoke `node "$WAYBILL" <cmd>` (path in the variable,
never the command string). A key-plausibility gate (core/keys: a stoplist
of technical prefixes — SHA, UTF, ISO, HTTP… — and, when
`tracker.project_keys` is configured, an authoritative prefix allowlist)
filters every extraction site; this changes attribution, so
`rules_version` bumped to "2" and the per-session checkpoints re-meter
everything stale, superseding phantom accounts. New verbs: `status` (one
screen of health), `export` (spend ledger as csv/json, audience-redacted),
`pricing show/set` (all five rates plus a cited version required — no
rates ever ship with the plugin). `mine` prints a reconciling
new/re-metered/gaps/current line; `bootstrap` accepts `--from/--to`;
report totals renamed to `shipped_metered_tokens` (projections are not
frozen). Spend/report skills gained an explicit brevity default.

**Rationale.** Every item was reproduced, not speculated; the fixes keep
the deterministic core untouched and make the honest numbers easier to
reach than the wrong ones.

## 2026-08-17 — D6 reversed: bundled Anthropic pricing ships as the default

**Question.** D6 (1.1.0) shipped with no rates at all — the user had to
`pricing set` all five rates per model, cited from a price list, before any
`cost_usd` appeared. Feedback since then: for the overwhelmingly common
case (first-party Anthropic usage, list price, no negotiated discount),
that onboarding step is pure friction repeated by every install for
numbers publicly listed at platform.claude.com/docs/en/about-claude/pricing.

**Choice.** Ship `references/anthropic-pricing.json` — exact dated model
ids only (never a guessed id), current list rates per million tokens, a
`last_updated`/`source` pair, and a small family-alias table (e.g.
`claude-sonnet-4` → `claude-sonnet-4-6`) for convenience lookups. New
`waybill pricing import [--model <id-or-alias>]...` merges it into
`config.pricing`; `waybill init` calls it automatically, but **only on a
fresh install** — a re-init on an existing ledger never touches pricing, so
a rate changed by hand with `pricing set` survives every future `init`.
`pricing set` remains the override path and always wins for whatever model
it names, import or not.

**Rationale.** The unknown-model policy (`tokens_only`, never guess) and
the required `pricing_version` label are untouched — this only removes the
friction of re-entering rates Anthropic already publishes. Scoping the
auto-import to fresh installs preserves the same non-destructive guarantee
the rest of `init` already gives re-run config.

## 2026-08-21 — Rate lookup made honest: resolution, empty-table import, unpriced surfacing (1.5.0)

**Question.** Users reported "rates not auto-configured, though the docs
say they are." Three real gaps behind one symptom: `priceTokens` looked up
the pricing table by exact model id, so a transcript's dated id
(`claude-opus-4-6-20260120`) missed the bundle's undated key and metered
tokens-only; `init` auto-imported bundled rates **only on a fresh
install**, so a ledger initialized before 1.2.0 stayed rate-less forever
with no flag; and nothing anywhere named the models that had metered
without a resolvable rate — the cost totals were quietly partial.

**Choice.** (1) Rate resolution (`core/pricing-resolve.ts`): exact key,
else the key whose date-normalized form (trailing `-YYYYMMDD` stripped)
matches — undated family key preferred, then the latest dated variant;
deterministic, never across families; no match still means `cost_usd:
null`. (2) `init` imports bundled rates whenever the table is **empty** —
fresh install or upgrader — and never touches a table holding any rate,
so `pricing set` customizations still survive every re-init. (3) `waybill
status` and `pricing show` cross-check the table against the models
actually metered and print each unresolvable model with the exact fix;
`init` lists missing pricing under "Needs action" instead of omitting the
line. (4) A `meter_version` joins the per-session checkpoint, so this (and
any future) metering-logic change re-meters stale sessions once,
automatically — superseding corrections re-price events without `--force`
folklore.

**Rationale.** "Costs appear from day one" is a claim about outcomes, not
about an import having run — it holds only if the ids in real transcripts
resolve, upgraders are included, and any gap is named rather than averaged
away. Date-stamp normalization is the narrowest rule that fixes the id
mismatch without ever guessing a rate across model families.

## 2026-08-21 — CLI-first sync fetches: acli for Jira (1.5.0)

**Question.** The sync skill fetched Jira through the Atlassian MCP
server, whose tool results carry the provider's full issue payload through
model context — reported as noticeably heavy for routine syncs. Atlassian
now ships an official CLI (`acli`, GA since May 2025) with JQL search and
per-item field selection.

**Choice.** The sync skill prefers `acli` when authenticated (the same
pattern as `gh` for GitHub Issues): `workitem search` with
`--fields key` returns only keys for the JQL window; each key is then
fetched with `workitem view --json --fields <exactly what sync needs>`,
REST-shaped with custom fields (points, sprint, epic link) included, and
composed verbatim into a bare array with `jq -s` — a shape the jira
adapter already accepts, so the engine is unchanged and the conformance
kit's verbatim-leaf checks still hold. `acli`'s flattened `search` JSON is
never fed to the adapter (it cannot carry custom fields or status
category). The Atlassian MCP remains the documented fallback, and
`waybill status` reports which path is active with the exact command to
set up the lighter one. Adapters keep accepting both transports — payload
shape, not transport, is the contract.

**Rationale.** A CLI call requests scoped fields and writes to a file;
tool results flow through context. Same facts, a fraction of the tokens —
and per-item `view` keeps fidelity (statusCategory, resolutiondate,
custom fields) that acli's search output drops. Transport preference
belongs in the skill layer; the engine's contract stays payload-shaped.
The same rule now covers the git-host half: `gh pr list --json` is the
preferred PR fetch, and the github adapter accepts gh's camelCase rows
(repo derived from the PR's own URL) alongside both REST shapes — the
`github-issues` adapter had already set that both-shapes precedent.

## 2026-08-21 — Standup is a query projection; the skill renders (1.5.0)

**Question.** "What did I do yesterday" standup digests: engine
subcommand with a rendered receipt (like `bootstrap`), or query
projection with a rendering skill (like `spend`/`report`)?

**Choice.** `waybill query standup` — a pure projection over the four
streams (shipped windowed on ship time, metered work-in-progress by
account, newly opened entries, session/token totals, attention items),
plus a new `standup` skill that renders the bullets. Window resolution
(`--date yesterday|today|<day>`, `--days <n>`, local-calendar) lives at
the CLI edge with `--now` injectable; the projection itself stays
clock-free. The skill name `standup` stays legal because the engine half
is a projection, not a subcommand (D19 reserves subcommand names).

**Rationale.** The export-pack boundary: prose is Claude's job, numbers
are the engine's — `bootstrap`'s engine-rendered receipt is the recorded
exception, not the pattern. A projection also gets the query envelope's
`--audience` redaction for free, which a digest pasted into a team
channel actually needs.

## 2026-08-22 — Salvage: clusters are engine work, titles are proposals, receipts are the only source (1.6.0)

**Question.** Untracked AI-assisted work (PRs shipped without tickets,
unattributed sessions) piles up as surfaced-but-unlabeled spend. How does
it become receipts without breaking "deterministic before intelligent" or
the ungameable tier system?

**Choice.** Three-role split. The ENGINE clusters deterministically
(`query untracked`): unlogged story keys by key, unattributed sessions by
the session's branch/repo identity, adhoc labels by label — each cluster
carrying its receipts (sessions, branches, repo, window, tokens). CLAUDE
proposes a title per cluster from those receipts only — branch names,
commit subjects, keys; never inference about what the work "probably
was". The USER confirms one cluster at a time; application flows through
the existing write paths (pins for re-attribution, `append` for
reconstructed entries marked "reconstructed from receipts (salvage)").
Reconstructed entries carry `estimate_without_claude_hours: null` and no
escrow — pre-registration is never backfilled.

**Rationale.** The inbox pattern, promoted from turns to work items: the
deterministic core stays pure, the model only labels, the human only
taps. Facts tier stays facts; the one thing salvage must never do is
manufacture tier-3 evidence, and the schema makes that structural.

## 2026-08-22 — Conventions are printed, never installed (1.6.0)

**Question.** Attribution quality is decided at commit time, so waybill
should shape commits/branches/PRs. Does the engine write into the user's
repo (CLAUDE.md, git hooks)?

**Choice.** `waybill conventions` PRINTS the CLAUDE.md block and the
`commit-msg` hook (derived from the configured key pattern); installing
either is the user's — or Claude's, with the user's yes — explicit action
in their repo. The engine never writes outside `$WAYBILL_HOME`.

**Rationale.** The engine's no-side-effects boundary is worth more than
the convenience; a printed artifact is auditable before it's installed,
and skills already have file-editing hands when the user wants it done
for them.

## 2026-08-22 — The dashboard refines the export-pack boundary: templating a rollup is not rendering a document (1.6.0)

**Question.** A zero-token dashboard needs the engine to produce HTML —
which the export-pack boundary ("presentation stays out of the engine")
exists to forbid.

**Choice.** `waybill dashboard` injects a JSON snapshot into a static
template shipped as a plugin reference file and writes
`rollups/dashboard.html`. The boundary holds, refined: presentation
LOGIC lives in the template (a checked-in artifact, reviewable like any
file), the engine performs data injection only (JSON.stringify + one
placeholder replace, `<` escaped so ledger strings cannot break out),
and the output is a derived, deletable rollup — never a receipt, never
verified, never the numbers' source of truth. The miner refreshes it
best-effort only when it already exists. The page itself makes zero
network requests (system fonts only) — the no-network promise applies to
what the engine emits, too.

**Rationale.** The boundary's purpose is keeping presentation code out
of the deterministic, conservation-checked path — not banning the
coverage-report pattern every good local tool uses. Reading your own
numbers should cost nothing; routine "where did my tokens go" glances
were the plugin's main steady-state token cost, and now they're free.

## 2026-08-22 — Overhead is a metered fact, not a claim (1.6.0)

**Question.** "Waybill is lightweight after the initial sync" was an
assertion. The product's own rule is that claims need receipts.

**Choice.** The meter tags turns whose tool commands invoke the waybill
CLI (deterministic substring match on `bin/waybill` / `waybill.mjs`,
exactly like evidence extraction) with `overhead: true` on their usage
events — additive, present only when true so pre-1.6 events keep their
content addresses. `spendData` rolls it up; the spend skill and the
dashboard print it. METER_LOGIC_VERSION bumped to 3 so existing ledgers
re-tag once, automatically. Known edge, accepted and documented: for
someone developing waybill itself, dev commands count as overhead — the
label means "ran the waybill CLI", nothing subtler.

**Rationale.** An accountant that bills for its own hours, itemized on
its own invoice, is the most on-brand feature the product can ship — and
the honest way to keep the lightweight promise checkable forever.

## 2026-08-22 — Verification packs are verbatim, green-only, and never redacted (1.7.0)

**Question.** `export --pack` arms the *recipient* of a pitch to re-run
the integrity checks. What may the pack contain — and can it be redacted
like a report?

**Choice.** Three rules. (1) **Verbatim lines only**: event ids recompute
from content, so the pack copies stream lines byte-for-byte; any
re-serialization — including pseudonymization — would read as tampering.
Packs are therefore never redacted; the external-audience artifact
remains the redacted report, and the pack's README says it travels at
internal sensitivity. (2) **Session-complete usage**: conservation is
per-session (Σ usage = receipt totals), so the window selects *which*
sessions travel (any in-window usage) and never slices one — a session
goes whole, receipts and its exceptions along, or not at all. The ledger
travels in full (chains and escrow must stay unbroken; it is small);
`identity.json` never travels. (3) **Green-only**: the engine refuses to
build a pack from a home whose `verify` has findings — a pack is a claim
of integrity, and shipping a red one would be manufacturing false
evidence with the product's own tooling.

**Rationale.** The whole feature is one sentence: "you don't have to
trust me — check." Every rule above exists so that sentence stays true
against a hostile reading: nothing re-encoded, nothing partially
included that a check depends on, nothing packed that was already known
broken.

## 2026-08-22 — Calibration reports the counterfactual gap honestly (1.7.0)

**Question.** "Estimate calibration" usually means predicted-vs-actual of
the same quantity. Waybill's pre-registered estimate is *hours without
Claude* while `actual_hours` is hours *with* it — so what does
calibration honestly mean here?

**Choice.** `query report`'s calibration section never pretends the two
are the same quantity. It reports coverage (how much shipped work was
pre-registered at all, and how much recorded actuals) and the actual's
position against the range: **below** the low bound — the claimed saving
held in full; **within** — partial; **above** the high bound — the work
took longer with Claude than the without-Claude estimate, i.e. negative
savings, named per item and never softened. Judgment-tier estimates
(`pre_registered: false`) are excluded entirely — calibrating a
recollection would launder tier-4 into tier-3.

**Rationale.** The above-range bucket is the section's credibility: a
calibration view structurally incapable of showing a loss would be
marketing, and one visible loss is what makes every reported win
believable.

## 2026-08-22 — Multi-machine is a git property, not a sync feature (1.7.0)

**Question.** One ledger across several machines — build a sync
mechanism, or document a workflow?

**Choice.** No sync code in the engine. The data model already merges:
append-only shards, deterministic ids, order-independent reads — so
`init` marks `streams/**/*.jsonl merge=union` and the workflow is an
ordinary private git remote (docs/multi-machine.md). Machine-local state
(`meter_state.json`, `pending-sessions/`, `rollups/`) stays gitignored;
each machine meters its own sessions, so usage never collides. `status`
gains a remote line — ahead/behind computed from **local refs only**,
labeled "as of last fetch": the engine's no-network promise is absolute,
so it reports staleness instead of hiding it. Known edge, documented
rather than papered over: the same event appended on two machines before
a pull union-merges into byte-identical duplicate lines, which `verify`
flags and a documented dedupe fixes — the honest failure mode, visible
by construction.

**Rationale.** A sync feature would be code competing with git at git's
own job, a new failure surface in the trust path, and a standing
temptation to add a server. The append-only design was chosen for
auditability; getting multi-machine for free is the design paying rent.

## 2026-08-22 — Many readers are renderings, and disclosure belongs to the IC (1.8.0)

**Question.** v1.8 promises six new audiences — invoices, expense
receipts, AI-disclosure registers, grant reports, career ledgers,
incident packs. Are these engine features, and who owns the disclosure
register?

**Choice.** Renderings, almost entirely. The engine's whole cost is
three additive fields on report shipped rows — `work_type`, `sessions`
(a count, so it survives every redaction level), `metered_cost_usd` —
and everything else is skills and presets over queries that already
existed: `invoice` and `disclose` as new skills (their readers speak
different vocabularies than "report" — a client paying for hours, a
policy asking about AI use), `grant-report`/`incident` as report
presets, and the career ledger as the documented external full-history
export. Two honesty lines drawn in the skills, structurally: the invoice
never presents counterfactual hours (`estimate_without_claude_hours`,
`time_saved_hours`) as billable time — only recorded `actual_hours` —
and the disclosure register never blends the recorded `claude_role` with
metered token volume into an invented "AI wrote N%". The register is the
individual's to produce, per item, on their initiative: no standing
feeds, no colleague aggregation, methodology §6 unchanged.

**Rationale.** The completion thesis says the performance review is one
reader of the receipts, not the product. Proving it means new readers
must cost near-zero engine surface — if a new audience needed new
metering, the receipt schema would be wrong. Three additive row fields
and zero new commands is the thesis holding.

## 2026-08-22 — 2.0 means "scope complete", and recommendations close with dispositions (2.0.0)

**Question.** What does the 2.0 major mean for a project whose schema
froze at 1.0 — and what does "the remaining architecture-review
recommendations closed" require when some recommendations aren't worth
their risk?

**Choice.** 2.0 is a completion marker, not a compatibility event: the
event schema is untouched (v2, frozen), every 2.0 change is additive,
and a 1.x ledger opens under 2.0 with no migration. The version says
"the committed scope is built" — coverage matrix (Azure DevOps,
Bitbucket, Windows, OTel), review closeout, self-verifying gate.
"Closed" for a recommendation means *a recorded disposition*, not
unconditional implementation: six closed in code, and the shared flag
parser closed by partial adoption with the rationale written down —
write-path commands keep their tested bespoke parsers because rewriting
tested parsing for uniformity trades regression risk for zero user
value, and the property the recommendation actually wanted (strict flag
handling) is enforced by regression tests on every command regardless.
An engineering-judgment "no, because" recorded in the architecture
document is a close; a silent skip is not.

**Rationale.** The product's own rule — claims need receipts — applies
to its roadmap: "complete" had to be checkable (the release gate now
mechanically verifies the release's claims about itself), and "closed"
had to be auditable (every recommendation's disposition is one lookup
away). The two adapters follow the same honesty pattern as Linear and
GitLab before them: conformance-tested on realistic fixtures, own-data
verified, and the adapters table says plainly that live end-to-end runs
are still welcome contributions.

## 2026-08-22 — Releasing is declarative: a manifest on main, reconciled server-side (post-2.0)

**Question.** The environment that builds releases can push branches but
not tags (proxy policy), and cannot dispatch workflows. How do tags and
GitHub releases get published without a human running git commands?

**Choice.** `.github/releases.txt` — one `<tag> <sha>` line per
release — and a reconciler workflow that runs on every change to it (or
to itself) on main. Per entry it re-verifies the release's claims at the
target sha (tag matches package.json; a CHANGELOG section exists — it
becomes the release body), creates the tag and release server-side via
the Actions token, never moves a published tag, pins the manifest's
highest semver as latest, and falls back to staging a draft when a
protected-tag rule refuses creation. Releasing = append a line, push
main. A non-converged manifest keeps the run red on purpose — the
reconciler's job is convergence, and a green run over unpublished
entries would be a false receipt.

**Rationale.** Same shape as everything else in this project: the
desired state written down and checkable, the mechanism idempotent, the
failure mode loud. It also survives the next constrained environment —
any contributor who can land a commit on main can cut a release that
still cannot dodge the version/CHANGELOG checks. Observed limit,
recorded honestly: name-scoped tag rules bind the Actions token too
(v1.x refused, v2.0.0 published), so backfilled tags under a protected
pattern need the rule relaxed or an owner-side publish.
