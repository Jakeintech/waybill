// v2.0 "Delivered" batch — the coverage matrix filled and the review
// closed out: Azure DevOps and Bitbucket adapters (conformance- and
// own-data-tested on realistic payloads), the shared strict flag parser,
// status --fast, and the standup↔spend agreement golden the architecture
// review asked for.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { azureDevOpsAdapter } from "../../src/adapters/azure-devops.ts";
import { bitbucketAdapter } from "../../src/adapters/bitbucket.ts";
import {
  checkGitHostAdapter,
  checkOwnDataScoping,
  checkTrackerAdapter,
} from "../../src/adapters/conformance.ts";
import { defaultContext } from "../../src/adapters/contract.ts";
import { parseFlags } from "../../src/cli/flags.ts";
import { defaultConfig } from "../../src/core/config.ts";
import { spendData } from "../../src/projections/queries.ts";
import { standupData } from "../../src/projections/standup.ts";
import { makeSessionReceipt, makeUsage, tempHome, writeValidHome } from "../helpers/fixtures.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const FIXTURES = join(import.meta.dirname, "..", "fixtures", "adapters");

function cli(home: string, args: string[]): string {
  return execFileSync(process.execPath, [join(ROOT, "src", "cli", "main.ts"), ...args], {
    encoding: "utf8",
    env: { ...process.env, WAYBILL_HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const adoRaw = JSON.parse(readFileSync(join(FIXTURES, "azure-devops-workitems.json"), "utf8")) as unknown;
const bbRaw = JSON.parse(readFileSync(join(FIXTURES, "bitbucket-prs.json"), "utf8")) as unknown;

test("azure-devops adapter: numeric keys, points/effort, sprint from iteration path, own-data via email", () => {
  const ctx = defaultContext({ identityEmails: ["me@example.com"] });
  const items = azureDevOpsAdapter.normalizeItems(adoRaw, ctx);

  // The colleague's item is dropped; the unassigned one is kept (scoped
  // queries are the primary defense; no assignee = nothing to check).
  assert.deepEqual(items.map((i) => i.key), ["4821", "4833", "4850"]);
  const done = items.find((i) => i.key === "4821")!;
  assert.equal(done.title, "Retry logic for checkout webhook");
  assert.equal(done.points, 5);
  assert.equal(done.sprint, "Sprint 17");
  assert.equal(done.done, true);
  assert.equal(done.resolved_at, "2026-08-12T16:02:19.847Z");
  assert.equal(done.work_type, "feature");
  assert.equal(done.url, "https://dev.azure.com/acme/Platform/_workitems/edit/4821");
  const active = items.find((i) => i.key === "4833")!;
  assert.equal(active.points, 3, "Scrum's Effort field backs StoryPoints");
  assert.equal(active.done, false);

  const report = checkTrackerAdapter(azureDevOpsAdapter, adoRaw, ctx);
  assert.deepEqual(report.failures, []);
  const scoping = checkOwnDataScoping(azureDevOpsAdapter, adoRaw, ctx, ["4840"]);
  assert.deepEqual(scoping.failures, []);
});

test("bitbucket adapter: merged-only, repo/branch/keys, updated_on stands in for merge time, own-data", () => {
  const ctx = defaultContext({ bitbucketUsername: "a-engineer", projectKeys: ["PLAT"] });
  const changes = bitbucketAdapter.normalizeChanges(bbRaw, ctx);

  // The colleague's PR and the open PR are both dropped.
  assert.equal(changes.length, 1);
  const c = changes[0]!;
  assert.equal(c.url, "https://bitbucket.org/acme/platform/pull-requests/214");
  assert.equal(c.repo, "acme/platform");
  assert.equal(c.branch, "feat/PLAT-482-retry");
  assert.equal(c.merged_at, "2026-08-12T16:00:11.000000+00:00");
  assert.deepEqual(c.keys, ["PLAT-482"]);
  assert.equal(c.closes, undefined, "Bitbucket has no closing-keyword linkage — omitted, not faked");

  const report = checkGitHostAdapter(bitbucketAdapter, bbRaw, ctx);
  assert.deepEqual(report.failures, []);
  const scoping = checkOwnDataScoping(bitbucketAdapter, bbRaw, ctx, [
    "https://bitbucket.org/acme/platform/pull-requests/219",
  ]);
  assert.deepEqual(scoping.failures, []);
});

test("flags: unknown options and missing values error; booleans, values, positionals parse", () => {
  const good = parseFlags("x", ["pos1", "--fast", "--out", "dir", "pos2"], {
    "--fast": "boolean",
    "--out": "value",
  });
  assert.deepEqual(good, {
    values: { "--out": "dir" },
    bools: { "--fast": true },
    positional: ["pos1", "pos2"],
  });
  assert.equal(parseFlags("x", ["--typo"], { "--fast": "boolean" }), null);
  assert.equal(parseFlags("x", ["--out"], { "--out": "value" }), null);
  // Prototype members are not flags.
  assert.equal(parseFlags("x", ["--constructor"], { "--out": "value" }), null);
});

test("status --fast: verify skipped and said so, exit stays 0, everything else still reported", () => {
  const home = tempHome();
  writeValidHome(home);
  const out = cli(home, ["status", "--fast"]);
  assert.match(out, /verify: skipped \(--fast\) — run: waybill verify/);
  assert.match(out, /spend: /);
  const json = JSON.parse(cli(home, ["status", "--fast", "--json"])) as {
    data: { verify: { skipped?: boolean } };
  };
  assert.equal(json.data.verify.skipped, true);
});

test("golden agreement: standup and spend report the same token total over the same window", () => {
  const config = defaultConfig();
  const usage = [
    makeUsage({ ts: "2026-08-11T10:00:00Z", turnIndex: 1, tokens: { input: 100_000, output: 20_000, cache_read: 800_000, cache_creation: 80_000 } }),
    makeUsage({ ts: "2026-08-12T11:00:00Z", turnIndex: 2, account: "unattributed", resolver: "none", tokens: { input: 10_000, output: 2_000, cache_read: 50_000, cache_creation: 8_000 } }),
    makeUsage({ ts: "2026-08-20T09:00:00Z", turnIndex: 3, tokens: { input: 999, output: 0, cache_read: 0, cache_creation: 0 } }), // outside window
  ];
  const receipt = makeSessionReceipt(usage);
  const window = { from: "2026-08-11T00:00:00Z", to: "2026-08-12T23:59:59.999Z" };
  const spend = spendData(usage, [], [], config, window);
  const standup = standupData([], usage, [receipt], [], config, window, null);
  assert.equal(standup.tokens.total, spend.total_tokens);
  assert.deepEqual(
    { in: standup.tokens.totals.input, out: standup.tokens.totals.output },
    { in: 110_000, out: 22_000 },
  );
  assert.equal(spend.total_tokens, 1_070_000);
});
