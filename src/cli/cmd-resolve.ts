import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { loadConfig, saveConfig } from "../core/config.ts";
import {
  finalizeEvent,
  SCHEMA_VERSION,
  type AmbiguityEvent,
  type ExceptionEvent,
  type LedgerEvent,
  type PinEntry,
  type ResolutionEvent,
  type SessionEvent,
} from "../core/events.ts";
import { appendEvents, authoritative, readEvents } from "../core/streams.ts";
import { countOpenAmbiguities } from "../projections/queries.ts";
import { acquireLock, releaseLock } from "../meter/lock.ts";
import { meterFile } from "../meter/run.ts";
import { loadState } from "../meter/state.ts";

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function commitLedger(home: string, message: string): void {
  try {
    execFileSync("git", ["-C", home, "add", "-A"], { stdio: ["ignore", "ignore", "ignore"], timeout: 15000 });
    execFileSync("git", ["-C", home, "commit", "-m", message], {
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 15000,
    });
  } catch {
    // nothing to commit / contention — the next writer picks it up
  }
}

/**
 * Close an attribution-inbox item: append a resolution event, optionally make
 * it durable (a pin or a repo default), then force-re-meter the session so
 * corrected usage events supersede the old attribution. Append-only
 * throughout; history is preserved.
 */
export function runResolve(home: string, args: string[], json: boolean): number {
  let ambiguityId: string | null = null;
  let account: string | null = null;
  let durablePin = false;
  let repoDefault: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--ambiguity") ambiguityId = args[++i] ?? null;
    else if (a === "--account") account = args[++i] ?? null;
    else if (a === "--pin") durablePin = true;
    else if (a === "--repo-default") repoDefault = args[++i] ?? null;
    else {
      process.stderr.write(`waybill resolve: unknown option ${a}\n`);
      return 2;
    }
  }
  if (!ambiguityId || !account) {
    process.stderr.write(
      "waybill resolve: pass --ambiguity <id> and --account <story:KEY | adhoc:label | unattributed>\n" +
        "  optional: --pin (durable session pin) or --repo-default <org/name>\n",
    );
    return 2;
  }
  if (durablePin && repoDefault) {
    process.stderr.write(
      "waybill resolve: --pin and --repo-default are different durable choices — pass one, not both\n",
    );
    return 2;
  }
  if (!/^(story:.+|adhoc:.+|unattributed)$/.test(account)) {
    process.stderr.write("waybill resolve: account must be story:<KEY>, adhoc:<label>, or unattributed\n");
    return 2;
  }

  const exceptions = readEvents<ExceptionEvent>(home, "exceptions");
  const ambiguity = exceptions.find(
    (e): e is AmbiguityEvent => e.kind === "ambiguity" && e.id === ambiguityId,
  );
  if (!ambiguity) {
    process.stderr.write(`waybill resolve: no ambiguity with id ${ambiguityId}\n`);
    return 1;
  }
  const alreadyResolved = exceptions.some(
    (e) => e.kind === "resolution" && (e as ResolutionEvent).resolves === ambiguityId,
  );
  if (alreadyResolved) {
    process.stderr.write(`waybill resolve: ${ambiguityId} is already resolved\n`);
    return 1;
  }

  const ts = nowIso();
  const durable: ResolutionEvent["durable"] = durablePin
    ? { type: "pin" }
    : repoDefault
      ? { type: "repo_default", repo: repoDefault }
      : null;
  const resolution = finalizeEvent("exceptions", {
    ts,
    kind: "resolution" as const,
    schema_version: SCHEMA_VERSION,
    supersedes: null,
    resolves: ambiguityId,
    account,
    durable,
  }) as ResolutionEvent;
  appendEvents(home, "exceptions", [resolution]);

  if (durablePin) {
    // A session has one whole-session pin: a later pin supersedes any
    // earlier one instead of siring conflicting siblings that would
    // degrade every turn to weaker resolver rules on the next re-meter.
    const priorPins = authoritative(readEvents<LedgerEvent>(home, "ledger"))
      .filter(
        (e): e is PinEntry =>
          e.kind === "pin" && e.session_id === ambiguity.session_id && e.range === null,
      )
      .sort((a, b) => (a.ts < b.ts ? -1 : 1));
    const pinBody = {
      ts,
      kind: "pin" as const,
      schema_version: SCHEMA_VERSION,
      supersedes: null as string | null,
      session_id: ambiguity.session_id,
      account,
      tracker_key: account.startsWith("story:") ? account.slice(6) : null,
      range: null,
      notes: `resolve: from inbox item ${ambiguityId}`,
    };
    const pins =
      priorPins.length === 0
        ? [finalizeEvent("ledger", pinBody)]
        : priorPins.map((prior) => finalizeEvent("ledger", { ...pinBody, supersedes: prior.id }));
    appendEvents(home, "ledger", pins);
  }
  if (repoDefault) {
    const config = loadConfig(home);
    config.metering.repo_defaults[repoDefault] = account;
    saveConfig(home, config);
  }

  // Re-meter the session under the new attribution inputs — the resolution
  // itself is a resolver input (rule 0), so this applies durable and
  // one-tap resolutions alike. Force: the transcript hasn't grown.
  // The pause switch holds here too: while metering is disabled nothing is
  // recorded, so the re-meter waits for re-enable (the stale fingerprint
  // then applies the resolution automatically).
  let remetered = false;
  let corrected = 0;
  if (loadConfig(home).metering.enabled === false) {
    process.stderr.write(
      "waybill resolve: metering is paused — the resolution is recorded and applies " +
        "automatically when metering is re-enabled and the session is next metered\n",
    );
    commitLedger(home, `resolve: inbox item filed to ${account}`);
    const openNow = countOpenAmbiguities(readEvents<ExceptionEvent>(home, "exceptions"));
    if (json) {
      process.stdout.write(
        JSON.stringify({ resolved: ambiguityId, account, durable, remetered: false, corrected_events: 0, inbox_open: openNow, paused: true }) + "\n",
      );
    } else {
      process.stdout.write(`filed to ${account} (metering paused — applies on re-enable); ${openNow} left in the inbox\n`);
    }
    return 0;
  }
  const checkpoint = loadState(home).sessions[ambiguity.session_id];
  const transcriptPath =
    checkpoint?.transcript_path ??
    authoritative(readEvents<SessionEvent>(home, "sessions"))
      .find((s) => s.kind === "session" && s.session_id === ambiguity.session_id)?.transcript_path ??
    null;
  if (transcriptPath && existsSync(transcriptPath)) {
    if (acquireLock(home)) {
      try {
        const result = meterFile(home, transcriptPath, null, true);
        remetered = true;
        corrected = result.usage;
      } finally {
        releaseLock(home);
      }
    } else {
      process.stderr.write(
        "waybill resolve: a miner is running — the resolution is recorded and will apply " +
          "the next time this session is metered (run `waybill meter --all` shortly, or it " +
          "applies automatically when the transcript next grows)\n",
      );
    }
  } else {
    process.stderr.write(
      "waybill resolve: transcript no longer on disk — the resolution is recorded, " +
        "but existing usage events keep their original attribution (visible in their resolver field)\n",
    );
  }

  commitLedger(home, `resolve: inbox item filed to ${account}`);

  const inboxOpen = countOpenAmbiguities(readEvents<ExceptionEvent>(home, "exceptions"));
  if (json) {
    process.stdout.write(
      JSON.stringify({ resolved: ambiguityId, account, durable, remetered, corrected_events: corrected, inbox_open: inboxOpen }) + "\n",
    );
  } else {
    const durableNote = durablePin ? " (pinned)" : repoDefault ? ` (repo default for ${repoDefault})` : "";
    process.stdout.write(
      `filed to ${account}${durableNote}` +
        (remetered ? `; ${corrected} usage event(s) corrected` : "") +
        `; ${inboxOpen} left in the inbox\n`,
    );
  }
  return 0;
}
