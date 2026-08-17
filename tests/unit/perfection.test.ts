// Regression tests for the 1.0.1 delta-review findings.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync as writeFileSyncFsRaw } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { meterOtel, parseOtelExport } from "../../src/meter/otel.ts";
import { meterTranscript } from "../../src/meter/meter.ts";
import { defaultConfig } from "../../src/core/config.ts";
import { finalizeEvent, type LedgerEntry, type UsageEvent } from "../../src/core/events.ts";
import { authoritative } from "../../src/core/streams.ts";
import { paceData } from "../../src/projections/pace.ts";
import { reconcile } from "../../src/sync/reconcile.ts";
import { defaultContext } from "../../src/adapters/contract.ts";
import { jiraAdapter } from "../../src/adapters/jira.ts";
import { acquireLock, releaseLock, _clearLock } from "../../src/meter/lock.ts";
import { makeOpened, makeUsage } from "../helpers/fixtures.ts";

const ROOT = join(import.meta.dirname, "..", "..");

function cumulativeLine(points: Array<{ session: string; type: string; model?: string; value: number; nano: string }>): string {
  return JSON.stringify({
    resourceMetrics: [{
      scopeMetrics: [{
        metrics: [{
          name: "claude_code.token.usage",
          sum: {
            aggregationTemporality: 2,
            dataPoints: points.map((p) => ({
              attributes: [
                { key: "session.id", value: { stringValue: p.session } },
                { key: "type", value: { stringValue: p.type } },
                { key: "model", value: { stringValue: p.model ?? "claude-opus-4-6" } },
              ],
              timeUnixNano: p.nano,
              asDouble: p.value,
            })),
          },
        }],
      }],
    }],
  });
}

test("otel finding 1: cumulative snapshots take the latest value, never the sum", () => {
  const raw = [
    cumulativeLine([{ session: "s-cum", type: "input", value: 1200, nano: "1786700000000000000" }]),
    cumulativeLine([{ session: "s-cum", type: "input", value: 1500, nano: "1786700100000000000" }]),
    cumulativeLine([{ session: "s-cum", type: "input", value: 1800, nano: "1786700200000000000" }]),
  ].join("\n");
  const parsed = parseOtelExport(raw);
  assert.equal(parsed.get("s-cum")!.models.get("claude-opus-4-6")!.input, 1800);

  // Delta temporality still sums.
  const delta = cumulativeLine([{ session: "s-d", type: "input", value: 100, nano: "1" }])
    .replace('"aggregationTemporality":2', '"aggregationTemporality":1');
  const parsedDelta = parseOtelExport([delta, delta].join("\n"));
  assert.equal(parsedDelta.get("s-d")!.models.get("claude-opus-4-6")!.input, 200);
});

test("otel finding 2: re-ingesting a grown export supersedes instead of double-counting", () => {
  const config = defaultConfig();
  const grown1 = cumulativeLine([{ session: "s-grow", type: "input", value: 1000, nano: "1786700000000000000" }]);
  const grown2 = [grown1, cumulativeLine([{ session: "s-grow", type: "input", value: 2500, nano: "1786700300000000000" }])].join("\n");

  const first = meterOtel({
    raw: grown1, config, ledgerEvents: [],
    existingUsage: [], existingSessions: [], existingExceptions: [],
  });
  assert.equal(first.newUsage.length, 1);
  const second = meterOtel({
    raw: grown2, config, ledgerEvents: [],
    existingUsage: first.newUsage, existingSessions: first.newSessions, existingExceptions: [],
  });
  assert.equal(second.newUsage.length, 1);
  assert.equal(second.newUsage[0]!.supersedes, first.newUsage[0]!.id, "grown ingest must supersede");
  assert.equal(second.newSessions[0]!.supersedes, first.newSessions[0]!.id);
  const auth = authoritative([...first.newUsage, ...second.newUsage]);
  assert.equal(auth.length, 1);
  assert.equal((auth[0] as UsageEvent).tokens.input, 2500);
  // Identical re-ingest after that: pure no-op.
  const third = meterOtel({
    raw: grown2, config, ledgerEvents: [],
    existingUsage: [...first.newUsage, ...second.newUsage],
    existingSessions: [...first.newSessions, ...second.newSessions], existingExceptions: [],
  });
  assert.equal(third.newUsage.length, 0);
  assert.equal(third.newSessions.length, 0);
});

test("otel finding 5: a transcript appearing later retires the otel events — transcript wins", () => {
  const config = defaultConfig();
  const raw = readFileSync(join(ROOT, "tests", "fixtures", "transcripts", "v2.1", "basic.jsonl"), "utf8");
  const otelFirst = meterOtel({
    raw: cumulativeLine([{ session: "11111111-aaaa-4bbb-8ccc-000000000001", type: "input", value: 999, nano: "1786700000000000000" }]),
    config, ledgerEvents: [], existingUsage: [], existingSessions: [], existingExceptions: [],
  });
  assert.equal(otelFirst.newUsage.length, 1);

  const out = meterTranscript({
    transcriptPath: "/tmp/basic.jsonl", raw, repo: "acme/platform", config,
    ledgerEvents: [], existingUsage: otelFirst.newUsage,
    existingSessions: otelFirst.newSessions, existingExceptions: [],
  });
  const retirements = out.newUsage.filter((u) => (u as { kind: string }).kind === "correction");
  assert.equal(retirements.length, 1);
  assert.equal(retirements[0]!.supersedes, otelFirst.newUsage[0]!.id);
  const auth = authoritative([...otelFirst.newUsage, ...out.newUsage]).filter((u) => u.kind === "usage");
  assert.ok(auth.every((u) => u.source === "transcript"), "only transcript events stay authoritative");
  // Receipt superseded too.
  assert.equal(out.newSessions[0]!.supersedes, otelFirst.newSessions[0]!.id);
});

test("reconcile finding 8: a re-resolved item clears the reopened flag once", () => {
  const opened = makeOpened();
  const { id: _i, ...openedBody } = opened;
  const shipped = finalizeEvent("ledger", {
    ...openedBody, ts: "2026-08-12T16:30:00Z", kind: "shipped" as const, supersedes: opened.id,
  }) as LedgerEntry;
  const { id: _s, ...shippedBody } = shipped;
  const reopenedEntry = finalizeEvent("ledger", {
    ...shippedBody, ts: "2026-08-14T09:00:00Z", kind: "correction" as const,
    supersedes: shipped.id, reopened: true, notes: "sync: reopened",
  }) as LedgerEntry;
  const items = jiraAdapter.normalizeItems(
    JSON.parse(readFileSync(join(ROOT, "tests", "fixtures", "adapters", "jira-search.json"), "utf8")),
    defaultContext(),
  ); // PLAT-482 is Done in the fixture
  const plan = reconcile(items, [], [opened, shipped, reopenedEntry], "2026-08-16T12:00:00Z");
  const redone = plan.corrections.find((c) => c.body.tracker_key === "PLAT-482");
  assert.ok(redone, "re-resolve correction proposed");
  assert.equal(redone!.body.reopened, false);
  assert.match(redone!.body.notes ?? "", /re-resolved in tracker/);
  // Applying it and reconciling again proposes nothing new for the key.
  const cleared = finalizeEvent("ledger", redone!.body) as LedgerEntry;
  const again = reconcile(items, [], [opened, shipped, reopenedEntry, cleared], "2026-08-17T12:00:00Z");
  assert.ok(!again.corrections.some((c) => c.body.tracker_key === "PLAT-482"));
});

test("reconcile finding 9: a correction over an OPEN entry still gets a shipped proposal", () => {
  const opened = makeOpened();
  const { id: _i, ...openedBody } = opened;
  const titleFix = finalizeEvent("ledger", {
    ...openedBody, ts: "2026-08-11T08:00:00Z", kind: "correction" as const,
    supersedes: opened.id, title: "Retry logic for checkout webhook (v2)",
  }) as LedgerEntry;
  const items = jiraAdapter.normalizeItems(
    JSON.parse(readFileSync(join(ROOT, "tests", "fixtures", "adapters", "jira-search.json"), "utf8")),
    defaultContext(),
  );
  const plan = reconcile(items, [], [opened, titleFix], "2026-08-16T12:00:00Z");
  const proposal = plan.shipped.find((b) => b.tracker_key === "PLAT-482");
  assert.ok(proposal, "open-chained correction must still ship when the item is done");
  assert.equal(proposal!.supersedes, titleFix.id);
  assert.equal(proposal!.title, "Retry logic for checkout webhook (v2)");
});

test("pace finding 7: corrections never re-date committed points out of the window", () => {
  const config = defaultConfig();
  config.allocations = [{ period: "2026-Q3", tokens_granted: 1_000_000, granted_at: "2026-07-01" }];
  const opened = makeOpened(); // origin ts 2026-08-10, 5 pts — inside Q3
  const { id: _i, ...openedBody } = opened;
  // A correction dated in Q4 must not move the commitment out of Q3.
  const lateCorrection = finalizeEvent("ledger", {
    ...openedBody, ts: "2026-10-05T09:00:00Z", kind: "correction" as const,
    supersedes: opened.id, notes: "late title fix",
  }) as LedgerEntry;
  const p = paceData([opened, lateCorrection], [makeUsage({})], [], config, "2026-08-16T00:00:00Z");
  assert.equal(p.committed_points, 5, "chain-origin windowing keeps the commitment in Q3");
});

test("lock: reap of a dead holder goes through atomic rename (single winner)", () => {
  const home = mkdtempSync(join(tmpdir(), "wb-lock2-"));
  try {
    // dead-pid lock
    acquireLock(home);
    releaseLock(home);
    writeFileSyncFsRaw(join(home, "pending-sessions", ".miner.lock"), "999999999", "utf8");
    assert.equal(acquireLock(home), true, "stale lock reaped and re-acquired");
    releaseLock(home);
    _clearLock(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
