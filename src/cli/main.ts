import { resolveHome } from "../core/home.ts";
import { renderFindings, verifyHome } from "../verify/verify.ts";
import { runAppend } from "./cmd-append.ts";
import { runBootstrap } from "./cmd-bootstrap.ts";
import { runInit } from "./cmd-init.ts";
import { runMeter } from "./cmd-meter.ts";
import { runMine } from "./cmd-mine.ts";
import { runSyncPlan } from "./cmd-sync-plan.ts";

const USAGE = `waybill — token accounting for AI-assisted work. Bring receipts.

Usage: waybill <command> [options]

Commands:
  init        Initialize $WAYBILL_HOME: git repo, config, identity map, retention check
  bootstrap   Render a bootstrap receipt from local git history (zero auth)
                [--days 90] [--repo-path <dir>]...
  mine        Process pending session captures (spawned by the SessionEnd hook)
                [--queue | --all]
  meter       Meter transcripts into usage events (deterministic, incremental)
                --transcript <path> [--repo org/name] | --all [--projects-dir <dir>]
  append      Validate, seal, id, and append one event (the skills' write path)
                --stream <name> --event '<json>' [--commit]
  sync-plan   Reconcile normalized tracker/git payloads into proposed entries
                --tracker jira --items <raw.json> --git github|local --changes <raw.json>
                [--baseline] | --apply <plan.json>
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
  const cli = parseGlobal(rest);
  switch (cmd) {
    case "init":
      return runInit(cli.home, cli.args, cli.json);
    case "bootstrap":
      return runBootstrap(cli.home, cli.args, cli.json);
    case "mine":
      return runMine(cli.home, cli.args);
    case "meter":
      return runMeter(cli.home, cli.args, cli.json);
    case "append":
      return runAppend(cli.home, cli.args, cli.json);
    case "sync-plan":
      return runSyncPlan(cli.home, cli.args);
    case "verify": {
      const findings = verifyHome(cli.home);
      if (cli.json) {
        process.stdout.write(JSON.stringify({ home: cli.home, findings }, null, 2) + "\n");
      } else {
        process.stdout.write(renderFindings(findings, cli.home) + "\n");
      }
      return findings.length === 0 ? 0 : 1;
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
