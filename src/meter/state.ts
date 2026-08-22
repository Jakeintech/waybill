import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RULES_VERSION } from "../attribution/resolver.ts";
import { METER_LOGIC_VERSION } from "./meter.ts";

export interface SessionCheckpoint {
  transcript_path: string;
  file_bytes: number;
  last_message_id: string | null;
  transcript_version: string | null;
  metered_through_ts: string | null;
  /** Versions this session was last metered under — compared per session,
   * so a version bump re-meters every stale session, not just the first. */
  rules_version: string;
  meter_version: string;
  /** Digest of the whole pricing table at meter time: a rate added or
   * changed under an unchanged version string (pricing set without
   * --version) still invalidates the fast path and re-prices. */
  pricing_digest: string;
  pricing_version: string | null;
  /** Fingerprint of the attribution inputs (pins, open entries, repo
   * defaults, inbox resolutions) at meter time. Pinning or resolving after
   * a session ends changes the fingerprint, which invalidates the fast path
   * — the re-meter then emits superseding corrected events. */
  attribution_inputs: string | null;
}

export interface MeterState {
  schema_version: number;
  sessions: Record<string, SessionCheckpoint>;
}

export function statePath(home: string): string {
  return join(home, "meter_state.json");
}

export function loadState(home: string): MeterState {
  const p = statePath(home);
  if (!existsSync(p)) {
    return { schema_version: 2, sessions: {} };
  }
  // The state file is only a cache: a torn or corrupt write (crash,
  // ENOSPC) must never stall metering forever. Unreadable state = empty
  // state = one clean re-meter, which is safe by design.
  type RawState = MeterState & { rules_version?: string; pricing_version?: string | null };
  let raw: RawState;
  try {
    raw = JSON.parse(readFileSync(p, "utf8")) as RawState;
  } catch {
    return { schema_version: 2, sessions: {} };
  }
  // Migrate pre-0.4 state (global version markers): drop the globals and
  // leave sessions without per-session versions — isCurrent treats those
  // checkpoints as stale, forcing one clean re-meter. Events are
  // content-addressed, so the re-meter is a no-op where nothing changed.
  const sessions: Record<string, SessionCheckpoint> = {};
  for (const [id, cp] of Object.entries(raw.sessions ?? {})) {
    const legacy = cp as Partial<SessionCheckpoint>;
    sessions[id] = {
      transcript_path: legacy.transcript_path ?? "",
      file_bytes: legacy.file_bytes ?? -1,
      last_message_id: legacy.last_message_id ?? null,
      transcript_version: legacy.transcript_version ?? null,
      metered_through_ts: legacy.metered_through_ts ?? null,
      rules_version: legacy.rules_version ?? "",
      // Absent on pre-1.5 checkpoints: stale, forcing one clean re-meter
      // (which re-prices dated model ids under the resolution rules).
      meter_version: legacy.meter_version ?? "",
      pricing_digest: legacy.pricing_digest ?? "",
      pricing_version: legacy.pricing_version ?? null,
      attribution_inputs: legacy.attribution_inputs ?? null,
    };
  }
  return { schema_version: 2, sessions };
}

export function saveState(home: string, state: MeterState): void {
  // Atomic replace: a crash mid-write must never leave torn JSON behind.
  const p = statePath(home);
  writeFileSync(`${p}.tmp`, JSON.stringify(state, null, 2) + "\n", "utf8");
  renameSync(`${p}.tmp`, p);
}

/** Fast-path: nothing to do when size, versions, pricing content, and
 * attribution inputs are all unchanged. */
export function isCurrent(
  state: MeterState,
  sessionId: string,
  fileBytes: number,
  pricingDigest: string,
  attributionInputs: string,
): boolean {
  // Own-property check: session ids come from untrusted transcript lines.
  const cp = Object.hasOwn(state.sessions, sessionId) ? state.sessions[sessionId] : undefined;
  if (cp === undefined) return false;
  return (
    cp.file_bytes === fileBytes &&
    cp.rules_version === RULES_VERSION &&
    cp.meter_version === METER_LOGIC_VERSION &&
    cp.pricing_digest === pricingDigest &&
    cp.attribution_inputs === attributionInputs
  );
}
