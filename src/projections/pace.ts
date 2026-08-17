import type { Config } from "../core/config.ts";
import type { ExceptionEvent, LedgerEntry, PinEntry, UsageEvent } from "../core/events.ts";
import { authoritative } from "../core/streams.ts";
import { effectiveShipped, spendData } from "./queries.ts";

export interface PaceData {
  allocation: { period: string; tokens_granted: number; granted_at: string } | null;
  window: { from: string; to: string } | null;
  spent_tokens: number;
  spent_pct: number | null;
  elapsed_pct: number | null;
  /** Work-weighted pace: points shipped vs points committed in the window. */
  committed_points: number | null;
  shipped_points: number | null;
  shipped_pct_of_committed: number | null;
  epics: Array<{ epic_key: string; budget_tokens: number; spent_tokens: number; spent_pct: number }>;
  thresholds_crossed: number[];
  biggest_open_spend: { account: string; tokens: number } | null;
  /** Whole days until the allocation period ends (negative = past). */
  days_to_renewal: number | null;
}

/** Allocation period → window. "2026-Q3" and "2026-08" parse exactly;
 * anything else falls back to granted_at + 90 days. */
export function periodWindow(period: string, grantedAt: string): { from: string; to: string } {
  const q = /^(\d{4})-Q([1-4])$/.exec(period);
  if (q) {
    const year = Number(q[1]);
    const startMonth = (Number(q[2]) - 1) * 3; // 0-based
    const from = new Date(Date.UTC(year, startMonth, 1));
    const to = new Date(Date.UTC(year, startMonth + 3, 1) - 1000);
    return { from: from.toISOString().slice(0, 19) + "Z", to: to.toISOString().slice(0, 19) + "Z" };
  }
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  if (m) {
    const from = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1));
    const to = new Date(Date.UTC(Number(m[1]), Number(m[2]), 1) - 1000);
    return { from: from.toISOString().slice(0, 19) + "Z", to: to.toISOString().slice(0, 19) + "Z" };
  }
  const from = Date.parse(grantedAt);
  return {
    from: new Date(from).toISOString().slice(0, 19) + "Z",
    to: new Date(from + 90 * 86400_000).toISOString().slice(0, 19) + "Z",
  };
}

const THRESHOLDS = [80, 100];

export function paceData(
  ledgerEvents: Array<LedgerEntry | PinEntry>,
  usageEvents: UsageEvent[],
  exceptionEvents: ExceptionEvent[],
  config: Config,
  nowIso: string,
): PaceData {
  const allocation = config.allocations[config.allocations.length - 1] ?? null;
  if (!allocation) {
    return {
      allocation: null, window: null, spent_tokens: 0, spent_pct: null, elapsed_pct: null,
      committed_points: null, shipped_points: null, shipped_pct_of_committed: null,
      epics: [], thresholds_crossed: [], biggest_open_spend: null,
      days_to_renewal: null,
    };
  }
  const window = periodWindow(allocation.period, allocation.granted_at);
  const spend = spendData(usageEvents, exceptionEvents, ledgerEvents, config, window);
  const spentPct =
    allocation.tokens_granted > 0
      ? Math.round((spend.total_tokens / allocation.tokens_granted) * 1000) / 10
      : null;
  const total = Date.parse(window.to) - Date.parse(window.from);
  const elapsed = Math.min(Math.max(Date.parse(nowIso) - Date.parse(window.from), 0), total);
  const elapsedPct = total > 0 ? Math.round((elapsed / total) * 1000) / 10 : null;

  // Work-weighted pace: entries with points whose lifecycle touches the window.
  const auth = authoritative(ledgerEvents).filter(
    (e): e is LedgerEntry => e.kind !== "pin",
  );
  const inWindowEntries = auth.filter(
    (e) => e.points !== null && e.ts >= window.from && e.ts <= window.to,
  );
  const committed = inWindowEntries.reduce((n, e) => n + (e.points ?? 0), 0);
  const shippedViews = effectiveShipped(ledgerEvents).filter(
    (s) => s.shipped_ts >= window.from && s.shipped_ts <= window.to,
  );
  const shippedPts = shippedViews.reduce((n, s) => n + (s.entry.points ?? 0), 0);

  // Per-epic envelopes: spend joined to epics via each story's ledger entry.
  const epicByKey = new Map<string, string>();
  for (const e of auth) {
    if (e.tracker_key !== null && e.epic_key !== null) epicByKey.set(e.tracker_key, e.epic_key);
  }
  const spentByEpic = new Map<string, number>();
  for (const a of spend.accounts) {
    if (!a.account.startsWith("story:")) continue;
    const epic = epicByKey.get(a.account.slice(6));
    if (epic) spentByEpic.set(epic, (spentByEpic.get(epic) ?? 0) + a.tokens);
  }
  const epics = Object.entries(config.budgets.epics)
    .map(([epic_key, budget_tokens]) => {
      const spent = spentByEpic.get(epic_key) ?? 0;
      return {
        epic_key,
        budget_tokens,
        spent_tokens: spent,
        spent_pct: budget_tokens > 0 ? Math.round((spent / budget_tokens) * 1000) / 10 : 0,
      };
    })
    .sort((a, b) => b.spent_pct - a.spent_pct);

  return {
    allocation,
    window,
    spent_tokens: spend.total_tokens,
    spent_pct: spentPct,
    elapsed_pct: elapsedPct,
    committed_points: committed > 0 ? committed : null,
    shipped_points: committed > 0 ? shippedPts : null,
    shipped_pct_of_committed:
      committed > 0 ? Math.round((shippedPts / committed) * 1000) / 10 : null,
    epics,
    thresholds_crossed: THRESHOLDS.filter((t) => spentPct !== null && spentPct >= t),
    biggest_open_spend: spend.open_spend[0] ?? null,
    days_to_renewal: Math.floor((Date.parse(window.to) - Date.parse(nowIso)) / 86400_000),
  };
}

export function renderPace(p: PaceData): string {
  if (!p.allocation || !p.window) {
    return "No allocation configured — add one to config.json allocations to track pacing.";
  }
  const lines: string[] = [];
  const granted = p.allocation.tokens_granted.toLocaleString("en-US");
  const spent = p.spent_tokens.toLocaleString("en-US");
  lines.push(
    `${p.allocation.period}: ${spent} of ${granted} tokens spent` +
      (p.spent_pct !== null ? ` (${p.spent_pct}%)` : "") +
      (p.elapsed_pct !== null ? `, ${p.elapsed_pct}% of the period elapsed` : ""),
  );
  if (p.shipped_pct_of_committed !== null) {
    lines.push(
      `Work-weighted: ${p.shipped_points} of ${p.committed_points} committed points shipped ` +
        `(${p.shipped_pct_of_committed}%).` +
        (p.spent_pct !== null && p.spent_pct > p.shipped_pct_of_committed
          ? " Worth a look, not an alarm."
          : ""),
    );
  }
  for (const e of p.epics) {
    lines.push(
      `Epic ${e.epic_key}: ${e.spent_tokens.toLocaleString("en-US")} of ` +
        `${e.budget_tokens.toLocaleString("en-US")} envelope (${e.spent_pct}%)`,
    );
  }
  if (p.biggest_open_spend) {
    lines.push(
      `Biggest open spend: ${p.biggest_open_spend.account} at ` +
        `${p.biggest_open_spend.tokens.toLocaleString("en-US")} tokens (not yet shipped)`,
    );
  }
  return lines.join("\n");
}
