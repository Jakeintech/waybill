import {
  extractKeys,
  sortChanges,
  type AdapterContext,
  type GitHostAdapter,
  type MergedChange,
} from "./contract.ts";

// Bitbucket Cloud 2.0 pull request (GET /repositories/{ws}/{repo}/
// pullrequests?state=MERGED, paged under `values`): { id, title, state,
// author: { nickname, display_name }, source: { branch: { name } },
// destination: { repository: { full_name } }, links: { html: { href } },
// created_on, updated_on }
interface BbPr {
  id?: number;
  title?: string;
  state?: string;
  author?: { nickname?: string; display_name?: string };
  source?: { branch?: { name?: string } };
  destination?: { repository?: { full_name?: string } };
  links?: { html?: { href?: string } };
  created_on?: string;
  updated_on?: string;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/**
 * Bitbucket Cloud adapter: merged pull requests → MergedChanges. The 2.0
 * PR object carries no merged_on field, so `updated_on` of a MERGED PR
 * stands in for the merge time (the merge is the update that set the
 * state) — documented approximation, never a fabrication: the value is a
 * verbatim payload leaf. Bitbucket has no GitHub-style closing-keyword
 * linkage, so `closes` is omitted (the contract allows it). Own-data
 * defense-in-depth reads author.nickname against identity's
 * bitbucket_username. Pure.
 */
export const bitbucketAdapter: GitHostAdapter = {
  kind: "bitbucket",
  normalizeChanges(raw: unknown, ctx: AdapterContext): MergedChange[] {
    const prs: BbPr[] = Array.isArray(raw)
      ? (raw as BbPr[])
      : ((raw as { values?: BbPr[] })?.values ?? []);
    const out: MergedChange[] = [];
    for (const pr of prs) {
      if (str(pr.state) !== "MERGED") continue; // open/declined PRs are not shipped value
      const url = str(pr.links?.html?.href);
      const repo = str(pr.destination?.repository?.full_name);
      const mergedAt = str(pr.updated_on);
      if (!url || !repo || !mergedAt) continue;
      // Own data only (methodology §6): a PR naming another author is
      // dropped even if a mis-scoped query fetched it.
      const author = str(pr.author?.nickname);
      if (ctx.bitbucketUsername && author && author !== ctx.bitbucketUsername) continue;
      const title = str(pr.title) ?? url;
      const branch = str(pr.source?.branch?.name);
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
