import { spawn } from "node:child_process";
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
import { parseFlags } from "./flags.ts";
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

/**
 * Open a file in the platform's default browser, best-effort. Only the
 * explicit `waybill dashboard` command calls this — the miner's silent
 * refresh (refreshDashboardIfPresent) must never pop a browser after a
 * session ends. A missing opener (headless box, CI) is fine: the path is
 * printed either way.
 */
function openInBrowser(path: string): boolean {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [path]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", path]]
        : ["xdg-open", [path]];
  try {
    const child = spawn(cmd as string, args as string[], { detached: true, stdio: "ignore" });
    child.on("error", () => {
      // opener missing — the printed path still tells the user where it is
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export function runDashboard(home: string, args: string[], json: boolean): number {
  const flags = parseFlags("dashboard", args, { "--now": "value", "--no-open": "boolean" });
  if (flags === null) return 2;
  let nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const now = flags.values["--now"];
  if (now !== undefined) {
    if (Number.isNaN(Date.parse(now))) {
      process.stderr.write("waybill dashboard: --now needs an ISO timestamp\n");
      return 2;
    }
    nowIso = now;
  }
  let out: string;
  try {
    out = generateDashboard(home, nowIso);
  } catch (err) {
    process.stderr.write(`waybill dashboard: ${(err as Error).message}\n`);
    return 1;
  }
  // Users shouldn't need to know how to open an HTML file: launch it,
  // unless asked not to (--no-open; --json implies a machine caller).
  const opened = flags.bools["--no-open"] === true || json ? false : openInBrowser(out);
  if (json) {
    process.stdout.write(JSON.stringify({ data: { path: out, generated_at: nowIso } }) + "\n");
  } else {
    process.stdout.write(
      `wrote ${out}\n` +
        (opened
          ? "Opening it in your browser (pass --no-open to skip) — reading your numbers costs zero tokens. "
          : "Open it in a browser — reading your numbers costs zero tokens. ") +
        `The miner refreshes it after each session; regenerate any time with: waybill dashboard\n`,
    );
  }
  return 0;
}
