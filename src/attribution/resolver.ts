import type { Attribution, LedgerEntry, PinEntry } from "../core/events.ts";
import { rootSessionId } from "../core/events.ts";
import { isPlausibleTrackerKey } from "../core/keys.ts";
import type { EvidenceKey, Turn } from "../meter/transcript.ts";

export const RULES_VERSION = "2"; // v2: key-plausibility gating (stoplist + project_keys)

export interface ResolverContext {
  sessionId: string;
  repo: string | null;
  branchKeyPattern: string;
  /** Pins for this session (authoritative, latest wins per range). */
  pins: PinEntry[];
  /** Authoritative `opened` (not yet shipped) ledger entries. */
  openEntries: LedgerEntry[];
  /** config.metering.repo_defaults */
  repoDefaults: Record<string, string | null>;
  /** All evidence keys found in the session, in encounter order. */
  evidence: EvidenceKey[];
  /**
   * Inbox resolutions applied to specific turns of this session
   * (turn index → account). A user assertion: outranks every rule,
   * confidence 1.0, and survives any future re-meter.
   */
  turnOverrides?: Map<number, string>;
  /** config.tracker.project_keys — gates branch-key matches (core/keys). */
  projectKeys?: string[];
}

export interface Resolution {
  attribution: Attribution;
  /** When a rule matched several candidates, they land here (rule falls through). */
  ambiguity: { rule: string; candidates: string[] } | null;
}

function keyFromBranch(branch: string | null, pattern: string): string | null {
  if (!branch) return null;
  const m = branch.match(new RegExp(pattern));
  return m ? m[0] : null;
}

function attribution(
  account: string,
  resolver: Attribution["resolver"],
  confidence: number,
): Attribution {
  return {
    account,
    tracker_key: account.startsWith("story:") ? account.slice("story:".length) : null,
    resolver,
    confidence,
    rules_version: RULES_VERSION,
  };
}

/**
 * The attribution ladder (rules_version 1). First rule that fires wins:
 *   1 pin                 1.00
 *   2 active_entry        0.90   exactly one open entry for the session's repo
 *   3 transcript_evidence 0.75   key in checkouts/commits/PR ops, applies forward
 *   4 session_branch      0.60   key parsed from the turn's git branch
 *   5 repo_default        0.40   config.metering.repo_defaults[repo]
 *   6 none                1.00   unattributed — a respectable account
 * A rule that matches multiple candidates falls through and queues an
 * ambiguity (the attribution inbox). A turn is never split.
 */
export function resolveTurn(turn: Turn, ctx: ResolverContext): Resolution {
  let ambiguity: Resolution["ambiguity"] = null;

  // Rule 0 — an applied inbox resolution for this turn. Same standing as a
  // pin (a user assertion), and it must keep winning on every re-meter.
  const override = ctx.turnOverrides?.get(turn.index);
  if (override !== undefined) {
    return { attribution: attribution(override, "pin", 1.0), ambiguity: null };
  }

  // Rule 1 — pin. A whole-session pin or one whose range covers the turn.
  // A pin on the parent session also covers its subagent transcripts
  // (composite ids): "pin this session" includes the agents it spawned.
  // For plain ids root === self, so no pre-2.1 attribution changes — which
  // is why RULES_VERSION stays put.
  const turnTs = turn.models.reduce((max, m) => (m.lastTs > max ? m.lastTs : max), "");
  const rootId = rootSessionId(ctx.sessionId);
  const matchingPins = ctx.pins.filter((p) => {
    if (p.session_id !== ctx.sessionId && p.session_id !== rootId) return false;
    if (p.range === null) return true;
    if (turnTs === "") return false;
    const fromOk = p.range.from <= turnTs;
    const toOk = p.range.to === null || turnTs <= p.range.to;
    return fromOk && toOk;
  });
  if (matchingPins.length === 1) {
    return { attribution: attribution(matchingPins[0]!.account, "pin", 1.0), ambiguity: null };
  }
  if (matchingPins.length > 1) {
    const accounts = [...new Set(matchingPins.map((p) => p.account))].sort();
    if (accounts.length === 1) {
      return { attribution: attribution(accounts[0]!, "pin", 1.0), ambiguity: null };
    }
    ambiguity = ambiguity ?? { rule: "pin", candidates: accounts };
  }

  // Rule 2 — active_entry: exactly one open entry matching the session's repo.
  const candidates = ctx.openEntries.filter(
    (e) => e.tracker_key !== null && (ctx.repo === null || e.repo === null || e.repo === ctx.repo),
  );
  const keys = [...new Set(candidates.map((e) => e.tracker_key as string))].sort();
  if (keys.length === 1) {
    return { attribution: attribution(`story:${keys[0]}`, "active_entry", 0.9), ambiguity };
  }
  if (keys.length > 1) {
    ambiguity = ambiguity ?? { rule: "active_entry", candidates: keys.map((k) => `story:${k}`) };
  }

  // Rule 3 — transcript_evidence: applies forward from the evidence point.
  // A turn belongs to the account active at its START (FR-A3), so evidence
  // found inside turn N takes effect from turn N+1; the turn is never split.
  const applicable = ctx.evidence.filter((e) => e.turnIndex < turn.index);
  const lastEvidence: EvidenceKey | undefined = applicable[applicable.length - 1];
  if (lastEvidence) {
    return {
      attribution: attribution(`story:${lastEvidence.key}`, "transcript_evidence", 0.75),
      ambiguity,
    };
  }

  // Rule 4 — session_branch: key parsed from the turn's branch.
  const branchKey = keyFromBranch(turn.branchAtStart, ctx.branchKeyPattern);
  if (branchKey && isPlausibleTrackerKey(branchKey, ctx.projectKeys ?? [])) {
    return { attribution: attribution(`story:${branchKey}`, "session_branch", 0.6), ambiguity };
  }

  // Rule 5 — repo_default.
  if (ctx.repo !== null) {
    const dflt = ctx.repoDefaults[ctx.repo];
    if (typeof dflt === "string" && dflt !== "") {
      const account = dflt.includes(":") ? dflt : `story:${dflt}`;
      return { attribution: attribution(account, "repo_default", 0.4), ambiguity };
    }
  }

  // Rule 6 — none.
  return { attribution: attribution("unattributed", "none", 1.0), ambiguity };
}
