import {
  extractCloses,
  extractKeys,
  sortChanges,
  type AdapterContext,
  type GitHostAdapter,
  type MergedChange,
} from "./contract.ts";

interface RawPr {
  html_url?: string;
  /** gh CLI (`gh pr list --json url,...`): the PR's html URL. In the REST
   * search shape this key is the API URL instead — html_url always wins. */
  url?: string;
  title?: string;
  body?: string | null;
  merged_at?: string | null;
  mergedAt?: string | null; // gh CLI
  closed_at?: string | null;
  pull_request?: { merged_at?: string | null };
  head?: { ref?: string };
  headRefName?: string; // gh CLI
  base?: { repo?: { full_name?: string } };
  repository_url?: string;
  repository?: { full_name?: string };
  user?: { login?: string };
  author?: { login?: string }; // gh CLI
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
  // gh CLI rows carry no repo object; the PR's own html URL names it. The
  // /pull/N path shape is the signal, not the hostname — GitHub Enterprise
  // hosts must work too (REST API urls never match: their paths run
  // /repos/owner/repo/pulls/N).
  const html = str(pr.html_url) ?? str(pr.url);
  if (html) {
    const m = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/\d+/.exec(html);
    if (m) return m[1]!;
  }
  return null;
}

/**
 * GitHub payloads → MergedChanges. Accepts the REST pulls-list shape, the
 * REST search-issues shape, and gh CLI output (`gh pr list --json
 * url,title,headRefName,mergedAt,body,author` — camelCase); silently drops
 * unmerged PRs. Pure.
 */
export const githubAdapter: GitHostAdapter = {
  kind: "github",
  normalizeChanges(raw: unknown, ctx: AdapterContext): MergedChange[] {
    const items: RawPr[] = Array.isArray(raw)
      ? (raw as RawPr[])
      : ((raw as { items?: RawPr[] })?.items ?? []);
    const out: MergedChange[] = [];
    for (const pr of items) {
      const mergedAt =
        str(pr.merged_at) ?? str(pr.pull_request?.merged_at) ?? str(pr.mergedAt);
      const url = str(pr.html_url) ?? str(pr.url);
      const repo = repoOf(pr);
      if (!mergedAt || !url || !repo) continue;
      // gh CLI's `url` is the html URL; a REST row's `url` is the API URL —
      // never a receipt. html_url won when both exist; drop API-only rows.
      if (!/\/pull\/\d+$/.test(url)) continue;
      // Own data only: a PR that names another author is dropped, even if
      // a mis-scoped query fetched it.
      const author = str(pr.user?.login) ?? str(pr.author?.login);
      if (ctx.githubLogin && author && author !== ctx.githubLogin) continue;
      const title = str(pr.title) ?? url;
      const branch = str(pr.head?.ref) ?? str(pr.headRefName);
      out.push({
        url,
        title,
        repo,
        branch,
        merged_at: mergedAt,
        keys: extractKeys(`${title} ${branch ?? ""}`, ctx.keyPattern, ctx.projectKeys),
        // GitHub's real issue linkage: closing keywords in the title/body.
        closes: extractCloses(`${title}\n${str(pr.body) ?? ""}`, repo),
      });
    }
    return sortChanges(out);
  },
};
