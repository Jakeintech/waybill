// v1.7 "Bill of lading" batch — regression tests per feature: the
// verification pack (export --pack, recipient-side verify), derived cache
// economics, model mix over shipped points, estimate calibration, the
// multi-machine remote line in status, and the conformance kit's own-data
// scoping check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { reportData, spendData } from "../../src/projections/queries.ts";
import { defaultConfig, type Config } from "../../src/core/config.ts";
import { finalizeEvent, SCHEMA_VERSION, type LedgerEntry } from "../../src/core/events.ts";
import { appendEvents } from "../../src/core/streams.ts";
import { sha256Hex } from "../../src/core/sha.ts";
import { checkOwnDataScoping } from "../../src/adapters/conformance.ts";
import { defaultContext, type TrackerAdapter } from "../../src/adapters/contract.ts";
import { jiraAdapter } from "../../src/adapters/jira.ts";
import { githubAdapter } from "../../src/adapters/github.ts";
import { makeOpened, makeSessionReceipt, makeUsage, tempHome, writeValidHome } from "../helpers/fixtures.ts";

const ROOT = join(import.meta.dirname, "..", "..");

function cli(home: string, args: string[], expectFail = false): { stdout: string; stderr: string; code: number } {
  try {
    const stdout = execFileSync(process.execPath, [join(ROOT, "src", "cli", "main.ts"), ...args], {
      encoding: "utf8",
      env: { ...process.env, WAYBILL_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { stdout, stderr: "", code: 0 };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    if (!expectFail) throw err;
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: e.status ?? -1 };
  }
}

function pricedConfig(): Config {
  const config = defaultConfig();
  config.pricing = {
    version: "2026-08-01",
    unknown_model_policy: "tokens_only",
    models: {
      "claude-opus-4-6": {
        input_per_mtok: 15, output_per_mtok: 75, cache_read_per_mtok: 1.5,
        cache_write_5m_per_mtok: 18.75, cache_write_1h_per_mtok: 30,
      },
    },
  };
  return config;
}

/** Like queries.test.ts's shippedFrom, but honest about explicit nulls
 * (actual_hours: null must stay null — calibration depends on it). */
function shippedFrom(opened: LedgerEntry, overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  const { id: _id, ...body } = opened;
  return finalizeEvent("ledger", {
    ...body,
    ts: overrides.ts ?? "2026-08-12T16:30:00Z",
    kind: "shipped" as const,
    supersedes: opened.id,
    artifacts: { prs: ["https://github.com/acme/platform/pull/1932"], commits: [], deploy: null, docs: [] },
    actual_hours: "actual_hours" in overrides ? (overrides.actual_hours ?? null) : 4.5,
    claude_role: "co_wrote" as const,
  }) as LedgerEntry;
}

test("cache_savings: derived from the current rate table, coverage stated, null when unpriced", () => {
  const usage = [
    makeUsage({ ts: "2026-08-11T10:00:00Z", turnIndex: 1, tokens: { input: 0, output: 0, cache_read: 1_000_000, cache_creation: 0 } }),
    makeUsage({ ts: "2026-08-11T11:00:00Z", turnIndex: 2, model: "acme-custom-llm", tokens: { input: 0, output: 0, cache_read: 500_000, cache_creation: 0 } }),
  ];
  const spend = spendData(usage, [], [], pricedConfig(), { from: null, to: null });
  assert.equal(spend.cache_savings.cache_read_tokens, 1_500_000);
  assert.equal(spend.cache_savings.cache_read_pct, 100);
  // 1M cache-read tokens × ($15 input − $1.5 cache-read)/mtok = $13.50;
  // the custom model has no rate, so it contributes volume but no dollars.
  assert.equal(spend.cache_savings.saved_usd, 13.5);
  assert.equal(spend.cache_savings.covered_pct, 66.7);
  assert.equal(spend.cache_savings.basis, "list_price_equivalent_derived");

  const unpriced = spendData(usage, [], [], defaultConfig(), { from: null, to: null });
  assert.equal(unpriced.cache_savings.saved_usd, null);
  assert.equal(unpriced.cache_savings.covered_pct, 0);
});

test("model_mix: >50% dominance buckets the story's FULL spend; an even split lands in mixed", () => {
  const config = defaultConfig();
  const a = makeOpened(); // PLAT-482, 5 pts
  const b = makeOpened({ tracker_key: "DATA-77", title: "Ingest dedupe", ts: "2026-08-11T09:00:00Z", points: 3 });
  const ledger = [a, shippedFrom(a), b, shippedFrom(b, { ts: "2026-08-12T17:00:00Z" })];
  const usage = [
    makeUsage({ ts: "2026-08-11T10:00:00Z", turnIndex: 1, tokens: { input: 800_000, output: 0, cache_read: 0, cache_creation: 0 } }),
    makeUsage({ ts: "2026-08-11T11:00:00Z", turnIndex: 2, model: "claude-sonnet-5", tokens: { input: 200_000, output: 0, cache_read: 0, cache_creation: 0 } }),
    makeUsage({ ts: "2026-08-12T10:00:00Z", turnIndex: 3, account: "story:DATA-77", tokens: { input: 500_000, output: 0, cache_read: 0, cache_creation: 0 } }),
    makeUsage({ ts: "2026-08-12T11:00:00Z", turnIndex: 4, account: "story:DATA-77", model: "claude-sonnet-5", tokens: { input: 500_000, output: 0, cache_read: 0, cache_creation: 0 } }),
  ];
  const report = reportData(ledger, usage, [], config, { from: null, to: null });
  assert.deepEqual(report.model_mix.by_model, [
    { model: "claude-opus-4-6", stories: 1, points: 5, tokens: 1_000_000, tokens_per_point: 200_000 },
  ]);
  assert.deepEqual(report.model_mix.mixed, { stories: 1, points: 3, tokens: 1_000_000 });
});

test("calibration: positions vs the pre-registered range, coverage honest, above-range surfaced", () => {
  const config = defaultConfig();
  const below = makeOpened(); // low 10 high 16, shipped actual 4.5 → below
  const within = makeOpened({
    tracker_key: "DATA-77", title: "Ingest dedupe", ts: "2026-08-11T09:00:00Z",
    estimate_without_claude_hours: { low: 2, high: 4, logged_at: "2026-08-11T09:00:00Z", pre_registered: true },
  });
  const above = makeOpened({
    tracker_key: "PLAT-999", title: "Flaky auth spike", ts: "2026-08-11T10:00:00Z",
    estimate_without_claude_hours: { low: 1, high: 2, logged_at: "2026-08-11T10:00:00Z", pre_registered: true },
  });
  const judged = makeOpened({
    tracker_key: "PLAT-555", title: "Estimate logged after the fact", ts: "2026-08-11T11:00:00Z",
    estimate_without_claude_hours: { low: 3, high: 5, logged_at: "2026-08-11T11:00:00Z", pre_registered: false },
    escrow: null,
  });
  const noActual = makeOpened({ tracker_key: "PLAT-777", title: "Actuals never recorded", ts: "2026-08-11T12:00:00Z" });
  const ledger = [
    below, shippedFrom(below),
    within, shippedFrom(within, { ts: "2026-08-12T17:00:00Z", actual_hours: 3 }),
    above, shippedFrom(above, { ts: "2026-08-12T18:00:00Z", actual_hours: 5 }),
    judged, shippedFrom(judged, { ts: "2026-08-12T19:00:00Z", actual_hours: 4 }),
    noActual, shippedFrom(noActual, { ts: "2026-08-12T20:00:00Z", actual_hours: null }),
  ];
  const cal = reportData(ledger, [], [], config, { from: null, to: null }).calibration;
  assert.equal(cal.shipped, 5);
  assert.equal(cal.pre_registered, 4);
  assert.equal(cal.coverage_pct, 80);
  assert.equal(cal.with_actuals, 3);
  assert.equal(cal.actual_below_range, 1);
  assert.equal(cal.actual_within_range, 1);
  assert.equal(cal.actual_above_range, 1);
  assert.deepEqual(
    cal.entries.map((e) => [e.tracker_key, e.position]),
    [["DATA-77", "within"], ["PLAT-482", "below"], ["PLAT-999", "above"]],
  );
});

test("export --pack: session-complete pack, hashes recompute, and the bundled engine verifies it green", () => {
  const home = tempHome();
  const { usage } = writeValidHome(home); // session in 2026-08, in window
  const inWindowSession = usage[0]!.session_id;
  // A second session entirely outside the window — must not travel.
  const outUsage = [
    makeUsage({ ts: "2026-07-10T10:00:00Z", session_id: "77777777-aaaa-4bbb-8ccc-000000000007", turnIndex: 1 }),
  ];
  appendEvents(home, "usage", outUsage);
  appendEvents(home, "sessions", [makeSessionReceipt(outUsage)]);
  // Exceptions: an ambiguity for the in-window session (travels, with its
  // resolution) and one for the out-of-window session (stays home).
  const amb = finalizeEvent("exceptions", {
    ts: "2026-08-17T10:16:00Z", kind: "ambiguity" as const, schema_version: SCHEMA_VERSION, supersedes: null,
    session_id: inWindowSession, turn: { index: 1, first_message_id: "msg_first_1" },
    rule: "rule3", candidates: ["story:PLAT-482", "story:DATA-77"], status: "open" as const,
  });
  const res = finalizeEvent("exceptions", {
    ts: "2026-08-17T11:00:00Z", kind: "resolution" as const, schema_version: SCHEMA_VERSION, supersedes: null,
    resolves: amb.id, account: "story:PLAT-482", durable: null,
  });
  const outAmb = finalizeEvent("exceptions", {
    ts: "2026-07-10T10:16:00Z", kind: "ambiguity" as const, schema_version: SCHEMA_VERSION, supersedes: null,
    session_id: "77777777-aaaa-4bbb-8ccc-000000000007", turn: { index: 1, first_message_id: "msg_first_1" },
    rule: "rule3", candidates: ["story:PLAT-482"], status: "open" as const,
  });
  appendEvents(home, "exceptions", [amb, res, outAmb]);
  writeFileSync(join(home, "config.json"), JSON.stringify(pricedConfig(), null, 2) + "\n", "utf8");

  const dir = join(tempHome(), "pack");
  const run = cli(home, [
    "export", "--pack", "--out", dir,
    "--from", "2026-08-01", "--to", "2026-08-31", "--now", "2026-08-22T12:00:00Z",
  ]);
  assert.match(run.stdout, /verification pack: /);
  assert.match(run.stdout, /1 session\(s\)/);

  const pack = JSON.parse(readFileSync(join(dir, "pack.json"), "utf8")) as {
    kind: string; sessions: number; events: Record<string, number>;
    engine_included: boolean; config_included: boolean; files: Record<string, string>;
  };
  assert.equal(pack.kind, "waybill-verification-pack");
  assert.equal(pack.sessions, 1);
  assert.equal(pack.events["usage"], 2);
  assert.equal(pack.events["exceptions"], 2); // in-window ambiguity + its resolution
  assert.equal(pack.engine_included, true);
  assert.equal(pack.config_included, true);
  for (const [rel, hash] of Object.entries(pack.files)) {
    assert.equal(sha256Hex(readFileSync(join(dir, rel), "utf8")), hash, `${rel}: pack.json hash must recompute`);
  }
  const packedUsage = readFileSync(join(dir, "streams", "usage", "2026-08.jsonl"), "utf8");
  assert.ok(!packedUsage.includes("77777777-aaaa"), "out-of-window session must not travel");
  // The recipient's actual move: run the engine that came in the box.
  const verdict = execFileSync(process.execPath, [join(dir, "waybill.mjs"), "verify", "--home", dir], {
    encoding: "utf8",
  });
  assert.match(verdict, /All checks passed/);
});

test("export --pack: refuses a ledger that does not verify green", () => {
  const home = tempHome();
  writeValidHome(home);
  // Tamper: bump a token count without recomputing the id.
  const shard = join(home, "streams", "usage", "2026-08.jsonl");
  const lines = readFileSync(shard, "utf8").trim().split("\n");
  const tampered = JSON.parse(lines[0]!) as { tokens: { input: number } };
  tampered.tokens.input += 1;
  writeFileSync(shard, [JSON.stringify(tampered), ...lines.slice(1)].join("\n") + "\n", "utf8");

  const run = cli(home, ["export", "--pack", "--out", join(tempHome(), "pack")], true);
  assert.equal(run.code, 1);
  assert.match(run.stderr, /refusing to pack an unverified ledger/);
});

test("export --pack: refuses a non-empty output directory; --audience is rejected outright", () => {
  const home = tempHome();
  writeValidHome(home);
  const dir = join(tempHome(), "pack");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "keep.txt"), "user data\n", "utf8");
  const run = cli(home, ["export", "--pack", "--out", dir], true);
  assert.equal(run.code, 1);
  assert.match(run.stderr, /not empty/);

  const redacted = cli(home, ["export", "--pack", "--audience", "external"], true);
  assert.equal(redacted.code, 2);
  assert.match(redacted.stderr, /cannot be redacted/);
});

test("status: remote ahead/behind from local refs only", () => {
  const home = tempHome();
  const bare = join(tempHome(), "origin.git");
  const git = (...args: string[]): string =>
    execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "--bare", bare);
  git("-C", home, "init", "-b", "main");
  writeFileSync(join(home, "config.json"), JSON.stringify(defaultConfig(), null, 2) + "\n", "utf8");
  git("-C", home, "add", "config.json");
  git("-C", home, "-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-m", "init");
  git("-C", home, "remote", "add", "origin", bare);
  git("-C", home, "push", "-u", "origin", "main");
  writeFileSync(join(home, "note.txt"), "ahead\n", "utf8");
  git("-C", home, "add", "note.txt");
  git("-C", home, "-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-m", "ahead");

  const out = cli(home, ["status", "--json"]);
  const { data } = JSON.parse(out.stdout) as {
    data: { remote: { git_backed: boolean; upstream: string | null; ahead: number | null; behind: number | null } };
  };
  assert.equal(data.remote.git_backed, true);
  assert.equal(data.remote.upstream, "origin/main");
  assert.equal(data.remote.ahead, 1);
  assert.equal(data.remote.behind, 0);
});

test("conformance own-data: bundled jira and github adapters drop foreign records; identity only narrows", () => {
  const jiraRaw = JSON.parse(
    readFileSync(join(import.meta.dirname, "..", "fixtures", "adapters", "jira-acli-views.json"), "utf8"),
  ) as unknown;
  const jiraReport = checkOwnDataScoping(
    jiraAdapter, jiraRaw,
    defaultContext({ jiraAccountId: "5b10a2844c20165700ede21g" }),
    ["PLAT-491"],
  );
  assert.deepEqual(jiraReport.failures, []);
  assert.equal(jiraReport.passed, true);

  const ghRaw = JSON.parse(
    readFileSync(join(import.meta.dirname, "..", "fixtures", "adapters", "github-gh-pr-list.json"), "utf8"),
  ) as unknown;
  const ghReport = checkOwnDataScoping(
    githubAdapter, ghRaw,
    defaultContext({ githubLogin: "a-engineer" }),
    ["https://github.com/acme/platform/pull/1940"],
  );
  assert.deepEqual(ghReport.failures, []);
});

test("conformance own-data: an identity-blind adapter fails; a vacuous fixture is refused", () => {
  const raw = [
    { key: "PLAT-1", assignee: "me" },
    { key: "PLAT-2", assignee: "someone-else" },
  ];
  const blind: TrackerAdapter = {
    kind: "identity-blind",
    normalizeItems: (r) =>
      (r as Array<{ key: string }>).map((i) => ({
        key: i.key, title: i.key, points: null, epic_key: null, epic_name: null, sprint: null,
        status: "Done", done: true, resolved_at: null, created_at: null, updated_at: null,
        work_type: "feature" as const, url: null,
      })),
  };
  const report = checkOwnDataScoping(blind, raw, defaultContext({ jiraAccountId: "me-id" }), ["PLAT-2"]);
  assert.equal(report.passed, false);
  assert.ok(report.failures.some((f) => f.includes("survived the identity check")));

  const vacuous = checkOwnDataScoping(blind, raw, defaultContext({ jiraAccountId: "me-id" }), ["PLAT-404"]);
  assert.ok(vacuous.failures.some((f) => f.includes("proves nothing")));
});
