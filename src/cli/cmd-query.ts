import { loadConfig, type Audience, type Detail } from "../core/config.ts";
import type { ExceptionEvent, LedgerEntry, PinEntry, SessionEvent, UsageEvent } from "../core/events.ts";
import { readEvents } from "../core/streams.ts";
import {
  effectiveShipped,
  forecastData,
  normalizeWindow,
  reportData,
  spendData,
  type Window,
} from "../projections/queries.ts";
import { manifestData } from "../projections/manifest.ts";
import { resolveStandupWindow, standupData } from "../projections/standup.ts";
import { untrackedData } from "../projections/untracked.ts";
import { redact } from "../report/redaction.ts";

const AUDIENCES: Audience[] = ["self", "internal", "external"];
const DETAILS: Detail[] = ["terse", "standard", "full"];

export function runQuery(home: string, args: string[]): number {
  const [what, ...rest] = args;
  let from: string | null = null;
  let to: string | null = null;
  let date: string | null = null;
  let days: string | null = null;
  let now: string | null = null;
  let audience: Audience | null = null;
  let detail: Detail | null = null;
  const positional: string[] = [];
  // A value-taking flag with no value, or a typo'd flag, must error — the
  // silent alternative is a full-history window presented as filtered.
  const need = (i: number, flag: string): string | null => {
    const v = rest[i];
    if (v === undefined) {
      process.stderr.write(`waybill query: ${flag} needs a value\n`);
      return null;
    }
    return v;
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--from") {
      if ((from = need(++i, a)) === null) return 2;
    } else if (a === "--to") {
      if ((to = need(++i, a)) === null) return 2;
    } else if (a === "--date") {
      if ((date = need(++i, a)) === null) return 2;
    } else if (a === "--days") {
      if ((days = need(++i, a)) === null) return 2;
    } else if (a === "--now") {
      if ((now = need(++i, a)) === null) return 2;
    } else if (a === "--audience") {
      const v = rest[++i];
      if (!v || !AUDIENCES.includes(v as Audience)) {
        process.stderr.write(`waybill query: --audience must be one of ${AUDIENCES.join(", ")}\n`);
        return 2;
      }
      audience = v as Audience;
    } else if (a === "--detail") {
      const v = rest[++i];
      if (!v || !DETAILS.includes(v as Detail)) {
        process.stderr.write(`waybill query: --detail must be one of ${DETAILS.join(", ")}\n`);
        return 2;
      }
      detail = v as Detail;
    } else if (a.startsWith("--")) {
      process.stderr.write(`waybill query: unknown option ${a}\n`);
      return 2;
    } else positional.push(a);
  }

  if (what !== "standup" && (date !== null || days !== null)) {
    process.stderr.write("waybill query: --date/--days apply to `query standup` only\n");
    return 2;
  }
  if (now !== null && what !== "standup" && what !== "manifest") {
    process.stderr.write("waybill query: --now applies to `query standup` and `query manifest`\n");
    return 2;
  }
  if (now !== null && Number.isNaN(Date.parse(now))) {
    process.stderr.write(`waybill query: --now is not a date: ${now}\n`);
    return 2;
  }

  const config = loadConfig(home);
  const aud = audience ?? config.audience_default;
  const det = detail ?? config.detail_default;
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
    case "manifest": {
      // What's still on the truck: open items, open spend, age, and the
      // demurrage flag. Age needs a clock — injectable, CLI-edge only.
      const nowIso = now ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
      payload = manifestData(ledger, usage, config, nowIso);
      break;
    }
    case "untracked": {
      // The salvage clustering: spend with no ledger receipt behind it,
      // grouped into candidate work items with their receipts attached.
      const sessions = readEvents<SessionEvent>(home, "sessions");
      payload = untrackedData(ledger, usage, sessions, config, window);
      break;
    }
    case "standup": {
      // The one projection with a relative default window (yesterday): day
      // math happens here at the CLI edge, injectable via --now; the
      // projection itself stays clock-free.
      let resolved: { window: Window; label: string | null };
      try {
        resolved = resolveStandupWindow(
          { date, days: days !== null ? Number(days) : null, from, to },
          now !== null ? new Date(now) : new Date(),
        );
      } catch (err) {
        process.stderr.write(`waybill query standup: ${(err as Error).message}\n`);
        return 2;
      }
      const sessions = readEvents<SessionEvent>(home, "sessions");
      payload = standupData(ledger, usage, sessions, exceptions, config, resolved.window, resolved.label);
      break;
    }
    default:
      process.stderr.write(
        "waybill query: pass one of spend | report | forecast | story <KEY> | inbox | standup | untracked | manifest\n",
      );
      return 2;
  }

  const { data, mapping } = redact(payload, aud);
  // `detail` is echoed for the rendering layer (skills): the engine returns
  // full data either way — length is a rendering decision, never a data one.
  const out =
    aud === "external"
      ? { audience: aud, detail: det, data, redaction_note: "identifiers pseudonymized; internal version available on request", mapping_size: Object.keys(mapping).length }
      : { audience: aud, detail: det, data };
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  return 0;
}
