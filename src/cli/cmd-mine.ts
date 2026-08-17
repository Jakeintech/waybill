import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { finalizeEvent, SCHEMA_VERSION, type ExceptionEvent, type MeterGapEvent } from "../core/events.ts";
import { appendEvents, readEvents } from "../core/streams.ts";
import { defaultProjectsDir, listTranscripts, meterFile } from "../meter/run.ts";

interface Capture {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  git_branch?: string;
  repo?: string;
  mined?: boolean | string;
  [k: string]: unknown;
}

function lockPath(home: string): string {
  return join(home, "pending-sessions", ".miner.lock");
}

function acquireLock(home: string): boolean {
  const p = lockPath(home);
  if (existsSync(p)) {
    try {
      const pid = Number(readFileSync(p, "utf8").trim());
      if (Number.isInteger(pid) && pid > 0) {
        process.kill(pid, 0); // throws if the process is gone
        return false; // a live miner holds the lock
      }
    } catch {
      // stale lock — take over
    }
  }
  writeFileSync(p, String(process.pid), "utf8");
  return true;
}

function releaseLock(home: string): void {
  try {
    unlinkSync(lockPath(home));
  } catch {
    // already gone
  }
}

function commitLedger(home: string): void {
  try {
    execFileSync("git", ["-C", home, "add", "-A"], { stdio: ["ignore", "ignore", "ignore"], timeout: 15000 });
    execFileSync("git", ["-C", home, "commit", "-m", "meter: mined pending sessions"], {
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 15000,
    });
  } catch {
    // lock contention or nothing to commit — the next writer picks it up
  }
}

function recordGap(home: string, sessionId: string, reason: MeterGapEvent["reason"]): void {
  const existing = readEvents<ExceptionEvent>(home, "exceptions");
  const body = {
    ts: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    kind: "meter_gap" as const,
    schema_version: SCHEMA_VERSION,
    supersedes: null,
    session_id: sessionId,
    reason,
  };
  // Deterministic dedupe on (session, reason) regardless of wall-clock ts:
  const already = existing.some(
    (e) => e.kind === "meter_gap" && (e as MeterGapEvent).session_id === sessionId,
  );
  if (!already) appendEvents(home, "exceptions", [finalizeEvent("exceptions", body)]);
}

export function runMine(home: string, args: string[]): number {
  let all = false;
  let projectsDir = defaultProjectsDir();
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--queue") all = false;
    else if (a === "--all") all = true;
    else if (a === "--projects-dir") projectsDir = args[++i] ?? projectsDir;
    else {
      process.stderr.write(`waybill mine: unknown option ${a}\n`);
      return 2;
    }
  }

  const queueDir = join(home, "pending-sessions");
  if (!existsSync(queueDir)) return 0;
  if (!acquireLock(home)) return 0; // another miner is live; the queue survives

  let mined = 0;
  try {
    const files = readdirSync(queueDir)
      .filter((f) => f.endsWith(".json"))
      .sort();
    for (const f of files) {
      const path = join(queueDir, f);
      let capture: Capture;
      try {
        capture = JSON.parse(readFileSync(path, "utf8")) as Capture;
      } catch {
        continue; // unreadable capture: leave it for inspection, never delete
      }
      if (capture.mined === true || typeof capture.mined === "string") continue;
      const transcript = capture.transcript_path;
      if (typeof transcript !== "string" || !existsSync(transcript)) {
        if (typeof capture.session_id === "string") {
          recordGap(home, capture.session_id, "transcript_pruned");
        }
        capture.mined = "gap";
        writeFileSync(path, JSON.stringify(capture) + "\n", "utf8");
        continue;
      }
      try {
        const result = meterFile(home, transcript, typeof capture.repo === "string" ? capture.repo : null);
        capture.mined = true;
        capture["mined_session_id"] = result.sessionId;
        capture["mined_usage_events"] = result.usage;
        writeFileSync(path, JSON.stringify(capture) + "\n", "utf8");
        mined += 1;
      } catch (err) {
        process.stderr.write(`waybill mine: ${transcript}: ${(err as Error).message}\n`);
      }
    }

    if (all) {
      for (const t of listTranscripts(projectsDir)) {
        try {
          const r = meterFile(home, t, null);
          if (!r.skipped) mined += 1;
        } catch (err) {
          process.stderr.write(`waybill mine: ${t}: ${(err as Error).message}\n`);
        }
      }
    }
  } finally {
    releaseLock(home);
  }

  if (mined > 0) commitLedger(home);
  process.stdout.write(`mined ${mined} session(s)\n`);
  return 0;
}

/** Test hook: remove a home's lock (used by unit tests only). */
export function _clearLock(home: string): void {
  rmSync(lockPath(home), { force: true });
}
