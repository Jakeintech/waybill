import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  finalizeEvent,
  SCHEMA_VERSION,
  type LedgerEntry,
  type SessionEvent,
  type TokenCounts,
  type UsageEvent,
} from "../../src/core/events.ts";
import { RULES_VERSION } from "../../src/attribution/resolver.ts";
import { sealEstimate } from "../../src/core/escrow.ts";
import { appendEvents } from "../../src/core/streams.ts";

export function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "waybill-fixture-"));
}

export function makeOpened(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  const ts = overrides.ts ?? "2026-08-10T09:12:00Z";
  const estimate = overrides.estimate_without_claude_hours ?? {
    low: 10, high: 16, logged_at: ts, pre_registered: true,
  };
  const trackerKey = "tracker_key" in overrides ? overrides.tracker_key ?? null : "PLAT-482";
  const title = overrides.title ?? "Retry logic for checkout webhook";
  const body = {
    ts,
    kind: "opened" as const,
    schema_version: SCHEMA_VERSION,
    supersedes: overrides.supersedes ?? null,
    title,
    tracker_key: trackerKey,
    epic_key: overrides.epic_key ?? null,
    epic_name: overrides.epic_name ?? null,
    sprint: overrides.sprint ?? null,
    repo: overrides.repo ?? "acme/platform",
    work_type: overrides.work_type ?? ("feature" as const),
    points: overrides.points ?? 5,
    artifacts: overrides.artifacts ?? { prs: [], commits: [], deploy: null, docs: [] },
    estimate_without_claude_hours: estimate,
    escrow: "escrow" in overrides ? overrides.escrow ?? null : sealEstimate(trackerKey ?? title, estimate),
    actual_hours: overrides.actual_hours ?? null,
    claude_role: overrides.claude_role ?? ("none" as const),
    sessions: overrides.sessions ?? [],
    tokens: overrides.tokens ?? null,
    budget_tokens: overrides.budget_tokens ?? null,
    time_saved_hours: overrides.time_saved_hours ?? null,
    notes: overrides.notes ?? null,
  };
  return finalizeEvent("ledger", body) as LedgerEntry;
}

export function makeUsage(overrides: {
  ts?: string;
  session_id?: string;
  turnIndex?: number;
  model?: string;
  tokens?: Partial<TokenCounts & { cache_creation_5m: number; cache_creation_1h: number }>;
  account?: string;
  resolver?: UsageEvent["attribution"]["resolver"];
  confidence?: number;
  repo?: string | null;
} = {}): UsageEvent {
  const ts = overrides.ts ?? "2026-08-17T10:15:03Z";
  const t = overrides.tokens ?? {};
  const account = overrides.account ?? "story:PLAT-482";
  const body = {
    ts,
    kind: "usage" as const,
    schema_version: SCHEMA_VERSION,
    supersedes: null,
    session_id: overrides.session_id ?? "9f4c1e2a-77aa-4b02-9d31-5c2f8ab9d001",
    turn: {
      index: overrides.turnIndex ?? 1,
      first_message_id: `msg_first_${overrides.turnIndex ?? 1}`,
      last_message_id: `msg_last_${overrides.turnIndex ?? 1}`,
      prompt_id: null,
    },
    repo: overrides.repo !== undefined ? overrides.repo : "acme/platform",
    model: overrides.model ?? "claude-opus-4-6",
    tokens: {
      input: t.input ?? 1000,
      output: t.output ?? 200,
      cache_read: t.cache_read ?? 5000,
      cache_creation: t.cache_creation ?? 300,
      cache_creation_5m: t.cache_creation_5m ?? 300,
      cache_creation_1h: t.cache_creation_1h ?? 0,
    },
    cost_usd: null,
    attribution: {
      account,
      tracker_key: account.startsWith("story:") ? account.slice("story:".length) : null,
      resolver: overrides.resolver ?? ("active_entry" as const),
      confidence: overrides.confidence ?? 0.9,
      rules_version: RULES_VERSION,
    },
    source: "transcript" as const,
    transcript_version: "2.1.229",
    raw_extra: null,
  };
  return finalizeEvent("usage", body) as UsageEvent;
}

export function makeSessionReceipt(
  usageEvents: UsageEvent[],
  overrides: Partial<SessionEvent> = {},
): SessionEvent {
  const sessionId = overrides.session_id ?? usageEvents[0]?.session_id ?? "9f4c1e2a-77aa-4b02-9d31-5c2f8ab9d001";
  const totals = { input: 0, output: 0, cache_read: 0, cache_creation: 0 };
  for (const u of usageEvents) {
    totals.input += u.tokens.input;
    totals.output += u.tokens.output;
    totals.cache_read += u.tokens.cache_read;
    totals.cache_creation += u.tokens.cache_creation;
  }
  const ts = overrides.ts ?? usageEvents[usageEvents.length - 1]?.ts ?? "2026-08-17T10:15:03Z";
  const body = {
    ts,
    kind: "session" as const,
    schema_version: SCHEMA_VERSION,
    supersedes: overrides.supersedes ?? null,
    session_id: sessionId,
    transcript_path: overrides.transcript_path ?? `~/.claude/projects/acme-platform/${sessionId}.jsonl`,
    transcript_version: overrides.transcript_version ?? "2.1.229",
    cwd: overrides.cwd ?? "/home/user/acme/platform",
    repo: overrides.repo ?? "acme/platform",
    branches: overrides.branches ?? ["feat/PLAT-482-retry"],
    models: overrides.models ?? ["claude-opus-4-6"],
    first_ts: overrides.first_ts ?? usageEvents[0]?.ts ?? ts,
    last_ts: overrides.last_ts ?? ts,
    turns: overrides.turns ?? usageEvents.length,
    messages: overrides.messages ?? usageEvents.length,
    totals: overrides.totals ?? totals,
    source: "transcript" as const,
  };
  return finalizeEvent("sessions", body) as SessionEvent;
}

export function writeValidHome(home: string): {
  opened: LedgerEntry;
  usage: UsageEvent[];
  receipt: SessionEvent;
} {
  const opened = makeOpened();
  const usage = [
    makeUsage({ turnIndex: 1, ts: "2026-08-17T10:15:03Z" }),
    makeUsage({ turnIndex: 2, ts: "2026-08-17T10:22:41Z", tokens: { input: 900, output: 4400 } }),
  ];
  const receipt = makeSessionReceipt(usage);
  appendEvents(home, "ledger", [opened]);
  appendEvents(home, "usage", usage);
  appendEvents(home, "sessions", [receipt]);
  return { opened, usage, receipt };
}
