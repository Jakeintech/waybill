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

/** The same closing-keyword grammar the adapters use (contract.ts) — the
 * kit re-finds every legal reference in the raw payload's string leaves. */
const CLOSING_RE =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+((?:[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+)?#[0-9]+)/gi;

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
  // An adapter may declare its tracker's own key shape (e.g. GitHub's
  // owner/repo#123); otherwise the configured branch pattern governs.
  const keyRe = new RegExp(`^(?:${adapter.keyPattern ?? ctx.keyPattern})$`);
  const seen = new Set<string>();
  for (const item of a) {
    checkItem(item, keyRe, leaves, seen, failures, adapter);
  }
  return { adapter: adapter.kind, passed: failures.length === 0, failures };
}

/** A composed key is not fabricated when it is a pure projection of a URL
 * leaf the kit has already verified verbatim: re-derive and compare. */
function keyDerivedFromPayload(
  item: WorkItem,
  leaves: Set<string>,
  adapter: TrackerAdapter,
): boolean {
  return (
    adapter.deriveKey !== undefined &&
    item.url !== null &&
    leaves.has(item.url) &&
    adapter.deriveKey(item.url) === item.key
  );
}

function checkItem(
  item: WorkItem,
  keyRe: RegExp,
  leaves: Set<string>,
  seen: Set<string>,
  failures: string[],
  adapter: TrackerAdapter,
): void {
  if (!keyRe.test(item.key)) failures.push(`${item.key}: key does not match the configured pattern`);
  if (seen.has(item.key)) failures.push(`${item.key}: duplicate key`);
  seen.add(item.key);
  if (!leaves.has(item.key) && !keyDerivedFromPayload(item, leaves, adapter)) {
    failures.push(`${item.key}: key not present in raw payload (fabricated?)`);
  }
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

/**
 * Own-data scoping (methodology §6, defense-in-depth): with the user's
 * identity in the context, records belonging to someone else must be
 * dropped even when a mis-scoped query fetched them — and with no identity
 * configured, the adapter must NOT over-drop (scoped queries are the
 * primary defense; an adapter that cannot check keeps the record).
 *
 * `foreign` names the fixture records that belong to someone else — item
 * keys for a tracker adapter, urls (or titles when url-less) for a git-host
 * adapter. The kit refuses a fixture whose foreign records don't survive
 * the no-identity run: a check that never sees the foreign record proves
 * nothing.
 */
export function checkOwnDataScoping(
  adapter: TrackerAdapter | GitHostAdapter,
  raw: unknown,
  ctx: AdapterContext,
  foreign: string[],
): ConformanceReport {
  const failures: string[] = [];
  const anonCtx: AdapterContext = {
    ...ctx,
    identityEmails: [],
    githubLogin: null,
    jiraAccountId: null,
    gitlabUsername: null,
    linearUserId: null,
  };
  const labels = (c: AdapterContext): Set<string> =>
    "normalizeItems" in adapter
      ? new Set(adapter.normalizeItems(raw, c).map((i) => i.key))
      : new Set(adapter.normalizeChanges(raw, c).map((ch) => ch.url ?? ch.title));
  const withIdentity = labels(ctx);
  const withoutIdentity = labels(anonCtx);

  for (const f of foreign) {
    if (!withoutIdentity.has(f)) {
      failures.push(`fixture: foreign record ${f} absent even with no identity — this check proves nothing`);
    }
    if (withIdentity.has(f)) {
      failures.push(`${f}: someone else's record survived the identity check`);
    }
  }
  for (const l of withIdentity) {
    if (!withoutIdentity.has(l)) {
      failures.push(`${l}: appears only WITH identity set — identity must only ever narrow the output`);
    }
  }
  return { adapter: `${adapter.kind}:own-data`, passed: failures.length === 0, failures };
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
  // Legal closing refs: every keyword-attached reference anywhere in the
  // raw payload's text, kept in both bare (#15) and full (o/r#15) forms.
  const closable = new Set<string>();
  for (const leaf of leaves) {
    for (const m of leaf.matchAll(CLOSING_RE)) closable.add(m[1]!);
  }
  for (const change of a) {
    checkChange(change, keyRe, leaves, closable, failures);
  }
  return { adapter: adapter.kind, passed: failures.length === 0, failures };
}

function checkChange(
  change: MergedChange,
  keyRe: RegExp,
  leaves: Set<string>,
  closable: Set<string>,
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
  // A closes ref is legal only if the payload actually carries a closing
  // keyword for it — verbatim cross-repo form, or the bare form expanded
  // against this change's own repo.
  for (const k of change.closes ?? []) {
    const bare = k.startsWith(`${change.repo}#`) ? k.slice(change.repo.length) : null;
    if (!closable.has(k) && !(bare !== null && closable.has(bare))) {
      failures.push(`${label}: closes ${k} has no closing keyword in the raw payload`);
    }
  }
  if (change.repo.trim() === "") failures.push(`${label}: empty repo identity`);
}
