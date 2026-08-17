import { defaultConfig, type Config } from "../../src/core/config.ts";
import type { MeterInput } from "../../src/meter/meter.ts";

/** The fixed config used for meter golden outputs: opus priced, others not. */
export function goldenMeterConfig(): Config {
  const config = defaultConfig();
  config.pricing = {
    version: "2026-08-01",
    unknown_model_policy: "tokens_only",
    models: {
      "claude-opus-4-6": {
        input_per_mtok: 15,
        output_per_mtok: 75,
        cache_read_per_mtok: 1.5,
        cache_write_5m_per_mtok: 18.75,
        cache_write_1h_per_mtok: 30,
      },
    },
  };
  return config;
}

export function goldenMeterInput(name: string, raw: string, config: Config): MeterInput {
  return {
    transcriptPath: `/fixtures/${name}.jsonl`,
    raw,
    repo: name.startsWith("v1/") ? null : "acme/platform",
    config,
    ledgerEvents: [],
    existingUsage: [],
    existingSessions: [],
    existingExceptions: [],
  };
}
