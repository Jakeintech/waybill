#!/usr/bin/env node

// src/core/home.ts
import { homedir } from "node:os";
import { join } from "node:path";
function resolveHome(env = process.env) {
  const fromEnv = env["WAYBILL_HOME"];
  if (fromEnv && fromEnv.trim() !== "") return fromEnv;
  return join(homedir(), ".waybill");
}

// src/core/canonical.ts
function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error("canonicalJson: non-finite number");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v) => canonicalJson(v === void 0 ? null : v)).join(",") + "]";
  }
  const obj = value;
  const keys = Object.keys(obj).filter((k) => obj[k] !== void 0).sort();
  const parts = keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k]));
  return "{" + parts.join(",") + "}";
}

// src/core/sha.ts
import { createHash } from "node:crypto";
function sha256Hex(input) {
  return createHash("sha256").update(input, "utf8").digest("hex");
}
function sha256Bytes(input) {
  return new Uint8Array(createHash("sha256").update(input, "utf8").digest());
}

// src/core/escrow.ts
function escrowPayload(keyOrTitle, low, high, loggedAt) {
  return `estimate.v1|${keyOrTitle}|${low}|${high}|hours|${loggedAt}`;
}
function sealEstimate(keyOrTitle, estimate) {
  return {
    algo: "sha256",
    payload: "estimate.v1",
    sha256: sha256Hex(escrowPayload(keyOrTitle, estimate.low, estimate.high, estimate.logged_at))
  };
}
function checkEscrow(entry) {
  if (!entry.escrow) return { status: "absent" };
  const est = entry.estimate_without_claude_hours;
  if (!est) return { status: "mismatch", expected: "(no estimate present)", found: entry.escrow.sha256 };
  const expected = sha256Hex(
    escrowPayload(entry.tracker_key ?? entry.title, est.low, est.high, est.logged_at)
  );
  if (expected === entry.escrow.sha256) return { status: "ok" };
  return { status: "mismatch", expected, found: entry.escrow.sha256 };
}

// src/core/streams.ts
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join as join2 } from "node:path";

// src/core/ulid.ts
var ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function encodeTime(ms) {
  if (!Number.isInteger(ms) || ms < 0 || ms > 2 ** 48 - 1) {
    throw new Error(`ulid: timestamp out of range: ${ms}`);
  }
  let out = "";
  let rest = ms;
  for (let i = 0; i < 10; i++) {
    out = ALPHABET[rest % 32] + out;
    rest = Math.floor(rest / 32);
  }
  return out;
}
function encodeEntropy(bytes) {
  if (bytes.length < 10) throw new Error("ulid: need 10 entropy bytes");
  let out = "";
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < 10; i++) {
    acc = acc << 8 | bytes[i];
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[acc >> bits & 31];
    }
  }
  return out;
}
function deterministicUlid(ts, stream, content) {
  const ms = Date.parse(ts);
  if (Number.isNaN(ms)) throw new Error(`ulid: unparseable ts: ${ts}`);
  const digest = sha256Bytes(stream + "\n" + canonicalJson(content));
  return encodeTime(ms) + encodeEntropy(digest);
}
function isUlid(s) {
  return /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/.test(s);
}

// src/core/events.ts
var SCHEMA_VERSION = 2;
function finalizeEvent(stream, body) {
  const id = deterministicUlid(body.ts, stream, body);
  return { id, ...body };
}
function serializeEvent(event) {
  return JSON.stringify(event);
}

// src/core/streams.ts
function shardFor(ts) {
  const m = /^(\d{4})-(\d{2})/.exec(ts);
  if (!m) throw new Error(`streams: unshardable ts: ${ts}`);
  return `${m[1]}-${m[2]}`;
}
function streamDir(home, stream) {
  return join2(home, "streams", stream);
}
function shardPath(home, stream, shard) {
  return join2(streamDir(home, stream), `${shard}.jsonl`);
}
function appendEvents(home, stream, events) {
  if (events.length === 0) return;
  const byShard = /* @__PURE__ */ new Map();
  for (const e of events) {
    const shard = shardFor(e.ts);
    const bucket = byShard.get(shard) ?? [];
    bucket.push(e);
    byShard.set(shard, bucket);
  }
  mkdirSync(streamDir(home, stream), { recursive: true });
  for (const [shard, bucket] of [...byShard.entries()].sort()) {
    const lines = bucket.map((e) => serializeEvent(e) + "\n").join("");
    appendFileSync(shardPath(home, stream, shard), lines, "utf8");
  }
}
function listShards(home, stream) {
  const dir = streamDir(home, stream);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort().map((f) => f.replace(/\.jsonl$/, ""));
}
function readStream(home, stream) {
  const out = [];
  for (const shard of listShards(home, stream)) {
    const raw = readFileSync(shardPath(home, stream, shard), "utf8");
    let lineNo = 0;
    for (const line of raw.split("\n")) {
      lineNo += 1;
      if (line.trim() === "") continue;
      out.push({ event: JSON.parse(line), shard, lineNo });
    }
  }
  return out;
}
function readEvents(home, stream) {
  return readStream(home, stream).map((l) => l.event);
}
function authoritative(events) {
  const superseded = /* @__PURE__ */ new Set();
  for (const e of events) if (e.supersedes) superseded.add(e.supersedes);
  return events.filter((e) => !superseded.has(e.id));
}

// src/verify/verify.ts
var STREAM_KINDS = {
  ledger: /* @__PURE__ */ new Set(["opened", "progress", "shipped", "correction", "pin"]),
  usage: /* @__PURE__ */ new Set(["usage", "correction"]),
  sessions: /* @__PURE__ */ new Set(["session", "correction"]),
  exceptions: /* @__PURE__ */ new Set(["ambiguity", "resolution", "meter_discrepancy", "meter_gap"])
};
var STREAMS = ["ledger", "usage", "sessions", "exceptions"];
function isIsoUtc(ts) {
  return typeof ts === "string" && !Number.isNaN(Date.parse(ts));
}
function zeroTotals() {
  return { input: 0, output: 0, cache_read: 0, cache_creation: 0 };
}
function addTotals(into, add) {
  into.input += add.input;
  into.output += add.output;
  into.cache_read += add.cache_read;
  into.cache_creation += add.cache_creation;
}
function totalsEqual(a, b) {
  return a.input === b.input && a.output === b.output && a.cache_read === b.cache_read && a.cache_creation === b.cache_creation;
}
function verifyHome(home) {
  const findings = [];
  const seenIds = /* @__PURE__ */ new Map();
  const byStream = /* @__PURE__ */ new Map();
  for (const stream of STREAMS) {
    let lines;
    try {
      lines = readStream(home, stream);
    } catch (err) {
      findings.push({
        check: "envelope",
        stream,
        shard: null,
        id: null,
        message: `stream unreadable: ${err.message}`
      });
      continue;
    }
    const events = [];
    for (const { event, shard, lineNo } of lines) {
      const where = `${stream}/${shard}.jsonl:${lineNo}`;
      if (typeof event !== "object" || event === null || typeof event.id !== "string" || !isIsoUtc(event.ts) || typeof event.kind !== "string" || typeof event.schema_version !== "number" || event.supersedes !== null && typeof event.supersedes !== "string") {
        findings.push({ check: "envelope", stream, shard, id: null, message: `${where}: invalid envelope` });
        continue;
      }
      if (!STREAM_KINDS[stream].has(event.kind)) {
        findings.push({
          check: "envelope",
          stream,
          shard,
          id: event.id,
          message: `${where}: kind "${event.kind}" not valid for stream "${stream}"`
        });
      }
      if (!isUlid(event.id)) {
        findings.push({ check: "envelope", stream, shard, id: event.id, message: `${where}: id is not a ULID` });
      } else {
        const { id: _id, ...content } = event;
        const expected = deterministicUlid(event.ts, stream, content);
        if (expected !== event.id) {
          findings.push({
            check: "id_deterministic",
            stream,
            shard,
            id: event.id,
            message: `${where}: id does not recompute from content (expected ${expected})`
          });
        }
      }
      if (shardFor(event.ts) !== shard) {
        findings.push({
          check: "shard_placement",
          stream,
          shard,
          id: event.id,
          message: `${where}: ts ${event.ts} belongs in shard ${shardFor(event.ts)}`
        });
      }
      const prior = seenIds.get(event.id);
      if (prior !== void 0) {
        findings.push({
          check: "id_unique",
          stream,
          shard,
          id: event.id,
          message: `${where}: id already seen at ${prior}`
        });
      } else {
        seenIds.set(event.id, where);
      }
      events.push(event);
    }
    byStream.set(stream, events);
  }
  for (const stream of STREAMS) {
    const events = byStream.get(stream) ?? [];
    const ids = new Set(events.map((e) => e.id));
    for (const e of events) {
      if (e.supersedes !== null && !ids.has(e.supersedes)) {
        findings.push({
          check: "supersedes",
          stream,
          shard: shardFor(e.ts),
          id: e.id,
          message: `supersedes ${e.supersedes}, which does not exist in stream "${stream}"`
        });
      }
    }
  }
  for (const raw of byStream.get("ledger") ?? []) {
    if (raw.kind === "pin") continue;
    const e = raw;
    if (e.escrow) {
      const result = checkEscrow(e);
      if (result.status === "mismatch") {
        findings.push({
          check: "escrow",
          stream: "ledger",
          shard: shardFor(e.ts),
          id: e.id,
          message: `escrow hash does not recompute (expected ${result.expected}, found ${result.found})`
        });
      }
    }
    const est = e.estimate_without_claude_hours;
    if (est && est.pre_registered && Date.parse(est.logged_at) > Date.parse(e.ts)) {
      findings.push({
        check: "pre_registration",
        stream: "ledger",
        shard: shardFor(e.ts),
        id: e.id,
        message: `pre_registered estimate logged_at ${est.logged_at} is after entry ts ${e.ts}`
      });
    }
  }
  const usage = authoritative(byStream.get("usage") ?? []).filter(
    (e) => e.kind === "usage"
  );
  const sessions = authoritative(byStream.get("sessions") ?? []).filter(
    (e) => e.kind === "session"
  );
  const receipts = /* @__PURE__ */ new Map();
  for (const s of sessions) receipts.set(s.session_id, s);
  const observed = /* @__PURE__ */ new Map();
  for (const u of usage) {
    const t = observed.get(u.session_id) ?? zeroTotals();
    addTotals(t, u.tokens);
    observed.set(u.session_id, t);
  }
  for (const [sessionId, sums] of [...observed.entries()].sort()) {
    const receipt = receipts.get(sessionId);
    if (!receipt) {
      findings.push({
        check: "conservation",
        stream: "usage",
        shard: null,
        id: null,
        message: `session ${sessionId}: usage events exist but no session receipt`
      });
      continue;
    }
    if (!totalsEqual(sums, receipt.totals)) {
      findings.push({
        check: "conservation",
        stream: "sessions",
        shard: null,
        id: receipt.id,
        message: `session ${sessionId}: \u03A3 usage ${canonicalJson(sums)} \u2260 receipt totals ` + canonicalJson(receipt.totals)
      });
    }
  }
  for (const [sessionId, receipt] of [...receipts.entries()].sort()) {
    if (!observed.has(sessionId) && (receipt.totals.input > 0 || receipt.totals.output > 0)) {
      findings.push({
        check: "conservation",
        stream: "sessions",
        shard: null,
        id: receipt.id,
        message: `session ${sessionId}: receipt has totals but no usage events`
      });
    }
  }
  return findings;
}
function renderFindings(findings, home) {
  const lines = [];
  if (findings.length === 0) {
    lines.push(`waybill verify: ${home}`);
    lines.push("All checks passed. Every escrow seal recomputes; every metered token is accounted for.");
    return lines.join("\n");
  }
  lines.push(`waybill verify: ${home}`);
  lines.push(`${findings.length} finding(s):`);
  for (const f of findings) {
    lines.push(`  [${f.check}] ${f.message}`);
  }
  return lines.join("\n");
}

// src/cli/cmd-append.ts
import { execFileSync } from "node:child_process";
import { readFileSync as readFileSync2 } from "node:fs";
var STREAMS2 = ["ledger", "usage", "sessions", "exceptions"];
function runAppend(home, args, json) {
  let stream = null;
  let bodyJson = null;
  let commit = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--stream") {
      const s = args[++i];
      if (!s || !STREAMS2.includes(s)) {
        process.stderr.write(`waybill append: --stream must be one of ${STREAMS2.join(", ")}
`);
        return 2;
      }
      stream = s;
    } else if (a === "--event") bodyJson = args[++i] ?? null;
    else if (a === "--stdin") bodyJson = readFileSync2(0, "utf8");
    else if (a === "--commit") commit = true;
    else {
      process.stderr.write(`waybill append: unknown option ${a}
`);
      return 2;
    }
  }
  if (!stream || !bodyJson) {
    process.stderr.write("waybill append: pass --stream <name> and --event '<json>' (or --stdin)\n");
    return 2;
  }
  let body;
  try {
    body = JSON.parse(bodyJson);
  } catch (err) {
    process.stderr.write(`waybill append: event is not valid JSON: ${err.message}
`);
    return 2;
  }
  if ("id" in body) {
    process.stderr.write("waybill append: do not supply an id \u2014 ids are derived from content\n");
    return 2;
  }
  if (typeof body["ts"] !== "string" || Number.isNaN(Date.parse(body["ts"]))) {
    process.stderr.write("waybill append: event needs an ISO 8601 ts\n");
    return 2;
  }
  if (typeof body["kind"] !== "string") {
    process.stderr.write("waybill append: event needs a kind\n");
    return 2;
  }
  body["schema_version"] = SCHEMA_VERSION;
  if (!("supersedes" in body)) body["supersedes"] = null;
  if (body["supersedes"] !== null) {
    const target = body["supersedes"];
    const exists = readEvents(home, stream).some((e) => e.id === target);
    if (!exists) {
      process.stderr.write(`waybill append: supersedes target ${String(target)} not found in ${stream}
`);
      return 1;
    }
  }
  if (stream === "ledger" && body["kind"] === "opened") {
    const est = body["estimate_without_claude_hours"];
    if (est && est.pre_registered === true && !body["escrow"]) {
      if (typeof est.low !== "number" || typeof est.high !== "number") {
        process.stderr.write("waybill append: estimate needs numeric low/high\n");
        return 2;
      }
      if (!est.logged_at) est.logged_at = body["ts"];
      const keyOrTitle = body["tracker_key"] ?? body["title"];
      body["escrow"] = sealEstimate(keyOrTitle, est);
    }
    if (est && est.pre_registered === true && Date.parse(est.logged_at) > Date.parse(body["ts"])) {
      process.stderr.write("waybill append: refusing a pre_registered estimate logged after the entry ts\n");
      return 1;
    }
  }
  const event = finalizeEvent(stream, body);
  const duplicate = readEvents(home, stream).some((e) => e.id === event.id);
  if (duplicate) {
    if (json) process.stdout.write(JSON.stringify({ id: event.id, appended: false, reason: "duplicate" }) + "\n");
    else process.stdout.write(`already present: ${event.id}
`);
    return 0;
  }
  appendEvents(home, stream, [event]);
  if (commit) {
    try {
      execFileSync("git", ["-C", home, "add", "-A"], { stdio: ["ignore", "ignore", "ignore"], timeout: 15e3 });
      execFileSync("git", ["-C", home, "commit", "-m", `ledger: ${String(body["kind"])} appended`], {
        stdio: ["ignore", "ignore", "ignore"],
        timeout: 15e3
      });
    } catch {
    }
  }
  if (json) process.stdout.write(JSON.stringify({ id: event.id, appended: true }) + "\n");
  else process.stdout.write(`appended ${event.id} to ${stream}
`);
  return 0;
}

// src/core/config.ts
import { existsSync as existsSync2, readFileSync as readFileSync3, writeFileSync } from "node:fs";
import { join as join3 } from "node:path";
function defaultConfig() {
  return {
    schema_version: 2,
    tracker: { kind: null, project_keys: [], base_url: null },
    git: { kind: "local", repos: [], default_branch: "main" },
    baseline: {
      velocity_points_per_sprint: null,
      median_cycle_time_days: null,
      window: null,
      derived_from: null
    },
    allocations: [],
    metering: {
      enabled: true,
      sources: ["transcript"],
      branch_key_pattern: "[A-Z][A-Z0-9]+-[0-9]+",
      repo_defaults: {}
    },
    pricing: { version: null, unknown_model_policy: "tokens_only", models: {} },
    budgets: { allocation: "inherit", epics: {} },
    audience_default: "self",
    last_sync: null
  };
}
function configPath(home) {
  return join3(home, "config.json");
}
function loadConfig(home) {
  const p = configPath(home);
  if (!existsSync2(p)) return defaultConfig();
  const raw = JSON.parse(readFileSync3(p, "utf8"));
  const base = defaultConfig();
  return {
    ...base,
    ...raw,
    tracker: { ...base.tracker, ...raw.tracker },
    git: { ...base.git, ...raw.git },
    baseline: { ...base.baseline, ...raw.baseline },
    metering: { ...base.metering, ...raw.metering },
    pricing: { ...base.pricing, ...raw.pricing },
    budgets: { ...base.budgets, ...raw.budgets }
  };
}
function saveConfig(home, config) {
  writeFileSync(configPath(home), JSON.stringify(config, null, 2) + "\n", "utf8");
}
function identityPath(home) {
  return join3(home, "identity.json");
}
function loadIdentity(home) {
  const p = identityPath(home);
  if (!existsSync2(p)) return null;
  return JSON.parse(readFileSync3(p, "utf8"));
}
function saveIdentity(home, identity) {
  writeFileSync(identityPath(home), JSON.stringify(identity, null, 2) + "\n", "utf8");
}

// src/gitlocal/gitlocal.ts
import { execFileSync as execFileSync2 } from "node:child_process";
import { existsSync as existsSync3 } from "node:fs";
var FIELD_SEP = "";
var RECORD_SEP = "";
function gitLogRaw(path, sinceIso) {
  return execFileSync2(
    "git",
    [
      "-C",
      path,
      "log",
      `--since=${sinceIso}`,
      "--date=iso-strict",
      "--pretty=format:%H%x1f%ae%x1f%ad%x1f%P%x1f%D%x1f%s%x1e"
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3e4, maxBuffer: 64 * 1024 * 1024 }
  );
}
function parseGitLog(raw) {
  const out = [];
  for (const record of raw.split(RECORD_SEP)) {
    const line = record.replace(/^\n/, "");
    if (line.trim() === "") continue;
    const parts = line.split(FIELD_SEP);
    if (parts.length < 6) continue;
    const [sha, email, date, parents, refs, ...subject] = parts;
    out.push({
      sha,
      author_email: email,
      author_date: date,
      parents: parents.trim() === "" ? 0 : parents.trim().split(" ").length,
      refs: refs.split(",").map((r) => r.trim()).filter((r) => r !== ""),
      subject: subject.join(FIELD_SEP)
    });
  }
  return out;
}
function summarizeRepo(repo, path, commits, identityEmails, keyPattern) {
  const emails = new Set(identityEmails.map((e) => e.toLowerCase()));
  const mine = commits.filter((c) => emails.has(c.author_email.toLowerCase()));
  const keyRe = new RegExp(keyPattern, "g");
  const keyCounts = /* @__PURE__ */ new Map();
  const tags = [];
  const days = /* @__PURE__ */ new Set();
  let first = null;
  let last = null;
  let merges = 0;
  for (const c of mine) {
    if (c.parents > 1) merges += 1;
    days.add(c.author_date.slice(0, 10));
    if (first === null || c.author_date < first) first = c.author_date;
    if (last === null || c.author_date > last) last = c.author_date;
    for (const k of c.subject.match(keyRe) ?? []) {
      keyCounts.set(k, (keyCounts.get(k) ?? 0) + 1);
    }
    for (const ref of c.refs) {
      if (ref.startsWith("tag: ") && !tags.includes(ref.slice(5))) tags.push(ref.slice(5));
    }
  }
  const keys = [...keyCounts.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : 1));
  return {
    repo,
    path,
    commits: mine.length,
    merges,
    active_days: days.size,
    first_date: first ? first.slice(0, 10) : null,
    last_date: last ? last.slice(0, 10) : null,
    keys,
    tags
  };
}
function isGitRepo(path) {
  if (!existsSync3(path)) return false;
  try {
    execFileSync2("git", ["-C", path, "rev-parse", "--git-dir"], {
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 5e3
    });
    return true;
  } catch {
    return false;
  }
}

// src/meter/run.ts
import { execFileSync as execFileSync3 } from "node:child_process";
import { existsSync as existsSync5, readFileSync as readFileSync5, readdirSync as readdirSync2, statSync } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { join as join5 } from "node:path";

// src/attribution/resolver.ts
var RULES_VERSION = "1";
function keyFromBranch(branch, pattern) {
  if (!branch) return null;
  const m = branch.match(new RegExp(pattern));
  return m ? m[0] : null;
}
function attribution(account, resolver, confidence) {
  return {
    account,
    tracker_key: account.startsWith("story:") ? account.slice("story:".length) : null,
    resolver,
    confidence,
    rules_version: RULES_VERSION
  };
}
function resolveTurn(turn, ctx) {
  let ambiguity = null;
  const turnTs = turn.models.reduce((max, m) => m.lastTs > max ? m.lastTs : max, "");
  const matchingPins = ctx.pins.filter((p) => {
    if (p.session_id !== ctx.sessionId) return false;
    if (p.range === null) return true;
    if (turnTs === "") return false;
    const fromOk = p.range.from <= turnTs;
    const toOk = p.range.to === null || turnTs <= p.range.to;
    return fromOk && toOk;
  });
  if (matchingPins.length === 1) {
    return { attribution: attribution(matchingPins[0].account, "pin", 1), ambiguity: null };
  }
  if (matchingPins.length > 1) {
    const accounts = [...new Set(matchingPins.map((p) => p.account))].sort();
    if (accounts.length === 1) {
      return { attribution: attribution(accounts[0], "pin", 1), ambiguity: null };
    }
    ambiguity = ambiguity ?? { rule: "pin", candidates: accounts };
  }
  const candidates = ctx.openEntries.filter(
    (e) => e.tracker_key !== null && (ctx.repo === null || e.repo === null || e.repo === ctx.repo)
  );
  const keys = [...new Set(candidates.map((e) => e.tracker_key))].sort();
  if (keys.length === 1) {
    return { attribution: attribution(`story:${keys[0]}`, "active_entry", 0.9), ambiguity };
  }
  if (keys.length > 1) {
    ambiguity = ambiguity ?? { rule: "active_entry", candidates: keys.map((k) => `story:${k}`) };
  }
  const applicable = ctx.evidence.filter((e) => e.turnIndex < turn.index);
  const lastEvidence = applicable[applicable.length - 1];
  if (lastEvidence) {
    return {
      attribution: attribution(`story:${lastEvidence.key}`, "transcript_evidence", 0.75),
      ambiguity
    };
  }
  const branchKey = keyFromBranch(turn.branchAtStart, ctx.branchKeyPattern);
  if (branchKey) {
    return { attribution: attribution(`story:${branchKey}`, "session_branch", 0.6), ambiguity };
  }
  if (ctx.repo !== null) {
    const dflt = ctx.repoDefaults[ctx.repo];
    if (typeof dflt === "string" && dflt !== "") {
      const account = dflt.includes(":") ? dflt : `story:${dflt}`;
      return { attribution: attribution(account, "repo_default", 0.4), ambiguity };
    }
  }
  return { attribution: attribution("unattributed", "none", 1), ambiguity };
}

// src/meter/transcript.ts
var KNOWN_USAGE_FIELDS = /* @__PURE__ */ new Set([
  "input_tokens",
  "output_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
  "cache_creation"
]);
function asInt(v) {
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : 0;
}
function tokensFromUsage(usage) {
  const cc = usage["cache_creation"];
  const cc5m = asInt(cc?.["ephemeral_5m_input_tokens"]);
  const cc1h = asInt(cc?.["ephemeral_1h_input_tokens"]);
  let cacheCreation = asInt(usage["cache_creation_input_tokens"]);
  if (cacheCreation === 0 && (cc5m > 0 || cc1h > 0)) cacheCreation = cc5m + cc1h;
  return {
    input: asInt(usage["input_tokens"]),
    output: asInt(usage["output_tokens"]),
    cache_read: asInt(usage["cache_read_input_tokens"]),
    cache_creation: cacheCreation,
    cache_creation_5m: cc5m,
    cache_creation_1h: cc1h
  };
}
function extraNumerics(usage, prefix = "", known = KNOWN_USAGE_FIELDS) {
  const out = {};
  for (const [k, v] of Object.entries(usage)) {
    if (prefix === "" && known.has(k)) continue;
    const path = prefix === "" ? k : `${prefix}.${k}`;
    if (typeof v === "number" && Number.isFinite(v)) {
      out[path] = v;
    } else if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      Object.assign(out, extraNumerics(v, path, known));
    }
  }
  return out;
}
function isPromptLine(line) {
  if (line.type !== "user" || line.isSidechain === true) return false;
  if (line.toolUseResult !== void 0) return false;
  const msg = line.message;
  if (!msg || msg.role !== void 0 && msg.role !== "user") return false;
  const content = msg.content;
  if (typeof content === "string") return content.trim() !== "";
  if (Array.isArray(content)) {
    let hasText = false;
    for (const item of content) {
      const t = item.type;
      if (t === "tool_result") return false;
      if (t === "text") hasText = true;
    }
    return hasText;
  }
  return false;
}
var CHECKOUT_RE = /\bgit\s+(?:checkout|switch)\s+(?:-[bc]\s+)?(\S+)/g;
var COMMIT_RE = /\bgit\s+commit\b[^\n]*?-m\s+(?:"([^"]*)"|'([^']*)')/g;
var PR_RE = /\bgh\s+pr\s+(?:create|checkout|merge|view)\b[^\n]*/g;
function evidenceFromCommand(command, keyPattern) {
  const out = [];
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
function toolCommands(content) {
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const item of content) {
    const block = item;
    if (block.type === "tool_use" && typeof block.input?.command === "string") {
      out.push(block.input.command);
    }
  }
  return out;
}
function parseTranscript(raw, options) {
  const keyPattern = new RegExp(options.branchKeyPattern, "g");
  const text = raw;
  const turns = [];
  const evidence = [];
  const branches = [];
  const models = [];
  const byMessage = /* @__PURE__ */ new Map();
  let sessionId = null;
  let version = null;
  let cwd = null;
  let currentBranch = null;
  let firstTs = null;
  let lastTs = null;
  let turnIndex = 0;
  let currentTurn = null;
  const ensureTurn = () => {
    if (!currentTurn) {
      currentTurn = {
        index: turnIndex,
        promptId: null,
        branchAtStart: currentBranch,
        firstMessageId: null,
        lastMessageId: null,
        models: []
      };
      turns.push(currentTurn);
    }
    return currentTurn;
  };
  for (const lineText of text.split("\n")) {
    if (lineText.trim() === "") continue;
    let line;
    try {
      line = JSON.parse(lineText);
    } catch {
      continue;
    }
    if (sessionId === null && typeof line.sessionId === "string") sessionId = line.sessionId;
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
        firstMessageId: null,
        lastMessageId: null,
        models: []
      };
      turns.push(currentTurn);
      continue;
    }
    if (line.type === "assistant" && line.message) {
      const msg = line.message;
      for (const command of toolCommands(msg.content)) {
        for (const ev of evidenceFromCommand(command, keyPattern)) {
          evidence.push({ ...ev, turnIndex: currentTurn?.index ?? turnIndex });
        }
      }
      if (typeof msg.id !== "string" || !msg.usage) continue;
      const model = typeof msg.model === "string" ? msg.model : "unknown";
      const ts = typeof line.timestamp === "string" ? line.timestamp : "";
      const prior = byMessage.get(msg.id);
      if (prior) {
        prior.tokens = tokensFromUsage(msg.usage);
        prior.extras = extraNumerics(msg.usage);
        if (ts !== "") prior.ts = ts;
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
          ts
        });
      }
    }
  }
  const totals = { input: 0, output: 0, cache_read: 0, cache_creation: 0 };
  const turnByIndex = /* @__PURE__ */ new Map();
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
        lastTs: rec.ts
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
  const messageCount = byMessage.size;
  const nonEmptyTurns = turns.filter((t) => t.models.length > 0);
  return {
    sessionId,
    version,
    cwd,
    branches,
    models,
    firstTs,
    lastTs,
    turns: nonEmptyTurns,
    evidence,
    messageCount,
    totals
  };
}

// src/meter/meter.ts
function priceTokens(config, model, tokens) {
  const version = config.pricing.version;
  const rates = config.pricing.models[model];
  if (!version || !rates) return null;
  const cc5m = tokens.cache_creation_5m === 0 && tokens.cache_creation_1h === 0 ? tokens.cache_creation : tokens.cache_creation_5m;
  const e4 = (r) => Math.round(r * 1e4);
  const exact = [
    rates.input_per_mtok,
    rates.output_per_mtok,
    rates.cache_read_per_mtok,
    rates.cache_write_5m_per_mtok,
    rates.cache_write_1h_per_mtok
  ].every((r) => Math.abs(r * 1e4 - e4(r)) < 1e-6);
  const terms = [
    [tokens.input, rates.input_per_mtok],
    [tokens.output, rates.output_per_mtok],
    [tokens.cache_read, rates.cache_read_per_mtok],
    [cc5m, rates.cache_write_5m_per_mtok],
    [tokens.cache_creation_1h, rates.cache_write_1h_per_mtok]
  ];
  let value;
  if (exact) {
    let e10 = 0;
    for (const [n, r] of terms) e10 += n * e4(r);
    value = Math.round(e10 / 1e6) / 1e4;
  } else {
    let raw = 0;
    for (const [n, r] of terms) raw += n * r;
    value = Math.round(raw / 100) / 1e4;
  }
  return { value, pricing_version: version };
}
function meterTranscript(input) {
  const transcript = parseTranscript(input.raw, {
    branchKeyPattern: input.config.metering.branch_key_pattern
  });
  const sessionId = transcript.sessionId;
  const newUsage = [];
  const newSessions = [];
  const newExceptions = [];
  if (sessionId === null || transcript.lastTs === null) {
    if (sessionId !== null) {
      const gapBody = {
        ts: (/* @__PURE__ */ new Date(0)).toISOString().replace(/\.\d{3}Z$/, "Z"),
        kind: "meter_gap",
        schema_version: SCHEMA_VERSION,
        supersedes: null,
        session_id: sessionId,
        reason: "unreadable"
      };
      const gap = finalizeEvent("exceptions", gapBody);
      if (!input.existingExceptions.some((e) => e.id === gap.id)) newExceptions.push(gap);
    }
    return { sessionId, transcript, newUsage, newSessions, newExceptions };
  }
  const pins = authoritative(input.ledgerEvents).filter(
    (e) => e.kind === "pin"
  );
  const openEntries = selectOpenEntries(input.ledgerEvents);
  const ctx = {
    sessionId,
    repo: input.repo,
    branchKeyPattern: input.config.metering.branch_key_pattern,
    pins,
    openEntries,
    repoDefaults: input.config.metering.repo_defaults,
    evidence: transcript.evidence
  };
  const existingUsageAuth = authoritative(input.existingUsage).filter(
    (u) => u.kind === "usage" && u.session_id === sessionId
  );
  const usageByGrain = /* @__PURE__ */ new Map();
  for (const u of existingUsageAuth) {
    usageByGrain.set(`${u.turn.index}|${u.model}`, u);
  }
  const existingIds = new Set(input.existingUsage.map((u) => u.id));
  const emitted = zeroTotals();
  for (const turn of transcript.turns) {
    const { attribution: attribution2, ambiguity } = resolveTurn(turn, ctx);
    if (ambiguity) {
      const ambBody = {
        ts: turn.models[0].lastTs || transcript.lastTs,
        kind: "ambiguity",
        schema_version: SCHEMA_VERSION,
        supersedes: null,
        session_id: sessionId,
        turn: { index: turn.index, first_message_id: turn.firstMessageId ?? "" },
        rule: ambiguity.rule,
        candidates: ambiguity.candidates,
        status: "open"
      };
      const amb = finalizeEvent("exceptions", ambBody);
      if (!input.existingExceptions.some((e) => e.id === amb.id) && !newExceptions.some((e) => e.id === amb.id)) {
        newExceptions.push(amb);
      }
    }
    for (const agg of [...turn.models].sort((a, b) => a.model < b.model ? -1 : 1)) {
      addTotals(emitted, agg.tokens);
      const ts = agg.lastTs !== "" ? agg.lastTs : transcript.lastTs;
      const prior = usageByGrain.get(`${turn.index}|${agg.model}`);
      const extras = Object.keys(agg.extras).length > 0 ? sortRecord(agg.extras) : null;
      const body = {
        ts,
        kind: "usage",
        schema_version: SCHEMA_VERSION,
        supersedes: null,
        session_id: sessionId,
        turn: {
          index: turn.index,
          first_message_id: turn.firstMessageId ?? "",
          last_message_id: turn.lastMessageId ?? "",
          prompt_id: turn.promptId
        },
        repo: input.repo,
        model: agg.model,
        tokens: agg.tokens,
        cost_usd: priceTokens(input.config, agg.model, agg.tokens),
        attribution: attribution2,
        source: "transcript",
        transcript_version: transcript.version,
        raw_extra: extras
      };
      let event = finalizeEvent("usage", body);
      if (prior && prior.id !== event.id) {
        event = finalizeEvent("usage", { ...body, supersedes: prior.id });
      } else if (prior && prior.id === event.id) {
        continue;
      }
      if (!existingIds.has(event.id)) newUsage.push(event);
    }
  }
  if (!totalsEqual(emitted, transcript.totals)) {
    const discBody = {
      ts: transcript.lastTs,
      kind: "meter_discrepancy",
      schema_version: SCHEMA_VERSION,
      supersedes: null,
      session_id: sessionId,
      expected: transcript.totals,
      observed: emitted,
      detail: "sum of turn aggregates does not equal source usage totals"
    };
    const disc = finalizeEvent("exceptions", discBody);
    if (!input.existingExceptions.some((e) => e.id === disc.id)) newExceptions.push(disc);
  }
  const priorReceipt = authoritative(input.existingSessions).find(
    (s) => s.kind === "session" && s.session_id === sessionId
  );
  const receiptBody = {
    ts: transcript.lastTs,
    kind: "session",
    schema_version: SCHEMA_VERSION,
    supersedes: null,
    session_id: sessionId,
    transcript_path: input.transcriptPath,
    transcript_version: transcript.version,
    cwd: transcript.cwd,
    repo: input.repo,
    branches: transcript.branches,
    models: transcript.models,
    first_ts: transcript.firstTs ?? transcript.lastTs,
    last_ts: transcript.lastTs,
    turns: transcript.turns.length,
    messages: transcript.messageCount,
    totals: transcript.totals,
    source: "transcript"
  };
  let receipt = finalizeEvent("sessions", receiptBody);
  if (priorReceipt && priorReceipt.id !== receipt.id) {
    receipt = finalizeEvent("sessions", { ...receiptBody, supersedes: priorReceipt.id });
    newSessions.push(receipt);
  } else if (!priorReceipt) {
    newSessions.push(receipt);
  }
  return { sessionId, transcript, newUsage, newSessions, newExceptions };
}
function selectOpenEntries(events) {
  const entries = authoritative(events).filter(
    (e) => e.kind === "opened" || e.kind === "progress"
  );
  const latestByKey = /* @__PURE__ */ new Map();
  for (const e of authoritative(events)) {
    if (e.kind === "pin") continue;
    const key = e.tracker_key;
    if (key === null) continue;
    const prior = latestByKey.get(key);
    if (!prior || e.ts > prior.ts) latestByKey.set(key, e);
  }
  return entries.filter((e) => {
    if (e.tracker_key === null) return true;
    const latest = latestByKey.get(e.tracker_key);
    return latest === void 0 || latest.id === e.id;
  });
}
function sortRecord(record) {
  const out = {};
  for (const k of Object.keys(record).sort()) out[k] = record[k];
  return out;
}

// src/meter/state.ts
import { existsSync as existsSync4, readFileSync as readFileSync4, writeFileSync as writeFileSync2 } from "node:fs";
import { join as join4 } from "node:path";
function statePath(home) {
  return join4(home, "meter_state.json");
}
function loadState(home) {
  const p = statePath(home);
  if (!existsSync4(p)) {
    return { schema_version: 2, rules_version: RULES_VERSION, pricing_version: null, sessions: {} };
  }
  return JSON.parse(readFileSync4(p, "utf8"));
}
function saveState(home, state) {
  writeFileSync2(statePath(home), JSON.stringify(state, null, 2) + "\n", "utf8");
}
function isCurrent(state, sessionId, fileBytes, pricingVersion) {
  if (state.rules_version !== RULES_VERSION) return false;
  if (state.pricing_version !== pricingVersion) return false;
  const cp = state.sessions[sessionId];
  return cp !== void 0 && cp.file_bytes === fileBytes;
}

// src/meter/run.ts
function repoFromCwd(cwd) {
  if (!cwd || !existsSync5(cwd)) return null;
  try {
    const url = execFileSync3("git", ["-C", cwd, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5e3
    }).trim();
    const m = /[:/]([^/:]+\/[^/:]+?)(?:\.git)?$/.exec(url);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}
function defaultProjectsDir() {
  return join5(homedir2(), ".claude", "projects");
}
function listTranscripts(projectsDir) {
  if (!existsSync5(projectsDir)) return [];
  const out = [];
  for (const proj of readdirSync2(projectsDir).sort()) {
    const dir = join5(projectsDir, proj);
    let entries;
    try {
      entries = readdirSync2(dir);
    } catch {
      continue;
    }
    for (const f of entries.sort()) {
      if (f.endsWith(".jsonl")) out.push(join5(dir, f));
    }
  }
  return out;
}
function meterFile(home, transcriptPath, repoHint) {
  const config = loadConfig(home);
  const state = loadState(home);
  const raw = readFileSync5(transcriptPath, "utf8");
  const fileBytes = statSync(transcriptPath).size;
  const probe = parseTranscript(raw, { branchKeyPattern: config.metering.branch_key_pattern });
  const sessionId = probe.sessionId;
  if (sessionId !== null && isCurrent(state, sessionId, fileBytes, config.pricing.version)) {
    return { sessionId, transcriptPath, skipped: true, usage: 0, sessions: 0, exceptions: 0 };
  }
  const repo = repoHint ?? repoFromCwd(probe.cwd);
  const ledgerEvents = readEvents(home, "ledger");
  const existingUsage = readEvents(home, "usage");
  const existingSessions = readEvents(home, "sessions");
  const existingExceptions = readEvents(home, "exceptions");
  const out = meterTranscript({
    transcriptPath,
    raw,
    repo,
    config,
    ledgerEvents,
    existingUsage,
    existingSessions,
    existingExceptions
  });
  appendEvents(home, "usage", out.newUsage);
  appendEvents(home, "sessions", out.newSessions);
  appendEvents(home, "exceptions", out.newExceptions);
  if (out.sessionId !== null) {
    const lastTurn = out.transcript.turns[out.transcript.turns.length - 1];
    state.rules_version = "1";
    state.pricing_version = config.pricing.version;
    state.sessions[out.sessionId] = {
      transcript_path: transcriptPath,
      file_bytes: fileBytes,
      last_message_id: lastTurn?.lastMessageId ?? null,
      transcript_version: out.transcript.version,
      metered_through_ts: out.transcript.lastTs
    };
    saveState(home, state);
  }
  return {
    sessionId: out.sessionId,
    transcriptPath,
    skipped: false,
    usage: out.newUsage.length,
    sessions: out.newSessions.length,
    exceptions: out.newExceptions.length
  };
}

// src/cli/cmd-bootstrap.ts
var LINE = "\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500";
function fmtInt(n) {
  return n.toLocaleString("en-US");
}
function renderReceipt(d) {
  const out = [];
  out.push("WAYBILL \xB7 BOOTSTRAP RECEIPT");
  out.push(LINE);
  out.push(`WINDOW    ${d.since} \u2192 ${d.until} (${d.window_days} days)`);
  out.push(`IDENTITY  ${d.emails.join(", ") || "(no git email configured)"}`);
  out.push("");
  if (d.repos.length === 0) {
    out.push("ITEMS");
    out.push("  No local git repos in scope. The ledger doesn't pad.");
    out.push("  (Run from inside a repo, or add repo paths with --repo-path.)");
  }
  for (const r of d.repos) {
    out.push(`REPO      ${r.repo}`);
    out.push("ITEMS");
    out.push(`  COMMITS         ${fmtInt(r.commits).padStart(8)}`);
    out.push(`  MERGES          ${fmtInt(r.merges).padStart(8)}`);
    out.push(`  ACTIVE DAYS     ${fmtInt(r.active_days).padStart(8)}`);
    if (r.first_date !== null) {
      out.push(`  FIRST \u2192 LAST    ${r.first_date} \u2192 ${r.last_date}`);
    }
    if (r.keys.length > 0) {
      const keys = r.keys.slice(0, 5).map((k) => `${k.key} \xD7${k.count}`).join(" \xB7 ");
      out.push(`  TRACKER KEYS    ${keys}${r.keys.length > 5 ? ` (+${r.keys.length - 5} more)` : ""}`);
    }
    if (r.tags.length > 0) {
      out.push(`  TAGS            ${r.tags.slice(0, 5).join(" \xB7 ")}`);
    }
    out.push("");
  }
  const totalCommits = d.repos.reduce((n, r) => n + r.commits, 0);
  out.push(`SUBTOTAL  ${fmtInt(totalCommits)} commit(s) across ${d.repos.length} repo(s)`);
  if (d.tokens === null) {
    out.push("TOKENS    no metered sessions in the window yet \u2014");
    out.push("          the SessionEnd miner fills this automatically as you work");
  } else {
    const t = d.tokens.totals;
    out.push(`TOKENS    ${d.tokens.metered_sessions} metered session(s)`);
    out.push(`  INPUT           ${fmtInt(t.input).padStart(12)}`);
    out.push(`  OUTPUT          ${fmtInt(t.output).padStart(12)}`);
    out.push(`  CACHE READ      ${fmtInt(t.cache_read).padStart(12)}`);
    out.push(`  CACHE WRITE     ${fmtInt(t.cache_creation).padStart(12)}`);
    for (const a of d.tokens.by_account.slice(0, 5)) {
      out.push(`  ${a.account.padEnd(20)} ${fmtInt(a.tokens).padStart(12)}`);
    }
  }
  out.push(LINE);
  out.push("EVIDENCE TIER: FACTS (LOCAL GIT LOG \xB7 METERED TRANSCRIPTS)");
  out.push("RANGES NOT MIDPOINTS \xB7 NOTHING PADDED \xB7 UNATTRIBUTED SHOWN");
  return out.join("\n");
}
function collectTokens(home, sinceIso) {
  const usage = authoritative(readEvents(home, "usage")).filter(
    (u) => u.kind === "usage" && u.ts >= sinceIso
  );
  if (usage.length === 0) return null;
  const sessions = /* @__PURE__ */ new Set();
  const totals = { input: 0, output: 0, cache_read: 0, cache_creation: 0 };
  const byAccount = /* @__PURE__ */ new Map();
  for (const u of usage) {
    sessions.add(u.session_id);
    totals.input += u.tokens.input;
    totals.output += u.tokens.output;
    totals.cache_read += u.tokens.cache_read;
    totals.cache_creation += u.tokens.cache_creation;
    const spent = u.tokens.input + u.tokens.output + u.tokens.cache_read + u.tokens.cache_creation;
    byAccount.set(u.attribution.account, (byAccount.get(u.attribution.account) ?? 0) + spent);
  }
  const by_account = [...byAccount.entries()].map(([account, tokens]) => ({ account, tokens })).sort((a, b) => b.tokens - a.tokens || (a.account < b.account ? -1 : 1));
  return { metered_sessions: sessions.size, totals, by_account };
}
function runBootstrap(home, args, json) {
  let days = 90;
  let nowIso = null;
  const repoPaths = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--days") days = Number(args[++i] ?? "90");
    else if (a === "--repo-path") {
      const p = args[++i];
      if (p) repoPaths.push(p);
    } else if (a === "--now") nowIso = args[++i] ?? null;
    else {
      process.stderr.write(`waybill bootstrap: unknown option ${a}
`);
      return 2;
    }
  }
  if (!Number.isFinite(days) || days <= 0) {
    process.stderr.write("waybill bootstrap: --days must be a positive number\n");
    return 2;
  }
  const config = loadConfig(home);
  const identity = loadIdentity(home);
  const emails = identity?.git_emails ?? [];
  const now = nowIso ? new Date(nowIso) : /* @__PURE__ */ new Date();
  const since = new Date(now.getTime() - days * 864e5);
  const sinceIso = since.toISOString().slice(0, 19) + "Z";
  if (repoPaths.length === 0 && isGitRepo(process.cwd())) repoPaths.push(process.cwd());
  const repos = [];
  for (const path of repoPaths) {
    if (!isGitRepo(path)) {
      process.stderr.write(`waybill bootstrap: not a git repo, skipping: ${path}
`);
      continue;
    }
    const name = repoFromCwd(path) ?? path;
    const commits = parseGitLog(gitLogRaw(path, sinceIso));
    repos.push(summarizeRepo(name, path, commits, emails, config.metering.branch_key_pattern));
  }
  const data = {
    window_days: days,
    since: sinceIso.slice(0, 10),
    until: now.toISOString().slice(0, 10),
    emails,
    repos,
    tokens: collectTokens(home, sinceIso)
  };
  if (json) {
    process.stdout.write(JSON.stringify(data, null, 2) + "\n");
  } else {
    process.stdout.write(renderReceipt(data) + "\n");
  }
  return 0;
}

// src/cli/cmd-init.ts
import { execFileSync as execFileSync4 } from "node:child_process";
import { existsSync as existsSync6, mkdirSync as mkdirSync2, readFileSync as readFileSync6, writeFileSync as writeFileSync3 } from "node:fs";
import { homedir as homedir3 } from "node:os";
import { join as join6 } from "node:path";
function git(home, args) {
  execFileSync4("git", ["-C", home, ...args], {
    stdio: ["ignore", "ignore", "ignore"],
    timeout: 15e3
  });
}
function tryExec(cmd, args) {
  try {
    return execFileSync4(cmd, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5e3
    }).trim();
  } catch {
    return null;
  }
}
function checkRetention(claudeSettingsPath) {
  let days = null;
  if (existsSync6(claudeSettingsPath)) {
    try {
      const settings = JSON.parse(readFileSync6(claudeSettingsPath, "utf8"));
      if (typeof settings["cleanupPeriodDays"] === "number") days = settings["cleanupPeriodDays"];
    } catch {
    }
  }
  if (days === 0) {
    return {
      cleanup_period_days: 0,
      effective: "transcripts are deleted immediately",
      warning: "cleanupPeriodDays is 0 \u2014 Claude Code deletes transcripts at once, so nothing can be metered. Waybill's session receipts will only cover sessions mined before deletion.",
      recommendation: "set cleanupPeriodDays to 90 or more in ~/.claude/settings.json"
    };
  }
  if (days === null) {
    return {
      cleanup_period_days: null,
      effective: "default retention (30 days)",
      warning: null,
      recommendation: "raise cleanupPeriodDays (e.g. 99999) in ~/.claude/settings.json so historical sessions stay meterable; Waybill's session receipts preserve totals either way"
    };
  }
  return {
    cleanup_period_days: days,
    effective: `${days} day(s)`,
    warning: null,
    recommendation: days < 90 ? "raise cleanupPeriodDays (e.g. 99999) so historical sessions stay meterable" : null
  };
}
function buildIdentity() {
  const emails = /* @__PURE__ */ new Set();
  const names = /* @__PURE__ */ new Set();
  for (const scope of [["--global"], []]) {
    const email = tryExec("git", ["config", ...scope, "--get-all", "user.email"]);
    for (const e of email?.split("\n") ?? []) if (e.trim()) emails.add(e.trim());
    const name = tryExec("git", ["config", ...scope, "--get-all", "user.name"]);
    for (const n of name?.split("\n") ?? []) if (n.trim()) names.add(n.trim());
  }
  const ghLogin = tryExec("gh", ["api", "user", "-q", ".login"]);
  return {
    schema_version: 2,
    git_emails: [...emails].sort(),
    git_names: [...names].sort(),
    github_login: ghLogin,
    jira_account_id: null
  };
}
function runInit(home, args, json) {
  let claudeSettings = join6(homedir3(), ".claude", "settings.json");
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--claude-settings") claudeSettings = args[++i] ?? claudeSettings;
    else {
      process.stderr.write(`waybill init: unknown option ${a}
`);
      return 2;
    }
  }
  mkdirSync2(join6(home, "pending-sessions"), { recursive: true });
  mkdirSync2(join6(home, "rollups"), { recursive: true });
  const freshConfig = !existsSync6(join6(home, "config.json"));
  const config = freshConfig ? defaultConfig() : loadConfig(home);
  const cwdRepo = repoFromCwd(process.cwd());
  if (cwdRepo && !config.git.repos.includes(cwdRepo)) config.git.repos.push(cwdRepo);
  saveConfig(home, config);
  const identity = buildIdentity();
  saveIdentity(home, identity);
  if (!existsSync6(join6(home, ".git"))) {
    git(home, ["init", "-b", "main"]);
  }
  writeFileSync3(join6(home, ".gitignore"), "rollups/\n", "utf8");
  try {
    git(home, ["add", "-A"]);
    git(home, ["commit", "-m", freshConfig ? "ledger: initialized" : "ledger: init refreshed"]);
  } catch {
  }
  const retention = checkRetention(claudeSettings);
  const result = {
    home,
    fresh: freshConfig,
    repos: config.git.repos,
    identity: { git_emails: identity.git_emails, github_login: identity.github_login },
    retention
  };
  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    process.stdout.write(`Initialized ${home} (git repo, append-only streams)
`);
    process.stdout.write(`Identity: ${identity.git_emails.join(", ") || "(no git email found)"}` + (identity.github_login ? ` \xB7 GitHub: ${identity.github_login}` : "") + "\n");
    process.stdout.write(`Repos in scope: ${config.git.repos.join(", ") || "(none yet)"}
`);
    process.stdout.write(`Transcript retention: ${retention.effective}
`);
    if (retention.warning) process.stdout.write(`WARNING: ${retention.warning}
`);
    if (retention.recommendation) process.stdout.write(`Recommend: ${retention.recommendation}
`);
  }
  return 0;
}

// src/cli/cmd-meter.ts
function runMeter(home, args, json) {
  let transcript = null;
  let repo = null;
  let all = false;
  let projectsDir = defaultProjectsDir();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--transcript") transcript = args[++i] ?? null;
    else if (a === "--repo") repo = args[++i] ?? null;
    else if (a === "--all") all = true;
    else if (a === "--projects-dir") projectsDir = args[++i] ?? projectsDir;
    else {
      process.stderr.write(`waybill meter: unknown option ${a}
`);
      return 2;
    }
  }
  if (!all && !transcript) {
    process.stderr.write("waybill meter: pass --transcript <path> or --all\n");
    return 2;
  }
  const results = [];
  const paths = all ? listTranscripts(projectsDir) : [transcript];
  for (const p of paths) {
    try {
      results.push(meterFile(home, p, repo));
    } catch (err) {
      process.stderr.write(`waybill meter: ${p}: ${err.message}
`);
    }
  }
  const metered = results.filter((r) => !r.skipped);
  const usage = metered.reduce((n, r) => n + r.usage, 0);
  const exceptions = metered.reduce((n, r) => n + r.exceptions, 0);
  if (json) {
    process.stdout.write(JSON.stringify({ results }, null, 2) + "\n");
  } else {
    process.stdout.write(
      `metered ${metered.length} session(s) (${results.length - metered.length} already current): +${usage} usage event(s), +${exceptions} exception(s)
`
    );
  }
  return 0;
}

// src/cli/cmd-mine.ts
import { execFileSync as execFileSync5 } from "node:child_process";
import { existsSync as existsSync7, readFileSync as readFileSync7, readdirSync as readdirSync3, rmSync, unlinkSync, writeFileSync as writeFileSync4 } from "node:fs";
import { join as join7 } from "node:path";
function lockPath(home) {
  return join7(home, "pending-sessions", ".miner.lock");
}
function acquireLock(home) {
  const p = lockPath(home);
  if (existsSync7(p)) {
    try {
      const pid = Number(readFileSync7(p, "utf8").trim());
      if (Number.isInteger(pid) && pid > 0) {
        process.kill(pid, 0);
        return false;
      }
    } catch {
    }
  }
  writeFileSync4(p, String(process.pid), "utf8");
  return true;
}
function releaseLock(home) {
  try {
    unlinkSync(lockPath(home));
  } catch {
  }
}
function commitLedger(home) {
  try {
    execFileSync5("git", ["-C", home, "add", "-A"], { stdio: ["ignore", "ignore", "ignore"], timeout: 15e3 });
    execFileSync5("git", ["-C", home, "commit", "-m", "meter: mined pending sessions"], {
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 15e3
    });
  } catch {
  }
}
function recordGap(home, sessionId, reason) {
  const existing = readEvents(home, "exceptions");
  const body = {
    ts: (/* @__PURE__ */ new Date()).toISOString().replace(/\.\d{3}Z$/, "Z"),
    kind: "meter_gap",
    schema_version: SCHEMA_VERSION,
    supersedes: null,
    session_id: sessionId,
    reason
  };
  const already = existing.some(
    (e) => e.kind === "meter_gap" && e.session_id === sessionId
  );
  if (!already) appendEvents(home, "exceptions", [finalizeEvent("exceptions", body)]);
}
function runMine(home, args) {
  let all = false;
  let projectsDir = defaultProjectsDir();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--queue") all = false;
    else if (a === "--all") all = true;
    else if (a === "--projects-dir") projectsDir = args[++i] ?? projectsDir;
    else {
      process.stderr.write(`waybill mine: unknown option ${a}
`);
      return 2;
    }
  }
  const queueDir = join7(home, "pending-sessions");
  if (!existsSync7(queueDir)) return 0;
  if (!acquireLock(home)) return 0;
  let mined = 0;
  try {
    const files = readdirSync3(queueDir).filter((f) => f.endsWith(".json")).sort();
    for (const f of files) {
      const path = join7(queueDir, f);
      let capture;
      try {
        capture = JSON.parse(readFileSync7(path, "utf8"));
      } catch {
        continue;
      }
      if (capture.mined === true || typeof capture.mined === "string") continue;
      const transcript = capture.transcript_path;
      if (typeof transcript !== "string" || !existsSync7(transcript)) {
        if (typeof capture.session_id === "string") {
          recordGap(home, capture.session_id, "transcript_pruned");
        }
        capture.mined = "gap";
        writeFileSync4(path, JSON.stringify(capture) + "\n", "utf8");
        continue;
      }
      try {
        const result = meterFile(home, transcript, typeof capture.repo === "string" ? capture.repo : null);
        capture.mined = true;
        capture["mined_session_id"] = result.sessionId;
        capture["mined_usage_events"] = result.usage;
        writeFileSync4(path, JSON.stringify(capture) + "\n", "utf8");
        mined += 1;
      } catch (err) {
        process.stderr.write(`waybill mine: ${transcript}: ${err.message}
`);
      }
    }
    if (all) {
      for (const t of listTranscripts(projectsDir)) {
        try {
          const r = meterFile(home, t, null);
          if (!r.skipped) mined += 1;
        } catch (err) {
          process.stderr.write(`waybill mine: ${t}: ${err.message}
`);
        }
      }
    }
  } finally {
    releaseLock(home);
  }
  if (mined > 0) commitLedger(home);
  process.stdout.write(`mined ${mined} session(s)
`);
  return 0;
}

// src/cli/main.ts
var USAGE = `waybill \u2014 token accounting for AI-assisted work. Bring receipts.

Usage: waybill <command> [options]

Commands:
  init        Initialize $WAYBILL_HOME: git repo, config, identity map, retention check
  bootstrap   Render a bootstrap receipt from local git history (zero auth)
                [--days 90] [--repo-path <dir>]...
  mine        Process pending session captures (spawned by the SessionEnd hook)
                [--queue | --all]
  meter       Meter transcripts into usage events (deterministic, incremental)
                --transcript <path> [--repo org/name] | --all [--projects-dir <dir>]
  append      Validate, seal, id, and append one event (the skills' write path)
                --stream <name> --event '<json>' [--commit]
  verify      Check ledger integrity: envelopes, ids, escrow, conservation

Options:
  --home <dir>   Override $WAYBILL_HOME
  --json         Machine-readable output where supported

The engine is deterministic and dependency-free: no model calls, no network.
`;
function parseGlobal(argv) {
  const args = [];
  let home = null;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--home") {
      home = argv[++i] ?? null;
      if (home === null) throw new Error("--home requires a value");
    } else if (a === "--json") {
      json = true;
    } else {
      args.push(a);
    }
  }
  return { args, home: home ?? resolveHome(), json };
}
async function main(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }
  const cli = parseGlobal(rest);
  switch (cmd) {
    case "init":
      return runInit(cli.home, cli.args, cli.json);
    case "bootstrap":
      return runBootstrap(cli.home, cli.args, cli.json);
    case "mine":
      return runMine(cli.home, cli.args);
    case "meter":
      return runMeter(cli.home, cli.args, cli.json);
    case "append":
      return runAppend(cli.home, cli.args, cli.json);
    case "verify": {
      const findings = verifyHome(cli.home);
      if (cli.json) {
        process.stdout.write(JSON.stringify({ home: cli.home, findings }, null, 2) + "\n");
      } else {
        process.stdout.write(renderFindings(findings, cli.home) + "\n");
      }
      return findings.length === 0 ? 0 : 1;
    }
    default:
      process.stderr.write(`waybill: unknown command "${cmd}"

${USAGE}`);
      return 2;
  }
}
main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`waybill: ${err.message}
`);
    process.exit(2);
  }
);
export {
  main,
  parseGlobal
};
