import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../core/config.ts";
import type { ExceptionEvent, LedgerEntry, PinEntry, UsageEvent } from "../core/events.ts";
import { readEvents } from "../core/streams.ts";
import { paceData, renderPace } from "../projections/pace.ts";

interface PaceState {
  period: string;
  notified_thresholds: number[];
  renewal_notified?: boolean;
}

function stateFile(home: string): string {
  return join(home, "rollups", "pace-state.json");
}

function loadPaceState(home: string): PaceState | null {
  const p = stateFile(home);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as PaceState;
  } catch {
    return null;
  }
}

/**
 * `pace` prints the full pacing picture. `pace --notice` prints at most ONE
 * line, and only when a threshold (80%, 100%) is newly crossed since the
 * last notice — the SessionStart hook uses it, so pacing surfaces at a
 * natural moment exactly once per crossing. Never nagging (FR-B3).
 */
export function runPace(home: string, args: string[], json: boolean): number {
  let notice = false;
  let nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--notice") notice = true;
    else if (a === "--now") nowIso = args[++i] ?? nowIso;
    else {
      process.stderr.write(`waybill pace: unknown option ${a}\n`);
      return 2;
    }
  }

  const config = loadConfig(home);
  const ledger = readEvents<LedgerEntry | PinEntry>(home, "ledger");
  const usage = readEvents<UsageEvent>(home, "usage");
  const exceptions = readEvents<ExceptionEvent>(home, "exceptions");
  const pace = paceData(ledger, usage, exceptions, config, nowIso);

  if (notice) {
    if (!pace.allocation) return 0;
    const prior = loadPaceState(home);
    const samePeriod = prior !== null && prior.period === pace.allocation.period;
    const already = samePeriod ? prior.notified_thresholds : [];
    const fresh = pace.thresholds_crossed.filter((t) => !already.includes(t));

    // Allocation-cycle reminder: N days before the grant renews, one nudge
    // to draft the pitch while the receipts are fresh.
    const reminderDays = config.budgets.renewal_reminder_days;
    const renewalDue =
      pace.days_to_renewal !== null &&
      pace.days_to_renewal >= 0 &&
      pace.days_to_renewal <= reminderDays &&
      !(samePeriod && prior.renewal_notified === true);

    const lines: string[] = [];
    if (fresh.length > 0) {
      const top = Math.max(...fresh);
      lines.push(
        `waybill: ${top}% of the ${pace.allocation.period} token grant is spent` +
          (pace.shipped_pct_of_committed !== null
            ? ` with ${pace.shipped_pct_of_committed}% of committed points shipped`
            : "") +
          (pace.biggest_open_spend ? `; biggest open spend: ${pace.biggest_open_spend.account}` : "") +
          ". Worth a look, not an alarm.",
      );
    }
    if (renewalDue) {
      lines.push(
        `waybill: the ${pace.allocation.period} grant renews in ${pace.days_to_renewal} day(s) — ` +
          `a good moment to build the token pitch while the receipts are fresh.`,
      );
    }
    if (lines.length === 0) return 0;
    process.stdout.write(lines.join("\n") + "\n");
    mkdirSync(join(home, "rollups"), { recursive: true });
    writeFileSync(
      stateFile(home),
      JSON.stringify({
        period: pace.allocation.period,
        notified_thresholds: [...new Set([...already, ...fresh])].sort((a, b) => a - b),
        renewal_notified: (samePeriod && prior.renewal_notified === true) || renewalDue,
      }) + "\n",
      "utf8",
    );
    return 0;
  }

  if (json) {
    process.stdout.write(JSON.stringify({ data: pace }, null, 2) + "\n");
  } else {
    process.stdout.write(renderPace(pace) + "\n");
  }
  return 0;
}
