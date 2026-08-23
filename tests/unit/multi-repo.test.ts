import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";

import { meterTranscript } from "../../src/meter/meter.ts";
import { parseTranscript } from "../../src/meter/transcript.ts";
import { defaultConfig } from "../../src/core/config.ts";
import { appendEvents } from "../../src/core/streams.ts";
import { splitFindings, verifyHome } from "../../src/verify/verify.ts";
import { tempHome } from "../helpers/fixtures.ts";

// E-14 (warn-only): a session that ran in several working directories
// books ALL its spend via the first cwd's repo. Until per-turn split
// attribution exists, the booking is disclosed, not silently wrong.

const OPTS = { branchKeyPattern: "[A-Z][A-Z0-9]+-[0-9]+" };

function line(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}

function twoRepoTranscript(): string {
  const base = { isSidechain: false, sessionId: "44444444-dddd-4eee-8fff-000000000004", version: "2.1.241" };
  return [
    line({ ...base, type: "user", promptId: "p1", cwd: "/home/dev/acme/platform", gitBranch: "feat/PLAT-1-x", timestamp: "2026-08-07T09:00:00Z", message: { role: "user", content: "work here" } }),
    line({ ...base, type: "assistant", cwd: "/home/dev/acme/platform", gitBranch: "feat/PLAT-1-x", timestamp: "2026-08-07T09:01:00Z", message: { id: "mm1", model: "claude-opus-4-6", role: "assistant", usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }),
    line({ ...base, type: "user", promptId: "p2", cwd: "/home/dev/acme/data-pipeline", gitBranch: "feat/DATA-2-y", timestamp: "2026-08-07T09:10:00Z", message: { role: "user", content: "now the other repo" } }),
    line({ ...base, type: "assistant", cwd: "/home/dev/acme/data-pipeline", gitBranch: "feat/DATA-2-y", timestamp: "2026-08-07T09:11:00Z", message: { id: "mm2", model: "claude-opus-4-6", role: "assistant", usage: { input_tokens: 5, output_tokens: 8, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }),
  ].join("\n");
}

test("parser records every distinct cwd; attribution still uses the first", () => {
  const t = parseTranscript(twoRepoTranscript(), OPTS);
  assert.deepEqual(t.cwds, ["/home/dev/acme/platform", "/home/dev/acme/data-pipeline"]);
  assert.equal(t.cwd, "/home/dev/acme/platform"); // first wins, unchanged
});

test("multi-repo receipts carry cwds; single-cwd receipts keep their pre-2.1 shape", () => {
  const config = defaultConfig();
  const multi = meterTranscript({
    transcriptPath: "/tmp/multi.jsonl", raw: twoRepoTranscript(), repo: "acme/platform",
    config, ledgerEvents: [], existingUsage: [], existingSessions: [], existingExceptions: [],
  });
  assert.deepEqual(multi.newSessions[0]!.cwds, ["/home/dev/acme/platform", "/home/dev/acme/data-pipeline"]);

  const singleRaw = twoRepoTranscript().replaceAll("/home/dev/acme/data-pipeline", "/home/dev/acme/platform");
  const single = meterTranscript({
    transcriptPath: "/tmp/single.jsonl", raw: singleRaw, repo: "acme/platform",
    config, ledgerEvents: [], existingUsage: [], existingSessions: [], existingExceptions: [],
  });
  assert.equal("cwds" in single.newSessions[0]!, false); // absent, so old ids never churn
});

test("verify discloses a multi-repo session as a warning, never a failure", () => {
  const home = tempHome();
  try {
    const out = meterTranscript({
      transcriptPath: "/tmp/multi.jsonl", raw: twoRepoTranscript(), repo: "acme/platform",
      config: defaultConfig(), ledgerEvents: [], existingUsage: [], existingSessions: [], existingExceptions: [],
    });
    appendEvents(home, "usage", out.newUsage);
    appendEvents(home, "sessions", out.newSessions);
    appendEvents(home, "exceptions", out.newExceptions);
    const { errors, warnings } = splitFindings(verifyHome(home));
    assert.equal(errors.length, 0);
    const multiRepo = warnings.filter((w) => w.check === "multi_repo");
    assert.equal(multiRepo.length, 1);
    assert.match(multiRepo[0]!.message, /ran in 2 working directories/);
    assert.match(multiRepo[0]!.message, /attributed via the first/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
