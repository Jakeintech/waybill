# 2.1.0 release handoff

Branch `claude/waybill-2-1-0-launch-8mjo41`, 19 commits over `a558f66`,
tagged `v2.1.0` locally (not pushed — releasing is yours, see the
human-only list). Written in the product's own tiers: **Facts** are
file/commit/test citations, **Measured** is pasted engine output with
its command, **Judgment** is labeled.

## Facts — every finding → commit

| Finding | Commit | Tests added |
|---|---|---|
| E-02 subagent transcripts metered | `29c4c64` | tests/unit/meter-subagents.test.ts (7) |
| E-01 claim rewrites + clock check + verify warnings | `6e7e380` | tests/unit/append-clock.test.ts (4) |
| E-03 demo static render + cold open + hold | `dd972fa` | tests/unit/demo-asset.test.ts (5) |
| E-04 init meters history | `d207c02` | tests/unit/init-meter.test.ts (3) |
| E-05 real README receipt · E-07 restart line | `b920823` | — (engine output pasted) |
| E-06 de-slop (moves, changelog fold, .mailmap) | `cbefd2d` | — |
| E-10 shared-walk stream reads | `3763d2c` | tests/unit/meter-cache.test.ts (1) |
| E-11 meter gaps in verify + packs | `3c13ae2` | tests/unit/meter-gap.test.ts (2) |
| E-12 SessionStart pure shell, miner precomputes | `7125bc4` | tests/unit/session-notice.test.ts (4) |
| E-13/E-08/E-09/E-16 docs batch | `6fecfef` | pricing-import assertion updated |
| E-14 multi-repo warn-only | `d2fabb1` | tests/unit/multi-repo.test.ts (3) |
| E-15 capability/dashboard phrasing + evals | `78d8174` | evals/trigger-help, trigger-dashboard |
| S-01/S-02 positioning + README first screen | `d47db30` | — |
| S-04 `query cache` + skill · S-05 evidence line | `ac8ecc4` | tests/unit/cache.test.ts (3); evals/trigger-cache{,-negative} |
| S-03 launch post · D-01..D-04 design docs | `fe2cb5d` | — |
| R-01/R-02/WB-05 distribution | `87dc73d` | — |
| Release 2.1.0 | `7d647a6` | — |

W8 (export-pack boundary promotion) was found **already present** at the
2.0.0 baseline (docs/skills.md ¶"The export-pack boundary";
skills/report/SKILL.md "Output handling") — verified, no change needed.

Suite: 192 → **224 tests**, 0 failing. tsc clean; shellcheck clean; hook
suite 7/7; `validate-plugin.sh` pass; `claude plugin validate --strict`
pass on both manifests; `npm run gate` pass; fresh-clone e2e pass
(build reproduces bin byte-for-byte → init meters 3 fixture transcripts
subagents-included with progress line → bootstrap TOKENS shows the exact
E-02 fixture sums → verify green → `query cache` answers).

## Measured — the launch numbers and the exact commands

All from one engine run over the remote session that built this release
(the home also backs the README receipt), engine `7d647a6`:

```
WAYBILL_HOME=<home> node bin/waybill.mjs meter --all     # subagents included
WAYBILL_HOME=<home> node bin/waybill.mjs bootstrap       # → README receipt block, verbatim
WAYBILL_HOME=<home> node bin/waybill.mjs query cache     # → launch-post JSON block, verbatim
```

Headline figures (see docs/launch-post.md for the verbatim block):
total_tokens 103,289,070 · cache_read_pct **99.2** · input 608 · output
255,071 · cache_read 102,428,828 · effective_usd 126.8972 vs
list_equivalent_usd 1042.7483 → saved_usd 915.8511
(`basis: "list_price_equivalent_derived"`, covered_pct 100) ·
cache_read_share_of_billed_pct 80.7 · **unattributed_pct 100** — kept in
the post; the session ran on an automation branch with no tracker keys
and the resolver refuses to guess.

These are point-in-time (the session kept running after the capture).
To refresh: re-run the three commands; never retype a digit.

## Judgment — deviations from the work order, each with its reason

1. **Branch name.** The order said `release/2.1.0`; this session's
   harness designates `claude/waybill-2-1-0-launch-8mjo41` as the only
   pushable branch. Developed and pushed there; treat it as the release
   branch.
2. **"Seven-month history."** The order describes metering "the full
   seven-month history of this repo"; the repo's actual git history
   begins 2026-08-16 and no seven-month transcript archive exists in
   this container. The launch numbers are what the engine measured
   here — the session that built 2.1.0 — and say so. If your local
   machine holds the longer transcript history, re-render before
   posting (the post's rule 2).
3. **E-12's mechanism.** A bare `&` would have silenced the notice
   feature (a detached hook's stdout never reaches the session), so the
   fix precomputes at mine time instead — same goal, different
   mechanism, recorded in docs/DECISIONS.md.
4. **E-06's history rewrite not run.** `.mailmap` committed instead;
   `git filter-repo` stays yours (below).
5. **brand.md competitor rule narrowed** to permit the work-ordered
   named survey in docs/positioning.md (recorded in DECISIONS).
6. **Trigger evals authored, not executed.** `claude plugin eval` needs
   an authenticated CLI + API key (CI gates on RUN_TRIGGER_EVALS); this
   container has neither. Files are in place for the existing runner.
7. **Issues not filed.** No GitHub tooling reached this session (no
   `gh`, GitHub MCP never connected). Ready-to-paste bodies below.
8. **Public-claim sign-off pending.** Wording is committed on the
   branch as *proposed*; nothing publishes from here. Review targets:
   README first screen (lines 1–75), docs/positioning.md,
   docs/launch-post.md.

## Ready-to-file issues (paste bodies; cross-link the doc)

1. **Per-turn attribution split for multi-repo sessions** (the E-14
   full fix) — "2.1.0 detects sessions spanning several working
   directories and verify warns that all spend books via the first cwd
   (receipts carry additive `cwds`). Implement per-turn repo tracking in
   the parser and resolver so each turn attributes via the cwd active
   at its start; the `branches` list and `cwds` field already exist.
   Semantics deliberately not rushed — see commit `d2fabb1`."
2. **Team aggregation (design)** — link docs/design/team-aggregation.md;
   ask: review the governing principle (aggregate receipts, never
   transcripts) and the free/paid boundary.
3. **Engagement/client tagging (design)** — link
   docs/design/engagement-tagging.md; ask: additive `engagement` field +
   filter-before-redaction export; free tier.
4. **Capitalization / R&D evidence pack (design)** — link
   docs/design/capitalization-evidence.md; note the no-tax-advice
   caveat is load-bearing; invite partner firms to specify columns.
5. **Multi-agent ingestion adapters (design)** — link
   docs/design/multi-agent-adapters.md; fidelity tiers 1–3; the
   deterministic guarantee stays Claude-Code-scoped until a tool earns
   tier 1 with fixtures.

## Human-only actions (deliberately not performed here)

- [ ] **Review and sign off the public wording** (deviation 8), then
      merge the branch.
- [ ] **Release plumbing**: after merge, append `v2.1.0 <sha>` to
      `.github/releases.txt` per your reconciler flow (the local tag
      `v2.1.0` exists on the branch head; releasing is your call).
- [ ] **`git filter-repo --mailmap .mailmap`** + force-push, if you want
      the 25 tool-authored commits permanently re-attributed (the
      committed .mailmap already fixes shortlog/blame display).
- [ ] **Rename the GitHub label** `good first receipt` → `good first
      issue` (docs already say the new name).
- [ ] **Upload `assets/social-preview.png`** in Settings → Social
      preview (1280×640, rendered from the demo's final frame).
- [ ] **File the five issues** above; cross-link them from the design
      docs if you want back-references.
- [ ] **Run the trigger evals** where authenticated:
      `claude plugin eval waybill@waybill --threshold 0.8`.
- [ ] **Submit** via <https://platform.claude.com/plugins/submit>
      (pre-filled answers in docs/directory-submission.md), PR the
      community lists, and post the launch write-up per the
      distribution plan's rules — never solicit upvotes; r/ClaudeAI
      needs >50 OP karma; the r/ClaudeCode post carries the
      what-I-learned element (it's in the draft). Proposed Show HN
      title (yours to accept or rewrite):
      *Show HN: 99% of my Claude Code tokens were cache reads, billed
      at a tenth*.

Do-not-build list: honored in full — no team server, no SSO/RBAC, no
dashboards beyond the existing local one, no hosted anything, no
telemetry, no `commands/` directory, no HTML renderer in the engine, no
license change, no per-seat anything, no pre-E-02 figure anywhere, and
nothing posted.
