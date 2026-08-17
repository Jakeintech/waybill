// Regenerates tests/golden/valid-home from the fixture builders.
// Run: node tests/tools/regen-golden.ts
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listShards, shardPath } from "../../src/core/streams.ts";
import type { StreamName } from "../../src/core/events.ts";
import { tempHome, writeValidHome } from "../helpers/fixtures.ts";

const home = tempHome();
try {
  writeValidHome(home);
  const goldenDir = join(import.meta.dirname, "..", "golden", "valid-home");
  rmSync(goldenDir, { recursive: true, force: true });
  mkdirSync(goldenDir, { recursive: true });
  const streams: StreamName[] = ["ledger", "usage", "sessions", "exceptions"];
  for (const stream of streams) {
    for (const shard of listShards(home, stream)) {
      const bytes = readFileSync(shardPath(home, stream, shard), "utf8");
      writeFileSync(join(goldenDir, `${stream}__${shard}.jsonl`), bytes, "utf8");
      process.stdout.write(`wrote ${stream}__${shard}.jsonl (${bytes.length} bytes)\n`);
    }
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}
