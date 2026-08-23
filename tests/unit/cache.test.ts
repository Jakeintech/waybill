import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";

import { cacheData } from "../../src/projections/queries.ts";
import { saveConfig } from "../../src/core/config.ts";
import { appendEvents } from "../../src/core/streams.ts";
import { goldenMeterConfig } from "../helpers/meter-golden.ts";
import { makeSessionReceipt, makeUsage, tempHome } from "../helpers/fixtures.ts";

// S-04: `query cache` — what the bill is actually made of. The golden
// config prices claude-opus-4-6 at 15/75 in/out, 1.5 cache-read (0.1×),
// 18.75 5m-write (1.25×), 30 1h-write (2×), so every figure below is
// hand-derivable from the fixture tokens.

function fixtureUsage() {
  return [
    // 1M in + 10M read + 2M 5m-write → 15 + 15 + 37.5 = 67.5 effective;
    // list: (1M+10M+2M)×15/1M + 0 = 195.
    makeUsage({
      ts: "2026-08-10T10:00:00Z", turnIndex: 1,
      tokens: { input: 1_000_000, output: 0, cache_read: 10_000_000, cache_creation: 2_000_000, cache_creation_5m: 2_000_000, cache_creation_1h: 0 },
    }),
    // 1M out + 1M 1h-write → 75 + 30 = 105 effective; list: 75 + 15 = 90.
    makeUsage({
      ts: "2026-08-10T11:00:00Z", turnIndex: 2,
      tokens: { input: 0, output: 1_000_000, cache_read: 0, cache_creation: 1_000_000, cache_creation_5m: 0, cache_creation_1h: 1_000_000 },
    }),
    // Unpriced model: volume counts, dollars do not — disclosed via covered_pct.
    makeUsage({
      ts: "2026-08-10T12:00:00Z", turnIndex: 3, model: "some-unpriced-model", account: "unattributed",
      tokens: { input: 500_000, output: 0, cache_read: 0, cache_creation: 0, cache_creation_5m: 0, cache_creation_1h: 0 },
    }),
  ];
}

test("cacheData: volume by tier, derived effective vs list, net saving, coverage disclosed", () => {
  const data = cacheData(fixtureUsage(), goldenMeterConfig(), { from: null, to: null });

  assert.equal(data.total_tokens, 15_500_000);
  assert.deepEqual(data.tokens, {
    input: 1_500_000, output: 1_000_000, cache_read: 10_000_000,
    cache_creation: 3_000_000, cache_creation_5m: 2_000_000, cache_creation_1h: 1_000_000,
  });
  assert.equal(data.cache_read_pct, 64.5); // 10M / 15.5M

  assert.equal(data.billed.effective_usd, 172.5); // 67.5 + 105
  assert.equal(data.billed.list_equivalent_usd, 285); // 195 + 90
  assert.equal(data.billed.saved_usd, 112.5); // net of write premiums
  assert.equal(data.billed.cache_read_share_of_billed_pct, 8.7); // 15 / 172.5
  assert.equal(data.billed.covered_pct, 96.8); // 15M priced of 15.5M
  assert.equal(data.billed.basis, "list_price_equivalent_derived");

  // Honesty floor: the unattributed share travels on the payload.
  assert.equal(data.unattributed_tokens, 500_000);
  assert.equal(data.unattributed_pct, 3.2);

  // Unpriced model row carries volume and a null cost — never $0.
  const unpriced = data.by_model.find((m) => m.model === "some-unpriced-model");
  assert.ok(unpriced);
  assert.equal(unpriced.effective_usd, null);
});

test("cacheData: empty rate table yields null dollars, never $0; empty window yields zeros", () => {
  const config = goldenMeterConfig();
  config.pricing = { version: null, unknown_model_policy: "tokens_only", models: {} };
  const data = cacheData(fixtureUsage(), config, { from: null, to: null });
  assert.equal(data.billed.effective_usd, null);
  assert.equal(data.billed.saved_usd, null);
  assert.equal(data.billed.covered_pct, 0);
  assert.equal(data.total_tokens, 15_500_000); // volume is volume, priced or not

  const empty = cacheData([], goldenMeterConfig(), { from: null, to: null });
  assert.equal(empty.total_tokens, 0);
  assert.equal(empty.cache_read_pct, 0);
  assert.equal(empty.billed.effective_usd, null);
});

test("query cache through the CLI: the envelope carries audience, detail, and the honesty fields", () => {
  const home = tempHome();
  try {
    saveConfig(home, goldenMeterConfig());
    const usage = fixtureUsage();
    appendEvents(home, "usage", usage);
    appendEvents(home, "sessions", [makeSessionReceipt(usage)]);
    const ROOT = join(import.meta.dirname, "..", "..");
    const out = JSON.parse(
      execFileSync(process.execPath, [join(ROOT, "src", "cli", "main.ts"), "query", "cache"], {
        encoding: "utf8",
        env: { ...process.env, WAYBILL_HOME: home },
      }),
    ) as {
      audience: string;
      detail: string;
      data: { billed: { basis: string; saved_usd: number }; unattributed_pct: number; cache_read_pct: number };
    };
    assert.equal(out.audience, "self");
    assert.equal(out.data.billed.basis, "list_price_equivalent_derived");
    assert.equal(out.data.billed.saved_usd, 112.5);
    assert.equal(out.data.unattributed_pct, 3.2);
    assert.equal(out.data.cache_read_pct, 64.5);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
