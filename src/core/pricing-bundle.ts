import { readFileSync } from "node:fs";
import { findReferenceFile } from "./references.ts";
import type { ModelPricing } from "./config.ts";

export interface PricingBundle {
  last_updated: string;
  source: string;
  models: Record<string, ModelPricing>;
  aliases: Record<string, string>;
}

let cached: PricingBundle | null = null;

export function loadPricingBundle(): PricingBundle {
  if (cached) return cached;
  const path = findReferenceFile("anthropic-pricing.json");
  cached = JSON.parse(readFileSync(path, "utf8")) as PricingBundle;
  return cached;
}

/**
 * Resolves an exact model id, a bundled alias (e.g. "claude-sonnet-4" →
 * "claude-sonnet-4-6"), or a family alias to a key that actually exists in
 * the bundle's `models` map. Returns null when nothing matches.
 *
 * Aliases are IMPORT-TIME conveniences only (`pricing import --model
 * claude-sonnet-4`) and may deliberately point at a newer family member.
 * Price-time lookup (core/pricing-resolve) never uses them and never
 * crosses families — an alias can be generous, a metered cost cannot.
 */
export function resolveBundledModel(bundle: PricingBundle, nameOrAlias: string): string | null {
  // Own-property checks: `pricing import --model constructor` must miss,
  // not resolve to an Object.prototype member.
  if (Object.hasOwn(bundle.models, nameOrAlias)) return nameOrAlias;
  const aliased = Object.hasOwn(bundle.aliases, nameOrAlias) ? bundle.aliases[nameOrAlias] : undefined;
  if (aliased && Object.hasOwn(bundle.models, aliased)) return aliased;
  return null;
}
