// M3: allocation-cycle reminder + GitLab adapter conformance.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { gitlabAdapter } from "../../src/adapters/gitlab.ts";
import { checkGitHostAdapter } from "../../src/adapters/conformance.ts";
import { defaultContext } from "../../src/adapters/contract.ts";
import { defaultConfig, saveConfig } from "../../src/core/config.ts";

const ROOT = join(import.meta.dirname, "..", "..");

function cli(home: string, args: string[]): string {
  return execFileSync(process.execPath, [join(ROOT, "src", "cli", "main.ts"), ...args], {
    encoding: "utf8",
    env: { ...process.env, WAYBILL_HOME: home },
  });
}

test("renewal reminder: one nudge inside the window, none after, none before", () => {
  const home = mkdtempSync(join(tmpdir(), "wb-renew-"));
  try {
    const config = defaultConfig();
    config.allocations = [{ period: "2026-Q3", tokens_granted: 50_000_000, granted_at: "2026-07-01" }];
    saveConfig(home, config);
    // 45 days out: quiet.
    assert.equal(cli(home, ["pace", "--notice", "--now", "2026-08-16T00:00:00Z"]), "");
    // 10 days out (inside the default 14): one nudge.
    const nudge = cli(home, ["pace", "--notice", "--now", "2026-09-20T00:00:00Z"]);
    assert.match(nudge, /grant renews in 10 day\(s\)/);
    assert.match(nudge, /token pitch/);
    // Asked again: quiet — once per period.
    assert.equal(cli(home, ["pace", "--notice", "--now", "2026-09-21T00:00:00Z"]), "");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("gitlab adapter: merged MRs normalize and pass the conformance kit", () => {
  const raw = [
    {
      web_url: "https://gitlab.com/acme/platform/-/merge_requests/7",
      title: "PLAT-482: retry logic",
      source_branch: "feat/PLAT-482-retry",
      merged_at: "2026-08-12T16:00:03Z",
      state: "merged",
      references: { full: "acme/platform!7" },
      author: { username: "jake" },
    },
    {
      web_url: "https://gitlab.com/acme/platform/-/merge_requests/9",
      title: "chore: deps",
      source_branch: "chore/deps",
      merged_at: null,
      state: "opened",
    },
  ];
  const ctx = defaultContext();
  const changes = gitlabAdapter.normalizeChanges(raw, ctx);
  assert.equal(changes.length, 1); // unmerged dropped
  assert.equal(changes[0]!.repo, "acme/platform");
  assert.deepEqual(changes[0]!.keys, ["PLAT-482"]);
  const report = checkGitHostAdapter(gitlabAdapter, raw, ctx);
  assert.deepEqual(report.failures, []);
});
