import { loadConfig, type Audience } from "../core/config.ts";
import type { ExceptionEvent, LedgerEntry, PinEntry, UsageEvent } from "../core/events.ts";
import { readEvents } from "../core/streams.ts";
import { normalizeWindow, spendData, type Window } from "../projections/queries.ts";
import { redact } from "../report/redaction.ts";

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/**
 * Share the spend ledger without hand-written jq: one row per account,
 * every number the receipts back, redacted to the chosen audience.
 */
export function runExport(home: string, args: string[]): number {
  let format: "csv" | "json" = "csv";
  let from: string | null = null;
  let to: string | null = null;
  let audience: Audience | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--format") {
      const v = args[++i];
      if (v !== "csv" && v !== "json") {
        process.stderr.write("waybill export: --format must be csv or json\n");
        return 2;
      }
      format = v;
    } else if (a === "--from") from = args[++i] ?? null;
    else if (a === "--to") to = args[++i] ?? null;
    else if (a === "--audience") {
      const v = args[++i];
      if (v !== "self" && v !== "internal" && v !== "external") {
        process.stderr.write("waybill export: --audience must be self, internal, or external\n");
        return 2;
      }
      audience = v;
    } else {
      process.stderr.write(`waybill export: unknown option ${a}\n`);
      return 2;
    }
  }

  const config = loadConfig(home);
  let window: Window;
  try {
    window = normalizeWindow(from, to);
  } catch (err) {
    process.stderr.write(`waybill export: ${(err as Error).message}\n`);
    return 2;
  }
  const spend = spendData(
    readEvents<UsageEvent>(home, "usage"),
    readEvents<ExceptionEvent>(home, "exceptions"),
    readEvents<LedgerEntry | PinEntry>(home, "ledger"),
    config,
    window,
  );
  const aud = audience ?? config.audience_default;
  const { data } = redact(spend, aud);
  const redacted = data as typeof spend;

  if (format === "json") {
    process.stdout.write(JSON.stringify({ audience: aud, data: redacted }, null, 2) + "\n");
    return 0;
  }

  const header = [
    "account", "tokens", "input", "output", "cache_read", "cache_creation",
    "cost_usd", "min_confidence", "resolvers", "sessions",
    "waste_retried_commands", "waste_repeated_reads",
  ];
  const lines = [header.join(",")];
  for (const a of redacted.accounts) {
    lines.push(
      [
        a.account, a.tokens, a.input, a.output, a.cache_read, a.cache_creation,
        a.cost_usd ?? "", a.min_confidence, a.resolvers.join("|"), a.sessions,
        a.waste.retried_commands, a.waste.repeated_reads,
      ]
        .map(csvCell)
        .join(","),
    );
  }
  process.stdout.write(lines.join("\n") + "\n");
  return 0;
}
