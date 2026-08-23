// The 1.5.0 architecture-review batch — one regression test per confirmed
// finding fixed in this release (see docs/architecture.md for the review
// record). Grouped by subsystem, smallest-possible reproductions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { normalizeWindow } from "../../src/projections/queries.ts";
import { resolveStandupWindow, standupData } from "../../src/projections/standup.ts";
import { resolveRate } from "../../src/core/pricing-resolve.ts";
import { priceTokens } from "../../src/meter/meter.ts";
import { meterFile } from "../../src/meter/run.ts";
import { isPromptLine } from "../../src/meter/transcript.ts";
import { parseGitLog } from "../../src/gitlocal/gitlocal.ts";
import { gitLocalAdapter } from "../../src/adapters/gitlocal-adapter.ts";
import { githubAdapter } from "../../src/adapters/github.ts";
import { gitlabAdapter } from "../../src/adapters/gitlab.ts";
import { linearAdapter } from "../../src/adapters/linear.ts";
import { defaultContext } from "../../src/adapters/contract.ts";
import { verifyHome } from "../../src/verify/verify.ts";
import { appendEvents } from "../../src/core/streams.ts";
import { defaultConfig } from "../../src/core/config.ts";
import { finalizeEvent, SCHEMA_VERSION, type LedgerEntry } from "../../src/core/events.ts";
import { makeOpened, makeUsage, tempHome, writeValidHome } from "../helpers/fixtures.ts";

const ROOT = join(import.meta.dirname, "..", "..");

function cli(home: string, args: string[], expectFail = false): { stdout: string; code: number } {
  try {
    const stdout = execFileSync(process.execPath, [join(ROOT, "src", "cli", "main.ts"), ...args], {
      encoding: "utf8",
      env: { ...process.env, WAYBILL_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { stdout, code: 0 };
  } catch (err) {
    const e = err as { status?: number; stdout?: string };
    if (!expectFail) throw err;
    return { stdout: e.stdout ?? "", code: e.status ?? -1 };
  }
}

test("normalizeWindow: parseable non-ISO bounds are rejected, not silently empty", () => {
  assert.throws(() => normalizeWindow("8/1/2026", null), /ISO/);
  assert.throws(() => normalizeWindow(null, "Aug 20 2026"), /ISO/);
  assert.equal(normalizeWindow("2026-08-01", "2026-08-20").to, "2026-08-20T23:59:59.999Z");
  assert.equal(normalizeWindow("2026-08-01T10:00:00Z", null).from, "2026-08-01T10:00:00Z");
});

test("standup: impossible calendar dates are refused; shipped-earlier spend is labeled", () => {
  assert.throws(
    () => resolveStandupWindow({ date: "2026-02-30", days: null, from: null, to: null }, new Date()),
    /real calendar date/,
  );

  const config = defaultConfig();
  const opened = makeOpened({ ts: "2026-07-01T09:00:00Z" });
  const { id: _id, ...body } = opened;
  const shippedLongAgo = finalizeEvent("ledger", {
    ...body,
    ts: "2026-07-10T12:00:00Z", // shipped well before the window
    kind: "shipped" as const,
    supersedes: opened.id,
  }) as LedgerEntry;
  const usage = [
    makeUsage({ ts: "2026-08-20T10:00:00Z", turnIndex: 1, tokens: { input: 100, output: 0, cache_read: 0, cache_creation: 0 } }),
  ];
  const d = standupData([opened, shippedLongAgo], usage, [], [], config, {
    from: "2026-08-20T00:00:00Z",
    to: "2026-08-20T23:59:59.999Z",
  });
  assert.equal(d.shipped.length, 0); // shipped outside the window
  assert.equal(d.progressed.length, 1); // but yesterday's spend still shows
  assert.equal(d.progressed[0]!.shipped_earlier, true); // labeled as follow-up
});

test("pricing: prototype-name model ids never resolve; unsplit cache remainder prices at 5m", () => {
  const pricing = {
    version: "2026-08-17",
    unknown_model_policy: "tokens_only" as const,
    models: {},
  };
  assert.equal(resolveRate(pricing, "constructor"), null);
  assert.equal(resolveRate(pricing, "__proto__"), null);
  assert.equal(resolveRate(pricing, "toString"), null);

  const config = defaultConfig();
  config.pricing.version = "2026-08-17";
  config.pricing.models["m"] = {
    input_per_mtok: 0, output_per_mtok: 0, cache_read_per_mtok: 0,
    cache_write_5m_per_mtok: 10, cache_write_1h_per_mtok: 100,
  };
  // Split says 100 (5m) + 200 (1h) but cache_creation is 1,000,000: the
  // 800k remainder prices at the 5m rate instead of silently at zero.
  const cost = priceTokens(config, "m", {
    input: 0, output: 0, cache_read: 0,
    cache_creation: 1_000_000, cache_creation_5m: 100, cache_creation_1h: 200,
  });
  // (1,000,000 - 200) × 10/mtok + 200 × 100/mtok ≈ 9.998 + 0.02
  assert.equal(cost!.value, 10.018);
});

test("meter: a duplicate transcript file for one sessionId is skipped, not flip-flopped", () => {
  const home = tempHome();
  const dir = tempHome();
  try {
    cli(home, ["init", "--projects-dir", "/nonexistent-projects", "--claude-settings", "/nonexistent"]);
    const src = join(ROOT, "tests", "fixtures", "transcripts", "v2.1", "basic.jsonl");
    const a = join(dir, "a.jsonl");
    const b = join(dir, "b.jsonl"); // a backup copy of the same session
    copyFileSync(src, a);
    copyFileSync(src, b);
    const first = meterFile(home, a, "acme/platform");
    assert.equal(first.skipped, false);
    const dup = meterFile(home, b, "acme/platform");
    assert.equal(dup.skipped, true, "the copy must not supersede the checkpointed file");
    const again = meterFile(home, a, "acme/platform");
    assert.equal(again.skipped, true); // checkpoint current
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("transcript: an image-only user message is a turn boundary", () => {
  assert.equal(
    isPromptLine({
      type: "user",
      message: { role: "user", content: [{ type: "image" }] },
    } as never),
    true,
  );
  assert.equal(
    isPromptLine({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result" }] },
    } as never),
    false,
  );
});

test("git-local: merged_at uses the committer date; pre-committer-date logs still parse", () => {
  const F = "";
  const R = "";
  const newFormat =
    `abc123${F}dev@acme.com${F}2026-08-03T09:00:00+02:00${F}2026-08-21T16:00:00+02:00${F}p1 p2${F}${F}PLAT-1: merge${F}${R}`;
  const commits = parseGitLog(newFormat);
  assert.equal(commits[0]!.committer_date, "2026-08-21T16:00:00+02:00");
  const changes = gitLocalAdapter.normalizeChanges({ repo: "acme/platform", log: newFormat }, defaultContext());
  assert.equal(changes[0]!.merged_at, "2026-08-21T16:00:00+02:00");

  const oldFormat = `abc123${F}dev@acme.com${F}2026-08-03T09:00:00+02:00${F}p1 p2${F}${F}PLAT-1: merge${F}${R}`;
  const legacy = parseGitLog(oldFormat);
  assert.equal(legacy[0]!.committer_date, "");
  assert.equal(legacy[0]!.parents, 2);
  const legacyChanges = gitLocalAdapter.normalizeChanges({ repo: "acme/platform", log: oldFormat }, defaultContext());
  assert.equal(legacyChanges[0]!.merged_at, "2026-08-03T09:00:00+02:00"); // fallback
});

test("gitlab/linear adapters: own-data defense-in-depth when identity fields are set", () => {
  const mrs = [
    { web_url: "https://gitlab.com/g/p/-/merge_requests/1", title: "mine", source_branch: "b", merged_at: "2026-08-20T10:00:00Z", author: { username: "me" } },
    { web_url: "https://gitlab.com/g/p/-/merge_requests/2", title: "theirs", source_branch: "b2", merged_at: "2026-08-20T11:00:00Z", author: { username: "colleague" } },
  ];
  const scoped = gitlabAdapter.normalizeChanges(mrs, defaultContext({ gitlabUsername: "me" }));
  assert.deepEqual(scoped.map((c) => c.title), ["mine"]);
  // Unset identity keeps everything (query-scoping remains the first line).
  assert.equal(gitlabAdapter.normalizeChanges(mrs, defaultContext()).length, 2);

  const issues = [
    { identifier: "ENG-1", title: "mine", state: { name: "Done", type: "completed" }, completedAt: "2026-08-20T10:00:00Z", assignee: { id: "me" } },
    { identifier: "ENG-2", title: "theirs", state: { name: "Done", type: "completed" }, completedAt: "2026-08-20T11:00:00Z", assignee: { id: "colleague" } },
  ];
  const ctx = defaultContext({ keyPattern: "[A-Z]+-[0-9]+", linearUserId: "me" });
  assert.deepEqual(linearAdapter.normalizeItems(issues, ctx).map((i) => i.key), ["ENG-1"]);
});

test("verify: forked supersession and torn lines are findings, not crashes", () => {
  const home = tempHome();
  try {
    const { opened } = writeValidHome(home);
    const { id: _a, ...body } = opened;
    const fork1 = finalizeEvent("ledger", { ...body, ts: "2026-08-18T10:00:00Z", kind: "correction" as const, supersedes: opened.id, notes: "fork one" }) as LedgerEntry;
    const fork2 = finalizeEvent("ledger", { ...body, ts: "2026-08-18T11:00:00Z", kind: "correction" as const, supersedes: opened.id, notes: "fork two" }) as LedgerEntry;
    appendEvents(home, "ledger", [fork1, fork2]);
    const findings = verifyHome(home);
    assert.ok(findings.some((f) => f.message.includes("forked chain")), "forked supersession must surface");

    // A torn trailing line is reported, and no command crashes over it.
    const shard = join(home, "streams", "ledger", "2026-08.jsonl");
    writeFileSync(shard, readFileSync(shard, "utf8") + '{"id":"torn', "utf8");
    const withTorn = verifyHome(home);
    assert.ok(withTorn.some((f) => f.message.includes("unparseable line")));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("append: a pre_registered estimate without logged_at is refused even with a pre-built escrow", () => {
  const home = tempHome();
  try {
    mkdirSync(home, { recursive: true });
    const body = {
      ts: "2026-08-20T10:00:00Z",
      kind: "opened",
      title: "No timestamp escrow",
      tracker_key: "PLAT-9",
      epic_key: null, epic_name: null, sprint: null, repo: null,
      work_type: "feature", points: null,
      artifacts: { prs: [], commits: [], deploy: null, docs: [] },
      estimate_without_claude_hours: { low: 1, high: 2, pre_registered: true },
      escrow: { algo: "sha256", payload: "estimate.v1", sha256: "0".repeat(64) },
      actual_hours: null, claude_role: "none", sessions: [], tokens: null,
      budget_tokens: null, time_saved_hours: null, notes: null,
    };
    const r = cli(home, ["append", "--stream", "ledger", "--event", JSON.stringify(body)], true);
    assert.equal(r.code, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("bootstrap: --to actually bounds the token section", () => {
  const home = tempHome();
  try {
    appendEvents(home, "usage", [
      makeUsage({ ts: "2026-03-10T10:00:00Z", turnIndex: 1, tokens: { input: 100, output: 0, cache_read: 0, cache_creation: 0 } }),
      makeUsage({ ts: "2026-08-10T10:00:00Z", turnIndex: 2, tokens: { input: 999, output: 0, cache_read: 0, cache_creation: 0 } }),
    ]);
    const { stdout } = cli(home, ["bootstrap", "--json", "--from", "2026-03-01", "--to", "2026-03-31"]);
    const data = JSON.parse(stdout) as { until: string; tokens: { totals: { input: number } } | null };
    assert.equal(data.until, "2026-03-31");
    assert.equal(data.tokens!.totals.input, 100, "the August event must stay outside the March receipt");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("sync-plan --apply: duplicate bodies within one plan append once", () => {
  const home = tempHome();
  try {
    mkdirSync(home, { recursive: true });
    const opened = makeOpened({ ts: "2026-08-10T09:00:00Z" });
    const { id: _id, ...body } = opened;
    const shippedBody = {
      ...body,
      ts: "2026-08-20T10:00:00Z",
      kind: "shipped",
      supersedes: null,
      schema_version: SCHEMA_VERSION,
    };
    const plan = {
      generated_at: "2026-08-21T00:00:00Z",
      shipped: [shippedBody, shippedBody], // same issue twice in the payload
      corrections: [],
      orphans: [],
      unmatched_changes: [],
      baseline: null,
      summary: { open_entries: 0, done_items: 1, merged_changes: 0 },
    };
    const planPath = join(home, "plan.json");
    writeFileSync(planPath, JSON.stringify(plan));
    const { stdout } = cli(home, ["sync-plan", "--apply", planPath]);
    assert.equal((JSON.parse(stdout) as { applied: number }).applied, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("standup: the Started section survives shipping/corrections (chain-aware opened)", () => {
  const config = defaultConfig();
  const opened = makeOpened({ ts: "2026-08-18T09:00:00Z" }); // opened Tuesday
  const { id: _id, ...body } = opened;
  const shipped = finalizeEvent("ledger", {
    ...body,
    ts: "2026-08-20T15:00:00Z", // ships Thursday — supersedes the opened event
    kind: "shipped" as const,
    supersedes: opened.id,
  }) as LedgerEntry;
  const tuesday = standupData([opened, shipped], [], [], [], config, {
    from: "2026-08-18T00:00:00Z",
    to: "2026-08-18T23:59:59.999Z",
  });
  assert.equal(tuesday.opened.length, 1, "Tuesday's digest must still show what was started Tuesday");
  assert.equal(tuesday.opened[0]!.tracker_key, "PLAT-482");
  assert.equal(tuesday.opened[0]!.ts, "2026-08-18T09:00:00Z"); // origin ts, not the ship ts
});

test("windows compare instants: a second-precision ts in the day's last second stays inside", () => {
  const config = defaultConfig();
  const usage = [
    makeUsage({ ts: "2026-08-20T23:59:59Z", turnIndex: 1, tokens: { input: 77, output: 0, cache_read: 0, cache_creation: 0 } }),
  ];
  const d = standupData([], usage, [], [], config, {
    from: "2026-08-20T00:00:00.000Z",
    to: "2026-08-20T23:59:59.999Z",
  });
  assert.equal(d.tokens.total, 77, "…59Z must not sort after the …59.999Z bound");
});

test("unknown model: tokens count as unpriced, but no list names it as a fixable model", async () => {
  const { spendData } = await import("../../src/projections/queries.ts");
  const config = defaultConfig();
  config.pricing.version = "2026-08-17";
  const usage = [
    makeUsage({ ts: "2026-08-20T10:00:00Z", turnIndex: 1, model: "unknown", tokens: { input: 50, output: 0, cache_read: 0, cache_creation: 0 } }),
  ];
  const spend = spendData(usage, [], [], config, { from: null, to: null });
  assert.equal(spend.pricing_coverage.unpriced_tokens, 50);
  assert.deepEqual(spend.pricing_coverage.unpriced_event_models, []);
  const d = standupData([], usage, [], [], config, { from: null, to: null });
  assert.equal(d.tokens.unpriced_tokens, 50);
  assert.deepEqual(d.tokens.unpriced_models, []);
});

test("github adapter: GitHub Enterprise hosts derive the repo from the PR URL too", () => {
  const rows = [
    {
      url: "https://ghe.corp.example/platform-team/checkout/pull/88",
      title: "PLAT-482: retry logic",
      headRefName: "feat/PLAT-482-retry",
      mergedAt: "2026-08-20T10:00:00Z",
      body: "",
      author: { login: "me" },
    },
  ];
  const changes = githubAdapter.normalizeChanges(rows, defaultContext({ githubLogin: "me" }));
  assert.equal(changes.length, 1);
  assert.equal(changes[0]!.repo, "platform-team/checkout");
});

test("query: typo'd flags and missing values error instead of silently widening the window", () => {
  const home = tempHome();
  try {
    mkdirSync(home, { recursive: true });
    assert.equal(cli(home, ["query", "spend", "--widnow", "x"], true).code, 2);
    assert.equal(cli(home, ["query", "spend", "--from"], true).code, 2);
    assert.equal(cli(home, ["export", "--from"], true).code, 2);
    assert.equal(cli(home, ["pace", "--now", "not-a-date"], true).code, 2);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
