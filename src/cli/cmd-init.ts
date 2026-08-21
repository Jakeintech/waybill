import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultConfig, loadConfig, saveConfig, saveIdentity, type Identity } from "../core/config.ts";
import { repoFromCwd } from "../meter/run.ts";
import { applyBundledPricing, type PricingImportResult } from "./cmd-pricing.ts";

const GITHUB_PAT_MESSAGE =
  "Export GITHUB_MCP_PAT in your shell profile. Create at https://github.com/settings/tokens with repo scope.";

function git(home: string, args: string[]): void {
  execFileSync("git", ["-C", home, ...args], {
    stdio: ["ignore", "ignore", "ignore"],
    timeout: 15000,
  });
}

function tryExec(cmd: string, args: string[]): string | null {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
  } catch {
    return null;
  }
}

export interface RetentionCheck {
  cleanup_period_days: number | null;
  effective: string;
  warning: string | null;
  recommendation: string | null;
}

/** D7: surface the transcript retention setting; recommend raising; warn on 0. */
export function checkRetention(claudeSettingsPath: string): RetentionCheck {
  let days: number | null = null;
  if (existsSync(claudeSettingsPath)) {
    try {
      const settings = JSON.parse(readFileSync(claudeSettingsPath, "utf8")) as Record<string, unknown>;
      if (typeof settings["cleanupPeriodDays"] === "number") days = settings["cleanupPeriodDays"];
    } catch {
      // unreadable settings: treat as default
    }
  }
  if (days === 0) {
    return {
      cleanup_period_days: 0,
      effective: "transcripts are deleted immediately",
      warning:
        "cleanupPeriodDays is 0 — Claude Code deletes transcripts at once, so nothing can be metered. Waybill's session receipts will only cover sessions mined before deletion.",
      recommendation: "set cleanupPeriodDays to 90 or more in ~/.claude/settings.json",
    };
  }
  if (days === null) {
    return {
      cleanup_period_days: null,
      effective: "default retention (30 days)",
      warning: null,
      recommendation:
        "raise cleanupPeriodDays (e.g. 99999) in ~/.claude/settings.json so historical sessions stay meterable; Waybill's session receipts preserve totals either way",
    };
  }
  return {
    cleanup_period_days: days,
    effective: `${days} day(s)`,
    warning: null,
    recommendation:
      days < 90
        ? "raise cleanupPeriodDays (e.g. 99999) so historical sessions stay meterable"
        : null,
  };
}

export function buildIdentity(): Identity {
  const emails = new Set<string>();
  const names = new Set<string>();
  for (const scope of [["--global"], []]) {
    const email = tryExec("git", ["config", ...scope, "--get-all", "user.email"]);
    for (const e of email?.split("\n") ?? []) if (e.trim()) emails.add(e.trim());
    const name = tryExec("git", ["config", ...scope, "--get-all", "user.name"]);
    for (const n of name?.split("\n") ?? []) if (n.trim()) names.add(n.trim());
  }
  // Only reads an existing gh auth; never starts an auth flow.
  const ghLogin = tryExec("gh", ["api", "user", "-q", ".login"]);
  return {
    schema_version: 2,
    git_emails: [...emails].sort(),
    git_names: [...names].sort(),
    github_login: ghLogin,
    jira_account_id: null,
  };
}

export function runInit(home: string, args: string[], json: boolean): number {
  let claudeSettings = join(homedir(), ".claude", "settings.json");
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--claude-settings") claudeSettings = args[++i] ?? claudeSettings;
    else {
      process.stderr.write(`waybill init: unknown option ${a}\n`);
      return 2;
    }
  }

  mkdirSync(join(home, "pending-sessions"), { recursive: true });
  mkdirSync(join(home, "rollups"), { recursive: true });

  const freshConfig = !existsSync(join(home, "config.json"));
  const config = freshConfig ? defaultConfig() : loadConfig(home);
  const cwdRepo = repoFromCwd(process.cwd());
  if (cwdRepo && !config.git.repos.includes(cwdRepo)) config.git.repos.push(cwdRepo);

  // Bundled pricing auto-imports whenever the rate table is EMPTY — a fresh
  // install, or a re-init on a ledger initialized before bundled rates
  // shipped ("costs appear from day one" must hold for upgraders too).
  // A table holding any rate is never touched: re-init must not clobber
  // rates the user has customized with `pricing set`.
  const pricing: PricingImportResult | null =
    Object.keys(config.pricing.models).length === 0 ? applyBundledPricing(config) : null;
  saveConfig(home, config);

  const identity = buildIdentity();
  saveIdentity(home, identity);

  if (!existsSync(join(home, ".git"))) {
    git(home, ["init", "-b", "main"]);
  }
  writeFileSync(join(home, ".gitignore"), "rollups/\n", "utf8");
  try {
    git(home, ["add", "-A"]);
    git(home, ["commit", "-m", freshConfig ? "ledger: initialized" : "ledger: init refreshed"]);
  } catch {
    // nothing to commit is fine
  }

  const retention = checkRetention(claudeSettings);
  const githubPatSet = (process.env["GITHUB_MCP_PAT"] ?? "") !== "";

  const configured: string[] = [
    "ledger (git-backed, append-only)",
    identity.git_emails.length > 0 ? `identity (${identity.git_emails.join(", ")})` : null,
    config.git.repos.length > 0 ? `repo scope (${config.git.repos.join(", ")})` : null,
    pricing && pricing.imported.length > 0
      ? `pricing (${pricing.imported.length} bundled Anthropic model(s), version ${pricing.version})`
      : config.pricing.version !== null
        ? `pricing (custom, version ${config.pricing.version})`
        : null,
    retention.warning === null && retention.recommendation === null
      ? `transcript retention (${retention.effective})`
      : null,
    githubPatSet ? "GitHub MCP (GITHUB_MCP_PAT set)" : null,
  ].filter((line): line is string => line !== null);

  const needsAction: string[] = [
    identity.git_emails.length === 0 ? "no git user.email found — set one so sessions attribute to you" : null,
    retention.warning,
    retention.recommendation,
    // Never claim costs work when no rate can price anything.
    config.pricing.version === null || Object.keys(config.pricing.models).length === 0
      ? "no pricing configured — costs stay tokens-only; run: waybill pricing import"
      : null,
    !githubPatSet ? GITHUB_PAT_MESSAGE : null,
  ].filter((line): line is string => line !== null);

  const result = {
    home,
    fresh: freshConfig,
    repos: config.git.repos,
    identity: { git_emails: identity.git_emails, github_login: identity.github_login },
    retention,
    pricing: pricing ?? { imported: [], unknown: [], version: config.pricing.version },
    github_mcp_pat_set: githubPatSet,
    configured,
    needs_action: needsAction,
  };
  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    process.stdout.write(
      freshConfig
        ? `Initialized ${home} (git repo, append-only streams)\n`
        : `Refreshed ${home} (already initialized; config preserved)\n`,
    );
    process.stdout.write(`Identity: ${identity.git_emails.join(", ") || "(no git email found)"}` +
      (identity.github_login ? ` · GitHub: ${identity.github_login}` : "") + "\n");
    process.stdout.write(`Repos in scope: ${config.git.repos.join(", ") || "(none yet)"}\n`);
    process.stdout.write(`Transcript retention: ${retention.effective}\n`);
    if (retention.warning) process.stdout.write(`WARNING: ${retention.warning}\n`);
    if (retention.recommendation) process.stdout.write(`Recommend: ${retention.recommendation}\n`);
    if (pricing && pricing.imported.length > 0) {
      process.stdout.write(
        `Pricing: imported ${pricing.imported.length} bundled Anthropic model(s) (version ${pricing.version}). ` +
          "Override any rate with: waybill pricing set <model-id> ...\n",
      );
      if (!freshConfig) {
        process.stdout.write(
          "Existing events re-price on the next meter run: waybill meter --all\n",
        );
      }
    }
    process.stdout.write("\nConfigured:\n");
    for (const line of configured) process.stdout.write(`  - ${line}\n`);
    if (needsAction.length > 0) {
      process.stdout.write("Needs action:\n");
      for (const line of needsAction) process.stdout.write(`  - ${line}\n`);
    }
  }
  return 0;
}
