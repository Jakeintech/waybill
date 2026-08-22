import type { LedgerEntry, PinEntry } from "../core/events.ts";
import { authoritative } from "../core/streams.ts";
import { effectiveShipped } from "../projections/queries.ts";
import type { MergedChange, WorkItem } from "../adapters/contract.ts";

export type EntryBody = Omit<LedgerEntry, "id">;

export interface SyncPlan {
  generated_at: string;
  shipped: EntryBody[];
  corrections: Array<{ body: EntryBody; drift: string[] }>;
  orphans: EntryBody[];
  unmatched_changes: MergedChange[];
  baseline: BaselineDerivation | null;
  summary: {
    open_entries: number;
    done_items: number;
    merged_changes: number;
  };
}

export interface BaselineDerivation {
  velocity_points_per_sprint: number | null;
  median_cycle_time_days: number | null;
  window: string;
  derived_from: string;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const m = sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return Math.round(m * 10) / 10;
}

export function deriveBaseline(items: WorkItem[], windowLabel: string): BaselineDerivation {
  const done = items.filter((i) => i.done);
  const bySprint = new Map<string, number>();
  for (const i of done) {
    if (i.sprint !== null && i.points !== null) {
      bySprint.set(i.sprint, (bySprint.get(i.sprint) ?? 0) + i.points);
    }
  }
  const cycles: number[] = [];
  for (const i of done) {
    if (i.created_at !== null && i.resolved_at !== null) {
      const days = (Date.parse(i.resolved_at) - Date.parse(i.created_at)) / 86400_000;
      if (days >= 0) cycles.push(days);
    }
  }
  return {
    velocity_points_per_sprint: median([...bySprint.values()]),
    median_cycle_time_days: median(cycles),
    window: windowLabel,
    derived_from: `tracker history: ${done.length} resolved item(s), ${bySprint.size} sprint(s)`,
  };
}

function shippedBody(
  entry: LedgerEntry,
  item: WorkItem,
  changes: MergedChange[],
  now: string,
): EntryBody {
  const prUrls = changes.map((c) => c.url).filter((u): u is string => u !== null).sort();
  const commitShas = changes
    .filter((c) => c.url === null)
    .map((c) => /\(([0-9a-f]{7,40})\)$/.exec(c.title)?.[1])
    .filter((s): s is string => s !== undefined)
    .sort();
  // Chronological max, not lexicographic: Jira resolutiondates carry
  // "+HHMM" offsets while merge timestamps are Z-suffixed — mixed formats
  // don't sort as strings. Ties (or unparseable values) fall back
  // deterministically to string order.
  const tsCandidates = [item.resolved_at ?? "", ...changes.map((c) => c.merged_at)].filter((t) => t !== "");
  const ts =
    tsCandidates.length > 0
      ? tsCandidates.sort((a, b) => {
          const pa = Date.parse(a);
          const pb = Date.parse(b);
          if (!Number.isNaN(pa) && !Number.isNaN(pb) && pa !== pb) return pa - pb;
          return a < b ? -1 : a > b ? 1 : 0;
        })[tsCandidates.length - 1]!
      : now;
  return {
    ts,
    kind: "shipped",
    schema_version: 2,
    supersedes: entry.id,
    title: entry.title,
    tracker_key: item.key,
    epic_key: item.epic_key ?? entry.epic_key,
    epic_name: item.epic_name ?? entry.epic_name,
    sprint: item.sprint ?? entry.sprint,
    repo: changes[0]?.repo ?? entry.repo,
    work_type: entry.work_type,
    points: item.points ?? entry.points,
    artifacts: { prs: prUrls, commits: commitShas, deploy: null, docs: [] },
    estimate_without_claude_hours: entry.estimate_without_claude_hours,
    escrow: entry.escrow,
    actual_hours: entry.actual_hours,
    claude_role: entry.claude_role,
    sessions: entry.sessions,
    tokens: entry.tokens,
    budget_tokens: entry.budget_tokens,
    time_saved_hours: entry.time_saved_hours,
    notes: entry.notes,
  };
}

function orphanBody(item: WorkItem, changes: MergedChange[], now: string): EntryBody {
  const base = shippedBody(
    {
      id: "", ts: now, kind: "opened", schema_version: 2, supersedes: null,
      title: item.title, tracker_key: item.key, epic_key: null, epic_name: null,
      sprint: null, repo: null, work_type: item.work_type, points: null,
      artifacts: { prs: [], commits: [], deploy: null, docs: [] },
      estimate_without_claude_hours: null, escrow: null, actual_hours: null,
      claude_role: "none", sessions: [], tokens: null, budget_tokens: null,
      time_saved_hours: null, notes: null,
    },
    item,
    changes,
    now,
  );
  base.supersedes = null;
  base.notes = "imported from tracker/git history; Claude involvement unrecorded";
  return base;
}

export function reconcile(
  items: WorkItem[],
  changes: MergedChange[],
  ledgerEvents: Array<LedgerEntry | PinEntry>,
  now: string,
  options: { baselineWindow?: string } = {},
): SyncPlan {
  const auth = authoritative(ledgerEvents).filter(
    (e): e is LedgerEntry => e.kind !== "pin",
  );
  const latestByKey = new Map<string, LedgerEntry>();
  for (const e of auth) {
    if (e.tracker_key === null) continue;
    const prior = latestByKey.get(e.tracker_key);
    if (!prior || e.ts > prior.ts) latestByKey.set(e.tracker_key, e);
  }
  const changesByKey = new Map<string, MergedChange[]>();
  const unmatched: MergedChange[] = [];
  for (const c of changes) {
    // Pairing refs: pattern keys from title/branch, plus explicit closing
    // references ("Fixes #12") — GitHub's actual issue↔PR linkage.
    const refs = [...new Set([...c.keys, ...(c.closes ?? [])])];
    if (refs.length === 0) {
      unmatched.push(c);
      continue;
    }
    for (const k of refs) {
      changesByKey.set(k, [...(changesByKey.get(k) ?? []), c]);
    }
  }

  const shipped: EntryBody[] = [];
  const corrections: Array<{ body: EntryBody; drift: string[] }> = [];
  const orphans: EntryBody[] = [];
  // Classify by supersession chain, not by surface kind: a correction over
  // an open entry is still open work; one over a shipped entry is shipped.
  const shipChained = new Set(effectiveShipped(ledgerEvents).map((v) => v.entry.id));

  for (const item of items) {
    const entry = latestByKey.get(item.key);
    const itemChanges = changesByKey.get(item.key) ?? [];
    if (!entry) {
      if (item.done) orphans.push(orphanBody(item, itemChanges, now));
      continue;
    }
    if (!shipChained.has(entry.id) && item.done) {
      shipped.push(shippedBody(entry, item, itemChanges, now));
      continue;
    }
    if (shipChained.has(entry.id)) {
      // Rework closed out: the tracker re-resolved a previously reopened item.
      if (item.done && entry.reopened === true) {
        const body: EntryBody = {
          ...(({ id: _id, ...rest }) => rest)(entry),
          ts: now,
          kind: "correction",
          supersedes: entry.id,
          points: item.points ?? entry.points,
          epic_key: item.epic_key ?? entry.epic_key,
          epic_name: item.epic_name ?? entry.epic_name,
          sprint: item.sprint ?? entry.sprint,
          reopened: false,
          notes: `sync: re-resolved in tracker (status "${item.status}") after reopen`,
        };
        corrections.push({ body, drift: [`re-resolved (status "${item.status}")`] });
        continue;
      }
      // Rework tracking: the tracker reopened an item that shipped. The
      // correction also carries the tracker's current fields so one sync
      // pass captures everything.
      if (!item.done && entry.reopened !== true) {
        const body: EntryBody = {
          ...(({ id: _id, ...rest }) => rest)(entry),
          ts: now,
          kind: "correction",
          supersedes: entry.id,
          points: item.points ?? entry.points,
          epic_key: item.epic_key ?? entry.epic_key,
          epic_name: item.epic_name ?? entry.epic_name,
          sprint: item.sprint ?? entry.sprint,
          reopened: true,
          notes: `sync: reopened in tracker (status "${item.status}")`,
        };
        corrections.push({ body, drift: [`reopened (status "${item.status}")`] });
        continue;
      }
      const drift: string[] = [];
      if (item.points !== null && entry.points !== item.points) {
        drift.push(`points ${entry.points ?? "null"} → ${item.points}`);
      }
      if (item.epic_key !== null && entry.epic_key !== item.epic_key) {
        drift.push(`epic ${entry.epic_key ?? "null"} → ${item.epic_key}`);
      }
      if (item.sprint !== null && entry.sprint !== item.sprint) {
        drift.push(`sprint ${entry.sprint ?? "null"} → ${item.sprint}`);
      }
      if (drift.length > 0) {
        const body: EntryBody = {
          ...(({ id: _id, ...rest }) => rest)(entry),
          ts: now,
          kind: "correction",
          supersedes: entry.id,
          points: item.points ?? entry.points,
          epic_key: item.epic_key ?? entry.epic_key,
          epic_name: item.epic_name ?? entry.epic_name,
          sprint: item.sprint ?? entry.sprint,
          notes: `sync: ${drift.join("; ")}`,
        };
        corrections.push({ body, drift });
      }
    }
  }

  // Merged changes whose keys have no tracker item and no entry: surface them.
  for (const [key, cs] of [...changesByKey.entries()].sort()) {
    if (!items.some((i) => i.key === key) && !latestByKey.has(key)) {
      for (const c of cs) if (!unmatched.includes(c)) unmatched.push(c);
    }
  }

  return {
    generated_at: now,
    shipped,
    corrections,
    orphans,
    unmatched_changes: unmatched,
    baseline: options.baselineWindow ? deriveBaseline(items, options.baselineWindow) : null,
    summary: {
      open_entries: auth.filter((e) => e.kind === "opened" || e.kind === "progress").length,
      done_items: items.filter((i) => i.done).length,
      merged_changes: changes.length,
    },
  };
}
