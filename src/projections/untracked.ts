import type { Config } from "../core/config.ts";
import type {
  LedgerEntry,
  PinEntry,
  SessionEvent,
  TokenCounts,
  UsageEvent,
} from "../core/events.ts";
import { isPlausibleTrackerKey } from "../core/keys.ts";
import { inWindow } from "../core/time.ts";
import { authoritative } from "../core/streams.ts";
import type { Window } from "./queries.ts";

/**
 * The clustering behind the salvage skill: spend that never became a
 * receipt — unattributed sessions, story keys seen in branches but never
 * logged or synced, adhoc labels without entries — grouped into candidate
 * work items, each cluster carrying the receipts (sessions, branches,
 * windows) a human needs to confirm it with one tap. Deterministic: the
 * engine groups, a skill proposes titles FROM the receipts, the user
 * decides. Salvage reconstructs facts; it never backfills
 * pre-registration.
 */
export interface UntrackedCluster {
  /** Stable identity for the conversation: `<kind>:<label>[@<repo>]`. */
  id: string;
  kind: "story_key" | "branch" | "adhoc" | "unattributed";
  /** The grouping label: the tracker key, the branch name, the adhoc
   * label, or the repo for repo-only clusters. */
  label: string;
  repo: string | null;
  branches: string[];
  /** Plausible tracker keys appearing in the cluster's branch names. */
  keys_seen: string[];
  sessions: Array<{ session_id: string; first_ts: string; last_ts: string; turns: number }>;
  tokens: number;
  totals: TokenCounts;
  first_ts: string;
  last_ts: string;
}

export interface UntrackedData {
  window: Window;
  clusters: UntrackedCluster[];
  untracked_tokens: number;
  window_tokens: number;
  /** Share of the window's spend that has no ledger receipt behind it. */
  untracked_pct: number;
}

function totalTokens(t: TokenCounts): number {
  return t.input + t.output + t.cache_read + t.cache_creation;
}

export function untrackedData(
  ledgerEvents: Array<LedgerEntry | PinEntry>,
  usageEvents: UsageEvent[],
  sessionEvents: SessionEvent[],
  config: Config,
  window: Window,
): UntrackedData {
  const ledgerKeys = new Set(
    authoritative(ledgerEvents)
      .filter((e): e is LedgerEntry => e.kind !== "pin")
      .map((e) => e.tracker_key)
      .filter((k): k is string => k !== null),
  );
  const receiptBySession = new Map<string, SessionEvent>();
  for (const s of authoritative(sessionEvents)) {
    if (s.kind === "session") receiptBySession.set(s.session_id, s);
  }

  const usage = authoritative(usageEvents).filter(
    (u) => u.kind === "usage" && inWindow(u.ts, window.from, window.to) && totalTokens(u.tokens) > 0,
  );

  const keyRe = new RegExp(config.metering.branch_key_pattern, "g");
  const clusters = new Map<string, UntrackedCluster>();
  let windowTokens = 0;
  let untrackedTokens = 0;

  const add = (
    kind: UntrackedCluster["kind"],
    label: string,
    repo: string | null,
    u: UsageEvent,
    receipt: SessionEvent | undefined,
  ): void => {
    const id = `${kind}:${label}${repo !== null ? `@${repo}` : ""}`;
    const cluster = clusters.get(id) ?? {
      id,
      kind,
      label,
      repo,
      branches: [],
      keys_seen: [],
      sessions: [],
      tokens: 0,
      totals: { input: 0, output: 0, cache_read: 0, cache_creation: 0 },
      first_ts: u.ts,
      last_ts: u.ts,
    };
    cluster.tokens += totalTokens(u.tokens);
    cluster.totals.input += u.tokens.input;
    cluster.totals.output += u.tokens.output;
    cluster.totals.cache_read += u.tokens.cache_read;
    cluster.totals.cache_creation += u.tokens.cache_creation;
    if (u.ts < cluster.first_ts) cluster.first_ts = u.ts;
    if (u.ts > cluster.last_ts) cluster.last_ts = u.ts;
    if (receipt) {
      if (!cluster.sessions.some((s) => s.session_id === receipt.session_id)) {
        cluster.sessions.push({
          session_id: receipt.session_id,
          first_ts: receipt.first_ts,
          last_ts: receipt.last_ts,
          turns: receipt.turns,
        });
      }
      for (const b of receipt.branches) {
        if (!cluster.branches.includes(b)) cluster.branches.push(b);
        for (const k of b.match(keyRe) ?? []) {
          if (isPlausibleTrackerKey(k, config.tracker.project_keys) && !cluster.keys_seen.includes(k)) {
            cluster.keys_seen.push(k);
          }
        }
      }
    } else if (!cluster.sessions.some((s) => s.session_id === u.session_id)) {
      cluster.sessions.push({ session_id: u.session_id, first_ts: u.ts, last_ts: u.ts, turns: 0 });
    }
    clusters.set(id, cluster);
  };

  for (const u of usage) {
    windowTokens += totalTokens(u.tokens);
    const receipt = receiptBySession.get(u.session_id);
    const account = u.attribution.account;

    if (account.startsWith("story:")) {
      const key = account.slice(6);
      if (ledgerKeys.has(key)) continue; // tracked — a ledger entry exists
      untrackedTokens += totalTokens(u.tokens);
      add("story_key", key, u.repo ?? receipt?.repo ?? null, u, receipt);
      continue;
    }
    if (account.startsWith("adhoc:")) {
      // Deliberately labeled (usually via a pin) but still entry-less:
      // salvage can offer to give it a real ledger entry.
      untrackedTokens += totalTokens(u.tokens);
      add("adhoc", account.slice(6), u.repo ?? receipt?.repo ?? null, u, receipt);
      continue;
    }
    // unattributed: group by the session's branch identity when one
    // exists, else by repo — the receipts a human can recognize work by.
    untrackedTokens += totalTokens(u.tokens);
    const repo = u.repo ?? receipt?.repo ?? null;
    const branch = receipt?.branches[0] ?? null;
    if (branch !== null) add("branch", branch, repo, u, receipt);
    else add("unattributed", repo ?? "(no repo)", repo, u, receipt);
  }

  const sorted = [...clusters.values()]
    .map((c) => ({
      ...c,
      branches: [...c.branches].sort(),
      keys_seen: [...c.keys_seen].sort(),
      sessions: [...c.sessions].sort((a, b) => (a.first_ts < b.first_ts ? -1 : 1)),
    }))
    .sort((a, b) => b.tokens - a.tokens || (a.id < b.id ? -1 : 1));

  return {
    window,
    clusters: sorted,
    untracked_tokens: untrackedTokens,
    window_tokens: windowTokens,
    untracked_pct: windowTokens > 0 ? Math.round((untrackedTokens / windowTokens) * 1000) / 10 : 0,
  };
}
