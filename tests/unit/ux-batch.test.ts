// The 1.3.0 UX batch — one regression test per shipped issue:
//   #6  metering.enabled is a real pause switch
//   #8  first-run one-shot lines (covered here + acceptance/pace tests)
//   #9  notices.level gates everything said unprompted
//   #10 --detail is validated and echoed for the rendering layer
//   #11 the bin/waybill launcher runs the engine
//   #13 --json is honest on mine and export
//   #15 status ends with a state-derived next-actions menu
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultConfig, loadConfig, saveConfig } from "../../src/core/config.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const FIXTURES = join(ROOT, "tests", "fixtures", "transcripts");

function cli(home: string, args: string[], expectFail = false): { stdout: string; code: number } {
  try {
    const stdout = execFileSync(process.execPath, [join(ROOT, "src", "cli", "main.ts"), ...args], {
      encoding: "utf8",
      env: { ...process.env, WAYBILL_HOME: home },
    });
    return { stdout, code: 0 };
  } catch (err) {
    const e = err as { status?: number; stdout?: string };
    if (!expectFail) throw err;
    return { stdout: e.stdout ?? "", code: e.status ?? 1 };
  }
}

test("pause switch (#6): metering.enabled=false stops mine and meter, status says PAUSED", () => {
  const home = mkdtempSync(join(tmpdir(), "wb-pause-"));
  try {
    const config = defaultConfig();
    config.metering.enabled = false;
    saveConfig(home, config);

    const mine = cli(home, ["mine", "--queue"]);
    assert.match(mine.stdout, /PAUSED \(config\.metering\.enabled = false\)/);

    const meter = cli(home, [
      "meter", "--transcript", join(FIXTURES, "v2.1", "basic.jsonl"), "--repo", "acme/platform",
    ]);
    assert.match(meter.stdout, /PAUSED/);

    // Nothing was recorded while paused.
    const spend = JSON.parse(cli(home, ["query", "spend"]).stdout) as {
      data: { total_tokens: number };
    };
    assert.equal(spend.data.total_tokens, 0);

    const status = cli(home, ["status"], true); // findings-free but exit reflects verify
    assert.match(status.stdout, /metering: PAUSED \(config\.metering\.enabled = false\)/);

    // Flip it back: metering resumes, tokens appear.
    config.metering.enabled = true;
    saveConfig(home, config);
    cli(home, ["meter", "--transcript", join(FIXTURES, "v2.1", "basic.jsonl"), "--repo", "acme/platform"]);
    const after = JSON.parse(cli(home, ["query", "spend"]).stdout) as {
      data: { total_tokens: number };
    };
    assert.ok(after.data.total_tokens > 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("notices.level (#9): off silences everything; minimal keeps thresholds, drops the rest", () => {
  const home = mkdtempSync(join(tmpdir(), "wb-notices-"));
  try {
    // off: not even the first-run line on an initialized, metered, unlogged home
    const config = defaultConfig();
    config.notices.level = "off";
    config.allocations = [{ period: "2026-Q3", tokens_granted: 7000, granted_at: "2026-07-01" }];
    saveConfig(home, config);
    cli(home, ["meter", "--transcript", join(FIXTURES, "v2.1", "basic.jsonl"), "--repo", "acme/platform"]);
    assert.equal(cli(home, ["pace", "--notice", "--now", "2026-08-16T00:00:00Z"]).stdout, "");

    // minimal: the threshold notice still fires, the first-run line never does
    config.notices.level = "minimal";
    saveConfig(home, config);
    const first = cli(home, ["pace", "--notice", "--now", "2026-08-16T01:00:00Z"]).stdout;
    assert.match(first, /% of the 2026-Q3 token grant is spent/);
    assert.equal(cli(home, ["pace", "--notice", "--now", "2026-08-16T02:00:00Z"]).stdout, "");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("--json honesty (#13): mine emits a structured summary; export --json means json", () => {
  const home = mkdtempSync(join(tmpdir(), "wb-json-"));
  try {
    const mine = JSON.parse(cli(home, ["mine", "--queue", "--json"]).stdout) as {
      mined_new: number; remetered: number; gaps: number; already_current: number;
    };
    assert.equal(mine.mined_new, 0);
    assert.equal(mine.already_current, 0);

    const exp = JSON.parse(cli(home, ["export", "--json"]).stdout) as {
      audience: string; data: { accounts: unknown[] };
    };
    assert.ok(Array.isArray(exp.data.accounts));

    // Contradictory flags are an error, not a silent choice.
    const conflict = cli(home, ["export", "--json", "--format", "csv"], true);
    assert.equal(conflict.code, 2);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("status menu (#15): next line is state-derived trigger phrases", () => {
  const home = mkdtempSync(join(tmpdir(), "wb-menu-"));
  try {
    // Uninitialized: the menu is the init phrase.
    const fresh = cli(home, ["status"], true);
    assert.match(fresh.stdout, /next: "initialize my waybill ledger"/);

    // Initialized, metered, nothing logged: sync phrase.
    saveConfig(home, defaultConfig());
    cli(home, ["meter", "--transcript", join(FIXTURES, "v2.1", "basic.jsonl"), "--repo", "acme/platform"]);
    const metered = cli(home, ["status"], true);
    assert.match(metered.stdout, /next: .*"sync my ledger"/);

    const asJson = JSON.parse(cli(home, ["status", "--json"], true).stdout) as {
      data: { next: string[] };
    };
    assert.ok(asJson.data.next.length >= 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("detail (#10): validated, defaulted from config, echoed in the query envelope", () => {
  const home = mkdtempSync(join(tmpdir(), "wb-detail-"));
  try {
    const std = JSON.parse(cli(home, ["query", "spend"]).stdout) as { detail: string };
    assert.equal(std.detail, "standard");

    const terse = JSON.parse(cli(home, ["query", "spend", "--detail", "terse"]).stdout) as {
      detail: string;
    };
    assert.equal(terse.detail, "terse");

    const config = defaultConfig();
    config.detail_default = "full";
    saveConfig(home, config);
    const full = JSON.parse(cli(home, ["query", "spend"]).stdout) as { detail: string };
    assert.equal(full.detail, "full");

    const bad = cli(home, ["query", "spend", "--detail", "verbose"], true);
    assert.equal(bad.code, 2);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("launcher (#11): bin/waybill execs the engine", () => {
  const launcher = join(ROOT, "bin", "waybill");
  chmodSync(launcher, 0o755); // belt and braces: git tracks the bit, CI checkouts vary
  const out = execFileSync(launcher, ["--version"], { encoding: "utf8" });
  assert.match(out, /^waybill /);
});

test("config: notices + detail_default default and merge; sources is gone", () => {
  const home = mkdtempSync(join(tmpdir(), "wb-cfgmerge-"));
  try {
    // An older config shape (pre-1.3.0, still carrying sources) merges clean.
    const config = defaultConfig();
    (config.metering as Record<string, unknown>)["sources"] = ["transcript"];
    saveConfig(home, config);
    const loaded = loadConfig(home);
    assert.equal(loaded.notices.level, "normal");
    assert.equal(loaded.detail_default, "standard");
    assert.equal(loaded.metering.enabled, true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
