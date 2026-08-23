import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";

import { meterTranscript, type MeterInput } from "../../src/meter/meter.ts";
import { parseTranscript } from "../../src/meter/transcript.ts";
import { defaultConfig } from "../../src/core/config.ts";
import { appendEvents } from "../../src/core/streams.ts";
import { splitFindings, verifyHome } from "../../src/verify/verify.ts";
import { makeOpened, makeSessionReceipt, makeUsage, tempHome } from "../helpers/fixtures.ts";

// E-14, completed (rules v3): a session that ran in several working
// directories attributes each turn via the directory active at the
// turn's START (FR-A3 — a turn is never split). Single-directory
// sessions keep the session-level repo exactly as before, so their
// events never churn on upgrade. verify's disclosure fires only for
// sessions still carrying pre-split (< v3) attribution, and retires
// itself after the re-meter the rules bump triggers.

const OPTS = { branchKeyPattern: "[A-Z][A-Z0-9]+-[0-9]+" };
const PLATFORM = "/home/dev/acme/platform";
const PIPELINE = "/home/dev/acme/data-pipeline";

function line(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}

function twoRepoTranscript(branches: [string, string] = ["feat/PLAT-1-x", "feat/DATA-2-y"]): string {
  const base = { isSidechain: false, sessionId: "44444444-dddd-4eee-8fff-000000000004", version: "2.1.241" };
  return [
    line({ ...base, type: "user", promptId: "p1", cwd: PLATFORM, gitBranch: branches[0], timestamp: "2026-08-07T09:00:00Z", message: { role: "user", content: "work here" } }),
    line({ ...base, type: "assistant", cwd: PLATFORM, gitBranch: branches[0], timestamp: "2026-08-07T09:01:00Z", message: { id: "mm1", model: "claude-opus-4-6", role: "assistant", usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }),
    line({ ...base, type: "user", promptId: "p2", cwd: PIPELINE, gitBranch: branches[1], timestamp: "2026-08-07T09:10:00Z", message: { role: "user", content: "now the other repo" } }),
    line({ ...base, type: "assistant", cwd: PIPELINE, gitBranch: branches[1], timestamp: "2026-08-07T09:11:00Z", message: { id: "mm2", model: "claude-opus-4-6", role: "assistant", usage: { input_tokens: 5, output_tokens: 8, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }),
  ].join("\n");
}

const REPO_BY_CWD: Record<string, string> = {
  [PLATFORM]: "acme/platform",
  [PIPELINE]: "acme/data-pipeline",
};

function meter(raw: string, overrides: Partial<MeterInput> = {}) {
  return meterTranscript({
    transcriptPath: "/tmp/multi.jsonl",
    raw,
    repo: "acme/platform",
    config: defaultConfig(),
    ledgerEvents: [],
    existingUsage: [],
    existingSessions: [],
    existingExceptions: [],
    resolveRepo: (cwd) => REPO_BY_CWD[cwd] ?? null,
    ...overrides,
  });
}

test("parser records every distinct cwd and each turn's cwd at start", () => {
  const t = parseTranscript(twoRepoTranscript(), OPTS);
  assert.deepEqual(t.cwds, [PLATFORM, PIPELINE]);
  assert.equal(t.cwd, PLATFORM); // first-seen, unchanged
  assert.deepEqual(t.turns.map((x) => x.cwdAtStart), [PLATFORM, PIPELINE]);
});

test("per-turn repo: each turn's events carry the repo of the directory active at its start", () => {
  const out = meter(twoRepoTranscript());
  assert.deepEqual(
    out.newUsage.map((u) => [u.turn.index, u.repo, u.attribution.account]),
    [
      [1, "acme/platform", "story:PLAT-1"],
      [2, "acme/data-pipeline", "story:DATA-2"],
    ],
  );
  assert.ok(out.newUsage.every((u) => u.attribution.rules_version === "3"));
  // The receipt stays session-level and discloses the directories.
  assert.equal(out.newSessions[0]!.repo, "acme/platform");
  assert.deepEqual(out.newSessions[0]!.cwds, [PLATFORM, PIPELINE]);
});

test("per-turn active_entry: two open entries in two repos resolve per turn, no inbox noise", () => {
  // Keyless branches so rule 2 (not the branch key) must decide.
  const raw = twoRepoTranscript(["main", "main"]);
  const entryA = makeOpened({ tracker_key: "PLAT-900", repo: "acme/platform", ts: "2026-08-01T00:00:00Z" });
  const entryB = makeOpened({ tracker_key: "DATA-900", repo: "acme/data-pipeline", ts: "2026-08-01T01:00:00Z" });
  const out = meter(raw, { ledgerEvents: [entryA, entryB] });
  assert.deepEqual(
    out.newUsage.map((u) => [u.turn.index, u.attribution.resolver, u.attribution.account]),
    [
      [1, "active_entry", "story:PLAT-900"],
      [2, "active_entry", "story:DATA-900"],
    ],
  );
  assert.equal(out.newExceptions.length, 0); // settled per turn — nothing for the inbox
});

test("precedence: multi-directory derives then falls back to the hint; single-directory keeps hint-first", () => {
  // Unknown second directory → derivation null → the session hint covers it.
  const raw = twoRepoTranscript().replaceAll(PIPELINE, "/somewhere/unmapped");
  const out = meter(raw);
  assert.deepEqual(out.newUsage.map((u) => u.repo), ["acme/platform", "acme/platform"]);

  // Single-directory: the hint wins even when derivation would disagree —
  // upgraded ledgers must not see these events churn.
  const single = twoRepoTranscript().replaceAll(PIPELINE, PLATFORM);
  const out2 = meter(single, { resolveRepo: () => "derived/other" });
  assert.deepEqual(out2.newUsage.map((u) => u.repo), ["acme/platform", "acme/platform"]);
  assert.equal("cwds" in out2.newSessions[0]!, false); // single-cwd receipt shape unchanged
});

test("verify: fresh (v3) multi-repo sessions are silent; pre-split usage still warns, followably", () => {
  const home = tempHome();
  try {
    const out = meter(twoRepoTranscript());
    appendEvents(home, "usage", out.newUsage);
    appendEvents(home, "sessions", out.newSessions);
    assert.deepEqual(verifyHome(home), []); // split attribution: nothing to disclose
  } finally {
    rmSync(home, { recursive: true, force: true });
  }

  const legacy = tempHome();
  try {
    // A ledger metered before the split: rules v2 usage + a cwds receipt.
    const u = makeUsage({ ts: "2026-08-07T09:01:00Z", session_id: "legacy-sess-1", rulesVersion: "2" });
    const receipt = makeSessionReceipt([u], { session_id: "legacy-sess-1", cwds: [PLATFORM, PIPELINE] });
    appendEvents(legacy, "usage", [u]);
    appendEvents(legacy, "sessions", [receipt]);
    const { errors, warnings } = splitFindings(verifyHome(legacy));
    assert.equal(errors.length, 0);
    const multi = warnings.filter((w) => w.check === "multi_repo");
    assert.equal(multi.length, 1);
    assert.match(multi[0]!.message, /pre-split rules/);
    assert.match(multi[0]!.message, /meter --all re-attributes it per turn/);
  } finally {
    rmSync(legacy, { recursive: true, force: true });
  }
});
