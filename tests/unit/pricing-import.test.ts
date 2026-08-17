// Regression tests for bundled Anthropic pricing (D6 reversed) and the
// enhanced `waybill init` that auto-imports it on a fresh install.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadPricingBundle, resolveBundledModel } from "../../src/core/pricing-bundle.ts";
import { applyBundledPricing } from "../../src/cli/cmd-pricing.ts";
import { defaultConfig } from "../../src/core/config.ts";

const ROOT = join(import.meta.dirname, "..", "..");

function cli(
  home: string,
  args: string[],
  env: Record<string, string | undefined> = {},
): { stdout: string; code: number } {
  try {
    const stdout = execFileSync(process.execPath, [join(ROOT, "src", "cli", "main.ts"), ...args], {
      encoding: "utf8",
      env: { ...process.env, WAYBILL_HOME: home, GITHUB_MCP_PAT: "", ...env },
    });
    return { stdout, code: 0 };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { stdout: (e.stdout ?? "") + (e.stderr ?? ""), code: e.status ?? 1 };
  }
}

test("pricing bundle: exact ids and family aliases resolve; unknowns don't", () => {
  const bundle = loadPricingBundle();
  assert.ok(Object.keys(bundle.models).length >= 10);
  assert.equal(resolveBundledModel(bundle, "claude-sonnet-5"), "claude-sonnet-5");
  assert.equal(resolveBundledModel(bundle, "claude-sonnet-4"), "claude-sonnet-4-6");
  assert.equal(resolveBundledModel(bundle, "claude-opus-4"), "claude-opus-4-8");
  assert.equal(resolveBundledModel(bundle, "claude-haiku-4-5"), "claude-haiku-4-5-20251001");
  assert.equal(resolveBundledModel(bundle, "nonexistent-model"), null);
});

test("applyBundledPricing: merges rates, sets version, idempotent, preserves unrelated custom models", () => {
  const config = defaultConfig();
  config.pricing.models["my-custom-model"] = {
    input_per_mtok: 1,
    output_per_mtok: 2,
    cache_read_per_mtok: 0.1,
    cache_write_5m_per_mtok: 0.2,
    cache_write_1h_per_mtok: 0.3,
  };
  const result = applyBundledPricing(config);
  assert.ok(result.imported.includes("claude-sonnet-5"));
  assert.equal(result.unknown.length, 0);
  assert.equal(config.pricing.version, result.version);
  assert.ok(config.pricing.models["my-custom-model"], "unrelated custom model must survive");

  const before = JSON.stringify(config.pricing);
  applyBundledPricing(config); // re-running with the same bundle is a no-op
  assert.equal(JSON.stringify(config.pricing), before);
});

test("applyBundledPricing: --model resolves aliases; unknown requests are reported, not fatal", () => {
  const config = defaultConfig();
  const result = applyBundledPricing(config, ["claude-sonnet-4", "totally-bogus"]);
  assert.deepEqual(result.imported, ["claude-sonnet-4-6"]);
  assert.deepEqual(result.unknown, ["totally-bogus"]);
});

test("waybill pricing import: CLI end-to-end, model filter with alias, unknown model fails", () => {
  const home = mkdtempSync(join(tmpdir(), "wb-pimport-"));
  try {
    const r1 = cli(home, ["pricing", "import"]);
    assert.equal(r1.code, 0, r1.stdout);
    assert.match(r1.stdout, /imported \d+ bundled model\(s\)/);
    assert.match(cli(home, ["pricing", "show"]).stdout, /claude-sonnet-5:/);

    const r2 = cli(home, ["pricing", "import", "--model", "claude-sonnet-4"]);
    assert.equal(r2.code, 0, r2.stdout);
    assert.match(r2.stdout, /claude-sonnet-4-6/);

    const bad = cli(home, ["pricing", "import", "--model", "not-a-model"]);
    assert.equal(bad.code, 2, bad.stdout);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("waybill init: fresh install auto-imports bundled pricing; refresh never overwrites a manual override", () => {
  const home = mkdtempSync(join(tmpdir(), "wb-init-pricing-"));
  const settingsDir = mkdtempSync(join(tmpdir(), "wb-init-settings-"));
  try {
    const init1 = cli(home, ["init", "--claude-settings", join(settingsDir, "missing.json")]);
    assert.equal(init1.code, 0, init1.stdout);
    assert.match(init1.stdout, /Pricing: imported \d+ bundled Anthropic model/);
    let config = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as {
      pricing: { version: string; models: Record<string, { input_per_mtok: number }> };
    };
    assert.ok(config.pricing.models["claude-sonnet-5"]);
    assert.ok(config.pricing.version);

    cli(home, [
      "pricing", "set", "claude-sonnet-5", "--version", "2099-01-01",
      "--input", "999", "--output", "999", "--cache-read", "999",
      "--cache-5m", "999", "--cache-1h", "999",
    ]);

    // Re-init (a refresh, not a fresh install) must never touch pricing.
    const init2 = cli(home, ["init", "--claude-settings", join(settingsDir, "missing.json")]);
    assert.equal(init2.code, 0, init2.stdout);
    assert.doesNotMatch(init2.stdout, /Pricing: imported/);
    config = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as {
      pricing: { version: string; models: Record<string, { input_per_mtok: number }> };
    };
    assert.equal(
      config.pricing.models["claude-sonnet-5"]!.input_per_mtok,
      999,
      "refresh must not clobber a manual override",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(settingsDir, { recursive: true, force: true });
  }
});

test("waybill init: GITHUB_MCP_PAT guidance appears only when unset; summary lists configured vs needs-action", () => {
  const home1 = mkdtempSync(join(tmpdir(), "wb-init-pat-unset-"));
  const home2 = mkdtempSync(join(tmpdir(), "wb-init-pat-set-"));
  try {
    const unset = cli(home1, ["init"], { GITHUB_MCP_PAT: "" });
    assert.match(
      unset.stdout,
      /Export GITHUB_MCP_PAT in your shell profile\. Create at https:\/\/github\.com\/settings\/tokens with repo scope\./,
    );
    assert.match(unset.stdout, /Needs action:/);

    const set = cli(home2, ["init"], { GITHUB_MCP_PAT: "ghp_test_token" });
    assert.doesNotMatch(set.stdout, /Export GITHUB_MCP_PAT/);
    assert.match(set.stdout, /GitHub MCP \(GITHUB_MCP_PAT set\)/);
    assert.match(set.stdout, /Configured:/);

    const json = JSON.parse(cli(home2, ["init", "--json"], { GITHUB_MCP_PAT: "ghp_test_token" }).stdout) as {
      github_mcp_pat_set: boolean;
      configured: string[];
      needs_action: string[];
    };
    assert.equal(json.github_mcp_pat_set, true);
    assert.ok(json.configured.length > 0);
  } finally {
    rmSync(home1, { recursive: true, force: true });
    rmSync(home2, { recursive: true, force: true });
  }
});
