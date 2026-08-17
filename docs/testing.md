# Test plan

How Waybill is tested, what each layer proves, how to run it, and what is
deliberately manual. The philosophy mirrors the product: every claim needs
a receipt, so every invariant has a named test that enforces it, and the
release gate is a checklist anyone can re-run from a clean checkout.

## 1. Scope and priorities

The engine's promises, in the order they'd hurt if broken:

| # | Invariant | Broken looks like |
|---|---|---|
| 1 | **Conservation** — Σ usage events = source totals, per session | silently wrong money/token numbers |
| 2 | **Determinism** — same inputs ⇒ byte-identical streams | unreproducible receipts, id churn |
| 3 | **Append-only + supersession** — history never rewritten | audit trail loses meaning |
| 4 | **Attribution correctness** — resolver ladder, no phantom stories | tokens billed to the wrong (or fake) work |
| 5 | **Privacy (D11/D12)** — counts/ids only; redaction holds | transcript text or identifiers leak |
| 6 | **Honesty guards** — escrow, no backdating, tiers labeled | the credibility model collapses |
| 7 | **Never break a session** — hooks exit 0, fast, detached | users uninstall |

## 2. Automated suites (run on every push)

All in `tests/unit/`, executed by `node --test` (native type-stripped TS,
Node ≥ 24). **107 tests** at 1.1.x. One command:

```bash
npm ci && npm run check     # typecheck + tests + build + bin-diff
```

| Suite | What it proves |
|---|---|
| `core.test.ts` | Canonical JSON stability; deterministic ULIDs (same content ⇒ same id); shard placement and line-atomic appends; supersession resolution; escrow seal/verify round-trip; config defaults and legacy-shape merging. |
| `verify.test.ts` | The integrity contract end-to-end: valid homes pass clean; tampered content breaks id recomputation *and* escrow; missing usage breaks conservation; dangling supersedes / duplicate ids / wrong shards / illegal kinds / backdated pre-registration are each caught. |
| `determinism.test.ts` | Double-run byte-identity of every stream, plus committed golden shards (regenerate only via `tests/tools/regen-golden.ts`). |
| `meter.test.ts` | Transcript parsing per format version (2.1.x + legacy 1.x): turn boundaries, streaming-duplicate dedupe by message id, sidechain rollup, cache 5m/1h split, raw-extra preservation; meter conservation self-check; idempotency (outputs fed back ⇒ zero new events); grown-transcript supersession; exact fixed-point pricing incl. the legacy unsplit-cache rule. |
| `meter-golden.test.ts` | Committed meter outputs for every fixture transcript, byte-compared; plus a full CLI e2e: meter fixtures → verify passes → re-run is a no-op. |
| `resolver.test.ts` | **The T2 harness**: a declarative case table covering every ladder rule (0–6), every fall-through, range pins, strict-forward evidence, project-key context — plus inbox integration (ambiguities queue once, dedupe across runs, never drop tokens). |
| `m0.test.ts` | Retention check paths (0/absent/high); git-local adapter scoped to identity emails; bootstrap receipt snapshot; full M0 e2e (init → capture queue → mine → verify) including the pruned-transcript gap path and D9 (session identity from the transcript, not the hook); `append` seals escrow, refuses backdating, dedupes. |
| `adapters.test.ts` | Jira/GitHub normalizers against fixture payloads (both API shapes); the conformance kit passing bundled adapters and **failing a deliberately fabricating one**; reconcile: shipped proposals carry escrow + artifacts, orphans marked honestly, drift corrections, baseline medians; sync-plan CLI plan→apply e2e with idempotent re-apply. |
| `queries.test.ts` | Spend rollups (sorting, confidence, unattributed shown), report data (ranges summed separately by basis, utilization), forecast medians with low-data labeling, redaction (internal strips machine detail; external provably contains no keys/titles/URLs while keeping every number; deterministic pseudonyms). |
| `pace.test.ts` | Period-window parsing (quarter/month/fallback); spend vs work-weighted pace; epic envelopes; threshold notices fire once per crossing then stay silent. |
| `otel.test.ts` | OTLP parsing per session/model/type; transcript-wins skipping; mixed-source conservation; deterministic output; idempotent re-ingest. |
| `m3.test.ts` / `m3b.test.ts` | Waste tallies (deduped by tool block id; **string-absence proof that no command text or path reaches the ledger**); reopen corrections + report counting; renewal reminder once per period; GitLab adapter conformance. |
| `acceptance.test.ts` | Product-spec §8 UX flows 1–4 as scripted CLI runs; Linear adapter conformance. |
| `polish.test.ts` | Regressions for the first adversarial review's 10 confirmed findings (pricing-bump re-metering, pin fingerprint invalidation, correction-over-shipped classification, window normalization, atomic lock, resolution survival across re-meters, …). |
| `perfection.test.ts` | Regressions for the second review's findings (OTel cumulative temporality, grown-export supersession, transcript-retires-otel, chain-based reconcile, chain-origin pacing windows, rename-based lock reaping). |
| `feedback.test.ts` | Regressions for the tested-user critique (key stoplist incl. the literal SHA-256 incident, project-key allowlist, status/export/pricing commands, bootstrap windows). |

Shell layer, same gate:

```bash
bash scripts/validate-plugin.sh     # manifests, skills, D19 naming, schema examples, dependency-free bin
shellcheck scripts/*.sh tests/*.sh
bash tests/test-capture-session.sh  # hook: exits 0 on valid/empty/unwritable input, never blocks
claude plugin validate .            # the official validator (no warnings allowed)
```

## 3. Golden-file protocol

Golden bytes are the determinism contract. A legitimate behavior change
regenerates them **deliberately**:

```bash
node tests/tools/regen-golden.ts        # stream-shard goldens
node tests/tools/regen-meter-golden.ts  # meter output goldens
```

Rule: a PR that touches goldens must say why in its message; CI's
reproducible-build job (`npm run build && git diff --exit-code bin/`)
independently proves the committed engine matches `src/`.

## 4. CI matrix (.github/workflows/ci.yml)

| Job | Runs |
|---|---|
| validate | `scripts/validate-plugin.sh` |
| shellcheck | shell lint over scripts + shell tests |
| hook | `tests/test-capture-session.sh` |
| engine | Node 24: `npm ci` → typecheck → 107 tests → rebuild + zero-diff |
| trigger-evals | *opt-in*: `claude plugin eval waybill@waybill --threshold 0.8`; only when repo variable `RUN_TRIGGER_EVALS=true`, push events only (fork PRs lack the secret) |

## 5. Manual / environment tests (release-blocking where marked)

| Test | How | Status |
|---|---|---|
| **Real-machine retro run** (blocking) | fresh `WAYBILL_HOME=$(mktemp -d)`, `mine --all` over real `~/.claude/projects`, then `verify` | every release; last: 16 sessions, ~1.9B tokens, green |
| **Installed-plugin e2e** (blocking) | install from the GitHub marketplace, run `init`/`bootstrap`/`status` from the installed root, fire the SessionEnd hook with a real capture, confirm the detached miner processes it | done at 1.0.0/1.1.0 |
| **launcher smoke** (blocking) | `./bin/waybill status` and `zsh -c './bin/waybill status'` | the launcher replaced the `node "$WAYBILL"` idiom (1.3.0); zsh case kept from the 1.1.0 incident |
| Skill trigger evals | `claude login` then `claude plugin eval waybill@waybill --threshold 0.8` (cases in `evals/`, incl. an overtrigger negative) | authored; pass rate unmeasured (needs an authenticated CLI) |
| Live adapter runs | real Linear / GitLab accounts through sync end-to-end | conformance-tested on fixtures only; adapters.md says exactly that |
| Linux / WSL pass | the CI engine job covers Linux; a manual WSL smoke of hook + miner is wanted | open |
| Plugin-panel check | after install with **no** env vars: the Errors tab must show nothing for waybill | added at 1.1.1 (`${GITHUB_MCP_PAT:-}`) |

## 6. The FINALPASS release gate

Every release runs, in order, from a clean tree:

1. `npx tsc --noEmit` — strict, zero errors.
2. `node --test 'tests/unit/**/*.test.ts'` — all pass.
3. `npm run build && git diff --exit-code bin/` — reproducible artifact.
4. `bash scripts/validate-plugin.sh` and `claude plugin validate .` — clean.
5. `shellcheck` + hook tests — clean.
6. Real-machine retro (blocking row above) — `verify` green on real data.
7. CHANGELOG entry, versions bumped everywhere (plugin.json, package.json,
   lockfile, skill frontmatter), DECISIONS.md updated if any judgment call
   was made.
8. Tag `vX.Y.Z`, push, GitHub release, `claude plugin update` on a real
   machine, `waybill status` shows the new engine version.

Evidence for each release's gate lives in [VALIDATION.md](../VALIDATION.md).

## 7. Adversarial review cadence

Beyond suites: multi-agent review passes (independent finder lenses, one
adversarial verifier per finding, fix only what survives) ran at 0.3 (10
confirmed) and 1.0 (12 confirmed), plus a hands-on user-perspective session
before 1.1.0 (6 fixed). Every confirmed finding became a permanent
regression test — the suites above grew out of real failures, not
hypothetical ones. Recommended cadence going forward: one such pass per
minor release, plus one before any schema-affecting change.

## 8. Known coverage gaps (honest)

- Trigger-eval pass rates unmeasured until an authenticated `plugin eval`
  run (early-access command).
- No live-account adapter runs (Linear/GitLab/Bitbucket) — fixtures only.
- No Windows/WSL manual pass yet (D16 targets WSL).
- Concurrency is tested for lock exclusivity and stale reaping, but not
  under true parallel-process fuzzing.
- The OTel fixture family covers one exporter shape; other collectors'
  OTLP framing variants are untested.

Contributions that close a gap qualify for `good first receipt`.
