// v1.6 "Salvage" batch — regression tests per feature: overhead tagging
// (the lightweight doctrine), the untracked-work clustering behind the
// salvage skill, the manifest/demurrage projection, the conventions
// command, and the zero-token dashboard.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseTranscript } from "../../src/meter/transcript.ts";
import { meterTranscript } from "../../src/meter/meter.ts";
import { spendData } from "../../src/projections/queries.ts";
import { manifestData } from "../../src/projections/manifest.ts";
import { untrackedData } from "../../src/projections/untracked.ts";
import { defaultConfig } from "../../src/core/config.ts";
import { finalizeEvent, type LedgerEntry } from "../../src/core/events.ts";
import { appendEvents } from "../../src/core/streams.ts";
import { makeOpened, makeSessionReceipt, makeUsage, tempHome } from "../helpers/fixtures.ts";

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

const S = "33333333-aaaa-4bbb-8ccc-000000000003";

function transcriptWith(commands: string[]): string {
  const lines: unknown[] = [
    {
      type: "user", uuid: "u1", sessionId: S, version: "2.1.229", cwd: "/home/dev/acme/platform",
      gitBranch: "feat/PLAT-500-thing", timestamp: "2026-08-21T10:00:00Z", promptId: "p1",
      message: { role: "user", content: "do the thing" },
    },
    {
      type: "assistant", uuid: "a1", sessionId: S, timestamp: "2026-08-21T10:00:10Z",
      message: {
        id: "m1", role: "assistant", model: "claude-opus-4-6",
        usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        content: commands.map((c, i) => ({ type: "tool_use", id: `t${i}`, name: "Bash", input: { command: c } })),
      },
    },
    {
      type: "user", uuid: "u2", sessionId: S, timestamp: "2026-08-21T10:01:00Z", promptId: "p2",
      message: { role: "user", content: "now the other thing" },
    },
    {
      type: "assistant", uuid: "a2", sessionId: S, timestamp: "2026-08-21T10:01:10Z",
      message: {
        id: "m2", role: "assistant", model: "claude-opus-4-6",
        usage: { input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        content: [{ type: "text", text: "done" }],
      },
    },
  ];
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

test("overhead: turns that ran the waybill CLI are tagged; other turns are not", () => {
  const raw = transcriptWith([
    'npm test',
    '"${CLAUDE_PLUGIN_ROOT}/bin/waybill" mine --all',
  ]);
  const parsed = parseTranscript(raw, { branchKeyPattern: "[A-Z][A-Z0-9]+-[0-9]+" });
  assert.equal(parsed.turns[0]!.overhead, true);
  assert.equal(parsed.turns[1]!.overhead, false);

  const out = meterTranscript({
    transcriptPath: "/t.jsonl",
    raw,
    repo: "acme/platform",
    config: defaultConfig(),
    ledgerEvents: [],
    existingUsage: [],
    existingSessions: [],
    existingExceptions: [],
  });
  const usage = out.newUsage.filter((u) => u.kind === "usage");
  const tagged = usage.find((u) => u.turn.index === 1)!;
  const untagged = usage.find((u) => u.turn.index === 2)!;
  assert.equal(tagged.overhead, true);
  assert.equal("overhead" in untagged, false, "absent, not false — pre-1.6 ids stay stable");
});

test("overhead: spendData itemizes the plugin's own keep", () => {
  const config = defaultConfig();
  const usage = [
    makeUsage({ ts: "2026-08-21T10:00:00Z", turnIndex: 1, overhead: true, tokens: { input: 40, output: 0, cache_read: 0, cache_creation: 0 } }),
    makeUsage({ ts: "2026-08-21T11:00:00Z", turnIndex: 2, tokens: { input: 960, output: 0, cache_read: 0, cache_creation: 0 } }),
  ];
  const spend = spendData(usage, [], [], config, { from: null, to: null });
  assert.equal(spend.overhead.tokens, 40);
  assert.equal(spend.overhead.pct, 4);
});

test("untracked: unlogged story keys, branch-grouped unattributed spend, adhoc labels — tracked work excluded", () => {
  const config = defaultConfig();
  const logged = makeOpened({ ts: "2026-08-10T09:00:00Z" }); // PLAT-482 has a ledger entry
  const usage = [
    // tracked: story with a ledger entry → not a cluster
    makeUsage({ ts: "2026-08-20T10:00:00Z", turnIndex: 1, tokens: { input: 100, output: 0, cache_read: 0, cache_creation: 0 } }),
    // untracked story key (branch resolver fired, never logged/synced)
    makeUsage({ ts: "2026-08-20T11:00:00Z", turnIndex: 2, account: "story:PLAT-777", resolver: "session_branch", confidence: 0.6, tokens: { input: 300, output: 0, cache_read: 0, cache_creation: 0 } }),
    // unattributed, session has a branch → branch cluster
    makeUsage({ ts: "2026-08-20T12:00:00Z", turnIndex: 3, session_id: "44444444-aaaa-4bbb-8ccc-000000000004", account: "unattributed", resolver: "none", tokens: { input: 200, output: 0, cache_read: 0, cache_creation: 0 } }),
    // adhoc label
    makeUsage({ ts: "2026-08-20T13:00:00Z", turnIndex: 4, account: "adhoc:oncall", tokens: { input: 50, output: 0, cache_read: 0, cache_creation: 0 } }),
  ];
  const receipt = makeSessionReceipt([usage[2]!], {
    session_id: "44444444-aaaa-4bbb-8ccc-000000000004",
    branches: ["spike/quick-fix"],
    repo: "acme/platform",
  });
  const d = untrackedData([logged], usage, [receipt], config, { from: null, to: null });

  assert.equal(d.window_tokens, 650);
  assert.equal(d.untracked_tokens, 550); // everything but the tracked PLAT-482 spend
  assert.deepEqual(
    d.clusters.map((c) => c.id),
    ["story_key:PLAT-777@acme/platform", "branch:spike/quick-fix@acme/platform", "adhoc:oncall@acme/platform"],
  );
  const branchCluster = d.clusters[1]!;
  assert.deepEqual(branchCluster.sessions.map((s) => s.session_id), ["44444444-aaaa-4bbb-8ccc-000000000004"]);
  assert.deepEqual(branchCluster.branches, ["spike/quick-fix"]);
});

test("manifest: open items with age, spend, and the demurrage flag; shipped items absent", () => {
  const config = defaultConfig(); // demurrage_days 14
  const active = makeOpened({ ts: "2026-08-01T09:00:00Z" }); // PLAT-482, recent activity
  const stale = makeOpened({ tracker_key: "DATA-77", title: "Ingest dedupe", ts: "2026-07-01T09:00:00Z" });
  const shippedOpen = makeOpened({ tracker_key: "PLAT-490", title: "Done thing", ts: "2026-08-05T09:00:00Z" });
  const { id: _id, ...body } = shippedOpen;
  const shipped = finalizeEvent("ledger", {
    ...body, ts: "2026-08-10T10:00:00Z", kind: "shipped" as const, supersedes: shippedOpen.id,
  }) as LedgerEntry;
  const usage = [
    makeUsage({ ts: "2026-08-21T10:00:00Z", turnIndex: 1, tokens: { input: 500, output: 0, cache_read: 0, cache_creation: 0 } }), // PLAT-482 yesterday
    makeUsage({ ts: "2026-07-20T10:00:00Z", turnIndex: 2, account: "story:DATA-77", tokens: { input: 900, output: 0, cache_read: 0, cache_creation: 0 } }), // a month idle
  ];
  const m = manifestData([active, stale, shippedOpen, shipped], usage, config, "2026-08-22T12:00:00Z");

  assert.deepEqual(m.open_items.map((i) => i.tracker_key), ["DATA-77", "PLAT-482"]); // by tokens desc
  const idle = m.open_items[0]!;
  assert.equal(idle.sitting, true);
  assert.equal(idle.idle_days! >= 14, true);
  const fresh = m.open_items[1]!;
  assert.equal(fresh.sitting, false);
  assert.equal(m.sitting, 1);
  assert.equal(m.open_tokens, 1400);
});

test("CLI: query untracked and query manifest ship through the envelope; --now scoped correctly", () => {
  const home = tempHome();
  try {
    mkdirSync(home, { recursive: true });
    appendEvents(home, "usage", [
      makeUsage({ ts: "2026-08-20T11:00:00Z", turnIndex: 1, account: "story:PLAT-777", resolver: "session_branch", tokens: { input: 10, output: 0, cache_read: 0, cache_creation: 0 } }),
    ]);
    appendEvents(home, "ledger", [makeOpened({ ts: "2026-08-01T09:00:00Z" })]);

    const untracked = JSON.parse(cli(home, ["query", "untracked"]).stdout) as { data: { clusters: unknown[] } };
    assert.equal(untracked.data.clusters.length, 1);

    const manifest = JSON.parse(cli(home, ["query", "manifest", "--now", "2026-08-22T12:00:00Z"]).stdout) as {
      data: { open_items: Array<{ tracker_key: string }> };
    };
    assert.equal(manifest.data.open_items[0]!.tracker_key, "PLAT-482");

    assert.equal(cli(home, ["query", "spend", "--now", "2026-08-22T12:00:00Z"], true).code, 2);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("conventions: block and hook derive from config; the hook actually prefixes commits", () => {
  const home = tempHome();
  const repo = tempHome();
  try {
    mkdirSync(home, { recursive: true });
    const out = JSON.parse(cli(home, ["conventions", "--json"]).stdout) as {
      data: { claude_md: string; commit_msg_hook: string };
    };
    assert.match(out.data.claude_md, /PLAT-123: what changed/);
    assert.match(out.data.commit_msg_hook, /\[A-Z\]\[A-Z0-9\]\+-\[0-9\]\+/);

    // The hook, exercised for real: on a keyed branch it prefixes a
    // keyless message and leaves a keyed one alone.
    execFileSync("git", ["-C", repo, "init", "-q", "-b", "feat/PLAT-9-retry"], { stdio: "ignore" });
    const hookPath = join(repo, "hook.sh");
    writeFileSync(hookPath, out.data.commit_msg_hook, { mode: 0o755 });
    const msg = join(repo, "msg.txt");
    writeFileSync(msg, "did the retry work\n");
    execFileSync("sh", [hookPath, msg], { cwd: repo, stdio: "ignore" });
    assert.match(readFileSync(msg, "utf8"), /^PLAT-9: did the retry work/);
    execFileSync("sh", [hookPath, msg], { cwd: repo, stdio: "ignore" });
    assert.match(readFileSync(msg, "utf8"), /^PLAT-9: did the retry work/, "already-keyed messages stay untouched");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("dashboard: injects the snapshot, escapes breakouts, never leaves the placeholder", () => {
  const home = tempHome();
  try {
    mkdirSync(home, { recursive: true });
    appendEvents(home, "ledger", [
      makeOpened({ ts: "2026-08-01T09:00:00Z", title: "sneaky </script><script>alert(1)</script>" }),
    ]);
    appendEvents(home, "usage", [
      makeUsage({ ts: "2026-08-20T10:00:00Z", turnIndex: 1, tokens: { input: 100, output: 0, cache_read: 0, cache_creation: 0 } }),
    ]);
    const out = JSON.parse(cli(home, ["dashboard", "--json", "--now", "2026-08-22T12:00:00Z"]).stdout) as {
      data: { path: string };
    };
    const html = readFileSync(out.data.path, "utf8");
    assert.ok(!html.includes("__WAYBILL_DATA__"), "placeholder must be replaced");
    assert.ok(html.includes('"generated_at":"2026-08-22T12:00:00Z"'));
    // Cache-savings tile (#18): renderer present, and the payload carries
    // the derived figures it reads (labeled basis, coverage, null-not-$0).
    assert.ok(html.includes('tile("Cache reads'), "cache-savings tile renderer present");
    assert.ok(html.includes('"cache_savings"'), "spend30 payload carries cache_savings");
    assert.ok(html.includes("saved vs list — derived"), "derived label present");
    assert.ok(!html.includes("</script><script>alert"), "ledger strings must not escape the JSON block");
    assert.ok(html.includes("\\u003c/script>"), "escaped form present instead");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("dashboard: opens in the browser by default; --no-open and --json stay launch-free", () => {
  const home = tempHome();
  try {
    // --no-open: the old print-the-path behavior, no launch attempted.
    const quiet = cli(home, ["dashboard", "--no-open", "--now", "2026-08-22T12:00:00Z"]).stdout;
    assert.match(quiet, /^wrote /);
    assert.match(quiet, /Open it in a browser/);
    assert.doesNotMatch(quiet, /Opening it in your browser/);

    // Default: the launch is attempted (best-effort — a headless box
    // without an opener still prints the path first) and says so.
    const opened = cli(home, ["dashboard", "--now", "2026-08-22T12:00:00Z"]).stdout;
    assert.match(opened, /Opening it in your browser \(pass --no-open to skip\)/);

    // --json is a machine caller: pure JSON, never a launch message.
    const json = cli(home, ["dashboard", "--json", "--now", "2026-08-22T12:00:00Z"]).stdout;
    JSON.parse(json); // exactly one parseable document
    assert.doesNotMatch(json, /browser/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
