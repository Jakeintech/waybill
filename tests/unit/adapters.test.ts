import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultContext, extractCloses } from "../../src/adapters/contract.ts";
import { jiraAdapter } from "../../src/adapters/jira.ts";
import { githubAdapter } from "../../src/adapters/github.ts";
import { githubIssuesAdapter } from "../../src/adapters/github-issues.ts";
import { gitLocalAdapter } from "../../src/adapters/gitlocal-adapter.ts";
import { checkGitHostAdapter, checkTrackerAdapter } from "../../src/adapters/conformance.ts";
import { deriveBaseline, reconcile } from "../../src/sync/reconcile.ts";
import { readEvents } from "../../src/core/streams.ts";
import { finalizeEvent, type LedgerEntry } from "../../src/core/events.ts";
import { checkEscrow } from "../../src/core/escrow.ts";
import { makeOpened } from "../helpers/fixtures.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const FIX = join(ROOT, "tests", "fixtures", "adapters");
const CTX = defaultContext({ identityEmails: ["me@example.com"] });

const jiraRaw = JSON.parse(readFileSync(join(FIX, "jira-search.json"), "utf8")) as unknown;
const githubRaw = JSON.parse(readFileSync(join(FIX, "github-prs.json"), "utf8")) as unknown;
const ghIssuesRaw = JSON.parse(readFileSync(join(FIX, "github-issues.json"), "utf8")) as unknown;

test("jira adapter: normalizes items — points, epic via parent, active sprint, done state", () => {
  const items = jiraAdapter.normalizeItems(jiraRaw, CTX);
  assert.deepEqual(items.map((i) => i.key), ["DATA-77", "PLAT-482", "PLAT-490"]);
  const plat = items.find((i) => i.key === "PLAT-482")!;
  assert.equal(plat.points, 5);
  assert.equal(plat.epic_key, "PLAT-401");
  assert.equal(plat.epic_name, "Checkout reliability");
  assert.equal(plat.sprint, "2026-S17");
  assert.equal(plat.done, true);
  assert.equal(plat.work_type, "feature");
  assert.equal(plat.url, "https://acme.atlassian.net/browse/PLAT-482");
  const data = items.find((i) => i.key === "DATA-77")!;
  assert.equal(data.done, false);
  assert.equal(data.resolved_at, null);
  const bug = items.find((i) => i.key === "PLAT-490")!;
  assert.equal(bug.work_type, "bug");
});

test("github adapter: merged only, keys from title+branch, both payload shapes", () => {
  const changes = githubAdapter.normalizeChanges(githubRaw, CTX);
  assert.equal(changes.length, 3); // the unmerged PR is dropped
  assert.deepEqual(changes[0]!.keys, ["PLAT-482"]);
  assert.deepEqual(changes[1]!.keys, ["PLAT-490"]); // key only in branch name
  assert.deepEqual(changes[2]!.keys, []); // no key anywhere
  // search-issues shape round-trips too
  const searchShape = {
    items: [{
      html_url: "https://github.com/acme/platform/pull/2001",
      title: "PLAT-500 hotfix",
      pull_request: { merged_at: "2026-08-16T10:00:00Z" },
      repository_url: "https://api.github.com/repos/acme/platform",
    }],
  };
  const fromSearch = githubAdapter.normalizeChanges(searchShape, CTX);
  assert.equal(fromSearch.length, 1);
  assert.equal(fromSearch[0]!.repo, "acme/platform");
  assert.deepEqual(fromSearch[0]!.keys, ["PLAT-500"]);
});

test("github-issues adapter: keys derived from URL leaves, real captured payload", () => {
  // The fixture is this very repo's issue list via `gh issue list --json …`
  // — the exact solo-maintainer shape that motivated the adapter: all
  // closed, none assigned, no milestones.
  const items = githubIssuesAdapter.normalizeItems(ghIssuesRaw, CTX);
  assert.equal(items.length, 15);
  for (const i of items) {
    assert.match(i.key, /^Jakeintech\/waybill#[0-9]+$/);
    assert.equal(i.done, true);
    assert.ok(i.resolved_at !== null);
    assert.equal(i.points, null); // GitHub has no estimates — never invented
  }
  const menu = items.find((i) => i.key === "Jakeintech/waybill#15")!;
  assert.equal(menu.work_type, "feature"); // label: enhancement
  assert.equal(menu.url, "https://github.com/Jakeintech/waybill/issues/15");
  assert.equal(items.find((i) => i.key === "Jakeintech/waybill#6")!.work_type, "bug");
  assert.equal(items.find((i) => i.key === "Jakeintech/waybill#7")!.work_type, "docs");
});

test("github-issues adapter: REST shape, PR rows, not_planned, and assignee scoping", () => {
  const login = defaultContext({ githubLogin: "Jakeintech" });
  const rest = [
    { // REST field names + lowercase state: accepted
      number: 1, title: "Fix the thing", state: "closed", state_reason: "completed",
      closed_at: "2026-08-01T10:00:00Z", created_at: "2026-07-30T09:00:00Z",
      updated_at: "2026-08-01T10:00:00Z", labels: [{ name: "bug" }], milestone: { title: "v1" },
      assignee: null, assignees: [], html_url: "https://github.com/Jakeintech/waybill/issues/1",
    },
    { // a PR returned by the /issues endpoint: skipped
      number: 2, title: "Some PR", state: "closed", state_reason: "completed",
      closed_at: "2026-08-02T10:00:00Z", html_url: "https://github.com/Jakeintech/waybill/pull/2",
      pull_request: { merged_at: "2026-08-02T10:00:00Z" },
    },
    { // not_planned: cancelled work, dropped like Linear's canceled
      number: 3, title: "Won't do", state: "closed", state_reason: "not_planned",
      closed_at: "2026-08-03T10:00:00Z", html_url: "https://github.com/Jakeintech/waybill/issues/3",
    },
    { // explicitly someone else's: dropped (defense in depth)
      number: 4, title: "Colleague's issue", state: "open",
      assignees: [{ login: "someone-else" }],
      html_url: "https://github.com/Jakeintech/waybill/issues/4",
    },
    { // assigned to the user (case-insensitive): kept, open
      number: 5, title: "Mine, open", state: "open",
      assignees: [{ login: "jakeintech" }],
      html_url: "https://github.com/Jakeintech/waybill/issues/5",
    },
  ];
  const items = githubIssuesAdapter.normalizeItems(rest, login);
  assert.deepEqual(items.map((i) => i.key), ["Jakeintech/waybill#1", "Jakeintech/waybill#5"]);
  const one = items[0]!;
  assert.equal(one.done, true);
  assert.equal(one.resolved_at, "2026-08-01T10:00:00Z");
  assert.equal(one.sprint, "v1");
  assert.equal(one.work_type, "bug");
  const five = items[1]!;
  assert.equal(five.done, false);
  assert.equal(five.resolved_at, null);
  // and the REST-shaped payload still passes the conformance kit
  assert.deepEqual(checkTrackerAdapter(githubIssuesAdapter, rest, login).failures, []);
});

test("conformance kit: derived keys pass only when the URL leaf re-derives them", () => {
  const raw = [{
    number: 9, title: "x", state: "closed", state_reason: "completed",
    closed_at: "2026-08-01T00:00:00Z", html_url: "https://github.com/o/r/issues/9",
  }];
  assert.deepEqual(checkTrackerAdapter(githubIssuesAdapter, raw, CTX).failures, []);
  // An adapter minting a key its own URL leaf cannot re-derive is caught.
  const lying = {
    ...githubIssuesAdapter,
    kind: "lying",
    normalizeItems: (r: unknown, c: Parameters<typeof githubIssuesAdapter.normalizeItems>[1]) =>
      githubIssuesAdapter.normalizeItems(r, c).map((i) => ({ ...i, key: "o/r#99" })),
  };
  const report = checkTrackerAdapter(lying, raw, CTX);
  assert.ok(report.failures.some((f) => f.includes("fabricated")));
});

test("extractCloses: GitHub's keyword-per-reference grammar, expanded against the repo", () => {
  const t = (s: string) => extractCloses(s, "o/r");
  assert.deepEqual(t("Fixes #12"), ["o/r#12"]);
  assert.deepEqual(t("fixed #3 and closes #4"), ["o/r#3", "o/r#4"]);
  assert.deepEqual(t("Resolves other/repo#9"), ["other/repo#9"]);
  assert.deepEqual(t("Closes: #7"), ["o/r#7"]);
  // A keyword closes only the one ref that follows it — GitHub's actual rule.
  assert.deepEqual(t("closes #1, #2"), ["o/r#1"]);
  // Mentions without a keyword are not closures.
  assert.deepEqual(t("see #5 and PR #6"), []);
  assert.deepEqual(t("fix everything eventually"), []);
  // Deduped, first-appearance order.
  assert.deepEqual(t("fixes #2\nFixes #2\ncloses #1"), ["o/r#2", "o/r#1"]);
});

test("closing-keyword linkage: PR bodies and squash commits pair with github-issues items", () => {
  // github adapter: the closing ref lives in the body, not title or branch.
  const prs = [{
    html_url: "https://github.com/o/r/pull/40",
    title: "Tighten the widget",
    body: "Refactors the frobnicator.\n\nFixes #12",
    merged_at: "2026-08-15T10:00:00Z",
    head: { ref: "tighten-widget" },
    base: { repo: { full_name: "o/r" } },
  }];
  const changes = githubAdapter.normalizeChanges(prs, CTX);
  assert.deepEqual(changes[0]!.keys, []); // nothing in title/branch — the old dead end
  assert.deepEqual(changes[0]!.closes, ["o/r#12"]);
  assert.deepEqual(checkGitHostAdapter(githubAdapter, prs, CTX).failures, []);

  // git-local: a single-parent squash commit whose body closes an issue is
  // a merged change; a plain commit without a closing ref stays invisible.
  const F = "";
  const R = "";
  const localRaw = {
    repo: "o/r",
    log:
      `abc1234abc${F}me@example.com${F}2026-08-14T12:00:00+00:00${F}p1${F}${F}feat: the widget${F}Long story.\n\nCloses #12${R}\n` +
      `def5678def${F}me@example.com${F}2026-08-14T13:00:00+00:00${F}p1${F}${F}chore: tidy${F}${R}`,
  };
  const local = gitLocalAdapter.normalizeChanges(localRaw, CTX);
  assert.equal(local.length, 1);
  assert.deepEqual(local[0]!.closes, ["o/r#12"]);
  assert.deepEqual(checkGitHostAdapter(gitLocalAdapter, localRaw, CTX).failures, []);

  // reconcile pairs via closes: the done item's orphan carries the receipts.
  const items = githubIssuesAdapter.normalizeItems(
    [{
      number: 12, title: "The widget is loose", state: "closed", state_reason: "completed",
      closed_at: "2026-08-15T09:00:00Z", html_url: "https://github.com/o/r/issues/12",
    }],
    CTX,
  );
  const plan = reconcile(items, [...changes, ...local], [], "2026-08-16T00:00:00Z");
  assert.equal(plan.orphans.length, 1);
  assert.equal(plan.orphans[0]!.tracker_key, "o/r#12");
  assert.deepEqual(plan.orphans[0]!.artifacts.prs, ["https://github.com/o/r/pull/40"]);
  assert.deepEqual(plan.orphans[0]!.artifacts.commits, ["abc1234abc"]);
  assert.equal(plan.unmatched_changes.length, 0);
});

test("conformance kit: a closes ref without a closing keyword in the payload is flagged", () => {
  const fabricating = {
    kind: "closes-fabricator",
    normalizeChanges: () => [{
      url: null, title: "x (abc1234)", repo: "o/r", branch: null,
      merged_at: "2026-08-14T12:00:00+00:00", keys: [], closes: ["o/r#99"],
    }],
  };
  const report = checkGitHostAdapter(fabricating, { any: "payload" }, CTX);
  assert.ok(report.failures.some((f) => f.includes("no closing keyword")));
});

test("conformance kit: bundled adapters pass", () => {
  const jira = checkTrackerAdapter(jiraAdapter, jiraRaw, CTX);
  assert.deepEqual(jira.failures, []);
  const ghIssues = checkTrackerAdapter(githubIssuesAdapter, ghIssuesRaw, CTX);
  assert.deepEqual(ghIssues.failures, []);
  const github = checkGitHostAdapter(githubAdapter, githubRaw, CTX);
  assert.deepEqual(github.failures, []);
  const F = "";
  const R = "";
  const localRaw = {
    repo: "acme/platform",
    log:
      `aaa111${F}me@example.com${F}2026-08-12T16:05:00+00:00${F}p1 p2${F}${F}Merge pull request #1932 PLAT-482 retry${R}\n` +
      `bbb222${F}colleague@example.com${F}2026-08-13T10:00:00+00:00${F}p1 p2${F}${F}Merge DATA-99 thing${R}`,
  };
  const local = checkGitHostAdapter(gitLocalAdapter, localRaw, CTX);
  assert.deepEqual(local.failures, []);
  const changes = gitLocalAdapter.normalizeChanges(localRaw, CTX);
  assert.equal(changes.length, 1); // colleague's merge excluded — own data only
  assert.deepEqual(changes[0]!.keys, ["PLAT-482"]);
});

test("conformance kit: catches a fabricating adapter", () => {
  const cheat = {
    kind: "cheat",
    normalizeItems: () => [{
      key: "FAKE-1", title: "invented", points: 13, epic_key: null, epic_name: null,
      sprint: null, status: "Done", done: true, resolved_at: "2026-01-01T00:00:00Z",
      created_at: null, updated_at: null, work_type: "feature" as const, url: null,
    }],
  };
  const report = checkTrackerAdapter(cheat, { issues: [] }, CTX);
  assert.equal(report.passed, false);
  assert.ok(report.failures.some((f) => f.includes("fabricated") || f.includes("not present")));
});

test("reconcile: shipped proposal carries escrow, artifacts, and tracker facts", () => {
  const opened = makeOpened(); // PLAT-482, pre-registered + sealed
  const items = jiraAdapter.normalizeItems(jiraRaw, CTX);
  const changes = githubAdapter.normalizeChanges(githubRaw, CTX);
  const plan = reconcile(items, changes, [opened], "2026-08-16T12:00:00Z");
  assert.equal(plan.shipped.length, 1);
  const s = plan.shipped[0]!;
  assert.equal(s.kind, "shipped");
  assert.equal(s.supersedes, opened.id);
  assert.equal(s.points, 5);
  assert.deepEqual(s.artifacts.prs, ["https://github.com/acme/platform/pull/1932"]);
  assert.equal(s.escrow, opened.escrow); // the seal travels with the claim
  assert.equal(s.ts, "2026-08-12T16:02:11.000+0000"); // max(resolved_at, merged_at)
  // orphan: PLAT-490 is done with no ledger entry
  assert.equal(plan.orphans.length, 1);
  assert.equal(plan.orphans[0]!.tracker_key, "PLAT-490");
  assert.equal(plan.orphans[0]!.claude_role, "none");
  assert.match(plan.orphans[0]!.notes ?? "", /involvement unrecorded/);
  // unmatched: the keyless refactor PR is listed, never silently dropped
  assert.equal(plan.unmatched_changes.length, 1);
  // DATA-77 is not done: nothing proposed
  assert.ok(!plan.shipped.some((b) => b.tracker_key === "DATA-77"));
});

test("reconcile: field drift on a shipped entry proposes a correction", () => {
  const opened = makeOpened();
  const items = jiraAdapter.normalizeItems(jiraRaw, CTX);
  const changes = githubAdapter.normalizeChanges(githubRaw, CTX);
  const first = reconcile(items, changes, [opened], "2026-08-16T12:00:00Z");
  // Apply the shipped proposal, then drift the tracker's points.
  const shippedEvent = finalizeEvent("ledger", first.shipped[0]!) as LedgerEntry;
  const drifted = structuredClone(jiraRaw) as { issues: Array<{ key: string; fields: Record<string, unknown> }> };
  drifted.issues.find((i) => i.key === "PLAT-482")!.fields["customfield_10016"] = 8;
  const items2 = jiraAdapter.normalizeItems(drifted, CTX);
  const plan2 = reconcile(items2, changes, [opened, shippedEvent], "2026-08-17T12:00:00Z");
  assert.equal(plan2.corrections.length, 1);
  assert.deepEqual(plan2.corrections[0]!.drift, ["points 5 → 8"]);
  assert.equal(plan2.corrections[0]!.body.supersedes, shippedEvent.id);
});

test("baseline: medians over sprints and cycle times", () => {
  const items = jiraAdapter.normalizeItems(jiraRaw, CTX);
  const b = deriveBaseline(items, "2026-Q2");
  // done items: PLAT-482 (S17, 5pts, ~4.3d), PLAT-490 (S17, 1pt, ~1.1d)
  assert.equal(b.velocity_points_per_sprint, 6); // one sprint bucket: 5+1
  assert.equal(b.median_cycle_time_days, 2.7); // median of 4.3 and 1.1
  assert.match(b.derived_from, /2 resolved item\(s\)/);
});

test("e2e sync-plan CLI: plan then apply, escrow intact, verify green", () => {
  const home = mkdtempSync(join(tmpdir(), "wb-sync-"));
  const work = mkdtempSync(join(tmpdir(), "wb-sync-work-"));
  try {
    const cli = (args: string[]): string =>
      execFileSync(process.execPath, [join(ROOT, "src", "cli", "main.ts"), ...args], {
        encoding: "utf8",
        env: { ...process.env, WAYBILL_HOME: home },
      });
    // Seed an open, escrowed entry through the real write path.
    const opened = makeOpened();
    const { id: _id, ...openedBody } = opened;
    cli(["append", "--stream", "ledger", "--event", JSON.stringify(openedBody)]);
    // Plan from fixtures.
    writeFileSync(join(work, "items.json"), JSON.stringify(jiraRaw), "utf8");
    writeFileSync(join(work, "changes.json"), JSON.stringify(githubRaw), "utf8");
    const planOut = cli([
      "sync-plan", "--tracker", "jira", "--items", join(work, "items.json"),
      "--git", "github", "--changes", join(work, "changes.json"),
      "--baseline", "--now", "2026-08-16T12:00:00Z",
    ]);
    const plan = JSON.parse(planOut) as { shipped: unknown[]; orphans: unknown[]; baseline: unknown };
    assert.equal(plan.shipped.length, 1);
    writeFileSync(join(work, "plan.json"), planOut, "utf8");
    const applyOut = cli(["sync-plan", "--apply", join(work, "plan.json")]);
    assert.match(applyOut, /"applied":2/);
    // Escrow survived the round trip; ledger verifies.
    const entries = readEvents<LedgerEntry>(home, "ledger");
    const shipped = entries.find((e) => e.kind === "shipped" && e.tracker_key === "PLAT-482")!;
    assert.equal(checkEscrow(shipped).status, "ok");
    const verify = cli(["verify"]);
    assert.match(verify, /All checks passed/);
    // Re-apply is a no-op (deterministic ids dedupe).
    const applyAgain = cli(["sync-plan", "--apply", join(work, "plan.json")]);
    assert.match(applyAgain, /"applied":0/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});
