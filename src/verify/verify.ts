import type {
  Envelope,
  LedgerEntry,
  SessionEvent,
  StreamName,
  TokenCounts,
  UsageEvent,
} from "../core/events.ts";
import { canonicalJson } from "../core/canonical.ts";
import { checkEscrow } from "../core/escrow.ts";
import { authoritative, readStream, shardFor } from "../core/streams.ts";
import { deterministicUlid, isUlid } from "../core/ulid.ts";

export interface Finding {
  check:
    | "envelope"
    | "shard_placement"
    | "id_unique"
    | "id_deterministic"
    | "supersedes"
    | "escrow"
    | "conservation"
    | "pre_registration";
  stream: StreamName | null;
  shard: string | null;
  id: string | null;
  message: string;
}

const STREAM_KINDS: Record<StreamName, Set<string>> = {
  ledger: new Set(["opened", "progress", "shipped", "correction", "pin"]),
  usage: new Set(["usage", "correction"]),
  sessions: new Set(["session", "correction"]),
  exceptions: new Set(["ambiguity", "resolution", "meter_discrepancy", "meter_gap"]),
};

const STREAMS: StreamName[] = ["ledger", "usage", "sessions", "exceptions"];

function isIsoUtc(ts: unknown): boolean {
  return typeof ts === "string" && !Number.isNaN(Date.parse(ts));
}

export function zeroTotals(): TokenCounts {
  return { input: 0, output: 0, cache_read: 0, cache_creation: 0 };
}

export function addTotals(into: TokenCounts, add: TokenCounts): void {
  into.input += add.input;
  into.output += add.output;
  into.cache_read += add.cache_read;
  into.cache_creation += add.cache_creation;
}

export function totalsEqual(a: TokenCounts, b: TokenCounts): boolean {
  return (
    a.input === b.input &&
    a.output === b.output &&
    a.cache_read === b.cache_read &&
    a.cache_creation === b.cache_creation
  );
}

export function verifyHome(home: string): Finding[] {
  const findings: Finding[] = [];
  const seenIds = new Map<string, string>();
  const byStream = new Map<StreamName, Envelope[]>();

  for (const stream of STREAMS) {
    let lines;
    try {
      lines = readStream(home, stream);
    } catch (err) {
      findings.push({
        check: "envelope", stream, shard: null, id: null,
        message: `stream unreadable: ${(err as Error).message}`,
      });
      continue;
    }
    const events: Envelope[] = [];
    for (const { event, shard, lineNo } of lines) {
      const where = `${stream}/${shard}.jsonl:${lineNo}`;
      if (
        typeof event !== "object" || event === null ||
        typeof event.id !== "string" || !isIsoUtc(event.ts) ||
        typeof event.kind !== "string" || typeof event.schema_version !== "number" ||
        (event.supersedes !== null && typeof event.supersedes !== "string")
      ) {
        findings.push({ check: "envelope", stream, shard, id: null, message: `${where}: invalid envelope` });
        continue;
      }
      if (!STREAM_KINDS[stream].has(event.kind)) {
        findings.push({
          check: "envelope", stream, shard, id: event.id,
          message: `${where}: kind "${event.kind}" not valid for stream "${stream}"`,
        });
      }
      if (!isUlid(event.id)) {
        findings.push({ check: "envelope", stream, shard, id: event.id, message: `${where}: id is not a ULID` });
      } else {
        const { id: _id, ...content } = event as Record<string, unknown> & Envelope;
        const expected = deterministicUlid(event.ts, stream, content);
        if (expected !== event.id) {
          findings.push({
            check: "id_deterministic", stream, shard, id: event.id,
            message: `${where}: id does not recompute from content (expected ${expected})`,
          });
        }
      }
      if (shardFor(event.ts) !== shard) {
        findings.push({
          check: "shard_placement", stream, shard, id: event.id,
          message: `${where}: ts ${event.ts} belongs in shard ${shardFor(event.ts)}`,
        });
      }
      const prior = seenIds.get(event.id);
      if (prior !== undefined) {
        findings.push({
          check: "id_unique", stream, shard, id: event.id,
          message: `${where}: id already seen at ${prior}`,
        });
      } else {
        seenIds.set(event.id, where);
      }
      events.push(event);
    }
    byStream.set(stream, events);
  }

  for (const stream of STREAMS) {
    const events = byStream.get(stream) ?? [];
    const ids = new Set(events.map((e) => e.id));
    for (const e of events) {
      if (e.supersedes !== null && !ids.has(e.supersedes)) {
        findings.push({
          check: "supersedes", stream, shard: shardFor(e.ts), id: e.id,
          message: `supersedes ${e.supersedes}, which does not exist in stream "${stream}"`,
        });
      }
    }
  }

  for (const raw of byStream.get("ledger") ?? []) {
    if (raw.kind === "pin") continue;
    const e = raw as LedgerEntry;
    if (e.escrow) {
      const result = checkEscrow(e);
      if (result.status === "mismatch") {
        findings.push({
          check: "escrow", stream: "ledger", shard: shardFor(e.ts), id: e.id,
          message: `escrow hash does not recompute (expected ${result.expected}, found ${result.found})`,
        });
      }
    }
    const est = e.estimate_without_claude_hours;
    if (est && est.pre_registered && Date.parse(est.logged_at) > Date.parse(e.ts)) {
      findings.push({
        check: "pre_registration", stream: "ledger", shard: shardFor(e.ts), id: e.id,
        message: `pre_registered estimate logged_at ${est.logged_at} is after entry ts ${e.ts}`,
      });
    }
  }

  const usage = authoritative((byStream.get("usage") ?? []) as UsageEvent[]).filter(
    (e) => e.kind === "usage",
  );
  const sessions = authoritative((byStream.get("sessions") ?? []) as SessionEvent[]).filter(
    (e) => e.kind === "session",
  );
  const receipts = new Map<string, SessionEvent>();
  for (const s of sessions) receipts.set(s.session_id, s);

  const observed = new Map<string, TokenCounts>();
  for (const u of usage) {
    const t = observed.get(u.session_id) ?? zeroTotals();
    addTotals(t, u.tokens);
    observed.set(u.session_id, t);
  }
  for (const [sessionId, sums] of [...observed.entries()].sort()) {
    const receipt = receipts.get(sessionId);
    if (!receipt) {
      findings.push({
        check: "conservation", stream: "usage", shard: null, id: null,
        message: `session ${sessionId}: usage events exist but no session receipt`,
      });
      continue;
    }
    if (!totalsEqual(sums, receipt.totals)) {
      findings.push({
        check: "conservation", stream: "sessions", shard: null, id: receipt.id,
        message:
          `session ${sessionId}: Σ usage ${canonicalJson(sums)} ≠ receipt totals ` +
          canonicalJson(receipt.totals),
      });
    }
  }
  for (const [sessionId, receipt] of [...receipts.entries()].sort()) {
    if (!observed.has(sessionId) && (receipt.totals.input > 0 || receipt.totals.output > 0)) {
      findings.push({
        check: "conservation", stream: "sessions", shard: null, id: receipt.id,
        message: `session ${sessionId}: receipt has totals but no usage events`,
      });
    }
  }

  return findings;
}

export function renderFindings(findings: Finding[], home: string): string {
  const lines: string[] = [];
  if (findings.length === 0) {
    lines.push(`waybill verify: ${home}`);
    lines.push("All checks passed. Every escrow seal recomputes; every metered token is accounted for.");
    return lines.join("\n");
  }
  lines.push(`waybill verify: ${home}`);
  lines.push(`${findings.length} finding(s):`);
  for (const f of findings) {
    lines.push(`  [${f.check}] ${f.message}`);
  }
  return lines.join("\n");
}
