import { deterministicUlid } from "./ulid.ts";

export const SCHEMA_VERSION = 2;

export type StreamName = "ledger" | "usage" | "sessions" | "exceptions";

/** The kinds each stream accepts — the single source for validation. */
export const STREAM_KINDS: Record<StreamName, ReadonlySet<string>> = {
  ledger: new Set(["opened", "progress", "shipped", "correction", "pin"]),
  usage: new Set(["usage", "correction"]),
  sessions: new Set(["session", "correction"]),
  exceptions: new Set(["ambiguity", "resolution", "meter_discrepancy", "meter_gap"]),
};

export interface Envelope {
  id: string;
  ts: string;
  kind: string;
  schema_version: number;
  supersedes: string | null;
}

export type WorkType =
  | "feature" | "bug" | "refactor" | "review"
  | "incident" | "docs" | "research" | "other";

export type ClaudeRole =
  | "wrote" | "co_wrote" | "assisted" | "reviewed" | "researched" | "none";

export interface Estimate {
  low: number;
  high: number;
  logged_at: string;
  pre_registered: boolean;
}

export interface Escrow {
  algo: "sha256";
  payload: "estimate.v1";
  sha256: string;
}

export interface Artifacts {
  prs: string[];
  commits: string[];
  deploy: string | null;
  docs: string[];
}

export interface TimeSaved {
  low: number;
  high: number;
  confidence: "high" | "medium" | "low";
  basis: "pre_registered" | "baseline" | "judgment";
}

export interface LedgerEntry extends Envelope {
  kind: "opened" | "progress" | "shipped" | "correction";
  title: string;
  tracker_key: string | null;
  epic_key: string | null;
  epic_name: string | null;
  sprint: string | null;
  repo: string | null;
  work_type: WorkType;
  points: number | null;
  artifacts: Artifacts;
  estimate_without_claude_hours: Estimate | null;
  escrow: Escrow | null;
  actual_hours: number | null;
  claude_role: ClaudeRole;
  sessions: Array<{ session_id: string; transcript_path: string }>;
  tokens: { input: number; output: number } | null;
  budget_tokens: number | null;
  time_saved_hours: TimeSaved | null;
  notes: string | null;
  /** Set by sync when the tracker reopened an item after it shipped. */
  reopened?: boolean;
}

export interface PinEntry extends Envelope {
  kind: "pin";
  session_id: string;
  account: string;
  tracker_key: string | null;
  range: { from: string; to: string | null } | null;
  notes: string | null;
}

export type LedgerEvent = LedgerEntry | PinEntry;

export interface TokenCounts {
  input: number;
  output: number;
  cache_read: number;
  cache_creation: number;
}

export interface UsageTokens extends TokenCounts {
  cache_creation_5m: number;
  cache_creation_1h: number;
}

export interface Attribution {
  account: string;
  tracker_key: string | null;
  resolver: "pin" | "active_entry" | "transcript_evidence" | "session_branch" | "repo_default" | "none";
  confidence: number;
  rules_version: string;
}

export interface UsageEvent extends Envelope {
  kind: "usage";
  session_id: string;
  turn: {
    index: number;
    first_message_id: string;
    last_message_id: string;
    prompt_id: string | null;
  };
  repo: string | null;
  model: string;
  tokens: UsageTokens;
  cost_usd: { value: number; pricing_version: string } | null;
  attribution: Attribution;
  source: "transcript" | "otel";
  transcript_version: string | null;
  raw_extra: Record<string, unknown> | null;
  /** Turn-level waste diagnostics (counts only, D11); carried on the
   * turn's first model event, null elsewhere. Absent on pre-1.0 events. */
  waste?: { retried_commands: number; repeated_reads: number } | null;
  /** The turn ran the waybill CLI itself — the plugin's own keep,
   * itemized so spend can prove the near-zero-overhead claim. Present
   * (true) only on overhead turns; absent elsewhere and on pre-1.6
   * events. */
  overhead?: boolean;
}

export interface SessionEvent extends Envelope {
  kind: "session";
  session_id: string;
  transcript_path: string;
  transcript_version: string | null;
  cwd: string | null;
  repo: string | null;
  branches: string[];
  models: string[];
  first_ts: string;
  last_ts: string;
  turns: number;
  messages: number;
  totals: TokenCounts;
  source: "transcript" | "otel";
}

export interface AmbiguityEvent extends Envelope {
  kind: "ambiguity";
  session_id: string;
  turn: { index: number; first_message_id: string };
  rule: string;
  candidates: string[];
  status: "open";
}

export interface ResolutionEvent extends Envelope {
  kind: "resolution";
  resolves: string;
  account: string;
  durable: null | { type: "pin" } | { type: "repo_default"; repo: string };
}

export interface MeterDiscrepancyEvent extends Envelope {
  kind: "meter_discrepancy";
  session_id: string;
  expected: TokenCounts;
  observed: TokenCounts;
  detail: string;
}

export interface MeterGapEvent extends Envelope {
  kind: "meter_gap";
  session_id: string;
  reason: "transcript_pruned" | "unreadable";
}

export type ExceptionEvent =
  | AmbiguityEvent | ResolutionEvent | MeterDiscrepancyEvent | MeterGapEvent;

/**
 * Assign the deterministic id. `body` must be the complete event minus `id`,
 * with fields in schema order (serialization preserves insertion order).
 */
export function finalizeEvent<T extends Omit<Envelope, "id">>(
  stream: StreamName,
  body: T,
): T & { id: string } {
  const id = deterministicUlid(body.ts, stream, body);
  return { id, ...body };
}

export function serializeEvent(event: Envelope): string {
  return JSON.stringify(event);
}
