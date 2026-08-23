import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultConfig, loadConfig, saveConfig, saveIdentity, type Identity } from "../core/config.ts";
import { loadPricingBundle } from "../core/pricing-bundle.ts";
import { defaultProjectsDir, listTranscripts, meterAllQuiet, repoFromCwd } from "../meter/run.ts";
import { applyBundledPricing, type PricingImportResult } from "./cmd-pricing.ts";

// Fine-grained read-only is the whole posture (E-13): sync only ever
// reads your own issues and PRs, so init must never ask for classic
// write scope. README's upgrade path says the same.
const GITHUB_PAT_MESSAGE =
  "Export GITHUB_MCP_PAT in your shell profile (easiest: \"$(gh auth token)\"). " +
  "Or mint a fine-grained read-only PAT (repository contents + pull requests, read-only) " +
  "at https://github.com/settings/personal-access-tokens";

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

/** D7: surface the transcript retention setting; recommend raising; warn on 0.
 * Claude Code layers settings.local.json over settings.json — read both so
 * the report matches the effective value, not just the shared file. */
export function checkRetention(claudeSettingsPath: string): RetentionCheck {
  let days: number | null = null;
  const readDays = (path: string): number | null => {
    if (!existsSync(path)) return null;
    try {
      const settings = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      return typeof settings["cleanupPeriodDays"] === "number"
        ? settings["cleanupPeriodDays"]
        : null;
    } catch {
      return null; // unreadable settings: treat as default
    }
  };
  days = readDays(claudeSettingsPath);
  if (claudeSettingsPath.endsWith("settings.json")) {
    const local = readDays(claudeSettingsPath.replace(/settings\.json$/, "settings.local.json"));
    if (local !== null) days = local;
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
  let projectsDir = defaultProjectsDir();
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--claude-settings") claudeSettings = args[++i] ?? claudeSettings;
    else if (a === "--projects-dir") projectsDir = args[++i] ?? projectsDir;
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
  // rates the user has customized with `pricing set`. A missing or corrupt
  // bundle must not abort init — the "no pricing configured" needs-action
  // line exists for exactly that state.
  let pricing: PricingImportResult | null = null;
  if (Object.keys(config.pricing.models).length === 0) {
    try {
      pricing = applyBundledPricing(config);
    } catch {
      // bundle unavailable — init continues; needs_action names the gap
    }
  }
  saveConfig(home, config);

  const identity = buildIdentity();
  saveIdentity(home, identity);

  if (!existsSync(join(home, ".git"))) {
    git(home, ["init", "-b", "main"]);
  }
  // Derived caches and transient runtime state (the capture queue, the
  // miner lock inside it, and the meter checkpoints) stay out of the
  // append-only audit history — they are rebuildable, the streams are not.
  writeFileSync(join(home, ".gitignore"), "rollups/\npending-sessions/\nmeter_state.json\n", "utf8");
  // Multi-machine (docs/multi-machine.md): stream shards are append-only
  // JSONL with deterministic ids and order-independent reads, so git's
  // union merge is *correct* for them — a crossed append from two machines
  // merges to the union of lines instead of a conflict.
  writeFileSync(join(home, ".gitattributes"), "streams/**/*.jsonl merge=union\n", "utf8");
  try {
    git(home, ["add", "-A"]);
    git(home, ["commit", "-m", freshConfig ? "ledger: initialized" : "ledger: init refreshed"]);
  } catch {
    // nothing to commit is fine
  }

  // E-04: the first receipt must contain tokens. Meter every existing
  // transcript now — subagent transcripts included — instead of leaving
  // months of history invisible until the first SessionEnd. Progress goes
  // to stderr so --json stdout stays one parseable document; when there is
  // nothing to meter (or metering is paused) init stays exactly as quiet
  // as before.
  let mined: import("../meter/run.ts").MeterAllResult | null = null;
  const transcriptCount = config.metering.enabled === false ? 0 : listTranscripts(projectsDir).length;
  if (transcriptCount > 0) {
    process.stderr.write(
      `Metering ${transcriptCount} existing transcript(s) (subagents included) — months of history can take a minute...\n`,
    );
    mined = meterAllQuiet(home, projectsDir, (p, err) =>
      process.stderr.write(`waybill init: ${p}: ${err.message}\n`),
    );
    if (mined === null) {
      process.stderr.write("another metering process is running — existing transcripts will be picked up by it\n");
    }
  }

  const retention = checkRetention(claudeSettings);
  const githubPatSet = (process.env["GITHUB_MCP_PAT"] ?? "") !== "";
  // "Bundled vs custom" in the configured line is decided by version match,
  // not by whether THIS run imported — a re-init after an earlier bundled
  // import must not relabel the same rates as custom.
  let bundledPricingVersion: string | null = null;
  try {
    bundledPricingVersion = loadPricingBundle().last_updated;
  } catch {
    // bundle unavailable — label falls back to "custom"
  }

  const configured: string[] = [
    "ledger (git-backed, append-only)",
    mined !== null && mined.metered + mined.already_current > 0
      ? `metered transcripts (${mined.metered} session(s) mined now, ${mined.already_current} already current` +
        (mined.failures > 0 ? `, ${mined.failures} failed` : "") +
        ")"
      : null,
    identity.git_emails.length > 0 ? `identity (${identity.git_emails.join(", ")})` : null,
    config.git.repos.length > 0 ? `repo scope (${config.git.repos.join(", ")})` : null,
    pricing && pricing.imported.length > 0
      ? `pricing (${pricing.imported.length} bundled Anthropic model(s), version ${pricing.version})`
      : config.pricing.version !== null
        ? `pricing (${config.pricing.version === bundledPricingVersion ? "bundled Anthropic rates" : "custom"}, ` +
          `version ${config.pricing.version}, ${Object.keys(config.pricing.models).length} model(s))`
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
    mined,
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
