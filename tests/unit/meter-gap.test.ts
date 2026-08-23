import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { finalizeEvent, SCHEMA_VERSION, type MeterGapEvent } from "../../src/core/events.ts";
import { appendEvents } from "../../src/core/streams.ts";
import { splitFindings, verifyHome } from "../../src/verify/verify.ts";
import { tempHome, writeValidHome } from "../helpers/fixtures.ts";

// The pack is exercised through the CLI: importing cmd-pack would drag in
// main.ts, whose entry auto-run exits the test process.
const ROOT = join(import.meta.dirname, "..", "..");

function cli(home: string, args: string[]): string {
  return execFileSync(process.execPath, [join(ROOT, "src", "cli", "main.ts"), ...args], {
    encoding: "utf8",
    env: { ...process.env, WAYBILL_HOME: home },
  });
}

// E-11: a session whose transcript is gone before metering has no usage
// events, so conservation cannot see it — the gap marker must reach
// verify (as a warning) and travel in every pack, or green quietly means
// "minus whatever is missing".

function gapEvent(sessionId: string): MeterGapEvent {
  return finalizeEvent("exceptions", {
    ts: "2026-08-05T00:00:00Z",
    kind: "meter_gap" as const,
    schema_version: SCHEMA_VERSION,
    supersedes: null,
    session_id: sessionId,
    reason: "transcript_pruned" as const,
  }) as MeterGapEvent;
}

test("verify discloses meter gaps as warnings, never failures", () => {
  const home = tempHome();
  try {
    writeValidHome(home);
    appendEvents(home, "exceptions", [gapEvent("dead-beef-0001")]);
    const { errors, warnings } = splitFindings(verifyHome(home));
    assert.equal(errors.length, 0);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]!.check, "meter_gap");
    assert.match(warnings[0]!.message, /dead-beef-0001.*pruned before metering.*missing from every total/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("packs carry gap markers and say what the totals do not contain", () => {
  const home = tempHome();
  const out = join(mkdtempSync(join(tmpdir(), "wb-pack-")), "pack");
  try {
    writeValidHome(home);
    appendEvents(home, "exceptions", [gapEvent("dead-beef-0002")]);

    // The gap session has no in-window usage — no window can select it —
    // yet the marker must travel and the README must disclose it. Warnings
    // never block the recipient's evidence: the pack builds.
    cli(home, ["export", "--pack", "--out", out, "--from", "2026-08-01", "--to", "2026-08-31"]);

    const packedExceptions = readFileSync(join(out, "streams", "exceptions", "2026-08.jsonl"), "utf8");
    assert.match(packedExceptions, /"meter_gap"/);
    assert.match(packedExceptions, /dead-beef-0002/);

    const readme = readFileSync(join(out, "README.md"), "utf8");
    assert.match(readme, /Missing sessions, disclosed/);
    assert.match(readme, /1 session\(s\) carry a `meter_gap` marker/);

    const meta = JSON.parse(readFileSync(join(out, "pack.json"), "utf8")) as {
      sessions: number;
      gap_sessions: number;
    };
    assert.equal(meta.sessions, 1);
    assert.equal(meta.gap_sessions, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(join(out, ".."), { recursive: true, force: true });
  }
});
