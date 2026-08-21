import type { Config } from "../core/config.ts";
import type {
  AmbiguityEvent,
  ExceptionEvent,
  LedgerEntry,
  PinEntry,
  ResolutionEvent,
  UsageEvent,
} from "../core/events.ts";
import { authoritative } from "../core/streams.ts";

export interface Window {
  from: string | null;
  to: string | null;
}

/**
 * Normalize user-supplied bounds: a bare date means the whole day (a
 * date-only `to` is inclusive of that day, not a midnight cutoff), and
 * unparseable bounds are an error rather than a silently empty window.
 */
export function normalizeWindow(from: string | null, to: string | null): Window {
  const check = (v: string | null, name: string): string | null => {
    if (v === null) return null;
    if (Number.isNaN(Date.parse(v))) {
      throw new Error(`--${name} is not a date: ${v}`);
    }
    return v;
  };
  const f = check(from, "from");
  let t = check(to, "to");
  if (t !== null && /^\d{4}-\d{2}-\d{2}$/.test(t)) t = `${t}T23:59:59.999Z`;
  return { from: f, to: t };
}

function inWindow(ts: string, w: Window): boolean {
  if (w.from !== null && ts < w.from) return false;
  if (w.to !== null && ts > w.to) return false;
  return true;
}

function totalTokens(u: UsageEvent): number {
  return u.tokens.input + u.tokens.output + u.tokens.cache_read + u.tokens.cache_creation;
}

export interface ShippedView {
  /** The authoritative event for the item — possibly a correction. */
  entry: LedgerEntry;
  /** When the item actually shipped: the ts of the chain's shipped event. */
  shipped_ts: string;
}

/**
 * Shipped items, supersession-aware: a correction that supersedes a shipped
 * entry keeps the item shipped (with the corrected fields) instead of
 * making it vanish from reports. Window filtering uses the ship time, not
 * the correction time.
 */
export function effectiveShipped(events: Array<LedgerEntry | PinEntry>): ShippedView[] {
  const byId = new Map<string, LedgerEntry | PinEntry>(events.map((e) => [e.id, e]));
  const out: ShippedView[] = [];
  for (const e of authoritative(events)) {
    if (e.kind !== "shipped" && e.kind !== "correction") continue;
    let cur: LedgerEntry | PinEntry | undefined = e;
    const seen = new Set<string>();
    let shippedTs: string | null = null;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      if (cur.kind === "shipped") {
        shippedTs = cur.ts;
        break;
      }
      cur = cur.supersedes !== null ? byId.get(cur.supersedes) : undefined;
    }
    if (shippedTs !== null) out.push({ entry: e as LedgerEntry, shipped_ts: shippedTs });
  }
  return out;
}

export interface AccountSpend {
  account: string;
  tokens: number;
  input: number;
  output: number;
  cache_read: number;
  cache_creation: number;
  cost_usd: number | null;
  min_confidence: number;
  resolvers: string[];
  sessions: number;
  /** Deterministic waste diagnostics rolled up per account (counts only). */
  waste: { retried_commands: number; repeated_reads: number };
}

export interface SpendData {
  window: Window;
  accounts: AccountSpend[];
  by_model: Array<{ model: string; tokens: number; cost_usd: number | null }>;
  by_week: Array<{ week: string; tokens: number }>;
  total_tokens: number;
  unattributed_tokens: number;
  unattributed_pct: number;
  open_spend: Array<{ account: string; tokens: number }>;
  attribution_health: {
    attributed_pct_conf_060: number;
    inbox_open: number;
  };
  pricing_version: string | null;
  /** How much of the window's tokens the USD figures actually cover — a
   * dollar total that silently omits unpriced events is not a receipt. */
  pricing_coverage: {
    priced_tokens: number;
    unpriced_tokens: number;
    priced_pct: number;
    unpriced_models: string[];
  };
}

function isoWeek(ts: string): string {
  const d = new Date(Date.parse(ts));
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const ftDay = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - ftDay + 3);
  const week = 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 86400_000));
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function spendData(
  usageEvents: UsageEvent[],
  exceptionEvents: ExceptionEvent[],
  ledgerEvents: Array<LedgerEntry | PinEntry>,
  config: Config,
  window: Window,
): SpendData {
  const usage = authoritative(usageEvents).filter(
    (u) => u.kind === "usage" && inWindow(u.ts, window) && totalTokens(u) > 0,
  );
  const accounts = new Map<string, AccountSpend>();
  const models = new Map<string, { tokens: number; cost: number; priced: boolean }>();
  const weeks = new Map<string, number>();
  const accountSessions = new Map<string, Set<string>>();
  let total = 0;
  let pricedTokens = 0;
  const unpricedByModel = new Set<string>();

  for (const u of usage) {
    const t = totalTokens(u);
    total += t;
    if (u.cost_usd) pricedTokens += t;
    else unpricedByModel.add(u.model);
    const acc = accounts.get(u.attribution.account) ?? {
      account: u.attribution.account,
      tokens: 0, input: 0, output: 0, cache_read: 0, cache_creation: 0,
      cost_usd: null as number | null,
      min_confidence: 1,
      resolvers: [] as string[],
      sessions: 0,
      waste: { retried_commands: 0, repeated_reads: 0 },
    };
    acc.tokens += t;
    acc.input += u.tokens.input;
    acc.output += u.tokens.output;
    acc.cache_read += u.tokens.cache_read;
    acc.cache_creation += u.tokens.cache_creation;
    if (u.cost_usd) acc.cost_usd = Math.round(((acc.cost_usd ?? 0) + u.cost_usd.value) * 10000) / 10000;
    if (u.attribution.confidence < acc.min_confidence) acc.min_confidence = u.attribution.confidence;
    if (!acc.resolvers.includes(u.attribution.resolver)) acc.resolvers.push(u.attribution.resolver);
    if (u.waste) {
      acc.waste.retried_commands += u.waste.retried_commands;
      acc.waste.repeated_reads += u.waste.repeated_reads;
    }
    accounts.set(u.attribution.account, acc);
    const sess = accountSessions.get(u.attribution.account) ?? new Set<string>();
    sess.add(u.session_id);
    accountSessions.set(u.attribution.account, sess);

    const m = models.get(u.model) ?? { tokens: 0, cost: 0, priced: false };
    m.tokens += t;
    if (u.cost_usd) {
      m.cost = Math.round((m.cost + u.cost_usd.value) * 10000) / 10000;
      m.priced = true;
    }
    models.set(u.model, m);
    weeks.set(isoWeek(u.ts), (weeks.get(isoWeek(u.ts)) ?? 0) + t);
  }

  for (const [account, acc] of accounts) {
    acc.sessions = accountSessions.get(account)?.size ?? 0;
    acc.resolvers.sort();
  }

  const shippedKeys = new Set(
    effectiveShipped(ledgerEvents)
      .map((s) => s.entry.tracker_key)
      .filter((k): k is string => k !== null),
  );
  const openSpend = [...accounts.values()]
    .filter((a) => a.account.startsWith("story:") && !shippedKeys.has(a.account.slice(6)))
    .map((a) => ({ account: a.account, tokens: a.tokens }))
    .sort((a, b) => b.tokens - a.tokens || (a.account < b.account ? -1 : 1));

  const attributed = [...accounts.values()]
    .filter((a) => a.account !== "unattributed" && a.min_confidence >= 0.6)
    .reduce((n, a) => n + a.tokens, 0);
  const openAmbiguities = countOpenAmbiguities(exceptionEvents);
  const unattributed = accounts.get("unattributed")?.tokens ?? 0;

  return {
    window,
    accounts: [...accounts.values()].sort(
      (a, b) => b.tokens - a.tokens || (a.account < b.account ? -1 : 1),
    ),
    by_model: [...models.entries()]
      .map(([model, m]) => ({ model, tokens: m.tokens, cost_usd: m.priced ? m.cost : null }))
      .sort((a, b) => b.tokens - a.tokens || (a.model < b.model ? -1 : 1)),
    by_week: [...weeks.entries()].map(([week, tokens]) => ({ week, tokens })).sort((a, b) => (a.week < b.week ? -1 : 1)),
    total_tokens: total,
    unattributed_tokens: unattributed,
    unattributed_pct: total > 0 ? Math.round((unattributed / total) * 1000) / 10 : 0,
    open_spend: openSpend,
    attribution_health: {
      attributed_pct_conf_060: total > 0 ? Math.round((attributed / total) * 1000) / 10 : 0,
      inbox_open: openAmbiguities,
    },
    pricing_version: config.pricing.version,
    pricing_coverage: {
      priced_tokens: pricedTokens,
      unpriced_tokens: total - pricedTokens,
      priced_pct: total > 0 ? Math.round((pricedTokens / total) * 1000) / 10 : 0,
      unpriced_models: [...unpricedByModel].sort(),
    },
  };
}

export function countOpenAmbiguities(exceptionEvents: ExceptionEvent[]): number {
  const resolved = new Set(
    exceptionEvents
      .filter((e): e is ResolutionEvent => e.kind === "resolution")
      .map((e) => e.resolves),
  );
  return exceptionEvents.filter(
    (e): e is AmbiguityEvent => e.kind === "ambiguity" && !resolved.has(e.id),
  ).length;
}

export interface ReportData {
  window: Window;
  shipped: Array<{
    id: string;
    tracker_key: string | null;
    title: string;
    epic_key: string | null;
    epic_name: string | null;
    points: number | null;
    prs: string[];
    deploy: string | null;
    ts: string;
    claude_role: string;
    metered_tokens: number | null;
    escrowed: boolean;
  }>;
  totals: {
    points: number;
    merged_prs: number;
    deploys: number;
    /** Tokens attributed to the SHIPPED items in the window — not all
     * in-window spend; that is costs.window_tokens. */
    shipped_metered_tokens: number;
  };
  efficiency: {
    tokens_per_point: number | null;
    tokens_per_pr: number | null;
  };
  time_saved: {
    pre_registered_or_baseline: { low: number; high: number; entries: number };
    judgment: { low: number; high: number; entries: number };
  };
  costs: {
    window_tokens: number;
    granted_tokens: number | null;
    utilization_pct: number | null;
    unattributed_pct: number;
    reopened_count: number;
    waste: { retried_commands: number; repeated_reads: number };
  };
  spend_ledger: SpendData;
  baseline: Config["baseline"] | null;
}

export function reportData(
  ledgerEvents: Array<LedgerEntry | PinEntry>,
  usageEvents: UsageEvent[],
  exceptionEvents: ExceptionEvent[],
  config: Config,
  window: Window,
): ReportData {
  const views = effectiveShipped(ledgerEvents).filter((s) => inWindow(s.shipped_ts, window));
  const spend = spendData(usageEvents, exceptionEvents, ledgerEvents, config, window);
  const tokensByKey = new Map<string, number>();
  for (const a of spend.accounts) {
    if (a.account.startsWith("story:")) tokensByKey.set(a.account.slice(6), a.tokens);
  }

  const shipped = views
    .map(({ entry: e, shipped_ts }) => ({
      id: e.id,
      tracker_key: e.tracker_key,
      title: e.title,
      epic_key: e.epic_key,
      epic_name: e.epic_name,
      points: e.points,
      prs: e.artifacts.prs,
      deploy: e.artifacts.deploy,
      ts: shipped_ts,
      claude_role: e.claude_role,
      metered_tokens: e.tracker_key !== null ? (tokensByKey.get(e.tracker_key) ?? null) : null,
      escrowed: e.escrow !== null,
    }))
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const entries = views.map((v) => v.entry);

  const points = shipped.reduce((n, s) => n + (s.points ?? 0), 0);
  const mergedPrs = shipped.reduce((n, s) => n + s.prs.length, 0);
  const deploys = shipped.filter((s) => s.deploy !== null).length;
  const meteredTokens = shipped.reduce((n, s) => n + (s.metered_tokens ?? 0), 0);

  const saved = { pre: { low: 0, high: 0, n: 0 }, judgment: { low: 0, high: 0, n: 0 } };
  for (const e of entries) {
    const t = e.time_saved_hours;
    if (!t) continue;
    const bucket = t.basis === "judgment" ? saved.judgment : saved.pre;
    bucket.low += t.low;
    bucket.high += t.high;
    bucket.n += 1;
  }

  const allocation = config.allocations[config.allocations.length - 1] ?? null;

  return {
    window,
    shipped,
    totals: { points, merged_prs: mergedPrs, deploys, shipped_metered_tokens: meteredTokens },
    efficiency: {
      tokens_per_point: points > 0 && meteredTokens > 0 ? Math.round(meteredTokens / points) : null,
      tokens_per_pr: mergedPrs > 0 && meteredTokens > 0 ? Math.round(meteredTokens / mergedPrs) : null,
    },
    time_saved: {
      pre_registered_or_baseline: { low: saved.pre.low, high: saved.pre.high, entries: saved.pre.n },
      judgment: { low: saved.judgment.low, high: saved.judgment.high, entries: saved.judgment.n },
    },
    costs: {
      window_tokens: spend.total_tokens,
      granted_tokens: allocation?.tokens_granted ?? null,
      utilization_pct:
        allocation && allocation.tokens_granted > 0
          ? Math.round((spend.total_tokens / allocation.tokens_granted) * 1000) / 10
          : null,
      unattributed_pct: spend.unattributed_pct,
      reopened_count: views.filter((v) => v.entry.reopened === true).length,
      waste: spend.accounts.reduce(
        (w, a) => ({
          retried_commands: w.retried_commands + a.waste.retried_commands,
          repeated_reads: w.repeated_reads + a.waste.repeated_reads,
        }),
        { retried_commands: 0, repeated_reads: 0 },
      ),
    },
    spend_ledger: spend,
    baseline: config.baseline.velocity_points_per_sprint !== null || config.baseline.median_cycle_time_days !== null
      ? config.baseline
      : null,
  };
}

export interface ForecastData {
  tokens_per_point: number | null;
  basis_entries: number;
  low_confidence: boolean;
  window: { first_ts: string | null; last_ts: string | null };
  hours_saved_per_point: { low: number; high: number } | null;
  utilization_pct: number | null;
}

export function forecastData(
  ledgerEvents: Array<LedgerEntry | PinEntry>,
  usageEvents: UsageEvent[],
  config: Config,
): ForecastData {
  const spend = spendData(usageEvents, [], ledgerEvents, config, { from: null, to: null });
  const tokensByKey = new Map<string, number>();
  for (const a of spend.accounts) {
    if (a.account.startsWith("story:")) tokensByKey.set(a.account.slice(6), a.tokens);
  }
  const shipped = effectiveShipped(ledgerEvents)
    .filter(
      (s) =>
        s.entry.points !== null &&
        s.entry.points > 0 &&
        s.entry.tracker_key !== null &&
        tokensByKey.has(s.entry.tracker_key),
    )
    .sort((a, b) => (a.shipped_ts < b.shipped_ts ? -1 : 1))
    .map((s) => s.entry);
  const recent = shipped.slice(-Math.max(5, Math.min(shipped.length, 10)));
  const rates = recent
    .map((e) => tokensByKey.get(e.tracker_key!)! / e.points!)
    .sort((a, b) => a - b);
  const mid = Math.floor(rates.length / 2);
  const tokensPerPoint =
    rates.length === 0
      ? null
      : Math.round(rates.length % 2 === 1 ? rates[mid]! : (rates[mid - 1]! + rates[mid]!) / 2);

  let savedLow = 0;
  let savedHigh = 0;
  let savedPoints = 0;
  for (const e of recent) {
    const t = e.time_saved_hours;
    if (t && (t.basis === "pre_registered" || t.basis === "baseline") && e.points) {
      savedLow += t.low;
      savedHigh += t.high;
      savedPoints += e.points;
    }
  }

  const allocation = config.allocations[config.allocations.length - 1] ?? null;
  return {
    tokens_per_point: tokensPerPoint,
    basis_entries: recent.length,
    low_confidence: recent.length < 5,
    window: {
      first_ts: recent[0]?.ts ?? null,
      last_ts: recent[recent.length - 1]?.ts ?? null,
    },
    hours_saved_per_point:
      savedPoints > 0
        ? {
            low: Math.round((savedLow / savedPoints) * 100) / 100,
            high: Math.round((savedHigh / savedPoints) * 100) / 100,
          }
        : null,
    utilization_pct:
      allocation && allocation.tokens_granted > 0
        ? Math.round((spend.total_tokens / allocation.tokens_granted) * 1000) / 10
        : null,
  };
}
