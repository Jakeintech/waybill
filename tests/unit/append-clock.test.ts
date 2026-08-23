import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { finalizeEvent, SCHEMA_VERSION, type LedgerEntry } from "../../src/core/events.ts";
import { appendEvents, readEvents } from "../../src/core/streams.ts";
import { sealEstimate } from "../../src/core/escrow.ts";
import { splitFindings, verifyHome } from "../../src/verify/verify.ts";
import { makeOpened, tempHome } from "../helpers/fixtures.ts";

const ROOT = join(import.meta.dirname, "..", "..");

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

function openedBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const { id: _id, ...body } = makeOpened();
  return { ...body, ...overrides };
}

test("append refuses a pre_registered estimate with a future logged_at (clock skew)", () => {
  const home = mkdtempSync(join(tmpdir(), "wb-clock-"));
  try {
    const future = "2026-08-23T13:00:00Z"; // an hour past the injected clock
    const body = openedBody({
      ts: future,
      estimate_without_claude_hours: { low: 10, high: 16, logged_at: future, pre_registered: true },
      escrow: null,
    });
    const r = cli(home, [
      "append", "--stream", "ledger",
      "--event", JSON.stringify(body),
      "--now", "2026-08-23T12:00:00Z",
    ]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /future logged_at/);
    assert.equal(readEvents(home, "ledger").length, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("append stamps appended_at on ledger entries; retries stay idempotent", () => {
  const home = mkdtempSync(join(tmpdir(), "wb-stamp-"));
  try {
    const body = openedBody();
    const r1 = cli(home, [
      "append", "--stream", "ledger", "--event", JSON.stringify(body),
      "--now", "2026-08-10T09:12:30Z", "--json",
    ]);
    assert.equal(r1.code, 0);
    const out1 = JSON.parse(r1.stdout) as { id: string; appended: boolean };
    assert.equal(out1.appended, true);
    const entries = readEvents<LedgerEntry>(home, "ledger");
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.appended_at, "2026-08-10T09:12:30.000Z");
    assert.deepEqual(verifyHome(home), []); // the stamp is id-covered content

    // Same logical content at a later wall clock: duplicate, not a fork.
    const r2 = cli(home, [
      "append", "--stream", "ledger", "--event", JSON.stringify(body),
      "--now", "2026-08-10T10:00:00Z", "--json",
    ]);
    const out2 = JSON.parse(r2.stdout) as { id: string; appended: boolean };
    assert.equal(out2.appended, false);
    assert.equal(out2.id, out1.id); // reports the event already on disk
    assert.equal(readEvents(home, "ledger").length, 1);

    // Caller-supplied appended_at is refused: the write path owns the stamp.
    const forged = cli(home, [
      "append", "--stream", "ledger",
      "--event", JSON.stringify({ ...body, title: "forged witness", appended_at: "2026-01-01T00:00:00Z" }),
    ]);
    assert.equal(forged.code, 2);
    assert.match(forged.stderr, /do not supply appended_at/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("verify warns — never fails — on a pre-registered estimate written long after its logged_at", () => {
  const home = tempHome();
  try {
    const ts = "2026-08-10T09:12:00Z";
    const estimate = { low: 10, high: 16, logged_at: ts, pre_registered: true };
    const body = {
      ...openedBody({ ts, estimate_without_claude_hours: estimate }),
      escrow: sealEstimate("PLAT-482", estimate),
      appended_at: "2026-08-14T09:12:00Z", // four days after the claimed logged_at
    };
    const entry = finalizeEvent("ledger", body as Parameters<typeof finalizeEvent>[1]) as LedgerEntry;
    appendEvents(home, "ledger", [entry]);

    const findings = verifyHome(home);
    const { errors, warnings } = splitFindings(findings);
    assert.equal(errors.length, 0);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]!.check, "pre_registration");
    assert.match(warnings[0]!.message, /predates its write/);

    // The CLI treats warnings as disclosures: exit 0, but printed.
    const r = cli(home, ["verify"]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /1 warning\(s\)/);
    assert.match(r.stdout, /All checks passed/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("backfill-safe: facts entries and pre-2.1 entries (no appended_at) never warn", () => {
  const home = tempHome();
  try {
    // A sync-style backfilled facts entry: old ts, no estimate, no stamp.
    const facts = makeOpened({
      ts: "2026-06-01T00:00:00Z",
      estimate_without_claude_hours: null,
      escrow: null,
    });
    // A pre-2.1 pre-registered entry: estimate present, no appended_at.
    const legacy = makeOpened({ ts: "2026-07-01T00:00:00Z" });
    appendEvents(home, "ledger", [facts, legacy]);
    assert.deepEqual(verifyHome(home), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
