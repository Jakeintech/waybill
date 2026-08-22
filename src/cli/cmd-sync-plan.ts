import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { defaultContext, sortChanges } from "../adapters/contract.ts";
import { jiraAdapter } from "../adapters/jira.ts";
import { linearAdapter } from "../adapters/linear.ts";
import { githubAdapter } from "../adapters/github.ts";
import { githubIssuesAdapter } from "../adapters/github-issues.ts";
import { gitLocalAdapter } from "../adapters/gitlocal-adapter.ts";
import { gitlabAdapter } from "../adapters/gitlab.ts";
import { azureDevOpsAdapter } from "../adapters/azure-devops.ts";
import { bitbucketAdapter } from "../adapters/bitbucket.ts";
import { loadConfig, loadIdentity, saveConfig } from "../core/config.ts";
import { finalizeEvent, type Envelope, type LedgerEntry, type PinEntry } from "../core/events.ts";
import { appendEvents, readEvents } from "../core/streams.ts";
import { gitLogRaw, isGitRepo } from "../gitlocal/gitlocal.ts";
import { repoFromCwd } from "../meter/run.ts";
import { reconcile, type EntryBody, type SyncPlan } from "../sync/reconcile.ts";
import type { MergedChange, WorkItem } from "../adapters/contract.ts";

const TRACKERS = {
  jira: jiraAdapter,
  linear: linearAdapter,
  "github-issues": githubIssuesAdapter,
  "azure-devops": azureDevOpsAdapter,
} as const;
const GIT_HOSTS = {
  github: githubAdapter,
  gitlab: gitlabAdapter,
  bitbucket: bitbucketAdapter,
  local: gitLocalAdapter,
} as const;

export function runSyncPlan(home: string, args: string[]): number {
  let tracker: keyof typeof TRACKERS | null = null;
  let gitHost: keyof typeof GIT_HOSTS | null = null;
  let itemsPath: string | null = null;
  let changesPath: string | null = null;
  let applyPath: string | null = null;
  let baseline = false;
  let since: string | null = null;
  const localRepos: string[] = [];
  let now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--tracker") tracker = (args[++i] ?? null) as keyof typeof TRACKERS | null;
    else if (a === "--git") gitHost = (args[++i] ?? null) as keyof typeof GIT_HOSTS | null;
    else if (a === "--items") itemsPath = args[++i] ?? null;
    else if (a === "--changes") changesPath = args[++i] ?? null;
    else if (a === "--local-repo") {
      const p = args[++i];
      if (p) localRepos.push(p);
    } else if (a === "--since") since = args[++i] ?? null;
    else if (a === "--apply") applyPath = args[++i] ?? null;
    else if (a === "--baseline") baseline = true;
    else if (a === "--now") now = args[++i] ?? now;
    else {
      process.stderr.write(`waybill sync-plan: unknown option ${a}\n`);
      return 2;
    }
  }

  const config = loadConfig(home);

  if (applyPath) {
    const plan = JSON.parse(readFileSync(applyPath, "utf8")) as SyncPlan;
    const bodies: EntryBody[] = [
      ...plan.shipped,
      ...plan.corrections.map((c) => c.body),
      ...plan.orphans,
    ];
    const existing = new Set(readEvents(home, "ledger").map((e) => e.id));
    const events: LedgerEntry[] = [];
    for (const body of bodies) {
      const event = finalizeEvent("ledger", body as EntryBody & Omit<Envelope, "id">) as LedgerEntry;
      // Dedupe within the batch too: a payload carrying the same issue
      // twice must not append two identical-id events to an append-only
      // stream (verify would flag the duplicate forever).
      if (existing.has(event.id)) continue;
      existing.add(event.id);
      events.push(event);
    }
    appendEvents(home, "ledger", events);
    if (plan.baseline) {
      config.baseline = {
        velocity_points_per_sprint: plan.baseline.velocity_points_per_sprint,
        median_cycle_time_days: plan.baseline.median_cycle_time_days,
        window: plan.baseline.window,
        derived_from: plan.baseline.derived_from,
      };
    }
    config.last_sync = plan.generated_at;
    saveConfig(home, config);
    try {
      execFileSync("git", ["-C", home, "add", "-A"], { stdio: ["ignore", "ignore", "ignore"], timeout: 15000 });
      execFileSync("git", ["-C", home, "commit", "-m", `sync: ${events.length} entr${events.length === 1 ? "y" : "ies"} applied`], {
        stdio: ["ignore", "ignore", "ignore"],
        timeout: 15000,
      });
    } catch {
      // nothing to commit / contention — fine
    }
    process.stdout.write(JSON.stringify({ applied: events.length, last_sync: plan.generated_at }) + "\n");
    return 0;
  }

  const identity = loadIdentity(home);
  const ctx = defaultContext({
    keyPattern: config.metering.branch_key_pattern,
    identityEmails: identity?.git_emails ?? [],
    githubLogin: identity?.github_login ?? null,
    jiraAccountId: identity?.jira_account_id ?? null,
    gitlabUsername: identity?.gitlab_username ?? null,
    linearUserId: identity?.linear_user_id ?? null,
    bitbucketUsername: identity?.bitbucket_username ?? null,
    projectKeys: config.tracker.project_keys,
  });

  let items: WorkItem[] = [];
  if (itemsPath) {
    if (!tracker || !(tracker in TRACKERS)) {
      process.stderr.write(`waybill sync-plan: --items needs --tracker <${Object.keys(TRACKERS).join("|")}>\n`);
      return 2;
    }
    items = TRACKERS[tracker].normalizeItems(JSON.parse(readFileSync(itemsPath, "utf8")), ctx);
  }
  let changes: MergedChange[] = [];
  if (changesPath) {
    if (!gitHost || !(gitHost in GIT_HOSTS)) {
      process.stderr.write(`waybill sync-plan: --changes needs --git <${Object.keys(GIT_HOSTS).join("|")}>\n`);
      return 2;
    }
    changes = GIT_HOSTS[gitHost].normalizeChanges(JSON.parse(readFileSync(changesPath, "utf8")), ctx);
  }
  // The zero-auth floor, self-contained: read local git history directly.
  if (localRepos.length > 0) {
    const sinceIso = since ?? config.last_sync ?? new Date(Date.parse(now) - 90 * 86400_000).toISOString().slice(0, 19) + "Z";
    for (const path of localRepos) {
      if (!isGitRepo(path)) {
        process.stderr.write(`waybill sync-plan: not a git repo, skipping: ${path}\n`);
        continue;
      }
      const name = repoFromCwd(path) ?? path;
      changes.push(
        ...gitLocalAdapter.normalizeChanges({ repo: name, log: gitLogRaw(path, sinceIso) }, ctx),
      );
    }
    changes = sortChanges(changes);
  }
  if (!itemsPath && !changesPath && localRepos.length === 0) {
    process.stderr.write(
      "waybill sync-plan: pass --items, --changes, or --local-repo (or --apply <plan.json>)\n",
    );
    return 2;
  }

  const ledgerEvents = readEvents<LedgerEntry | PinEntry>(home, "ledger");
  const plan = reconcile(items, changes, ledgerEvents, now, {
    ...(baseline ? { baselineWindow: `until ${now.slice(0, 10)}` } : {}),
  });
  process.stdout.write(JSON.stringify(plan, null, 2) + "\n");
  return 0;
}
