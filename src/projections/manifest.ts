import type { Config } from "../core/config.ts";
import type { LedgerEntry, PinEntry, TokenCounts, UsageEvent } from "../core/events.ts";
import { authoritative } from "../core/streams.ts";
import { effectiveShipped } from "./queries.ts";

/**
 * What's still on the truck: open work with its open spend and its age.
 * Demurrage is the honest nudge derived from it — an item that has
 * consumed tokens but shown no metered activity for
 * `budgets.demurrage_days` is "sitting", worth one factual line in
 * status, never a nag. Pure; `now` is injectable at the CLI edge.
 */
export interface ManifestItem {
  tracker_key: string | null;
  title: string;
  work_type: string;
  opened_ts: string;
  age_days: number;
  /** All-time metered spend on the item's account (open-spend semantics). */
  tokens: number;
  last_activity: string | null;
  idle_days: number | null;
  sitting: boolean;
}

export interface ManifestData {
  now: string;
  demurrage_days: number;
  open_items: ManifestItem[];
  open_tokens: number;
  sitting: number;
}

function totalTokens(t: TokenCounts): number {
  return t.input + t.output + t.cache_read + t.cache_creation;
}

function wholeDays(fromTs: string, toTs: string): number {
  const d = (Date.parse(toTs) - Date.parse(fromTs)) / 86400_000;
  return Number.isFinite(d) ? Math.max(0, Math.floor(d)) : 0;
}

export function manifestData(
  ledgerEvents: Array<LedgerEntry | PinEntry>,
  usageEvents: UsageEvent[],
  config: Config,
  nowIso: string,
): ManifestData {
  const shipChained = new Set(effectiveShipped(ledgerEvents).map((v) => v.entry.id));
  const byId = new Map<string, LedgerEntry | PinEntry>(ledgerEvents.map((e) => [e.id, e]));

  // Spend and last activity per story account, all-time.
  const spendByKey = new Map<string, { tokens: number; last: string }>();
  for (const u of authoritative(usageEvents)) {
    if (u.kind !== "usage") continue;
    const account = u.attribution.account;
    if (!account.startsWith("story:")) continue;
    const key = account.slice(6);
    const cur = spendByKey.get(key) ?? { tokens: 0, last: u.ts };
    cur.tokens += totalTokens(u.tokens);
    if (u.ts > cur.last) cur.last = u.ts;
    spendByKey.set(key, cur);
  }

  const demurrageDays = config.budgets.demurrage_days;
  const openItems: ManifestItem[] = [];
  for (const head of authoritative(ledgerEvents)) {
    if (head.kind === "pin" || shipChained.has(head.id)) continue;
    const entry = head as LedgerEntry;
    // Chain origin: the day the work was actually started.
    let cur: LedgerEntry | PinEntry | undefined = entry;
    const seen = new Set<string>();
    let openedTs = entry.ts;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      openedTs = cur.ts;
      cur = cur.supersedes !== null ? byId.get(cur.supersedes) : undefined;
    }
    const spend = entry.tracker_key !== null ? spendByKey.get(entry.tracker_key) : undefined;
    const lastActivity = spend?.last ?? null;
    const idleDays = lastActivity !== null ? wholeDays(lastActivity, nowIso) : null;
    openItems.push({
      tracker_key: entry.tracker_key,
      title: entry.title,
      work_type: entry.work_type,
      opened_ts: openedTs,
      age_days: wholeDays(openedTs, nowIso),
      tokens: spend?.tokens ?? 0,
      last_activity: lastActivity,
      idle_days: idleDays,
      sitting: (spend?.tokens ?? 0) > 0 && idleDays !== null && idleDays >= demurrageDays,
    });
  }
  openItems.sort((a, b) => b.tokens - a.tokens || (a.opened_ts < b.opened_ts ? -1 : 1));

  return {
    now: nowIso,
    demurrage_days: demurrageDays,
    open_items: openItems,
    open_tokens: openItems.reduce((n, i) => n + i.tokens, 0),
    sitting: openItems.filter((i) => i.sitting).length,
  };
}
