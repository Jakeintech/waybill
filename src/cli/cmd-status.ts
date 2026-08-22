import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../core/config.ts";
import type { ExceptionEvent, LedgerEntry, PinEntry, UsageEvent } from "../core/events.ts";
import { resolveRate, unpricedModels } from "../core/pricing-resolve.ts";
import { authoritative, readEvents } from "../core/streams.ts";
import { manifestData } from "../projections/manifest.ts";
import { countOpenAmbiguities, spendData } from "../projections/queries.ts";
import { loadState } from "../meter/state.ts";
import { verifyHome } from "../verify/verify.ts";
import { execFileSync } from "node:child_process";
import { checkRetention } from "./cmd-init.ts";
import { parseFlags } from "./flags.ts";
import { ENGINE_VERSION } from "./main.ts";

function fmtInt(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * One screen of ledger health — everything a user would otherwise assemble
 * from init/verify/query/jq by hand.
 */
export function runStatus(home: string, args: string[], json: boolean): number {
  const flags = parseFlags("status", args, { "--claude-settings": "value", "--fast": "boolean" });
  if (flags === null) return 2;
  const claudeSettings = flags.values["--claude-settings"] ?? join(homedir(), ".claude", "settings.json");
  // --fast (architecture review rec. 6): skip the full-ledger verify
  // re-hash — the one expensive step on a large home. Everything else on
  // the screen is cheap. The verify line says it was skipped, never "ok".
  const fast = flags.bools["--fast"] === true;

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
  const manifest = manifestData(ledger, usage, config, new Date().toISOString().replace(/\.\d{3}Z$/, "Z"));
  const state = loadState(home);
  const lastMine = Object.values(state.sessions)
    .map((s) => s.metered_through_ts ?? "")
    .filter((t) => t !== "")
    .sort()
    .pop() ?? null;
  const gaps = exceptions.filter((e) => e.kind === "meter_gap").length;
  const findings = fast ? null : verifyHome(home);

  // Pricing health — the check behind "costs appear from day one": which
  // models actually metered into the ledger have no resolvable rate, and
  // how many events still carry no cost (cured by the next meter run).
  // Sessions whose transcripts are gone (meter_gap) can never re-price —
  // they must not keep the "run meter --all" hint alive forever.
  const authUsage = authoritative(usage).filter((u) => u.kind === "usage");
  const seenModels = [...new Set(authUsage.map((u) => u.model))];
  const unpriced = unpricedModels(config.pricing, seenModels);
  const unpricedEvents = authUsage.filter((u) => u.cost_usd === null).length;
  const gapSessions = new Set(
    exceptions.filter((e) => e.kind === "meter_gap").map((e) => (e as { session_id: string }).session_id),
  );
  const repriceable = authUsage.filter(
    (u) =>
      u.cost_usd === null &&
      u.model !== "unknown" &&
      !gapSessions.has(u.session_id) &&
      resolveRate(config.pricing, u.model) !== null,
  ).length;

  // MCP credential check — env only, no network: helps generate the
  // credentials instead of leaving a red error in the plugin panel.
  const githubPatSet = (process.env["GITHUB_MCP_PAT"] ?? "") !== "";
  let ghCliAvailable = false;
  try {
    execFileSync("gh", ["auth", "status"], { stdio: ["ignore", "ignore", "ignore"], timeout: 5000 });
    ghCliAvailable = true;
  } catch {
    // gh missing or unauthenticated — fine
  }
  // Atlassian CLI (acli) — the light-payload Jira sync path. Probed only
  // when the tracker is Jira: a wedged acli must not stall the health
  // screen for users who never touch it. null = not probed.
  let acliAuthenticated: boolean | null = null;
  if (config.tracker.kind === "jira") {
    acliAuthenticated = false;
    try {
      execFileSync("acli", ["jira", "auth", "status"], { stdio: ["ignore", "ignore", "ignore"], timeout: 5000 });
      acliAuthenticated = true;
    } catch {
      // acli missing or unauthenticated — fine; the MCP path still works
    }
  }

  // Multi-machine (v1.7): is the ledger home tracking a remote, and how far
  // apart are they? LOCAL REFS ONLY — status never touches the network, so
  // ahead/behind is "as of the last fetch", and says so.
  const git = (cwdArgs: string[]): string | null => {
    try {
      return execFileSync("git", ["-C", home, ...cwdArgs], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
      }).trim();
    } catch {
      return null;
    }
  };
  const gitBacked = git(["rev-parse", "--is-inside-work-tree"]) === "true";
  const upstream = gitBacked ? git(["rev-parse", "--abbrev-ref", "@{upstream}"]) : null;
  let ahead: number | null = null;
  let behind: number | null = null;
  let fetchedAt: string | null = null;
  if (upstream !== null) {
    const counts = git(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]);
    const m = counts !== null ? /^(\d+)\s+(\d+)$/.exec(counts) : null;
    if (m) {
      ahead = Number(m[1]);
      behind = Number(m[2]);
    }
    try {
      const gitDir = git(["rev-parse", "--absolute-git-dir"]) ?? join(home, ".git");
      fetchedAt = statSync(join(gitDir, "FETCH_HEAD"))
        .mtime.toISOString().replace(/\.\d{3}Z$/, "Z");
    } catch {
      fetchedAt = null; // never fetched on this machine — push-only so far
    }
  }
  const remote = { git_backed: gitBacked, upstream, ahead, behind, fetched_at: fetchedAt };

  // The menu, not just the health screen: state-derived trigger phrases —
  // what to *say* next, chosen from what the ledger actually needs.
  const entriesLogged = ledger.filter((e) => e.kind !== "pin").length;
  const next: string[] = [];
  if (!initialized) {
    next.push('"initialize my waybill ledger" — 60s, no auth');
  } else {
    if (spend.attribution_health.inbox_open > 0)
      next.push(`"resolve my attribution inbox" (${spend.attribution_health.inbox_open} open)`);
    if (pendingUnmined > 0) next.push(`"process my pending sessions" (${pendingUnmined} waiting)`);
    next.push(
      entriesLogged === 0
        ? '"sync my ledger" — a receipt from your git history'
        : '"build my token pitch"',
    );
  }

  const data = {
    home,
    initialized,
    retention,
    mcp: {
      github_pat_set: githubPatSet,
      gh_cli_authenticated: ghCliAvailable,
      acli_jira_authenticated: acliAuthenticated,
    },
    pricing: {
      version: config.pricing.version,
      models_priced: Object.keys(config.pricing.models).length,
      unpriced_models: unpriced,
      unpriced_events: unpricedEvents,
      repriceable_events: repriceable,
    },
    metering: {
      enabled: config.metering.enabled,
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
    manifest: {
      open_items: manifest.open_items.length,
      open_tokens: manifest.open_tokens,
      sitting: manifest.sitting,
      demurrage_days: manifest.demurrage_days,
    },
    verify:
      findings === null
        ? { skipped: true as const }
        : { findings: findings.length, ok: findings.length === 0 },
    remote,
    next: next.slice(0, 2),
  };

  if (json) {
    process.stdout.write(JSON.stringify({ data }, null, 2) + "\n");
    return findings === null || findings.length === 0 ? 0 : 1;
  }

  const lines: string[] = [];
  lines.push(`waybill status — ${home} (engine ${ENGINE_VERSION})`);
  lines.push(initialized ? "initialized: yes (git-backed, append-only)" : "initialized: NO — run: waybill init");
  lines.push(
    `retention: ${retention.effective}` +
      (retention.recommendation ? ` — recommend: ${retention.recommendation}` : ""),
  );
  if (retention.warning) lines.push(`  WARNING: ${retention.warning}`);
  lines.push(
    (config.metering.enabled
      ? `metering: ${fmtInt(data.metering.sessions_metered)} session(s) metered`
      : `metering: PAUSED (config.metering.enabled = false) — ` +
        `${fmtInt(data.metering.sessions_metered)} session(s) metered before the pause`) +
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
  if (manifest.sitting > 0) {
    lines.push(
      `manifest: ${manifest.open_items.length} open item(s), ${fmtInt(manifest.open_tokens)} tokens open; ` +
        `${manifest.sitting} sitting idle ≥ ${manifest.demurrage_days}d — see: waybill query manifest`,
    );
  }
  if (config.pricing.version === null || Object.keys(config.pricing.models).length === 0) {
    lines.push(
      "pricing: NOT CONFIGURED — costs stay tokens-only. Fix: waybill pricing import",
    );
  } else {
    lines.push(
      `pricing: version ${config.pricing.version}, ${Object.keys(config.pricing.models).length} model(s)` +
        (unpriced.length > 0
          ? `; NO RATE for metered model(s): ${unpriced.join(", ")} — costs shown tokens-only.` +
            " Fix: waybill pricing set <model-id> ... (then: waybill meter --all)"
          : "") +
        (repriceable > 0
          ? `; ${fmtInt(repriceable)} event(s) metered before their rate existed — re-price: waybill meter --all`
          : ""),
    );
  }
  lines.push(
    findings === null
      ? "verify: skipped (--fast) — run: waybill verify"
      : findings.length === 0
        ? "verify: all checks pass"
        : `verify: ${findings.length} finding(s) — run: waybill verify`,
  );
  if (remote.upstream !== null) {
    lines.push(
      `remote: ${remote.upstream} — ` +
        (remote.ahead !== null && remote.behind !== null
          ? `${remote.ahead} ahead, ${remote.behind} behind` +
            (remote.fetched_at !== null ? ` (as of last fetch ${remote.fetched_at})` : " (never fetched here — counts are vs the last push)")
          : "counts unavailable") +
        (remote.behind !== null && remote.behind > 0
          ? ". Pull before logging: git -C \"$WAYBILL_HOME\" pull"
          : ""),
    );
  } else if (remote.git_backed) {
    lines.push(
      "remote: none — this ledger lives on this machine only. Multi-machine setup: docs/multi-machine.md",
    );
  }
  if (!githubPatSet) {
    lines.push(
      "mcp: GITHUB_MCP_PAT not set — the GitHub sync upgrade is inactive (everything else works).",
    );
    lines.push(
      ghCliAvailable
        ? '  You have an authenticated gh CLI — generate it from that:  export GITHUB_MCP_PAT="$(gh auth token)"'
        : "  Generate a fine-grained read-only PAT at https://github.com/settings/personal-access-tokens and:  export GITHUB_MCP_PAT=github_pat_…",
    );
    lines.push("  (Atlassian needs no token — run /mcp in Claude Code and complete its OAuth.)");
  }
  if (config.tracker.kind === "jira") {
    lines.push(
      acliAuthenticated
        ? "tracker: acli (Atlassian CLI) authenticated — Jira syncs fetch through it (light payloads; the Atlassian MCP is not needed)."
        : "tracker: acli (Atlassian CLI) not detected — Jira syncs use the Atlassian MCP. Lighter: install acli (developer.atlassian.com/cloud/acli) and run: acli jira auth login --web",
    );
  }
  if (data.next.length > 0) lines.push(`next: ${data.next.join(" · ")}`);
  process.stdout.write(lines.join("\n") + "\n");
  return findings === null || findings.length === 0 ? 0 : 1;
}
