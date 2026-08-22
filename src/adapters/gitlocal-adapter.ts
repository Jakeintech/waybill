import { parseGitLog } from "../gitlocal/gitlocal.ts";
import {
  extractCloses,
  extractKeys,
  sortChanges,
  type AdapterContext,
  type GitHostAdapter,
  type MergedChange,
} from "./contract.ts";

/**
 * The zero-auth floor: local `git log` output becomes MergedChanges. `raw`
 * is `{repo, log}` where log is the %x1f/%x1e-delimited text from
 * gitLogRaw(). Two commit shapes qualify: merge commits (>1 parent), and —
 * because GitHub squash-flow produces linear history where the squashed
 * commit IS the merged change — a single-parent commit whose message
 * carries a closing reference ("Fixes #12"). Plain commits without one
 * stay invisible, as before. Only the user's own commits (identityEmails).
 * Pure.
 */
export const gitLocalAdapter: GitHostAdapter = {
  kind: "local",
  normalizeChanges(raw: unknown, ctx: AdapterContext): MergedChange[] {
    const { repo, log } = raw as { repo?: string; log?: string };
    if (typeof repo !== "string" || typeof log !== "string") return [];
    const emails = new Set(ctx.identityEmails.map((e) => e.toLowerCase()));
    const out: MergedChange[] = [];
    for (const c of parseGitLog(log)) {
      if (emails.size > 0 && !emails.has(c.author_email.toLowerCase())) continue;
      const closes = extractCloses(`${c.subject}\n${c.body}`, repo);
      if (c.parents <= 1 && closes.length === 0) continue;
      out.push({
        url: null, // local history has no web URL; the sha is the receipt
        title: `${c.subject} (${c.sha.slice(0, 10)})`,
        repo,
        branch: null,
        // Merge semantics want the committer date: a squash-merged branch
        // keeps an author date days older than the merge itself. Older
        // captured logs without %cd fall back to the author date.
        merged_at: c.committer_date !== "" ? c.committer_date : c.author_date,
        keys: extractKeys(c.subject, ctx.keyPattern, ctx.projectKeys),
        closes,
      });
    }
    return sortChanges(out);
  },
};
