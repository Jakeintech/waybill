import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { meterTranscript } from "../../src/meter/meter.ts";
import { goldenMeterConfig, goldenMeterInput } from "../helpers/meter-golden.ts";
import { saveConfig } from "../../src/core/config.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const FIXTURES = join(ROOT, "tests", "fixtures", "transcripts");
const GOLDEN = join(ROOT, "tests", "golden", "meter");

for (const name of ["v2.1/basic", "v2.1/multiturn", "v1/legacy"]) {
  test(`golden: meter output for ${name} matches committed bytes`, () => {
    const raw = readFileSync(join(FIXTURES, `${name}.jsonl`), "utf8");
    const out = meterTranscript(goldenMeterInput(name, raw, goldenMeterConfig()));
    const slug = name.replace("/", "__").replace(".", "_");
    const dump = (events: unknown[]): string => events.map((e) => JSON.stringify(e) + "\n").join("");
    for (const [suffix, events] of [
      ["usage", out.newUsage],
      ["sessions", out.newSessions],
      ["exceptions", out.newExceptions],
    ] as const) {
      const golden = readFileSync(join(GOLDEN, `${slug}.${suffix}.jsonl`), "utf8");
      assert.equal(
        dump(events),
        golden,
        `golden mismatch: ${slug}.${suffix}.jsonl — if intentional, run node tests/tools/regen-meter-golden.ts`,
      );
    }
  });
}

test("e2e: meter CLI over all fixtures, then verify passes (conservation end-to-end)", () => {
  const home = mkdtempSync(join(tmpdir(), "waybill-e2e-"));
  try {
    saveConfig(home, goldenMeterConfig());
    const cliTest = (args: string[]): string =>
      execFileSync(process.execPath, [join(ROOT, "src", "cli", "main.ts"), ...args], {
        encoding: "utf8",
        env: { ...process.env, WAYBILL_HOME: home },
      });
    for (const name of ["v2.1/basic.jsonl", "v2.1/multiturn.jsonl", "v1/legacy.jsonl"]) {
      cliTest(["meter", "--transcript", join(FIXTURES, name), "--repo", "acme/platform"]);
    }
    // Second pass: everything current, nothing appended.
    const rerun = cliTest(["meter", "--transcript", join(FIXTURES, "v2.1/basic.jsonl"), "--repo", "acme/platform"]);
    assert.match(rerun, /metered 0 session\(s\) \(1 already current\)/);
    const verdict = cliTest(["verify"]);
    assert.match(verdict, /All checks passed/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
