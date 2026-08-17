import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ModelPricing {
  input_per_mtok: number;
  output_per_mtok: number;
  cache_read_per_mtok: number;
  cache_write_5m_per_mtok: number;
  cache_write_1h_per_mtok: number;
}

export interface Allocation {
  period: string;
  tokens_granted: number;
  granted_at: string;
}

export type Audience = "self" | "internal" | "external";

/** How much Waybill says unprompted (SessionStart lines, renewal nudges).
 * normal: everything; minimal: pacing thresholds and errors only; off:
 * metering runs, Waybill never speaks first. */
export type NoticesLevel = "normal" | "minimal" | "off";

/** Output length for rendered reports/answers. terse: 1–3 lines (may never
 * drop unattributed %, confidence, low_confidence labels, evidence-tier
 * labels, or ranges); standard: the default; full: no collapse. */
export type Detail = "terse" | "standard" | "full";

export interface Config {
  schema_version: number;
  tracker: { kind: string | null; project_keys: string[]; base_url: string | null };
  git: { kind: string; repos: string[]; default_branch: string };
  baseline: {
    velocity_points_per_sprint: number | null;
    median_cycle_time_days: number | null;
    window: string | null;
    derived_from: string | null;
  };
  allocations: Allocation[];
  metering: {
    /** The pause switch: false short-circuits capture, mine, and meter —
     * nothing recorded until re-enabled. `status` reports the paused state. */
    enabled: boolean;
    branch_key_pattern: string;
    repo_defaults: Record<string, string | null>;
  };
  pricing: {
    version: string | null;
    unknown_model_policy: "tokens_only";
    models: Record<string, ModelPricing>;
  };
  budgets: {
    allocation: string;
    epics: Record<string, number>;
    /** Days before the allocation period ends to surface the renewal
     * reminder (draft-the-pitch nudge). */
    renewal_reminder_days: number;
  };
  notices: { level: NoticesLevel };
  audience_default: Audience;
  detail_default: Detail;
  last_sync: string | null;
}

export function defaultConfig(): Config {
  return {
    schema_version: 2,
    tracker: { kind: null, project_keys: [], base_url: null },
    git: { kind: "local", repos: [], default_branch: "main" },
    baseline: {
      velocity_points_per_sprint: null,
      median_cycle_time_days: null,
      window: null,
      derived_from: null,
    },
    allocations: [],
    metering: {
      enabled: true,
      branch_key_pattern: "[A-Z][A-Z0-9]+-[0-9]+",
      repo_defaults: {},
    },
    pricing: { version: null, unknown_model_policy: "tokens_only", models: {} },
    budgets: { allocation: "inherit", epics: {}, renewal_reminder_days: 14 },
    notices: { level: "normal" },
    audience_default: "self",
    detail_default: "standard",
    last_sync: null,
  };
}

export function configPath(home: string): string {
  return join(home, "config.json");
}

export function loadConfig(home: string): Config {
  const p = configPath(home);
  if (!existsSync(p)) return defaultConfig();
  const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<Config>;
  // Merge over defaults so older configs keep working (additive v2).
  const base = defaultConfig();
  return {
    ...base,
    ...raw,
    tracker: { ...base.tracker, ...raw.tracker },
    git: { ...base.git, ...raw.git },
    baseline: { ...base.baseline, ...raw.baseline },
    metering: { ...base.metering, ...raw.metering },
    pricing: { ...base.pricing, ...raw.pricing },
    budgets: { ...base.budgets, ...raw.budgets },
    notices: { ...base.notices, ...raw.notices },
  };
}

export function saveConfig(home: string, config: Config): void {
  writeFileSync(configPath(home), JSON.stringify(config, null, 2) + "\n", "utf8");
}

export interface Identity {
  schema_version: number;
  git_emails: string[];
  git_names: string[];
  github_login: string | null;
  jira_account_id: string | null;
}

export function identityPath(home: string): string {
  return join(home, "identity.json");
}

export function loadIdentity(home: string): Identity | null {
  const p = identityPath(home);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as Identity;
}

export function saveIdentity(home: string, identity: Identity): void {
  writeFileSync(identityPath(home), JSON.stringify(identity, null, 2) + "\n", "utf8");
}
