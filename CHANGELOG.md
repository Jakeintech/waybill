# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/) — the ledger entry schema is the
compatibility surface.

## [Unreleased]

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

[Unreleased]: https://github.com/YOUR_GITHUB_USERNAME/waybill/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/YOUR_GITHUB_USERNAME/waybill/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/YOUR_GITHUB_USERNAME/waybill/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/YOUR_GITHUB_USERNAME/waybill/releases/tag/v0.1.0
