// OpenTelemetry secondary source (FR-M2): ingest Claude Code's
// `claude_code.token.usage` metric from an OTLP-JSON export file, for
// sessions that have no transcript (pruned before mining). The transcript
// is always the source of truth where one was metered; a session never
// mixes sources.
import type { Config } from "../core/config.ts";
import type {
  ExceptionEvent,
  LedgerEntry,
  PinEntry,
  SessionEvent,
  TokenCounts,
  UsageEvent,
} from "../core/events.ts";
import { finalizeEvent, SCHEMA_VERSION } from "../core/events.ts";
import { authoritative } from "../core/streams.ts";
import { resolveTurn, type ResolverContext } from "../attribution/resolver.ts";
import { priceTokens, selectOpenEntries } from "./meter.ts";
import type { Turn } from "./transcript.ts";

interface OtelAttribute {
  key?: string;
  value?: { stringValue?: string; intValue?: string | number };
}

interface OtelDataPoint {
  attributes?: OtelAttribute[];
  asDouble?: number;
  asInt?: string | number;
  timeUnixNano?: string | number;
}

const TYPE_MAP: Record<string, keyof TokenCounts> = {
  input: "input",
  output: "output",
  cacheRead: "cache_read",
  cacheCreation: "cache_creation",
};

function attr(point: OtelDataPoint, key: string): string | null {
  for (const a of point.attributes ?? []) {
    if (a.key === key) {
      const v = a.value?.stringValue ?? a.value?.intValue;
      if (v !== undefined) return String(v);
    }
  }
  return null;
}

interface SessionAgg {
  models: Map<string, TokenCounts>;
  lastNano: bigint;
}

/** Parse OTLP-JSON lines and aggregate token.usage points per session/model. */
export function parseOtelExport(raw: string): Map<string, SessionAgg> {
  const sessions = new Map<string, SessionAgg>();
  for (const lineText of raw.split("\n")) {
    if (lineText.trim() === "") continue;
    let line: unknown;
    try {
      line = JSON.parse(lineText);
    } catch {
      continue;
    }
    const resourceMetrics = (line as { resourceMetrics?: unknown[] }).resourceMetrics ?? [];
    for (const rm of resourceMetrics as Array<{ scopeMetrics?: unknown[] }>) {
      for (const sm of (rm.scopeMetrics ?? []) as Array<{ metrics?: unknown[] }>) {
        for (const metric of (sm.metrics ?? []) as Array<{
          name?: string;
          sum?: { dataPoints?: OtelDataPoint[] };
        }>) {
          if (metric.name !== "claude_code.token.usage") continue;
          for (const point of metric.sum?.dataPoints ?? []) {
            const sessionId = attr(point, "session.id");
            const model = attr(point, "model") ?? "unknown";
            const type = attr(point, "type");
            if (!sessionId || !type || !(type in TYPE_MAP)) continue;
            const count = Math.trunc(Number(point.asDouble ?? point.asInt ?? 0));
            if (!Number.isFinite(count) || count <= 0) continue;
            const agg = sessions.get(sessionId) ?? { models: new Map(), lastNano: 0n };
            const tokens =
              agg.models.get(model) ?? { input: 0, output: 0, cache_read: 0, cache_creation: 0 };
            tokens[TYPE_MAP[type]!] += count;
            agg.models.set(model, tokens);
            const nano = BigInt(point.timeUnixNano ?? 0);
            if (nano > agg.lastNano) agg.lastNano = nano;
            sessions.set(sessionId, agg);
          }
        }
      }
    }
  }
  return sessions;
}

function nanoToIso(nano: bigint): string {
  const ms = Number(nano / 1_000_000n);
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export interface OtelMeterInput {
  raw: string;
  config: Config;
  ledgerEvents: Array<LedgerEntry | PinEntry>;
  existingUsage: UsageEvent[];
  existingSessions: SessionEvent[];
  existingExceptions: ExceptionEvent[];
}

export interface OtelMeterOutput {
  newUsage: UsageEvent[];
  newSessions: SessionEvent[];
  skipped_transcript_sessions: string[];
}

export function meterOtel(input: OtelMeterInput): OtelMeterOutput {
  const parsed = parseOtelExport(input.raw);
  const newUsage: UsageEvent[] = [];
  const newSessions: SessionEvent[] = [];
  const skipped: string[] = [];

  const transcriptSessions = new Set(
    authoritative(input.existingSessions)
      .filter((s) => s.kind === "session" && s.source === "transcript")
      .map((s) => s.session_id),
  );
  const existingIds = new Set([
    ...input.existingUsage.map((e) => e.id),
    ...input.existingSessions.map((e) => e.id),
  ]);
  const pins = authoritative(input.ledgerEvents).filter((e): e is PinEntry => e.kind === "pin");
  const openEntries = selectOpenEntries(input.ledgerEvents);

  for (const [sessionId, agg] of [...parsed.entries()].sort()) {
    if (transcriptSessions.has(sessionId)) {
      skipped.push(sessionId); // transcript wins; never mix sources
      continue;
    }
    const ts = agg.lastNano > 0n ? nanoToIso(agg.lastNano) : "1970-01-01T00:00:00Z";
    const totals: TokenCounts = { input: 0, output: 0, cache_read: 0, cache_creation: 0 };
    const models = [...agg.models.keys()].sort();

    const ctx: ResolverContext = {
      sessionId,
      repo: null,
      branchKeyPattern: input.config.metering.branch_key_pattern,
      pins,
      openEntries,
      repoDefaults: input.config.metering.repo_defaults,
      evidence: [],
    };

    for (const model of models) {
      const t = agg.models.get(model)!;
      totals.input += t.input;
      totals.output += t.output;
      totals.cache_read += t.cache_read;
      totals.cache_creation += t.cache_creation;
      const syntheticTurn: Turn = {
        index: 0,
        promptId: null,
        branchAtStart: null,
        firstMessageId: null,
        lastMessageId: null,
        models: [],
      };
      const { attribution } = resolveTurn(syntheticTurn, ctx);
      const body = {
        ts,
        kind: "usage" as const,
        schema_version: SCHEMA_VERSION,
        supersedes: null,
        session_id: sessionId,
        turn: { index: 0, first_message_id: "", last_message_id: "", prompt_id: null },
        repo: null,
        model,
        tokens: {
          ...t,
          cache_creation_5m: 0,
          cache_creation_1h: 0,
        },
        cost_usd: priceTokens(input.config, model, {
          ...t,
          cache_creation_5m: 0,
          cache_creation_1h: 0,
        }),
        attribution,
        source: "otel" as const,
        transcript_version: null,
        raw_extra: null,
      };
      const event = finalizeEvent("usage", body) as unknown as UsageEvent;
      if (!existingIds.has(event.id)) newUsage.push(event);
    }

    const receiptBody = {
      ts,
      kind: "session" as const,
      schema_version: SCHEMA_VERSION,
      supersedes: null,
      session_id: sessionId,
      transcript_path: "",
      transcript_version: null,
      cwd: null,
      repo: null,
      branches: [],
      models,
      first_ts: ts,
      last_ts: ts,
      turns: 1,
      messages: 0,
      totals,
      source: "otel" as const,
    };
    const receipt = finalizeEvent("sessions", receiptBody) as unknown as SessionEvent;
    if (!existingIds.has(receipt.id)) newSessions.push(receipt);
  }

  return { newUsage, newSessions, skipped_transcript_sessions: skipped };
}
