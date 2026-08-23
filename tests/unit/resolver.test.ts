// The T2 harness: a declarative case table exercising every resolver rule
// (1–6), every fall-through, range pins, segmentation semantics, and
// ambiguity routing to the attribution inbox.
import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveTurn, RULES_VERSION, type ResolverContext } from "../../src/attribution/resolver.ts";
import type { Turn } from "../../src/meter/transcript.ts";
import { finalizeEvent, SCHEMA_VERSION, type LedgerEntry, type PinEntry } from "../../src/core/events.ts";
import { meterTranscript } from "../../src/meter/meter.ts";
import { defaultConfig } from "../../src/core/config.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeOpened } from "../helpers/fixtures.ts";

const SESSION = "9f4c1e2a-77aa-4b02-9d31-5c2f8ab9d001";

function turn(index: number, overrides: Partial<Turn> = {}): Turn {
  return {
    index,
    promptId: null,
    branchAtStart: null,
    cwdAtStart: null,
    firstMessageId: `msg_first_${index}`,
    lastMessageId: `msg_last_${index}`,
    models: [
      {
        model: "claude-opus-4-6",
        tokens: { input: 1, output: 1, cache_read: 0, cache_creation: 0, cache_creation_5m: 0, cache_creation_1h: 0 },
        extras: {},
        lastTs: `2026-08-17T10:${String(10 + index).padStart(2, "0")}:00Z`,
      },
    ],
    waste: { retried_commands: 0, repeated_reads: 0 },
    overhead: false,
    ...overrides,
  };
}

function pin(overrides: Partial<PinEntry> = {}): PinEntry {
  const body = {
    ts: overrides.ts ?? "2026-08-17T09:00:00Z",
    kind: "pin" as const,
    schema_version: SCHEMA_VERSION,
    supersedes: overrides.supersedes ?? null,
    session_id: overrides.session_id ?? SESSION,
    account: overrides.account ?? "story:PLAT-482",
    tracker_key: overrides.tracker_key ?? "PLAT-482",
    range: overrides.range ?? null,
    notes: null,
  };
  return finalizeEvent("ledger", body) as PinEntry;
}

function ctx(overrides: Partial<ResolverContext> = {}): ResolverContext {
  return {
    sessionId: SESSION,
    repo: "acme/platform",
    branchKeyPattern: "[A-Z][A-Z0-9]+-[0-9]+",
    pins: [],
    openEntries: [],
    repoDefaults: {},
    evidence: [],
    ...overrides,
  };
}

interface Case {
  name: string;
  turn: Turn;
  ctx: ResolverContext;
  expect: { account: string; resolver: string; confidence: number };
  ambiguity?: { rule: string; candidates: string[] };
}

const CASES: Case[] = [
  {
    name: "rule 1: whole-session pin wins at 1.0",
    turn: turn(1, { branchAtStart: "feat/OTHER-9-x" }),
    ctx: ctx({ pins: [pin()] }),
    expect: { account: "story:PLAT-482", resolver: "pin", confidence: 1.0 },
  },
  {
    name: "rule 1: range pin covering the turn wins",
    turn: turn(2),
    ctx: ctx({ pins: [pin({ range: { from: "2026-08-17T10:00:00Z", to: null } })] }),
    expect: { account: "story:PLAT-482", resolver: "pin", confidence: 1.0 },
  },
  {
    name: "rule 1 → 6: range pin not covering the turn falls through",
    turn: turn(2),
    ctx: ctx({ pins: [pin({ range: { from: "2026-08-17T11:00:00Z", to: null } })] }),
    expect: { account: "unattributed", resolver: "none", confidence: 1.0 },
  },
  {
    name: "rule 1: conflicting pins queue an ambiguity and fall through to rule 2",
    turn: turn(1),
    ctx: ctx({
      pins: [pin(), pin({ account: "story:DATA-77", tracker_key: "DATA-77", ts: "2026-08-17T09:05:00Z" })],
      openEntries: [makeOpened({ tracker_key: "INT-9", title: "x" })],
    }),
    expect: { account: "story:INT-9", resolver: "active_entry", confidence: 0.9 },
    ambiguity: { rule: "pin", candidates: ["story:DATA-77", "story:PLAT-482"] },
  },
  {
    name: "rule 2: exactly one open entry for the repo",
    turn: turn(1),
    ctx: ctx({ openEntries: [makeOpened()] }),
    expect: { account: "story:PLAT-482", resolver: "active_entry", confidence: 0.9 },
  },
  {
    name: "rule 2: open entry with null repo matches any session repo",
    turn: turn(1),
    ctx: ctx({ openEntries: [makeOpened({ repo: null })] }),
    expect: { account: "story:PLAT-482", resolver: "active_entry", confidence: 0.9 },
  },
  {
    name: "rule 2 skips entries for other repos",
    turn: turn(1),
    ctx: ctx({ openEntries: [makeOpened({ repo: "acme/other" })] }),
    expect: { account: "unattributed", resolver: "none", confidence: 1.0 },
  },
  {
    name: "rule 2 → 3: two open entries queue ambiguity, evidence breaks the tie",
    turn: turn(3),
    ctx: ctx({
      openEntries: [
        makeOpened(),
        makeOpened({ tracker_key: "DATA-77", title: "Ingest dedupe", ts: "2026-08-11T09:00:00Z" }),
      ],
      evidence: [{ key: "DATA-77", source: "commit_message", turnIndex: 2 }],
    }),
    expect: { account: "story:DATA-77", resolver: "transcript_evidence", confidence: 0.75 },
    ambiguity: { rule: "active_entry", candidates: ["story:DATA-77", "story:PLAT-482"] },
  },
  {
    name: "rule 3: evidence applies strictly forward — not to its own turn",
    turn: turn(2, { branchAtStart: "feat/PLAT-482-retry" }),
    ctx: ctx({ evidence: [{ key: "DATA-77", source: "branch_checkout", turnIndex: 2 }] }),
    expect: { account: "story:PLAT-482", resolver: "session_branch", confidence: 0.6 },
  },
  {
    name: "rule 3: latest applicable evidence wins",
    turn: turn(5),
    ctx: ctx({
      evidence: [
        { key: "DATA-77", source: "branch_checkout", turnIndex: 1 },
        { key: "PLAT-482", source: "commit_message", turnIndex: 3 },
      ],
    }),
    expect: { account: "story:PLAT-482", resolver: "transcript_evidence", confidence: 0.75 },
  },
  {
    name: "rule 4: key parsed from the turn's branch",
    turn: turn(1, { branchAtStart: "feat/PLAT-482-retry" }),
    ctx: ctx(),
    expect: { account: "story:PLAT-482", resolver: "session_branch", confidence: 0.6 },
  },
  {
    name: "rule 4: branch without a key falls through",
    turn: turn(1, { branchAtStart: "main" }),
    ctx: ctx(),
    expect: { account: "unattributed", resolver: "none", confidence: 1.0 },
  },
  {
    name: "rule 5: repo default (bare key becomes a story account)",
    turn: turn(1),
    ctx: ctx({ repoDefaults: { "acme/platform": "PLAT-999" } }),
    expect: { account: "story:PLAT-999", resolver: "repo_default", confidence: 0.4 },
  },
  {
    name: "rule 5: repo default may name an adhoc account",
    turn: turn(1),
    ctx: ctx({ repoDefaults: { "acme/platform": "adhoc:infra" } }),
    expect: { account: "adhoc:infra", resolver: "repo_default", confidence: 0.4 },
  },
  {
    name: "rule 5: null default falls through",
    turn: turn(1),
    ctx: ctx({ repoDefaults: { "acme/platform": null } }),
    expect: { account: "unattributed", resolver: "none", confidence: 1.0 },
  },
  {
    name: "rule 6: nothing matches — unattributed, honestly, at 1.0",
    turn: turn(1),
    ctx: ctx({ repo: null }),
    expect: { account: "unattributed", resolver: "none", confidence: 1.0 },
  },
];

for (const c of CASES) {
  test(`T2: ${c.name}`, () => {
    const r = resolveTurn(c.turn, c.ctx);
    assert.equal(r.attribution.account, c.expect.account);
    assert.equal(r.attribution.resolver, c.expect.resolver);
    assert.equal(r.attribution.confidence, c.expect.confidence);
    assert.equal(r.attribution.rules_version, RULES_VERSION);
    if (c.expect.account.startsWith("story:")) {
      assert.equal(r.attribution.tracker_key, c.expect.account.slice("story:".length));
    } else {
      assert.equal(r.attribution.tracker_key, null);
    }
    if (c.ambiguity) {
      assert.deepEqual(r.ambiguity, c.ambiguity);
    } else {
      assert.equal(r.ambiguity, null);
    }
  });
}

test("inbox: two open entries during metering queue one ambiguity per turn, deduped across runs", () => {
  const raw = readFileSync(
    join(import.meta.dirname, "..", "fixtures", "transcripts", "v1", "legacy.jsonl"),
    "utf8",
  );
  const ledgerEvents = [
    makeOpened({ repo: null }),
    makeOpened({ tracker_key: "DATA-77", title: "Ingest dedupe", repo: null, ts: "2026-08-11T09:00:00Z" }),
  ];
  const input = {
    transcriptPath: "/tmp/legacy.jsonl",
    raw,
    repo: null,
    config: defaultConfig(),
    ledgerEvents,
    existingUsage: [],
    existingSessions: [],
    existingExceptions: [],
  };
  const out = meterTranscript(input);
  const ambiguities = out.newExceptions.filter((e) => e.kind === "ambiguity");
  assert.equal(ambiguities.length, 1);
  assert.deepEqual((ambiguities[0] as { candidates: string[] }).candidates, [
    "story:DATA-77",
    "story:PLAT-482",
  ]);
  // usage still lands via a lower rule — a queued ambiguity never drops tokens
  assert.equal(out.newUsage.length, 1);
  assert.equal(out.newUsage[0]!.attribution.account, "unattributed");
  // re-run with the ambiguity present: deduped, not re-queued
  const again = meterTranscript({ ...input, existingUsage: out.newUsage, existingSessions: out.newSessions, existingExceptions: out.newExceptions });
  assert.equal(again.newExceptions.length, 0);
});
