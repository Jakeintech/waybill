import { sha256Hex } from "./sha.ts";
import type { Escrow, Estimate, LedgerEntry } from "./events.ts";

export function escrowPayload(
  keyOrTitle: string,
  low: number,
  high: number,
  loggedAt: string,
): string {
  return `estimate.v1|${keyOrTitle}|${low}|${high}|hours|${loggedAt}`;
}

export function sealEstimate(keyOrTitle: string, estimate: Estimate): Escrow {
  return {
    algo: "sha256",
    payload: "estimate.v1",
    sha256: sha256Hex(escrowPayload(keyOrTitle, estimate.low, estimate.high, estimate.logged_at)),
  };
}

export type EscrowCheck =
  | { status: "ok" }
  | { status: "absent" }
  | { status: "mismatch"; expected: string; found: string };

export function checkEscrow(entry: LedgerEntry): EscrowCheck {
  if (!entry.escrow) return { status: "absent" };
  const est = entry.estimate_without_claude_hours;
  if (!est) return { status: "mismatch", expected: "(no estimate present)", found: entry.escrow.sha256 };
  // An entry sealed before it had a tracker_key was sealed over the title;
  // a later correction may add the key. Either identity verifies — the
  // range and logged_at are what the seal protects.
  const candidates = [entry.tracker_key, entry.title].filter(
    (v): v is string => v !== null,
  );
  let expected = "";
  for (const keyOrTitle of candidates) {
    expected = sha256Hex(escrowPayload(keyOrTitle, est.low, est.high, est.logged_at));
    if (expected === entry.escrow.sha256) return { status: "ok" };
  }
  return { status: "mismatch", expected, found: entry.escrow.sha256 };
}
