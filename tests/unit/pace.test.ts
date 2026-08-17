import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { paceData, periodWindow, renderPace } from "../../src/projections/pace.ts";
import { defaultConfig } from "../../src/core/config.ts";
import { finalizeEvent, type LedgerEntry } from "../../src/core/events.ts";
import { appendEvents } from "../../src/core/streams.ts";
import { saveConfig } from "../../src/core/config.ts";
import { makeOpened, makeUsage } from "../helpers/fixtures.ts";

const ROOT = join(import.meta.dirname, "..", "..");

function cli(home: string, args: string[]): string {
  return execFileSync(process.execPath, [join(ROOT, "src", "cli", "main.ts"), ...args], {
    encoding: "utf8",
    env: { ...process.env, WAYBILL_HOME: home },
  });
}

test("periodWindow parses quarters, months, and falls back to granted_at+90d", () => {
  const q3 = periodWindow("2026-Q3", "2026-07-01");
  assert.equal(q3.from, "2026-07-01T00:00:00Z");
  assert.ok(q3.to.startsWith("2026-09-30T23:59"));
  const aug = periodWindow("2026-08", "2026-08-01");
  assert.equal(aug.from, "2026-08-01T00:00:00Z");
  assert.ok(aug.to.startsWith("2026-08-31T23:59"));
  const fallback = periodWindow("summer grant", "2026-07-01T00:00:00Z");
  assert.equal(fallback.from, "2026-07-01T00:00:00Z");
  assert.equal(fallback.to, "2026-09-29T00:00:00Z");
});

function paceFixture() {
  const config = defaultConfig();
  config.allocations = [{ period: "2026-Q3", tokens_granted: 10_000_000, granted_at: "2026-07-01" }];
  config.budgets.epics = { "PLAT-401": 5_000_000 };
  const opened = makeOpened({ epic_key: "PLAT-401" }); // 5 pts committed
  const { id: _i, ...openedBody } = opened;
  const shipped = finalizeEvent("ledger", {
    ...openedBody, ts: "2026-08-12T16:30:00Z", kind: "shipped" as const, supersedes: opened.id,
  }) as LedgerEntry;
  const openOnly = makeOpened({
    tracker_key: "DATA-77", title: "Ingest dedupe", points: 5, epic_key: null,
    ts: "2026-08-11T09:00:00Z",
  });
  const usage = [
    makeUsage({ ts: "2026-08-11T10:00:00Z", tokens: { input: 4_000_000, output: 200_000, cache_read: 1_800_000, cache_creation: 0 } }),
    makeUsage({ ts: "2026-08-12T10:00:00Z", turnIndex: 2, account: "story:DATA-77", resolver: "session_branch", confidence: 0.6, tokens: { input: 2_000_000, output: 0, cache_read: 0, cache_creation: 0 } }),
  ];
  return { config, ledger: [opened, shipped, openOnly], usage };
}

test("paceData: spend vs linear pace, work-weighted pace, epic envelopes, thresholds", () => {
  const { config, ledger, usage } = paceFixture();
  const p = paceData(ledger, usage, [], config, "2026-08-16T00:00:00Z");
  assert.equal(p.spent_tokens, 8_000_000);
  assert.equal(p.spent_pct, 80);
  assert.equal(p.committed_points, 10);
  assert.equal(p.shipped_points, 5);
  assert.equal(p.shipped_pct_of_committed, 50);
  assert.equal(p.epics[0]!.epic_key, "PLAT-401");
  assert.equal(p.epics[0]!.spent_tokens, 6_000_000); // PLAT-482 usage rolls up via its entry
  assert.deepEqual(p.thresholds_crossed, [80]);
  assert.deepEqual(p.biggest_open_spend, { account: "story:DATA-77", tokens: 2_000_000 });
  const text = renderPace(p);
  assert.match(text, /80%.*50%|50% of committed|Work-weighted: 5 of 10/s);
  assert.match(text, /Worth a look, not an alarm/);
});

test("pace --notice fires once per crossing, then stays quiet", () => {
  const home = mkdtempSync(join(tmpdir(), "wb-pace-"));
  try {
    const { config, ledger, usage } = paceFixture();
    saveConfig(home, config);
    appendEvents(home, "ledger", ledger);
    appendEvents(home, "usage", usage);
    const first = cli(home, ["pace", "--notice", "--now", "2026-08-16T00:00:00Z"]);
    assert.match(first, /80% of the 2026-Q3 token grant is spent/);
    assert.match(first, /Worth a look, not an alarm/);
    const second = cli(home, ["pace", "--notice", "--now", "2026-08-16T01:00:00Z"]);
    assert.equal(second, "", "same threshold must not notify twice");
    // Crossing 100% notifies again.
    appendEvents(home, "usage", [
      makeUsage({ ts: "2026-08-17T10:00:00Z", turnIndex: 3, tokens: { input: 2_500_000, output: 0, cache_read: 0, cache_creation: 0 } }),
    ]);
    const third = cli(home, ["pace", "--notice", "--now", "2026-08-18T00:00:00Z"]);
    assert.match(third, /100% of the 2026-Q3 token grant/);
    const fourth = cli(home, ["pace", "--notice", "--now", "2026-08-18T01:00:00Z"]);
    assert.equal(fourth, "");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("pace with no allocation says so plainly and never notifies", () => {
  const home = mkdtempSync(join(tmpdir(), "wb-pace0-"));
  try {
    assert.match(cli(home, ["pace"]), /No allocation configured/);
    // Uninitialized home: the one first-run line, once ever, then silence —
    // no pacing notice is ever emitted without an allocation.
    assert.match(cli(home, ["pace", "--notice"]), /not initialized/);
    assert.equal(cli(home, ["pace", "--notice"]), "");
    assert.equal(cli(home, ["pace", "--notice"]), "");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
