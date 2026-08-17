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
