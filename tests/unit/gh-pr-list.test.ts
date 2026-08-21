// The gh CLI git-host path: `gh pr list --json url,title,headRefName,
// mergedAt,body,author` emits camelCase rows with no repo object. The
// github adapter must normalize them like REST payloads — same own-data
// scoping, closing-keyword linkage, conformance-clean.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { githubAdapter } from "../../src/adapters/github.ts";
import { checkGitHostAdapter } from "../../src/adapters/conformance.ts";
import { defaultContext } from "../../src/adapters/contract.ts";

const raw = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "fixtures", "adapters", "github-gh-pr-list.json"), "utf8"),
) as unknown;

test("github adapter: gh pr list rows normalize — repo from URL, branch/merge/closes intact", () => {
  const ctx = defaultContext({ githubLogin: "a-engineer" });
  const changes = githubAdapter.normalizeChanges(raw, ctx);

  // The colleague's PR and the unmerged PR are both dropped.
  assert.equal(changes.length, 1);
  const c = changes[0]!;
  assert.equal(c.url, "https://github.com/acme/platform/pull/1932");
  assert.equal(c.repo, "acme/platform"); // derived from the PR's own URL
  assert.equal(c.branch, "feat/PLAT-482-retry");
  assert.equal(c.merged_at, "2026-08-12T16:00:11Z");
  assert.deepEqual(c.keys, ["PLAT-482"]);
  assert.deepEqual(c.closes, ["acme/platform#12"]); // "Fixes #12" in the body
});

test("github adapter: gh pr list payload passes the conformance kit", () => {
  const ctx = defaultContext({ githubLogin: "a-engineer" });
  const report = checkGitHostAdapter(githubAdapter, raw, ctx);
  assert.deepEqual(report.failures, []);
  assert.equal(report.passed, true);
});
