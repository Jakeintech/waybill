import type { Audience } from "../core/config.ts";

/**
 * Audience redaction (D12). Applied to query output before it reaches a
 * report renderer:
 *   self      everything — the user's own books.
 *   internal  drops machine-local detail (session ids, paths); keeps keys,
 *             repos, URLs, numbers.
 *   external  additionally pseudonymizes identifiers: tracker keys become
 *             STORY-n / EPIC-n, repos become repo-n, adhoc labels become
 *             adhoc-n; titles and URLs are dropped. Numbers survive —
 *             receipts stay checkable via the internal version on request.
 * Pseudonym assignment is deterministic: sorted first, then numbered.
 */
export interface RedactionResult {
  data: unknown;
  mapping: Record<string, string>;
}

const SESSION_KEYS = new Set(["session_id", "transcript_path", "cwd", "sessions"]);
const EXTERNAL_DROP = new Set(["title", "prs", "url", "urls", "deploy", "notes"]);

function collectStrings(value: unknown, field: string, into: Set<string>): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, field, into);
    return;
  }
  for (const [k, v] of Object.entries(value)) {
    if (k === field && typeof v === "string") into.add(v);
    else collectStrings(v, field, into);
  }
}

export function redact(data: unknown, audience: Audience): RedactionResult {
  if (audience === "self") return { data, mapping: {} };

  const clone = JSON.parse(JSON.stringify(data)) as unknown;
  stripKeys(clone, SESSION_KEYS);
  if (audience === "internal") return { data: clone, mapping: {} };

  // external: build deterministic pseudonym maps.
  const keys = new Set<string>();
  collectStrings(clone, "tracker_key", keys);
  collectStrings(clone, "key", keys); // e.g. the story-cost payload's key field
  collectAccountKeys(clone, keys); // keys inside "story:<KEY>" account strings
  const epicKeys = new Set<string>();
  collectStrings(clone, "epic_key", epicKeys);
  const epicNames = new Set<string>();
  collectStrings(clone, "epic_name", epicNames);
  const repos = new Set<string>();
  collectStrings(clone, "repo", repos);

  const adhocs = new Set<string>();
  collectAdhocLabels(clone, adhocs);

  const mapping: Record<string, string> = {};
  let n = 0;
  for (const k of [...keys].sort()) mapping[k] = `STORY-${++n}`;
  n = 0;
  for (const k of [...epicKeys].sort()) mapping[k] = `EPIC-${++n}`;
  n = 0;
  for (const k of [...epicNames].sort()) mapping[k] = `Epic ${++n}`;
  n = 0;
  for (const k of [...repos].sort()) mapping[k] = `repo-${++n}`;
  n = 0;
  for (const k of [...adhocs].sort()) mapping[`adhoc:${k}`] = `adhoc-${++n}`;

  const redacted = rewrite(clone, mapping);
  return { data: redacted, mapping };
}

function collectAdhocLabels(value: unknown, into: Set<string>): void {
  if (typeof value === "string") {
    if (value.startsWith("adhoc:")) into.add(value.slice(6));
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectAdhocLabels(v, into);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const v of Object.values(value)) collectAdhocLabels(v, into);
  }
}

function collectAccountKeys(value: unknown, into: Set<string>): void {
  if (typeof value === "string") {
    if (value.startsWith("story:")) into.add(value.slice(6));
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectAccountKeys(v, into);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const v of Object.values(value)) collectAccountKeys(v, into);
  }
}

function stripKeys(value: unknown, drop: Set<string>): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const v of value) stripKeys(v, drop);
    return;
  }
  const obj = value as Record<string, unknown>;
  for (const k of Object.keys(obj)) {
    // Strip identifier-bearing values only: AccountSpend.sessions is a
    // plain count and stays.
    if (drop.has(k) && typeof obj[k] !== "number") delete obj[k];
    else stripKeys(obj[k], drop);
  }
}

function rewrite(value: unknown, mapping: Record<string, string>): unknown {
  if (typeof value === "string") {
    // account strings like "story:PLAT-482" and adhoc labels
    if (value.startsWith("story:")) {
      const key = value.slice(6);
      return `story:${mapping[key] ?? key}`;
    }
    if (value.startsWith("adhoc:")) {
      // Distinct labels stay distinguishable (adhoc-1, adhoc-2, …) without
      // leaking what they were called.
      return `adhoc:${mapping[value] ?? "redacted"}`;
    }
    return mapping[value] ?? value;
  }
  if (Array.isArray(value)) return value.map((v) => rewrite(v, mapping));
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (EXTERNAL_DROP.has(k)) continue;
      out[k] = rewrite(v, mapping);
    }
    return out;
  }
  return value;
}
