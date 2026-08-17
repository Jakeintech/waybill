import {
  extractKeys,
  sortChanges,
  type AdapterContext,
  type GitHostAdapter,
  type MergedChange,
} from "./contract.ts";

interface RawPr {
  html_url?: string;
  title?: string;
  merged_at?: string | null;
  closed_at?: string | null;
  pull_request?: { merged_at?: string | null };
  head?: { ref?: string };
  base?: { repo?: { full_name?: string } };
  repository_url?: string;
  repository?: { full_name?: string };
  user?: { login?: string };
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

function repoOf(pr: RawPr): string | null {
  const full = str(pr.base?.repo?.full_name) ?? str(pr.repository?.full_name);
  if (full) return full;
  const repoUrl = str(pr.repository_url);
  if (repoUrl) {
    const m = /repos\/([^/]+\/[^/]+)$/.exec(repoUrl);
    if (m) return m[1]!;
  }
  const html = str(pr.html_url);
  if (html) {
    const m = /github\.com\/([^/]+\/[^/]+)\/pull\//.exec(html);
    if (m) return m[1]!;
  }
  return null;
}

/**
 * GitHub REST payloads → MergedChanges. Accepts both the pulls-list shape
 * and the search-issues shape; silently drops unmerged PRs. Pure.
 */
export const githubAdapter: GitHostAdapter = {
  kind: "github",
  normalizeChanges(raw: unknown, ctx: AdapterContext): MergedChange[] {
    const items: RawPr[] = Array.isArray(raw)
      ? (raw as RawPr[])
      : ((raw as { items?: RawPr[] })?.items ?? []);
    const out: MergedChange[] = [];
    for (const pr of items) {
      const mergedAt = str(pr.merged_at) ?? str(pr.pull_request?.merged_at);
      const url = str(pr.html_url);
      const repo = repoOf(pr);
      if (!mergedAt || !url || !repo) continue;
      // Own data only: a PR that names another author is dropped, even if
      // a mis-scoped query fetched it.
      const author = str(pr.user?.login);
      if (ctx.githubLogin && author && author !== ctx.githubLogin) continue;
      const title = str(pr.title) ?? url;
      const branch = str(pr.head?.ref);
      out.push({
        url,
        title,
        repo,
        branch,
        merged_at: mergedAt,
        keys: extractKeys(`${title} ${branch ?? ""}`, ctx.keyPattern, ctx.projectKeys),
      });
    }
    return sortChanges(out);
  },
};
