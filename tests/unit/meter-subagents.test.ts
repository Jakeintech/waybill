import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { finalizeEvent, rootSessionId, SCHEMA_VERSION, subagentSessionId, type PinEntry, type SessionEvent, type UsageEvent } from "../../src/core/events.ts";
import { readEvents } from "../../src/core/streams.ts";
import { defaultConfig } from "../../src/core/config.ts";
import { parseTranscript } from "../../src/meter/transcript.ts";
import { meterTranscript } from "../../src/meter/meter.ts";
import { listTranscripts, listSubagentTranscripts, meterFile, meterFileWithSubagents } from "../../src/meter/run.ts";
import { spendData } from "../../src/projections/queries.ts";
import { verifyHome, zeroTotals, addTotals } from "../../src/verify/verify.ts";
import { tempHome } from "../helpers/fixtures.ts";

const FIXTURES = join(import.meta.dirname, "..", "fixtures", "transcripts");
const PROJECTS = join(FIXTURES, "v2.1", "agent-tree");
const MAIN = join(PROJECTS, "proj-acme", "33333333-cccc-4ddd-8eee-000000000003.jsonl");
const PARENT_SID = "33333333-cccc-4ddd-8eee-000000000003";
const OPTS = { branchKeyPattern: "[A-Z][A-Z0-9]+-[0-9]+" };

// Exact per-file sums of the fixture's usage lines (streamed duplicates
// dedupe by message id, so msg_sub_a01 counts once, at its final values).
const MAIN_TOTALS = { input: 15, output: 150, cache_read: 2200, cache_creation: 300 };
const SUB_A_TOTALS = { input: 18, output: 202, cache_read: 500, cache_creation: 500 };
const SUB_B_TOTALS = { input: 20, output: 40, cache_read: 300, cache_creation: 100 };

function fixture(path: string): string {
  return readFileSync(path, "utf8");
}

test("session-id helpers: compose and strip the subagent suffix; plain ids untouched", () => {
  assert.equal(subagentSessionId("abc", "a1"), "abc:agent-a1");
  assert.equal(rootSessionId("abc:agent-a1"), "abc");
  assert.equal(rootSessionId("abc"), "abc");
});

test("parse subagent transcript: agentId adopted from the identity line, usage deduped by message id", () => {
  const t = parseTranscript(fixture(join(PROJECTS, "proj-acme", PARENT_SID, "subagents", "agent-aaa111.jsonl")), OPTS);
  assert.equal(t.sessionId, PARENT_SID);
  assert.equal(t.agentId, "aaa111");
  assert.equal(t.messageCount, 2); // msg_sub_a01 counted once despite two streamed lines
  assert.deepEqual(t.totals, SUB_A_TOTALS);
  // Sidechain user lines never open turns: everything aggregates in turn 0.
  assert.equal(t.turns.length, 1);
  assert.equal(t.turns[0]!.index, 0);
  assert.equal(t.turns[0]!.branchAtStart, "feat/PLAT-482-retry");
});

test("parse main transcripts: inline sidechains never re-identify the file as an agent's", () => {
  // The committed multiturn fixture has inline isSidechain lines, no agentId.
  const multiturn = parseTranscript(
    fixture(join(FIXTURES, "v2.1", "multiturn.jsonl")),
    OPTS,
  );
  assert.equal(multiturn.agentId, null);
  // Adversarial: agentId appearing on a LATER line (inline sidechain) must
  // not composite the identity — only the identity line's agentId counts.
  const crafted = [
    JSON.stringify({ type: "user", isSidechain: false, sessionId: "root-1", message: { role: "user", content: "hi" }, timestamp: "2026-08-06T10:00:00Z" }),
    JSON.stringify({ type: "assistant", isSidechain: true, agentId: "sneaky", sessionId: "root-1", message: { id: "m1", model: "m", usage: { input_tokens: 1, output_tokens: 1 } }, timestamp: "2026-08-06T10:00:01Z" }),
  ].join("\n");
  const t = parseTranscript(crafted, OPTS);
  assert.equal(t.sessionId, "root-1");
  assert.equal(t.agentId, null);
});

test("listTranscripts walks projects/<proj>/<session>/subagents/*.jsonl; sidecar meta files ignored", () => {
  const paths = listTranscripts(PROJECTS);
  assert.equal(paths.length, 3);
  assert.ok(paths.includes(MAIN));
  assert.ok(paths.some((p) => p.endsWith("agent-aaa111.jsonl")));
  assert.ok(paths.some((p) => p.endsWith("agent-bbb222.jsonl")));
  assert.ok(!paths.some((p) => p.endsWith(".meta.json")));
  assert.deepEqual(listSubagentTranscripts(MAIN).length, 2);
});

test("metering a session with subagents: exact sum, no double-count, per-session conservation", () => {
  const home = tempHome();
  try {
    const results = listTranscripts(PROJECTS).map((p) => meterFile(home, p, "acme/platform"));
    // The parent's checkpoint must never swallow a subagent file (the
    // duplicate-session guard keys on the composite id).
    assert.ok(results.every((r) => !r.skipped));

    const usage = readEvents<UsageEvent>(home, "usage").filter((u) => u.kind === "usage");
    const sessions = readEvents<SessionEvent>(home, "sessions").filter((s) => s.kind === "session");

    // One usage event per (session, turn, model): 2 main turns + 1 per agent.
    assert.equal(usage.length, 4);
    assert.equal(new Set(usage.map((u) => u.id)).size, 4); // each counted once
    assert.deepEqual(
      sessions.map((s) => s.session_id).sort(),
      [PARENT_SID, `${PARENT_SID}:agent-aaa111`, `${PARENT_SID}:agent-bbb222`],
    );

    // Main-transcript usage lines carry no isSidechain flag on their usage —
    // totals are the exact sum of the three files, each event once.
    const summed = zeroTotals();
    for (const u of usage) addTotals(summed, u.tokens);
    const expected = zeroTotals();
    for (const t of [MAIN_TOTALS, SUB_A_TOTALS, SUB_B_TOTALS]) addTotals(expected, t);
    assert.deepEqual(summed, expected);
    assert.deepEqual(expected, { input: 53, output: 392, cache_read: 3000, cache_creation: 900 });

    // Per-session conservation, subagent sessions included: verify is green.
    assert.deepEqual(verifyHome(home), []);

    // Fast path: a second pass over unchanged files skips everything.
    const rerun = listTranscripts(PROJECTS).map((p) => meterFile(home, p, "acme/platform"));
    assert.ok(rerun.every((r) => r.skipped));

    // Session counts group by root: one session, subagents included.
    const spend = spendData(usage, [], [], defaultConfig(), { from: null, to: null });
    const account = spend.accounts.find((a) => a.account === "story:PLAT-482");
    assert.ok(account);
    assert.equal(account.sessions, 1);
    assert.equal(account.tokens, 53 + 392 + 3000 + 900);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("meterFileWithSubagents: a queued main transcript brings its sibling agents along", () => {
  const home = tempHome();
  try {
    const results = meterFileWithSubagents(home, MAIN, "acme/platform");
    assert.equal(results.length, 3);
    assert.equal(results[0]!.session_id, PARENT_SID);
    assert.deepEqual(
      results.slice(1).map((r) => r.session_id).sort(),
      [`${PARENT_SID}:agent-aaa111`, `${PARENT_SID}:agent-bbb222`],
    );
    assert.deepEqual(verifyHome(home), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a whole-session pin on the parent covers its subagent transcripts", () => {
  const pin = finalizeEvent("ledger", {
    ts: "2026-08-06T09:00:00Z",
    kind: "pin" as const,
    schema_version: SCHEMA_VERSION,
    supersedes: null,
    session_id: PARENT_SID,
    account: "story:DATA-99",
    tracker_key: "DATA-99",
    range: null,
    notes: null,
  }) as PinEntry;
  const out = meterTranscript({
    transcriptPath: "/tmp/agent-aaa111.jsonl",
    raw: fixture(join(PROJECTS, "proj-acme", PARENT_SID, "subagents", "agent-aaa111.jsonl")),
    repo: "acme/platform",
    config: defaultConfig(),
    ledgerEvents: [pin],
    existingUsage: [],
    existingSessions: [],
    existingExceptions: [],
  });
  assert.equal(out.sessionId, `${PARENT_SID}:agent-aaa111`);
  assert.equal(out.newUsage.length, 1);
  assert.equal(out.newUsage[0]!.attribution.resolver, "pin");
  assert.equal(out.newUsage[0]!.attribution.account, "story:DATA-99");
});
