import { mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function lockPath(home: string): string {
  return join(home, "pending-sessions", ".miner.lock");
}

/**
 * Atomic writer lock shared by every metering entry point (miner, meter,
 * resolve): exclusive-create (wx) so two processes can never both hold it.
 * A lock whose pid is dead is stale; takeover goes through an atomic
 * rename, so of two processes that both observe the dead holder exactly
 * one claims it — the unlink-then-recreate window of 0.4 is gone.
 */
export function acquireLock(home: string): boolean {
  mkdirSync(join(home, "pending-sessions"), { recursive: true });
  const p = lockPath(home);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(p, String(process.pid), { flag: "wx" });
      return true;
    } catch {
      try {
        const pid = Number(readFileSync(p, "utf8").trim());
        if (Number.isInteger(pid) && pid > 0) {
          process.kill(pid, 0); // throws if the process is gone
          return false; // live holder
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue; // freed — retry wx
        // unreadable content or dead holder — stale, fall through to takeover
      }
      const claim = `${p}.reap.${process.pid}`;
      try {
        renameSync(p, claim); // atomic: exactly one reaper wins
      } catch {
        return false; // another process reaped (or the holder revived) — yield
      }
      // Post-rename verification (architecture review rec. 5): between the
      // staleness read and the rename, the stale lock could have been
      // freed and a NEW live holder's lock created at the same path — the
      // rename would then have swept a live lock. Re-read what was
      // actually claimed; if it names a live process, put it back (wx, so
      // a lock created in the meantime is never clobbered) and yield.
      try {
        const claimed = readFileSync(claim, "utf8");
        const claimedPid = Number(claimed.trim());
        if (Number.isInteger(claimedPid) && claimedPid > 0 && claimedPid !== process.pid) {
          try {
            process.kill(claimedPid, 0); // throws if gone — the expected case
            try {
              writeFileSync(p, claimed, { flag: "wx" });
              unlinkSync(claim);
            } catch {
              // p re-created by a third process before restore: the claim
              // file stays as a harmless orphan; the live holder's next
              // release is already a silent no-op either way.
            }
            return false;
          } catch {
            // dead as observed — the reap stands
          }
        }
        unlinkSync(claim);
      } catch {
        return false; // claim vanished under us — yield
      }
    }
  }
  return false;
}

/** Acquire with a short retry window (for user-invoked commands). */
export async function acquireLockWait(home: string, tries = 10, delayMs = 200): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if (acquireLock(home)) return true;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

export function releaseLock(home: string): void {
  try {
    unlinkSync(lockPath(home));
  } catch {
    // already gone
  }
}

/** Test hook. */
export function _clearLock(home: string): void {
  rmSync(lockPath(home), { force: true });
}
