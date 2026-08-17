# Validation — FINALPASS gate (v1.0.1; earlier release evidence retained below)

Evidence for milestones M0 "Believable", M1 "Metered", M2 "Answerable",
and M3 "Trustworthy at scale". Every claim below is reproducible from a
clean checkout with
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
