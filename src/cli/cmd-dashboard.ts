import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../core/config.ts";
import type {
  ExceptionEvent,
  LedgerEntry,
  PinEntry,
  SessionEvent,
  UsageEvent,
} from "../core/events.ts";
import { findReferenceFile } from "../core/references.ts";
import { readEvents } from "../core/streams.ts";
import { manifestData } from "../projections/manifest.ts";
import { spendData } from "../projections/queries.ts";
import { localDayWindow, standupData } from "../projections/standup.ts";
import { ENGINE_VERSION } from "./main.ts";

/**
 * The zero-token dashboard: a static rollup in rollups/dashboard.html.
 * The engine only injects a JSON snapshot into the bundled template —
 * presentation stays out of the verified path (the template is a static
 * plugin file; the output is a derived, deletable rollup, never a
 * receipt). Reading your own numbers costs nothing: no model call, no
 * network, refreshed by the detached miner after each session.
 */
export function generateDashboard(home: string, nowIso: string): string {
  const config = loadConfig(home);
  const ledger = readEvents<LedgerEntry | PinEntry>(home, "ledger");
  const usage = readEvents<UsageEvent>(home, "usage");
  const sessions = readEvents<SessionEvent>(home, "sessions");
  const exceptions = readEvents<ExceptionEvent>(home, "exceptions");

  const now = new Date(nowIso);
  const iso = (d: Date): string => d.toISOString();
  const daysAgo = (n: number): string => iso(new Date(now.getTime() - n * 86400_000));

  const spend30 = spendData(usage, exceptions, ledger, config, { from: daysAgo(30), to: nowIso });
  const spend12w = spendData(usage, exceptions, ledger, config, { from: daysAgo(84), to: nowIso });
  const week = { from: localDayWindow(now, -6).from, to: localDayWindow(now, 0).to };
  const standup = standupData(ledger, usage, sessions, exceptions, config, week, "last 7 day(s)");
  const manifest = manifestData(ledger, usage, config, nowIso);

  const data = {
    generated_at: nowIso,
    engine: ENGINE_VERSION,
    spend30,
    weeks: spend12w.by_week.slice(-12),
    standup,
    manifest,
  };

  const template = readFileSync(findReferenceFile("dashboard-template.html"), "utf8");
  // <-escape so ledger strings can never break out of the JSON block.
  const payload = JSON.stringify(data).replace(/</g, "\\u003c");
  const html = template.replace("__WAYBILL_DATA__", payload);
  const dir = join(home, "rollups");
  mkdirSync(dir, { recursive: true });
  const out = join(dir, "dashboard.html");
  writeFileSync(out, html, "utf8");
  return out;
}

/** Miner hook: refresh an existing dashboard, silently and best-effort —
 * generation is opted into by the first `waybill dashboard` run. */
export function refreshDashboardIfPresent(home: string): void {
  try {
    if (existsSync(join(home, "rollups", "dashboard.html"))) {
      generateDashboard(home, new Date().toISOString().replace(/\.\d{3}Z$/, "Z"));
    }
  } catch {
    // never let a rollup refresh disturb metering
  }
}

export function runDashboard(home: string, args: string[], json: boolean): number {
  let nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--now") {
      const v = args[++i];
      if (!v || Number.isNaN(Date.parse(v))) {
        process.stderr.write("waybill dashboard: --now needs an ISO timestamp\n");
        return 2;
      }
      nowIso = v;
    } else {
      process.stderr.write(`waybill dashboard: unknown option ${a}\n`);
      return 2;
    }
  }
  let out: string;
  try {
    out = generateDashboard(home, nowIso);
  } catch (err) {
    process.stderr.write(`waybill dashboard: ${(err as Error).message}\n`);
    return 1;
  }
  if (json) {
    process.stdout.write(JSON.stringify({ data: { path: out, generated_at: nowIso } }) + "\n");
  } else {
    process.stdout.write(
      `wrote ${out}\nOpen it in a browser — reading your numbers costs zero tokens. ` +
        `The miner refreshes it after each session; regenerate any time with: waybill dashboard\n`,
    );
  }
  return 0;
}
