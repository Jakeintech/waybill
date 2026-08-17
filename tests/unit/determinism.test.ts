import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { listShards, shardPath } from "../../src/core/streams.ts";
import type { StreamName } from "../../src/core/events.ts";
import { tempHome, writeValidHome } from "../helpers/fixtures.ts";

/** Byte-for-byte snapshot of every shard in a home. */
export function snapshotStreams(home: string): Map<string, string> {
  const snap = new Map<string, string>();
  const streams: StreamName[] = ["ledger", "usage", "sessions", "exceptions"];
  for (const stream of streams) {
    for (const shard of listShards(home, stream)) {
      snap.set(`${stream}/${shard}`, readFileSync(shardPath(home, stream, shard), "utf8"));
    }
  }
  return snap;
}

export function assertIdenticalStreams(a: string, b: string): void {
  const sa = snapshotStreams(a);
  const sb = snapshotStreams(b);
  assert.deepEqual([...sa.keys()].sort(), [...sb.keys()].sort(), "shard sets differ");
  for (const [key, bytes] of sa) {
    assert.equal(bytes, sb.get(key), `shard ${key} differs between runs`);
  }
}

test("determinism: identical inputs produce byte-identical streams", () => {
  const a = tempHome();
  const b = tempHome();
  try {
    writeValidHome(a);
    writeValidHome(b);
    assertIdenticalStreams(a, b);
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test("golden: fixture home shards match the committed golden bytes", () => {
  const home = tempHome();
  try {
    writeValidHome(home);
    const goldenDir = join(import.meta.dirname, "..", "golden", "valid-home");
    for (const [key, bytes] of snapshotStreams(home)) {
      const goldenPath = join(goldenDir, key.replace("/", "__") + ".jsonl");
      const golden = readFileSync(goldenPath, "utf8");
      assert.equal(bytes, golden, `golden mismatch for ${key} — if intentional, regenerate tests/golden/`);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
