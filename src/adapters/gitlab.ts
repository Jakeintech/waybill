import {
  extractCloses,
  extractKeys,
  sortChanges,
  type AdapterContext,
  type GitHostAdapter,
  type MergedChange,
} from "./contract.ts";

// GitLab REST merge request (GET /merge_requests?state=merged or via the
// GitLab MCP server): { web_url, title, source_branch, merged_at,
// references: { full: "group/project!7" }, author: { username } }
interface RawMr {
  web_url?: string;
  title?: string;
  description?: string | null;
  source_branch?: string;
  merged_at?: string | null;
  state?: string;
  references?: { full?: string };
  author?: { username?: string };
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

function repoOf(mr: RawMr): string | null {
  const full = str(mr.references?.full);
  if (full) {
    const m = /^(.+)!\d+$/.exec(full);
    if (m) return m[1]!;
  }
  const url = str(mr.web_url);
  if (url) {
    const m = /^https?:\/\/[^/]+\/(.+?)\/-\/merge_requests\//.exec(url);
    if (m) return m[1]!;
  }
  return null;
}

/** GitLab merge requests → MergedChanges. Merged only; MRs map to
 * artifacts.prs. Pure. */
export const gitlabAdapter: GitHostAdapter = {
  kind: "gitlab",
  normalizeChanges(raw: unknown, ctx: AdapterContext): MergedChange[] {
    const items: RawMr[] = Array.isArray(raw)
      ? (raw as RawMr[])
      : ((raw as { merge_requests?: RawMr[] })?.merge_requests ?? []);
    const out: MergedChange[] = [];
    for (const mr of items) {
      const mergedAt = str(mr.merged_at);
      const url = str(mr.web_url);
      const repo = repoOf(mr);
      if (!mergedAt || !url || !repo) continue;
      // Own data only (methodology §6): an MR naming another author is
      // dropped even if a mis-scoped query fetched it.
      const author = str(mr.author?.username);
      if (ctx.gitlabUsername && author && author !== ctx.gitlabUsername) continue;
      const title = str(mr.title) ?? url;
      const branch = str(mr.source_branch);
      out.push({
        url,
        title,
        repo,
        branch,
        merged_at: mergedAt,
        keys: extractKeys(`${title} ${branch ?? ""}`, ctx.keyPattern, ctx.projectKeys),
        // GitLab MR descriptions use the same closing-keyword grammar.
        closes: extractCloses(`${title}\n${str(mr.description) ?? ""}`, repo),
      });
    }
    return sortChanges(out);
  },
};
