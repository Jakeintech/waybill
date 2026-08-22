import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configPath, loadConfig } from "../core/config.ts";
import type { ExceptionEvent, LedgerEntry, PinEntry, UsageEvent } from "../core/events.ts";
import { readEvents } from "../core/streams.ts";
import { loadState } from "../meter/state.ts";
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

/** One-shot first-run lines: each state announced at most once, ever. */
interface FirstRunState {
  uninitialized_announced?: boolean;
  unlogged_announced?: boolean;
}

function firstRunFile(home: string): string {
  return join(home, "rollups", "first-run.json");
}

function loadFirstRun(home: string): FirstRunState {
  const p = firstRunFile(home);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8")) as FirstRunState;
  } catch {
    return {};
  }
}

function saveFirstRun(home: string, state: FirstRunState): void {
  mkdirSync(join(home, "rollups"), { recursive: true });
  writeFileSync(firstRunFile(home), JSON.stringify(state) + "\n", "utf8");
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
  if (Number.isNaN(Date.parse(nowIso))) {
    process.stderr.write(`waybill pace: --now is not a date: ${nowIso}\n`);
    return 2;
  }

  const config = loadConfig(home);
  const ledger = readEvents<LedgerEntry | PinEntry>(home, "ledger");
  const usage = readEvents<UsageEvent>(home, "usage");
  const exceptions = readEvents<ExceptionEvent>(home, "exceptions");
  const pace = paceData(ledger, usage, exceptions, config, nowIso);

  if (notice) {
    // One switch for everything Waybill says first: normal = everything,
    // minimal = pacing thresholds only, off = never speak unprompted.
    const level = config.notices.level;
    if (level === "off") return 0;

    if (pace.allocation) {
      const prior = loadPaceState(home);
      const samePeriod = prior !== null && prior.period === pace.allocation.period;
      const already = samePeriod ? prior.notified_thresholds : [];
      const fresh = pace.thresholds_crossed.filter((t) => !already.includes(t));

      // Allocation-cycle reminder: N days before the grant renews, one nudge
      // to draft the pitch while the receipts are fresh. Not a threshold, so
      // `minimal` silences it.
      const reminderDays = config.budgets.renewal_reminder_days;
      const renewalDue =
        level === "normal" &&
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
      if (lines.length > 0) {
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
        return 0; // at most one notice block per session — never stack first-run lines on it
      }
    }

    // First-run one-shots (normal level only): speak once at the two
    // highest-intent moments, then never again — each state at most once ever.
    if (level !== "normal") return 0;
    const firstRun = loadFirstRun(home);
    if (!existsSync(configPath(home))) {
      if (firstRun.uninitialized_announced !== true) {
        process.stdout.write(
          'waybill: not initialized. Say "initialize my waybill ledger" — 60s, no auth.\n',
        );
        saveFirstRun(home, { ...firstRun, uninitialized_announced: true });
      }
      return 0;
    }
    const sessionsMetered = Object.keys(loadState(home).sessions).length;
    const entriesLogged = ledger.filter((e) => e.kind !== "pin").length;
    if (sessionsMetered > 0 && entriesLogged === 0 && firstRun.unlogged_announced !== true) {
      process.stdout.write(
        `waybill: ${sessionsMetered} session(s) metered, nothing logged yet. ` +
          'Say "sync my ledger" for a receipt from your git history.\n',
      );
      saveFirstRun(home, { ...firstRun, unlogged_announced: true });
    }
    return 0;
  }

  if (json) {
    process.stdout.write(JSON.stringify({ data: pace }, null, 2) + "\n");
  } else {
    process.stdout.write(renderPace(pace) + "\n");
  }
  return 0;
}
