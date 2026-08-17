import { acquireLockWait, releaseLock } from "../meter/lock.ts";
import { defaultProjectsDir, listTranscripts, meterFile, type MeterRunResult } from "../meter/run.ts";

export async function runMeter(home: string, args: string[], json: boolean): Promise<number> {
  let transcript: string | null = null;
  let repo: string | null = null;
  let all = false;
  let force = false;
  let projectsDir = defaultProjectsDir();
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--transcript") transcript = args[++i] ?? null;
    else if (a === "--repo") repo = args[++i] ?? null;
    else if (a === "--all") all = true;
    else if (a === "--force") force = true;
    else if (a === "--projects-dir") projectsDir = args[++i] ?? projectsDir;
    else {
      process.stderr.write(`waybill meter: unknown option ${a}\n`);
      return 2;
    }
  }
  if (!all && !transcript) {
    process.stderr.write("waybill meter: pass --transcript <path> or --all\n");
    return 2;
  }

  // Same lock as the miner: two writers computing the same events would
  // append duplicate ids.
  if (!(await acquireLockWait(home))) {
    process.stderr.write("waybill meter: another metering process is running; try again shortly\n");
    return 1;
  }

  const results: MeterRunResult[] = [];
  let failures = 0;
  try {
    const paths = all ? listTranscripts(projectsDir) : [transcript!];
    for (const p of paths) {
      try {
        results.push(meterFile(home, p, repo, force));
      } catch (err) {
        failures += 1;
        process.stderr.write(`waybill meter: ${p}: ${(err as Error).message}\n`);
      }
    }
  } finally {
    releaseLock(home);
  }

  const metered = results.filter((r) => !r.skipped);
  const usage = metered.reduce((n, r) => n + r.usage, 0);
  const exceptions = metered.reduce((n, r) => n + r.exceptions, 0);
  if (json) {
    process.stdout.write(JSON.stringify({ results, failures }, null, 2) + "\n");
  } else {
    process.stdout.write(
      `metered ${metered.length} session(s) (${results.length - metered.length} already current` +
        (failures > 0 ? `, ${failures} failed` : "") +
        `): +${usage} usage event(s), +${exceptions} exception(s)\n`,
    );
  }
  return failures > 0 ? 1 : 0;
}
