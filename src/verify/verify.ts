import type {
  Envelope,
  ExceptionEvent,
  LedgerEntry,
  MeterGapEvent,
  SessionEvent,
  StreamName,
  TokenCounts,
  UsageEvent,
} from "../core/events.ts";
import { STREAM_KINDS } from "../core/events.ts";
import { isIsoTimestamp } from "../core/time.ts";
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
    | "pre_registration"
    | "meter_gap"
    | "multi_repo";
  stream: StreamName | null;
  shard: string | null;
  id: string | null;
  message: string;
  /** Absent = an integrity failure (verify exits nonzero, packs refuse to
   * build). "warning" = disclosed but never fatal: the ledger's promises
   * hold, and something is still worth telling the reader. */
  severity?: "warning";
}

export function splitFindings(findings: Finding[]): { errors: Finding[]; warnings: Finding[] } {
  return {
    errors: findings.filter((f) => f.severity !== "warning"),
    warnings: findings.filter((f) => f.severity === "warning"),
  };
}

const STREAMS: StreamName[] = ["ledger", "usage", "sessions", "exceptions"];

/** How long a pre-registered estimate may sit between its claimed
 * logged_at and its actual write before verify discloses the lag —
 * generous enough for a machine that was off over a weekend. */
export const PRE_REGISTRATION_LAG_MS = 48 * 3600_000;

// ISO shape required, not just parseability (core/time): shardFor and
// window filtering depend on the YYYY-MM prefix, so a merely parseable ts
// ("8/20/2026") is corruption to report, not a value to crash on.
const isIsoUtc = isIsoTimestamp;

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
      lines = readStream(home, stream, (shard, lineNo) => {
        findings.push({
          check: "envelope", stream, shard, id: null,
          message: `${stream}/${shard}.jsonl:${lineNo}: unparseable line (torn write?)`,
        });
      });
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
    const supersededBy = new Map<string, string>();
    for (const e of events) {
      if (e.supersedes === null) continue;
      if (!ids.has(e.supersedes)) {
        findings.push({
          check: "supersedes", stream, shard: shardFor(e.ts), id: e.id,
          message: `supersedes ${e.supersedes}, which does not exist in stream "${stream}"`,
        });
      }
      // Forked supersession: two successors over one target would both
      // count as authoritative — double-counting hidden behind green.
      const prior = supersededBy.get(e.supersedes);
      if (prior !== undefined) {
        findings.push({
          check: "supersedes", stream, shard: shardFor(e.ts), id: e.id,
          message: `supersedes ${e.supersedes}, already superseded by ${prior} — forked chain`,
        });
      } else {
        supersededBy.set(e.supersedes, e.id);
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
    if (est && est.pre_registered && Number.isNaN(Date.parse(est.logged_at))) {
      findings.push({
        check: "pre_registration", stream: "ledger", shard: shardFor(e.ts), id: e.id,
        message: `pre_registered estimate has no parseable logged_at (${String(est.logged_at)})`,
      });
    } else if (est && est.pre_registered && Date.parse(est.logged_at) > Date.parse(e.ts)) {
      findings.push({
        check: "pre_registration", stream: "ledger", shard: shardFor(e.ts), id: e.id,
        message: `pre_registered estimate logged_at ${est.logged_at} is after entry ts ${e.ts}`,
      });
    }
    // Write-time lag (E-01): the escrow seal proves the entry hasn't been
    // edited since a copy was shared, not when it was written. appended_at
    // is the wall-clock witness; an estimate claiming a logged_at far
    // before its actual write is disclosed as a warning — never a failure,
    // because backfilled facts entries (sync) legitimately carry old ts
    // and no appended_at at all.
    if (
      est && est.pre_registered && typeof e.appended_at === "string" &&
      !Number.isNaN(Date.parse(est.logged_at)) && !Number.isNaN(Date.parse(e.appended_at)) &&
      Date.parse(e.appended_at) - Date.parse(est.logged_at) > PRE_REGISTRATION_LAG_MS
    ) {
      findings.push({
        check: "pre_registration", stream: "ledger", shard: shardFor(e.ts), id: e.id,
        severity: "warning",
        message:
          `pre_registered estimate logged_at ${est.logged_at} predates its write ` +
          `(appended_at ${e.appended_at}) by more than ${PRE_REGISTRATION_LAG_MS / 3600_000}h — ` +
          "the seal proves no edits since sharing, not when the estimate was written",
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
    const t = receipt.totals;
    const any = t.input > 0 || t.output > 0 || t.cache_read > 0 || t.cache_creation > 0;
    if (!observed.has(sessionId) && any) {
      findings.push({
        check: "conservation", stream: "sessions", shard: null, id: receipt.id,
        message: `session ${sessionId}: receipt has totals but no usage events`,
      });
    }
  }

  // Multi-repo sessions (E-14): a transcript that ran in several working
  // directories books ALL its spend to the first one's repo — a correct
  // per-turn split does not exist yet, so the booking is disclosed rather
  // than silently wrong.
  for (const s of sessions) {
    if (s.cwds !== undefined && s.cwds.length > 1) {
      findings.push({
        check: "multi_repo", stream: "sessions", shard: shardFor(s.ts), id: s.id,
        severity: "warning",
        message:
          `session ${s.session_id}: ran in ${s.cwds.length} working directories ` +
          `(${s.cwds.join(", ")}) — all spend is attributed via the first; ` +
          "per-turn split attribution is not yet supported",
      });
    }
  }

  // Meter gaps (E-11): sessions whose transcripts were pruned or unreadable
  // before metering have no usage events at all — conservation cannot see
  // them, so green would silently stand for "minus whatever is missing".
  // Disclosed as warnings: the ledger's promises hold, and the reader is
  // told what the totals do not contain.
  const gaps = authoritative((byStream.get("exceptions") ?? []) as ExceptionEvent[]).filter(
    (e): e is MeterGapEvent => e.kind === "meter_gap",
  );
  for (const g of [...gaps].sort((a, b) => (a.session_id < b.session_id ? -1 : 1))) {
    findings.push({
      check: "meter_gap", stream: "exceptions", shard: shardFor(g.ts), id: g.id,
      severity: "warning",
      message:
        `session ${g.session_id}: transcript ` +
        (g.reason === "transcript_pruned" ? "was pruned before metering" : "was unreadable") +
        " — its usage is missing from every total",
    });
  }

  return findings;
}

export function isEmptyHome(home: string): boolean {
  return STREAMS.every((s) => readStream(home, s).length === 0);
}

export function renderFindings(findings: Finding[], home: string): string {
  const { errors, warnings } = splitFindings(findings);
  const lines: string[] = [];
  lines.push(`waybill verify: ${home}`);
  if (errors.length === 0) {
    if (isEmptyHome(home)) {
      lines.push("Empty ledger — no streams to check yet. (Wrong --home? This is not a failure.)");
      return lines.join("\n");
    }
    lines.push("All checks passed. Every escrow seal recomputes; every metered token is accounted for.");
  } else {
    lines.push(`${errors.length} finding(s):`);
    for (const f of errors) {
      lines.push(`  [${f.check}] ${f.message}`);
    }
  }
  if (warnings.length > 0) {
    lines.push(`${warnings.length} warning(s) — disclosed, not failures:`);
    for (const f of warnings) {
      lines.push(`  [${f.check}] ${f.message}`);
    }
  }
  return lines.join("\n");
}
