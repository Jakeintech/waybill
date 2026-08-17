import { defaultProjectsDir, listTranscripts, meterFile, type MeterRunResult } from "../meter/run.ts";

export function runMeter(home: string, args: string[], json: boolean): number {
  let transcript: string | null = null;
  let repo: string | null = null;
  let all = false;
  let projectsDir = defaultProjectsDir();
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--transcript") transcript = args[++i] ?? null;
    else if (a === "--repo") repo = args[++i] ?? null;
    else if (a === "--all") all = true;
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

  const results: MeterRunResult[] = [];
  const paths = all ? listTranscripts(projectsDir) : [transcript!];
  for (const p of paths) {
    try {
      results.push(meterFile(home, p, repo));
    } catch (err) {
      process.stderr.write(`waybill meter: ${p}: ${(err as Error).message}\n`);
    }
  }

  const metered = results.filter((r) => !r.skipped);
  const usage = metered.reduce((n, r) => n + r.usage, 0);
  const exceptions = metered.reduce((n, r) => n + r.exceptions, 0);
  if (json) {
    process.stdout.write(JSON.stringify({ results }, null, 2) + "\n");
  } else {
    process.stdout.write(
      `metered ${metered.length} session(s) (${results.length - metered.length} already current): ` +
        `+${usage} usage event(s), +${exceptions} exception(s)\n`,
    );
  }
  return 0;
}
