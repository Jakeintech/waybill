// Regenerates tests/golden/meter/ from the fixture transcripts.
// Run: node tests/tools/regen-meter-golden.ts
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { meterTranscript } from "../../src/meter/meter.ts";
import { goldenMeterConfig, goldenMeterInput } from "../helpers/meter-golden.ts";

const goldenDir = join(import.meta.dirname, "..", "golden", "meter");
rmSync(goldenDir, { recursive: true, force: true });
mkdirSync(goldenDir, { recursive: true });

for (const name of ["v2.1/basic", "v2.1/multiturn", "v1/legacy"]) {
  const raw = readFileSync(
    join(import.meta.dirname, "..", "fixtures", "transcripts", `${name}.jsonl`),
    "utf8",
  );
  const out = meterTranscript(goldenMeterInput(name, raw, goldenMeterConfig()));
  const slug = name.replace("/", "__").replace(".", "_");
  const dump = (events: unknown[]): string => events.map((e) => JSON.stringify(e) + "\n").join("");
  writeFileSync(join(goldenDir, `${slug}.usage.jsonl`), dump(out.newUsage), "utf8");
  writeFileSync(join(goldenDir, `${slug}.sessions.jsonl`), dump(out.newSessions), "utf8");
  writeFileSync(join(goldenDir, `${slug}.exceptions.jsonl`), dump(out.newExceptions), "utf8");
  process.stdout.write(
    `${slug}: ${out.newUsage.length} usage, ${out.newSessions.length} sessions, ${out.newExceptions.length} exceptions\n`,
  );
}
