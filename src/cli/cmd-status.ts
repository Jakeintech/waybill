import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../core/config.ts";
import type { ExceptionEvent, LedgerEntry, PinEntry, UsageEvent } from "../core/events.ts";
import { readEvents } from "../core/streams.ts";
import { countOpenAmbiguities, spendData } from "../projections/queries.ts";
import { loadState } from "../meter/state.ts";
import { verifyHome } from "../verify/verify.ts";
import { checkRetention } from "./cmd-init.ts";

function fmtInt(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * One screen of ledger health — everything a user would otherwise assemble
 * from init/verify/query/jq by hand.
 */
export function runStatus(home: string, args: string[], json: boolean): number {
  let claudeSettings = join(homedir(), ".claude", "settings.json");
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--claude-settings") claudeSettings = args[++i] ?? claudeSettings;
    else {
      process.stderr.write(`waybill status: unknown option ${a}\n`);
      return 2;
    }
  }

  const initialized = existsSync(join(home, "config.json"));
  const config = loadConfig(home);
  const retention = checkRetention(claudeSettings);

  let pendingUnmined = 0;
  const queueDir = join(home, "pending-sessions");
  if (existsSync(queueDir)) {
    for (const f of readdirSync(queueDir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const capture = JSON.parse(readFileSync(join(queueDir, f), "utf8")) as { mined?: unknown };
        if (capture.mined !== true && typeof capture.mined !== "string") pendingUnmined += 1;
      } catch {
        pendingUnmined += 1; // unreadable = needs attention
      }
    }
  }

  const ledger = readEvents<LedgerEntry | PinEntry>(home, "ledger");
  const usage = readEvents<UsageEvent>(home, "usage");
  const exceptions = readEvents<ExceptionEvent>(home, "exceptions");
  const spend = spendData(usage, exceptions, ledger, config, { from: null, to: null });
  const state = loadState(home);
  const lastMine = Object.values(state.sessions)
    .map((s) => s.metered_through_ts ?? "")
    .filter((t) => t !== "")
    .sort()
    .pop() ?? null;
  const gaps = exceptions.filter((e) => e.kind === "meter_gap").length;
  const findings = verifyHome(home);

  const data = {
    home,
    initialized,
    retention,
    metering: {
      sessions_metered: Object.keys(state.sessions).length,
      last_metered_through: lastMine,
      pending_unmined: pendingUnmined,
      meter_gaps: gaps,
    },
    spend: {
      total_tokens: spend.total_tokens,
      unattributed_pct: spend.unattributed_pct,
      attributed_pct_conf_060: spend.attribution_health.attributed_pct_conf_060,
      inbox_open: spend.attribution_health.inbox_open,
    },
    verify: { findings: findings.length, ok: findings.length === 0 },
  };

  if (json) {
    process.stdout.write(JSON.stringify({ data }, null, 2) + "\n");
    return findings.length === 0 ? 0 : 1;
  }

  const lines: string[] = [];
  lines.push(`waybill status — ${home}`);
  lines.push(initialized ? "initialized: yes (git-backed, append-only)" : "initialized: NO — run: waybill init");
  lines.push(
    `retention: ${retention.effective}` +
      (retention.recommendation ? ` — recommend: ${retention.recommendation}` : ""),
  );
  if (retention.warning) lines.push(`  WARNING: ${retention.warning}`);
  lines.push(
    `metering: ${fmtInt(data.metering.sessions_metered)} session(s) metered` +
      (lastMine ? `, through ${lastMine}` : "") +
      (pendingUnmined > 0 ? `; ${pendingUnmined} capture(s) waiting — run: waybill mine --queue` : "") +
      (gaps > 0 ? `; ${gaps} gap(s) (transcripts pruned before mining)` : ""),
  );
  lines.push(
    `spend: ${fmtInt(spend.total_tokens)} tokens, ${spend.unattributed_pct}% unattributed ` +
      `(${spend.attribution_health.attributed_pct_conf_060}% attributed at conf ≥ 0.6)` +
      (spend.attribution_health.inbox_open > 0
        ? `; ${spend.attribution_health.inbox_open} in the attribution inbox — see: waybill query inbox`
        : ""),
  );
  lines.push(
    findings.length === 0
      ? "verify: all checks pass"
      : `verify: ${findings.length} finding(s) — run: waybill verify`,
  );
  process.stdout.write(lines.join("\n") + "\n");
  return findings.length === 0 ? 0 : 1;
}
