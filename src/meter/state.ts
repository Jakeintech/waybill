import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RULES_VERSION } from "../attribution/resolver.ts";

export interface SessionCheckpoint {
  transcript_path: string;
  file_bytes: number;
  last_message_id: string | null;
  transcript_version: string | null;
  metered_through_ts: string | null;
}

export interface MeterState {
  schema_version: number;
  rules_version: string;
  pricing_version: string | null;
  sessions: Record<string, SessionCheckpoint>;
}

export function statePath(home: string): string {
  return join(home, "meter_state.json");
}

export function loadState(home: string): MeterState {
  const p = statePath(home);
  if (!existsSync(p)) {
    return { schema_version: 2, rules_version: RULES_VERSION, pricing_version: null, sessions: {} };
  }
  return JSON.parse(readFileSync(p, "utf8")) as MeterState;
}

export function saveState(home: string, state: MeterState): void {
  writeFileSync(statePath(home), JSON.stringify(state, null, 2) + "\n", "utf8");
}

/** Fast-path: nothing to do when versions and file size are unchanged. */
export function isCurrent(
  state: MeterState,
  sessionId: string,
  fileBytes: number,
  pricingVersion: string | null,
): boolean {
  if (state.rules_version !== RULES_VERSION) return false;
  if (state.pricing_version !== pricingVersion) return false;
  const cp = state.sessions[sessionId];
  return cp !== undefined && cp.file_bytes === fileBytes;
}
