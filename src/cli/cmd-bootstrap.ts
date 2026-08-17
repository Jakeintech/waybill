import { loadConfig, loadIdentity } from "../core/config.ts";
import type { UsageEvent } from "../core/events.ts";
import { authoritative, readEvents } from "../core/streams.ts";
import { gitLogRaw, isGitRepo, parseGitLog, summarizeRepo, type RepoSummary } from "../gitlocal/gitlocal.ts";
import { repoFromCwd } from "../meter/run.ts";

const LINE = "────────────────────────────────────────";

function fmtInt(n: number): string {
  return n.toLocaleString("en-US");
}

export interface BootstrapData {
  window_days: number;
  since: string;
  until: string;
  emails: string[];
  repos: RepoSummary[];
  tokens: {
    metered_sessions: number;
    totals: { input: number; output: number; cache_read: number; cache_creation: number };
    by_account: Array<{ account: string; tokens: number }>;
  } | null;
}

export function renderReceipt(d: BootstrapData): string {
  const out: string[] = [];
  out.push("WAYBILL · BOOTSTRAP RECEIPT");
  out.push(LINE);
  out.push(`WINDOW    ${d.since} → ${d.until} (${d.window_days} days)`);
  out.push(`IDENTITY  ${d.emails.join(", ") || "(no git email configured)"}`);
  out.push("");
  if (d.repos.length === 0) {
    out.push("ITEMS");
    out.push("  No local git repos in scope. The ledger doesn't pad.");
    out.push("  (Run from inside a repo, or add repo paths with --repo-path.)");
  }
  for (const r of d.repos) {
    out.push(`REPO      ${r.repo}`);
    out.push("ITEMS");
    out.push(`  COMMITS         ${fmtInt(r.commits).padStart(11)}`);
    out.push(`  MERGES          ${fmtInt(r.merges).padStart(11)}`);
    out.push(`  ACTIVE DAYS     ${fmtInt(r.active_days).padStart(11)}`);
    if (r.first_date !== null) {
      out.push(`  FIRST → LAST    ${r.first_date} → ${r.last_date}`);
    }
    if (r.keys.length > 0) {
      const keys = r.keys.slice(0, 5).map((k) => `${k.key} ×${k.count}`).join(" · ");
      out.push(`  TRACKER KEYS    ${keys}${r.keys.length > 5 ? ` (+${r.keys.length - 5} more)` : ""}`);
    }
    if (r.tags.length > 0) {
      out.push(`  TAGS            ${r.tags.slice(0, 5).join(" · ")}`);
    }
    out.push("");
  }
  const totalCommits = d.repos.reduce((n, r) => n + r.commits, 0);
  out.push(`SUBTOTAL  ${fmtInt(totalCommits)} commit(s) across ${d.repos.length} repo(s)`);
  if (d.tokens === null) {
    out.push("TOKENS    no metered sessions in the window yet —");
    out.push("          the SessionEnd miner fills this automatically as you work");
  } else {
    const t = d.tokens.totals;
    out.push(`TOKENS    ${d.tokens.metered_sessions} metered session(s)`);
    out.push(`  INPUT           ${fmtInt(t.input).padStart(15)}`);
    out.push(`  OUTPUT          ${fmtInt(t.output).padStart(15)}`);
    out.push(`  CACHE READ      ${fmtInt(t.cache_read).padStart(15)}`);
    out.push(`  CACHE WRITE     ${fmtInt(t.cache_creation).padStart(15)}`);
    for (const a of d.tokens.by_account.slice(0, 5)) {
      out.push(`  ${a.account.padEnd(16)}${fmtInt(a.tokens).padStart(15)}`);
    }
  }
  out.push(LINE);
  out.push("EVIDENCE TIER: FACTS (LOCAL GIT LOG · METERED TRANSCRIPTS)");
  out.push("RANGES NOT MIDPOINTS · NOTHING PADDED · UNATTRIBUTED SHOWN");
  return out.join("\n");
}

export function collectTokens(home: string, sinceIso: string): BootstrapData["tokens"] {
  const usage = authoritative(readEvents<UsageEvent>(home, "usage")).filter(
    (u) => u.kind === "usage" && u.ts >= sinceIso,
  );
  if (usage.length === 0) return null;
  const sessions = new Set<string>();
  const totals = { input: 0, output: 0, cache_read: 0, cache_creation: 0 };
  const byAccount = new Map<string, number>();
  for (const u of usage) {
    sessions.add(u.session_id);
    totals.input += u.tokens.input;
    totals.output += u.tokens.output;
    totals.cache_read += u.tokens.cache_read;
    totals.cache_creation += u.tokens.cache_creation;
    const spent = u.tokens.input + u.tokens.output + u.tokens.cache_read + u.tokens.cache_creation;
    byAccount.set(u.attribution.account, (byAccount.get(u.attribution.account) ?? 0) + spent);
  }
  const by_account = [...byAccount.entries()]
    .map(([account, tokens]) => ({ account, tokens }))
    .sort((a, b) => b.tokens - a.tokens || (a.account < b.account ? -1 : 1));
  return { metered_sessions: sessions.size, totals, by_account };
}

export function runBootstrap(home: string, args: string[], json: boolean): number {
  let days = 90;
  let nowIso: string | null = null;
  let fromIso: string | null = null;
  let toIso: string | null = null;
  const repoPaths: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--days") days = Number(args[++i] ?? "90");
    else if (a === "--from") fromIso = args[++i] ?? null;
    else if (a === "--to") toIso = args[++i] ?? null;
    else if (a === "--repo-path") {
      const p = args[++i];
      if (p) repoPaths.push(p);
    } else if (a === "--now") nowIso = args[++i] ?? null;
    else {
      process.stderr.write(`waybill bootstrap: unknown option ${a}\n`);
      return 2;
    }
  }
  if (!Number.isFinite(days) || days <= 0) {
    process.stderr.write("waybill bootstrap: --days must be a positive number\n");
    return 2;
  }

  const config = loadConfig(home);
  const identity = loadIdentity(home);
  const emails = identity?.git_emails ?? [];
  // --from/--to align the receipt with query report windows; --days is the shorthand.
  if ((fromIso && Number.isNaN(Date.parse(fromIso))) || (toIso && Number.isNaN(Date.parse(toIso)))) {
    process.stderr.write("waybill bootstrap: --from/--to must be dates\n");
    return 2;
  }
  const now = toIso ? new Date(toIso) : nowIso ? new Date(nowIso) : new Date();
  const since = fromIso ? new Date(fromIso) : new Date(now.getTime() - days * 86400_000);
  if (fromIso) days = Math.max(1, Math.round((now.getTime() - since.getTime()) / 86400_000));
  const sinceIso = since.toISOString().slice(0, 19) + "Z";

  if (repoPaths.length === 0 && isGitRepo(process.cwd())) repoPaths.push(process.cwd());

  const repos: RepoSummary[] = [];
  for (const path of repoPaths) {
    if (!isGitRepo(path)) {
      process.stderr.write(`waybill bootstrap: not a git repo, skipping: ${path}\n`);
      continue;
    }
    const name = repoFromCwd(path) ?? path;
    const commits = parseGitLog(gitLogRaw(path, sinceIso));
    repos.push(summarizeRepo(name, path, commits, emails, config.metering.branch_key_pattern, config.tracker.project_keys));
  }

  const data: BootstrapData = {
    window_days: days,
    since: sinceIso.slice(0, 10),
    until: now.toISOString().slice(0, 10),
    emails,
    repos,
    tokens: collectTokens(home, sinceIso),
  };

  if (json) {
    process.stdout.write(JSON.stringify(data, null, 2) + "\n");
  } else {
    process.stdout.write(renderReceipt(data) + "\n");
  }
  return 0;
}
