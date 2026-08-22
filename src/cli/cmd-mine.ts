import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../core/config.ts";
import { finalizeEvent, SCHEMA_VERSION, type ExceptionEvent, type MeterGapEvent } from "../core/events.ts";
import { appendEvents, readEvents } from "../core/streams.ts";
import { acquireLock, releaseLock } from "../meter/lock.ts";
import { defaultProjectsDir, listTranscripts, meterFile } from "../meter/run.ts";
import { refreshDashboardIfPresent } from "./cmd-dashboard.ts";

interface Capture {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  git_branch?: string;
  repo?: string;
  captured_at?: string;
  mined?: boolean | string;
  [k: string]: unknown;
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

/** Stamp gaps with the capture time, not the wall clock: replays stay byte-identical. */
function gapTs(capture: Capture): string {
  const captured = capture.captured_at;
  if (typeof captured === "string") {
    const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(captured);
    if (m) return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
    if (!Number.isNaN(Date.parse(captured))) return captured;
  }
  return "1970-01-01T00:00:00Z";
}

function recordGap(home: string, sessionId: string, ts: string, reason: MeterGapEvent["reason"]): void {
  const existing = readEvents<ExceptionEvent>(home, "exceptions");
  const already = existing.some(
    (e) => e.kind === "meter_gap" && (e as MeterGapEvent).session_id === sessionId,
  );
  if (already) return;
  const body = {
    ts,
    kind: "meter_gap" as const,
    schema_version: SCHEMA_VERSION,
    supersedes: null,
    session_id: sessionId,
    reason,
  };
  appendEvents(home, "exceptions", [finalizeEvent("exceptions", body)]);
}

export function runMine(home: string, args: string[], json: boolean): number {
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

  // The pause switch (metering.enabled = false): nothing metered, queue
  // untouched, exit 0 — the hook path stays silent and cheap.
  if (loadConfig(home).metering.enabled === false) {
    process.stdout.write(
      json
        ? JSON.stringify({ paused: true, mined_new: 0, remetered: 0, gaps: 0, already_current: 0 }) + "\n"
        : "metering: PAUSED (config.metering.enabled = false) — nothing metered\n",
    );
    return 0;
  }

  const queueDir = join(home, "pending-sessions");
  mkdirSync(queueDir, { recursive: true });
  if (!acquireLock(home)) {
    // Another metering process is live; the queue survives untouched.
    process.stdout.write(
      json
        ? JSON.stringify({ locked: true, mined_new: 0, remetered: 0, gaps: 0, already_current: 0 }) + "\n"
        : "mined: 0 new (another metering process is running — queue intact)\n",
    );
    return 0;
  }

  let minedNew = 0;
  let remetered = 0;
  let gaps = 0;
  let alreadyCurrent = 0;
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
          recordGap(home, capture.session_id, gapTs(capture), "transcript_pruned");
        }
        gaps += 1;
        capture.mined = "gap";
        writeFileSync(path, JSON.stringify(capture) + "\n", "utf8");
        continue;
      }
      try {
        const result = meterFile(home, transcript, typeof capture.repo === "string" ? capture.repo : null);
        capture.mined = true;
        capture["mined_session_id"] = result.session_id;
        capture["mined_usage_events"] = result.usage;
        writeFileSync(path, JSON.stringify(capture) + "\n", "utf8");
        if (result.skipped) alreadyCurrent += 1;
        else if (result.remetered) remetered += 1;
        else minedNew += 1;
      } catch (err) {
        process.stderr.write(`waybill mine: ${transcript}: ${(err as Error).message}\n`);
      }
    }

    if (all) {
      for (const t of listTranscripts(projectsDir)) {
        try {
          const r = meterFile(home, t, null);
          if (r.skipped) alreadyCurrent += 1;
          else if (r.remetered) remetered += 1;
          else minedNew += 1;
        } catch (err) {
          process.stderr.write(`waybill mine: ${t}: ${(err as Error).message}\n`);
        }
      }
    }
  } finally {
    releaseLock(home);
  }

  if (minedNew + remetered > 0) {
    commitLedger(home);
    // Keep the zero-token dashboard current — best-effort, opted into by
    // its first generation, never able to disturb metering.
    refreshDashboardIfPresent(home);
  }
  if (json) {
    process.stdout.write(
      JSON.stringify({
        mined_new: minedNew,
        remetered,
        gaps,
        already_current: alreadyCurrent,
      }) + "\n",
    );
    return 0;
  }
  // One reconciling line: what happened to every session this run touched.
  process.stdout.write(
    `mined: ${minedNew} new · ${remetered} re-metered (inputs changed) · ` +
      `${gaps} gap(s) · ${alreadyCurrent} already current\n`,
  );
  return 0;
}
