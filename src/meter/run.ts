import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../core/config.ts";
import type { ExceptionEvent, LedgerEntry, PinEntry, SessionEvent, UsageEvent } from "../core/events.ts";
import { appendEvents, readEvents } from "../core/streams.ts";
import { meterTranscript } from "./meter.ts";
import { parseTranscript } from "./transcript.ts";
import { isCurrent, loadState, saveState } from "./state.ts";

export interface MeterRunResult {
  sessionId: string | null;
  transcriptPath: string;
  skipped: boolean;
  usage: number;
  sessions: number;
  exceptions: number;
}

/** Derive an org/name repo identity from a working directory's git remote. Local command, no network. */
export function repoFromCwd(cwd: string | null): string | null {
  if (!cwd || !existsSync(cwd)) return null;
  try {
    const url = execFileSync("git", ["-C", cwd, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
    const m = /[:/]([^/:]+\/[^/:]+?)(?:\.git)?$/.exec(url);
    return m ? m[1]! : null;
  } catch {
    return null;
  }
}

export function defaultProjectsDir(): string {
  return join(homedir(), ".claude", "projects");
}

export function listTranscripts(projectsDir: string): string[] {
  if (!existsSync(projectsDir)) return [];
  const out: string[] = [];
  for (const proj of readdirSync(projectsDir).sort()) {
    const dir = join(projectsDir, proj);
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of entries.sort()) {
      if (f.endsWith(".jsonl")) out.push(join(dir, f));
    }
  }
  return out;
}

/** Meter one transcript into the home's streams. Deterministic given inputs; idempotent by event id. */
export function meterFile(
  home: string,
  transcriptPath: string,
  repoHint: string | null,
): MeterRunResult {
  const config = loadConfig(home);
  const state = loadState(home);
  const raw = readFileSync(transcriptPath, "utf8");
  const fileBytes = statSync(transcriptPath).size;

  // Cheap identity probe for the fast path (full parse only when stale).
  const probe = parseTranscript(raw, { branchKeyPattern: config.metering.branch_key_pattern });
  const sessionId = probe.sessionId;
  if (sessionId !== null && isCurrent(state, sessionId, fileBytes, config.pricing.version)) {
    return { sessionId, transcriptPath, skipped: true, usage: 0, sessions: 0, exceptions: 0 };
  }

  const repo = repoHint ?? repoFromCwd(probe.cwd);
  const ledgerEvents = readEvents<LedgerEntry | PinEntry>(home, "ledger");
  const existingUsage = readEvents<UsageEvent>(home, "usage");
  const existingSessions = readEvents<SessionEvent>(home, "sessions");
  const existingExceptions = readEvents<ExceptionEvent>(home, "exceptions");

  const out = meterTranscript({
    transcriptPath,
    raw,
    repo,
    config,
    ledgerEvents,
    existingUsage,
    existingSessions,
    existingExceptions,
  });

  appendEvents(home, "usage", out.newUsage);
  appendEvents(home, "sessions", out.newSessions);
  appendEvents(home, "exceptions", out.newExceptions);

  if (out.sessionId !== null) {
    const lastTurn = out.transcript.turns[out.transcript.turns.length - 1];
    state.rules_version = "1";
    state.pricing_version = config.pricing.version;
    state.sessions[out.sessionId] = {
      transcript_path: transcriptPath,
      file_bytes: fileBytes,
      last_message_id: lastTurn?.lastMessageId ?? null,
      transcript_version: out.transcript.version,
      metered_through_ts: out.transcript.lastTs,
    };
    saveState(home, state);
  }

  return {
    sessionId: out.sessionId,
    transcriptPath,
    skipped: false,
    usage: out.newUsage.length,
    sessions: out.newSessions.length,
    exceptions: out.newExceptions.length,
  };
}
