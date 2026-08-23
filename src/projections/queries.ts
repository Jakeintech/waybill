import type { Config } from "../core/config.ts";
import type {
  AmbiguityEvent,
  ExceptionEvent,
  LedgerEntry,
  PinEntry,
  ResolutionEvent,
  UsageEvent,
} from "../core/events.ts";
import { rootSessionId } from "../core/events.ts";
import { inWindow as isInWindow, isIsoBound } from "../core/time.ts";
import { resolveRate } from "../core/pricing-resolve.ts";
import { authoritative } from "../core/streams.ts";

export interface Window {
  from: string | null;
  to: string | null;
}

/**
 * Normalize user-supplied bounds: a bare date means the whole day (a
 * date-only `to` is inclusive of that day, not a midnight cutoff), and
 * bad bounds are an error rather than a silently empty window. Bounds must
 * be ISO-shaped (core/time): a merely Date.parse-able format ("8/20/2026")
 * would be accepted and then silently match nothing.
 */
export function normalizeWindow(from: string | null, to: string | null): Window {
  const check = (v: string | null, name: string): string | null => {
    if (v === null) return null;
    if (!isIsoBound(v)) {
      throw new Error(`--${name} must be an ISO date (YYYY-MM-DD or full ISO timestamp): ${v}`);
    }
    return v;
  };
  const f = check(from, "from");
  let t = check(to, "to");
  if (t !== null && /^\d{4}-\d{2}-\d{2}$/.test(t)) t = `${t}T23:59:59.999Z`;
  return { from: f, to: t };
}

function inWindow(ts: string, w: Window): boolean {
  return isInWindow(ts, w.from, w.to);
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
  /** `unpriced_tokens` > 0 marks a model whose cost_usd covers only part
   * of its tokens (events metered before a rate existed, or no rate). */
  by_model: Array<{ model: string; tokens: number; cost_usd: number | null; unpriced_tokens: number }>;
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
   * dollar total that silently omits unpriced events is not a receipt.
   * `unpriced_event_models` = models with at least one costless event in
   * the window (distinct from status's "no resolvable rate now" list —
   * an event metered before its rate existed lands here until re-metered). */
  pricing_coverage: {
    priced_tokens: number;
    unpriced_tokens: number;
    priced_pct: number;
    unpriced_event_models: string[];
  };
  /** The plugin's own keep — tokens from turns that ran the waybill CLI
   * (v1.6, meter-tagged). The accountant bills for its own hours. */
  overhead: { tokens: number; pct: number };
  /** What cache reads saved vs. re-sending those tokens at the uncached
   * input rate — DERIVED at query time from the current rate table (v1.7),
   * never a stored fact. `saved_usd` is null until at least one cache-read
   * event's model resolves a rate; `covered_pct` says how much of the
   * cache-read volume the figure actually covers. */
  cache_savings: {
    cache_read_tokens: number;
    cache_read_pct: number;
    saved_usd: number | null;
    covered_pct: number;
    basis: "list_price_equivalent_derived";
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
  const models = new Map<string, { tokens: number; cost: number; priced: boolean; unpriced: number }>();
  const weeks = new Map<string, number>();
  const accountSessions = new Map<string, Set<string>>();
  let total = 0;
  let pricedTokens = 0;
  let overheadTokens = 0;
  let cacheReadTokens = 0;
  let cacheSavedUsd = 0;
  let cacheCoveredTokens = 0;
  const unpricedByModel = new Set<string>();

  for (const u of usage) {
    const t = totalTokens(u);
    total += t;
    if (u.overhead === true) overheadTokens += t;
    if (u.tokens.cache_read > 0) {
      cacheReadTokens += u.tokens.cache_read;
      // Derived, current-rate-table math (not the stored cost_usd): what
      // these cache-read tokens would have cost at the uncached input rate,
      // minus what the cache-read rate charges for them.
      const rate = resolveRate(config.pricing, u.model);
      if (rate !== null) {
        cacheCoveredTokens += u.tokens.cache_read;
        cacheSavedUsd +=
          (u.tokens.cache_read * (rate.rates.input_per_mtok - rate.rates.cache_read_per_mtok)) / 1_000_000;
      }
    }
    if (u.cost_usd) pricedTokens += t;
    // "unknown" (no model id in the source) counts as unpriced tokens but
    // stays out of the named list — no rate could ever fix it, and status
    // must be able to print a fix for every model this list names.
    else if (u.model !== "unknown") unpricedByModel.add(u.model);
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
    // Root ids: a session and its subagent transcripts count as one session.
    sess.add(rootSessionId(u.session_id));
    accountSessions.set(u.attribution.account, sess);

    const m = models.get(u.model) ?? { tokens: 0, cost: 0, priced: false, unpriced: 0 };
    m.tokens += t;
    if (u.cost_usd) {
      m.cost = Math.round((m.cost + u.cost_usd.value) * 10000) / 10000;
      m.priced = true;
    } else {
      m.unpriced += t;
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
      .map(([model, m]) => ({ model, tokens: m.tokens, cost_usd: m.priced ? m.cost : null, unpriced_tokens: m.unpriced }))
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
      unpriced_event_models: [...unpricedByModel].sort(),
    },
    overhead: {
      tokens: overheadTokens,
      pct: total > 0 ? Math.round((overheadTokens / total) * 1000) / 10 : 0,
    },
    cache_savings: {
      cache_read_tokens: cacheReadTokens,
      cache_read_pct: total > 0 ? Math.round((cacheReadTokens / total) * 1000) / 10 : 0,
      saved_usd: cacheCoveredTokens > 0 ? Math.round(cacheSavedUsd * 10000) / 10000 : null,
      covered_pct:
        cacheReadTokens > 0 ? Math.round((cacheCoveredTokens / cacheReadTokens) * 1000) / 10 : 0,
      basis: "list_price_equivalent_derived",
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
    /** v1.8 reader presets (disclosure register, incident recipe): the
     * entry's work_type travels onto the row. */
    work_type: string;
    metered_tokens: number | null;
    /** Distinct metered sessions attributed to this story in the window —
     * a count (numbers survive every redaction level). */
    sessions: number;
    /** This story's metered USD in the window (spend-account cost), null
     * when unpriced — per-item cost for invoice/disclosure rows. */
    metered_cost_usd: number | null;
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
  /** Tokens-per-shipped-point by model (v1.7), own history only. A shipped
   * story counts under a model when that model carried >50% of the story's
   * metered tokens; `tokens` is the story's FULL metered spend (the honest
   * cost of shipping the point, minority models included). Stories with no
   * majority model land in `mixed`. */
  model_mix: {
    by_model: Array<{
      model: string;
      stories: number;
      points: number;
      tokens: number;
      tokens_per_point: number | null;
    }>;
    mixed: { stories: number; points: number; tokens: number };
  };
  /** Pre-registered ranges vs. recorded actual hours (v1.7). The estimate
   * is "hours without Claude"; `actual_hours` is what the work took with
   * it. `below` = actual under the range's low (the claimed saving holds in
   * full), `within` = partial, `above` = the work took longer than the
   * no-Claude estimate — negative savings, surfaced, never hidden. */
  calibration: {
    shipped: number;
    pre_registered: number;
    coverage_pct: number;
    with_actuals: number;
    actual_below_range: number;
    actual_within_range: number;
    actual_above_range: number;
    entries: Array<{
      tracker_key: string | null;
      low: number;
      high: number;
      actual_hours: number;
      position: "below" | "within" | "above";
    }>;
  };
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
  const costByKey = new Map<string, number | null>();
  for (const a of spend.accounts) {
    if (a.account.startsWith("story:")) {
      tokensByKey.set(a.account.slice(6), a.tokens);
      costByKey.set(a.account.slice(6), a.cost_usd);
    }
  }

  // Per-story usage detail for the shipped rows and the model mix: the same
  // authoritative in-window usage spendData counted, so projections agree.
  const storyModelTokens = new Map<string, Map<string, number>>();
  const sessionsByKey = new Map<string, Set<string>>();
  for (const u of authoritative(usageEvents)) {
    if (u.kind !== "usage" || !inWindow(u.ts, window) || totalTokens(u) === 0) continue;
    if (!u.attribution.account.startsWith("story:")) continue;
    const key = u.attribution.account.slice(6);
    const split = storyModelTokens.get(key) ?? new Map<string, number>();
    split.set(u.model, (split.get(u.model) ?? 0) + totalTokens(u));
    storyModelTokens.set(key, split);
    const sess = sessionsByKey.get(key) ?? new Set<string>();
    sess.add(rootSessionId(u.session_id)); // subagents count with their session
    sessionsByKey.set(key, sess);
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
      work_type: e.work_type,
      metered_tokens: e.tracker_key !== null ? (tokensByKey.get(e.tracker_key) ?? null) : null,
      sessions: e.tracker_key !== null ? (sessionsByKey.get(e.tracker_key)?.size ?? 0) : 0,
      metered_cost_usd: e.tracker_key !== null ? (costByKey.get(e.tracker_key) ?? null) : null,
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

  // Model mix over the per-story splits computed above.
  const byModel = new Map<string, { stories: number; points: number; tokens: number }>();
  const mixed = { stories: 0, points: 0, tokens: 0 };
  for (const s of shipped) {
    if (s.tracker_key === null || s.points === null || s.points <= 0) continue;
    const split = storyModelTokens.get(s.tracker_key);
    if (!split) continue;
    let storyTotal = 0;
    let topModel = "";
    let topTokens = -1;
    for (const [model, tokens] of [...split.entries()].sort()) {
      storyTotal += tokens;
      if (tokens > topTokens) {
        topModel = model;
        topTokens = tokens;
      }
    }
    if (topTokens * 2 > storyTotal) {
      const row = byModel.get(topModel) ?? { stories: 0, points: 0, tokens: 0 };
      row.stories += 1;
      row.points += s.points;
      row.tokens += storyTotal;
      byModel.set(topModel, row);
    } else {
      mixed.stories += 1;
      mixed.points += s.points;
      mixed.tokens += storyTotal;
    }
  }

  // Calibration: pre-registered "hours without Claude" ranges vs. recorded
  // actual hours, over the window's shipped items (authoritative views).
  const calEntries: ReportData["calibration"]["entries"] = [];
  let preRegistered = 0;
  for (const { entry } of views) {
    const est = entry.estimate_without_claude_hours;
    if (!est || !est.pre_registered) continue;
    preRegistered += 1;
    if (entry.actual_hours === null) continue;
    const a = entry.actual_hours;
    calEntries.push({
      tracker_key: entry.tracker_key,
      low: est.low,
      high: est.high,
      actual_hours: a,
      position: a < est.low ? "below" : a > est.high ? "above" : "within",
    });
  }
  calEntries.sort((a, b) => ((a.tracker_key ?? "") < (b.tracker_key ?? "") ? -1 : 1));

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
    model_mix: {
      by_model: [...byModel.entries()]
        .map(([model, r]) => ({
          model,
          stories: r.stories,
          points: r.points,
          tokens: r.tokens,
          tokens_per_point: r.points > 0 ? Math.round(r.tokens / r.points) : null,
        }))
        .sort((a, b) => b.tokens - a.tokens || (a.model < b.model ? -1 : 1)),
      mixed,
    },
    calibration: {
      shipped: views.length,
      pre_registered: preRegistered,
      coverage_pct: views.length > 0 ? Math.round((preRegistered / views.length) * 1000) / 10 : 0,
      with_actuals: calEntries.length,
      actual_below_range: calEntries.filter((e) => e.position === "below").length,
      actual_within_range: calEntries.filter((e) => e.position === "within").length,
      actual_above_range: calEntries.filter((e) => e.position === "above").length,
      entries: calEntries,
    },
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
