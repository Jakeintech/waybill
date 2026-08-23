import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultConfig, saveConfig } from "../../src/core/config.ts";
import { computeNotice, noticeFile, queueNotice } from "../../src/cli/notice.ts";
import { makeUsage, makeSessionReceipt, tempHome } from "../helpers/fixtures.ts";
import { appendEvents } from "../../src/core/streams.ts";

// E-12: SessionStart runs no engine work. The miner queues the notice at
// SessionEnd (when thresholds actually cross — tokens land at mine time),
// and the hook serves the file with pure shell.
const ROOT = join(import.meta.dirname, "..", "..");
const HOOK = join(ROOT, "scripts", "session-start.sh");

function crossedHome(): string {
  const home = tempHome();
  const config = defaultConfig();
  config.allocations = [{ period: "2026-Q3", tokens_granted: 5000, granted_at: "2026-07-01" }];
  saveConfig(home, config);
  const usage = [makeUsage({ ts: "2026-08-10T10:00:00Z", tokens: { input: 4000, output: 500, cache_read: 0, cache_creation: 0 } })];
  appendEvents(home, "usage", usage);
  appendEvents(home, "sessions", [makeSessionReceipt(usage)]);
  return home;
}

function runHook(home: string): string {
  return execFileSync("bash", [HOOK], {
    encoding: "utf8",
    env: { ...process.env, WAYBILL_HOME: home },
  });
}

test("queueNotice writes the threshold line once; re-queue adds nothing", () => {
  const home = crossedHome();
  try {
    queueNotice(home, "2026-08-16T00:00:00Z");
    const queued = readFileSync(noticeFile(home), "utf8");
    assert.match(queued, /% of the 2026-Q3 token grant is spent/);

    queueNotice(home, "2026-08-16T01:00:00Z");
    assert.equal(readFileSync(noticeFile(home), "utf8"), queued); // marked shown at queue time

    // The manual CLI path sees the same marked state: nothing fresh.
    assert.deepEqual(computeNotice(home, "2026-08-16T02:00:00Z").lines, []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the SessionStart hook serves and consumes the queued notice with pure shell", () => {
  const home = crossedHome();
  try {
    queueNotice(home, "2026-08-16T00:00:00Z");
    const first = runHook(home);
    assert.match(first, /% of the 2026-Q3 token grant is spent/);
    assert.equal(existsSync(noticeFile(home)), false); // consumed
    assert.equal(runHook(home), ""); // nothing queued → silent
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the hook owns the not-initialized nudge: once ever, marker shared with the engine", () => {
  const home = join(mkdtempSync(join(tmpdir(), "wb-notice-")), "never-initialized");
  try {
    const first = runHook(home);
    assert.match(first, /not initialized\. Say "initialize my waybill ledger"/);
    assert.equal(runHook(home), ""); // announced once, ever
    const marker = JSON.parse(readFileSync(join(home, "rollups", "first-run.json"), "utf8")) as {
      uninitialized_announced: boolean;
    };
    assert.equal(marker.uninitialized_announced, true);
    // The engine's own notice path honors the shell-written marker.
    assert.deepEqual(computeNotice(home, "2026-08-16T00:00:00Z").lines, []);
  } finally {
    rmSync(join(home, ".."), { recursive: true, force: true });
  }
});

test("mine queues the notice for the next session start", () => {
  const home = crossedHome();
  try {
    execFileSync(process.execPath, [join(ROOT, "src", "cli", "main.ts"), "mine", "--queue"], {
      encoding: "utf8",
      env: { ...process.env, WAYBILL_HOME: home },
    });
    assert.match(readFileSync(noticeFile(home), "utf8"), /token grant is spent/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
