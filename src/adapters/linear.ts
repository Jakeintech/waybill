import type { WorkType } from "../core/events.ts";
import {
  sortItems,
  type AdapterContext,
  type TrackerAdapter,
  type WorkItem,
} from "./contract.ts";

// Linear GraphQL issue node (via the Linear MCP server or API):
// { identifier, title, estimate, url, createdAt, updatedAt, completedAt,
//   state: { name, type }, cycle: { name, number }, project: { name },
//   labels: { nodes: [{ name }] } }
interface LinearIssue {
  identifier?: string;
  title?: string;
  estimate?: number | null;
  url?: string;
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string | null;
  assignee?: { id?: string };
  state?: { name?: string; type?: string };
  cycle?: { name?: string | null; number?: number | null } | null;
  project?: { name?: string | null } | null;
  labels?: { nodes?: Array<{ name?: string }> };
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

function workTypeFromLabels(issue: LinearIssue): WorkType {
  const labels = (issue.labels?.nodes ?? [])
    .map((l) => (l.name ?? "").toLowerCase())
    .filter((n) => n !== "");
  if (labels.includes("bug")) return "bug";
  if (labels.includes("refactor")) return "refactor";
  if (labels.includes("docs") || labels.includes("documentation")) return "docs";
  if (labels.includes("research") || labels.includes("spike")) return "research";
  if (labels.includes("incident")) return "incident";
  return "feature";
}

/**
 * Linear adapter: GraphQL issue nodes → WorkItems. Accepts the full GraphQL
 * response shape ({data:{issues:{nodes:[...]}}}), a nodes array, or a bare
 * array. Estimates map to points (never invented); a Linear cycle maps to
 * sprint; the project name maps to epic_name (Linear projects have no
 * tracker-style key, so epic_key stays null). Pure.
 */
export const linearAdapter: TrackerAdapter = {
  kind: "linear",
  normalizeItems(raw: unknown, ctx: AdapterContext): WorkItem[] {
    const root = raw as {
      data?: { issues?: { nodes?: LinearIssue[] } };
      issues?: { nodes?: LinearIssue[] };
      nodes?: LinearIssue[];
    };
    const nodes: LinearIssue[] = Array.isArray(raw)
      ? (raw as LinearIssue[])
      : (root.data?.issues?.nodes ?? root.issues?.nodes ?? root.nodes ?? []);
    const keyRe = new RegExp(`^(?:${ctx.keyPattern})$`);
    const out: WorkItem[] = [];
    for (const issue of nodes) {
      const key = str(issue.identifier);
      if (!key || !keyRe.test(key)) continue;
      const stateType = str(issue.state?.type);
      if (stateType === "canceled") continue; // cancelled work is not shipped value
      const completedAt = str(issue.completedAt);
      const done = stateType === "completed" || completedAt !== null;
      const cycle = issue.cycle ?? null;
      const sprint =
        str(cycle?.name) ??
        (typeof cycle?.number === "number" ? `cycle-${cycle.number}` : null);
      out.push({
        key,
        title: str(issue.title) ?? key,
        points: typeof issue.estimate === "number" && Number.isFinite(issue.estimate) ? issue.estimate : null,
        epic_key: null,
        epic_name: str(issue.project?.name),
        sprint,
        status: str(issue.state?.name) ?? "unknown",
        done,
        resolved_at: completedAt,
        created_at: str(issue.createdAt),
        updated_at: str(issue.updatedAt),
        work_type: workTypeFromLabels(issue),
        url: str(issue.url),
      });
    }
    return sortItems(out);
  },
};
