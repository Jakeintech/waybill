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

function safeNano(v: string | number | undefined): bigint {
  try {
    return BigInt(v ?? 0);
  } catch {
    return 0n; // malformed timestamp: keep the point, ignore its time
  }
}

/**
 * Parse OTLP-JSON lines and aggregate token.usage points per session/model,
 * temporality-aware: DELTA (1) series sum; CUMULATIVE (2 — what Claude
 * Code's counters export, and the OTLP default assumption here when the
 * field is absent) series take the latest point per
 * (session, model, type), so re-emitted growing snapshots are never
 * double-counted.
 */
export function parseOtelExport(raw: string): Map<string, SessionAgg> {
  const sessions = new Map<string, SessionAgg>();
  // For cumulative series: latest (value, nano) per session|model|type.
  const cumulative = new Map<string, { value: number; nano: bigint }>();
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
          sum?: { dataPoints?: OtelDataPoint[]; aggregationTemporality?: number };
        }>) {
          if (metric.name !== "claude_code.token.usage") continue;
          const isDelta = metric.sum?.aggregationTemporality === 1;
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
            const nano = safeNano(point.timeUnixNano);
            if (isDelta) {
              tokens[TYPE_MAP[type]!] += count;
            } else {
              const key = `${sessionId}|${model}|${type}`;
              const prior = cumulative.get(key);
              if (!prior || nano >= prior.nano) {
                cumulative.set(key, { value: count, nano });
                tokens[TYPE_MAP[type]!] = count;
              }
            }
            agg.models.set(model, tokens);
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
  // A growing collector file re-ingests naturally: prior otel events for the
  // same grain must be superseded, never left to double-count.
  const priorOtelUsage = new Map<string, UsageEvent>();
  for (const u of authoritative(input.existingUsage)) {
    if (u.kind === "usage" && u.source === "otel") {
      priorOtelUsage.set(`${u.session_id}|${u.model}`, u);
    }
  }
  const priorOtelReceipts = new Map<string, SessionEvent>();
  for (const s of authoritative(input.existingSessions)) {
    if (s.kind === "session" && s.source === "otel") priorOtelReceipts.set(s.session_id, s);
  }
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
      projectKeys: input.config.tracker.project_keys,
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
        cwdAtStart: null,
        firstMessageId: null,
        lastMessageId: null,
        models: [],
        overhead: false,
        waste: { retried_commands: 0, repeated_reads: 0 },
      };
      const { attribution } = resolveTurn(syntheticTurn, ctx);
      const body = {
        ts,
        kind: "usage" as const,
        schema_version: SCHEMA_VERSION,
        supersedes: null as string | null,
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
      const prior = priorOtelUsage.get(`${sessionId}|${model}`);
      if (prior) {
        const asPrior = finalizeEvent("usage", { ...body, supersedes: prior.supersedes }) as unknown as UsageEvent;
        if (asPrior.id === prior.id) continue; // unchanged since last ingest
        const event = finalizeEvent("usage", { ...body, supersedes: prior.id }) as unknown as UsageEvent;
        if (!existingIds.has(event.id)) newUsage.push(event);
      } else {
        const event = finalizeEvent("usage", body) as unknown as UsageEvent;
        if (!existingIds.has(event.id)) newUsage.push(event);
      }
    }

    const receiptBody = {
      ts,
      kind: "session" as const,
      schema_version: SCHEMA_VERSION,
      supersedes: null as string | null,
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
    const priorReceipt = priorOtelReceipts.get(sessionId);
    if (priorReceipt) {
      const asPrior = finalizeEvent("sessions", {
        ...receiptBody,
        supersedes: priorReceipt.supersedes,
      }) as unknown as SessionEvent;
      if (asPrior.id !== priorReceipt.id) {
        const receipt = finalizeEvent("sessions", {
          ...receiptBody,
          supersedes: priorReceipt.id,
        }) as unknown as SessionEvent;
        if (!existingIds.has(receipt.id)) newSessions.push(receipt);
      }
    } else {
      const receipt = finalizeEvent("sessions", receiptBody) as unknown as SessionEvent;
      if (!existingIds.has(receipt.id)) newSessions.push(receipt);
    }
  }

  return { newUsage, newSessions, skipped_transcript_sessions: skipped };
}
