// Regression tests for the tested-user-feedback batch (v1.1.0).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isPlausibleTrackerKey, filterTrackerKeys } from "../../src/core/keys.ts";
import { parseTranscript } from "../../src/meter/transcript.ts";
import { meterTranscript } from "../../src/meter/meter.ts";
import { defaultConfig, saveConfig } from "../../src/core/config.ts";
import { appendEvents } from "../../src/core/streams.ts";
import { makeOpened, makeUsage } from "../helpers/fixtures.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const OPTS = { branchKeyPattern: "[A-Z][A-Z0-9]+-[0-9]+" };

function cli(home: string, args: string[]): { stdout: string; code: number } {
  try {
    const stdout = execFileSync(process.execPath, [join(ROOT, "src", "cli", "main.ts"), ...args], {
      encoding: "utf8",
      env: { ...process.env, WAYBILL_HOME: home },
    });
    return { stdout, code: 0 };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { stdout: (e.stdout ?? "") + (e.stderr ?? ""), code: e.status ?? 1 };
  }
}

test("keys: technical tokens are never tracker keys; project_keys is authoritative", () => {
  for (const bogus of ["SHA-256", "UTF-8", "ISO-8601", "HTTP-404", "BASE-64", "RFC-2119", "TLS-13"]) {
    assert.equal(isPlausibleTrackerKey(bogus, []), false, `${bogus} must be rejected`);
  }
  assert.equal(isPlausibleTrackerKey("PLAT-482", []), true);
  // With project_keys configured, only those prefixes pass — even novel ones.
  assert.equal(isPlausibleTrackerKey("PLAT-482", ["PLAT"]), true);
  assert.equal(isPlausibleTrackerKey("DATA-77", ["PLAT"]), false);
  assert.deepEqual(filterTrackerKeys(["SHA-256", "PLAT-1", "DATA-2"], []), ["PLAT-1", "DATA-2"]);
});

test("keys: a commit message mentioning SHA-256 mints no story (the real incident)", () => {
  const line = (uuid: string, msg: object): string => JSON.stringify(msg);
  const raw = [
    line("u1", {
      parentUuid: null, isSidechain: false, promptId: "p1", type: "user",
      message: { role: "user", content: "commit the escrow work" },
      uuid: "u-1", timestamp: "2026-08-16T10:00:00Z", cwd: "/tmp/x",
      sessionId: "77777777-aaaa-4bbb-8ccc-000000000007", version: "2.1.229", gitBranch: "main",
    }),
    line("a1", {
      parentUuid: "u-1", isSidechain: false, type: "assistant",
      message: {
        id: "msg_sha_1", model: "claude-opus-4-6", role: "assistant", type: "message",
        content: [{ type: "tool_use", id: "tu_sha", name: "Bash", input: { command: "git commit -m 'seal estimates with SHA-256 escrow'" } }],
        usage: { input_tokens: 10, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
      uuid: "a-1", timestamp: "2026-08-16T10:00:30Z", cwd: "/tmp/x",
      sessionId: "77777777-aaaa-4bbb-8ccc-000000000007", version: "2.1.229", gitBranch: "main",
    }),
    line("u2", {
      parentUuid: "a-1", isSidechain: false, promptId: "p2", type: "user",
      message: { role: "user", content: "now the next thing" },
      uuid: "u-2", timestamp: "2026-08-16T10:05:00Z", cwd: "/tmp/x",
      sessionId: "77777777-aaaa-4bbb-8ccc-000000000007", version: "2.1.229", gitBranch: "main",
    }),
    line("a2", {
      parentUuid: "u-2", isSidechain: false, type: "assistant",
      message: {
        id: "msg_sha_2", model: "claude-opus-4-6", role: "assistant", type: "message",
        content: [{ type: "text", text: "done" }],
        usage: { input_tokens: 5, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
      uuid: "a-2", timestamp: "2026-08-16T10:05:30Z", cwd: "/tmp/x",
      sessionId: "77777777-aaaa-4bbb-8ccc-000000000007", version: "2.1.229", gitBranch: "main",
    }),
  ].join("\n");

  const t = parseTranscript(raw, OPTS);
  assert.deepEqual(t.evidence, [], "SHA-256 in a commit message is not evidence");

  const out = meterTranscript({
    transcriptPath: "/tmp/sha.jsonl", raw, repo: null, config: defaultConfig(),
    ledgerEvents: [], existingUsage: [], existingSessions: [], existingExceptions: [],
  });
  assert.ok(
    out.newUsage.every((u) => u.attribution.account !== "story:SHA-256"),
    "no phantom story:SHA-256 account",
  );
});

test("status: one screen of health, human and machine readable", () => {
  const home = mkdtempSync(join(tmpdir(), "wb-status-"));
  const settings = join(home, "fake-settings.json");
  try {
    cli(home, ["meter", "--transcript", join(ROOT, "tests", "fixtures", "transcripts", "v2.1", "basic.jsonl"), "--repo", "acme/platform"]);
    const r = cli(home, ["status", "--claude-settings", settings]);
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /waybill status/);
    assert.match(r.stdout, /metering: 1 session\(s\) metered/);
    assert.match(r.stdout, /spend: 5,993 tokens/);
    assert.match(r.stdout, /verify: all checks pass/);
    const j = JSON.parse(cli(home, ["status", "--json", "--claude-settings", settings]).stdout) as {
      data: { verify: { ok: boolean }; spend: { total_tokens: number } };
    };
    assert.equal(j.data.verify.ok, true);
    assert.equal(j.data.spend.total_tokens, 5993);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("export: spend ledger as csv and json, redacted on request", () => {
  const home = mkdtempSync(join(tmpdir(), "wb-export-"));
  try {
    appendEvents(home, "ledger", [makeOpened()]);
    appendEvents(home, "usage", [makeUsage({})]);
    const csv = cli(home, ["export", "--format", "csv"]).stdout;
    const lines = csv.trim().split("\n");
    assert.match(lines[0]!, /^account,tokens,input,output/);
    assert.match(lines[1]!, /^story:PLAT-482,6500,1000,200/);
    const ext = cli(home, ["export", "--format", "json", "--audience", "external"]).stdout;
    assert.ok(!ext.includes("PLAT-482"), "external export must pseudonymize keys");
    assert.match(ext, /STORY-1/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("pricing: set requires all five rates + a version; show guides when empty", () => {
  const home = mkdtempSync(join(tmpdir(), "wb-pricing-"));
  try {
    assert.match(cli(home, ["pricing", "show"]).stdout, /No pricing configured/);
    const missing = cli(home, ["pricing", "set", "claude-opus-4-6", "--input", "15"]);
    assert.equal(missing.code, 2);
    assert.match(missing.stdout, /all five rates are required/);
    const ok = cli(home, [
      "pricing", "set", "claude-opus-4-6", "--version", "2026-08-01",
      "--input", "15", "--output", "75", "--cache-read", "1.5",
      "--cache-5m", "18.75", "--cache-1h", "30",
    ]);
    assert.equal(ok.code, 0, ok.stdout);
    const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as {
      pricing: { version: string; models: Record<string, { input_per_mtok: number }> };
    };
    assert.equal(config.pricing.version, "2026-08-01");
    assert.equal(config.pricing.models["claude-opus-4-6"]!.input_per_mtok, 15);
    assert.match(cli(home, ["pricing", "show"]).stdout, /claude-opus-4-6: in 15/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("bootstrap: --from/--to align the receipt window with query windows", () => {
  const home = mkdtempSync(join(tmpdir(), "wb-bwin-"));
  try {
    saveConfig(home, defaultConfig());
    appendEvents(home, "usage", [makeUsage({ ts: "2026-08-11T10:00:00Z" })]);
    const r = cli(home, ["bootstrap", "--from", "2026-08-01", "--to", "2026-08-16", "--repo-path", "/nonexistent"]);
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /WINDOW    2026-08-01 → 2026-08-16 \(15 days\)/);
    assert.match(r.stdout, /1 metered session\(s\)/); // the in-window usage shows up
    const bad = cli(home, ["bootstrap", "--from", "whenever"]);
    assert.equal(bad.code, 2);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
