# Validation — FINALPASS gate (v2.0.0; earlier release evidence retained below)

## Gate results (2026-08-22, Linux/Node 22 dev container; CI mirrors on Ubuntu/Node 24)

| Check | Result |
|---|---|
| `tsc --noEmit` (strict) | clean |
| `node --test` full suite | **211 / 211 pass** (2.1 batch so far: subagent-transcript metering with exact-sum fixtures, append clock check + verify warnings, demo static-render pins, init-time metering; v2.0 batch: Azure DevOps + Bitbucket adapters with conformance and own-data, shared flag parser, status --fast, standup↔spend agreement golden) |
| Reproducible build + zero bin diff | pass |
| `scripts/validate-plugin.sh` | pass |
| `scripts/release-gate.sh` (`npm run gate` — the release's claims about itself, checked mechanically) | pass |
| Hook suite | 7 / 7 pass |

## 2.0.0 DoD — "Delivered"

- The Azure DevOps and Bitbucket adapters pass the conformance kit and
  the own-data scoping check on realistic fixtures (foreign assignee /
  foreign author present and dropped; unassigned items kept; identity
  only narrows). Field semantics fixture-asserted: numeric keys,
  StoryPoints *and* Scrum Effort, iteration-path sprints, ClosedDate
  done-ness; Bitbucket merged-only with the documented `updated_on`
  merge-time stand-in and `closes` omitted, never faked. Honest limit
  recorded in the adapters table: live end-to-end runs still welcome.
- Every 1.5.0 architecture-review recommendation carries a recorded
  disposition in docs/architecture.md — six done in code, the flag
  parser closed by partial adoption with written rationale, the pricing
  vocabulary given an owning definition.
- The release gate is self-verifying and runs in CI: a stale VALIDATION
  test count, a missing CHANGELOG section, a broken doc link, or a
  skill without a trigger eval each fail the gate (verified locally by
  running it against this release).
- `status --fast` skips only verify and says "skipped", never "ok"
  (CLI-tested); the standup↔spend token-total agreement golden pins the
  two projections together over an explicit window.
- Windows and OTel stories are documented with their honest limits
  (docs/windows.md, docs/otel.md): reasoned port + retention caveat;
  fallback-only OTel semantics restated.

## 1.8.0 DoD — "Many readers"

Gate at release (same environment): tsc clean; **187 / 187** tests;
reproducible build, zero bin diff; validator (incl. `invoice`/`disclose`
naming) pass; hook suite 7 / 7.

- The engine cost of six new audiences is exactly three additive fields
  on report shipped rows, each fixture-tested: `work_type` travels from
  the entry; `sessions` counts distinct metered sessions (a repeat
  session must not inflate it); `metered_cost_usd` is the story's
  windowed spend cost and is null — never $0 — when unpriced.
- Redaction behavior of the new fields is asserted: session *counts*
  survive `internal` and `external` (numbers are never identifiers)
  while titles/PRs drop and keys pseudonymize exactly as before.
- The honesty lines are structural in the skills: `invoice` bills only
  recorded `actual_hours` (counterfactual estimates and time-saved
  ranges are never presented as billable time; pricing stays the
  user's); `disclose` keeps the recorded role and the metered volume
  separate (no invented "AI wrote N%"), includes role-`none` rows, and
  is per-item, IC-initiated — no standing feeds, no colleague data.
- Trigger evals added for both new skills (`evals/trigger-invoice`,
  `evals/trigger-disclose`); the validator's naming and reserved-word
  checks pass for `invoice` and `disclose`.

## 1.7.0 DoD — "Bill of lading"

Gate at release (same environment): tsc clean; **184 / 184** tests
(verification pack end-to-end, cache savings, model mix, calibration,
remote status against a real git upstream, own-data conformance);
reproducible build, zero bin diff; validator (incl. `retro` naming)
pass; hook suite 7 / 7; built-binary smoke — `export --pack` from the
real bundle → recipient `verify` green.

- The verification pack is exercised through the real recipient flow in
  the test suite AND against the built binary: pack a fixture home,
  then run the **copied** engine's `verify --home <pack>` and require
  green. Session-completeness is asserted (an out-of-window session's
  events do not travel; an in-window session travels whole with its
  receipt and exceptions), pack.json's SHA-256 file hashes recompute,
  and the refusals are tested: a tampered ledger (red verify), a
  non-empty output directory, and `--audience` (packs are verbatim by
  design — DECISIONS 2026-08-22).
- Calibration counts pre-registration coverage and actual-vs-range
  positions with the above-range case (negative savings) surfaced,
  fixture-tested; judgment-tier estimates are excluded structurally.
- Model mix buckets a story under a model only at >50% dominance and
  accounts the story's FULL spend; the even-split story lands in
  `mixed` (fixture-tested).
- Cache savings are derived (current rate table), labeled, and honest
  about coverage: an unpriced model contributes volume but no dollars,
  `covered_pct` says so, and an empty rate table yields null — never $0.
- `status`'s remote line is tested against a real local upstream
  (bare repo + push + one extra commit → `1 ahead, 0 behind`), computed
  from local refs only.
- The conformance kit's own-data check passes for the bundled Jira and
  GitHub adapters on the sync skill's documented fetch shapes, fails an
  identity-blind adapter, and refuses a vacuous fixture (foreign record
  never present).

---

## 1.6.0 DoD — "Salvage"

Gate at release (same environment): tsc clean; **175 / 175** tests;
reproducible build, zero bin diff; validator (incl. `salvage` naming,
reserved words `conventions`/`dashboard`) pass; hook suite 7 / 7;
dashboard headless render (Chromium: tiles, empty states, meta line) pass.

- Salvage clustering exercised end-to-end (`query untracked` through the
  CLI envelope) with tracked work excluded and receipts attached; the
  skill's never-backfill rule is structural (reconstructed entries carry
  no estimate and no escrow).
- The conventions `commit-msg` hook is executed in a real git repo by the
  test suite (prefixes a keyless message on a keyed branch, first commit
  included; leaves keyed messages untouched).
- The dashboard's injection is breakout-safe (`<` escaped; regression
  test with a hostile ledger title) and renders headless with correct
  empty states.
- Overhead tagging is conservation-neutral (full suite green incl.
  meter goldens) and additive (absent on non-overhead events, so
  pre-1.6 content addresses are unchanged); METER_LOGIC_VERSION 3
  re-tags existing ledgers exactly once.

## Gate results (2026-08-22, Linux/Node 22 dev container; CI mirrors on Ubuntu/Node 24)

| Check | Result |
|---|---|
| `tsc --noEmit` (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) | clean |
| `node --test` unit + golden + determinism + conservation + acceptance suites | **168 / 168 pass** |
| Reproducible build (`npm run build` then `git diff --exit-code bin/`) | zero diff |
| `scripts/validate-plugin.sh` (manifests, version agreement, skills, D19 naming, schema examples, dependency-free engine) | pass |
| `tests/test-capture-session.sh` (hook never blocks/fails) | 7 / 7 pass |
| Built-binary smoke: fresh init → `query standup` → `status`; upgrader re-init imports empty rate table | pass |

## 1.5.0 DoD — the tested-feedback batch

- Adversarial architecture review, recorded in
  [docs/architecture.md](architecture.md): 15 agents (6 subsystem
  reviewers + a release-diff reviewer, adversarial verification per scope,
  synthesis) over the full engine and plugin — 82 raw findings, 51
  confirmed; all 8 majors and the substantive minors fixed in-release,
  one regression test per fix (`tests/unit/review-1-5.test.ts`,
  `tests/unit/feedback-1-5.test.ts`).
- The pricing claim is enforced, not asserted: bundled-rate resolution
  covers every realistic transcript id shape
  (`tests/unit/pricing-resolution.test.ts`), upgraders auto-import on
  re-init, and `status`/`pricing show` name every unpriced metered model
  with its exact fix.
- The acli and gh CLI sync paths are conformance-tested against composed
  fixtures (`tests/unit/jira-acli.test.ts`, `tests/unit/gh-pr-list.test.ts`);
  the fixture provenance and its runtime shape-check are documented in
  the test headers and the sync skill.
- Standup verified end-to-end through the real CLI (`query standup`
  envelope, `--date`/`--days`/`--now` window words, audience redaction
  including the session summary), with a trigger eval
  (`evals/trigger-standup/`).

---

Earlier release evidence follows: milestones M0 "Believable", M1
"Metered", M2 "Answerable", and M3 "Trustworthy at scale". Every claim
below is reproducible from a clean checkout with
`npm ci && npm run check && bash scripts/validate-plugin.sh &&
shellcheck scripts/*.sh tests/*.sh && bash tests/test-capture-session.sh`.

## Gate results (2026-08-16, macOS; CI mirrors on Ubuntu/Node 24)

| Check | Result |
|---|---|
| `tsc --noEmit` (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) | clean |
| `node --test` unit + golden + determinism + conservation + acceptance suites | **101 / 101 pass** |
| Reproducible build (`npm run build` then `git diff --exit-code bin/`) | zero diff |
| `scripts/validate-plugin.sh` (manifests, skills, D19 naming, schema examples, dependency-free engine) | pass |
| `claude plugin validate` (official CLI) | pass, no warnings |
| `shellcheck scripts/*.sh tests/*.sh` | clean |
| `tests/test-capture-session.sh` (hook never blocks/fails) | 7 / 7 pass |
| GitHub Actions (validate, shellcheck, hook, engine jobs) | green on `main` |

## M2 DoD — "Answerable"

- Product-spec §8 UX flows 1–4 pass as scripted acceptance tests
  (`tests/unit/acceptance.test.ts`): zero-touch week with confidence bands
  and a working inbox, story cost in one interaction, the once-per-crossing
  pacing nudge, and a pitch whose data carries the spend ledger,
  escrow-sealed receipts, and utilization.
- One-tap inbox resolution (`waybill resolve`) re-attributes turns via
  superseding events and provably survives forced re-meters
  (`tests/unit/polish.test.ts`).
- The pitch renders from real data: `query report` over this machine's
  actual metered history returns the full spend-ledger section (verified
  during the live e2e).
- Adversarial review, two passes: 15 agents over the 0.3 core (10 confirmed
  findings) and 16 agents over the 0.4/1.0 delta (12 confirmed) — every
  confirmed finding fixed with a regression test.

## M3 DoD — "Trustworthy at scale"

- Waste diagnostics and rework/reopen tracking fixture-tested, including
  the D11 guarantee that no command text or file path reaches the ledger
  (string-absence asserted over serialized events).
- Two additional adapter configs beyond the bundled defaults — Linear and
  GitLab — pass the conformance kit with fixtures. Honest limit: live
  end-to-end runs against real Linear/GitLab accounts have not been
  performed; the adapters.md table says exactly that.
- Trigger evals authored for every skill plus an overtrigger negative;
  the CI job is gated behind the RUN_TRIGGER_EVALS repository variable (push events only). Honest limit: pass-rate
  thresholds have not been measured yet — this machine's CLI OAuth session
  is expired and `plugin eval` is early-access. First authenticated run:
  `claude plugin eval waybill@waybill --threshold 0.8`.
- Schema v2 frozen with a written migration policy (docs/migration.md);
  docs-completeness sweep done (tutorial, how-to, reference, explanation
  all present and cross-linked).

## Invariants, and the tests that enforce them

- **Determinism (invariant 8).** Same inputs ⇒ byte-identical streams:
  `tests/unit/determinism.test.ts` (double-run comparison + committed
  golden shards) and `tests/unit/meter-golden.test.ts` (committed meter
  outputs for every fixture transcript; regenerate only via
  `tests/tools/regen-*.ts`). Event ids are pure functions of content
  (deterministic ULIDs), so replays are provably identical.
- **Conservation (invariant 9).** Σ usage events = source totals per
  session, enforced three ways: the meter's self-check (emits
  `meter_discrepancy` on mismatch), `waybill verify`'s independent
  recount against durable session receipts, and fixture tests including a
  deliberately-broken stream (`tests/unit/verify.test.ts`).
- **Append-only (invariant 7).** No code path edits a stream line;
  corrections supersede. `verify` rejects dangling `supersedes`, duplicate
  ids, and content whose id does not recompute (tamper evidence).
- **No LLM / no network in the metering path (invariant 6).** The engine
  is a single stdlib-only bundle (`bin/waybill.mjs`); the validator fails
  if it references `node_modules`; the only child processes are local `git` invocations (init and sync additionally use local `git`/`gh` — never the metering path).
- **Escrow (D13).** Pre-registered estimates are SHA-256-sealed at the
  write path, refused when backdated, verified by `waybill verify`, and
  carried forward through sync (`tests/unit/m0.test.ts`,
  `tests/unit/adapters.test.ts`).
- **Resolver ladder (D14).** The T2 harness
  (`tests/unit/resolver.test.ts`) covers all six rules, every
  fall-through, range pins, strict-forward evidence (a turn belongs to
  the account active at its start), and ambiguity routing to the
  attribution inbox with dedupe.
- **Adapters (D2).** The conformance kit asserts determinism, ordering,
  key legality, and no fabrication; bundled Jira/GitHub/git-local
  adapters pass it, and a deliberately fabricating adapter fails it.
- **Redaction (D12).** External output provably contains no tracker keys,
  titles, repos, or URLs (asserted by string absence over the serialized
  payload) while keeping every number; pseudonym maps are deterministic.

## M0 DoD — measured on this machine

- `waybill init` + `waybill bootstrap` on a real repo, zero auth, fresh
  `$WAYBILL_HOME`: **0.52 s** wall clock to a rendered receipt
  (target: < 60 s).
- Retention check surfaced (`cleanupPeriodDays`), with the 0-days warning
  path unit-tested.
- Hook path: capture script exits 0 on valid, empty, and unwritable
  inputs; miner spawns detached and re-mining is a no-op.

## M1 DoD — measured on this machine

- Retroactive run over the machine's real Claude Code history:
  **14 sessions metered in ~1 s**, 1.71 B tokens accounted, 13
  attribution accounts, `waybill verify` fully green afterwards
  (conservation reconciles), attribution inbox empty.
- Fixture-transcript CI suite covers transcript versions 2.1.x and a
  legacy 1.x shape (no promptId, no gitBranch, unsplit cache writes),
  message-id streaming duplicates, sidechain rollup to the parent turn,
  branch-switch segmentation, grown-transcript supersession, and pricing
  (exact e4 fixed-point; unknown model ⇒ `cost_usd: null`).

## Known limits (0.3.0, honest)

- OpenTelemetry secondary source, the `spend` skill, budgets/pacing
  surfacing, and one-tap inbox resolution UX ship in 0.4 (M2) — the
  engine primitives (`query spend|story|inbox`, `resolution` events)
  already exist.
- Rule-3 evidence reads git/PR operations in tool calls; tracker-MCP
  operations inside a session are not yet evidence (product-spec open
  question 1).
- The retro run attributes ~54 % of historical tokens with zero setup
  (branch + evidence rules); the G2 target (≥ 85 % at conf ≥ 0.6) is a
  two-week steady-state target that requires open entries/pins, not a
  cold-history property.
