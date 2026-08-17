import { loadConfig, type Audience } from "../core/config.ts";
import type { ExceptionEvent, LedgerEntry, PinEntry, UsageEvent } from "../core/events.ts";
import { readEvents } from "../core/streams.ts";
import {
  effectiveShipped,
  forecastData,
  normalizeWindow,
  reportData,
  spendData,
  type Window,
} from "../projections/queries.ts";
import { redact } from "../report/redaction.ts";

const AUDIENCES: Audience[] = ["self", "internal", "external"];

export function runQuery(home: string, args: string[]): number {
  const [what, ...rest] = args;
  let from: string | null = null;
  let to: string | null = null;
  let audience: Audience | null = null;
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--from") from = rest[++i] ?? null;
    else if (a === "--to") to = rest[++i] ?? null;
    else if (a === "--audience") {
      const v = rest[++i];
      if (!v || !AUDIENCES.includes(v as Audience)) {
        process.stderr.write(`waybill query: --audience must be one of ${AUDIENCES.join(", ")}\n`);
        return 2;
      }
      audience = v as Audience;
    } else positional.push(a);
  }

  const config = loadConfig(home);
  const aud = audience ?? config.audience_default;
  let window: Window;
  try {
    window = normalizeWindow(from, to);
  } catch (err) {
    process.stderr.write(`waybill query: ${(err as Error).message}\n`);
    return 2;
  }
  const ledger = readEvents<LedgerEntry | PinEntry>(home, "ledger");
  const usage = readEvents<UsageEvent>(home, "usage");
  const exceptions = readEvents<ExceptionEvent>(home, "exceptions");

  let payload: unknown;
  switch (what) {
    case "spend":
      payload = spendData(usage, exceptions, ledger, config, window);
      break;
    case "report":
      payload = reportData(ledger, usage, exceptions, config, window);
      break;
    case "forecast":
      payload = forecastData(ledger, usage, config);
      break;
    case "story": {
      const key = positional[0];
      if (!key) {
        process.stderr.write("waybill query story: pass the tracker key\n");
        return 2;
      }
      const spend = spendData(usage, exceptions, ledger, config, window);
      const account = spend.accounts.find((a) => a.account === `story:${key}`) ?? null;
      // Supersession-aware: the latest authoritative view of the item, even
      // if that view is a correction over the shipped entry.
      const view =
        effectiveShipped(ledger)
          .filter((s) => s.entry.tracker_key === key)
          .sort((a, b) => (a.shipped_ts < b.shipped_ts ? -1 : 1))
          .pop() ?? null;
      payload = {
        key,
        spend: account,
        cache_read_share:
          account && account.tokens > 0
            ? Math.round((account.cache_read / account.tokens) * 1000) / 10
            : null,
        shipped: view
          ? {
              id: view.entry.id,
              ts: view.shipped_ts,
              points: view.entry.points,
              prs: view.entry.artifacts.prs,
            }
          : null,
        tokens_per_point:
          account && view && view.entry.points
            ? Math.round(account.tokens / view.entry.points)
            : null,
      };
      break;
    }
    case "inbox": {
      const resolved = new Set(
        exceptions.filter((e) => e.kind === "resolution").map((e) => (e as { resolves: string }).resolves),
      );
      payload = exceptions.filter((e) => e.kind === "ambiguity" && !resolved.has(e.id));
      break;
    }
    default:
      process.stderr.write(
        "waybill query: pass one of spend | report | forecast | story <KEY> | inbox\n",
      );
      return 2;
  }

  const { data, mapping } = redact(payload, aud);
  const out =
    aud === "external"
      ? { audience: aud, data, redaction_note: "identifiers pseudonymized; internal version available on request", mapping_size: Object.keys(mapping).length }
      : { audience: aud, data };
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  return 0;
}
