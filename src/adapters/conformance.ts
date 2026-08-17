// The adapter conformance kit: run any adapter against the contract's
// invariants with a raw fixture. Bundled adapters pass it in CI; community
// adapters run it in their PRs (see docs/adapters.md).
import type {
  AdapterContext,
  GitHostAdapter,
  MergedChange,
  TrackerAdapter,
  WorkItem,
} from "./contract.ts";

export interface ConformanceReport {
  adapter: string;
  passed: boolean;
  failures: string[];
}

function isIso(v: string): boolean {
  return !Number.isNaN(Date.parse(v));
}

/** Every string/number leaf in the raw payload, for no-fabrication checks. */
function leafSet(raw: unknown, into = new Set<string>()): Set<string> {
  if (typeof raw === "string") into.add(raw);
  else if (typeof raw === "number") into.add(String(raw));
  else if (Array.isArray(raw)) for (const v of raw) leafSet(v, into);
  else if (raw !== null && typeof raw === "object") {
    for (const v of Object.values(raw)) leafSet(v, into);
  }
  return into;
}

export function checkTrackerAdapter(
  adapter: TrackerAdapter,
  raw: unknown,
  ctx: AdapterContext,
): ConformanceReport {
  const failures: string[] = [];
  const a = adapter.normalizeItems(raw, ctx);
  const b = adapter.normalizeItems(raw, ctx);
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    failures.push("determinism: two runs over the same raw payload differ");
  }
  const sorted = [...a].sort((x, y) => (x.key < y.key ? -1 : 1));
  if (JSON.stringify(a) !== JSON.stringify(sorted)) {
    failures.push("ordering: items must be sorted by key");
  }
  const leaves = leafSet(raw);
  const keyRe = new RegExp(`^(?:${ctx.keyPattern})$`);
  const seen = new Set<string>();
  for (const item of a) {
    checkItem(item, keyRe, leaves, seen, failures);
  }
  return { adapter: adapter.kind, passed: failures.length === 0, failures };
}

function checkItem(
  item: WorkItem,
  keyRe: RegExp,
  leaves: Set<string>,
  seen: Set<string>,
  failures: string[],
): void {
  if (!keyRe.test(item.key)) failures.push(`${item.key}: key does not match the configured pattern`);
  if (seen.has(item.key)) failures.push(`${item.key}: duplicate key`);
  seen.add(item.key);
  if (!leaves.has(item.key)) failures.push(`${item.key}: key not present in raw payload (fabricated?)`);
  if (item.points !== null && !leaves.has(String(item.points))) {
    failures.push(`${item.key}: points ${item.points} not present in raw payload — points are never invented`);
  }
  if (item.resolved_at !== null) {
    if (!isIso(item.resolved_at)) failures.push(`${item.key}: resolved_at is not a timestamp`);
    if (!item.done) failures.push(`${item.key}: resolved_at set but done=false`);
    if (!leaves.has(item.resolved_at)) failures.push(`${item.key}: resolved_at not present in raw payload`);
  }
  if (item.url !== null && !/^https?:\/\//.test(item.url)) {
    failures.push(`${item.key}: url is not http(s)`);
  }
}

export function checkGitHostAdapter(
  adapter: GitHostAdapter,
  raw: unknown,
  ctx: AdapterContext,
): ConformanceReport {
  const failures: string[] = [];
  const a = adapter.normalizeChanges(raw, ctx);
  const b = adapter.normalizeChanges(raw, ctx);
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    failures.push("determinism: two runs over the same raw payload differ");
  }
  const sorted = [...a].sort(
    (x, y) => (x.merged_at < y.merged_at ? -1 : x.merged_at > y.merged_at ? 1 : 0) || ((x.url ?? "") < (y.url ?? "") ? -1 : 1),
  );
  if (JSON.stringify(a) !== JSON.stringify(sorted)) {
    failures.push("ordering: changes must be sorted by merged_at, then url");
  }
  const leaves = leafSet(raw);
  const keyRe = new RegExp(ctx.keyPattern, "g");
  for (const change of a) {
    checkChange(change, keyRe, leaves, failures);
  }
  return { adapter: adapter.kind, passed: failures.length === 0, failures };
}

function checkChange(
  change: MergedChange,
  keyRe: RegExp,
  leaves: Set<string>,
  failures: string[],
): void {
  const label = change.url ?? change.title;
  if (!isIso(change.merged_at)) failures.push(`${label}: merged_at is not a timestamp`);
  if (change.url !== null && !leaves.has(change.url)) {
    failures.push(`${label}: url not present in raw payload — URLs are never fabricated`);
  }
  const haystack = `${change.title} ${change.branch ?? ""}`;
  const legal = new Set(haystack.match(keyRe) ?? []);
  for (const k of change.keys) {
    if (!legal.has(k)) failures.push(`${label}: key ${k} does not occur in title/branch`);
  }
  if (change.repo.trim() === "") failures.push(`${label}: empty repo identity`);
}
