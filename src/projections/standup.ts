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
import { rootSessionId } from "../core/events.ts";
import { inWindow as isInWindow } from "../core/time.ts";
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
   * work in progress, by the tokens it actually consumed. Rows with
   * `shipped_earlier: true` are follow-up spend on an item that already
   * shipped before the window (rework, hotfixes) — worked on, but not
   * "in progress" in the open-spend sense. */
  progressed: Array<{
    account: string;
    title: string | null;
    tokens: number;
    sessions: number;
    last_ts: string;
    shipped_earlier: boolean;
  }>;
  opened: Array<{
    tracker_key: string | null;
    title: string;
    ts: string;
    pre_registered: boolean;
  }>;
  /** Named session_summary, not `sessions`: redaction strips `sessions`
   * keys as machine-local detail (LedgerEntry.sessions carries transcript
   * paths); this roll-up must survive the internal audience. */
  session_summary: {
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
  return isInWindow(ts, w.from, w.to);
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
    // "unknown" carried no model id at all — its tokens count as unpriced,
    // but it is not a *model* a rate could fix, so it stays out of the
    // named list (consistent with status/pricing show).
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
    acc.sessions.add(rootSessionId(u.session_id)); // subagents count with their session
    if (u.ts > acc.last_ts) acc.last_ts = u.ts;
    byAccount.set(u.attribution.account, acc);
  }

  const allShippedKeys = new Set(
    effectiveShipped(ledgerEvents)
      .map((s) => s.entry.tracker_key)
      .filter((k): k is string => k !== null),
  );
  const progressed = [...byAccount.entries()]
    .filter(([account]) => {
      if (account === "unattributed") return false;
      const key = account.startsWith("story:") ? account.slice(6) : null;
      return key === null || !shippedKeys.has(key);
    })
    .map(([account, a]) => {
      const key = account.startsWith("story:") ? account.slice(6) : null;
      return {
        account,
        title: key !== null ? (titleByKey.get(key) ?? null) : null,
        tokens: a.tokens,
        sessions: a.sessions.size,
        last_ts: a.last_ts,
        shipped_earlier: key !== null && allShippedKeys.has(key),
      };
    })
    .sort((a, b) => b.tokens - a.tokens || (a.account < b.account ? -1 : 1));

  // Entries opened in the window — chain-aware: once an item ships or a
  // sync correction supersedes its `opened` event, the head is no longer
  // kind "opened", but the day it was STARTED does not change. Walk each
  // authoritative head to its chain-origin `opened` event, window on that
  // ts, and report the head's (corrected) fields.
  const byId = new Map<string, LedgerEntry | PinEntry>(ledgerEvents.map((e) => [e.id, e]));
  const opened = authoritative(ledgerEvents)
    .filter((e): e is LedgerEntry => e.kind !== "pin")
    .map((head) => {
      let cur: LedgerEntry | PinEntry | undefined = head;
      const seen = new Set<string>();
      while (cur && !seen.has(cur.id)) {
        seen.add(cur.id);
        if (cur.kind === "opened") return { head, opened_ts: cur.ts };
        cur = cur.supersedes !== null ? byId.get(cur.supersedes) : undefined;
      }
      return null;
    })
    .filter((v): v is { head: LedgerEntry; opened_ts: string } => v !== null && inWindow(v.opened_ts, window))
    .map(({ head, opened_ts }) => ({
      tracker_key: head.tracker_key,
      title: head.title,
      ts: opened_ts,
      pre_registered: head.estimate_without_claude_hours?.pre_registered === true,
    }))
    .sort((a, b) => (a.ts < b.ts ? -1 : 1));

  // Sessions that overlap the window (a session spanning midnight counts
  // toward the day it ran into, not only the day it ended). Overlap =
  // the session ends at-or-after the window start AND starts at-or-before
  // the window end — instant comparisons, same as inWindow.
  const receipts = authoritative(sessionEvents).filter((s) => {
    if (s.kind !== "session") return false;
    return (
      (window.from === null || inWindow(s.last_ts, { from: window.from, to: null })) &&
      (window.to === null || inWindow(s.first_ts, { from: null, to: window.to }))
    );
  });
  const repos: string[] = [];
  const branches: string[] = [];
  let turns = 0;
  let rootCount = 0;
  for (const s of receipts) {
    if (s.repo !== null && !repos.includes(s.repo)) repos.push(s.repo);
    for (const b of s.branches) if (!branches.includes(b)) branches.push(b);
    // Session and turn counts mean what the user did: subagent-transcript
    // receipts (composite ids) contribute repos/branches but neither a
    // session of their own nor phantom turns (they hold no user prompts).
    if (rootSessionId(s.session_id) === s.session_id) {
      rootCount += 1;
      turns += s.turns;
    }
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
    session_summary: { count: rootCount, repos, branches, turns },
    tokens: {
      total,
      totals,
      cost_usd: cost,
      pricing_version: config.pricing.version,
      unpriced_models: [...unpriced.keys()].filter((m) => m !== "unknown").sort(),
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
  const base = new Date(y, m - 1, d);
  // Round-trip check: the Date constructor rolls impossible dates over
  // (2026-02-30 → March 2), which would silently label the wrong day.
  if (base.getFullYear() !== y || base.getMonth() !== m - 1 || base.getDate() !== d) {
    throw new Error(`--date is not a real calendar date: ${date}`);
  }
  const w = localDayWindow(base, 0);
  return { window: w, label: date };
}
