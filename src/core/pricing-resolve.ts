import type { Config, ModelPricing } from "./config.ts";

/**
 * Strip a trailing `-YYYYMMDD` date stamp. Transcripts carry dated API ids
 * (`claude-sonnet-4-5-20250929`) while the pricing table may hold the
 * undated family id (`claude-sonnet-4-5`) or a differently dated one —
 * the same rates either way. Only the date stamp is stripped; families
 * never cross-match (`claude-opus-4-6` does not normalize to
 * `claude-opus-4`).
 */
export function normalizeModelId(id: string): string {
  return id.replace(/-\d{8}$/, "");
}

export interface RateResolution {
  /** The pricing-table key that supplied the rates — differs from the
   * metered model id only by the `-YYYYMMDD` date stamp, never by family. */
  rate_model: string;
  rates: ModelPricing;
}

/**
 * Resolve a metered model id to configured rates. Deterministic:
 * exact key first; else the key with the same date-normalized form —
 * preferring the undated key when present, otherwise the latest-dated
 * variant. Returns null when nothing matches (unknown_model_policy:
 * tokens_only takes over — a rate is never guessed).
 */
export function resolveRate(
  pricing: Config["pricing"],
  model: string,
): RateResolution | null {
  // Own-property check: transcripts are untrusted input, and a model id
  // like "constructor" must not resolve to an Object.prototype member.
  if (Object.hasOwn(pricing.models, model)) {
    return { rate_model: model, rates: pricing.models[model]! };
  }
  const wanted = normalizeModelId(model);
  let best: string | null = null;
  for (const key of Object.keys(pricing.models)) {
    if (normalizeModelId(key) !== wanted) continue;
    if (key === wanted) {
      best = key; // the undated family key is canonical
      break;
    }
    if (best === null || key > best) best = key; // latest dated variant
  }
  return best === null ? null : { rate_model: best, rates: pricing.models[best]! };
}

/** Distinct metered models that resolve to no configured rate, sorted —
 * the honesty check behind "costs appear from day one". */
export function unpricedModels(
  pricing: Config["pricing"],
  models: Iterable<string>,
): string[] {
  const missing = new Set<string>();
  for (const m of models) {
    if (m === "unknown") continue; // transcript carried no model id at all
    if (resolveRate(pricing, m) === null) missing.add(m);
  }
  return [...missing].sort();
}

/** Distinct models whose usage actually carries tokens — the model list
 * the unpriced check should see. Zero-token events (legacy placeholder
 * ids like "<synthetic>", written before the meter skipped zero-usage
 * messages) price nothing: a model seen only through them must never be
 * named as unpriced, because status and pricing show print a real fix
 * for every model they name and there is nothing to fix. Same principle
 * as unpricedModels' "unknown" exclusion. */
export function meteredModels(
  usage: Iterable<{ model: string; tokens: { input: number; output: number; cache_read: number; cache_creation: number } }>,
): string[] {
  const seen = new Set<string>();
  for (const u of usage) {
    const t = u.tokens;
    if (t.input + t.output + t.cache_read + t.cache_creation > 0) seen.add(u.model);
  }
  return [...seen].sort();
}
