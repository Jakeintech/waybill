import { loadConfig } from "../core/config.ts";
import type { ExceptionEvent, LedgerEntry, PinEntry, UsageEvent } from "../core/events.ts";
import { readEvents } from "../core/streams.ts";
import { paceData, renderPace } from "../projections/pace.ts";
import { computeNotice } from "./notice.ts";

/**
 * `pace` prints the full pacing picture. `pace --notice` prints at most ONE
 * block, and only when a threshold (80%, 100%) is newly crossed since the
 * last notice — so pacing surfaces at a natural moment exactly once per
 * crossing, never nagging (FR-B3). The SessionStart hook does not run this
 * command: the detached miner queues the same lines via cli/notice.ts and
 * the hook serves them from a file (E-12).
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

  if (notice) {
    const { lines, mark } = computeNotice(home, nowIso);
    if (lines.length > 0) {
      process.stdout.write(lines.join("\n") + "\n");
      mark();
    }
    return 0;
  }

  const config = loadConfig(home);
  const ledger = readEvents<LedgerEntry | PinEntry>(home, "ledger");
  const usage = readEvents<UsageEvent>(home, "usage");
  const exceptions = readEvents<ExceptionEvent>(home, "exceptions");
  const pace = paceData(ledger, usage, exceptions, config, nowIso);
  if (json) {
    process.stdout.write(JSON.stringify({ data: pace }, null, 2) + "\n");
  } else {
    process.stdout.write(renderPace(pace) + "\n");
  }
  return 0;
}
