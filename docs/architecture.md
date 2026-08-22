# Architecture & system design

The recorded architecture review of the Waybill engine and plugin, run for
v1.5.0 (2026-08-22). It has two jobs: explain how the system composes —
the reference the other docs point at — and record what a structured
adversarial review found, what was fixed, and what stands open. Method and
results are at the end; every fixed finding has a regression test
(`tests/unit/review-1-5.test.ts`, `tests/unit/feedback-1-5.test.ts`).

## The bet

Every number a skill utters must be reproducible, byte for byte, from an
append-only ledger by a deterministic, dependency-free engine. The system
divides into a fact-producing spine (hooks → queue → miner → meter →
streams), a fact-deriving query surface (projections → redaction), a
conversational skin (skills) that is forbidden from doing arithmetic, and
a sync path that imports external receipts under a no-fabrication
contract.

## The metering spine

When a Claude Code session ends, the SessionEnd hook (`hooks/hooks.json` →
`scripts/capture-session.sh`) saves the raw hook JSON into
`$WAYBILL_HOME/pending-sessions`, enriches it with repo, branch, and
capture time, and spawns a detached dependency-free miner
(`waybill mine --queue`); the hook never blocks and always exits 0. The
miner takes an exclusive-create pidfile lock (`src/meter/lock.ts`) — the
single-writer guarantee for every stream-writing path — and walks the
queue.

For each capture, `src/meter/run.ts:meterFile` consults a per-session
checkpoint in `meter_state.json` — file bytes, the rules and meter-logic
versions, a digest of the whole pricing table, and a fingerprint of the
attribution inputs — and skips unchanged transcripts. Otherwise
`src/meter/transcript.ts` parses the transcript into turns (deduplicating
streamed assistant lines by message id, folding sidechains, splitting
cache-write tiers, extracting commit/PR evidence, tallying waste), and
`src/meter/meter.ts` derives events: per-(turn, model) usage events
attributed by a six-rule ladder (`src/attribution/resolver.ts` — turn
override, pin, active entry, transcript evidence, session branch, repo
default, none — with ambiguity fall-through into the inbox), priced by
`priceTokens` through the date-stamp-tolerant `resolveRate` (exact key,
else the same normalized family, never across families; no match means
`cost_usd: null` — a rate is never guessed), plus a session receipt and
exception events. Appends land in monthly shards
(`streams/<stream>/YYYY-MM.jsonl`, the shard chosen from the ts prefix),
and the home repo is git-committed. OTLP ingestion is strictly secondary:
it fills only transcript-less sessions and is retired by superseding
corrections the moment a transcript appears.

## The trust model

`finalizeEvent` derives every id as a deterministic ULID — 48 bits of time
from the event's own ts, 80 entropy bits of SHA-256 over the stream name
and the canonical JSON of the body (`src/core/ulid.ts`, `canonical.ts`).
Content addressing makes the pipeline safe to replay: re-metering an
unchanged transcript recomputes identical ids and is a no-op; changed
facts arrive as superseding events, never edits; readers collapse to the
authoritative view by dropping anything named in a `supersedes` link
(`src/core/streams.ts`).

Conservation — the sum of authoritative usage tokens per session equals
its receipt — is self-checked at meter time and recomputed by
`waybill verify`, which replays every promise the engine makes: id
determinism, shard placement, uniqueness, supersedes existence (including
forked chains), escrow seals, pre-registration ordering, and per-line
stream integrity. Estimates earn the top evidence tier through escrow:
`waybill append` seals a pre-registered range and `logged_at` under a
SHA-256 whose fixed payload order makes field-shift forgery structurally
impossible (`src/core/escrow.ts`), and verify recomputes each seal.

Output leaves `query` only through audience redaction
(`src/report/redaction.ts`): internal strips machine-local detail (session
ids, transcript paths, cwd); external additionally drops titles, PR URLs,
and branch names and deterministically pseudonymizes tracker keys, epics,
and repos. Numbers always survive — unattributed percentages, pricing
coverage, and confidence labels cannot be dropped at any detail level.

## Projections and skills

`spend`, `report`, `forecast`, `pace`, and `standup` are pure folds over
`readEvents` → `authoritative()` with inclusive windows compared as
instants; the clock enters only at CLI edges, injectable via `--now`,
including standup's local-calendar day math. `spendData`'s
`pricing_coverage` and standup's unpriced-model roll-up make partial
dollar totals explicit rather than silently omissive. Skills render the
`{audience, detail, data}` envelope verbatim; all writes flow through
`waybill append`, which validates kinds against the stream registry, seals
escrow, and no-ops on duplicate content ids.

## The sync path

The sync skill drives a CLI-first fetch — acli for Jira, gh for PRs and
GitHub Issues, MCP fallbacks, or the zero-auth local git log — into temp
files. Pure adapters (`src/adapters/*`) normalize the payloads into sorted
WorkItems and MergedChanges under a contract policed by the conformance
kit: keys, points, dates, and URLs must be verbatim payload leaves (or
re-derivable from one), closing refs require a real closing keyword in the
payload, cancelled work never becomes value — and, in the adapters
themselves, records naming another author or assignee are dropped as
defense-in-depth whenever the matching `identity.json` field is set.
`reconcile()` diffs the result against the ledger's supersession chains
into a SyncPlan (shipped, corrections, orphans, unmatched); after one
human confirmation, `--apply` finalizes deterministic ids, skips ids
already present (within the batch too), appends, updates the baseline, and
commits — re-applying the same plan is a no-op.

## Where each invariant is enforced

| Invariant | Enforced at |
|---|---|
| Determinism | `finalizeEvent`/`canonicalJson`; verify recomputes every id |
| Append-only | streams + the ledger home's git history |
| Single writer | the miner pidfile lock (miner, meter, resolve) |
| Conservation | meter self-check; `waybill verify` |
| Supersession | `authoritative()`; chain-aware `effectiveShipped`; verify's forked-chain check |
| Escrow / tiers | sealed at `append`; recomputed by verify; ordering checked both places |
| Redaction | the `cmd-query` envelope, before any renderer sees data |
| Own data only | upstream query scoping + adapter identity drops |
| Schema freeze | additive config merges; checkpoint migration re-meters legacy sessions exactly once |

## The review record (v1.5.0)

**Method.** Seven parallel reviewers — six subsystem scopes (core,
metering, query surface, sync, CLI/packaging, skills/docs/evals) plus a
fresh-eyes reviewer of the release diff itself — each reading their scope
completely and reporting evidence-backed findings; one adversarial
verifier per scope instructed to refute each finding against the tree;
one synthesizer. Fifteen agents in total. Findings landing mid-review
were fixed in place, so several verifiers re-confirmed fixes rather than
findings ("cannot occur in the code on disk").

**Results.** 82 raw findings; 51 confirmed after adversarial verification
and deduplication — 8 major, the rest minor/polish. All 8 majors and the
substantive minors were fixed inside the 1.5.0 release, each with a
regression test:

- the pricing table's content (not its version string) keys meter
  checkpoints, so `pricing set` re-prices as promised;
- duplicate transcript files for one sessionId no longer take turns
  superseding each other's receipts;
- a torn `meter_state.json` or stream line degrades to one clean re-meter
  or a verify finding, never a silent permanent stall;
- standup's Started section is supersession-chain-aware, its windows
  compare instants, and its Monday guidance matches the engine;
- conflicting whole-session pins supersede instead of accumulating;
- the documented sync fetches carry the identity fields the adapters'
  own-data checks need, and GitLab/Linear gained the same checks;
- rate and checkpoint lookups use own-property access (a transcript
  claiming model `"constructor"` is data, not a crash);
- plus the CLI-edge batch: strict flags, ISO-shaped window bounds, real
  calendar dates, a bounded bootstrap receipt.

**Cross-subsystem themes** (the shapes behind the findings — mostly
retired in 1.5.0, kept here because they are the shapes to watch):

1. *Date.parse as validator, strings as semantics.* Permissive validation
   plus lexicographic comparison produced one failure class with eight
   faces. 1.5.0 tightened every edge; the standing recommendation is one
   strict timestamp module.
2. *Own-data enforced in adapters, disarmed by procedure.* The documented
   fetch commands omitted the identity fields the checks read. Fixed;
   the loop-closing conformance check remains open work.
3. *Caches keyed by labels while the ledger is keyed by content.* The
   checkpoint pricing digest fixes the live case; the principle stands.
4. *The ledger is crash-safe; auxiliary state wasn't.* Atomic state
   writes, tolerant reads, and runtime files out of the synced history.
5. *Parallel implementations of settled semantics.* Standup re-implemented
   windowing and chain logic beside `queries.ts` and diverged exactly
   there — where this release's majors lived.

**Standing recommendations** (open, in priority order):

1. A single strict-ISO timestamp module (validate, canonical precision,
   one comparison helper, half-open day windows) used at every edge.
2. A conformance-kit identity-scoping check plus one test that runs the
   exact fetch shapes the sync skill documents through the adapters.
3. A shared strict flag parser for all `cmd-*` entry points.
4. Refactor standup onto the shared projection primitives, with a golden
   test asserting standup and spend agree over the same window.
5. Post-rename verification in the miner-lock takeover (a live lock can
   theoretically be reaped during a takeover race).
6. A cheap structural mode for `status` (it currently re-hashes the full
   ledger via verify on every run).
7. A self-verifying release gate: regenerate test counts and VALIDATION
   entries per release, check doc links resolve, lint eval criteria
   against current skill rules.
8. One owner for the pricing-honesty vocabulary — *unpriced* (no
   resolvable rate), *repriceable* (rate exists, transcripts survive),
   *unidentified* (no model id) — already consistent in 1.5.0, worth a
   named definition here so it cannot drift.

The hash-and-supersede core held under review: verify recomputes ids end
to end, apply and re-meter idempotence are tested through the real CLI,
the escrow design resists structural forgery, and `resolveRate`'s family
discipline is exactly as claimed. None of the findings corrupted the
ledger; nearly all mis-told the user about it — and for a tool whose
identity is "every claim needs a receipt," the telling is the product.
