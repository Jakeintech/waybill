import type { WorkType } from "../core/events.ts";
import { isPlausibleTrackerKey } from "../core/keys.ts";

/** A normalized tracker item — the only shape sync ever reasons about. */
export interface WorkItem {
  key: string;
  title: string;
  points: number | null;
  epic_key: string | null;
  epic_name: string | null;
  sprint: string | null;
  status: string;
  done: boolean;
  resolved_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  work_type: WorkType;
  url: string | null;
}

/** A normalized merged change (PR/MR/merge commit). */
export interface MergedChange {
  url: string | null;
  title: string;
  repo: string;
  branch: string | null;
  merged_at: string;
  keys: string[];
}

export interface AdapterContext {
  /** Tracker key regex (config.metering.branch_key_pattern). */
  keyPattern: string;
  /** Identity for own-data checks where the raw payload carries authorship. */
  identityEmails: string[];
  /** Defense-in-depth (methodology §6): when the raw payload names an
   * author/assignee and these are set, records for other people are
   * dropped even if a mis-scoped query fetched them. */
  githubLogin: string | null;
  jiraAccountId: string | null;
  /** config.tracker.project_keys — gates key extraction (core/keys). */
  projectKeys: string[];
  /** Candidate custom field ids for story points (Jira instances vary). */
  pointsFields: string[];
  /** Candidate custom field ids for sprint. */
  sprintFields: string[];
}

export function defaultContext(partial: Partial<AdapterContext> = {}): AdapterContext {
  return {
    keyPattern: "[A-Z][A-Z0-9]+-[0-9]+",
    identityEmails: [],
    githubLogin: null,
    jiraAccountId: null,
    projectKeys: [],
    pointsFields: ["customfield_10016", "customfield_10026", "customfield_10002"],
    sprintFields: ["customfield_10020", "customfield_10010"],
    ...partial,
  };
}

/**
 * Adapters are pure, deterministic normalizers: raw provider JSON in,
 * sorted normalized records out. No network, no model, no clock.
 */
export interface TrackerAdapter {
  kind: string;
  /** The tracker's own key shape, when it differs from the configured
   * branch pattern (e.g. GitHub's `owner/repo#123`). The conformance kit
   * and sync validate item keys against this instead of
   * `ctx.keyPattern`; metering's branch pattern is deliberately NOT
   * widened — "what a key looks like in this tracker" and "what keys
   * look like in branch names" are different questions. */
  keyPattern?: string;
  /** Pure projection from a verbatim payload URL leaf to the item key.
   * Declaring it lets the conformance kit verify a composed key (one not
   * present verbatim in the payload) is still derived entirely from the
   * payload: the kit re-runs the derivation on `item.url` — which must
   * itself be a verbatim leaf — and requires an exact match. Must use
   * nothing but the given URL string. */
  deriveKey?(url: string): string | null;
  normalizeItems(raw: unknown, ctx: AdapterContext): WorkItem[];
}

export interface GitHostAdapter {
  kind: string;
  normalizeChanges(raw: unknown, ctx: AdapterContext): MergedChange[];
}

export function extractKeys(text: string, keyPattern: string, projectKeys: string[] = []): string[] {
  const out: string[] = [];
  for (const k of text.match(new RegExp(keyPattern, "g")) ?? []) {
    if (!isPlausibleTrackerKey(k, projectKeys)) continue;
    if (!out.includes(k)) out.push(k);
  }
  return out;
}

export function sortItems(items: WorkItem[]): WorkItem[] {
  return [...items].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

export function sortChanges(changes: MergedChange[]): MergedChange[] {
  return [...changes].sort(
    (a, b) =>
      (a.merged_at < b.merged_at ? -1 : a.merged_at > b.merged_at ? 1 : 0) ||
      ((a.url ?? "") < (b.url ?? "") ? -1 : 1),
  );
}
