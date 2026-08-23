import type { TokenCounts, UsageTokens } from "../core/events.ts";
import { isPlausibleTrackerKey } from "../core/keys.ts";

/** One tracker key sighting inside a session, with where it came from. */
export interface EvidenceKey {
  key: string;
  source: "branch_checkout" | "commit_message" | "pr_operation";
  turnIndex: number;
}

export interface ModelAggregate {
  model: string;
  tokens: UsageTokens;
  extras: Record<string, number>;
  lastTs: string;
}

export interface TurnWaste {
  /** Identical commands run again within the turn (retry loops). */
  retried_commands: number;
  /** Identical file reads repeated within the turn. */
  repeated_reads: number;
}

export interface Turn {
  index: number;
  promptId: string | null;
  branchAtStart: string | null;
  /** Working directory in effect when the turn started — the per-turn
   * attribution anchor for multi-repo sessions (FR-A3: a turn belongs to
   * the context at its START; a turn is never split). */
  cwdAtStart: string | null;
  firstMessageId: string | null;
  lastMessageId: string | null;
  models: ModelAggregate[];
  waste: TurnWaste;
  /** The turn ran the waybill CLI itself — the plugin's own keep, tagged
   * so spend can itemize its overhead. Deterministic substring match on
   * tool commands, nothing subtler (a waybill developer's own dev
   * commands count too). */
  overhead: boolean;
}

export interface ParsedTranscript {
  sessionId: string | null;
  /** Distinct working directories seen across the transcript, in first-
   * appearance order. More than one marks a multi-repo session: each
   * turn attributes via the directory active at its start (rules v3);
   * verify discloses sessions still carrying pre-split attribution. */
  cwds: string[];
  /** Present when this file is a subagent transcript: the agent id carried
   * on the same line that supplied sessionId. Subagent files stamp it on
   * every line; inline sidechains in a main transcript never set it (the
   * main file's first identity line has no agentId). */
  agentId: string | null;
  version: string | null;
  cwd: string | null;
  branches: string[];
  models: string[];
  firstTs: string | null;
  lastTs: string | null;
  turns: Turn[];
  evidence: EvidenceKey[];
  messageCount: number;
  totals: TokenCounts;
}

interface RawLine {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  isSidechain?: boolean;
  sessionId?: string;
  agentId?: string;
  version?: string;
  cwd?: string;
  gitBranch?: string;
  timestamp?: string;
  promptId?: string;
  toolUseResult?: unknown;
  message?: {
    id?: string;
    role?: string;
    model?: string;
    usage?: Record<string, unknown>;
    content?: unknown;
  };
}

const KNOWN_USAGE_FIELDS = new Set([
  "input_tokens",
  "output_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
  "cache_creation",
]);

function asInt(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : 0;
}

export function tokensFromUsage(usage: Record<string, unknown>): UsageTokens {
  const cc = usage["cache_creation"];
  const cc5m = asInt((cc as Record<string, unknown> | undefined)?.["ephemeral_5m_input_tokens"]);
  const cc1h = asInt((cc as Record<string, unknown> | undefined)?.["ephemeral_1h_input_tokens"]);
  let cacheCreation = asInt(usage["cache_creation_input_tokens"]);
  if (cacheCreation === 0 && (cc5m > 0 || cc1h > 0)) cacheCreation = cc5m + cc1h;
  return {
    input: asInt(usage["input_tokens"]),
    output: asInt(usage["output_tokens"]),
    cache_read: asInt(usage["cache_read_input_tokens"]),
    cache_creation: cacheCreation,
    cache_creation_5m: cc5m,
    cache_creation_1h: cc1h,
  };
}

/** Flatten unknown numeric usage fields to dot-paths, e.g. server_tool_use.web_search_requests. */
export function extraNumerics(usage: Record<string, unknown>, prefix = "", known = KNOWN_USAGE_FIELDS): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(usage)) {
    if (prefix === "" && known.has(k)) continue;
    const path = prefix === "" ? k : `${prefix}.${k}`;
    if (typeof v === "number" && Number.isFinite(v)) {
      out[path] = v;
    } else if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      Object.assign(out, extraNumerics(v as Record<string, unknown>, path, known));
    }
  }
  return out;
}

/** Is this line a real user prompt (a turn boundary)? */
export function isPromptLine(line: RawLine): boolean {
  if (line.type !== "user" || line.isSidechain === true) return false;
  if (line.toolUseResult !== undefined) return false;
  const msg = line.message;
  if (!msg || (msg.role !== undefined && msg.role !== "user")) return false;
  const content = msg.content;
  if (typeof content === "string") return content.trim() !== "";
  if (Array.isArray(content)) {
    // Any real user content is a turn boundary — an image-only or
    // document-only paste starts a turn exactly like typed text does.
    let hasContent = false;
    for (const item of content) {
      const t = (item as { type?: string }).type;
      if (t === "tool_result") return false;
      if (t === "text" || t === "image" || t === "document") hasContent = true;
    }
    return hasContent;
  }
  return false;
}

const CHECKOUT_RE = /\bgit\s+(?:checkout|switch)\s+(?:-[bc]\s+)?(\S+)/g;
const COMMIT_RE = /\bgit\s+commit\b[^\n]*?-m\s+(?:"([^"]*)"|'([^']*)')/g;
const PR_RE = /\bgh\s+pr\s+(?:create|checkout|merge|view)\b[^\n]*/g;

/** Extract tracker keys from a Bash-like tool command, per resolver rule 3. */
export function evidenceFromCommand(command: string, keyPattern: RegExp): Array<Omit<EvidenceKey, "turnIndex">> {
  const out: Array<Omit<EvidenceKey, "turnIndex">> = [];
  for (const m of command.matchAll(CHECKOUT_RE)) {
    const branch = m[1] ?? "";
    for (const k of branch.match(keyPattern) ?? []) out.push({ key: k, source: "branch_checkout" });
  }
  for (const m of command.matchAll(COMMIT_RE)) {
    const msg = m[1] ?? m[2] ?? "";
    for (const k of msg.match(keyPattern) ?? []) out.push({ key: k, source: "commit_message" });
  }
  for (const m of command.matchAll(PR_RE)) {
    for (const k of (m[0] ?? "").match(keyPattern) ?? []) out.push({ key: k, source: "pr_operation" });
  }
  return out;
}

interface ToolBlock {
  id: string;
  name: string;
  command: string | null;
  file_path: string | null;
}

function toolBlocks(content: unknown): ToolBlock[] {
  if (!Array.isArray(content)) return [];
  const out: ToolBlock[] = [];
  for (const item of content) {
    const block = item as {
      type?: string;
      id?: string;
      name?: string;
      input?: { command?: unknown; file_path?: unknown };
    };
    if (block.type !== "tool_use" || typeof block.id !== "string") continue;
    out.push({
      id: block.id,
      name: typeof block.name === "string" ? block.name : "",
      command: typeof block.input?.command === "string" ? block.input.command : null,
      file_path: typeof block.input?.file_path === "string" ? block.input.file_path : null,
    });
  }
  return out;
}

export interface ParseOptions {
  branchKeyPattern: string;
  /** config.tracker.project_keys — gates pattern matches (see core/keys). */
  projectKeys?: string[];
}

export function parseTranscript(raw: string, options: ParseOptions): ParsedTranscript {
  const keyPattern = new RegExp(options.branchKeyPattern, "g");
  const text = raw;

  const turns: Turn[] = [];
  const evidence: EvidenceKey[] = [];
  const branches: string[] = [];
  const models: string[] = [];
  const byMessage = new Map<
    string,
    { turnIndex: number; model: string; tokens: UsageTokens; extras: Record<string, number>; ts: string }
  >();

  let sessionId: string | null = null;
  const cwds: string[] = [];
  let agentId: string | null = null;
  let version: string | null = null;
  let cwd: string | null = null;
  let currentCwd: string | null = null;
  let currentBranch: string | null = null;
  let firstTs: string | null = null;
  let lastTs: string | null = null;
  let turnIndex = 0;
  let currentTurn: Turn | null = null;
  // Waste tallies (D11: counts only — commands and paths never reach the
  // ledger). Tool blocks are deduped by block id: streamed lines repeat.
  const seenToolIds = new Set<string>();
  const commandTallies = new Map<number, Map<string, number>>();
  const readTallies = new Map<number, Map<string, number>>();
  const overheadTurns = new Set<number>();

  const ensureTurn = (): Turn => {
    if (!currentTurn) {
      currentTurn = {
        index: turnIndex,
        promptId: null,
        branchAtStart: currentBranch,
        cwdAtStart: currentCwd,
        firstMessageId: null,
        lastMessageId: null,
        models: [],
        waste: { retried_commands: 0, repeated_reads: 0 },
        overhead: false,
      };
      turns.push(currentTurn);
    }
    return currentTurn;
  };

  for (const lineText of text.split("\n")) {
    if (lineText.trim() === "") continue;
    let line: RawLine;
    try {
      line = JSON.parse(lineText) as RawLine;
    } catch {
      continue;
    }
    if (typeof line.cwd === "string" && line.cwd !== "") {
      currentCwd = line.cwd;
      if (!cwds.includes(line.cwd)) cwds.push(line.cwd);
    }
    if (sessionId === null && typeof line.sessionId === "string") {
      sessionId = line.sessionId;
      // Adopted only from the identity line: a main transcript's inline
      // sidechain lines must never re-identify the whole file as an agent's.
      if (typeof line.agentId === "string" && line.agentId !== "") agentId = line.agentId;
    }
    if (version === null && typeof line.version === "string") version = line.version;
    if (cwd === null && typeof line.cwd === "string") cwd = line.cwd;
    if (typeof line.gitBranch === "string" && line.gitBranch !== "") {
      currentBranch = line.gitBranch;
      if (!branches.includes(currentBranch)) branches.push(currentBranch);
    }
    if (typeof line.timestamp === "string") {
      if (firstTs === null) firstTs = line.timestamp;
      lastTs = line.timestamp;
    }

    if (isPromptLine(line)) {
      turnIndex += 1;
      currentTurn = {
        index: turnIndex,
        promptId: typeof line.promptId === "string" ? line.promptId : null,
        branchAtStart: currentBranch,
        cwdAtStart: currentCwd,
        firstMessageId: null,
        lastMessageId: null,
        models: [],
        waste: { retried_commands: 0, repeated_reads: 0 },
        overhead: false,
      };
      turns.push(currentTurn);
      continue;
    }

    if (line.type === "assistant" && line.message) {
      const msg = line.message;
      for (const block of toolBlocks(msg.content)) {
        if (seenToolIds.has(block.id)) continue; // streamed duplicate line
        seenToolIds.add(block.id);
        const tIdx = currentTurn?.index ?? turnIndex;
        if (block.command !== null) {
          for (const ev of evidenceFromCommand(block.command, keyPattern)) {
            // SHA-256 in a commit message is not a story (core/keys).
            if (!isPlausibleTrackerKey(ev.key, options.projectKeys ?? [])) continue;
            evidence.push({ ...ev, turnIndex: tIdx });
          }
          const tally = commandTallies.get(tIdx) ?? new Map<string, number>();
          tally.set(block.command, (tally.get(block.command) ?? 0) + 1);
          commandTallies.set(tIdx, tally);
          // The plugin's own keep: turns that ran the waybill CLI (the
          // "${CLAUDE_PLUGIN_ROOT}/bin/waybill" launcher or the built
          // waybill.mjs) are tagged so spend can itemize the overhead.
          if (block.command.includes("bin/waybill") || block.command.includes("waybill.mjs")) {
            overheadTurns.add(tIdx);
          }
        }
        if (block.name === "Read" && block.file_path !== null) {
          const tally = readTallies.get(tIdx) ?? new Map<string, number>();
          tally.set(block.file_path, (tally.get(block.file_path) ?? 0) + 1);
          readTallies.set(tIdx, tally);
        }
      }
      if (typeof msg.id !== "string" || !msg.usage) continue;
      // Zero-usage messages (e.g. synthetic error placeholders) meter
      // nothing; skipping them keeps zero-token events out of the streams.
      const probe = tokensFromUsage(msg.usage);
      if (
        probe.input === 0 && probe.output === 0 &&
        probe.cache_read === 0 && probe.cache_creation === 0 &&
        !byMessage.has(msg.id)
      ) {
        continue;
      }
      const model = typeof msg.model === "string" ? msg.model : "unknown";
      const ts = typeof line.timestamp === "string" ? line.timestamp : "";
      const prior = byMessage.get(msg.id);
      if (prior) {
        // Never let a degenerate all-zero duplicate line clobber real usage.
        if (!(probe.input === 0 && probe.output === 0 && probe.cache_read === 0 && probe.cache_creation === 0)) {
          prior.tokens = probe;
          prior.extras = extraNumerics(msg.usage);
          if (ts !== "") prior.ts = ts;
        }
      } else {
        const turn = ensureTurn();
        if (turn.firstMessageId === null) turn.firstMessageId = msg.id;
        turn.lastMessageId = msg.id;
        if (!models.includes(model)) models.push(model);
        byMessage.set(msg.id, {
          turnIndex: turn.index,
          model,
          tokens: tokensFromUsage(msg.usage),
          extras: extraNumerics(msg.usage),
          ts,
        });
      }
    }
  }

  const totals: TokenCounts = { input: 0, output: 0, cache_read: 0, cache_creation: 0 };
  const turnByIndex = new Map<number, Turn>();
  for (const t of turns) turnByIndex.set(t.index, t);

  for (const rec of byMessage.values()) {
    totals.input += rec.tokens.input;
    totals.output += rec.tokens.output;
    totals.cache_read += rec.tokens.cache_read;
    totals.cache_creation += rec.tokens.cache_creation;
    const turn = turnByIndex.get(rec.turnIndex);
    if (!turn) continue;
    let agg = turn.models.find((m) => m.model === rec.model);
    if (!agg) {
      agg = {
        model: rec.model,
        tokens: { input: 0, output: 0, cache_read: 0, cache_creation: 0, cache_creation_5m: 0, cache_creation_1h: 0 },
        extras: {},
        lastTs: rec.ts,
      };
      turn.models.push(agg);
    }
    agg.tokens.input += rec.tokens.input;
    agg.tokens.output += rec.tokens.output;
    agg.tokens.cache_read += rec.tokens.cache_read;
    agg.tokens.cache_creation += rec.tokens.cache_creation;
    agg.tokens.cache_creation_5m += rec.tokens.cache_creation_5m;
    agg.tokens.cache_creation_1h += rec.tokens.cache_creation_1h;
    for (const [k, v] of Object.entries(rec.extras)) {
      agg.extras[k] = (agg.extras[k] ?? 0) + v;
    }
    if (rec.ts > agg.lastTs) agg.lastTs = rec.ts;
  }

  for (const t of turns) {
    for (const n of commandTallies.get(t.index)?.values() ?? []) {
      t.waste.retried_commands += Math.max(0, n - 1);
    }
    for (const n of readTallies.get(t.index)?.values() ?? []) {
      t.waste.repeated_reads += Math.max(0, n - 1);
    }
    if (overheadTurns.has(t.index)) t.overhead = true;
  }

  const messageCount = byMessage.size;
  const nonEmptyTurns = turns.filter((t) => t.models.length > 0);

  return {
    sessionId,
    cwds,
    agentId,
    version,
    cwd,
    branches,
    models,
    firstTs,
    lastTs,
    turns: nonEmptyTurns,
    evidence,
    messageCount,
    totals,
  };
}
