import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";

import {
  localDayWindow,
  resolveStandupWindow,
  standupData,
} from "../../src/projections/standup.ts";
import { redact } from "../../src/report/redaction.ts";
import { defaultConfig } from "../../src/core/config.ts";
import { finalizeEvent, SCHEMA_VERSION, type AmbiguityEvent, type LedgerEntry } from "../../src/core/events.ts";
import { appendEvents } from "../../src/core/streams.ts";
import { makeOpened, makeSessionReceipt, makeUsage, tempHome } from "../helpers/fixtures.ts";

const ROOT = join(import.meta.dirname, "..", "..");

function shippedFrom(opened: LedgerEntry, ts: string): LedgerEntry {
  const { id: _id, ...body } = opened;
  return finalizeEvent("ledger", {
    ...body,
    ts,
    kind: "shipped" as const,
    supersedes: opened.id,
    artifacts: { prs: ["https://github.com/acme/platform/pull/1932"], commits: [], deploy: null, docs: [] },
  }) as LedgerEntry;
}

function makeAmbiguity(ts: string): AmbiguityEvent {
  return finalizeEvent("exceptions", {
    ts,
    kind: "ambiguity" as const,
    schema_version: SCHEMA_VERSION,
    supersedes: null,
    session_id: "9f4c1e2a-77aa-4b02-9d31-5c2f8ab9d001",
    turn: { index: 1, first_message_id: "msg_first_1" },
    rule: "branch",
    candidates: ["story:PLAT-482", "story:DATA-77"],
    status: "open" as const,
  }) as AmbiguityEvent;
}

const DAY: { from: string; to: string } = {
  from: "2026-08-20T00:00:00Z",
  to: "2026-08-20T23:59:59.999Z",
};

test("standupData: shipped in window; progressed excludes shipped keys and unattributed; opened listed", () => {
  const config = defaultConfig();
  const opened = makeOpened({ ts: "2026-08-10T09:00:00Z" }); // PLAT-482
  const shipped = shippedFrom(opened, "2026-08-20T16:30:00Z");
  const openedInWindow = makeOpened({ tracker_key: "DATA-77", title: "Ingest dedupe", ts: "2026-08-20T11:00:00Z" });
  const usage = [
    makeUsage({ ts: "2026-08-20T10:00:00Z", turnIndex: 1, tokens: { input: 100, output: 50, cache_read: 0, cache_creation: 0 } }), // PLAT-482 (ships in window)
    makeUsage({ ts: "2026-08-20T12:00:00Z", turnIndex: 2, account: "story:DATA-77", tokens: { input: 300, output: 0, cache_read: 0, cache_creation: 0 } }),
    makeUsage({ ts: "2026-08-20T13:00:00Z", turnIndex: 3, account: "adhoc:oncall", tokens: { input: 200, output: 0, cache_read: 0, cache_creation: 0 } }),
    makeUsage({ ts: "2026-08-20T14:00:00Z", turnIndex: 4, account: "unattributed", resolver: "none", tokens: { input: 50, output: 0, cache_read: 0, cache_creation: 0 } }),
    makeUsage({ ts: "2026-08-19T10:00:00Z", turnIndex: 5, tokens: { input: 999, output: 0, cache_read: 0, cache_creation: 0 } }), // outside window
  ];
  const d = standupData([opened, shipped, openedInWindow], usage, [], [], config, DAY, "yesterday");

  assert.equal(d.shipped.length, 1);
  assert.equal(d.shipped[0]!.tracker_key, "PLAT-482");
  assert.equal(d.shipped[0]!.escrowed, true);
  // PLAT-482 shipped in the window, so it is not "progressed"; DATA-77 and
  // the adhoc account are; unattributed never is.
  assert.deepEqual(d.progressed.map((p) => p.account), ["story:DATA-77", "adhoc:oncall"]);
  assert.equal(d.progressed[0]!.title, "Ingest dedupe");
  assert.equal(d.progressed[0]!.tokens, 300);
  assert.deepEqual(d.opened.map((o) => o.tracker_key), ["DATA-77"]);
  assert.equal(d.opened[0]!.pre_registered, true);
  assert.equal(d.tokens.total, 700); // the 2026-08-19 event is out of window
  assert.equal(d.attention.unattributed_tokens, 50);
  assert.equal(d.window.label, "yesterday");
});

test("standupData: cost sums priced events and surfaces unpriced models with their tokens", () => {
  const config = defaultConfig();
  config.pricing.version = "2026-08-17";
  const usage = [
    makeUsage({ ts: "2026-08-20T10:00:00Z", turnIndex: 1, cost: { value: 1.25, pricing_version: "2026-08-17" }, tokens: { input: 100, output: 0, cache_read: 0, cache_creation: 0 } }),
    makeUsage({ ts: "2026-08-20T11:00:00Z", turnIndex: 2, cost: { value: 0.5, pricing_version: "2026-08-17" }, tokens: { input: 100, output: 0, cache_read: 0, cache_creation: 0 } }),
    makeUsage({ ts: "2026-08-20T12:00:00Z", turnIndex: 3, model: "claude-opus-4-5-20251101", tokens: { input: 40, output: 2, cache_read: 0, cache_creation: 0 } }),
  ];
  const d = standupData([], usage, [], [], config, DAY);
  assert.equal(d.tokens.cost_usd, 1.75);
  assert.equal(d.tokens.pricing_version, "2026-08-17");
  assert.deepEqual(d.tokens.unpriced_models, ["claude-opus-4-5-20251101"]);
  assert.equal(d.tokens.unpriced_tokens, 42);
});

test("standupData: sessions overlap the window; waste rolls up; inbox counted", () => {
  const config = defaultConfig();
  const usage = [
    makeUsage({ ts: "2026-08-20T10:00:00Z", turnIndex: 1, waste: { retried_commands: 2, repeated_reads: 1 }, tokens: { input: 10, output: 0, cache_read: 0, cache_creation: 0 } }),
  ];
  const spanning = makeSessionReceipt(usage, {
    session_id: "11111111-1111-4111-8111-111111111111",
    first_ts: "2026-08-19T23:00:00Z",
    last_ts: "2026-08-20T01:00:00Z",
  });
  const before = makeSessionReceipt(usage, {
    session_id: "22222222-2222-4222-8222-222222222222",
    first_ts: "2026-08-18T08:00:00Z",
    last_ts: "2026-08-18T09:00:00Z",
  });
  const d = standupData([], usage, [spanning, before], [makeAmbiguity("2026-08-20T10:00:00Z")], config, DAY);
  assert.equal(d.session_summary.count, 1); // the midnight-spanning session counts; the 08-18 one does not
  assert.deepEqual(d.waste, { retried_commands: 2, repeated_reads: 1 });
  assert.equal(d.attention.inbox_open, 1);
});

test("resolveStandupWindow: precedence (from/to > days > date), labels, and errors", () => {
  const now = new Date(2026, 7, 21, 15, 30); // local 2026-08-21
  const explicit = resolveStandupWindow({ date: "yesterday", days: 3, from: "2026-08-01", to: "2026-08-02" }, now);
  assert.equal(explicit.window.from, "2026-08-01");
  assert.equal(explicit.window.to, "2026-08-02T23:59:59.999Z"); // date-only --to is inclusive
  assert.equal(explicit.label, null);

  const days = resolveStandupWindow({ date: null, days: 7, from: null, to: null }, now);
  assert.equal(days.label, "last 7 day(s)");
  assert.equal(days.window.from, localDayWindow(now, -6).from);
  assert.equal(days.window.to, localDayWindow(now, 0).to);

  const yesterday = resolveStandupWindow({ date: null, days: null, from: null, to: null }, now);
  assert.equal(yesterday.label, "yesterday");
  assert.deepEqual(
    { from: yesterday.window.from, to: yesterday.window.to },
    localDayWindow(now, -1),
  );

  const literal = resolveStandupWindow({ date: "2026-08-15", days: null, from: null, to: null }, now);
  assert.equal(literal.label, "2026-08-15");
  assert.deepEqual(
    { from: literal.window.from, to: literal.window.to },
    localDayWindow(new Date(2026, 7, 15), 0),
  );

  assert.throws(() => resolveStandupWindow({ date: "not-a-date", days: null, from: null, to: null }, now), /--date/);
  assert.throws(() => resolveStandupWindow({ date: null, days: 0, from: null, to: null }, now), /--days/);
  assert.throws(() => resolveStandupWindow({ date: null, days: 1.5, from: null, to: null }, now), /--days/);
});

test("localDayWindow: covers exactly one local calendar day, end-exclusive by 1ms", () => {
  const base = new Date(2026, 7, 21, 15, 30);
  const w = localDayWindow(base, -1);
  const from = new Date(w.from);
  const to = new Date(w.to);
  assert.equal(to.getTime() - from.getTime(), 86400_000 - 1);
  assert.equal(from.getDate(), 20);
  assert.equal(from.getHours(), 0);
});

test("standup redaction: internal keeps the session summary; external drops titles, PRs, branches and pseudonymizes accounts + repos", () => {
  const config = defaultConfig();
  const opened = makeOpened({ ts: "2026-08-10T09:00:00Z" });
  const shipped = shippedFrom(opened, "2026-08-20T16:30:00Z");
  const usage = [
    makeUsage({ ts: "2026-08-20T12:00:00Z", turnIndex: 1, account: "story:DATA-77", tokens: { input: 300, output: 0, cache_read: 0, cache_creation: 0 } }),
  ];
  const receipt = makeSessionReceipt(usage, {
    first_ts: "2026-08-20T11:00:00Z",
    last_ts: "2026-08-20T12:30:00Z",
    branches: ["feat/PLAT-482-retry"],
    repo: "acme/platform",
  });
  const d = standupData([opened, shipped], usage, [receipt], [], config, DAY);

  // Internal: machine-local detail goes, the roll-up section stays.
  const internal = redact(d, "internal");
  const internalData = internal.data as { session_summary?: { count: number } };
  assert.equal(internalData.session_summary?.count, 1, "session_summary must survive internal redaction");
  assert.ok(!JSON.stringify(internal.data).includes("session_id"));

  const external = redact(d, "external");
  const json = JSON.stringify(external.data);
  assert.ok(!json.includes("PLAT-482")); // branch names dropped, keys pseudonymized
  assert.ok(!json.includes("DATA-77"));
  assert.ok(!json.includes("github.com"));
  assert.ok(!json.includes("Retry logic"));
  assert.ok(!json.includes("acme/platform"), "repos array must be pseudonymized externally");
  assert.ok(json.includes("story:STORY-"));
  assert.ok(json.includes("repo-1"));
});

test("CLI: query standup returns the query envelope; standup-only flags rejected elsewhere", () => {
  const home = tempHome();
  try {
    const opened = makeOpened({ ts: "2026-08-10T09:00:00Z" });
    const shipped = shippedFrom(opened, "2026-08-20T16:30:00Z");
    appendEvents(home, "ledger", [opened, shipped]);
    appendEvents(home, "usage", [
      makeUsage({ ts: "2026-08-20T10:00:00Z", turnIndex: 1, tokens: { input: 100, output: 50, cache_read: 0, cache_creation: 0 } }),
    ]);

    const out = execFileSync(
      process.execPath,
      [join(ROOT, "src", "cli", "main.ts"), "query", "standup", "--from", "2026-08-20", "--to", "2026-08-20"],
      { encoding: "utf8", env: { ...process.env, WAYBILL_HOME: home } },
    );
    const parsed = JSON.parse(out) as { audience: string; data: { shipped: unknown[]; tokens: { total: number } } };
    assert.equal(parsed.audience, "self");
    assert.equal(parsed.data.shipped.length, 1);
    assert.equal(parsed.data.tokens.total, 150);

    // --date resolves the window without --from/--to (fixed via --now).
    const dated = execFileSync(
      process.execPath,
      [join(ROOT, "src", "cli", "main.ts"), "query", "standup", "--date", "yesterday", "--now", "2026-08-21T12:00:00Z"],
      { encoding: "utf8", env: { ...process.env, WAYBILL_HOME: home, TZ: "UTC" } },
    );
    const datedParsed = JSON.parse(dated) as { data: { window: { label: string }; tokens: { total: number } } };
    assert.equal(datedParsed.data.window.label, "yesterday");
    assert.equal(datedParsed.data.tokens.total, 150);

    // Standup-only flags are an error on other projections, not a silent no-op.
    let code = 0;
    try {
      execFileSync(
        process.execPath,
        [join(ROOT, "src", "cli", "main.ts"), "query", "spend", "--date", "yesterday"],
        { encoding: "utf8", env: { ...process.env, WAYBILL_HOME: home }, stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (err) {
      code = (err as { status?: number }).status ?? 0;
    }
    assert.equal(code, 2);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
