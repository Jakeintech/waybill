import type {
  AmbiguityEvent,
  ExceptionEvent,
  LedgerEntry,
  MeterDiscrepancyEvent,
  MeterGapEvent,
  PinEntry,
  SessionEvent,
  TokenCounts,
  UsageEvent,
} from "../core/events.ts";
import { finalizeEvent, SCHEMA_VERSION, subagentSessionId } from "../core/events.ts";
import type { Config } from "../core/config.ts";
import { resolveRate } from "../core/pricing-resolve.ts";
import { authoritative } from "../core/streams.ts";
import { addTotals, totalsEqual, zeroTotals } from "../verify/verify.ts";
import { resolveTurn, type ResolverContext } from "../attribution/resolver.ts";
import { parseTranscript, type ParsedTranscript } from "./transcript.ts";

export interface MeterInput {
  transcriptPath: string;
  raw: string;
  repo: string | null;
  config: Config;
  ledgerEvents: Array<LedgerEntry | PinEntry>;
  existingUsage: UsageEvent[];
  existingSessions: SessionEvent[];
  existingExceptions: ExceptionEvent[];
  /** Applied inbox resolutions for this session (turn index → account). */
  turnOverrides?: Map<number, string>;
}

export interface MeterOutput {
  sessionId: string | null;
  transcript: ParsedTranscript;
  newUsage: UsageEvent[];
  newSessions: SessionEvent[];
  newExceptions: ExceptionEvent[];
}

/** Bumped when metering/pricing derivation logic changes shape — stored per
 * session checkpoint so an engine upgrade re-meters stale sessions once
 * (content-addressed events make that a no-op where nothing changed).
 * 3: overhead tagging (v1.6). */
export const METER_LOGIC_VERSION = "3";

export function priceTokens(
  config: Config,
  model: string,
  tokens: UsageEvent["tokens"],
): UsageEvent["cost_usd"] {
  const version = config.pricing.version;
  // Date-stamp-tolerant lookup: transcripts carry dated API ids, the table
  // may hold undated family ids (or vice versa). Never crosses families;
  // no match still means tokens_only — a rate is never guessed.
  const rates = resolveRate(config.pricing, model)?.rates;
  if (!version || !rates) return null;
  // Legacy sources without the 5m/1h split price all cache writes at the
  // 5m rate — and when a split is present but does not sum to
  // cache_creation, the unsplit remainder is priced at 5m too rather than
  // silently priced at zero (every counted token gets a priced bucket).
  const cc5m =
    tokens.cache_creation_5m === 0 && tokens.cache_creation_1h === 0
      ? tokens.cache_creation
      : Math.max(tokens.cache_creation - tokens.cache_creation_1h, 0);
  // Exact fixed-point arithmetic: rates in e4 (1/10000 USD) per mtok, so
  // token × rate products are integers and rounding is auditable — no float
  // half-case wobble. Rates with more than 4 decimals fall back to floats.
  const e4 = (r: number): number => Math.round(r * 10000);
  const exact = [
    rates.input_per_mtok, rates.output_per_mtok, rates.cache_read_per_mtok,
    rates.cache_write_5m_per_mtok, rates.cache_write_1h_per_mtok,
  ].every((r) => Math.abs(r * 10000 - e4(r)) < 1e-6);
  const terms: Array<[number, number]> = [
    [tokens.input, rates.input_per_mtok],
    [tokens.output, rates.output_per_mtok],
    [tokens.cache_read, rates.cache_read_per_mtok],
    [cc5m, rates.cache_write_5m_per_mtok],
    [tokens.cache_creation_1h, rates.cache_write_1h_per_mtok],
  ];
  let value: number;
  if (exact) {
    let e10 = 0; // token-count × rate_e4 accumulates in units of 1e-10 USD × 1e6
    for (const [n, r] of terms) e10 += n * e4(r);
    value = Math.round(e10 / 1_000_000) / 10000;
  } else {
    let raw = 0;
    for (const [n, r] of terms) raw += n * r;
    value = Math.round(raw / 100) / 10000;
  }
  return { value, pricing_version: version };
}

export function meterTranscript(input: MeterInput): MeterOutput {
  const transcript = parseTranscript(input.raw, {
    branchKeyPattern: input.config.metering.branch_key_pattern,
    projectKeys: input.config.tracker.project_keys,
  });
  // Subagent transcripts (E-02) meter under a composite session id: their
  // lines carry the parent's sessionId, and reusing it verbatim would
  // collide receipts, checkpoints, and per-(turn, model) usage grains with
  // the parent transcript's.
  const sessionId =
    transcript.sessionId !== null && transcript.agentId !== null
      ? subagentSessionId(transcript.sessionId, transcript.agentId)
      : transcript.sessionId;
  const newUsage: UsageEvent[] = [];
  const newSessions: SessionEvent[] = [];
  const newExceptions: ExceptionEvent[] = [];

  if (sessionId === null || transcript.lastTs === null) {
    // Unmeterable: no identity or no timestamps. Record the gap once, if identifiable.
    if (sessionId !== null) {
      const gapBody = {
        ts: new Date(0).toISOString().replace(/\.\d{3}Z$/, "Z"),
        kind: "meter_gap" as const,
        schema_version: SCHEMA_VERSION,
        supersedes: null,
        session_id: sessionId,
        reason: "unreadable" as const,
      };
      const gap = finalizeEvent("exceptions", gapBody) as MeterGapEvent;
      if (!input.existingExceptions.some((e) => e.id === gap.id)) newExceptions.push(gap);
    }
    return { sessionId, transcript, newUsage, newSessions, newExceptions };
  }

  const pins = authoritative(input.ledgerEvents).filter(
    (e): e is PinEntry => e.kind === "pin",
  );
  const openEntries = selectOpenEntries(input.ledgerEvents);
  const ctx: ResolverContext = {
    sessionId,
    repo: input.repo,
    branchKeyPattern: input.config.metering.branch_key_pattern,
    pins,
    openEntries,
    repoDefaults: input.config.metering.repo_defaults,
    evidence: transcript.evidence,
    projectKeys: input.config.tracker.project_keys,
    ...(input.turnOverrides ? { turnOverrides: input.turnOverrides } : {}),
  };

  const existingUsageAuth = authoritative(input.existingUsage).filter(
    (u) => u.kind === "usage" && u.session_id === sessionId,
  );
  const usageByGrain = new Map<string, UsageEvent>();
  for (const u of existingUsageAuth) {
    if (u.source === "otel") continue; // retired wholesale below — transcript wins
    usageByGrain.set(`${u.turn.index}|${u.model}`, u);
  }
  const existingIds = new Set(input.existingUsage.map((u) => u.id));

  // FR-M2: the transcript is the source of truth. If this session was
  // previously metered from OTel (transcript pruned, then restored or mined
  // late), retire every otel event with a superseding correction so nothing
  // double-counts.
  for (const stale of existingUsageAuth) {
    if (stale.source !== "otel") continue;
    const retire = finalizeEvent("usage", {
      ts: transcript.lastTs,
      kind: "correction" as const,
      schema_version: SCHEMA_VERSION,
      supersedes: stale.id,
      session_id: sessionId,
      detail: "superseded by transcript metering (transcript wins over otel)",
    }) as unknown as UsageEvent;
    if (!existingIds.has(retire.id)) newUsage.push(retire);
  }

  const emitted: TokenCounts = zeroTotals();

  for (const turn of transcript.turns) {
    const { attribution, ambiguity } = resolveTurn(turn, ctx);
    // Queue to the inbox only when the ambiguity actually stands: a
    // fall-through rule that landed at pin/active_entry/evidence strength
    // settles the turn; branch/default/none leaves it worth a human tap.
    const settled =
      attribution.resolver === "pin" ||
      attribution.resolver === "active_entry" ||
      attribution.resolver === "transcript_evidence";
    if (ambiguity && !settled) {
      const ambBody = {
        ts: turn.models[0]!.lastTs || transcript.lastTs,
        kind: "ambiguity" as const,
        schema_version: SCHEMA_VERSION,
        supersedes: null,
        session_id: sessionId,
        turn: { index: turn.index, first_message_id: turn.firstMessageId ?? "" },
        rule: ambiguity.rule,
        candidates: ambiguity.candidates,
        status: "open" as const,
      };
      const amb = finalizeEvent("exceptions", ambBody) as AmbiguityEvent;
      if (
        !input.existingExceptions.some((e) => e.id === amb.id) &&
        !newExceptions.some((e) => e.id === amb.id)
      ) {
        newExceptions.push(amb);
      }
    }
    const sortedModels = [...turn.models].sort((a, b) => (a.model < b.model ? -1 : 1));
    for (const agg of sortedModels) {
      addTotals(emitted, agg.tokens);
      const ts = agg.lastTs !== "" ? agg.lastTs : transcript.lastTs;
      const prior = usageByGrain.get(`${turn.index}|${agg.model}`);
      const extras = Object.keys(agg.extras).length > 0 ? sortRecord(agg.extras) : null;
      // Waste is turn-level; carry it once, on the turn's first model event.
      const waste =
        agg === sortedModels[0] && (turn.waste.retried_commands > 0 || turn.waste.repeated_reads > 0)
          ? turn.waste
          : null;
      const body = {
        ts,
        kind: "usage" as const,
        schema_version: SCHEMA_VERSION,
        supersedes: null as string | null,
        session_id: sessionId,
        turn: {
          index: turn.index,
          first_message_id: turn.firstMessageId ?? "",
          last_message_id: turn.lastMessageId ?? "",
          prompt_id: turn.promptId,
        },
        repo: input.repo,
        model: agg.model,
        tokens: agg.tokens,
        cost_usd: priceTokens(input.config, agg.model, agg.tokens),
        attribution,
        source: "transcript" as const,
        transcript_version: transcript.version,
        raw_extra: extras,
        waste,
        // Present only when true: non-overhead events keep their pre-1.6
        // content addresses.
        ...(turn.overhead ? { overhead: true } : {}),
      };
      // Unchanged means "same content modulo the supersedes link" — an event
      // that already supersedes an older one must not be re-superseded by an
      // identical recomputation (that would grow the chain on every forced
      // re-meter).
      if (prior) {
        const asPrior = finalizeEvent("usage", { ...body, supersedes: prior.supersedes }) as UsageEvent;
        if (asPrior.id === prior.id) continue; // unchanged
      }
      let event = finalizeEvent("usage", body) as UsageEvent;
      if (prior) {
        event = finalizeEvent("usage", { ...body, supersedes: prior.id }) as UsageEvent;
      }
      if (!existingIds.has(event.id)) newUsage.push(event);
    }
  }

  // Conservation self-check: what we emitted must equal what the source says.
  if (!totalsEqual(emitted, transcript.totals)) {
    const discBody = {
      ts: transcript.lastTs,
      kind: "meter_discrepancy" as const,
      schema_version: SCHEMA_VERSION,
      supersedes: null,
      session_id: sessionId,
      expected: transcript.totals,
      observed: emitted,
      detail: "sum of turn aggregates does not equal source usage totals",
    };
    const disc = finalizeEvent("exceptions", discBody) as MeterDiscrepancyEvent;
    if (!input.existingExceptions.some((e) => e.id === disc.id)) newExceptions.push(disc);
  }

  // Session receipt (superseding any prior receipt for this session).
  const priorReceipt = authoritative(input.existingSessions).find(
    (s) => s.kind === "session" && s.session_id === sessionId,
  );
  const receiptBody = {
    ts: transcript.lastTs,
    kind: "session" as const,
    schema_version: SCHEMA_VERSION,
    supersedes: null as string | null,
    session_id: sessionId,
    transcript_path: input.transcriptPath,
    transcript_version: transcript.version,
    cwd: transcript.cwd,
    repo: input.repo,
    branches: transcript.branches,
    models: transcript.models,
    first_ts: transcript.firstTs ?? transcript.lastTs,
    last_ts: transcript.lastTs,
    turns: transcript.turns.length,
    messages: transcript.messageCount,
    totals: transcript.totals,
    source: "transcript" as const,
  };
  if (priorReceipt) {
    const asPrior = finalizeEvent("sessions", {
      ...receiptBody,
      supersedes: priorReceipt.supersedes,
    }) as SessionEvent;
    if (asPrior.id !== priorReceipt.id) {
      newSessions.push(
        finalizeEvent("sessions", { ...receiptBody, supersedes: priorReceipt.id }) as SessionEvent,
      );
    }
  } else {
    newSessions.push(finalizeEvent("sessions", receiptBody) as SessionEvent);
  }

  return { sessionId, transcript, newUsage, newSessions, newExceptions };
}

/** Open = authoritative entries whose latest kind is `opened` or `progress`. */
export function selectOpenEntries(events: Array<LedgerEntry | PinEntry>): LedgerEntry[] {
  const entries = authoritative(events).filter(
    (e): e is LedgerEntry => e.kind === "opened" || e.kind === "progress",
  );
  // If a later shipped/correction entry shares the tracker_key without a
  // supersedes link, prefer the latest event per key.
  const latestByKey = new Map<string, LedgerEntry | PinEntry>();
  for (const e of authoritative(events)) {
    if (e.kind === "pin") continue;
    const key = (e as LedgerEntry).tracker_key;
    if (key === null) continue;
    const prior = latestByKey.get(key);
    if (!prior || e.ts > prior.ts) latestByKey.set(key, e);
  }
  return entries.filter((e) => {
    if (e.tracker_key === null) return true;
    const latest = latestByKey.get(e.tracker_key);
    return latest === undefined || latest.id === e.id;
  });
}

function sortRecord(record: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of Object.keys(record).sort()) out[k] = record[k]!;
  return out;
}
