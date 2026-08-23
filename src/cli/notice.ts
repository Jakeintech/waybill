import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configPath, loadConfig } from "../core/config.ts";
import type { ExceptionEvent, LedgerEntry, PinEntry, UsageEvent } from "../core/events.ts";
import { readEvents } from "../core/streams.ts";
import { loadState } from "../meter/state.ts";
import { paceData } from "../projections/pace.ts";

/**
 * The one place session-start notices are decided (E-12). Two consumers:
 *
 * - `pace --notice` prints the lines directly (the manual/CLI path).
 * - the detached miner queues them into `rollups/next-notice`, which the
 *   SessionStart hook serves and consumes with pure shell — session start
 *   is never taxed with engine work, and hooks.json's "neither hook
 *   blocks" is true. Thresholds cross when tokens land, i.e. at session
 *   end — so computing at mine time changes nothing about when a notice
 *   appears.
 *
 * `mark()` persists the shown-once state (pace thresholds, renewal,
 * first-run one-shots). The queue path marks at write time: the queued
 * file persists until a session start consumes it, so the notice is
 * still delivered exactly once — just never recomputed.
 */

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

/** One-shot first-run lines: each state announced at most once, ever.
 * `uninitialized_announced` is shared with the SessionStart hook, which
 * owns the not-initialized nudge in pure shell for the very first
 * session and writes the same marker shape. */
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

export function noticeFile(home: string): string {
  return join(home, "rollups", "next-notice");
}

export interface NoticeComputation {
  lines: string[];
  mark: () => void;
}

/** What the next session start should hear — at most one block — plus the
 * closure that records it as said. Callers print or queue, then mark. */
export function computeNotice(home: string, nowIso: string): NoticeComputation {
  const config = loadConfig(home);
  const level = config.notices.level;
  if (level === "off") return { lines: [], mark: () => {} };

  const ledger = readEvents<LedgerEntry | PinEntry>(home, "ledger");
  const usage = readEvents<UsageEvent>(home, "usage");
  const exceptions = readEvents<ExceptionEvent>(home, "exceptions");
  const pace = paceData(ledger, usage, exceptions, config, nowIso);

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
      const allocation = pace.allocation;
      return {
        lines, // at most one notice block per session — never stack first-run lines on it
        mark: () => {
          mkdirSync(join(home, "rollups"), { recursive: true });
          writeFileSync(
            stateFile(home),
            JSON.stringify({
              period: allocation.period,
              notified_thresholds: [...new Set([...already, ...fresh])].sort((a, b) => a - b),
              renewal_notified: (samePeriod && prior.renewal_notified === true) || renewalDue,
            }) + "\n",
            "utf8",
          );
        },
      };
    }
  }

  // First-run one-shots (normal level only): speak once at the two
  // highest-intent moments, then never again — each state at most once ever.
  if (level !== "normal") return { lines: [], mark: () => {} };
  const firstRun = loadFirstRun(home);
  if (!existsSync(configPath(home))) {
    if (firstRun.uninitialized_announced !== true) {
      return {
        lines: ['waybill: not initialized. Say "initialize my waybill ledger" — 60s, no auth.'],
        mark: () => saveFirstRun(home, { ...firstRun, uninitialized_announced: true }),
      };
    }
    return { lines: [], mark: () => {} };
  }
  const sessionsMetered = Object.keys(loadState(home).sessions).length;
  const entriesLogged = ledger.filter((e) => e.kind !== "pin").length;
  if (sessionsMetered > 0 && entriesLogged === 0 && firstRun.unlogged_announced !== true) {
    return {
      lines: [
        `waybill: ${sessionsMetered} session(s) metered, nothing logged yet. ` +
          'Say "sync my ledger" for a receipt from your git history.',
      ],
      mark: () => saveFirstRun(home, { ...firstRun, unlogged_announced: true }),
    };
  }
  return { lines: [], mark: () => {} };
}

/**
 * The miner's path: compute the notice and queue it for the next session
 * start. New lines append to a still-unserved file (two crossings before
 * one start both arrive); nothing new leaves a pending file untouched.
 */
export function queueNotice(home: string, nowIso: string): void {
  const { lines, mark } = computeNotice(home, nowIso);
  if (lines.length === 0) return;
  mkdirSync(join(home, "rollups"), { recursive: true });
  const p = noticeFile(home);
  let pending: string[] = [];
  if (existsSync(p)) {
    try {
      pending = readFileSync(p, "utf8").split("\n").filter((l) => l !== "");
    } catch {
      pending = [];
    }
  }
  const fresh = lines.filter((l) => !pending.includes(l));
  if (fresh.length === 0) return;
  writeFileSync(p, [...pending, ...fresh].join("\n") + "\n", "utf8");
  mark();
}
