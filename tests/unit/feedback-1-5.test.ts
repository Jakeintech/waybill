// The 1.5.0 tested-feedback batch — one regression test per shipped fix:
// rate auto-configuration honesty (empty-table import on re-init, custom
// rates never clobbered, unpriced models named by status/pricing show) and
// the meter_version checkpoint invalidation that re-prices old events.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { appendEvents } from "../../src/core/streams.ts";
import { isCurrent, loadState, saveState, type MeterState } from "../../src/meter/state.ts";
import { METER_LOGIC_VERSION } from "../../src/meter/meter.ts";
import { RULES_VERSION } from "../../src/attribution/resolver.ts";
import { makeSessionReceipt, makeUsage, tempHome } from "../helpers/fixtures.ts";

const ROOT = join(import.meta.dirname, "..", "..");

function cli(home: string, args: string[], expectFail = false): { stdout: string; code: number } {
  try {
    const stdout = execFileSync(process.execPath, [join(ROOT, "src", "cli", "main.ts"), ...args], {
      encoding: "utf8",
      env: { ...process.env, WAYBILL_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { stdout, code: 0 };
  } catch (err) {
    const e = err as { status?: number; stdout?: string };
    if (!expectFail) throw err;
    return { stdout: e.stdout ?? "", code: e.status ?? -1 };
  }
}

test("init on an existing rate-less ledger imports bundled pricing (upgrader path)", () => {
  const home = tempHome();
  try {
    writeFileSync(join(home, "config.json"), JSON.stringify({ schema_version: 2 }) + "\n");
    const { stdout } = cli(home, ["init", "--projects-dir", "/nonexistent-projects", "--claude-settings", "/nonexistent", "--json"]);
    const out = JSON.parse(stdout) as {
      fresh: boolean;
      pricing: { imported: string[]; version: string | null };
      needs_action: string[];
    };
    assert.equal(out.fresh, false);
    assert.ok(out.pricing.imported.length > 0, "re-init on an empty rate table must import");
    assert.ok(!out.needs_action.some((l) => l.includes("no pricing configured")));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("init never clobbers a hand-set rate; the rest of the bundle is not merged in", () => {
  const home = tempHome();
  try {
    cli(home, ["init", "--projects-dir", "/nonexistent-projects", "--claude-settings", "/nonexistent"]);
    cli(home, [
      "pricing", "set", "my-model", "--version", "2026-01-01",
      "--input", "7", "--output", "70", "--cache-read", "0.7", "--cache-5m", "8.75", "--cache-1h", "14",
    ]);
    // Wipe the bundled imports, keep only the custom rate — the upgrader
    // whose only rate is hand-entered.
    const configPath = join(home, "config.json");
    const config = JSON.parse(execFileSync("cat", [configPath], { encoding: "utf8" })) as {
      pricing: { version: string; models: Record<string, unknown> };
    };
    config.pricing.models = { "my-model": config.pricing.models["my-model"] };
    config.pricing.version = "2026-01-01";
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

    const { stdout } = cli(home, ["init", "--projects-dir", "/nonexistent-projects", "--claude-settings", "/nonexistent", "--json"]);
    const out = JSON.parse(stdout) as { pricing: { imported: string[] } };
    assert.deepEqual(out.pricing.imported, [], "a table holding any rate is never touched");
    const after = JSON.parse(execFileSync("cat", [configPath], { encoding: "utf8" })) as {
      pricing: { version: string; models: Record<string, { input_per_mtok: number }> };
    };
    assert.equal(after.pricing.version, "2026-01-01");
    assert.equal(after.pricing.models["my-model"]!.input_per_mtok, 7);
    assert.equal(Object.keys(after.pricing.models).length, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("fresh init reports missing pricing under needs_action only when the bundle import fails to price anything", () => {
  const home = tempHome();
  try {
    const { stdout } = cli(home, ["init", "--projects-dir", "/nonexistent-projects", "--claude-settings", "/nonexistent", "--json"]);
    const out = JSON.parse(stdout) as { needs_action: string[]; pricing: { imported: string[] } };
    // Bundle present → imported → no pricing line in needs_action.
    assert.ok(out.pricing.imported.length > 0);
    assert.ok(!out.needs_action.some((l) => l.includes("no pricing configured")));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("status names metered models with no resolvable rate, with the exact fix", () => {
  const home = tempHome();
  try {
    cli(home, ["init", "--projects-dir", "/nonexistent-projects", "--claude-settings", "/nonexistent"]);
    const priced = makeUsage({ ts: "2026-08-20T10:00:00Z", turnIndex: 1, model: "claude-opus-4-6" });
    const mystery = makeUsage({ ts: "2026-08-20T11:00:00Z", turnIndex: 2, model: "mystery-model-9" });
    appendEvents(home, "usage", [priced, mystery]);
    appendEvents(home, "sessions", [makeSessionReceipt([priced, mystery])]);

    const { stdout } = cli(home, ["status", "--claude-settings", "/nonexistent", "--json"], true);
    const out = JSON.parse(stdout) as {
      data: { pricing: { unpriced_models: string[]; repriceable_events: number } };
    };
    assert.deepEqual(out.data.pricing.unpriced_models, ["mystery-model-9"]);
    // claude-opus-4-6 resolves now but its fixture event carries no cost —
    // the re-priceable count points at `meter --all`.
    assert.equal(out.data.pricing.repriceable_events, 1);

    const text = cli(home, ["status", "--claude-settings", "/nonexistent"], true).stdout;
    assert.match(text, /NO RATE for metered model\(s\): mystery-model-9/);
    assert.match(text, /waybill pricing set/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("pricing show surfaces metered-but-unpriced models (text and --json)", () => {
  const home = tempHome();
  try {
    cli(home, ["init", "--projects-dir", "/nonexistent-projects", "--claude-settings", "/nonexistent"]);
    appendEvents(home, "usage", [
      makeUsage({ ts: "2026-08-20T10:00:00Z", turnIndex: 1, model: "mystery-model-9" }),
    ]);
    const text = cli(home, ["pricing", "show"]).stdout;
    assert.match(text, /Metered but UNPRICED.*mystery-model-9/);
    const json = JSON.parse(cli(home, ["pricing", "show", "--json"]).stdout) as {
      data: { unpriced_models: string[] };
    };
    assert.deepEqual(json.data.unpriced_models, ["mystery-model-9"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("meter_version + pricing_digest: pre-1.5 checkpoints are stale, current ones are not, torn state loads empty", () => {
  const home = tempHome();
  try {
    // A legacy checkpoint (no meter_version/pricing_digest) loads as stale.
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "meter_state.json"),
      JSON.stringify({
        schema_version: 2,
        sessions: {
          "sess-1": {
            transcript_path: "/t.jsonl",
            file_bytes: 100,
            last_message_id: null,
            transcript_version: "2.1.229",
            metered_through_ts: "2026-08-20T10:00:00Z",
            rules_version: RULES_VERSION,
            pricing_version: "2026-08-17",
            attribution_inputs: "fp",
          },
        },
      }),
    );
    const legacy = loadState(home);
    assert.equal(isCurrent(legacy, "sess-1", 100, "digest-a", "fp"), false);

    // A checkpoint written by this engine is current — until the pricing
    // table's content digest changes, version string or not.
    const state: MeterState = {
      schema_version: 2,
      sessions: {
        "sess-1": {
          transcript_path: "/t.jsonl",
          file_bytes: 100,
          last_message_id: null,
          transcript_version: "2.1.229",
          metered_through_ts: "2026-08-20T10:00:00Z",
          rules_version: RULES_VERSION,
          meter_version: METER_LOGIC_VERSION,
          pricing_digest: "digest-a",
          pricing_version: "2026-08-17",
          attribution_inputs: "fp",
        },
      },
    };
    saveState(home, state);
    assert.equal(isCurrent(loadState(home), "sess-1", 100, "digest-a", "fp"), true);
    assert.equal(isCurrent(loadState(home), "sess-1", 100, "digest-b", "fp"), false);
    // Session ids come from untrusted transcripts: prototype names miss.
    assert.equal(isCurrent(loadState(home), "constructor", 100, "digest-a", "fp"), false);

    // A torn state file is a cache, not a wall: loadState returns empty.
    writeFileSync(join(home, "meter_state.json"), '{"schema_version": 2, "sessions": {');
    assert.deepEqual(loadState(home), { schema_version: 2, sessions: {} });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("spendData: pricing_coverage reports priced share and unpriced models", async () => {
  const { spendData } = await import("../../src/projections/queries.ts");
  const { defaultConfig } = await import("../../src/core/config.ts");
  const config = defaultConfig();
  config.pricing.version = "2026-08-17";
  const usage = [
    makeUsage({ ts: "2026-08-20T10:00:00Z", turnIndex: 1, cost: { value: 1, pricing_version: "2026-08-17" }, tokens: { input: 750, output: 0, cache_read: 0, cache_creation: 0 } }),
    makeUsage({ ts: "2026-08-20T11:00:00Z", turnIndex: 2, model: "mystery-model-9", tokens: { input: 250, output: 0, cache_read: 0, cache_creation: 0 } }),
  ];
  const spend = spendData(usage, [], [], config, { from: null, to: null });
  assert.equal(spend.pricing_coverage.priced_tokens, 750);
  assert.equal(spend.pricing_coverage.unpriced_tokens, 250);
  assert.equal(spend.pricing_coverage.priced_pct, 75);
  assert.deepEqual(spend.pricing_coverage.unpriced_event_models, ["mystery-model-9"]);
  // Per-model coverage: a partially priced model says how much it misses.
  const mystery = spend.by_model.find((m) => m.model === "mystery-model-9")!;
  assert.equal(mystery.cost_usd, null);
  assert.equal(mystery.unpriced_tokens, 250);
});
