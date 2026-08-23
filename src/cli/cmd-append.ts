import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { canonicalJson } from "../core/canonical.ts";
import { finalizeEvent, SCHEMA_VERSION, STREAM_KINDS, type Envelope, type LedgerEntry, type StreamName } from "../core/events.ts";
import { sealEstimate } from "../core/escrow.ts";
import { appendEvents, readEvents } from "../core/streams.ts";

const STREAMS: StreamName[] = ["ledger", "usage", "sessions", "exceptions"];

/**
 * The write path for skills: takes an event body (no id), validates it,
 * seals escrow on pre-registered estimates, assigns the deterministic ULID,
 * appends to the right shard, and optionally commits. Skills never
 * hand-append JSONL — hand-built ids would fail `waybill verify`.
 */
/** Wall-clock skew tolerated on a pre-registered estimate's logged_at
 * before append refuses it as future-dated (E-01). */
export const APPEND_CLOCK_SKEW_MS = 5 * 60 * 1000;

export function runAppend(home: string, args: string[], json: boolean): number {
  let stream: StreamName | null = null;
  let bodyJson: string | null = null;
  let commit = false;
  let nowIso: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--stream") {
      const s = args[++i];
      if (!s || !STREAMS.includes(s as StreamName)) {
        process.stderr.write(`waybill append: --stream must be one of ${STREAMS.join(", ")}\n`);
        return 2;
      }
      stream = s as StreamName;
    } else if (a === "--event") bodyJson = args[++i] ?? null;
    else if (a === "--stdin") bodyJson = readFileSync(0, "utf8");
    else if (a === "--commit") commit = true;
    else if (a === "--now") nowIso = args[++i] ?? null;
    else {
      process.stderr.write(`waybill append: unknown option ${a}\n`);
      return 2;
    }
  }
  if (!stream || !bodyJson) {
    process.stderr.write("waybill append: pass --stream <name> and --event '<json>' (or --stdin)\n");
    return 2;
  }
  if (nowIso !== null && Number.isNaN(Date.parse(nowIso))) {
    process.stderr.write("waybill append: --now must be an ISO timestamp\n");
    return 2;
  }
  const nowMs = nowIso !== null ? Date.parse(nowIso) : Date.now();

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(bodyJson) as Record<string, unknown>;
  } catch (err) {
    process.stderr.write(`waybill append: event is not valid JSON: ${(err as Error).message}\n`);
    return 2;
  }
  if ("id" in body) {
    process.stderr.write("waybill append: do not supply an id — ids are derived from content\n");
    return 2;
  }
  if ("appended_at" in body) {
    process.stderr.write("waybill append: do not supply appended_at — the write path stamps it\n");
    return 2;
  }
  if (typeof body["ts"] !== "string" || Number.isNaN(Date.parse(body["ts"] as string))) {
    process.stderr.write("waybill append: event needs an ISO 8601 ts\n");
    return 2;
  }
  if (typeof body["kind"] !== "string" || !STREAM_KINDS[stream].has(body["kind"])) {
    process.stderr.write(
      `waybill append: kind must be one of ${[...STREAM_KINDS[stream]].join(", ")} for stream "${stream}"\n`,
    );
    return 2;
  }
  body["schema_version"] = SCHEMA_VERSION;
  if (!("supersedes" in body)) body["supersedes"] = null;
  if (body["supersedes"] !== null) {
    const target = body["supersedes"];
    const exists = readEvents(home, stream).some((e) => e.id === target);
    if (!exists) {
      process.stderr.write(`waybill append: supersedes target ${String(target)} not found in ${stream}\n`);
      return 1;
    }
  }

  // Seal pre-registered estimates at write time (D13).
  if (stream === "ledger" && body["kind"] === "opened") {
    const est = body["estimate_without_claude_hours"] as LedgerEntry["estimate_without_claude_hours"];
    if (est && est.pre_registered === true && !body["escrow"]) {
      if (typeof est.low !== "number" || typeof est.high !== "number") {
        process.stderr.write("waybill append: estimate needs numeric low/high\n");
        return 2;
      }
      if (!est.logged_at) est.logged_at = body["ts"] as string;
      const keyOrTitle = (body["tracker_key"] as string | null) ?? (body["title"] as string);
      body["escrow"] = sealEstimate(keyOrTitle, est);
    }
    // A pre-registered claim needs a real logged_at: Date.parse(undefined)
    // is NaN and NaN > x is false, which would wave through a timestamp-less
    // estimate arriving with an externally built escrow.
    if (est && est.pre_registered === true && Number.isNaN(Date.parse(est.logged_at))) {
      process.stderr.write("waybill append: a pre_registered estimate needs an ISO logged_at\n");
      return 1;
    }
    if (est && est.pre_registered === true && Date.parse(est.logged_at) > Date.parse(body["ts"] as string)) {
      process.stderr.write("waybill append: refusing a pre_registered estimate logged after the entry ts\n");
      return 1;
    }
    // E-01: the escrow seal proves no edits since sharing, not when the
    // estimate was written — so write-time ordering is enforced here, at
    // the only moment a wall clock is available. A logged_at ahead of the
    // clock beyond a small skew is a forged pre-registration, not data.
    if (est && est.pre_registered === true && Date.parse(est.logged_at) > nowMs + APPEND_CLOCK_SKEW_MS) {
      process.stderr.write(
        "waybill append: refusing a pre_registered estimate with a future logged_at " +
          `(${est.logged_at} is ahead of the wall clock by more than ${APPEND_CLOCK_SKEW_MS / 60000} minutes)\n`,
      );
      return 2;
    }
  }

  // Idempotency by logical content: the appended_at stamp (below) differs
  // per write, so the duplicate check compares everything except it — a
  // retried append of the same entry must stay a no-op, reporting the
  // event already on disk.
  const contentKey = (e: Record<string, unknown>): string => {
    const { id: _id, appended_at: _at, ...rest } = e;
    return canonicalJson(rest);
  };
  const bodyKey = contentKey(body);
  const existing = readEvents(home, stream).find(
    (e) => contentKey(e as unknown as Record<string, unknown>) === bodyKey,
  );
  if (existing) {
    if (json) process.stdout.write(JSON.stringify({ id: existing.id, appended: false, reason: "duplicate" }) + "\n");
    else process.stdout.write(`already present: ${existing.id}\n`);
    return 0;
  }
  // Wall-clock witness (E-01, additive 2.1): ledger entries record when
  // they were actually written, so verify can disclose a pre-registered
  // estimate whose logged_at long predates its write. Engine-derived
  // streams (usage/sessions/exceptions) stay replay-deterministic.
  if (stream === "ledger") body["appended_at"] = new Date(nowMs).toISOString();
  const event = finalizeEvent(stream, body as Record<string, unknown> & Omit<Envelope, "id">);
  appendEvents(home, stream, [event]);

  if (commit) {
    try {
      execFileSync("git", ["-C", home, "add", "-A"], { stdio: ["ignore", "ignore", "ignore"], timeout: 15000 });
      execFileSync("git", ["-C", home, "commit", "-m", `ledger: ${String(body["kind"])} appended`], {
        stdio: ["ignore", "ignore", "ignore"],
        timeout: 15000,
      });
    } catch {
      // nothing to commit / lock contention — next writer picks it up
    }
  }

  if (json) process.stdout.write(JSON.stringify({ id: event.id, appended: true }) + "\n");
  else process.stdout.write(`appended ${event.id} to ${stream}\n`);
  return 0;
}
