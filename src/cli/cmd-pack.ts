import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StreamName } from "../core/events.ts";
import type { UsageEvent } from "../core/events.ts";
import { sha256Hex } from "../core/sha.ts";
import { authoritative, listShards, shardPath } from "../core/streams.ts";
import type { Window } from "../projections/queries.ts";
import { verifyHome } from "../verify/verify.ts";
import { inWindow } from "../core/time.ts";
import { ENGINE_VERSION } from "./main.ts";

/**
 * The verification pack (v1.7 "Bill of lading"): a directory the recipient
 * of a pitch or review packet can check themselves with one command —
 * `node waybill.mjs verify --home .` re-runs id determinism, escrow seals,
 * and conservation against the included events.
 *
 * Two properties everything else follows from:
 *
 * 1. **Verbatim lines.** Event ids recompute from content, so the pack
 *    copies stream lines byte-for-byte — any re-serialization would be
 *    indistinguishable from tampering. This is also why packs are never
 *    redacted: a pseudonymized event no longer recomputes its id.
 *    Verifiability and redaction are mutually exclusive at the event level;
 *    the external-audience path stays the redacted *report*.
 * 2. **Session-complete usage.** Conservation is Σ usage = receipt totals
 *    per session, so a session is included whole (every usage event and
 *    receipt version, even outside the window) or not at all. The window
 *    selects *which* sessions (any in-window usage), never slices them.
 *
 * The ledger stream is included in full — supersession chains and escrow
 * seals must stay whole, and the ledger is small. identity.json is never
 * copied (emails); config.json is (rates — so the recipient's `query spend`
 * reproduces the sender's numbers).
 */

interface PackLine {
  raw: string;
  parsed: Record<string, unknown> | null;
  shard: string;
}

function readRawLines(home: string, stream: StreamName): PackLine[] {
  const out: PackLine[] = [];
  for (const shard of listShards(home, stream)) {
    for (const raw of readFileSync(shardPath(home, stream, shard), "utf8").split("\n")) {
      if (raw.trim() === "") continue;
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        parsed = null; // cannot happen post-verify; kept for type honesty
      }
      out.push({ raw, parsed, shard });
    }
  }
  return out;
}

export interface PackResult {
  out_dir: string;
  sessions: number;
  events: Record<StreamName, number>;
  total_tokens: number;
  engine_included: boolean;
  config_included: boolean;
}

/** Locate the built engine bundle to copy into the pack: the running bundle
 * itself when that is what's executing, else the repo checkout's bin/. */
export function engineBundlePath(): string | null {
  const argv1 = process.argv[1] ?? "";
  if (argv1.endsWith("waybill.mjs") && existsSync(argv1)) return argv1;
  let dir = import.meta.dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "bin", "waybill.mjs");
    if (existsSync(candidate)) return candidate;
    dir = join(dir, "..");
  }
  return null;
}

export function buildPack(
  home: string,
  outDir: string,
  window: Window,
  nowIso: string,
): { result: PackResult; error: string | null } {
  const empty: PackResult = {
    out_dir: outDir, sessions: 0,
    events: { ledger: 0, usage: 0, sessions: 0, exceptions: 0 },
    total_tokens: 0, engine_included: false, config_included: false,
  };
  // A pack is a claim of integrity — it is only ever built from a ledger
  // that verifies green right now.
  const findings = verifyHome(home);
  if (findings.length > 0) {
    return {
      result: empty,
      error: `refusing to pack an unverified ledger: ${findings.length} finding(s) — run: waybill verify`,
    };
  }
  if (existsSync(outDir) && readdirSync(outDir).length > 0) {
    return { result: empty, error: `output directory is not empty: ${outDir} — pass --out <dir>` };
  }

  // Pass 1: which sessions have in-window usage.
  const usageLines = readRawLines(home, "usage");
  const included = new Set<string>();
  for (const l of usageLines) {
    const ts = l.parsed?.["ts"];
    const sid = l.parsed?.["session_id"];
    if (typeof ts === "string" && typeof sid === "string" && inWindow(ts, window.from, window.to)) {
      included.add(sid);
    }
  }

  // Pass 2: filter each stream. Ledger travels whole; usage/sessions lines
  // follow their session id; exceptions follow their session id, plus
  // resolutions for included ambiguities.
  const keep: Record<StreamName, PackLine[]> = {
    ledger: readRawLines(home, "ledger"),
    usage: usageLines.filter((l) => included.has(String(l.parsed?.["session_id"]))),
    sessions: readRawLines(home, "sessions").filter((l) => included.has(String(l.parsed?.["session_id"]))),
    exceptions: [],
  };
  const exceptionLines = readRawLines(home, "exceptions");
  const includedAmbiguities = new Set<string>();
  for (const l of exceptionLines) {
    if (l.parsed?.["kind"] === "ambiguity" && included.has(String(l.parsed?.["session_id"]))) {
      includedAmbiguities.add(String(l.parsed?.["id"]));
    }
  }
  keep.exceptions = exceptionLines.filter((l) => {
    if (l.parsed?.["kind"] === "resolution") return includedAmbiguities.has(String(l.parsed?.["resolves"]));
    return included.has(String(l.parsed?.["session_id"]));
  });

  const packUsage = keep.usage
    .map((l) => l.parsed as unknown as UsageEvent)
    .filter((u) => u !== null);
  const totalTokens = authoritative(packUsage)
    .filter((u) => u.kind === "usage")
    .reduce((n, u) => n + u.tokens.input + u.tokens.output + u.tokens.cache_read + u.tokens.cache_creation, 0);

  mkdirSync(outDir, { recursive: true });
  const files: Record<string, string> = {};
  const writePackFile = (rel: string, content: string): void => {
    const p = join(outDir, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content, "utf8");
    files[rel] = sha256Hex(content);
  };

  for (const stream of ["ledger", "usage", "sessions", "exceptions"] as StreamName[]) {
    const byShard = new Map<string, string[]>();
    for (const l of keep[stream]) {
      const bucket = byShard.get(l.shard) ?? [];
      bucket.push(l.raw);
      byShard.set(l.shard, bucket);
    }
    for (const [shard, lines] of [...byShard.entries()].sort()) {
      writePackFile(join("streams", stream, `${shard}.jsonl`), lines.join("\n") + "\n");
    }
  }

  let configIncluded = false;
  const configPath = join(home, "config.json");
  if (existsSync(configPath)) {
    writePackFile("config.json", readFileSync(configPath, "utf8"));
    configIncluded = true;
  }

  let engineIncluded = false;
  const engine = engineBundlePath();
  if (engine !== null) {
    copyFileSync(engine, join(outDir, "waybill.mjs"));
    files["waybill.mjs"] = sha256Hex(readFileSync(join(outDir, "waybill.mjs"), "utf8"));
    engineIncluded = true;
  }

  const result: PackResult = {
    out_dir: outDir,
    sessions: included.size,
    events: {
      ledger: keep.ledger.length,
      usage: keep.usage.length,
      sessions: keep.sessions.length,
      exceptions: keep.exceptions.length,
    },
    total_tokens: totalTokens,
    engine_included: engineIncluded,
    config_included: configIncluded,
  };

  writePackFile("README.md", packReadme(result, window, nowIso));
  writeFileSync(
    join(outDir, "pack.json"),
    JSON.stringify(
      {
        kind: "waybill-verification-pack",
        pack_version: 1,
        engine_version: ENGINE_VERSION,
        generated_at: nowIso,
        window,
        sessions: result.sessions,
        events: result.events,
        total_tokens: result.total_tokens,
        engine_included: engineIncluded,
        config_included: configIncluded,
        verify_at_pack_time: "green",
        files,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  return { result, error: null };
}

function packReadme(result: PackResult, window: Window, nowIso: string): string {
  const windowLine =
    window.from === null && window.to === null
      ? "all recorded history"
      : `${window.from ?? "(start)"} → ${window.to ?? "(now)"}`;
  const verifyCmd = result.engine_included
    ? "node waybill.mjs verify --home ."
    : "node <path-to-waybill.mjs> verify --home .  (engine: github.com/jakeintech/waybill, bin/waybill.mjs)";
  return `# Waybill verification pack

Generated ${nowIso} · window: ${windowLine} · ${result.sessions} session(s), ${result.total_tokens.toLocaleString("en-US")} tokens.

This directory accompanies a report or token pitch. It contains the actual
event lines behind the numbers — not a rendering of them — so you can check
the claims yourself, offline, with one command:

\`\`\`
${verifyCmd}
\`\`\`

That re-runs, against the included events (Node 20+, no network, no install):

- **Id determinism** — every event id recomputes from its content
  (SHA-256); an edited line no longer matches its id.
- **Escrow seals** — pre-registered estimates are hash-sealed at logging
  time; a backdated or altered estimate fails the seal.
- **Conservation** — per session, the sum of per-turn usage events equals
  the session receipt's totals. Sessions are included whole (every usage
  event, even outside the window) so this check is meaningful.
- **Supersession integrity** — corrections form unforked chains; nothing
  is silently edited or double-counted.

Then read the numbers the same way the sender did:

\`\`\`
${result.engine_included ? "node waybill.mjs" : "node <path-to-waybill.mjs>"} query spend --home .
${result.engine_included ? "node waybill.mjs" : "node <path-to-waybill.mjs>"} query report --home .
\`\`\`

Contents: \`streams/\` (verbatim ledger, usage, session-receipt, and
exception events)${result.config_included ? ", `config.json` (the sender's rate table, so cost figures reproduce)" : ""}${result.engine_included ? ", `waybill.mjs` (the engine — a single dependency-free bundle)" : ""},
and \`pack.json\` (metadata + SHA-256 of every file here).

Note: pack contents are **verbatim and unredacted** (tracker keys, titles,
repos) — redaction would break the id checks above. Treat the pack at the
same sensitivity as the internal report it accompanies.
`;
}
