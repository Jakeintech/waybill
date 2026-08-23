import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { listTranscripts, loadMeterContext, meterFile } from "../../src/meter/run.ts";
import { tempHome } from "../helpers/fixtures.ts";

// E-10: a walk shares one read of the home's streams across every file.
// The contract is behavioral equivalence — the shared context must
// produce byte-identical streams to per-file reloads, because events
// appended mid-walk are pushed back into it.
const PROJECTS = join(import.meta.dirname, "..", "fixtures", "transcripts", "v2.1", "agent-tree");

function streamBytes(home: string): string {
  const out: string[] = [];
  for (const stream of ["ledger", "usage", "sessions", "exceptions"]) {
    const dir = join(home, "streams", stream);
    let shards: string[] = [];
    try {
      shards = readdirSync(dir).sort();
    } catch {
      // stream never written
    }
    for (const shard of shards) out.push(`== ${stream}/${shard}\n` + readFileSync(join(dir, shard), "utf8"));
  }
  return out.join("");
}

test("shared meter context: byte-identical streams vs per-file reloads", () => {
  const cached = tempHome();
  const uncached = tempHome();
  try {
    const paths = listTranscripts(PROJECTS);
    assert.equal(paths.length, 3);

    const ctx = loadMeterContext(cached);
    for (const p of paths) meterFile(cached, p, "acme/platform", false, ctx);
    for (const p of paths) meterFile(uncached, p, "acme/platform");

    assert.equal(streamBytes(cached), streamBytes(uncached));

    // The context observed its own appends: a re-walk with a fresh context
    // (and with none) skips everything.
    const ctx2 = loadMeterContext(cached);
    for (const p of paths) {
      assert.equal(meterFile(cached, p, "acme/platform", false, ctx2).skipped, true);
      assert.equal(meterFile(uncached, p, "acme/platform").skipped, true);
    }
  } finally {
    rmSync(cached, { recursive: true, force: true });
    rmSync(uncached, { recursive: true, force: true });
  }
});
