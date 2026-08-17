// Regression tests for the adversarially-verified review findings.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultConfig, saveConfig } from "../../src/core/config.ts";
import { finalizeEvent, type LedgerEntry, type UsageEvent } from "../../src/core/events.ts";
import { appendEvents, authoritative, readEvents } from "../../src/core/streams.ts";
import { meterFile } from "../../src/meter/run.ts";
import { acquireLock, releaseLock, _clearLock } from "../../src/meter/lock.ts";
import { effectiveShipped, normalizeWindow, reportData, spendData } from "../../src/projections/queries.ts";
import { makeOpened, makeUsage } from "../helpers/fixtures.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const FIXTURE = join(ROOT, "tests", "fixtures", "transcripts", "v2.1", "basic.jsonl");

function cli(home: string, args: string[]): { stdout: string; code: number } {
  try {
    const stdout = execFileSync(process.execPath, [join(ROOT, "src", "cli", "main.ts"), ...args], {
      encoding: "utf8",
      env: { ...process.env, WAYBILL_HOME: home },
    });
    return { stdout, code: 0 };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { stdout: (e.stdout ?? "") + (e.stderr ?? ""), code: e.status ?? 1 };
  }
}

test("finding 1: a pricing-version bump re-meters every stale session, not just the first", () => {
  const home = mkdtempSync(join(tmpdir(), "wb-pv-"));
  const fixtures = join(ROOT, "tests", "fixtures", "transcripts", "v2.1");
  try {
    // Meter two sessions with no pricing.
    meterFile(home, join(fixtures, "basic.jsonl"), "acme/platform");
    meterFile(home, join(fixtures, "multiturn.jsonl"), "acme/platform");
    // Bump pricing; both sessions must re-meter with priced events.
    const config = defaultConfig();
    config.pricing = {
      version: "2026-09-01",
      unknown_model_policy: "tokens_only",
      models: {
        "claude-opus-4-6": {
          input_per_mtok: 15, output_per_mtok: 75, cache_read_per_mtok: 1.5,
          cache_write_5m_per_mtok: 18.75, cache_write_1h_per_mtok: 30,
        },
      },
    };
    saveConfig(home, config);
    const r1 = meterFile(home, join(fixtures, "basic.jsonl"), "acme/platform");
    const r2 = meterFile(home, join(fixtures, "multiturn.jsonl"), "acme/platform");
    assert.equal(r1.skipped, false, "first session must re-meter after pricing bump");
    assert.equal(r2.skipped, false, "second session must ALSO re-meter after pricing bump");
    const priced = authoritative(readEvents<UsageEvent>(home, "usage")).filter(
      (u) => u.kind === "usage" && u.model === "claude-opus-4-6",
    );
    assert.ok(priced.length > 0);
    for (const u of priced) {
      assert.equal(u.cost_usd?.pricing_version, "2026-09-01", `stale pricing on ${u.id}`);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("finding 3: a pin added after metering takes effect on the next plain meter run", () => {
  const home = mkdtempSync(join(tmpdir(), "wb-pin-"));
  try {
    meterFile(home, FIXTURE, "acme/platform");
    const before = authoritative(readEvents<UsageEvent>(home, "usage")).filter((u) => u.kind === "usage");
    assert.ok(before.every((u) => u.attribution.account === "story:PLAT-482")); // branch rule
    // Pin the session to a different story — via the real write path.
    const pin = {
      ts: "2026-08-05T15:00:00Z", kind: "pin",
      session_id: "11111111-aaaa-4bbb-8ccc-000000000001",
      account: "story:PLAT-999", tracker_key: "PLAT-999", range: null, notes: null,
    };
    const r = cli(home, ["append", "--stream", "ledger", "--event", JSON.stringify(pin)]);
    assert.equal(r.code, 0, r.stdout);
    // No --force, no file growth: the fingerprint alone must invalidate.
    const rerun = meterFile(home, FIXTURE, "acme/platform");
    assert.equal(rerun.skipped, false, "pin must invalidate the fast path");
    const after = authoritative(readEvents<UsageEvent>(home, "usage")).filter((u) => u.kind === "usage");
    assert.ok(after.length > 0);
    for (const u of after) {
      assert.equal(u.attribution.account, "story:PLAT-999");
      assert.equal(u.attribution.resolver, "pin");
    }
    // And the run after that is a clean no-op.
    const third = meterFile(home, FIXTURE, "acme/platform");
    assert.equal(third.skipped, true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("finding 2: a correction over a shipped entry keeps the story shipped everywhere", () => {
  const config = defaultConfig();
  const opened = makeOpened();
  const { id: _o, ...openedBody } = opened;
  const shipped = finalizeEvent("ledger", {
    ...openedBody,
    ts: "2026-08-12T16:30:00Z",
    kind: "shipped" as const,
    supersedes: opened.id,
    artifacts: { prs: ["https://github.com/acme/platform/pull/1932"], commits: [], deploy: null, docs: [] },
  }) as LedgerEntry;
  const { id: _s, ...shippedBody } = shipped;
  const correction = finalizeEvent("ledger", {
    ...shippedBody,
    ts: "2026-08-14T09:00:00Z",
    kind: "correction" as const,
    supersedes: shipped.id,
    points: 8, // drift fix
  }) as LedgerEntry;
  const ledger = [opened, shipped, correction];
  const usage = [makeUsage({ ts: "2026-08-11T10:00:00Z" })];

  const views = effectiveShipped(ledger);
  assert.equal(views.length, 1);
  assert.equal(views[0]!.entry.id, correction.id);
  assert.equal(views[0]!.shipped_ts, "2026-08-12T16:30:00Z"); // ship time, not correction time

  const report = reportData(ledger, usage, [], config, { from: "2026-08-01", to: "2026-08-13T00:00:00Z" });
  assert.equal(report.shipped.length, 1, "corrected story must stay in the report");
  assert.equal(report.shipped[0]!.points, 8, "with the corrected points");
  assert.equal(report.totals.points, 8);

  const spend = spendData(usage, [], ledger, config, { from: null, to: null });
  assert.deepEqual(spend.open_spend, [], "corrected shipped story is not open spend");
});

test("finding 5/7: date-only --to is inclusive; garbage bounds are rejected", () => {
  const w = normalizeWindow("2026-08-01", "2026-08-11");
  assert.equal(w.to, "2026-08-11T23:59:59.999Z");
  const usage = [makeUsage({ ts: "2026-08-11T10:00:00Z" })];
  const spend = spendData(usage, [], [], defaultConfig(), w);
  assert.equal(spend.total_tokens, 6500, "event on the --to day must be inside the window");
  assert.throws(() => normalizeWindow("yesterday", null), /not a date/);
});

test("finding 6: story query returns the authoritative (corrected) view", () => {
  const home = mkdtempSync(join(tmpdir(), "wb-story-"));
  try {
    const opened = makeOpened();
    const { id: _o, ...openedBody } = opened;
    const shipped = finalizeEvent("ledger", {
      ...openedBody, ts: "2026-08-12T16:30:00Z", kind: "shipped" as const, supersedes: opened.id,
    }) as LedgerEntry;
    const { id: _s, ...shippedBody } = shipped;
    const correction = finalizeEvent("ledger", {
      ...shippedBody, ts: "2026-08-14T09:00:00Z", kind: "correction" as const,
      supersedes: shipped.id, points: 8,
    }) as LedgerEntry;
    appendEvents(home, "ledger", [opened, shipped, correction]);
    const r = cli(home, ["query", "story", "PLAT-482"]);
    assert.equal(r.code, 0);
    const payload = JSON.parse(r.stdout) as { data: { shipped: { id: string; points: number } } };
    assert.equal(payload.data.shipped.id, correction.id, "must be the correction, not the superseded shipped");
    assert.equal(payload.data.shipped.points, 8);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("finding 10: append rejects a kind that is illegal for the stream", () => {
  const home = mkdtempSync(join(tmpdir(), "wb-kind-"));
  try {
    const r = cli(home, ["append", "--stream", "usage", "--event", JSON.stringify({ ts: "2026-08-01T00:00:00Z", kind: "opened" })]);
    assert.equal(r.code, 2);
    assert.match(r.stdout, /kind must be one of usage, correction/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("finding 8: the metering lock is exclusive and stale-safe", () => {
  const home = mkdtempSync(join(tmpdir(), "wb-lock-"));
  try {
    assert.equal(acquireLock(home), true);
    assert.equal(acquireLock(home), false, "second acquire while held must fail");
    releaseLock(home);
    assert.equal(acquireLock(home), true, "reacquire after release");
    releaseLock(home);
    // Stale lock (dead pid) is taken over.
    writeFileSync(join(home, "pending-sessions", ".miner.lock"), "999999999", "utf8");
    assert.equal(acquireLock(home), true, "stale lock must be taken over");
    _clearLock(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("resolve: one-tap inbox resolution corrects the turn and survives re-meters", () => {
  const home = mkdtempSync(join(tmpdir(), "wb-resolve-"));
  try {
    // Two open entries with no repo → ambiguity on the legacy fixture.
    const a = makeOpened({ repo: null });
    const b = makeOpened({ tracker_key: "DATA-77", title: "Ingest dedupe", repo: null, ts: "2026-08-11T09:00:00Z" });
    appendEvents(home, "ledger", [a, b]);
    const legacy = join(ROOT, "tests", "fixtures", "transcripts", "v1", "legacy.jsonl");
    meterFile(home, legacy, null);
    const inbox = JSON.parse(cli(home, ["query", "inbox"]).stdout) as { data: Array<{ id: string }> };
    assert.equal(inbox.data.length, 1);

    const r = cli(home, ["resolve", "--ambiguity", inbox.data[0]!.id, "--account", "story:DATA-77"]);
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /filed to story:DATA-77/);
    assert.match(r.stdout, /0 left in the inbox/);

    const after = authoritative(readEvents<UsageEvent>(home, "usage")).filter((u) => u.kind === "usage");
    assert.equal(after.length, 1);
    assert.equal(after[0]!.attribution.account, "story:DATA-77");
    assert.equal(after[0]!.attribution.confidence, 1.0);
    // A later re-meter must keep the resolution (rule 0), not revert it.
    const rerun = meterFile(home, legacy, null, true);
    assert.equal(rerun.usage, 0, "forced re-meter emits nothing new — the resolution holds");
    const verify = cli(home, ["verify"]);
    assert.equal(verify.code, 0, verify.stdout);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
