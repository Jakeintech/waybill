# Security Policy

## What this plugin touches

- **Local files**: the ledger under `~/.waybill/` (or
  `$WAYBILL_HOME`) and Claude Code session transcripts it is asked to
  mine. Nothing is uploaded by the plugin itself.
- **Network**: only the MCP servers configured in `.mcp.json` — Atlassian's
  and GitHub's official remote servers by default — using credentials you
  provide (OAuth, or `GITHUB_MCP_PAT` from your environment). Queries are
  scoped to the current user's own issues and PRs.
- **Secrets**: never written to the ledger or the repo. The GitHub PAT lives
  only in your environment; use a fine-grained, read-only token.

## Supported versions

The latest minor release receives fixes. Older versions: please upgrade.

## Reporting a vulnerability

Please **do not** open a public issue. Use GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository (Security → Report a vulnerability), or email
**info@jakeawilliams.com** with details and reproduction steps.

You'll get an acknowledgment within 72 hours and a fix or mitigation plan
within 14 days for confirmed issues. Credit given unless you prefer
otherwise.

## Hardening notes for users

- Prefer OAuth flows over long-lived tokens where the MCP server supports it.
- The `~/.waybill/` git repo may contain issue titles and PR URLs —
  treat it with the same sensitivity as your tracker, and don't push it to a
  public remote.
