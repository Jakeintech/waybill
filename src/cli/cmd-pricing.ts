import { loadConfig, saveConfig } from "../core/config.ts";

/**
 * Pricing onboarding without hand-editing config.json. No prices ship with
 * the plugin — an accounting tool must not guess rates (D6); the user
 * enters the list prices they can cite, and every cost gets labeled with
 * the pricing version they set.
 */
export function runPricing(home: string, args: string[], json: boolean): number {
  const [verb, ...rest] = args;
  const config = loadConfig(home);

  if (verb === "show" || verb === undefined) {
    if (json) process.stdout.write(JSON.stringify({ data: config.pricing }, null, 2) + "\n");
    else if (config.pricing.version === null || Object.keys(config.pricing.models).length === 0) {
      process.stdout.write(
        "No pricing configured — tokens stay the native unit (by design).\n" +
          "To label USD list-price equivalents:\n" +
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
      process.stdout.write("Re-meter to price existing events: waybill meter --all\n");
    }
    return 0;
  }

  if (verb !== "set") {
    process.stderr.write("waybill pricing: pass `show` or `set <model-id> [rates]`\n");
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
