import { loadConfig, saveConfig, type Config } from "../core/config.ts";
import type { UsageEvent } from "../core/events.ts";
import { loadPricingBundle, resolveBundledModel } from "../core/pricing-bundle.ts";
import { unpricedModels } from "../core/pricing-resolve.ts";
import { authoritative, readEvents } from "../core/streams.ts";

/**
 * Pricing onboarding without hand-editing config.json. Bundled Anthropic
 * rates ship as defaults; override with pricing set (D6, reversed from the
 * original "no prices ship" call — see DECISIONS.md). Every cost is still
 * labeled with the pricing version in effect, bundled or hand-entered.
 */
export function runPricing(home: string, args: string[], json: boolean): number {
  const [verb, ...rest] = args;
  const config = loadConfig(home);

  if (verb === "import") {
    return runPricingImport(home, config, rest, json);
  }

  if (verb === "show" || verb === undefined) {
    // Cross-check the table against what actually metered: a configured
    // table that cannot price the models in the ledger is not "configured".
    const seenModels = [
      ...new Set(
        authoritative(readEvents<UsageEvent>(home, "usage"))
          .filter((u) => u.kind === "usage")
          .map((u) => u.model),
      ),
    ];
    const missing = unpricedModels(config.pricing, seenModels);
    if (json) {
      process.stdout.write(
        JSON.stringify({ data: { ...config.pricing, unpriced_models: missing } }, null, 2) + "\n",
      );
    }
    else if (config.pricing.version === null || Object.keys(config.pricing.models).length === 0) {
      process.stdout.write(
        "No pricing configured — tokens stay the native unit (by design).\n" +
          "Fastest path: waybill pricing import  (bundled Anthropic list rates)\n" +
          "To label a different USD basis:\n" +
          "  waybill pricing set <model-id> --version <YYYY-MM-DD> \\\n" +
          "    --input <usd/mtok> --output <usd/mtok> --cache-read <usd/mtok> \\\n" +
          "    --cache-5m <usd/mtok> --cache-1h <usd/mtok>\n" +
          "Rates come from your provider's price list; cite the date as the version.\n",
      );
    } else {
      process.stdout.write(`pricing_version: ${config.pricing.version}\n`);
      for (const [model, r] of Object.entries(config.pricing.models).sort()) {
        process.stdout.write(
          `  ${model}: in ${r.input_per_mtok} · out ${r.output_per_mtok} · ` +
            `cache-read ${r.cache_read_per_mtok} · 5m ${r.cache_write_5m_per_mtok} · ` +
            `1h ${r.cache_write_1h_per_mtok}  (USD/mtok)\n`,
        );
      }
      process.stdout.write(
        "Dated model ids (…-YYYYMMDD) resolve to their family rate automatically.\n",
      );
      if (missing.length > 0) {
        process.stdout.write(
          `Metered but UNPRICED (no resolvable rate): ${missing.join(", ")}\n` +
            "  Fix: waybill pricing set <model-id> ...  (or pricing import), then: waybill meter --all\n",
        );
      }
      process.stdout.write("Re-meter to price existing events: waybill meter --all\n");
    }
    return 0;
  }

  if (verb !== "set") {
    process.stderr.write("waybill pricing: pass `show`, `import`, or `set <model-id> [rates]`\n");
    return 2;
  }
  const model = rest[0];
  if (!model || model.startsWith("--")) {
    process.stderr.write("waybill pricing set: pass the model id first\n");
    return 2;
  }
  const rates: Record<string, number> = {};
  let version: string | null = null;
  const FLAGS: Record<string, string> = {
    "--input": "input_per_mtok",
    "--output": "output_per_mtok",
    "--cache-read": "cache_read_per_mtok",
    "--cache-5m": "cache_write_5m_per_mtok",
    "--cache-1h": "cache_write_1h_per_mtok",
  };
  for (let i = 1; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--version") {
      version = rest[++i] ?? null;
      continue;
    }
    const field = FLAGS[a];
    if (!field) {
      process.stderr.write(`waybill pricing set: unknown option ${a}\n`);
      return 2;
    }
    const v = Number(rest[++i]);
    if (!Number.isFinite(v) || v < 0) {
      process.stderr.write(`waybill pricing set: ${a} needs a non-negative number (USD per million tokens)\n`);
      return 2;
    }
    rates[field] = v;
  }
  for (const field of Object.values(FLAGS)) {
    if (!(field in rates)) {
      process.stderr.write(
        "waybill pricing set: all five rates are required (--input --output --cache-read --cache-5m --cache-1h) — no rate is ever guessed\n",
      );
      return 2;
    }
  }
  const effectiveVersion = version ?? config.pricing.version;
  if (!effectiveVersion) {
    process.stderr.write(
      "waybill pricing set: pass --version <YYYY-MM-DD> (the price-list date — it labels every derived USD figure)\n",
    );
    return 2;
  }

  config.pricing.version = effectiveVersion;
  config.pricing.models[model] = {
    input_per_mtok: rates["input_per_mtok"]!,
    output_per_mtok: rates["output_per_mtok"]!,
    cache_read_per_mtok: rates["cache_read_per_mtok"]!,
    cache_write_5m_per_mtok: rates["cache_write_5m_per_mtok"]!,
    cache_write_1h_per_mtok: rates["cache_write_1h_per_mtok"]!,
  };
  saveConfig(home, config);
  if (json) {
    process.stdout.write(JSON.stringify({ data: config.pricing }, null, 2) + "\n");
  } else {
    process.stdout.write(
      `priced ${model} (version ${effectiveVersion}). Existing events re-price on the next ` +
        `meter run: waybill meter --all\n`,
    );
  }
  return 0;
}

export interface PricingImportResult {
  imported: string[];
  unknown: string[];
  version: string;
}

/**
 * Merges the bundled Anthropic rates into `config.pricing`, resolving
 * family aliases (e.g. "claude-sonnet-4" → "claude-sonnet-4-6") first.
 * Mutates `config` in place; does not save it — callers control that so
 * `waybill init` can fold the write into its own config save.
 */
export function applyBundledPricing(config: Config, requested?: string[]): PricingImportResult {
  const bundle = loadPricingBundle();
  const targets = requested && requested.length > 0 ? requested : Object.keys(bundle.models);
  const imported: string[] = [];
  const unknown: string[] = [];
  for (const t of targets) {
    const resolved = resolveBundledModel(bundle, t);
    if (!resolved) {
      unknown.push(t);
      continue;
    }
    config.pricing.models[resolved] = bundle.models[resolved]!;
    imported.push(resolved);
  }
  if (imported.length > 0) config.pricing.version = bundle.last_updated;
  return { imported, unknown, version: bundle.last_updated };
}

function runPricingImport(home: string, config: Config, rest: string[], json: boolean): number {
  const requested: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--model") {
      const m = rest[++i];
      if (!m) {
        process.stderr.write("waybill pricing import: --model needs a value\n");
        return 2;
      }
      requested.push(m);
    } else {
      process.stderr.write(`waybill pricing import: unknown option ${a}\n`);
      return 2;
    }
  }

  const result = applyBundledPricing(config, requested);
  if (result.imported.length === 0) {
    process.stderr.write(
      `waybill pricing import: no matching bundled model(s)${result.unknown.length > 0 ? `: ${result.unknown.join(", ")}` : ""}\n`,
    );
    return 2;
  }
  saveConfig(home, config);

  if (json) {
    process.stdout.write(JSON.stringify({ data: { ...result, pricing: config.pricing } }, null, 2) + "\n");
  } else {
    process.stdout.write(
      `imported ${result.imported.length} bundled model(s) (version ${result.version}): ` +
        `${result.imported.join(", ")}\n`,
    );
    if (result.unknown.length > 0) {
      process.stderr.write(`not in the bundle, skipped: ${result.unknown.join(", ")}\n`);
    }
    process.stdout.write(
      "Override any model's rate with: waybill pricing set <model-id> ...\n" +
        "Re-meter to price existing events: waybill meter --all\n",
    );
  }
  return 0;
}
