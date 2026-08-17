import { test } from "node:test";
import assert from "node:assert/strict";

import { forecastData, reportData, spendData } from "../../src/projections/queries.ts";
import { redact } from "../../src/report/redaction.ts";
import { defaultConfig } from "../../src/core/config.ts";
import { finalizeEvent, type LedgerEntry, type UsageEvent } from "../../src/core/events.ts";
import { makeOpened, makeUsage } from "../helpers/fixtures.ts";

function shippedFrom(opened: LedgerEntry, overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  const { id: _id, ...body } = opened;
  return finalizeEvent("ledger", {
    ...body,
    ts: overrides.ts ?? "2026-08-12T16:30:00Z",
    kind: "shipped" as const,
    supersedes: opened.id,
    artifacts: overrides.artifacts ?? {
      prs: ["https://github.com/acme/platform/pull/1932"],
      commits: [], deploy: "v2026.08.12", docs: [],
    },
    actual_hours: overrides.actual_hours ?? 4.5,
    claude_role: overrides.claude_role ?? ("co_wrote" as const),
    time_saved_hours: overrides.time_saved_hours ?? {
      low: 5.5, high: 11.5, confidence: "medium" as const, basis: "pre_registered" as const,
    },
    ...(overrides.points !== undefined ? { points: overrides.points } : {}),
    ...(overrides.tracker_key !== undefined ? { tracker_key: overrides.tracker_key } : {}),
    ...(overrides.title !== undefined ? { title: overrides.title } : {}),
  }) as LedgerEntry;
}

function usageSet(): UsageEvent[] {
  return [
    makeUsage({ ts: "2026-08-11T10:00:00Z", turnIndex: 1, tokens: { input: 100_000, output: 20_000, cache_read: 800_000, cache_creation: 80_000 } }),
    makeUsage({ ts: "2026-08-11T11:00:00Z", turnIndex: 2, tokens: { input: 50_000, output: 10_000, cache_read: 400_000, cache_creation: 40_000 } }),
    makeUsage({ ts: "2026-08-12T10:00:00Z", turnIndex: 3, account: "story:DATA-77", resolver: "session_branch", confidence: 0.6, tokens: { input: 30_000, output: 5_000, cache_read: 100_000, cache_creation: 15_000 } }),
    makeUsage({ ts: "2026-08-12T11:00:00Z", turnIndex: 4, account: "unattributed", resolver: "none", confidence: 1.0, tokens: { input: 10_000, output: 2_000, cache_read: 50_000, cache_creation: 8_000 } }),
  ];
}

test("spendData: accounts sorted by tokens, unattributed shown, open spend, health", () => {
  const config = defaultConfig();
  const opened = makeOpened();
  const shipped = shippedFrom(opened);
  const dataOpen = makeOpened({ tracker_key: "DATA-77", title: "Ingest dedupe", ts: "2026-08-11T09:00:00Z" });
  const spend = spendData(usageSet(), [], [opened, shipped, dataOpen], config, { from: null, to: null });

  assert.equal(spend.total_tokens, 1_720_000);
  assert.deepEqual(spend.accounts.map((a) => a.account), ["story:PLAT-482", "story:DATA-77", "unattributed"]);
  assert.equal(spend.accounts[0]!.tokens, 1_500_000);
  assert.equal(spend.unattributed_tokens, 70_000);
  assert.equal(spend.unattributed_pct, 4.1);
  // PLAT-482 shipped, so open spend is only DATA-77
  assert.deepEqual(spend.open_spend, [{ account: "story:DATA-77", tokens: 150_000 }]);
  // conf≥0.6 covers everything except unattributed
  assert.equal(spend.attribution_health.attributed_pct_conf_060, 95.9);
  assert.equal(spend.by_week.length, 1);
});

test("reportData: shipped receipts, efficiency, ranged time saved kept separate", () => {
  const config = defaultConfig();
  config.allocations = [{ period: "2026-Q3", tokens_granted: 50_000_000, granted_at: "2026-07-01" }];
  const opened = makeOpened();
  const shipped = shippedFrom(opened);
  const judged = shippedFrom(makeOpened({ tracker_key: "DATA-77", title: "Ingest dedupe", ts: "2026-08-11T09:00:00Z", escrow: null, estimate_without_claude_hours: null }), {
    ts: "2026-08-13T10:00:00Z",
    tracker_key: "DATA-77",
    title: "Ingest dedupe",
    points: 3,
    time_saved_hours: { low: 2, high: 6, confidence: "low", basis: "judgment" },
    artifacts: { prs: [], commits: [], deploy: null, docs: [] },
  });
  const report = reportData([opened, shipped, judged], usageSet(), [], config, { from: "2026-08-01T00:00:00Z", to: "2026-08-31T23:59:59Z" });

  assert.equal(report.shipped.length, 2);
  const plat = report.shipped.find((s) => s.tracker_key === "PLAT-482")!;
  assert.equal(plat.metered_tokens, 1_500_000);
  assert.equal(plat.escrowed, true);
  assert.equal(report.totals.points, 8);
  assert.equal(report.totals.merged_prs, 1);
  assert.equal(report.efficiency.tokens_per_point, Math.round(1_650_000 / 8));
  // ranges summed separately, never merged into judgment
  assert.deepEqual(report.time_saved.pre_registered_or_baseline, { low: 5.5, high: 11.5, entries: 1 });
  assert.deepEqual(report.time_saved.judgment, { low: 2, high: 6, entries: 1 });
  assert.equal(report.costs.utilization_pct, 3.4);
});

test("forecastData: median rate, low-data labeling", () => {
  const config = defaultConfig();
  const opened = makeOpened();
  const shipped = shippedFrom(opened);
  const f = forecastData([opened, shipped], usageSet(), config);
  assert.equal(f.tokens_per_point, 300_000); // 1.5M / 5 pts
  assert.equal(f.basis_entries, 1);
  assert.equal(f.low_confidence, true); // fewer than 5 shipped stories with data
  assert.deepEqual(f.hours_saved_per_point, { low: 1.1, high: 2.3 });
});

test("redaction: internal strips machine detail, external pseudonymizes deterministically", () => {
  const config = defaultConfig();
  const opened = makeOpened();
  const shipped = shippedFrom(opened);
  const report = reportData([opened, shipped], usageSet(), [], config, { from: null, to: null });

  const internal = redact(report, "internal");
  const internalJson = JSON.stringify(internal.data);
  assert.ok(!internalJson.includes("session_id"));
  assert.ok(internalJson.includes("PLAT-482")); // keys survive internally

  const external = redact(report, "external");
  const externalJson = JSON.stringify(external.data);
  assert.ok(!externalJson.includes("PLAT-482"), "tracker keys must not leak externally");
  assert.ok(!externalJson.includes("github.com"), "PR URLs must not leak externally");
  assert.ok(!externalJson.includes("Retry logic"), "titles must not leak externally");
  assert.ok(externalJson.includes("STORY-"), "pseudonymized accounts remain");
  assert.equal(external.mapping["PLAT-482"], "STORY-2"); // sorted: DATA-77 → STORY-1
  // numbers survive redaction — the receipt stays a receipt
  assert.match(externalJson, /1500000/);

  const again = redact(report, "external");
  assert.deepEqual(again.mapping, external.mapping); // deterministic
});
