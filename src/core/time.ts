/**
 * The one timestamp module (architecture review, recommendation #1).
 * Everything that validates, compares, or windows a timestamp goes through
 * here — the review traced one failure class with eight faces to scattered
 * Date.parse-permissive validation and lexicographic comparison. Engine
 * events are ISO-8601 UTC; user-supplied bounds must be ISO-shaped
 * (windowing would otherwise silently match nothing); comparisons are
 * instant-based with a deterministic string fallback.
 */

/** A user-suppliable window bound: date-only or full ISO timestamp. */
export const ISO_BOUND_RE =
  /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

export function isIsoBound(v: string): boolean {
  return ISO_BOUND_RE.test(v) && !Number.isNaN(Date.parse(v));
}

/** A full event timestamp (the shard layout depends on the YYYY-MM prefix,
 * so a merely parseable ts is corruption to report, not a value to use). */
export function isIsoTimestamp(v: unknown): boolean {
  return (
    typeof v === "string" &&
    /^\d{4}-\d{2}-\d{2}T/.test(v) &&
    !Number.isNaN(Date.parse(v))
  );
}

/**
 * Compare two timestamps as instants; unparseable values fall back to
 * string order so the result is total and deterministic either way.
 */
export function compareInstants(a: string, b: string): number {
  const pa = Date.parse(a);
  const pb = Date.parse(b);
  if (!Number.isNaN(pa) && !Number.isNaN(pb) && pa !== pb) return pa - pb;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Inclusive window membership by instant — a second-precision "…59Z" must
 * not sort after a "…59.999Z" day-end bound the way strings do. Falls back
 * to lexicographic bounds when anything fails to parse.
 */
export function inWindow(ts: string, from: string | null, to: string | null): boolean {
  const t = Date.parse(ts);
  const f = from !== null ? Date.parse(from) : null;
  const o = to !== null ? Date.parse(to) : null;
  if (!Number.isNaN(t) && (f === null || !Number.isNaN(f)) && (o === null || !Number.isNaN(o))) {
    if (f !== null && t < f) return false;
    if (o !== null && t > o) return false;
    return true;
  }
  if (from !== null && ts < from) return false;
  if (to !== null && ts > to) return false;
  return true;
}
