import type { WorkType } from "../core/events.ts";
import {
  sortItems,
  type AdapterContext,
  type TrackerAdapter,
  type WorkItem,
} from "./contract.ts";

interface JiraIssue {
  key?: string;
  self?: string;
  fields?: Record<string, unknown>;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function mapWorkType(issueType: string | null): WorkType {
  switch ((issueType ?? "").toLowerCase()) {
    case "bug":
      return "bug";
    case "story":
    case "task":
    case "sub-task":
    case "subtask":
      return "feature";
    case "incident":
      return "incident";
    case "spike":
    case "research":
      return "research";
    default:
      return "other";
  }
}

function sprintName(fields: Record<string, unknown>, ctx: AdapterContext): string | null {
  for (const field of ctx.sprintFields) {
    const v = fields[field];
    if (Array.isArray(v) && v.length > 0) {
      const last = v[v.length - 1];
      if (typeof last === "string") {
        // Old Jira serializes sprints as "...,name=Sprint 17,..." strings.
        const m = /name=([^,]+)/.exec(last);
        if (m) return m[1]!;
        return last;
      }
      const name = str((last as Record<string, unknown>)?.["name"]);
      if (name) return name;
    }
  }
  return null;
}

function points(fields: Record<string, unknown>, ctx: AdapterContext): number | null {
  for (const field of ctx.pointsFields) {
    const v = num(fields[field]);
    if (v !== null) return v;
  }
  return null;
}

/** Jira Cloud REST search payload ({issues: [...]}) → WorkItems. Pure. */
export const jiraAdapter: TrackerAdapter = {
  kind: "jira",
  normalizeItems(raw: unknown, ctx: AdapterContext): WorkItem[] {
    const issues: JiraIssue[] = Array.isArray(raw)
      ? (raw as JiraIssue[])
      : ((raw as { issues?: JiraIssue[] })?.issues ?? []);
    const out: WorkItem[] = [];
    const keyRe = new RegExp(`^(?:${ctx.keyPattern})$`);
    for (const issue of issues) {
      const key = str(issue.key);
      if (!key || !keyRe.test(key)) continue;
      const fields = issue.fields ?? {};
      // Own data only: an issue assigned to someone else is dropped, even
      // if a mis-scoped JQL fetched it.
      const assignee = str(
        (fields["assignee"] as Record<string, unknown> | undefined)?.["accountId"],
      );
      if (ctx.jiraAccountId && assignee && assignee !== ctx.jiraAccountId) continue;
      const status = fields["status"] as Record<string, unknown> | undefined;
      const statusName = str(status?.["name"]) ?? "unknown";
      const category = (status?.["statusCategory"] as Record<string, unknown> | undefined)?.["key"];
      const resolvedAt = str(fields["resolutiondate"]);
      const done = category === "done" || resolvedAt !== null;
      const issueType = str((fields["issuetype"] as Record<string, unknown> | undefined)?.["name"]);
      const parent = fields["parent"] as JiraIssue | undefined;
      const parentType = str(
        ((parent?.fields?.["issuetype"]) as Record<string, unknown> | undefined)?.["name"],
      );
      const parentIsEpic = (parentType ?? "").toLowerCase() === "epic";
      const epicKey = parentIsEpic ? str(parent?.key) : str(fields["customfield_10014"]); // epic link
      const epicName = parentIsEpic
        ? str((parent?.fields ?? {})["summary"])
        : str(fields["customfield_10011"]); // epic name
      const base = str(issue.self)?.replace(/\/rest\/api\/.*$/, "");
      out.push({
        key,
        title: str(fields["summary"]) ?? key,
        points: points(fields, ctx),
        epic_key: epicKey,
        epic_name: epicName,
        sprint: sprintName(fields, ctx),
        status: statusName,
        done,
        resolved_at: resolvedAt,
        created_at: str(fields["created"]),
        updated_at: str(fields["updated"]),
        work_type: mapWorkType(issueType),
        url: base ? `${base}/browse/${key}` : null,
      });
    }
    return sortItems(out);
  },
};
