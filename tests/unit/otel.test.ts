import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { meterOtel, parseOtelExport } from "../../src/meter/otel.ts";
import { defaultConfig } from "../../src/core/config.ts";
import { readEvents } from "../../src/core/streams.ts";
import type { SessionEvent, UsageEvent } from "../../src/core/events.ts";
import { meterFile } from "../../src/meter/run.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const OTEL = join(ROOT, "tests", "fixtures", "otel", "token-usage.jsonl");
const TRANSCRIPT = join(ROOT, "tests", "fixtures", "transcripts", "v2.1", "basic.jsonl");

function cli(home: string, args: string[]): string {
  return execFileSync(process.execPath, [join(ROOT, "src", "cli", "main.ts"), ...args], {
    encoding: "utf8",
    env: { ...process.env, WAYBILL_HOME: home },
  });
}

test("otel: parses token.usage points per session/model/type, ignores other metrics", () => {
  const parsed = parseOtelExport(readFileSync(OTEL, "utf8"));
  assert.equal(parsed.size, 2);
  const s5 = parsed.get("55555555-aaaa-4bbb-8ccc-000000000005")!;
  assert.deepEqual(s5.models.get("claude-opus-4-6"), {
    input: 1200, output: 800, cache_read: 50000, cache_creation: 3000,
  });
});

test("otel: fills only transcript-less sessions — transcript wins, never mixes", () => {
  const home = mkdtempSync(join(tmpdir(), "wb-otel-"));
  try {
    // Session ...0001 has a metered transcript; the OTel export also
    // mentions it with a bogus 999999-input point that must be ignored.
    meterFile(home, TRANSCRIPT, "acme/platform");
    const out = cli(home, ["meter", "--otel", OTEL]);
    assert.match(out, /\+1 usage event\(s\) across 1 session\(s\)/);
    assert.match(out, /1 session\(s\) skipped — transcript is the source of truth/);

    const usage = readEvents<UsageEvent>(home, "usage");
    const otelEvents = usage.filter((u) => u.source === "otel");
    assert.equal(otelEvents.length, 1);
    assert.equal(otelEvents[0]!.session_id, "55555555-aaaa-4bbb-8ccc-000000000005");
    assert.deepEqual(otelEvents[0]!.tokens, {
      input: 1200, output: 800, cache_read: 50000, cache_creation: 3000,
      cache_creation_5m: 0, cache_creation_1h: 0,
    });
    // The transcript-backed session kept its transcript numbers.
    const s1 = usage.filter((u) => u.session_id === "11111111-aaaa-4bbb-8ccc-000000000001");
    assert.ok(s1.every((u) => u.source === "transcript"));
    assert.ok(s1.every((u) => u.tokens.input < 999999));

    const receipts = readEvents<SessionEvent>(home, "sessions");
    assert.equal(receipts.filter((r) => r.source === "otel").length, 1);

    // Conservation holds across mixed-source streams; re-run is a no-op.
    assert.match(cli(home, ["verify"]), /All checks passed/);
    const again = cli(home, ["meter", "--otel", OTEL]);
    assert.match(again, /\+0 usage event\(s\)/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("otel: deterministic output", () => {
  const input = {
    raw: readFileSync(OTEL, "utf8"),
    config: defaultConfig(),
    ledgerEvents: [],
    existingUsage: [],
    existingSessions: [],
    existingExceptions: [],
  };
  const a = meterOtel(input);
  const b = meterOtel(input);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});
