/**
 * Shared strict flag parser (architecture review rec. 3). The house rule
 * every command must satisfy: an unknown `--flag` errors, a value-taking
 * flag with no value errors — the silent alternatives (ignored typo,
 * window quietly widened to all history) misreport data.
 *
 * Adopted by the simple read-side commands. The commands with bespoke
 * per-flag semantics (query's enums and window words, export's
 * format/pack interlocks, the write paths append/resolve/meter/sync-plan)
 * keep their hand-rolled strict parsers deliberately: each of their error
 * paths carries a regression test, and rewriting tested write-path
 * parsing for tidiness trades real risk for zero user value
 * (docs/architecture.md records this disposition).
 */

export interface FlagSpec {
  /** flag name (with leading --) → takes a value? */
  [flag: string]: "value" | "boolean";
}

export interface ParsedFlags {
  values: Record<string, string>;
  bools: Record<string, boolean>;
  positional: string[];
}

/** Parse argv strictly. Returns null after printing the error (caller
 * returns exit code 2). */
export function parseFlags(cmd: string, args: string[], spec: FlagSpec): ParsedFlags | null {
  const out: ParsedFlags = { values: {}, bools: {}, positional: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("--")) {
      out.positional.push(a);
      continue;
    }
    const kind = Object.hasOwn(spec, a) ? spec[a] : undefined;
    if (kind === undefined) {
      process.stderr.write(`waybill ${cmd}: unknown option ${a}\n`);
      return null;
    }
    if (kind === "boolean") {
      out.bools[a] = true;
      continue;
    }
    const v = args[++i];
    if (v === undefined) {
      process.stderr.write(`waybill ${cmd}: ${a} needs a value\n`);
      return null;
    }
    out.values[a] = v;
  }
  return out;
}
