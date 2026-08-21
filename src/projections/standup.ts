import type { Config } from "../core/config.ts";
import type {
  ClaudeRole,
  ExceptionEvent,
  LedgerEntry,
  PinEntry,
  SessionEvent,
  TokenCounts,
  UsageEvent,
} from "../core/events.ts";
import { authoritative } from "../core/streams.ts";
import { countOpenAmbiguities, effectiveShipped, normalizeWindow, type Window } from "./queries.ts";

/**
 * The standup digest: "what did I do yesterday", answered from the ledger
 * instead of memory. Facts only — shipped items, metered work-in-progress,
 * newly opened entries, session/token totals — every line traceable to an
 * event in the streams. The same projection serves daily standups (a
 * one-day window), Monday standups (Fri→Sun), and weekly digests (7 days):
 * the window is the only variable.
 */
export interface StandupData {
  window: { from: string; to: string; label: string | null };
  shipped: Array<{
    tracker_key: string | null;
    title: string;
    points: number | null;
    prs: string[];
    deploy: string | null;
    ts: string;
    claude_role: ClaudeRole;
    escrowed: boolean;
  }>;
  /** Accounts with metered spend in the window that did not ship in it —
   * work in progress, by the tokens it actually consumed. */
  progressed: Array<{
    account: string;
    title: string | null;
    tokens: number;
    sessions: number;
    last_ts: string;
  }>;
  opened: Array<{
    tracker_key: string | null;
    title: string;
    ts: string;
    pre_registered: boolean;
  }>;
  sessions: {
    count: number;
    repos: string[];
    branches: string[];
    turns: number;
  };
  tokens: {
    total: number;
    totals: TokenCounts;
    cost_usd: number | null;
    pricing_version: string | null;
    /** Models whose windowed events carry no cost — rates missing at meter
     * time. Surfaced so "costs appear from day one" stays an honest claim. */
    unpriced_models: string[];
    unpriced_tokens: number;
  };
  waste: { retried_commands: number; repeated_reads: number };
  attention: { inbox_open: number; unattributed_tokens: number; unattributed_pct: number };
}

function inWindow(ts: string, w: Window): boolean {
  if (w.from !== null && ts < w.from) return false;
  if (w.to !== null && ts > w.to) return false;
  return true;
}

function totalTokens(t: TokenCounts): number {
  return t.input + t.output + t.cache_read + t.cache_creation;
}

export function standupData(
  ledgerEvents: Array<LedgerEntry | PinEntry>,
  usageEvents: UsageEvent[],
  sessionEvents: SessionEvent[],
  exceptionEvents: ExceptionEvent[],
  config: Config,
  window: Window,
  label: string | null = null,
): StandupData {
  const usage = authoritative(usageEvents).filter(
    (u) => u.kind === "usage" && inWindow(u.ts, window) && totalTokens(u.tokens) > 0,
  );

  // Shipped in the window (supersession-aware; windowed on ship time).
  const shippedViews = effectiveShipped(ledgerEvents).filter((s) => inWindow(s.shipped_ts, window));
  const shipped = shippedViews
    .map(({ entry: e, shipped_ts }) => ({
      tracker_key: e.tracker_key,
      title: e.title,
      points: e.points,
      prs: e.artifacts.prs,
      deploy: e.artifacts.deploy,
      ts: shipped_ts,
      claude_role: e.claude_role,
      escrowed: e.escrow !== null,
    }))
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const shippedKeys = new Set(shipped.map((s) => s.tracker_key).filter((k) => k !== null));

  // Titles for spend accounts, from the latest authoritative entry per key.
  const authEntries = authoritative(ledgerEvents).filter(
    (e): e is LedgerEntry => e.kind !== "pin",
  );
  const titleByKey = new Map<string, string>();
  for (const e of authEntries) {
    if (e.tracker_key !== null) titleByKey.set(e.tracker_key, e.title);
  }

  // Windowed spend per account, with per-account session counts and last
  // activity — computed here (not via spendData) because standup also needs
  // last_ts and the unpriced-model roll-up from the same pass.
  const byAccount = new Map<string, { tokens: number; sessions: Set<string>; last_ts: string }>();
  const totals: TokenCounts = { input: 0, output: 0, cache_read: 0, cache_creation: 0 };
  let cost: number | null = null;
  const unpriced = new Map<string, number>();
  const waste = { retried_commands: 0, repeated_reads: 0 };
  for (const u of usage) {
    totals.input += u.tokens.input;
    totals.output += u.tokens.output;
    totals.cache_read += u.tokens.cache_read;
    totals.cache_creation += u.tokens.cache_creation;
    if (u.cost_usd) cost = Math.round(((cost ?? 0) + u.cost_usd.value) * 10000) / 10000;
    else unpriced.set(u.model, (unpriced.get(u.model) ?? 0) + totalTokens(u.tokens));
    if (u.waste) {
      waste.retried_commands += u.waste.retried_commands;
      waste.repeated_reads += u.waste.repeated_reads;
    }
    const acc = byAccount.get(u.attribution.account) ?? {
      tokens: 0,
      sessions: new Set<string>(),
      last_ts: u.ts,
    };
    acc.tokens += totalTokens(u.tokens);
    acc.sessions.add(u.session_id);
    if (u.ts > acc.last_ts) acc.last_ts = u.ts;
    byAccount.set(u.attribution.account, acc);
  }

  const progressed = [...byAccount.entries()]
    .filter(([account]) => {
      if (account === "unattributed") return false;
      const key = account.startsWith("story:") ? account.slice(6) : null;
      return key === null || !shippedKeys.has(key);
    })
    .map(([account, a]) => ({
      account,
      title: account.startsWith("story:") ? (titleByKey.get(account.slice(6)) ?? null) : null,
      tokens: a.tokens,
      sessions: a.sessions.size,
      last_ts: a.last_ts,
    }))
    .sort((a, b) => b.tokens - a.tokens || (a.account < b.account ? -1 : 1));

  // Entries opened in the window (chain origin = the opened event itself).
  const opened = authoritative(ledgerEvents)
    .filter((e): e is LedgerEntry => e.kind === "opened" && inWindow(e.ts, window))
    .map((e) => ({
      tracker_key: e.tracker_key,
      title: e.title,
      ts: e.ts,
      pre_registered: e.estimate_without_claude_hours?.pre_registered === true,
    }))
    .sort((a, b) => (a.ts < b.ts ? -1 : 1));

  // Sessions that overlap the window (a session spanning midnight counts
  // toward the day it ran into, not only the day it ended).
  const receipts = authoritative(sessionEvents).filter((s) => {
    if (s.kind !== "session") return false;
    if (window.from !== null && s.last_ts < window.from) return false;
    if (window.to !== null && s.first_ts > window.to) return false;
    return true;
  });
  const repos: string[] = [];
  const branches: string[] = [];
  let turns = 0;
  for (const s of receipts) {
    if (s.repo !== null && !repos.includes(s.repo)) repos.push(s.repo);
    for (const b of s.branches) if (!branches.includes(b)) branches.push(b);
    turns += s.turns;
  }
  repos.sort();
  branches.sort();

  const total = totalTokens(totals);
  const unattributed = byAccount.get("unattributed")?.tokens ?? 0;
  const unpricedTokens = [...unpriced.values()].reduce((n, t) => n + t, 0);

  return {
    window: { from: window.from ?? "", to: window.to ?? "", label },
    shipped,
    progressed,
    opened,
    sessions: { count: receipts.length, repos, branches, turns },
    tokens: {
      total,
      totals,
      cost_usd: cost,
      pricing_version: config.pricing.version,
      unpriced_models: [...unpriced.keys()].sort(),
      unpriced_tokens: unpricedTokens,
    },
    waste,
    attention: {
      inbox_open: countOpenAmbiguities(exceptionEvents),
      unattributed_tokens: unattributed,
      unattributed_pct: total > 0 ? Math.round((unattributed / total) * 1000) / 10 : 0,
    },
  };
}

/** Local-calendar day bounds for `base` shifted by `offsetDays`, as ISO
 * instants. "Yesterday" means the user's yesterday, not UTC's. */
export function localDayWindow(base: Date, offsetDays: number): { from: string; to: string } {
  const start = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offsetDays, 0, 0, 0, 0);
  const end = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offsetDays + 1, 0, 0, 0, 0);
  return {
    from: start.toISOString(),
    to: new Date(end.getTime() - 1).toISOString(),
  };
}

export interface StandupWindowArgs {
  date: string | null;
  days: number | null;
  from: string | null;
  to: string | null;
}

/**
 * Resolve the digest window. Precedence: explicit --from/--to, then --days,
 * then --date (default: yesterday). All day math is in the local calendar;
 * `now` is injectable (--now) so resolution stays testable and
 * deterministic.
 */
export function resolveStandupWindow(
  args: StandupWindowArgs,
  now: Date,
): { window: Window; label: string | null } {
  if (args.from !== null || args.to !== null) {
    return { window: normalizeWindow(args.from, args.to), label: null };
  }
  if (args.days !== null) {
    if (!Number.isFinite(args.days) || args.days <= 0 || !Number.isInteger(args.days)) {
      throw new Error("--days must be a positive integer");
    }
    const first = localDayWindow(now, -(args.days - 1));
    const last = localDayWindow(now, 0);
    return {
      window: { from: first.from, to: last.to },
      label: `last ${args.days} day(s)`,
    };
  }
  const date = args.date ?? "yesterday";
  if (date === "yesterday" || date === "today") {
    const w = localDayWindow(now, date === "yesterday" ? -1 : 0);
    return { window: w, label: date };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`--date must be yesterday, today, or YYYY-MM-DD (got: ${date})`);
  }
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const w = localDayWindow(new Date(y, m - 1, d), 0);
  return { window: w, label: date };
}
