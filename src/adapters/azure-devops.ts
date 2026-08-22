import type { WorkType } from "../core/events.ts";
import {
  sortItems,
  type AdapterContext,
  type TrackerAdapter,
  type WorkItem,
} from "./contract.ts";

// Azure DevOps work item (REST `_apis/wit/workitems?ids=…&$expand=links`,
// or one item per WIQL result): { id, fields: { "System.Title",
// "System.State", "System.WorkItemType", "System.CreatedDate",
// "System.ChangedDate", "System.IterationPath",
// "System.AssignedTo": { displayName, uniqueName },
// "Microsoft.VSTS.Scheduling.StoryPoints" | ".Effort",
// "Microsoft.VSTS.Common.ClosedDate" }, _links: { html: { href } }, url }
interface AdoWorkItem {
  id?: number | string;
  fields?: Record<string, unknown>;
  _links?: { html?: { href?: string } };
  url?: string;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// Process templates vary (Agile, Scrum, Basic, CMMI); these are the
// terminal states across all of them. An unknown custom state is not
// assumed done — ClosedDate is the stronger signal either way.
const DONE_STATES = new Set(["done", "closed", "completed", "resolved"]);

function workTypeOf(t: string | null): WorkType {
  const kind = (t ?? "").toLowerCase();
  if (kind === "bug") return "bug";
  if (kind === "task" || kind === "user story" || kind === "product backlog item" || kind === "feature" || kind === "epic") {
    return "feature";
  }
  return "other";
}

/**
 * Azure DevOps adapter: work items → WorkItems. Keys are the numeric work
 * item ids (ADO's own key shape — branch/commit references use `AB#123` /
 * bare ids, and the id is always a payload leaf). Story points come from
 * the Agile StoryPoints field or the Scrum Effort field, never invented;
 * the iteration path's last segment maps to sprint. Own-data
 * defense-in-depth reads System.AssignedTo.uniqueName (the account's
 * email) against the identity map's git emails. Pure.
 */
export const azureDevOpsAdapter: TrackerAdapter = {
  kind: "azure-devops",
  keyPattern: "[0-9]+",
  deriveKey(url: string): string | null {
    const m = /\/(\d+)$/.exec(url);
    return m ? m[1]! : null;
  },
  normalizeItems(raw: unknown, ctx: AdapterContext): WorkItem[] {
    const items: AdoWorkItem[] = Array.isArray(raw)
      ? (raw as AdoWorkItem[])
      : ((raw as { value?: AdoWorkItem[] })?.value ?? []);
    const out: WorkItem[] = [];
    const emails = ctx.identityEmails.map((e) => e.toLowerCase());
    for (const item of items) {
      const id = typeof item.id === "number" ? String(item.id) : str(item.id);
      const fields = item.fields ?? {};
      if (!id || !/^\d+$/.test(id)) continue;
      // Own data only (methodology §6): an item assigned to someone else is
      // dropped even if a mis-scoped WIQL query fetched it. uniqueName is
      // the assignee's sign-in email — the identity map already holds those.
      const assignedTo = fields["System.AssignedTo"] as { uniqueName?: string } | undefined;
      const assignee = str(assignedTo?.uniqueName);
      if (emails.length > 0 && assignee && !emails.includes(assignee.toLowerCase())) continue;
      const state = str(fields["System.State"]);
      const closedAt = str(fields["Microsoft.VSTS.Common.ClosedDate"]);
      const done = closedAt !== null || DONE_STATES.has((state ?? "").toLowerCase());
      const iteration = str(fields["System.IterationPath"]);
      const sprint = iteration !== null ? (iteration.split("\\").pop() ?? iteration) : null;
      out.push({
        key: id,
        title: str(fields["System.Title"]) ?? id,
        points:
          num(fields["Microsoft.VSTS.Scheduling.StoryPoints"]) ??
          num(fields["Microsoft.VSTS.Scheduling.Effort"]),
        epic_key: null, // System.Parent is a bare id; a key without its title helps nobody
        epic_name: null,
        sprint,
        status: state ?? "unknown",
        done,
        resolved_at: closedAt,
        created_at: str(fields["System.CreatedDate"]),
        updated_at: str(fields["System.ChangedDate"]),
        work_type: workTypeOf(str(fields["System.WorkItemType"])),
        url: str(item._links?.html?.href) ?? str(item.url),
      });
    }
    return sortItems(out);
  },
};
