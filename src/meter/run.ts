import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "../core/config.ts";
import { canonicalJson } from "../core/canonical.ts";
import { sha256Hex } from "../core/sha.ts";
import type {
  AmbiguityEvent,
  ExceptionEvent,
  LedgerEntry,
  PinEntry,
  ResolutionEvent,
  SessionEvent,
  UsageEvent,
} from "../core/events.ts";
import { appendEvents, authoritative, readEvents } from "../core/streams.ts";
import { RULES_VERSION } from "../attribution/resolver.ts";
import { METER_LOGIC_VERSION, meterTranscript, selectOpenEntries } from "./meter.ts";
import { parseTranscript } from "./transcript.ts";
import { isCurrent, loadState, saveState } from "./state.ts";

export interface MeterRunResult {
  session_id: string | null;
  transcript_path: string;
  skipped: boolean;
  /** This session had been metered before (checkpoint existed) — this run superseded stale events. */
  remetered: boolean;
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

/**
 * Fingerprint of everything that can change a session's attribution without
 * the transcript growing: pins, open entries, repo defaults, and applied
 * inbox resolutions. Any change invalidates the meter fast path, so pins
 * and resolutions take effect on the next mine/meter run — never silently
 * skipped.
 */
export function attributionFingerprint(
  ledgerEvents: Array<LedgerEntry | PinEntry>,
  exceptionEvents: ExceptionEvent[],
  config: Config,
): string {
  const pins = authoritative(ledgerEvents)
    .filter((e): e is PinEntry => e.kind === "pin")
    .map((p) => ({ id: p.id, session: p.session_id, account: p.account, range: p.range }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const open = selectOpenEntries(ledgerEvents)
    .map((e) => ({ key: e.tracker_key, repo: e.repo }))
    .sort((a, b) => ((a.key ?? "") < (b.key ?? "") ? -1 : 1));
  const resolutions = exceptionEvents
    .filter((e): e is ResolutionEvent => e.kind === "resolution")
    .map((r) => ({ resolves: r.resolves, account: r.account }))
    .sort((a, b) => (a.resolves < b.resolves ? -1 : 1));
  return sha256Hex(
    canonicalJson({
      rules: RULES_VERSION,
      pins,
      open,
      defaults: config.metering.repo_defaults,
      pattern: config.metering.branch_key_pattern,
      project_keys: config.tracker.project_keys,
      resolutions,
    }),
  );
}

/** Applied inbox resolutions for a session, as turn-index → account. */
export function turnOverridesFor(
  sessionId: string,
  exceptionEvents: ExceptionEvent[],
): Map<number, string> {
  const ambiguities = new Map<string, AmbiguityEvent>();
  for (const e of exceptionEvents) {
    if (e.kind === "ambiguity" && (e as AmbiguityEvent).session_id === sessionId) {
      ambiguities.set(e.id, e as AmbiguityEvent);
    }
  }
  const overrides = new Map<number, string>();
  for (const e of exceptionEvents) {
    if (e.kind !== "resolution") continue;
    const r = e as ResolutionEvent;
    const amb = ambiguities.get(r.resolves);
    if (amb) overrides.set(amb.turn.index, r.account);
  }
  return overrides;
}

/** Leading-lines sessionId probe — the fast path must not pay for a full
 * parse. Reads a handful of lines, not just the first: transcripts often
 * open with a `type:"summary"` line that carries no sessionId. */
function probeSessionId(raw: string): string | null {
  let start = 0;
  for (let i = 0; i < 8 && start < raw.length; i++) {
    const nl = raw.indexOf("\n", start);
    const line = nl === -1 ? raw.slice(start) : raw.slice(start, nl);
    start = nl === -1 ? raw.length : nl + 1;
    try {
      const parsed = JSON.parse(line) as { sessionId?: string };
      if (typeof parsed.sessionId === "string") return parsed.sessionId;
    } catch {
      // not JSON — keep probing
    }
  }
  return null;
}

/**
 * Meter one transcript into the home's streams. Deterministic given inputs;
 * idempotent by event id. Pass force=true to bypass the fast path outright.
 */
export function meterFile(
  home: string,
  transcriptPath: string,
  repoHint: string | null,
  force = false,
): MeterRunResult {
  const config = loadConfig(home);
  const state = loadState(home);
  // Stat before read: bytes appended between the two calls then read as a
  // larger size next run (stale checkpoint → re-meter) instead of being
  // checkpointed as metered without ever being parsed.
  const fileBytes = statSync(transcriptPath).size;
  const raw = readFileSync(transcriptPath, "utf8");
  const pricingDigest = sha256Hex(canonicalJson(config.pricing));

  const ledgerEvents = readEvents<LedgerEntry | PinEntry>(home, "ledger");
  const existingExceptions = readEvents<ExceptionEvent>(home, "exceptions");
  const fingerprint = attributionFingerprint(ledgerEvents, existingExceptions, config);

  // Duplicate-transcript guard: two on-disk files carrying one sessionId
  // (a copied project dir, a restored backup) must not take turns
  // superseding each other's receipts on every run. The checkpointed path
  // wins while it still exists and is at least as complete; the loser is
  // skipped, never metered.
  const duplicateOf = (sid: string): boolean => {
    const cp = Object.hasOwn(state.sessions, sid) ? state.sessions[sid] : undefined;
    if (!cp || cp.transcript_path === transcriptPath) return false;
    if (!existsSync(cp.transcript_path)) return false;
    try {
      return statSync(cp.transcript_path).size >= fileBytes;
    } catch {
      return false;
    }
  };

  const probedId = probeSessionId(raw);
  if (!force && probedId !== null) {
    if (isCurrent(state, probedId, fileBytes, pricingDigest, fingerprint) || duplicateOf(probedId)) {
      return { session_id: probedId, transcript_path: transcriptPath, skipped: true, remetered: false, usage: 0, sessions: 0, exceptions: 0 };
    }
  }

  const probe = parseTranscript(raw, {
    branchKeyPattern: config.metering.branch_key_pattern,
    projectKeys: config.tracker.project_keys,
  });
  const sessionId = probe.sessionId;
  if (!force && sessionId !== null && sessionId !== probedId) {
    if (isCurrent(state, sessionId, fileBytes, pricingDigest, fingerprint) || duplicateOf(sessionId)) {
      return { session_id: sessionId, transcript_path: transcriptPath, skipped: true, remetered: false, usage: 0, sessions: 0, exceptions: 0 };
    }
  }

  const hadCheckpoint = sessionId !== null && Object.hasOwn(state.sessions, sessionId);
  const repo = repoHint ?? repoFromCwd(probe.cwd);
  const existingUsage = readEvents<UsageEvent>(home, "usage");
  const existingSessions = readEvents<SessionEvent>(home, "sessions");

  const out = meterTranscript({
    transcriptPath,
    raw,
    repo,
    config,
    ledgerEvents,
    existingUsage,
    existingSessions,
    existingExceptions,
    turnOverrides: sessionId !== null ? turnOverridesFor(sessionId, existingExceptions) : new Map(),
  });

  appendEvents(home, "usage", out.newUsage);
  appendEvents(home, "sessions", out.newSessions);
  appendEvents(home, "exceptions", out.newExceptions);

  if (out.sessionId !== null) {
    const lastTurn = out.transcript.turns[out.transcript.turns.length - 1];
    state.sessions[out.sessionId] = {
      transcript_path: transcriptPath,
      file_bytes: fileBytes,
      last_message_id: lastTurn?.lastMessageId ?? null,
      transcript_version: out.transcript.version,
      metered_through_ts: out.transcript.lastTs,
      rules_version: RULES_VERSION,
      meter_version: METER_LOGIC_VERSION,
      pricing_digest: pricingDigest,
      pricing_version: config.pricing.version,
      attribution_inputs: fingerprint,
    };
    saveState(home, state);
  }

  return {
    session_id: out.sessionId,
    transcript_path: transcriptPath,
    skipped: false,
    remetered: hadCheckpoint,
    usage: out.newUsage.length,
    sessions: out.newSessions.length,
    exceptions: out.newExceptions.length,
  };
}
