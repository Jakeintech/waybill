// M2 acceptance: the product-spec §8 UX flows as scripted tests, plus the
// Linear adapter through the conformance kit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultContext } from "../../src/adapters/contract.ts";
import { linearAdapter } from "../../src/adapters/linear.ts";
import { checkTrackerAdapter } from "../../src/adapters/conformance.ts";
import { appendEvents } from "../../src/core/streams.ts";
import { defaultConfig, saveConfig } from "../../src/core/config.ts";
import { makeOpened } from "../helpers/fixtures.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const FIXTURES = join(ROOT, "tests", "fixtures", "transcripts");

function cli(home: string, args: string[]): string {
  return execFileSync(process.execPath, [join(ROOT, "src", "cli", "main.ts"), ...args], {
    encoding: "utf8",
    env: { ...process.env, WAYBILL_HOME: home },
  });
}

test("flow 1 (zero-touch week): metering accumulates, spend answers with confidence, inbox surfaces", () => {
  const home = mkdtempSync(join(tmpdir(), "wb-flow1-"));
  try {
    // Two open entries make the legacy session ambiguous — like real life.
    appendEvents(home, "ledger", [
      makeOpened({ repo: null }),
      makeOpened({ tracker_key: "DATA-77", title: "Ingest dedupe", repo: null, ts: "2026-08-11T09:00:00Z" }),
    ]);
    for (const f of ["v2.1/basic.jsonl", "v2.1/multiturn.jsonl", "v1/legacy.jsonl"]) {
      cli(home, ["meter", "--transcript", join(FIXTURES, f)]);
    }
    const spend = JSON.parse(cli(home, ["query", "spend"])) as {
      data: {
        accounts: Array<{ account: string; min_confidence: number }>;
        unattributed_pct: number;
        attribution_health: { inbox_open: number };
      };
    };
    // Per-account confidence bands are stated; unattributed shown; the
    // inbox offers the ambiguous leftovers for one-tap resolution.
    assert.ok(spend.data.accounts.length >= 2);
    assert.ok(spend.data.accounts.every((a) => a.min_confidence > 0));
    assert.ok(spend.data.accounts.some((a) => a.account === "unattributed"));
    // Ambiguities stand only where nothing strong settled the turn:
    // basic (2 turns @ branch 0.6) + multiturn turn 1 (branch 0.6) +
    // legacy (unattributed) = 4; evidence-settled turns don't nag.
    assert.equal(spend.data.attribution_health.inbox_open, 4);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("flow 2 (story cost): one interaction, tokens + cache share + per-point", () => {
  const home = mkdtempSync(join(tmpdir(), "wb-flow2-"));
  try {
    const opened = makeOpened();
    const { id: _i, ...openedBody } = opened;
    // The write path stamps appended_at, so ids are never predicted
    // client-side — the skills' contract is to read the id append returns.
    const openedResult = JSON.parse(
      cli(home, ["append", "--stream", "ledger", "--event", JSON.stringify(openedBody), "--json"]),
    ) as { id: string };
    cli(home, ["meter", "--transcript", join(FIXTURES, "v2.1/basic.jsonl"), "--repo", "acme/platform"]);
    // Ship it (supersede the opened entry) so cost-per-point exists.
    const shippedBody = {
      ...openedBody,
      ts: "2026-08-12T16:30:00Z",
      kind: "shipped",
      supersedes: openedResult.id,
      artifacts: { prs: ["https://github.com/acme/platform/pull/1932"], commits: [], deploy: null, docs: [] },
    };
    cli(home, ["append", "--stream", "ledger", "--event", JSON.stringify(shippedBody)]);
    const story = JSON.parse(cli(home, ["query", "story", "PLAT-482"])) as {
      data: { spend: { tokens: number }; cache_read_share: number; tokens_per_point: number };
    };
    assert.ok(story.data.spend.tokens > 0);
    assert.ok(story.data.cache_read_share > 0);
    assert.equal(story.data.tokens_per_point, Math.round(story.data.spend.tokens / 5));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("flow 3 (pacing nudge): one line at the threshold, then silence", () => {
  const home = mkdtempSync(join(tmpdir(), "wb-flow3-"));
  try {
    const config = defaultConfig();
    config.allocations = [{ period: "2026-Q3", tokens_granted: 7000, granted_at: "2026-07-01" }];
    saveConfig(home, config);
    cli(home, ["meter", "--transcript", join(FIXTURES, "v2.1/basic.jsonl"), "--repo", "acme/platform"]);
    const notice = cli(home, ["pace", "--notice", "--now", "2026-08-16T00:00:00Z"]);
    assert.match(notice, /% of the 2026-Q3 token grant is spent/);
    // The threshold is spent; the next session gets the one-shot first-run
    // nudge (sessions metered, nothing logged) — once ever — then silence.
    assert.match(
      cli(home, ["pace", "--notice", "--now", "2026-08-16T01:00:00Z"]),
      /nothing logged yet/,
    );
    assert.equal(cli(home, ["pace", "--notice", "--now", "2026-08-16T02:00:00Z"]), "");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("flow 4 (the pitch): report data carries the spend ledger, receipts, and costs", () => {
  const home = mkdtempSync(join(tmpdir(), "wb-flow4-"));
  try {
    const config = defaultConfig();
    config.allocations = [{ period: "2026-Q3", tokens_granted: 50_000_000, granted_at: "2026-07-01" }];
    saveConfig(home, config);
    const opened = makeOpened();
    const { id: _i, ...openedBody } = opened;
    const openedResult = JSON.parse(
      cli(home, ["append", "--stream", "ledger", "--event", JSON.stringify(openedBody), "--json"]),
    ) as { id: string };
    cli(home, ["meter", "--transcript", join(FIXTURES, "v2.1/basic.jsonl"), "--repo", "acme/platform"]);
    cli(home, ["append", "--stream", "ledger", "--event", JSON.stringify({
      ...openedBody,
      ts: "2026-08-12T16:30:00Z",
      kind: "shipped",
      supersedes: openedResult.id,
      actual_hours: 4.5,
      claude_role: "co_wrote",
      time_saved_hours: { low: 5.5, high: 11.5, confidence: "medium", basis: "pre_registered" },
      artifacts: { prs: ["https://github.com/acme/platform/pull/1932"], commits: [], deploy: "v2026.08.12", docs: [] },
    })]);
    const report = JSON.parse(cli(home, ["query", "report", "--from", "2026-08-01", "--to", "2026-08-31"])) as {
      data: {
        shipped: Array<{ escrowed: boolean; prs: string[] }>;
        time_saved: { pre_registered_or_baseline: { low: number; high: number } };
        costs: { utilization_pct: number; unattributed_pct: number };
        spend_ledger: { total_tokens: number; accounts: unknown[] };
      };
    };
    assert.equal(report.data.shipped.length, 1);
    assert.equal(report.data.shipped[0]!.escrowed, true); // pre-registered, sealed
    assert.deepEqual(report.data.time_saved.pre_registered_or_baseline, { low: 5.5, high: 11.5, entries: 1 });
    assert.ok(report.data.spend_ledger.total_tokens > 0);
    assert.ok(report.data.costs.utilization_pct !== null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("linear adapter: normalizes issues and passes the conformance kit", () => {
  const raw = JSON.parse(
    readFileSync(join(ROOT, "tests", "fixtures", "adapters", "linear-issues.json"), "utf8"),
  ) as unknown;
  const ctx = defaultContext();
  const items = linearAdapter.normalizeItems(raw, ctx);
  assert.deepEqual(items.map((i) => i.key), ["ENG-142", "ENG-150"]); // canceled dropped
  const done = items.find((i) => i.key === "ENG-142")!;
  assert.equal(done.points, 5);
  assert.equal(done.done, true);
  assert.equal(done.sprint, "cycle-17");
  assert.equal(done.epic_name, "Checkout reliability");
  const wip = items.find((i) => i.key === "ENG-150")!;
  assert.equal(wip.done, false);
  assert.equal(wip.work_type, "bug");
  assert.equal(wip.sprint, "Sprint 17");
  const report = checkTrackerAdapter(linearAdapter, raw, ctx);
  assert.deepEqual(report.failures, []);
});
