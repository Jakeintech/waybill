import type { WorkType } from "../core/events.ts";
import {
  sortItems,
  type AdapterContext,
  type TrackerAdapter,
  type WorkItem,
} from "./contract.ts";

// A GitHub issue in either of the two shapes the ecosystem produces —
// the gh CLI (`gh issue list --json …`: camelCase, SCREAMING state) and
// the REST API (`/repos/{owner}/{repo}/issues`: snake_case, lowercase
// state). The adapter accepts both; field access tries CLI names first.
interface GhIssue {
  number?: number;
  title?: string;
  state?: string; // "CLOSED" (CLI) | "closed" (REST)
  stateReason?: string | null; // CLI
  state_reason?: string | null; // REST
  closedAt?: string | null; // CLI
  closed_at?: string | null; // REST
  createdAt?: string; // CLI
  created_at?: string; // REST
  updatedAt?: string; // CLI
  updated_at?: string; // REST
  labels?: Array<{ name?: string } | string>;
  milestone?: { title?: string | null } | null;
  assignee?: { login?: string } | null; // REST only
  assignees?: Array<{ login?: string }>;
  url?: string; // CLI: the html url
  html_url?: string; // REST
  pull_request?: unknown; // REST /issues returns PRs too — identified by this key
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

function workTypeFromLabels(issue: GhIssue): WorkType {
  const labels = (issue.labels ?? [])
    .map((l) => (typeof l === "string" ? l : (l.name ?? "")).toLowerCase())
    .filter((n) => n !== "");
  if (labels.includes("bug")) return "bug";
  if (labels.includes("refactor")) return "refactor";
  if (labels.includes("docs") || labels.includes("documentation")) return "docs";
  if (labels.includes("research") || labels.includes("spike")) return "research";
  if (labels.includes("incident")) return "incident";
  return "feature";
}

const ISSUE_URL = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/issues\/([0-9]+)$/;

/**
 * GitHub Issues as the tracker of record. Keys are GitHub's own canonical
 * cross-repo reference syntax, `owner/repo#number`, derived purely from
 * the issue's URL leaf (see `deriveKey` — the conformance kit re-runs the
 * derivation to prove no fabrication). Accepts a bare array (gh CLI, REST
 * list), `{items}` (REST search), or `{issues}`. GitHub has no estimates,
 * so `points` stays null — a point scale is never invented. `not_planned`
 * closures are cancelled work, dropped like Linear's `canceled`. Pull
 * requests returned by the REST `/issues` endpoint are skipped. Own-data
 * scoping: an issue explicitly assigned to only other people is dropped
 * when `ctx.githubLogin` is set; an unassigned issue is kept — solo-repo
 * issues are rarely self-assigned, and the query is scoped upstream.
 * Pure.
 */
export const githubIssuesAdapter: TrackerAdapter = {
  kind: "github-issues",
  keyPattern: "[A-Za-z0-9][A-Za-z0-9-]*\\/[A-Za-z0-9._-]+#[0-9]+",
  deriveKey(url: string): string | null {
    const m = ISSUE_URL.exec(url);
    return m ? `${m[1]}/${m[2]}#${m[3]}` : null;
  },
  normalizeItems(raw: unknown, _ctx: AdapterContext): WorkItem[] {
    const root = raw as { items?: GhIssue[]; issues?: GhIssue[] };
    const nodes: GhIssue[] = Array.isArray(raw)
      ? (raw as GhIssue[])
      : (root.items ?? root.issues ?? []);
    const out: WorkItem[] = [];
    for (const issue of nodes) {
      if (issue.pull_request !== undefined) continue; // REST /issues lists PRs too
      const url = str(issue.url) ?? str(issue.html_url);
      if (!url) continue;
      const key = githubIssuesAdapter.deriveKey!(url);
      if (!key) continue; // not an issue URL
      const state = (str(issue.state) ?? "").toLowerCase();
      const reason = (str(issue.stateReason) ?? str(issue.state_reason) ?? "").toLowerCase();
      if (reason === "not_planned") continue; // cancelled work is not shipped value
      // Own-data (methodology §6): explicitly someone else's issue is
      // dropped; unassigned in a repo the user is syncing counts as theirs.
      const assignees = [
        ...(issue.assignees ?? []).map((a) => str(a.login)),
        str(issue.assignee?.login),
      ].filter((l): l is string => l !== null);
      if (
        _ctx.githubLogin !== null &&
        assignees.length > 0 &&
        !assignees.some((l) => l.toLowerCase() === _ctx.githubLogin!.toLowerCase())
      ) {
        continue;
      }
      const done = state === "closed";
      out.push({
        key,
        title: str(issue.title) ?? key,
        points: null, // GitHub has no estimates; a point scale is never invented
        epic_key: null,
        epic_name: null,
        sprint: str(issue.milestone?.title),
        status: state === "" ? "unknown" : state,
        done,
        resolved_at: done ? (str(issue.closedAt) ?? str(issue.closed_at)) : null,
        created_at: str(issue.createdAt) ?? str(issue.created_at),
        updated_at: str(issue.updatedAt) ?? str(issue.updated_at),
        work_type: workTypeFromLabels(issue),
        url,
      });
    }
    return sortItems(out);
  },
};
