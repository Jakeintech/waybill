import { readFileSync } from "node:fs";
import { loadConfig } from "../core/config.ts";
import type { ExceptionEvent, LedgerEntry, PinEntry, SessionEvent, UsageEvent } from "../core/events.ts";
import { appendEvents, readEvents } from "../core/streams.ts";
import { acquireLockWait, releaseLock } from "../meter/lock.ts";
import { meterOtel } from "../meter/otel.ts";
import { defaultProjectsDir, listTranscripts, loadMeterContext, meterFile, meterFileWithSubagents, type MeterRunResult } from "../meter/run.ts";

export async function runMeter(home: string, args: string[], json: boolean): Promise<number> {
  let transcript: string | null = null;
  let otel: string | null = null;
  let repo: string | null = null;
  let all = false;
  let force = false;
  let projectsDir = defaultProjectsDir();
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--transcript") transcript = args[++i] ?? null;
    else if (a === "--otel") otel = args[++i] ?? null;
    else if (a === "--repo") repo = args[++i] ?? null;
    else if (a === "--all") all = true;
    else if (a === "--force") force = true;
    else if (a === "--projects-dir") projectsDir = args[++i] ?? projectsDir;
    else {
      process.stderr.write(`waybill meter: unknown option ${a}\n`);
      return 2;
    }
  }
  if (!all && !transcript && !otel) {
    process.stderr.write("waybill meter: pass --transcript <path>, --otel <export.jsonl>, or --all\n");
    return 2;
  }

  // The pause switch: metering.enabled = false stops every metering path
  // (transcript, --all, --otel) until the user flips it back.
  if (loadConfig(home).metering.enabled === false) {
    process.stdout.write(
      json
        ? JSON.stringify({ paused: true, results: [], failures: 0 }) + "\n"
        : "metering: PAUSED (config.metering.enabled = false) — nothing metered\n",
    );
    return 0;
  }

  if (otel) {
    if (!(await acquireLockWait(home))) {
      process.stderr.write("waybill meter: another metering process is running; try again shortly\n");
      return 1;
    }
    try {
      const out = meterOtel({
        raw: readFileSync(otel, "utf8"),
        config: loadConfig(home),
        ledgerEvents: readEvents<LedgerEntry | PinEntry>(home, "ledger"),
        existingUsage: readEvents<UsageEvent>(home, "usage"),
        existingSessions: readEvents<SessionEvent>(home, "sessions"),
        existingExceptions: readEvents<ExceptionEvent>(home, "exceptions"),
      });
      appendEvents(home, "usage", out.newUsage);
      appendEvents(home, "sessions", out.newSessions);
      if (json) {
        process.stdout.write(
          JSON.stringify(
            {
              usage: out.newUsage.length,
              sessions: out.newSessions.length,
              skipped_transcript_sessions: out.skipped_transcript_sessions,
            },
            null,
            2,
          ) + "\n",
        );
      } else {
        process.stdout.write(
          `otel: +${out.newUsage.length} usage event(s) across ${out.newSessions.length} session(s)` +
            (out.skipped_transcript_sessions.length > 0
              ? ` (${out.skipped_transcript_sessions.length} session(s) skipped — transcript is the source of truth)`
              : "") +
            "\n",
        );
      }
      return 0;
    } finally {
      releaseLock(home);
    }
  }

  // Same lock as the miner: two writers computing the same events would
  // append duplicate ids.
  if (!(await acquireLockWait(home))) {
    process.stderr.write("waybill meter: another metering process is running; try again shortly\n");
    return 1;
  }

  const results: MeterRunResult[] = [];
  let failures = 0;
  try {
    if (all) {
      // listTranscripts already includes subagent transcripts (E-02); one
      // shared context spares re-reading the four streams per file (E-10).
      const ctx = loadMeterContext(home);
      for (const p of listTranscripts(projectsDir)) {
        try {
          results.push(meterFile(home, p, repo, force, ctx));
        } catch (err) {
          failures += 1;
          process.stderr.write(`waybill meter: ${p}: ${(err as Error).message}\n`);
        }
      }
    } else {
      // A named transcript brings its sibling subagent transcripts along.
      try {
        results.push(
          ...meterFileWithSubagents(home, transcript!, repo, force, (p, err) => {
            failures += 1;
            process.stderr.write(`waybill meter: ${p}: ${err.message}\n`);
          }),
        );
      } catch (err) {
        failures += 1;
        process.stderr.write(`waybill meter: ${transcript!}: ${(err as Error).message}\n`);
      }
    }
  } finally {
    releaseLock(home);
  }

  const metered = results.filter((r) => !r.skipped);
  const usage = metered.reduce((n, r) => n + r.usage, 0);
  const exceptions = metered.reduce((n, r) => n + r.exceptions, 0);
  if (json) {
    process.stdout.write(JSON.stringify({ results, failures }, null, 2) + "\n");
  } else {
    process.stdout.write(
      `metered ${metered.length} session(s) (${results.length - metered.length} already current` +
        (failures > 0 ? `, ${failures} failed` : "") +
        `): +${usage} usage event(s), +${exceptions} exception(s)\n`,
    );
  }
  return failures > 0 ? 1 : 0;
}
