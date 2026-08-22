import { join } from "node:path";
import { loadConfig, type Audience } from "../core/config.ts";
import type { ExceptionEvent, LedgerEntry, PinEntry, UsageEvent } from "../core/events.ts";
import { readEvents } from "../core/streams.ts";
import { normalizeWindow, spendData, type Window } from "../projections/queries.ts";
import { redact } from "../report/redaction.ts";
import { buildPack } from "./cmd-pack.ts";

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/**
 * Share the spend ledger without hand-written jq: one row per account,
 * every number the receipts back, redacted to the chosen audience.
 */
export function runExport(home: string, args: string[], json: boolean): number {
  // The global --json flag is honest here: it means --format json.
  let format: "csv" | "json" = json ? "json" : "csv";
  let from: string | null = null;
  let to: string | null = null;
  let audience: Audience | null = null;
  let pack = false;
  let out: string | null = null;
  let now: string | null = null;
  let formatSet = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--pack") {
      pack = true;
    } else if (a === "--out" || a === "--now") {
      const v = args[++i];
      if (v === undefined) {
        process.stderr.write(`waybill export: ${a} needs a value\n`);
        return 2;
      }
      if (a === "--out") out = v;
      else now = v;
    } else if (a === "--format") {
      const v = args[++i];
      if (v !== "csv" && v !== "json") {
        process.stderr.write("waybill export: --format must be csv or json\n");
        return 2;
      }
      if (json && v === "csv") {
        process.stderr.write("waybill export: --json conflicts with --format csv — pick one\n");
        return 2;
      }
      format = v;
      formatSet = true;
    } else if (a === "--from" || a === "--to") {
      // A forgotten value must not silently widen the export to all history.
      const v = args[++i];
      if (v === undefined) {
        process.stderr.write(`waybill export: ${a} needs a value\n`);
        return 2;
      }
      if (a === "--from") from = v;
      else to = v;
    } else if (a === "--audience") {
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

  if (pack) {
    if (formatSet) {
      process.stderr.write("waybill export: --pack writes a directory — --format applies to csv/json exports only\n");
      return 2;
    }
    // The verification pack is verbatim, internal-grade data by design —
    // redaction would break the id checks the recipient runs (cmd-pack.ts).
    if (audience !== null) {
      process.stderr.write(
        "waybill export: --pack cannot be redacted (--audience) — verbatim events are what the recipient verifies; share the redacted report instead\n",
      );
      return 2;
    }
    if (now !== null && Number.isNaN(Date.parse(now))) {
      process.stderr.write(`waybill export: --now is not a date: ${now}\n`);
      return 2;
    }
    const nowIso = now ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const outDir = out ?? join(home, "rollups", "verification-pack");
    const { result, error } = buildPack(home, outDir, window, nowIso);
    if (error !== null) {
      process.stderr.write(`waybill export: ${error}\n`);
      return 1;
    }
    if (json) {
      process.stdout.write(JSON.stringify({ data: result }, null, 2) + "\n");
    } else {
      const events =
        result.events.ledger + result.events.usage + result.events.sessions + result.events.exceptions;
      process.stdout.write(
        `verification pack: ${result.out_dir}\n` +
          `${result.sessions} session(s), ${events} event lines, ${result.total_tokens.toLocaleString("en-US")} tokens — verified green at pack time.\n` +
          `Recipient check: node waybill.mjs verify --home .\n`,
      );
    }
    return 0;
  }
  if (out !== null || now !== null) {
    process.stderr.write("waybill export: --out/--now apply to --pack only\n");
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
