# Contributing to Waybill

Thanks for helping. Two minutes of orientation, then the mechanics.

## The one rule that outranks the others

The methodology is the product. Waybill is useful *because* it refuses
to flatter — evidence tiers, pre-registration, ranges, append-only history,
no peer scraping. PRs that weaken those invariants (however well-intentioned:
"let users backfill estimates", "add a teammates view") will be closed with a
link to [the methodology](skills/ledger/references/methodology.md) and
[ROADMAP non-goals](ROADMAP.md#non-goals). Everything else is negotiable.

## Dev setup

```bash
git clone https://github.com/Jakeintech/waybill
cd waybill
claude plugin marketplace add .
claude plugin install waybill@waybill
```

Requirements for the checks: `bash`, `jq`, `shellcheck`, and Node ≥ 24
(the test runner uses Node's native TypeScript type-stripping; the shipped
`bin/waybill.mjs` itself runs on Node ≥ 20). The engine is TypeScript in
`src/`, strict mode, compiled by `npm run build` into the committed,
dependency-free `bin/waybill.mjs` — the only runtime the shipped plugin
needs is Node itself.

Skill trigger evals live in `evals/` (one case per skill's canonical
phrases plus an overtrigger negative). They cost real model calls, so they
are not part of the local gate; run them with an authenticated CLI via
`claude plugin eval waybill@waybill --threshold 0.8` when you change a
skill description. CI runs them only when the repo variable
`RUN_TRIGGER_EVALS` is set.

## Quality gates (run before pushing)

```bash
npm ci                              # dev toolchain (typescript, esbuild) — never shipped
npm run typecheck                   # tsc --noEmit, strict
npm test                            # node --test: unit, golden, determinism, conservation
npm run build && git diff --exit-code bin/  # committed bundle must match src/
bash scripts/validate-plugin.sh     # structure, manifests, frontmatter, schema examples
shellcheck scripts/*.sh tests/*.sh  # shell lint
bash tests/test-capture-session.sh  # hook behavior
```

CI runs the same jobs on every PR; green checks are required to merge. If
you change `src/` without rebuilding `bin/`, the build-diff job fails — the
committed artifact must provably match the sources.

## Writing and changing skills

Skills follow the [Claude Code plugin conventions](https://code.claude.com/docs/en/plugins):

- **Frontmatter description is the UI.** Third person, and deliberately
  *pushy*: skills chronically undertrigger, so include the concrete phrases a
  user would say, in quotes, plus the contexts where the skill should fire
  even unprompted.
- **Body is instructions for Claude**, imperative voice, under ~500 lines.
  Depth goes in `references/` with explicit pointers on when to read them.
- **Trigger-test your description** before opening the PR: run a handful of
  realistic phrasings through `claude -p "<phrase>"` in a session with the
  plugin installed and confirm the skill loads. Note the phrases you tested
  in the PR description, or run the scripted version: `claude plugin eval`
  over the cases in `evals/`.
- Schema or methodology changes must update
  `skills/ledger/references/schema.md` / `methodology.md` in the same PR —
  the example entries in `schema.md` are validated by CI, so they can't rot.

## Adapters (most-wanted contribution)

Want Linear, GitLab, Bitbucket, Azure DevOps? See
[docs/adapters.md](docs/adapters.md). A good adapter PR includes the
`.mcp.json` server block, the query-syntax notes for `sync`, and a filled row
in the tested-configs table.

## Commits, PRs, releases

- **Commits**: [Conventional Commits](https://www.conventionalcommits.org)
  (`feat:`, `fix:`, `docs:`, `test:`, `chore:`). Scope by component when
  useful: `feat(sync): …`.
- **DCO**: every commit must carry a `Signed-off-by:` line
  ([Developer Certificate of Origin](https://developercertificate.org)) —
  use `git commit -s`. No CLA.
- **PRs**: fill the template; one logical change per PR; add a line to
  `CHANGELOG.md` under `Unreleased`.
- **Releases**: [SemVer](https://semver.org). Ledger **schema** changes are
  the compatibility surface — additive fields are minor, anything requiring
  migration is major. Maintainers cut releases by moving `Unreleased` to a
  dated version in `CHANGELOG.md`, bumping `.claude-plugin/plugin.json`, and
  tagging `vX.Y.Z`.

## Where to start

Issues labeled `good first receipt`, or any of: a new report preset, more hook
test cases, an adapter, README typo fixes. Questions → GitHub Discussions.

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
