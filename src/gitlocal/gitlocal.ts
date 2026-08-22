// The git-local adapter: first value from local git history alone —
// no auth, no network, no tracker. Reads only the user's own commits.
import { execFileSync } from "node:child_process";
import { isPlausibleTrackerKey } from "../core/keys.ts";
import { existsSync } from "node:fs";

export interface LocalCommit {
  sha: string;
  author_email: string;
  author_date: string;
  /** Committer date (%cd) — when the commit actually landed. This is the
   * merge-time signal: a squash-merged branch keeps its author date from
   * days earlier, but the committer date is the merge. Empty for logs
   * captured in the pre-committer-date format (adapter falls back to
   * author_date). */
  committer_date: string;
  parents: number;
  refs: string[];
  subject: string;
  /** Commit body (%b) — where closing keywords ("Fixes #12") live in
   * squash-merge workflows. Empty for logs captured in the pre-body
   * format. */
  body: string;
}

export interface RepoSummary {
  repo: string;
  path: string;
  commits: number;
  merges: number;
  active_days: number;
  first_date: string | null;
  last_date: string | null;
  keys: Array<{ key: string; count: number }>;
  tags: string[];
}

const FIELD_SEP = "\u001f";
const RECORD_SEP = "\u001e";

export function gitLogRaw(path: string, sinceIso: string, untilIso?: string): string {
  return execFileSync(
    "git",
    [
      "-C", path, "log", `--since=${sinceIso}`,
      ...(untilIso !== undefined ? [`--until=${untilIso}`] : []),
      "--date=iso-strict",
      "--pretty=format:%H%x1f%ae%x1f%ad%x1f%cd%x1f%P%x1f%D%x1f%s%x1f%b%x1e",
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30000, maxBuffer: 64 * 1024 * 1024 },
  );
}

export function parseGitLog(raw: string): LocalCommit[] {
  const out: LocalCommit[] = [];
  for (const record of raw.split(RECORD_SEP)) {
    const line = record.replace(/^\n/, "");
    if (line.trim() === "") continue;
    const parts = line.split(FIELD_SEP);
    if (parts.length < 6) continue;
    // Format detection: the current format carries a committer date after
    // the author date; the older one goes straight to the parents field.
    // A date can never look like a parents list (space-separated hex shas
    // or empty), so testing field 3 for an ISO shape is unambiguous.
    const hasCommitterDate = /^\d{4}-\d{2}-\d{2}T/.test(parts[3] ?? "");
    const [sha, email, adate] = parts;
    const cdate = hasCommitterDate ? parts[3]! : "";
    const rest = hasCommitterDate ? parts.slice(4) : parts.slice(3);
    const [parents, refs, subject, ...body] = rest;
    if (parents === undefined || refs === undefined || subject === undefined) continue;
    out.push({
      sha: sha!,
      author_email: email!,
      author_date: adate!,
      committer_date: cdate,
      parents: parents.trim() === "" ? 0 : parents.trim().split(" ").length,
      refs: refs
        .split(",")
        .map((r) => r.trim())
        .filter((r) => r !== ""),
      subject,
      body: body.join(FIELD_SEP), // "" for pre-body-format logs
    });
  }
  return out;
}

export function summarizeRepo(
  repo: string,
  path: string,
  commits: LocalCommit[],
  identityEmails: string[],
  keyPattern: string,
  projectKeys: string[] = [],
): RepoSummary {
  const emails = new Set(identityEmails.map((e) => e.toLowerCase()));
  const mine = commits.filter((c) => emails.has(c.author_email.toLowerCase()));
  const keyRe = new RegExp(keyPattern, "g");
  const keyCounts = new Map<string, number>();
  const tags: string[] = [];
  const days = new Set<string>();
  let first: string | null = null;
  let last: string | null = null;
  let merges = 0;
  for (const c of mine) {
    if (c.parents > 1) merges += 1;
    days.add(c.author_date.slice(0, 10));
    if (first === null || c.author_date < first) first = c.author_date;
    if (last === null || c.author_date > last) last = c.author_date;
    for (const k of c.subject.match(keyRe) ?? []) {
      if (!isPlausibleTrackerKey(k, projectKeys)) continue;
      keyCounts.set(k, (keyCounts.get(k) ?? 0) + 1);
    }
    for (const ref of c.refs) {
      if (ref.startsWith("tag: ") && !tags.includes(ref.slice(5))) tags.push(ref.slice(5));
    }
  }
  const keys = [...keyCounts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : 1));
  return {
    repo,
    path,
    commits: mine.length,
    merges,
    active_days: days.size,
    first_date: first ? first.slice(0, 10) : null,
    last_date: last ? last.slice(0, 10) : null,
    keys,
    tags,
  };
}

export function isGitRepo(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    execFileSync("git", ["-C", path, "rev-parse", "--git-dir"], {
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}
