import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalJson } from "../../src/core/canonical.ts";
import { deterministicUlid, encodeTime, isUlid } from "../../src/core/ulid.ts";
import { finalizeEvent, serializeEvent, type Envelope } from "../../src/core/events.ts";
import { appendEvents, authoritative, listShards, readEvents, shardFor, shardPath } from "../../src/core/streams.ts";
import { checkEscrow, escrowPayload, sealEstimate } from "../../src/core/escrow.ts";
import { defaultConfig, loadConfig, saveConfig } from "../../src/core/config.ts";
import type { LedgerEntry } from "../../src/core/events.ts";

test("canonicalJson sorts keys recursively and is stable", () => {
  const a = canonicalJson({ b: 1, a: { d: [1, 2], c: null } });
  const b = canonicalJson({ a: { c: null, d: [1, 2] }, b: 1 });
  assert.equal(a, b);
  assert.equal(a, '{"a":{"c":null,"d":[1,2]},"b":1}');
});

test("canonicalJson drops undefined object members", () => {
  assert.equal(canonicalJson({ a: undefined, b: 1 }), '{"b":1}');
});

test("encodeTime is 10 chars and ordered", () => {
  const t1 = encodeTime(Date.parse("2026-08-01T00:00:00Z"));
  const t2 = encodeTime(Date.parse("2026-09-01T00:00:00Z"));
  assert.equal(t1.length, 10);
  assert.ok(t1 < t2);
});

test("deterministicUlid: same content same id, different content different id", () => {
  const ts = "2026-08-17T10:15:03Z";
  const a = deterministicUlid(ts, "usage", { x: 1 });
  const b = deterministicUlid(ts, "usage", { x: 1 });
  const c = deterministicUlid(ts, "usage", { x: 2 });
  const d = deterministicUlid(ts, "ledger", { x: 1 });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.notEqual(a, d);
  assert.ok(isUlid(a));
});

test("finalizeEvent puts id first and derives it from content", () => {
  const body = { ts: "2026-08-17T10:15:03Z", kind: "usage", schema_version: 2, supersedes: null, n: 7 };
  const e = finalizeEvent("usage", body);
  assert.deepEqual(Object.keys(e)[0], "id");
  const again = finalizeEvent("usage", body);
  assert.equal(e.id, again.id);
  assert.equal(serializeEvent(e), serializeEvent(again));
});

test("streams: shard placement, append, read, authoritative", () => {
  const home = mkdtempSync(join(tmpdir(), "wb-test-"));
  try {
    assert.equal(shardFor("2026-08-17T10:15:03Z"), "2026-08");
    const e1 = finalizeEvent("ledger", {
      ts: "2026-08-10T09:00:00Z", kind: "opened", schema_version: 2, supersedes: null, title: "a",
    });
    const e2 = finalizeEvent("ledger", {
      ts: "2026-09-02T09:00:00Z", kind: "shipped", schema_version: 2, supersedes: e1.id, title: "a",
    });
    appendEvents(home, "ledger", [e1, e2]);
    assert.deepEqual(listShards(home, "ledger"), ["2026-08", "2026-09"]);
    const raw = readFileSync(shardPath(home, "ledger", "2026-08"), "utf8");
    assert.ok(raw.endsWith("\n"));
    const events = readEvents(home, "ledger");
    assert.equal(events.length, 2);
    const auth = authoritative(events as Envelope[]);
    assert.equal(auth.length, 1);
    assert.equal(auth[0]!.id, e2.id);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("escrow: seal and verify round-trip; edits detected", () => {
  const est = { low: 10, high: 16, logged_at: "2026-08-10T09:12:00Z", pre_registered: true };
  const escrow = sealEstimate("PLAT-482", est);
  assert.equal(escrow.algo, "sha256");
  assert.equal(
    escrowPayload("PLAT-482", 10, 16, "2026-08-10T09:12:00Z"),
    "estimate.v1|PLAT-482|10|16|hours|2026-08-10T09:12:00Z",
  );
  const entry = {
    id: "x", ts: "2026-08-10T09:12:00Z", kind: "opened", schema_version: 2, supersedes: null,
    title: "Retry logic", tracker_key: "PLAT-482", epic_key: null, epic_name: null, sprint: null,
    repo: null, work_type: "feature", points: null,
    artifacts: { prs: [], commits: [], deploy: null, docs: [] },
    estimate_without_claude_hours: est, escrow, actual_hours: null, claude_role: "none",
    sessions: [], tokens: null, budget_tokens: null, time_saved_hours: null, notes: null,
  } as unknown as LedgerEntry;
  assert.deepEqual(checkEscrow(entry), { status: "ok" });
  const tampered = {
    ...entry,
    estimate_without_claude_hours: { ...est, low: 20 },
  } as LedgerEntry;
  assert.equal(checkEscrow(tampered).status, "mismatch");
});

test("config: defaults round-trip and merge over older shapes", () => {
  const home = mkdtempSync(join(tmpdir(), "wb-test-"));
  try {
    const c = defaultConfig();
    assert.equal(c.git.kind, "local");
    assert.equal(c.tracker.kind, null);
    saveConfig(home, c);
    const loaded = loadConfig(home);
    assert.deepEqual(loaded, c);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
