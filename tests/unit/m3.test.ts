// M3 "Trustworthy at scale": waste diagnostics + rework/reopen tracking.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseTranscript } from "../../src/meter/transcript.ts";
import { meterTranscript } from "../../src/meter/meter.ts";
import { defaultConfig } from "../../src/core/config.ts";
import { finalizeEvent, type LedgerEntry } from "../../src/core/events.ts";
import { defaultContext } from "../../src/adapters/contract.ts";
import { jiraAdapter } from "../../src/adapters/jira.ts";
import { reconcile } from "../../src/sync/reconcile.ts";
import { reportData, spendData } from "../../src/projections/queries.ts";
import { makeOpened } from "../helpers/fixtures.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const OPTS = { branchKeyPattern: "[A-Z][A-Z0-9]+-[0-9]+" };

function wastefulRaw(): string {
  return readFileSync(join(ROOT, "tests", "fixtures", "transcripts", "v2.1", "wasteful.jsonl"), "utf8");
}

test("waste: repeated commands and reads are counted per turn — counts only, never paths", () => {
  const t = parseTranscript(wastefulRaw(), OPTS);
  assert.equal(t.turns.length, 2);
  // npm test ran 3× (2 retries); payment.test.ts read 2× (1 repeat).
  assert.deepEqual(t.turns[0]!.waste, { retried_commands: 2, repeated_reads: 1 });
  assert.deepEqual(t.turns[1]!.waste, { retried_commands: 0, repeated_reads: 0 });
});

test("waste: carried once per turn on usage events, rolled up per account", () => {
  const out = meterTranscript({
    transcriptPath: "/tmp/wasteful.jsonl",
    raw: wastefulRaw(),
    repo: "acme/platform",
    config: defaultConfig(),
    ledgerEvents: [],
    existingUsage: [],
    existingSessions: [],
    existingExceptions: [],
  });
  const withWaste = out.newUsage.filter((u) => u.waste != null);
  assert.equal(withWaste.length, 1);
  assert.deepEqual(withWaste[0]!.waste, { retried_commands: 2, repeated_reads: 1 });
  // Ledger content policy: no command text or file paths anywhere.
  const serialized = JSON.stringify(out.newUsage) + JSON.stringify(out.newSessions);
  assert.ok(!serialized.includes("npm test"));
  assert.ok(!serialized.includes("payment.test.ts"));

  const spend = spendData(out.newUsage, [], [], defaultConfig(), { from: null, to: null });
  const acc = spend.accounts.find((a) => a.account === "story:PLAT-490")!;
  assert.deepEqual(acc.waste, { retried_commands: 2, repeated_reads: 1 });
});

test("rework: a reopened tracker item proposes a flagged correction; reports count it", () => {
  const opened = makeOpened();
  const { id: _i, ...openedBody } = opened;
  const shipped = finalizeEvent("ledger", {
    ...openedBody, ts: "2026-08-12T16:30:00Z", kind: "shipped" as const, supersedes: opened.id,
  }) as LedgerEntry;

  // Tracker says the issue went back to In Progress after shipping.
  const raw = JSON.parse(
    readFileSync(join(ROOT, "tests", "fixtures", "adapters", "jira-search.json"), "utf8"),
  ) as { issues: Array<{ key: string; fields: Record<string, unknown> }> };
  const reopenedRaw = structuredClone(raw);
  const item = reopenedRaw.issues.find((i) => i.key === "PLAT-482")!;
  item.fields["status"] = { name: "In Progress", statusCategory: { key: "indeterminate" } };
  item.fields["resolutiondate"] = null;

  const items = jiraAdapter.normalizeItems(reopenedRaw, defaultContext());
  const plan = reconcile(items, [], [opened, shipped], "2026-08-16T12:00:00Z");
  assert.equal(plan.corrections.length, 1);
  assert.deepEqual(plan.corrections[0]!.drift, ['reopened (status "In Progress")']);
  assert.equal(plan.corrections[0]!.body.reopened, true);
  assert.match(plan.corrections[0]!.body.notes ?? "", /reopened in tracker/);

  // Applied, the report's costs section counts it — the unflattering number
  // that makes the flattering ones believable.
  const correction = finalizeEvent("ledger", plan.corrections[0]!.body) as LedgerEntry;
  const report = reportData([opened, shipped, correction], [], [], defaultConfig(), { from: null, to: null });
  assert.equal(report.costs.reopened_count, 1);
  assert.equal(report.shipped.length, 1); // still shipped — reopened, not erased

  // Re-reconciling doesn't propose the same correction twice.
  const again = reconcile(items, [], [opened, shipped, correction], "2026-08-17T12:00:00Z");
  assert.equal(again.corrections.length, 0);
});
