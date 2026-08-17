import { parseGitLog } from "../gitlocal/gitlocal.ts";
import {
  extractKeys,
  sortChanges,
  type AdapterContext,
  type GitHostAdapter,
  type MergedChange,
} from "./contract.ts";

/**
 * The zero-auth floor: merge commits from local `git log` output become
 * MergedChanges. `raw` is `{repo, log}` where log is the %x1f/%x1e-delimited
 * text from gitLogRaw(). Only the user's own commits (identityEmails). Pure.
 */
export const gitLocalAdapter: GitHostAdapter = {
  kind: "local",
  normalizeChanges(raw: unknown, ctx: AdapterContext): MergedChange[] {
    const { repo, log } = raw as { repo?: string; log?: string };
    if (typeof repo !== "string" || typeof log !== "string") return [];
    const emails = new Set(ctx.identityEmails.map((e) => e.toLowerCase()));
    const out: MergedChange[] = [];
    for (const c of parseGitLog(log)) {
      if (c.parents <= 1) continue;
      if (emails.size > 0 && !emails.has(c.author_email.toLowerCase())) continue;
      out.push({
        url: null, // local history has no web URL; the sha is the receipt
        title: `${c.subject} (${c.sha.slice(0, 10)})`,
        repo,
        branch: null,
        merged_at: c.author_date,
        keys: extractKeys(c.subject, ctx.keyPattern, ctx.projectKeys),
      });
    }
    return sortChanges(out);
  },
};
