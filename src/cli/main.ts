import { resolveHome } from "../core/home.ts";
import { renderFindings, splitFindings, verifyHome } from "../verify/verify.ts";

// Injected by the build (esbuild --define); "dev" when running from src/.
declare const __WAYBILL_VERSION__: string | undefined;
export const ENGINE_VERSION: string =
  typeof __WAYBILL_VERSION__ === "string" ? __WAYBILL_VERSION__ : "dev";
import { runAppend } from "./cmd-append.ts";
import { runBootstrap } from "./cmd-bootstrap.ts";
import { runConventions } from "./cmd-conventions.ts";
import { runDashboard } from "./cmd-dashboard.ts";
import { runInit } from "./cmd-init.ts";
import { runMeter } from "./cmd-meter.ts";
import { runMine } from "./cmd-mine.ts";
import { runExport } from "./cmd-export.ts";
import { runPace } from "./cmd-pace.ts";
import { runPricing } from "./cmd-pricing.ts";
import { runStatus } from "./cmd-status.ts";
import { runQuery } from "./cmd-query.ts";
import { runResolve } from "./cmd-resolve.ts";
import { runSyncPlan } from "./cmd-sync-plan.ts";

const USAGE = `waybill — token accounting for AI-assisted work. Bring receipts.

Usage: waybill <command> [options]

Commands:
  init        Initialize $WAYBILL_HOME: git repo, config, identity map, retention check
  bootstrap   Render a bootstrap receipt from local git history (zero auth)
                [--days 90 | --from <date> [--to <date>]] [--repo-path <dir>]...
  mine        Process pending session captures (spawned by the SessionEnd hook)
                [--queue | --all]
  meter       Meter transcripts into usage events (deterministic, incremental)
                --transcript <path> [--repo org/name] | --all [--projects-dir <dir>]
                | --otel <export.jsonl>  (fills transcript-less sessions only)
                [--force  re-meter even when checkpoints say current]
  append      Validate, seal, id, and append one event (the skills' write path)
                --stream <name> (--event '<json>' | --stdin) [--commit]
  resolve     File an attribution-inbox item and re-attribute its turns
                --ambiguity <id> --account <acct> [--pin | --repo-default <org/name>]
  sync-plan   Reconcile normalized tracker/git payloads into proposed entries
                --tracker jira|linear|github-issues|azure-devops --items <raw.json>
                --git github|gitlab|bitbucket|local --changes <raw.json>
                [--local-repo <dir>]... [--since <iso>] [--baseline] | --apply <plan.json>
  query       Projections as JSON: spend | cache (what the bill is made of:
                volume by cache tier, effective vs list cost, derived)
                | report | forecast | story <KEY> | inbox
                | standup ("what did I do" digest — default window: yesterday;
                --date yesterday|today|YYYY-MM-DD or --days <n>, local-calendar)
                | untracked (salvage clustering: spend with no receipt behind it)
                | manifest (open work, open spend, age; --now injectable)
                [--from <date|iso>] [--to <date|iso>] [--audience self|internal|external]
                [--detail terse|standard|full  echoed for the rendering layer]
  pace        Budget pacing vs the allocation (spend, linear + work-weighted pace,
                per-epic envelopes) [--notice  one line, only on a fresh threshold]
  status      One screen of ledger health: init, retention, mining, inbox, verify,
                remote ahead/behind (multi-machine, local refs only — no network)
  export      Spend ledger as csv|json [--format csv|json] [--from/--to] [--audience]
                | --pack [--out <dir>] [--from/--to]: verification pack — verbatim
                events + the engine, so the recipient runs verify themselves
  pricing     show | import [--model <id-or-alias>]... | set <model-id> --version <date>
                --input/--output/--cache-read/--cache-5m/--cache-1h <usd per mtok>
                (import loads bundled Anthropic rates; set overrides any model)
  conventions Print the receipt-friendly CLAUDE.md block and commit-msg hook
                (key-prefixed branches/commits raise attribution confidence)
  dashboard   Write rollups/dashboard.html — the zero-token view of your ledger
                — and open it in your browser [--no-open] [--now <iso>]
                (the miner refreshes the file silently when it exists)
  verify      Check ledger integrity: envelopes, ids, escrow, conservation

Options:
  --home <dir>   Override $WAYBILL_HOME
  --json         Machine-readable output where supported

The engine is deterministic and dependency-free: no model calls, no network.
`;

export interface Cli {
  args: string[];
  home: string;
  json: boolean;
}

export function parseGlobal(argv: string[]): Cli {
  const args: string[] = [];
  let home: string | null = null;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--home") {
      home = argv[++i] ?? null;
      if (home === null) throw new Error("--home requires a value");
    } else if (a === "--json") {
      json = true;
    } else {
      args.push(a);
    }
  }
  return { args, home: home ?? resolveHome(), json };
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (cmd === "--version" || cmd === "version") {
    process.stdout.write(
      `waybill ${ENGINE_VERSION}\nUpdate: claude plugin update waybill@waybill  (then restart Claude Code)\n`,
    );
    return 0;
  }
  const cli = parseGlobal(rest);
  switch (cmd) {
    case "init":
      return runInit(cli.home, cli.args, cli.json);
    case "bootstrap":
      return runBootstrap(cli.home, cli.args, cli.json);
    case "mine":
      return runMine(cli.home, cli.args, cli.json);
    case "meter":
      return runMeter(cli.home, cli.args, cli.json);
    case "append":
      return runAppend(cli.home, cli.args, cli.json);
    case "resolve":
      return runResolve(cli.home, cli.args, cli.json);
    case "sync-plan":
      return runSyncPlan(cli.home, cli.args);
    case "query":
      return runQuery(cli.home, cli.args);
    case "pace":
      return runPace(cli.home, cli.args, cli.json);
    case "status":
      return runStatus(cli.home, cli.args, cli.json);
    case "export":
      return runExport(cli.home, cli.args, cli.json);
    case "pricing":
      return runPricing(cli.home, cli.args, cli.json);
    case "conventions":
      return runConventions(cli.home, cli.args, cli.json);
    case "dashboard":
      return runDashboard(cli.home, cli.args, cli.json);
    case "verify": {
      const findings = verifyHome(cli.home);
      if (cli.json) {
        process.stdout.write(JSON.stringify({ home: cli.home, findings }, null, 2) + "\n");
      } else {
        process.stdout.write(renderFindings(findings, cli.home) + "\n");
      }
      // Warnings are disclosures, not failures: only errors gate the exit.
      return splitFindings(findings).errors.length === 0 ? 0 : 1;
    }
    default:
      process.stderr.write(`waybill: unknown command "${cmd}"\n\n${USAGE}`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`waybill: ${(err as Error).message}\n`);
    process.exit(2);
  },
);
