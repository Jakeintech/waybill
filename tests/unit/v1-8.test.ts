// v1.8 "Many readers" batch — the engine side of the reader presets:
// shipped report rows carry per-item work_type, session count, and metered
// USD (invoice / disclosure / incident renderings), and those fields
// survive redaction the right way (counts stay, identifiers don't).
import { test } from "node:test";
import assert from "node:assert/strict";

import { reportData } from "../../src/projections/queries.ts";
import { redact } from "../../src/report/redaction.ts";
import { defaultConfig } from "../../src/core/config.ts";
import { finalizeEvent, type LedgerEntry } from "../../src/core/events.ts";
import { makeOpened, makeUsage } from "../helpers/fixtures.ts";

function shippedFrom(opened: LedgerEntry, overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  const { id: _id, ...body } = opened;
  return finalizeEvent("ledger", {
    ...body,
    ts: overrides.ts ?? "2026-08-12T16:30:00Z",
    kind: "shipped" as const,
    supersedes: opened.id,
    artifacts: { prs: ["https://github.com/acme/platform/pull/1932"], commits: [], deploy: null, docs: [] },
    actual_hours: 4.5,
    claude_role: "co_wrote" as const,
  }) as LedgerEntry;
}

const S2 = "22222222-aaaa-4bbb-8ccc-000000000002";

test("shipped rows: work_type, distinct-session count, and per-item metered USD", () => {
  const config = defaultConfig();
  const opened = makeOpened({ work_type: "incident" });
  const ledger = [opened, shippedFrom(opened)];
  const usage = [
    makeUsage({ ts: "2026-08-11T10:00:00Z", turnIndex: 1, cost: { value: 0.25, pricing_version: "2026-08-01" }, tokens: { input: 100_000, output: 0, cache_read: 0, cache_creation: 0 } }),
    makeUsage({ ts: "2026-08-11T11:00:00Z", turnIndex: 2, session_id: S2, cost: { value: 0.15, pricing_version: "2026-08-01" }, tokens: { input: 50_000, output: 0, cache_read: 0, cache_creation: 0 } }),
    // Same story, same session as turn 1 — must not inflate the count.
    makeUsage({ ts: "2026-08-11T12:00:00Z", turnIndex: 3, tokens: { input: 10_000, output: 0, cache_read: 0, cache_creation: 0 } }),
  ];
  const report = reportData(ledger, usage, [], config, { from: null, to: null });
  const row = report.shipped[0]!;
  assert.equal(row.work_type, "incident");
  assert.equal(row.sessions, 2);
  assert.equal(row.metered_tokens, 160_000);
  assert.equal(row.metered_cost_usd, 0.4);
});

test("shipped rows: unpriced story reports null USD, never $0; keyless entry reports zero sessions", () => {
  const config = defaultConfig();
  const priced = makeOpened();
  const keyless = makeOpened({ tracker_key: null, title: "Adhoc hardening", ts: "2026-08-11T09:30:00Z", escrow: null });
  const ledger = [priced, shippedFrom(priced), keyless, shippedFrom(keyless, { ts: "2026-08-12T17:00:00Z" })];
  const usage = [makeUsage({ ts: "2026-08-11T10:00:00Z", turnIndex: 1 })]; // no cost
  const report = reportData(ledger, usage, [], config, { from: null, to: null });
  const pricedRow = report.shipped.find((s) => s.tracker_key === "PLAT-482")!;
  assert.equal(pricedRow.metered_cost_usd, null);
  const keylessRow = report.shipped.find((s) => s.tracker_key === null)!;
  assert.equal(keylessRow.sessions, 0);
  assert.equal(keylessRow.metered_cost_usd, null);
});

test("redaction: session counts and work_type survive external; identifiers do not", () => {
  const config = defaultConfig();
  const opened = makeOpened();
  const ledger = [opened, shippedFrom(opened)];
  const usage = [
    makeUsage({ ts: "2026-08-11T10:00:00Z", turnIndex: 1 }),
    makeUsage({ ts: "2026-08-11T11:00:00Z", turnIndex: 2, session_id: S2 }),
  ];
  const report = reportData(ledger, usage, [], config, { from: null, to: null });
  const { data } = redact(report, "external");
  const row = (data as { shipped: Array<Record<string, unknown>> }).shipped[0]!;
  assert.equal(row["sessions"], 2, "the count is a number — it survives every level");
  assert.equal(row["work_type"], "feature");
  assert.equal(row["tracker_key"], "STORY-1", "pseudonymized, not dropped");
  assert.equal("title" in row, false);
  assert.equal("prs" in row, false);

  const internal = redact(report, "internal").data as { shipped: Array<Record<string, unknown>> };
  assert.equal(internal.shipped[0]!["sessions"], 2);
  assert.equal(internal.shipped[0]!["title"], "Retry logic for checkout webhook");
});
