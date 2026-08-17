import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseTranscript, evidenceFromCommand } from "../../src/meter/transcript.ts";
import { meterTranscript, priceTokens, type MeterInput } from "../../src/meter/meter.ts";
import { defaultConfig, type Config } from "../../src/core/config.ts";
import type { UsageEvent } from "../../src/core/events.ts";

const FIXTURES = join(import.meta.dirname, "..", "fixtures", "transcripts");
const OPTS = { branchKeyPattern: "[A-Z][A-Z0-9]+-[0-9]+" };

function fixture(rel: string): string {
  return readFileSync(join(FIXTURES, rel), "utf8");
}

function meterInput(raw: string, overrides: Partial<MeterInput> = {}): MeterInput {
  return {
    transcriptPath: "/tmp/fixture.jsonl",
    raw,
    repo: "acme/platform",
    config: defaultConfig(),
    ledgerEvents: [],
    existingUsage: [],
    existingSessions: [],
    existingExceptions: [],
    ...overrides,
  };
}

test("parse v2.1 basic: turns, dedupe by message id, cache split, extras", () => {
  const t = parseTranscript(fixture("v2.1/basic.jsonl"), OPTS);
  assert.equal(t.sessionId, "11111111-aaaa-4bbb-8ccc-000000000001");
  assert.equal(t.version, "2.1.229");
  assert.equal(t.turns.length, 2);
  assert.equal(t.messageCount, 3); // msg_basic_001 counted once despite two lines
  assert.deepEqual(t.totals, { input: 23, output: 670, cache_read: 4100, cache_creation: 1200 });
  const turn1 = t.turns[0]!;
  assert.equal(turn1.index, 1);
  assert.equal(turn1.models.length, 1);
  assert.deepEqual(turn1.models[0]!.tokens, {
    input: 15, output: 460, cache_read: 2500, cache_creation: 500,
    cache_creation_5m: 500, cache_creation_1h: 0,
  });
  const turn2 = t.turns[1]!;
  assert.deepEqual(turn2.models[0]!.tokens, {
    input: 8, output: 210, cache_read: 1600, cache_creation: 700,
    cache_creation_5m: 200, cache_creation_1h: 500,
  });
  // extras: server_tool_use flattened and summed
  assert.equal(turn2.models[0]!.extras["server_tool_use.web_search_requests"], 1);
});

test("parse v2.1 multiturn: sidechain rolls up, branch switch observed, evidence extracted", () => {
  const t = parseTranscript(fixture("v2.1/multiturn.jsonl"), OPTS);
  assert.equal(t.turns.length, 3);
  assert.deepEqual(t.branches, ["feat/PLAT-482-retry", "feat/DATA-77-ingest"]);
  assert.deepEqual(t.models, ["claude-opus-4-6", "claude-haiku-4-5-20251001"]);
  const turn2 = t.turns[1]!;
  assert.equal(turn2.models.length, 2); // opus + sidechain haiku in the same turn
  assert.deepEqual(t.totals, { input: 46, output: 790, cache_read: 4900, cache_creation: 400 });
  assert.deepEqual(
    t.evidence.map((e) => [e.key, e.source, e.turnIndex]),
    [["DATA-77", "branch_checkout", 1], ["DATA-77", "commit_message", 3]],
  );
});

test("parse v1 legacy: no promptId, no gitBranch, no cache_creation object", () => {
  const t = parseTranscript(fixture("v1/legacy.jsonl"), OPTS);
  assert.equal(t.version, "1.0.83");
  assert.equal(t.turns.length, 1);
  assert.equal(t.turns[0]!.promptId, null);
  assert.equal(t.turns[0]!.branchAtStart, null);
  assert.deepEqual(t.totals, { input: 100, output: 900, cache_read: 0, cache_creation: 250 });
  assert.equal(t.turns[0]!.models[0]!.tokens.cache_creation_5m, 0);
});

test("evidenceFromCommand: checkout, commit, pr forms", () => {
  const pat = /[A-Z][A-Z0-9]+-[0-9]+/g;
  assert.deepEqual(evidenceFromCommand("git checkout -b feat/ABC-1-x", pat), [
    { key: "ABC-1", source: "branch_checkout" },
  ]);
  assert.deepEqual(evidenceFromCommand("git commit -m 'ABC-2: fix'", pat), [
    { key: "ABC-2", source: "commit_message" },
  ]);
  assert.deepEqual(evidenceFromCommand("gh pr create --title 'ABC-3 done'", pat), [
    { key: "ABC-3", source: "pr_operation" },
  ]);
  assert.deepEqual(evidenceFromCommand("cat ABC-4.txt", pat), []);
});

test("meter: conservation holds — sum of usage events equals source totals", () => {
  const out = meterTranscript(meterInput(fixture("v2.1/multiturn.jsonl")));
  const sums = { input: 0, output: 0, cache_read: 0, cache_creation: 0 };
  for (const u of out.newUsage) {
    sums.input += u.tokens.input;
    sums.output += u.tokens.output;
    sums.cache_read += u.tokens.cache_read;
    sums.cache_creation += u.tokens.cache_creation;
  }
  assert.deepEqual(sums, out.transcript.totals);
  assert.deepEqual(out.newSessions[0]!.totals, out.transcript.totals);
  assert.equal(out.newExceptions.length, 0); // no discrepancy, no ambiguity
});

test("meter: attribution — rule 4 at turn 1, rule 3 forward from evidence", () => {
  const out = meterTranscript(meterInput(fixture("v2.1/multiturn.jsonl")));
  const byTurn = new Map<number, UsageEvent[]>();
  for (const u of out.newUsage) {
    byTurn.set(u.turn.index, [...(byTurn.get(u.turn.index) ?? []), u]);
  }
  const t1 = byTurn.get(1)![0]!;
  assert.equal(t1.attribution.resolver, "session_branch");
  assert.equal(t1.attribution.account, "story:PLAT-482");
  assert.equal(t1.attribution.confidence, 0.6);
  for (const u of byTurn.get(2)!) {
    assert.equal(u.attribution.resolver, "transcript_evidence");
    assert.equal(u.attribution.account, "story:DATA-77");
    assert.equal(u.attribution.confidence, 0.75);
  }
  const t3 = byTurn.get(3)![0]!;
  assert.equal(t3.attribution.account, "story:DATA-77");
});

test("meter: legacy session with no signals lands in unattributed", () => {
  const out = meterTranscript(meterInput(fixture("v1/legacy.jsonl"), { repo: null }));
  assert.equal(out.newUsage.length, 1);
  assert.equal(out.newUsage[0]!.attribution.account, "unattributed");
  assert.equal(out.newUsage[0]!.attribution.resolver, "none");
  assert.equal(out.newUsage[0]!.attribution.confidence, 1.0);
  assert.equal(out.newUsage[0]!.cost_usd, null); // model not in pricing table
});

test("meter: idempotent — feeding outputs back yields zero new events", () => {
  const raw = fixture("v2.1/basic.jsonl");
  const first = meterTranscript(meterInput(raw));
  const second = meterTranscript(
    meterInput(raw, {
      existingUsage: first.newUsage,
      existingSessions: first.newSessions,
      existingExceptions: first.newExceptions,
    }),
  );
  assert.equal(second.newUsage.length, 0);
  assert.equal(second.newSessions.length, 0);
  assert.equal(second.newExceptions.length, 0);
});

test("meter: deterministic — two runs produce identical serialized events", () => {
  const raw = fixture("v2.1/multiturn.jsonl");
  const a = meterTranscript(meterInput(raw));
  const b = meterTranscript(meterInput(raw));
  assert.equal(JSON.stringify(a.newUsage), JSON.stringify(b.newUsage));
  assert.equal(JSON.stringify(a.newSessions), JSON.stringify(b.newSessions));
});

test("meter: a grown transcript supersedes the changed turn and the receipt", () => {
  const raw = fixture("v2.1/basic.jsonl");
  const lines = raw.trimEnd().split("\n");
  const truncated = lines.slice(0, 5).join("\n") + "\n"; // ends mid-session: turn 1 only
  const first = meterTranscript(meterInput(truncated));
  assert.equal(first.newUsage.length, 1);
  const grown = meterTranscript(
    meterInput(raw, {
      existingUsage: first.newUsage,
      existingSessions: first.newSessions,
      existingExceptions: first.newExceptions,
    }),
  );
  // Turn 1 unchanged (same id, skipped); turn 2 is new; receipt superseded.
  assert.equal(grown.newUsage.length, 1);
  assert.equal(grown.newUsage[0]!.turn.index, 2);
  assert.equal(grown.newSessions.length, 1);
  assert.equal(grown.newSessions[0]!.supersedes, first.newSessions[0]!.id);
});

test("meter: pricing — configured model gets cost, version stamped", () => {
  const config: Config = {
    ...defaultConfig(),
    pricing: {
      version: "2026-08-01",
      unknown_model_policy: "tokens_only",
      models: {
        "claude-opus-4-6": {
          input_per_mtok: 15, output_per_mtok: 75, cache_read_per_mtok: 1.5,
          cache_write_5m_per_mtok: 18.75, cache_write_1h_per_mtok: 30,
        },
      },
    },
  };
  const out = meterTranscript(meterInput(fixture("v2.1/basic.jsonl"), { config }));
  const t1 = out.newUsage.find((u) => u.turn.index === 1)!;
  // (15*15 + 460*75 + 2500*1.5 + 500*18.75 + 0*30) / 1e6 = 0.047850
  assert.deepEqual(t1.cost_usd, { value: 0.0479, pricing_version: "2026-08-01" });
  const t2 = out.newUsage.find((u) => u.turn.index === 2)!;
  // (8*15 + 210*75 + 1600*1.5 + 200*18.75 + 500*30) / 1e6 = 0.037020
  assert.deepEqual(t2.cost_usd, { value: 0.037, pricing_version: "2026-08-01" });
});

test("priceTokens: legacy unsplit cache writes are priced at the 5m rate", () => {
  const config: Config = {
    ...defaultConfig(),
    pricing: {
      version: "2026-08-01",
      unknown_model_policy: "tokens_only",
      models: {
        m: {
          input_per_mtok: 0, output_per_mtok: 0, cache_read_per_mtok: 0,
          cache_write_5m_per_mtok: 10, cache_write_1h_per_mtok: 100,
        },
      },
    },
  };
  const cost = priceTokens(config, "m", {
    input: 0, output: 0, cache_read: 0, cache_creation: 1_000_000,
    cache_creation_5m: 0, cache_creation_1h: 0,
  });
  assert.deepEqual(cost, { value: 10, pricing_version: "2026-08-01" });
});
