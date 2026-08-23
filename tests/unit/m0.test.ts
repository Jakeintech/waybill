import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkRetention } from "../../src/cli/cmd-init.ts";
import { parseGitLog, summarizeRepo } from "../../src/gitlocal/gitlocal.ts";
import { renderReceipt, type BootstrapData } from "../../src/cli/cmd-bootstrap.ts";
import { readEvents } from "../../src/core/streams.ts";
import type { LedgerEntry, UsageEvent } from "../../src/core/events.ts";
import { checkEscrow } from "../../src/core/escrow.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const FIXTURES = join(ROOT, "tests", "fixtures", "transcripts");

function cli(home: string, args: string[], opts: { cwd?: string } = {}): { stdout: string; code: number } {
  try {
    const stdout = execFileSync(process.execPath, [join(ROOT, "src", "cli", "main.ts"), ...args], {
      encoding: "utf8",
      env: { ...process.env, WAYBILL_HOME: home },
      cwd: opts.cwd ?? ROOT,
    });
    return { stdout, code: 0 };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { stdout: (e.stdout ?? "") + (e.stderr ?? ""), code: e.status ?? 1 };
  }
}

test("retention check (D7): zero warns, absent recommends, high passes", () => {
  const dir = mkdtempSync(join(tmpdir(), "wb-ret-"));
  try {
    const p = join(dir, "settings.json");
    writeFileSync(p, JSON.stringify({ cleanupPeriodDays: 0 }), "utf8");
    const zero = checkRetention(p);
    assert.equal(zero.cleanup_period_days, 0);
    assert.match(zero.warning ?? "", /deletes transcripts/);

    const absent = checkRetention(join(dir, "missing.json"));
    assert.equal(absent.cleanup_period_days, null);
    assert.match(absent.recommendation ?? "", /raise cleanupPeriodDays/);

    writeFileSync(p, JSON.stringify({ cleanupPeriodDays: 365 }), "utf8");
    const high = checkRetention(p);
    assert.equal(high.warning, null);
    assert.equal(high.recommendation, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("git-local adapter: parse + summarize scoped to identity emails", () => {
  const F = "";
  const R = "";
  const raw = [
    `aaa111${F}me@example.com${F}2026-08-01T10:00:00+00:00${F}p1${F}HEAD -> main, tag: v1.2.0${F}PLAT-482: retry logic`,
    `bbb222${F}me@example.com${F}2026-08-02T11:00:00+00:00${F}p1 p2${F}${F}Merge branch 'feat/PLAT-482-retry'`,
    `ccc333${F}someone.else@example.com${F}2026-08-03T09:00:00+00:00${F}p1${F}${F}DATA-77: not mine`,
    `ddd444${F}me@example.com${F}2026-08-03T12:00:00+00:00${F}p1${F}${F}PLAT-482: tests`,
  ].join(R + "\n") + R;
  const commits = parseGitLog(raw);
  assert.equal(commits.length, 4);
  const s = summarizeRepo("acme/platform", "/tmp/x", commits, ["ME@example.com"], "[A-Z][A-Z0-9]+-[0-9]+");
  assert.equal(s.commits, 3); // the colleague's commit is excluded — own data only
  assert.equal(s.merges, 1);
  assert.equal(s.active_days, 3);
  assert.deepEqual(s.keys, [{ key: "PLAT-482", count: 3 }]);
  assert.deepEqual(s.tags, ["v1.2.0"]);
  assert.equal(s.first_date, "2026-08-01");
  assert.equal(s.last_date, "2026-08-03");
});

test("bootstrap receipt renders the fixed snapshot", () => {
  const data: BootstrapData = {
    window_days: 90,
    since: "2026-05-18",
    until: "2026-08-16",
    emails: ["me@example.com"],
    repos: [
      {
        repo: "acme/platform", path: "/tmp/x", commits: 42, merges: 7, active_days: 19,
        first_date: "2026-05-20", last_date: "2026-08-15",
        keys: [{ key: "PLAT-482", count: 12 }, { key: "DATA-77", count: 3 }],
        tags: ["v2026.08.12"],
      },
    ],
    tokens: {
      metered_sessions: 3,
      totals: { input: 52_000, output: 9_100, cache_read: 480_000, cache_creation: 31_000 },
      by_account: [
        { account: "story:PLAT-482", tokens: 400_000 },
        { account: "unattributed", tokens: 172_100 },
      ],
    },
  };
  const receipt = renderReceipt(data);
  assert.match(receipt, /WAYBILL · BOOTSTRAP RECEIPT/);
  assert.match(receipt, /COMMITS\s+42/);
  assert.match(receipt, /PLAT-482 ×12 · DATA-77 ×3/);
  assert.match(receipt, /story:PLAT-482\s+400,000/);
  assert.match(receipt, /unattributed\s+172,100/); // never hidden
  assert.match(receipt, /EVIDENCE TIER: FACTS/);
});

test("e2e M0: init → capture queue → mine → verify (zero auth, zero config)", () => {
  const home = mkdtempSync(join(tmpdir(), "wb-m0-"));
  const settingsDir = mkdtempSync(join(tmpdir(), "wb-m0-settings-"));
  try {
    writeFileSync(join(settingsDir, "settings.json"), JSON.stringify({ cleanupPeriodDays: 0 }), "utf8");
    const init = cli(home, ["init", "--projects-dir", "/nonexistent-projects", "--claude-settings", join(settingsDir, "settings.json")]);
    assert.equal(init.code, 0);
    assert.match(init.stdout, /Initialized/);
    assert.match(init.stdout, /WARNING: cleanupPeriodDays is 0/);

    // Queue two captures: one real fixture transcript, one pruned.
    const queue = join(home, "pending-sessions");
    mkdirSync(queue, { recursive: true });
    writeFileSync(
      join(queue, "20260805T140700Z-1.json"),
      JSON.stringify({
        session_id: "hook-side-id-ignored",
        transcript_path: join(FIXTURES, "v2.1", "basic.jsonl"),
        cwd: "/home/dev/acme/platform",
        repo: "acme/platform",
        mined: false,
      }) + "\n",
      "utf8",
    );
    writeFileSync(
      join(queue, "20260805T150000Z-2.json"),
      JSON.stringify({
        session_id: "44444444-aaaa-4bbb-8ccc-000000000004",
        transcript_path: join(settingsDir, "gone.jsonl"),
        mined: false,
      }) + "\n",
      "utf8",
    );

    const mine = cli(home, ["mine", "--queue"]);
    assert.equal(mine.code, 0);
    assert.match(mine.stdout, /mined: 1 new · 0 re-metered.*1 gap/);

    const cap1 = JSON.parse(readFileSync(join(queue, "20260805T140700Z-1.json"), "utf8")) as Record<string, unknown>;
    assert.equal(cap1["mined"], true);
    // D9: session identity from the transcript, not the hook payload.
    assert.equal(cap1["mined_session_id"], "11111111-aaaa-4bbb-8ccc-000000000001");
    const cap2 = JSON.parse(readFileSync(join(queue, "20260805T150000Z-2.json"), "utf8")) as Record<string, unknown>;
    assert.equal(cap2["mined"], "gap");

    const usage = readEvents<UsageEvent>(home, "usage");
    assert.equal(usage.length, 2);
    assert.ok(usage.every((u) => u.session_id === "11111111-aaaa-4bbb-8ccc-000000000001"));
    const gaps = readEvents(home, "exceptions").filter((e) => e.kind === "meter_gap");
    assert.equal(gaps.length, 1);

    // Re-mining is a no-op (captures marked, meter current).
    const again = cli(home, ["mine", "--queue"]);
    assert.match(again.stdout, /mined: 0 new · 0 re-metered/);

    const verify = cli(home, ["verify"]);
    assert.equal(verify.code, 0, verify.stdout);
    assert.match(verify.stdout, /All checks passed/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(settingsDir, { recursive: true, force: true });
  }
});

test("mine --all works on a completely fresh home (no init, no queue dir)", () => {
  const home = mkdtempSync(join(tmpdir(), "wb-fresh-"));
  const projects = mkdtempSync(join(tmpdir(), "wb-projects-"));
  try {
    mkdirSync(join(projects, "-home-dev-acme-platform"), { recursive: true });
    for (const f of ["basic.jsonl", "multiturn.jsonl"]) {
      writeFileSync(
        join(projects, "-home-dev-acme-platform", f),
        readFileSync(join(FIXTURES, "v2.1", f), "utf8"),
        "utf8",
      );
    }
    const out = cli(home, ["mine", "--all", "--projects-dir", projects]);
    assert.equal(out.code, 0, out.stdout);
    assert.match(out.stdout, /mined: 2 new/);
    assert.ok(readEvents<UsageEvent>(home, "usage").length > 0);
    const verify = cli(home, ["verify"]);
    assert.match(verify.stdout, /All checks passed/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(projects, { recursive: true, force: true });
  }
});

test("append: seals escrow on pre-registered opens; refuses backdating; dedupes", () => {
  const home = mkdtempSync(join(tmpdir(), "wb-append-"));
  try {
    const body = {
      ts: "2026-08-10T09:12:00Z",
      kind: "opened",
      title: "Retry logic for checkout webhook",
      tracker_key: "PLAT-482",
      epic_key: null, epic_name: null, sprint: null, repo: "acme/platform",
      work_type: "feature", points: 5,
      artifacts: { prs: [], commits: [], deploy: null, docs: [] },
      estimate_without_claude_hours: { low: 10, high: 16, logged_at: "2026-08-10T09:12:00Z", pre_registered: true },
      actual_hours: null, claude_role: "none", sessions: [], tokens: null,
      budget_tokens: null, time_saved_hours: null, notes: null,
    };
    const r1 = cli(home, ["append", "--stream", "ledger", "--event", JSON.stringify(body), "--json"]);
    assert.equal(r1.code, 0);
    const out1 = JSON.parse(r1.stdout) as { id: string; appended: boolean };
    assert.equal(out1.appended, true);

    const entries = readEvents<LedgerEntry>(home, "ledger");
    assert.equal(entries.length, 1);
    assert.equal(checkEscrow(entries[0]!).status, "ok");

    // Same content again: deduped by deterministic id.
    const r2 = cli(home, ["append", "--stream", "ledger", "--event", JSON.stringify(body), "--json"]);
    assert.match(r2.stdout, /"appended":false/);

    // Backdated pre-registration refused at the write path.
    const backdated = {
      ...body,
      title: "Backdated claim",
      estimate_without_claude_hours: { low: 5, high: 8, logged_at: "2026-08-12T00:00:00Z", pre_registered: true },
    };
    const r3 = cli(home, ["append", "--stream", "ledger", "--event", JSON.stringify(backdated)]);
    assert.equal(r3.code, 1);
    assert.match(r3.stdout, /refusing a pre_registered estimate logged after/);

    const verify = cli(home, ["verify"]);
    assert.equal(verify.code, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
