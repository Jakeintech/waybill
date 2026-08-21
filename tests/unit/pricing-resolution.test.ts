import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeModelId, resolveRate, unpricedModels } from "../../src/core/pricing-resolve.ts";
import { loadPricingBundle } from "../../src/core/pricing-bundle.ts";
import { defaultConfig } from "../../src/core/config.ts";
import { applyBundledPricing } from "../../src/cli/cmd-pricing.ts";
import { priceTokens } from "../../src/meter/meter.ts";
import type { ModelPricing } from "../../src/core/config.ts";

const RATE: ModelPricing = {
  input_per_mtok: 5,
  output_per_mtok: 25,
  cache_read_per_mtok: 0.5,
  cache_write_5m_per_mtok: 6.25,
  cache_write_1h_per_mtok: 10,
};

function pricingWith(models: Record<string, ModelPricing>) {
  return { version: "2026-08-17", unknown_model_policy: "tokens_only" as const, models };
}

test("normalizeModelId: strips only a trailing -YYYYMMDD date stamp", () => {
  assert.equal(normalizeModelId("claude-sonnet-4-5-20250929"), "claude-sonnet-4-5");
  assert.equal(normalizeModelId("claude-opus-4-6"), "claude-opus-4-6"); // minor version is not a date
  assert.equal(normalizeModelId("claude-fable-5"), "claude-fable-5");
  assert.equal(normalizeModelId("claude-haiku-4-5-20251001"), "claude-haiku-4-5");
});

test("resolveRate: exact match wins; dated transcript id finds undated table key", () => {
  const pricing = pricingWith({ "claude-opus-4-6": RATE });
  assert.equal(resolveRate(pricing, "claude-opus-4-6")!.rate_model, "claude-opus-4-6");
  // A dated variant of the same family resolves to the undated key.
  assert.equal(resolveRate(pricing, "claude-opus-4-6-20260120")!.rate_model, "claude-opus-4-6");
});

test("resolveRate: undated transcript id finds the latest dated table key", () => {
  const pricing = pricingWith({
    "claude-opus-4-5-20251101": RATE,
    "claude-opus-4-5-20250601": { ...RATE, input_per_mtok: 4 },
  });
  const r = resolveRate(pricing, "claude-opus-4-5");
  assert.equal(r!.rate_model, "claude-opus-4-5-20251101"); // latest date, deterministic
  // A differently dated transcript id also resolves (same normalized family id).
  assert.equal(resolveRate(pricing, "claude-opus-4-5-20260101")!.rate_model, "claude-opus-4-5-20251101");
});

test("resolveRate: undated key preferred over dated when both exist", () => {
  const pricing = pricingWith({
    "claude-opus-4-5": { ...RATE, input_per_mtok: 7 }, // user-set family rate
    "claude-opus-4-5-20251101": RATE,
  });
  const r = resolveRate(pricing, "claude-opus-4-5-20250601");
  assert.equal(r!.rate_model, "claude-opus-4-5");
  assert.equal(r!.rates.input_per_mtok, 7);
});

test("resolveRate: families never cross-match; unknown stays null", () => {
  const pricing = pricingWith({ "claude-opus-4": RATE });
  assert.equal(resolveRate(pricing, "claude-opus-4-6"), null);
  assert.equal(resolveRate(pricing, "claude-opus-4-6-20260120"), null);
  assert.equal(resolveRate(pricing, "some-other-model"), null);
});

test("bundled rates price every realistic transcript id shape", () => {
  const config = defaultConfig();
  applyBundledPricing(config);
  const transcriptIds = [
    "claude-fable-5",
    "claude-opus-5",
    "claude-sonnet-5",
    "claude-haiku-4-5-20251001",
    "claude-opus-4-6",
    "claude-opus-4-6-20260120", // dated variant of an undated bundle key
    "claude-opus-4-5-20251101",
    "claude-sonnet-4-5-20250929",
    "claude-sonnet-4-6-20260215", // dated variant
    "claude-fable-5-20260801", // hypothetical dated variant of a top model
  ];
  for (const id of transcriptIds) {
    assert.ok(resolveRate(config.pricing, id) !== null, `bundled rates must resolve ${id}`);
  }
  assert.deepEqual(unpricedModels(config.pricing, transcriptIds), []);
});

test("unpricedModels: distinct, sorted, skips the 'unknown' placeholder", () => {
  const pricing = pricingWith({ "claude-opus-4-6": RATE });
  const models = ["claude-opus-4-6", "mystery-b", "mystery-a", "mystery-b", "unknown"];
  assert.deepEqual(unpricedModels(pricing, models), ["mystery-a", "mystery-b"]);
});

test("priceTokens: dated transcript model prices via the resolved family key", () => {
  const config = defaultConfig();
  applyBundledPricing(config);
  const cost = priceTokens(config, "claude-opus-4-6-20260120", {
    input: 1_000_000,
    output: 0,
    cache_read: 0,
    cache_creation: 0,
    cache_creation_5m: 0,
    cache_creation_1h: 0,
  });
  assert.ok(cost !== null, "dated model id must price via the undated bundle key");
  assert.equal(cost!.value, 5); // claude-opus-4-6 input rate is 5 USD/mtok
  assert.equal(cost!.pricing_version, loadPricingBundle().last_updated);
});
