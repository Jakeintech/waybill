// The acli (Atlassian CLI) sync path: `acli jira workitem view <KEY> --json`
// emits REST-shaped issues; the sync skill composes them verbatim into a
// bare array (jq -s). The jira adapter must normalize that composition
// exactly like an MCP/REST search envelope — same fields, same own-data
// scoping, conformance-clean.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { jiraAdapter } from "../../src/adapters/jira.ts";
import { checkTrackerAdapter } from "../../src/adapters/conformance.ts";
import { defaultContext } from "../../src/adapters/contract.ts";

const raw = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "fixtures", "adapters", "jira-acli-views.json"), "utf8"),
) as unknown;

test("jira adapter: bare array of acli view outputs normalizes like a search envelope", () => {
  const ctx = defaultContext({ jiraAccountId: "5b10a2844c20165700ede21g" });
  const items = jiraAdapter.normalizeItems(raw, ctx);

  // Own-data scoping drops the colleague's PLAT-491 even though the
  // composed file contains it.
  assert.deepEqual(items.map((i) => i.key), ["PLAT-482", "PLAT-490"]);

  const done = items[0]!;
  assert.equal(done.done, true);
  assert.equal(done.points, 5);
  assert.equal(done.epic_key, "PLAT-400");
  assert.equal(done.epic_name, "Checkout reliability");
  assert.equal(done.sprint, "Sprint 17");
  assert.equal(done.resolved_at, "2026-08-12T16:02:11.000+0000");
  assert.equal(done.work_type, "feature");
  assert.equal(done.url, "https://acme.atlassian.net/browse/PLAT-482");

  const open = items[1]!;
  assert.equal(open.done, false);
  assert.equal(open.resolved_at, null);
  assert.equal(open.points, null); // never invented
});

test("jira adapter: acli-composed payload passes the conformance kit", () => {
  const ctx = defaultContext({ jiraAccountId: "5b10a2844c20165700ede21g" });
  const report = checkTrackerAdapter(jiraAdapter, raw, ctx);
  assert.deepEqual(report.failures, []);
  assert.equal(report.passed, true);
});
