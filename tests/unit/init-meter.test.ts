import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SessionEvent } from "../../src/core/events.ts";
import { readEvents } from "../../src/core/streams.ts";

// E-04: the first receipt must contain tokens. `init` meters every
// existing transcript — subagent transcripts included — so a user with
// months of history sees real totals immediately, not "no metered
// sessions".
const ROOT = join(import.meta.dirname, "..", "..");
const PROJECTS = join(ROOT, "tests", "fixtures", "transcripts", "v2.1", "agent-tree");

function cli(home: string, args: string[]): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [join(ROOT, "src", "cli", "main.ts"), ...args], {
      encoding: "utf8",
      env: { ...process.env, WAYBILL_HOME: home },
    });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

test("init meters existing transcripts (subagents included) with a progress line", () => {
  const home = mkdtempSync(join(tmpdir(), "wb-init-meter-"));
  try {
    const r = execFileSync(
      process.execPath,
      [join(ROOT, "src", "cli", "main.ts"), "init", "--claude-settings", "/nonexistent", "--projects-dir", PROJECTS],
      { encoding: "utf8", env: { ...process.env, WAYBILL_HOME: home }, stdio: ["ignore", "pipe", "pipe"] },
    );
    // The receipt-ready state: main + two subagent transcripts metered.
    const receipts = readEvents<SessionEvent>(home, "sessions").filter((s) => s.kind === "session");
    assert.equal(receipts.length, 3);
    assert.match(r, /metered transcripts \(3 session\(s\) mined now, 0 already current\)/);

    // Re-init: everything already current, still reported, never re-mined.
    const again = cli(home, ["init", "--claude-settings", "/nonexistent", "--projects-dir", PROJECTS]);
    assert.equal(again.code, 0);
    assert.match(again.stdout, /metered transcripts \(0 session\(s\) mined now, 3 already current\)/);

    // A bootstrap receipt over the fixture window now carries tokens.
    const receipt = cli(home, ["bootstrap", "--from", "2026-08-01", "--to", "2026-08-10"]);
    assert.match(receipt.stdout, /TOKENS    1 metered session\(s\)/);
    assert.doesNotMatch(receipt.stdout, /no metered sessions/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("init progress goes to stderr and --json stdout stays one parseable document", () => {
  const home = mkdtempSync(join(tmpdir(), "wb-init-json-"));
  try {
    let stderr = "";
    let stdout = "";
    try {
      stdout = execFileSync(
        process.execPath,
        [join(ROOT, "src", "cli", "main.ts"), "init", "--claude-settings", "/nonexistent", "--projects-dir", PROJECTS, "--json"],
        { encoding: "utf8", env: { ...process.env, WAYBILL_HOME: home } },
      );
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      stdout = e.stdout ?? "";
      stderr = e.stderr ?? "";
    }
    const parsed = JSON.parse(stdout) as { mined: { metered: number } | null };
    assert.equal(parsed.mined?.metered, 3);
    void stderr; // progress lines, if any, must not be on stdout
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("init with no transcripts is exactly as quiet as before", () => {
  const home = mkdtempSync(join(tmpdir(), "wb-init-empty-"));
  try {
    const r = cli(home, ["init", "--claude-settings", "/nonexistent", "--projects-dir", "/nonexistent-projects"]);
    assert.equal(r.code, 0);
    assert.doesNotMatch(r.stdout, /metered transcripts/);
    assert.doesNotMatch(r.stdout, /Metering/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
