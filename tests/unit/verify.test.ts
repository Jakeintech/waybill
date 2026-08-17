import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { verifyHome } from "../../src/verify/verify.ts";
import { appendEvents, shardPath } from "../../src/core/streams.ts";
import { finalizeEvent, SCHEMA_VERSION } from "../../src/core/events.ts";
import { makeSessionReceipt, makeUsage, tempHome, writeValidHome } from "../helpers/fixtures.ts";

function checks(home: string): string[] {
  return verifyHome(home).map((f) => f.check);
}

test("verify: a valid home has zero findings", () => {
  const home = tempHome();
  try {
    writeValidHome(home);
    assert.deepEqual(verifyHome(home), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("verify: an empty home has zero findings", () => {
  const home = tempHome();
  try {
    assert.deepEqual(verifyHome(home), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("verify: tampered event content breaks deterministic id", () => {
  const home = tempHome();
  try {
    writeValidHome(home);
    const p = shardPath(home, "ledger", "2026-08");
    const line = readFileSync(p, "utf8").trimEnd();
    const tampered = line.replace('"low":10', '"low":2');
    writeFileSync(p, tampered + "\n", "utf8");
    const found = checks(home);
    assert.ok(found.includes("id_deterministic"), `expected id_deterministic in ${found}`);
    assert.ok(found.includes("escrow"), `expected escrow in ${found}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("verify: missing usage event breaks conservation", () => {
  const home = tempHome();
  try {
    const usage = [makeUsage({ turnIndex: 1 }), makeUsage({ turnIndex: 2, ts: "2026-08-17T10:22:41Z" })];
    const receipt = makeSessionReceipt(usage);
    appendEvents(home, "usage", [usage[0]!]); // drop turn 2
    appendEvents(home, "sessions", [receipt]);
    const found = verifyHome(home);
    assert.equal(found.length, 1);
    assert.equal(found[0]!.check, "conservation");
    assert.match(found[0]!.message, /≠ receipt totals/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("verify: usage without a session receipt is flagged", () => {
  const home = tempHome();
  try {
    appendEvents(home, "usage", [makeUsage({})]);
    const found = verifyHome(home);
    assert.equal(found.length, 1);
    assert.equal(found[0]!.check, "conservation");
    assert.match(found[0]!.message, /no session receipt/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("verify: superseding a usage event preserves conservation", () => {
  const home = tempHome();
  try {
    const u1 = makeUsage({ turnIndex: 1, tokens: { input: 500, output: 100 } });
    const u1fixed = finalizeEvent("usage", {
      ...(({ id: _, ...rest }) => rest)(u1),
      supersedes: u1.id,
      tokens: { ...u1.tokens, input: 800 },
    });
    const receipt = makeSessionReceipt([u1fixed as never]);
    appendEvents(home, "usage", [u1, u1fixed]);
    appendEvents(home, "sessions", [receipt]);
    assert.deepEqual(verifyHome(home), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("verify: dangling supersedes, duplicate ids, bad shard, bad kind", () => {
  const home = tempHome();
  try {
    const ghost = finalizeEvent("ledger", {
      ts: "2026-08-11T00:00:00Z", kind: "correction", schema_version: SCHEMA_VERSION,
      supersedes: "01J5ZZZZZZZZZZZZZZZZZZZZZZ", title: "fix", work_type: "other", claude_role: "none",
      tracker_key: null, epic_key: null, epic_name: null, sprint: null, repo: null, points: null,
      artifacts: { prs: [], commits: [], deploy: null, docs: [] },
      estimate_without_claude_hours: null, escrow: null, actual_hours: null,
      sessions: [], tokens: null, budget_tokens: null, time_saved_hours: null, notes: null,
    });
    appendEvents(home, "ledger", [ghost]);
    // duplicate line
    const p = shardPath(home, "ledger", "2026-08");
    appendFileSync(p, readFileSync(p, "utf8"), "utf8");
    // wrong shard: hand-place an event in the wrong month + wrong kind for stream
    const stray = finalizeEvent("ledger", {
      ts: "2026-09-01T00:00:00Z", kind: "usage", schema_version: SCHEMA_VERSION, supersedes: null,
    });
    appendFileSync(shardPath(home, "ledger", "2026-08"), JSON.stringify(stray) + "\n", "utf8");
    const found = checks(home);
    assert.ok(found.includes("supersedes"));
    assert.ok(found.includes("id_unique"));
    assert.ok(found.includes("shard_placement"));
    assert.ok(found.includes("envelope"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("verify: backdated pre-registration is flagged", () => {
  const home = tempHome();
  try {
    const { opened } = writeValidHome(home);
    void opened;
    rmSync(shardPath(home, "ledger", "2026-08"));
    const bad = finalizeEvent("ledger", {
      ts: "2026-08-10T09:12:00Z", kind: "opened", schema_version: SCHEMA_VERSION, supersedes: null,
      title: "Backdated", tracker_key: null, epic_key: null, epic_name: null, sprint: null,
      repo: null, work_type: "feature", points: null,
      artifacts: { prs: [], commits: [], deploy: null, docs: [] },
      estimate_without_claude_hours: {
        low: 5, high: 8, logged_at: "2026-08-12T00:00:00Z", pre_registered: true,
      },
      escrow: null, actual_hours: null, claude_role: "none",
      sessions: [], tokens: null, budget_tokens: null, time_saved_hours: null, notes: null,
    });
    appendEvents(home, "ledger", [bad]);
    const found = checks(home);
    assert.ok(found.includes("pre_registration"), `expected pre_registration in ${found}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
