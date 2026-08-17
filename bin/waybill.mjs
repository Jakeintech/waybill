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
var STREAM_KINDS = {
  ledger: /* @__PURE__ */ new Set(["opened", "progress", "shipped", "correction", "pin"]),
  usage: /* @__PURE__ */ new Set(["usage", "correction"]),
  sessions: /* @__PURE__ */ new Set(["session", "correction"]),
  exceptions: /* @__PURE__ */ new Set(["ambiguity", "resolution", "meter_discrepancy", "meter_gap"])
};
function finalizeEvent(stream, body) {
  const id = deterministicUlid(body.ts, stream, body);
  return { id, ...body };
}
function serializeEvent(event) {
  return JSON.stringify(event);
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
  const candidates = [entry.tracker_key, entry.title].filter(
    (v) => v !== null
  );
  let expected = "";
  for (const keyOrTitle of candidates) {
    expected = sha256Hex(escrowPayload(keyOrTitle, est.low, est.high, est.logged_at));
    if (expected === entry.escrow.sha256) return { status: "ok" };
  }
  return { status: "mismatch", expected, found: entry.escrow.sha256 };
}

// src/core/streams.ts
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join as join2 } from "node:path";
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
    const t = receipt.totals;
    const any = t.input > 0 || t.output > 0 || t.cache_read > 0 || t.cache_creation > 0;
    if (!observed.has(sessionId) && any) {
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
function isEmptyHome(home) {
  return STREAMS.every((s) => readStream(home, s).length === 0);
}
function renderFindings(findings, home) {
  const lines = [];
  if (findings.length === 0) {
    lines.push(`waybill verify: ${home}`);
    if (isEmptyHome(home)) {
      lines.push("Empty ledger \u2014 no streams to check yet. (Wrong --home? This is not a failure.)");
      return lines.join("\n");
    }
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
  if (typeof body["kind"] !== "string" || !STREAM_KINDS[stream].has(body["kind"])) {
    process.stderr.write(
      `waybill append: kind must be one of ${[...STREAM_KINDS[stream]].join(", ")} for stream "${stream}"
`
    );
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
  const override = ctx.turnOverrides?.get(turn.index);
  if (override !== void 0) {
    return { attribution: attribution(override, "pin", 1), ambiguity: null };
  }
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
      const probe = tokensFromUsage(msg.usage);
      if (probe.input === 0 && probe.output === 0 && probe.cache_read === 0 && probe.cache_creation === 0 && !byMessage.has(msg.id)) {
        continue;
      }
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
    evidence: transcript.evidence,
    ...input.turnOverrides ? { turnOverrides: input.turnOverrides } : {}
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
      if (prior) {
        const asPrior = finalizeEvent("usage", { ...body, supersedes: prior.supersedes });
        if (asPrior.id === prior.id) continue;
      }
      let event = finalizeEvent("usage", body);
      if (prior) {
        event = finalizeEvent("usage", { ...body, supersedes: prior.id });
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
  if (priorReceipt) {
    const asPrior = finalizeEvent("sessions", {
      ...receiptBody,
      supersedes: priorReceipt.supersedes
    });
    if (asPrior.id !== priorReceipt.id) {
      newSessions.push(
        finalizeEvent("sessions", { ...receiptBody, supersedes: priorReceipt.id })
      );
    }
  } else {
    newSessions.push(finalizeEvent("sessions", receiptBody));
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
    return { schema_version: 2, sessions: {} };
  }
  const raw = JSON.parse(readFileSync4(p, "utf8"));
  const sessions = {};
  for (const [id, cp] of Object.entries(raw.sessions ?? {})) {
    const legacy = cp;
    sessions[id] = {
      transcript_path: legacy.transcript_path ?? "",
      file_bytes: legacy.file_bytes ?? -1,
      last_message_id: legacy.last_message_id ?? null,
      transcript_version: legacy.transcript_version ?? null,
      metered_through_ts: legacy.metered_through_ts ?? null,
      rules_version: legacy.rules_version ?? "",
      pricing_version: legacy.pricing_version ?? null,
      attribution_inputs: legacy.attribution_inputs ?? null
    };
  }
  return { schema_version: 2, sessions };
}
function saveState(home, state) {
  writeFileSync2(statePath(home), JSON.stringify(state, null, 2) + "\n", "utf8");
}
function isCurrent(state, sessionId, fileBytes, pricingVersion, attributionInputs) {
  const cp = state.sessions[sessionId];
  if (cp === void 0) return false;
  return cp.file_bytes === fileBytes && cp.rules_version === RULES_VERSION && cp.pricing_version === pricingVersion && cp.attribution_inputs === attributionInputs;
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
function attributionFingerprint(ledgerEvents, exceptionEvents, config) {
  const pins = authoritative(ledgerEvents).filter((e) => e.kind === "pin").map((p) => ({ id: p.id, session: p.session_id, account: p.account, range: p.range })).sort((a, b) => a.id < b.id ? -1 : 1);
  const open = selectOpenEntries(ledgerEvents).map((e) => ({ key: e.tracker_key, repo: e.repo })).sort((a, b) => (a.key ?? "") < (b.key ?? "") ? -1 : 1);
  const resolutions = exceptionEvents.filter((e) => e.kind === "resolution").map((r) => ({ resolves: r.resolves, account: r.account })).sort((a, b) => a.resolves < b.resolves ? -1 : 1);
  return sha256Hex(
    canonicalJson({
      rules: RULES_VERSION,
      pins,
      open,
      defaults: config.metering.repo_defaults,
      pattern: config.metering.branch_key_pattern,
      resolutions
    })
  );
}
function turnOverridesFor(sessionId, exceptionEvents) {
  const ambiguities = /* @__PURE__ */ new Map();
  for (const e of exceptionEvents) {
    if (e.kind === "ambiguity" && e.session_id === sessionId) {
      ambiguities.set(e.id, e);
    }
  }
  const overrides = /* @__PURE__ */ new Map();
  for (const e of exceptionEvents) {
    if (e.kind !== "resolution") continue;
    const r = e;
    const amb = ambiguities.get(r.resolves);
    if (amb) overrides.set(amb.turn.index, r.account);
  }
  return overrides;
}
function probeSessionId(raw) {
  const nl = raw.indexOf("\n");
  const first = nl === -1 ? raw : raw.slice(0, nl);
  try {
    const line = JSON.parse(first);
    return typeof line.sessionId === "string" ? line.sessionId : null;
  } catch {
    return null;
  }
}
function meterFile(home, transcriptPath, repoHint, force = false) {
  const config = loadConfig(home);
  const state = loadState(home);
  const raw = readFileSync5(transcriptPath, "utf8");
  const fileBytes = statSync(transcriptPath).size;
  const ledgerEvents = readEvents(home, "ledger");
  const existingExceptions = readEvents(home, "exceptions");
  const fingerprint = attributionFingerprint(ledgerEvents, existingExceptions, config);
  const probedId = probeSessionId(raw);
  if (!force && probedId !== null && isCurrent(state, probedId, fileBytes, config.pricing.version, fingerprint)) {
    return { session_id: probedId, transcript_path: transcriptPath, skipped: true, usage: 0, sessions: 0, exceptions: 0 };
  }
  const probe = parseTranscript(raw, { branchKeyPattern: config.metering.branch_key_pattern });
  const sessionId = probe.sessionId;
  if (!force && sessionId !== null && sessionId !== probedId && isCurrent(state, sessionId, fileBytes, config.pricing.version, fingerprint)) {
    return { session_id: sessionId, transcript_path: transcriptPath, skipped: true, usage: 0, sessions: 0, exceptions: 0 };
  }
  const repo = repoHint ?? repoFromCwd(probe.cwd);
  const existingUsage = readEvents(home, "usage");
  const existingSessions = readEvents(home, "sessions");
  const out = meterTranscript({
    transcriptPath,
    raw,
    repo,
    config,
    ledgerEvents,
    existingUsage,
    existingSessions,
    existingExceptions,
    turnOverrides: sessionId !== null ? turnOverridesFor(sessionId, existingExceptions) : /* @__PURE__ */ new Map()
  });
  appendEvents(home, "usage", out.newUsage);
  appendEvents(home, "sessions", out.newSessions);
  appendEvents(home, "exceptions", out.newExceptions);
  if (out.sessionId !== null) {
    const lastTurn = out.transcript.turns[out.transcript.turns.length - 1];
    state.sessions[out.sessionId] = {
      transcript_path: transcriptPath,
      file_bytes: fileBytes,
      last_message_id: lastTurn?.lastMessageId ?? null,
      transcript_version: out.transcript.version,
      metered_through_ts: out.transcript.lastTs,
      rules_version: RULES_VERSION,
      pricing_version: config.pricing.version,
      attribution_inputs: fingerprint
    };
    saveState(home, state);
  }
  return {
    session_id: out.sessionId,
    transcript_path: transcriptPath,
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
    out.push(`  COMMITS         ${fmtInt(r.commits).padStart(11)}`);
    out.push(`  MERGES          ${fmtInt(r.merges).padStart(11)}`);
    out.push(`  ACTIVE DAYS     ${fmtInt(r.active_days).padStart(11)}`);
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
    out.push(`  INPUT           ${fmtInt(t.input).padStart(15)}`);
    out.push(`  OUTPUT          ${fmtInt(t.output).padStart(15)}`);
    out.push(`  CACHE READ      ${fmtInt(t.cache_read).padStart(15)}`);
    out.push(`  CACHE WRITE     ${fmtInt(t.cache_creation).padStart(15)}`);
    for (const a of d.tokens.by_account.slice(0, 5)) {
      out.push(`  ${a.account.padEnd(16)}${fmtInt(a.tokens).padStart(15)}`);
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
  let nowIso2 = null;
  const repoPaths = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--days") days = Number(args[++i] ?? "90");
    else if (a === "--repo-path") {
      const p = args[++i];
      if (p) repoPaths.push(p);
    } else if (a === "--now") nowIso2 = args[++i] ?? null;
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
  const now = nowIso2 ? new Date(nowIso2) : /* @__PURE__ */ new Date();
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
    process.stdout.write(
      freshConfig ? `Initialized ${home} (git repo, append-only streams)
` : `Refreshed ${home} (already initialized; config preserved)
`
    );
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

// src/meter/lock.ts
import { mkdirSync as mkdirSync3, readFileSync as readFileSync7, rmSync, unlinkSync, writeFileSync as writeFileSync4 } from "node:fs";
import { join as join7 } from "node:path";
function lockPath(home) {
  return join7(home, "pending-sessions", ".miner.lock");
}
function acquireLock(home) {
  mkdirSync3(join7(home, "pending-sessions"), { recursive: true });
  const p = lockPath(home);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync4(p, String(process.pid), { flag: "wx" });
      return true;
    } catch {
      try {
        const pid = Number(readFileSync7(p, "utf8").trim());
        if (Number.isInteger(pid) && pid > 0) {
          process.kill(pid, 0);
          return false;
        }
      } catch {
      }
      try {
        unlinkSync(p);
      } catch {
      }
    }
  }
  return false;
}
async function acquireLockWait(home, tries = 10, delayMs = 200) {
  for (let i = 0; i < tries; i++) {
    if (acquireLock(home)) return true;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}
function releaseLock(home) {
  try {
    unlinkSync(lockPath(home));
  } catch {
  }
}

// src/cli/cmd-meter.ts
async function runMeter(home, args, json) {
  let transcript = null;
  let repo = null;
  let all = false;
  let force = false;
  let projectsDir = defaultProjectsDir();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--transcript") transcript = args[++i] ?? null;
    else if (a === "--repo") repo = args[++i] ?? null;
    else if (a === "--all") all = true;
    else if (a === "--force") force = true;
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
  if (!await acquireLockWait(home)) {
    process.stderr.write("waybill meter: another metering process is running; try again shortly\n");
    return 1;
  }
  const results = [];
  let failures = 0;
  try {
    const paths = all ? listTranscripts(projectsDir) : [transcript];
    for (const p of paths) {
      try {
        results.push(meterFile(home, p, repo, force));
      } catch (err) {
        failures += 1;
        process.stderr.write(`waybill meter: ${p}: ${err.message}
`);
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
      `metered ${metered.length} session(s) (${results.length - metered.length} already current` + (failures > 0 ? `, ${failures} failed` : "") + `): +${usage} usage event(s), +${exceptions} exception(s)
`
    );
  }
  return failures > 0 ? 1 : 0;
}

// src/cli/cmd-mine.ts
import { execFileSync as execFileSync5 } from "node:child_process";
import { existsSync as existsSync7, mkdirSync as mkdirSync4, readFileSync as readFileSync8, readdirSync as readdirSync3, writeFileSync as writeFileSync5 } from "node:fs";
import { join as join8 } from "node:path";
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
function gapTs(capture) {
  const captured = capture.captured_at;
  if (typeof captured === "string") {
    const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(captured);
    if (m) return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
    if (!Number.isNaN(Date.parse(captured))) return captured;
  }
  return "1970-01-01T00:00:00Z";
}
function recordGap(home, sessionId, ts, reason) {
  const existing = readEvents(home, "exceptions");
  const already = existing.some(
    (e) => e.kind === "meter_gap" && e.session_id === sessionId
  );
  if (already) return;
  const body = {
    ts,
    kind: "meter_gap",
    schema_version: SCHEMA_VERSION,
    supersedes: null,
    session_id: sessionId,
    reason
  };
  appendEvents(home, "exceptions", [finalizeEvent("exceptions", body)]);
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
  const queueDir = join8(home, "pending-sessions");
  mkdirSync4(queueDir, { recursive: true });
  if (!acquireLock(home)) return 0;
  let mined = 0;
  try {
    const files = readdirSync3(queueDir).filter((f) => f.endsWith(".json")).sort();
    for (const f of files) {
      const path = join8(queueDir, f);
      let capture;
      try {
        capture = JSON.parse(readFileSync8(path, "utf8"));
      } catch {
        continue;
      }
      if (capture.mined === true || typeof capture.mined === "string") continue;
      const transcript = capture.transcript_path;
      if (typeof transcript !== "string" || !existsSync7(transcript)) {
        if (typeof capture.session_id === "string") {
          recordGap(home, capture.session_id, gapTs(capture), "transcript_pruned");
        }
        capture.mined = "gap";
        writeFileSync5(path, JSON.stringify(capture) + "\n", "utf8");
        continue;
      }
      try {
        const result = meterFile(home, transcript, typeof capture.repo === "string" ? capture.repo : null);
        capture.mined = true;
        capture["mined_session_id"] = result.session_id;
        capture["mined_usage_events"] = result.usage;
        writeFileSync5(path, JSON.stringify(capture) + "\n", "utf8");
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

// src/cli/cmd-pace.ts
import { existsSync as existsSync8, mkdirSync as mkdirSync5, readFileSync as readFileSync9, writeFileSync as writeFileSync6 } from "node:fs";
import { join as join9 } from "node:path";

// src/projections/queries.ts
function normalizeWindow(from, to) {
  const check = (v, name) => {
    if (v === null) return null;
    if (Number.isNaN(Date.parse(v))) {
      throw new Error(`--${name} is not a date: ${v}`);
    }
    return v;
  };
  const f = check(from, "from");
  let t = check(to, "to");
  if (t !== null && /^\d{4}-\d{2}-\d{2}$/.test(t)) t = `${t}T23:59:59.999Z`;
  return { from: f, to: t };
}
function inWindow(ts, w) {
  if (w.from !== null && ts < w.from) return false;
  if (w.to !== null && ts > w.to) return false;
  return true;
}
function totalTokens(u) {
  return u.tokens.input + u.tokens.output + u.tokens.cache_read + u.tokens.cache_creation;
}
function effectiveShipped(events) {
  const byId = new Map(events.map((e) => [e.id, e]));
  const out = [];
  for (const e of authoritative(events)) {
    if (e.kind !== "shipped" && e.kind !== "correction") continue;
    let cur = e;
    const seen = /* @__PURE__ */ new Set();
    let shippedTs = null;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      if (cur.kind === "shipped") {
        shippedTs = cur.ts;
        break;
      }
      cur = cur.supersedes !== null ? byId.get(cur.supersedes) : void 0;
    }
    if (shippedTs !== null) out.push({ entry: e, shipped_ts: shippedTs });
  }
  return out;
}
function isoWeek(ts) {
  const d = new Date(Date.parse(ts));
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const ftDay = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - ftDay + 3);
  const week = 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 864e5));
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
function spendData(usageEvents, exceptionEvents, ledgerEvents, config, window) {
  const usage = authoritative(usageEvents).filter(
    (u) => u.kind === "usage" && inWindow(u.ts, window) && totalTokens(u) > 0
  );
  const accounts = /* @__PURE__ */ new Map();
  const models = /* @__PURE__ */ new Map();
  const weeks = /* @__PURE__ */ new Map();
  const accountSessions = /* @__PURE__ */ new Map();
  let total = 0;
  for (const u of usage) {
    const t = totalTokens(u);
    total += t;
    const acc = accounts.get(u.attribution.account) ?? {
      account: u.attribution.account,
      tokens: 0,
      input: 0,
      output: 0,
      cache_read: 0,
      cache_creation: 0,
      cost_usd: null,
      min_confidence: 1,
      resolvers: [],
      sessions: 0
    };
    acc.tokens += t;
    acc.input += u.tokens.input;
    acc.output += u.tokens.output;
    acc.cache_read += u.tokens.cache_read;
    acc.cache_creation += u.tokens.cache_creation;
    if (u.cost_usd) acc.cost_usd = Math.round(((acc.cost_usd ?? 0) + u.cost_usd.value) * 1e4) / 1e4;
    if (u.attribution.confidence < acc.min_confidence) acc.min_confidence = u.attribution.confidence;
    if (!acc.resolvers.includes(u.attribution.resolver)) acc.resolvers.push(u.attribution.resolver);
    accounts.set(u.attribution.account, acc);
    const sess = accountSessions.get(u.attribution.account) ?? /* @__PURE__ */ new Set();
    sess.add(u.session_id);
    accountSessions.set(u.attribution.account, sess);
    const m = models.get(u.model) ?? { tokens: 0, cost: 0, priced: false };
    m.tokens += t;
    if (u.cost_usd) {
      m.cost = Math.round((m.cost + u.cost_usd.value) * 1e4) / 1e4;
      m.priced = true;
    }
    models.set(u.model, m);
    weeks.set(isoWeek(u.ts), (weeks.get(isoWeek(u.ts)) ?? 0) + t);
  }
  for (const [account, acc] of accounts) {
    acc.sessions = accountSessions.get(account)?.size ?? 0;
    acc.resolvers.sort();
  }
  const shippedKeys = new Set(
    effectiveShipped(ledgerEvents).map((s) => s.entry.tracker_key).filter((k) => k !== null)
  );
  const openSpend = [...accounts.values()].filter((a) => a.account.startsWith("story:") && !shippedKeys.has(a.account.slice(6))).map((a) => ({ account: a.account, tokens: a.tokens })).sort((a, b) => b.tokens - a.tokens || (a.account < b.account ? -1 : 1));
  const attributed = [...accounts.values()].filter((a) => a.account !== "unattributed" && a.min_confidence >= 0.6).reduce((n, a) => n + a.tokens, 0);
  const openAmbiguities = countOpenAmbiguities(exceptionEvents);
  const unattributed = accounts.get("unattributed")?.tokens ?? 0;
  return {
    window,
    accounts: [...accounts.values()].sort(
      (a, b) => b.tokens - a.tokens || (a.account < b.account ? -1 : 1)
    ),
    by_model: [...models.entries()].map(([model, m]) => ({ model, tokens: m.tokens, cost_usd: m.priced ? m.cost : null })).sort((a, b) => b.tokens - a.tokens || (a.model < b.model ? -1 : 1)),
    by_week: [...weeks.entries()].map(([week, tokens]) => ({ week, tokens })).sort((a, b) => a.week < b.week ? -1 : 1),
    total_tokens: total,
    unattributed_tokens: unattributed,
    unattributed_pct: total > 0 ? Math.round(unattributed / total * 1e3) / 10 : 0,
    open_spend: openSpend,
    attribution_health: {
      attributed_pct_conf_060: total > 0 ? Math.round(attributed / total * 1e3) / 10 : 0,
      inbox_open: openAmbiguities
    },
    pricing_version: config.pricing.version
  };
}
function countOpenAmbiguities(exceptionEvents) {
  const resolved = new Set(
    exceptionEvents.filter((e) => e.kind === "resolution").map((e) => e.resolves)
  );
  return exceptionEvents.filter(
    (e) => e.kind === "ambiguity" && !resolved.has(e.id)
  ).length;
}
function reportData(ledgerEvents, usageEvents, exceptionEvents, config, window) {
  const views = effectiveShipped(ledgerEvents).filter((s) => inWindow(s.shipped_ts, window));
  const spend = spendData(usageEvents, exceptionEvents, ledgerEvents, config, window);
  const tokensByKey = /* @__PURE__ */ new Map();
  for (const a of spend.accounts) {
    if (a.account.startsWith("story:")) tokensByKey.set(a.account.slice(6), a.tokens);
  }
  const shipped = views.map(({ entry: e, shipped_ts }) => ({
    id: e.id,
    tracker_key: e.tracker_key,
    title: e.title,
    epic_key: e.epic_key,
    epic_name: e.epic_name,
    points: e.points,
    prs: e.artifacts.prs,
    deploy: e.artifacts.deploy,
    ts: shipped_ts,
    claude_role: e.claude_role,
    metered_tokens: e.tracker_key !== null ? tokensByKey.get(e.tracker_key) ?? null : null,
    escrowed: e.escrow !== null
  })).sort((a, b) => a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0);
  const entries = views.map((v) => v.entry);
  const points2 = shipped.reduce((n, s) => n + (s.points ?? 0), 0);
  const mergedPrs = shipped.reduce((n, s) => n + s.prs.length, 0);
  const deploys = shipped.filter((s) => s.deploy !== null).length;
  const meteredTokens = shipped.reduce((n, s) => n + (s.metered_tokens ?? 0), 0);
  const saved = { pre: { low: 0, high: 0, n: 0 }, judgment: { low: 0, high: 0, n: 0 } };
  for (const e of entries) {
    const t = e.time_saved_hours;
    if (!t) continue;
    const bucket = t.basis === "judgment" ? saved.judgment : saved.pre;
    bucket.low += t.low;
    bucket.high += t.high;
    bucket.n += 1;
  }
  const allocation = config.allocations[config.allocations.length - 1] ?? null;
  return {
    window,
    shipped,
    totals: { points: points2, merged_prs: mergedPrs, deploys, metered_tokens: meteredTokens },
    efficiency: {
      tokens_per_point: points2 > 0 && meteredTokens > 0 ? Math.round(meteredTokens / points2) : null,
      tokens_per_pr: mergedPrs > 0 && meteredTokens > 0 ? Math.round(meteredTokens / mergedPrs) : null
    },
    time_saved: {
      pre_registered_or_baseline: { low: saved.pre.low, high: saved.pre.high, entries: saved.pre.n },
      judgment: { low: saved.judgment.low, high: saved.judgment.high, entries: saved.judgment.n }
    },
    costs: {
      window_tokens: spend.total_tokens,
      granted_tokens: allocation?.tokens_granted ?? null,
      utilization_pct: allocation && allocation.tokens_granted > 0 ? Math.round(spend.total_tokens / allocation.tokens_granted * 1e3) / 10 : null,
      unattributed_pct: spend.unattributed_pct
    },
    spend_ledger: spend,
    baseline: config.baseline.velocity_points_per_sprint !== null || config.baseline.median_cycle_time_days !== null ? config.baseline : null
  };
}
function forecastData(ledgerEvents, usageEvents, config) {
  const spend = spendData(usageEvents, [], ledgerEvents, config, { from: null, to: null });
  const tokensByKey = /* @__PURE__ */ new Map();
  for (const a of spend.accounts) {
    if (a.account.startsWith("story:")) tokensByKey.set(a.account.slice(6), a.tokens);
  }
  const shipped = effectiveShipped(ledgerEvents).filter(
    (s) => s.entry.points !== null && s.entry.points > 0 && s.entry.tracker_key !== null && tokensByKey.has(s.entry.tracker_key)
  ).sort((a, b) => a.shipped_ts < b.shipped_ts ? -1 : 1).map((s) => s.entry);
  const recent = shipped.slice(-Math.max(5, Math.min(shipped.length, 10)));
  const rates = recent.map((e) => tokensByKey.get(e.tracker_key) / e.points).sort((a, b) => a - b);
  const mid = Math.floor(rates.length / 2);
  const tokensPerPoint = rates.length === 0 ? null : Math.round(rates.length % 2 === 1 ? rates[mid] : (rates[mid - 1] + rates[mid]) / 2);
  let savedLow = 0;
  let savedHigh = 0;
  let savedPoints = 0;
  for (const e of recent) {
    const t = e.time_saved_hours;
    if (t && (t.basis === "pre_registered" || t.basis === "baseline") && e.points) {
      savedLow += t.low;
      savedHigh += t.high;
      savedPoints += e.points;
    }
  }
  const allocation = config.allocations[config.allocations.length - 1] ?? null;
  return {
    tokens_per_point: tokensPerPoint,
    basis_entries: recent.length,
    low_confidence: recent.length < 5,
    window: {
      first_ts: recent[0]?.ts ?? null,
      last_ts: recent[recent.length - 1]?.ts ?? null
    },
    hours_saved_per_point: savedPoints > 0 ? {
      low: Math.round(savedLow / savedPoints * 100) / 100,
      high: Math.round(savedHigh / savedPoints * 100) / 100
    } : null,
    utilization_pct: allocation && allocation.tokens_granted > 0 ? Math.round(spend.total_tokens / allocation.tokens_granted * 1e3) / 10 : null
  };
}

// src/projections/pace.ts
function periodWindow(period, grantedAt) {
  const q = /^(\d{4})-Q([1-4])$/.exec(period);
  if (q) {
    const year = Number(q[1]);
    const startMonth = (Number(q[2]) - 1) * 3;
    const from2 = new Date(Date.UTC(year, startMonth, 1));
    const to = new Date(Date.UTC(year, startMonth + 3, 1) - 1e3);
    return { from: from2.toISOString().slice(0, 19) + "Z", to: to.toISOString().slice(0, 19) + "Z" };
  }
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  if (m) {
    const from2 = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1));
    const to = new Date(Date.UTC(Number(m[1]), Number(m[2]), 1) - 1e3);
    return { from: from2.toISOString().slice(0, 19) + "Z", to: to.toISOString().slice(0, 19) + "Z" };
  }
  const from = Date.parse(grantedAt);
  return {
    from: new Date(from).toISOString().slice(0, 19) + "Z",
    to: new Date(from + 90 * 864e5).toISOString().slice(0, 19) + "Z"
  };
}
var THRESHOLDS = [80, 100];
function paceData(ledgerEvents, usageEvents, exceptionEvents, config, nowIso2) {
  const allocation = config.allocations[config.allocations.length - 1] ?? null;
  if (!allocation) {
    return {
      allocation: null,
      window: null,
      spent_tokens: 0,
      spent_pct: null,
      elapsed_pct: null,
      committed_points: null,
      shipped_points: null,
      shipped_pct_of_committed: null,
      epics: [],
      thresholds_crossed: [],
      biggest_open_spend: null
    };
  }
  const window = periodWindow(allocation.period, allocation.granted_at);
  const spend = spendData(usageEvents, exceptionEvents, ledgerEvents, config, window);
  const spentPct = allocation.tokens_granted > 0 ? Math.round(spend.total_tokens / allocation.tokens_granted * 1e3) / 10 : null;
  const total = Date.parse(window.to) - Date.parse(window.from);
  const elapsed = Math.min(Math.max(Date.parse(nowIso2) - Date.parse(window.from), 0), total);
  const elapsedPct = total > 0 ? Math.round(elapsed / total * 1e3) / 10 : null;
  const auth = authoritative(ledgerEvents).filter(
    (e) => e.kind !== "pin"
  );
  const inWindowEntries = auth.filter(
    (e) => e.points !== null && e.ts >= window.from && e.ts <= window.to
  );
  const committed = inWindowEntries.reduce((n, e) => n + (e.points ?? 0), 0);
  const shippedViews = effectiveShipped(ledgerEvents).filter(
    (s) => s.shipped_ts >= window.from && s.shipped_ts <= window.to
  );
  const shippedPts = shippedViews.reduce((n, s) => n + (s.entry.points ?? 0), 0);
  const epicByKey = /* @__PURE__ */ new Map();
  for (const e of auth) {
    if (e.tracker_key !== null && e.epic_key !== null) epicByKey.set(e.tracker_key, e.epic_key);
  }
  const spentByEpic = /* @__PURE__ */ new Map();
  for (const a of spend.accounts) {
    if (!a.account.startsWith("story:")) continue;
    const epic = epicByKey.get(a.account.slice(6));
    if (epic) spentByEpic.set(epic, (spentByEpic.get(epic) ?? 0) + a.tokens);
  }
  const epics = Object.entries(config.budgets.epics).map(([epic_key, budget_tokens]) => {
    const spent = spentByEpic.get(epic_key) ?? 0;
    return {
      epic_key,
      budget_tokens,
      spent_tokens: spent,
      spent_pct: budget_tokens > 0 ? Math.round(spent / budget_tokens * 1e3) / 10 : 0
    };
  }).sort((a, b) => b.spent_pct - a.spent_pct);
  return {
    allocation,
    window,
    spent_tokens: spend.total_tokens,
    spent_pct: spentPct,
    elapsed_pct: elapsedPct,
    committed_points: committed > 0 ? committed : null,
    shipped_points: committed > 0 ? shippedPts : null,
    shipped_pct_of_committed: committed > 0 ? Math.round(shippedPts / committed * 1e3) / 10 : null,
    epics,
    thresholds_crossed: THRESHOLDS.filter((t) => spentPct !== null && spentPct >= t),
    biggest_open_spend: spend.open_spend[0] ?? null
  };
}
function renderPace(p) {
  if (!p.allocation || !p.window) {
    return "No allocation configured \u2014 add one to config.json allocations to track pacing.";
  }
  const lines = [];
  const granted = p.allocation.tokens_granted.toLocaleString("en-US");
  const spent = p.spent_tokens.toLocaleString("en-US");
  lines.push(
    `${p.allocation.period}: ${spent} of ${granted} tokens spent` + (p.spent_pct !== null ? ` (${p.spent_pct}%)` : "") + (p.elapsed_pct !== null ? `, ${p.elapsed_pct}% of the period elapsed` : "")
  );
  if (p.shipped_pct_of_committed !== null) {
    lines.push(
      `Work-weighted: ${p.shipped_points} of ${p.committed_points} committed points shipped (${p.shipped_pct_of_committed}%).` + (p.spent_pct !== null && p.spent_pct > p.shipped_pct_of_committed ? " Worth a look, not an alarm." : "")
    );
  }
  for (const e of p.epics) {
    lines.push(
      `Epic ${e.epic_key}: ${e.spent_tokens.toLocaleString("en-US")} of ${e.budget_tokens.toLocaleString("en-US")} envelope (${e.spent_pct}%)`
    );
  }
  if (p.biggest_open_spend) {
    lines.push(
      `Biggest open spend: ${p.biggest_open_spend.account} at ${p.biggest_open_spend.tokens.toLocaleString("en-US")} tokens (not yet shipped)`
    );
  }
  return lines.join("\n");
}

// src/cli/cmd-pace.ts
function stateFile(home) {
  return join9(home, "rollups", "pace-state.json");
}
function loadPaceState(home) {
  const p = stateFile(home);
  if (!existsSync8(p)) return null;
  try {
    return JSON.parse(readFileSync9(p, "utf8"));
  } catch {
    return null;
  }
}
function runPace(home, args, json) {
  let notice = false;
  let nowIso2 = (/* @__PURE__ */ new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--notice") notice = true;
    else if (a === "--now") nowIso2 = args[++i] ?? nowIso2;
    else {
      process.stderr.write(`waybill pace: unknown option ${a}
`);
      return 2;
    }
  }
  const config = loadConfig(home);
  const ledger = readEvents(home, "ledger");
  const usage = readEvents(home, "usage");
  const exceptions = readEvents(home, "exceptions");
  const pace = paceData(ledger, usage, exceptions, config, nowIso2);
  if (notice) {
    if (!pace.allocation) return 0;
    const prior = loadPaceState(home);
    const already = prior && prior.period === pace.allocation.period ? prior.notified_thresholds : [];
    const fresh = pace.thresholds_crossed.filter((t) => !already.includes(t));
    if (fresh.length === 0) return 0;
    const top = Math.max(...fresh);
    const line = `waybill: ${top}% of the ${pace.allocation.period} token grant is spent` + (pace.shipped_pct_of_committed !== null ? ` with ${pace.shipped_pct_of_committed}% of committed points shipped` : "") + (pace.biggest_open_spend ? `; biggest open spend: ${pace.biggest_open_spend.account}` : "") + ". Worth a look, not an alarm.";
    process.stdout.write(line + "\n");
    mkdirSync5(join9(home, "rollups"), { recursive: true });
    writeFileSync6(
      stateFile(home),
      JSON.stringify({
        period: pace.allocation.period,
        notified_thresholds: [.../* @__PURE__ */ new Set([...already, ...fresh])].sort((a, b) => a - b)
      }) + "\n",
      "utf8"
    );
    return 0;
  }
  if (json) {
    process.stdout.write(JSON.stringify({ data: pace }, null, 2) + "\n");
  } else {
    process.stdout.write(renderPace(pace) + "\n");
  }
  return 0;
}

// src/report/redaction.ts
var SESSION_KEYS = /* @__PURE__ */ new Set(["session_id", "transcript_path", "cwd", "sessions"]);
var EXTERNAL_DROP = /* @__PURE__ */ new Set(["title", "prs", "url", "urls", "deploy", "notes"]);
function collectStrings(value, field, into) {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, field, into);
    return;
  }
  for (const [k, v] of Object.entries(value)) {
    if (k === field && typeof v === "string") into.add(v);
    else collectStrings(v, field, into);
  }
}
function redact(data, audience) {
  if (audience === "self") return { data, mapping: {} };
  const clone = JSON.parse(JSON.stringify(data));
  stripKeys(clone, SESSION_KEYS);
  if (audience === "internal") return { data: clone, mapping: {} };
  const keys = /* @__PURE__ */ new Set();
  collectStrings(clone, "tracker_key", keys);
  collectStrings(clone, "key", keys);
  collectAccountKeys(clone, keys);
  const epicKeys = /* @__PURE__ */ new Set();
  collectStrings(clone, "epic_key", epicKeys);
  const epicNames = /* @__PURE__ */ new Set();
  collectStrings(clone, "epic_name", epicNames);
  const repos = /* @__PURE__ */ new Set();
  collectStrings(clone, "repo", repos);
  const adhocs = /* @__PURE__ */ new Set();
  collectAdhocLabels(clone, adhocs);
  const mapping = {};
  let n = 0;
  for (const k of [...keys].sort()) mapping[k] = `STORY-${++n}`;
  n = 0;
  for (const k of [...epicKeys].sort()) mapping[k] = `EPIC-${++n}`;
  n = 0;
  for (const k of [...epicNames].sort()) mapping[k] = `Epic ${++n}`;
  n = 0;
  for (const k of [...repos].sort()) mapping[k] = `repo-${++n}`;
  n = 0;
  for (const k of [...adhocs].sort()) mapping[`adhoc:${k}`] = `adhoc-${++n}`;
  const redacted = rewrite(clone, mapping);
  return { data: redacted, mapping };
}
function collectAdhocLabels(value, into) {
  if (typeof value === "string") {
    if (value.startsWith("adhoc:")) into.add(value.slice(6));
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectAdhocLabels(v, into);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const v of Object.values(value)) collectAdhocLabels(v, into);
  }
}
function collectAccountKeys(value, into) {
  if (typeof value === "string") {
    if (value.startsWith("story:")) into.add(value.slice(6));
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectAccountKeys(v, into);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const v of Object.values(value)) collectAccountKeys(v, into);
  }
}
function stripKeys(value, drop) {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const v of value) stripKeys(v, drop);
    return;
  }
  const obj = value;
  for (const k of Object.keys(obj)) {
    if (drop.has(k) && typeof obj[k] !== "number") delete obj[k];
    else stripKeys(obj[k], drop);
  }
}
function rewrite(value, mapping) {
  if (typeof value === "string") {
    if (value.startsWith("story:")) {
      const key = value.slice(6);
      return `story:${mapping[key] ?? key}`;
    }
    if (value.startsWith("adhoc:")) {
      return `adhoc:${mapping[value] ?? "redacted"}`;
    }
    return mapping[value] ?? value;
  }
  if (Array.isArray(value)) return value.map((v) => rewrite(v, mapping));
  if (value !== null && typeof value === "object") {
    const obj = value;
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (EXTERNAL_DROP.has(k)) continue;
      out[k] = rewrite(v, mapping);
    }
    return out;
  }
  return value;
}

// src/cli/cmd-query.ts
var AUDIENCES = ["self", "internal", "external"];
function runQuery(home, args) {
  const [what, ...rest] = args;
  let from = null;
  let to = null;
  let audience = null;
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--from") from = rest[++i] ?? null;
    else if (a === "--to") to = rest[++i] ?? null;
    else if (a === "--audience") {
      const v = rest[++i];
      if (!v || !AUDIENCES.includes(v)) {
        process.stderr.write(`waybill query: --audience must be one of ${AUDIENCES.join(", ")}
`);
        return 2;
      }
      audience = v;
    } else positional.push(a);
  }
  const config = loadConfig(home);
  const aud = audience ?? config.audience_default;
  let window;
  try {
    window = normalizeWindow(from, to);
  } catch (err) {
    process.stderr.write(`waybill query: ${err.message}
`);
    return 2;
  }
  const ledger = readEvents(home, "ledger");
  const usage = readEvents(home, "usage");
  const exceptions = readEvents(home, "exceptions");
  let payload;
  switch (what) {
    case "spend":
      payload = spendData(usage, exceptions, ledger, config, window);
      break;
    case "report":
      payload = reportData(ledger, usage, exceptions, config, window);
      break;
    case "forecast":
      payload = forecastData(ledger, usage, config);
      break;
    case "story": {
      const key = positional[0];
      if (!key) {
        process.stderr.write("waybill query story: pass the tracker key\n");
        return 2;
      }
      const spend = spendData(usage, exceptions, ledger, config, window);
      const account = spend.accounts.find((a) => a.account === `story:${key}`) ?? null;
      const view = effectiveShipped(ledger).filter((s) => s.entry.tracker_key === key).sort((a, b) => a.shipped_ts < b.shipped_ts ? -1 : 1).pop() ?? null;
      payload = {
        key,
        spend: account,
        cache_read_share: account && account.tokens > 0 ? Math.round(account.cache_read / account.tokens * 1e3) / 10 : null,
        shipped: view ? {
          id: view.entry.id,
          ts: view.shipped_ts,
          points: view.entry.points,
          prs: view.entry.artifacts.prs
        } : null,
        tokens_per_point: account && view && view.entry.points ? Math.round(account.tokens / view.entry.points) : null
      };
      break;
    }
    case "inbox": {
      const resolved = new Set(
        exceptions.filter((e) => e.kind === "resolution").map((e) => e.resolves)
      );
      payload = exceptions.filter((e) => e.kind === "ambiguity" && !resolved.has(e.id));
      break;
    }
    default:
      process.stderr.write(
        "waybill query: pass one of spend | report | forecast | story <KEY> | inbox\n"
      );
      return 2;
  }
  const { data, mapping } = redact(payload, aud);
  const out = aud === "external" ? { audience: aud, data, redaction_note: "identifiers pseudonymized; internal version available on request", mapping_size: Object.keys(mapping).length } : { audience: aud, data };
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  return 0;
}

// src/cli/cmd-resolve.ts
import { execFileSync as execFileSync6 } from "node:child_process";
import { existsSync as existsSync9 } from "node:fs";
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
}
function commitLedger2(home, message) {
  try {
    execFileSync6("git", ["-C", home, "add", "-A"], { stdio: ["ignore", "ignore", "ignore"], timeout: 15e3 });
    execFileSync6("git", ["-C", home, "commit", "-m", message], {
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 15e3
    });
  } catch {
  }
}
function runResolve(home, args, json) {
  let ambiguityId = null;
  let account = null;
  let durablePin = false;
  let repoDefault = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--ambiguity") ambiguityId = args[++i] ?? null;
    else if (a === "--account") account = args[++i] ?? null;
    else if (a === "--pin") durablePin = true;
    else if (a === "--repo-default") repoDefault = args[++i] ?? null;
    else {
      process.stderr.write(`waybill resolve: unknown option ${a}
`);
      return 2;
    }
  }
  if (!ambiguityId || !account) {
    process.stderr.write(
      "waybill resolve: pass --ambiguity <id> and --account <story:KEY | adhoc:label | unattributed>\n  optional: --pin (durable session pin) or --repo-default <org/name>\n"
    );
    return 2;
  }
  if (!/^(story:.+|adhoc:.+|unattributed)$/.test(account)) {
    process.stderr.write("waybill resolve: account must be story:<KEY>, adhoc:<label>, or unattributed\n");
    return 2;
  }
  const exceptions = readEvents(home, "exceptions");
  const ambiguity = exceptions.find(
    (e) => e.kind === "ambiguity" && e.id === ambiguityId
  );
  if (!ambiguity) {
    process.stderr.write(`waybill resolve: no ambiguity with id ${ambiguityId}
`);
    return 1;
  }
  const alreadyResolved = exceptions.some(
    (e) => e.kind === "resolution" && e.resolves === ambiguityId
  );
  if (alreadyResolved) {
    process.stderr.write(`waybill resolve: ${ambiguityId} is already resolved
`);
    return 1;
  }
  const ts = nowIso();
  const durable = durablePin ? { type: "pin" } : repoDefault ? { type: "repo_default", repo: repoDefault } : null;
  const resolution = finalizeEvent("exceptions", {
    ts,
    kind: "resolution",
    schema_version: SCHEMA_VERSION,
    supersedes: null,
    resolves: ambiguityId,
    account,
    durable
  });
  appendEvents(home, "exceptions", [resolution]);
  if (durablePin) {
    const pin = finalizeEvent("ledger", {
      ts,
      kind: "pin",
      schema_version: SCHEMA_VERSION,
      supersedes: null,
      session_id: ambiguity.session_id,
      account,
      tracker_key: account.startsWith("story:") ? account.slice(6) : null,
      range: null,
      notes: `resolve: from inbox item ${ambiguityId}`
    });
    appendEvents(home, "ledger", [pin]);
  }
  if (repoDefault) {
    const config = loadConfig(home);
    config.metering.repo_defaults[repoDefault] = account;
    saveConfig(home, config);
  }
  let remetered = false;
  let corrected = 0;
  const checkpoint = loadState(home).sessions[ambiguity.session_id];
  const transcriptPath = checkpoint?.transcript_path ?? authoritative(readEvents(home, "sessions")).find((s) => s.kind === "session" && s.session_id === ambiguity.session_id)?.transcript_path ?? null;
  if (transcriptPath && existsSync9(transcriptPath)) {
    if (acquireLock(home)) {
      try {
        const result = meterFile(home, transcriptPath, null, true);
        remetered = true;
        corrected = result.usage;
      } finally {
        releaseLock(home);
      }
    } else {
      process.stderr.write(
        "waybill resolve: a miner is running \u2014 the resolution is recorded and will apply on its next pass\n"
      );
    }
  } else {
    process.stderr.write(
      "waybill resolve: transcript no longer on disk \u2014 the resolution is recorded, but existing usage events keep their original attribution (visible in their resolver field)\n"
    );
  }
  commitLedger2(home, `resolve: inbox item filed to ${account}`);
  const inboxOpen = countOpenAmbiguities(readEvents(home, "exceptions"));
  if (json) {
    process.stdout.write(
      JSON.stringify({ resolved: ambiguityId, account, durable, remetered, corrected_events: corrected, inbox_open: inboxOpen }) + "\n"
    );
  } else {
    const durableNote = durablePin ? " (pinned)" : repoDefault ? ` (repo default for ${repoDefault})` : "";
    process.stdout.write(
      `filed to ${account}${durableNote}` + (remetered ? `; ${corrected} usage event(s) corrected` : "") + `; ${inboxOpen} left in the inbox
`
    );
  }
  return 0;
}

// src/cli/cmd-sync-plan.ts
import { execFileSync as execFileSync7 } from "node:child_process";
import { readFileSync as readFileSync10 } from "node:fs";

// src/adapters/contract.ts
function defaultContext(partial = {}) {
  return {
    keyPattern: "[A-Z][A-Z0-9]+-[0-9]+",
    identityEmails: [],
    githubLogin: null,
    jiraAccountId: null,
    pointsFields: ["customfield_10016", "customfield_10026", "customfield_10002"],
    sprintFields: ["customfield_10020", "customfield_10010"],
    ...partial
  };
}
function extractKeys(text, keyPattern) {
  const out = [];
  for (const k of text.match(new RegExp(keyPattern, "g")) ?? []) {
    if (!out.includes(k)) out.push(k);
  }
  return out;
}
function sortItems(items) {
  return [...items].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}
function sortChanges(changes) {
  return [...changes].sort(
    (a, b) => (a.merged_at < b.merged_at ? -1 : a.merged_at > b.merged_at ? 1 : 0) || ((a.url ?? "") < (b.url ?? "") ? -1 : 1)
  );
}

// src/adapters/jira.ts
function str(v) {
  return typeof v === "string" && v !== "" ? v : null;
}
function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function mapWorkType(issueType) {
  switch ((issueType ?? "").toLowerCase()) {
    case "bug":
      return "bug";
    case "story":
    case "task":
    case "sub-task":
    case "subtask":
      return "feature";
    case "incident":
      return "incident";
    case "spike":
    case "research":
      return "research";
    default:
      return "other";
  }
}
function sprintName(fields, ctx) {
  for (const field of ctx.sprintFields) {
    const v = fields[field];
    if (Array.isArray(v) && v.length > 0) {
      const last = v[v.length - 1];
      if (typeof last === "string") {
        const m = /name=([^,]+)/.exec(last);
        if (m) return m[1];
        return last;
      }
      const name = str(last?.["name"]);
      if (name) return name;
    }
  }
  return null;
}
function points(fields, ctx) {
  for (const field of ctx.pointsFields) {
    const v = num(fields[field]);
    if (v !== null) return v;
  }
  return null;
}
var jiraAdapter = {
  kind: "jira",
  normalizeItems(raw, ctx) {
    const issues = Array.isArray(raw) ? raw : raw?.issues ?? [];
    const out = [];
    const keyRe = new RegExp(`^(?:${ctx.keyPattern})$`);
    for (const issue of issues) {
      const key = str(issue.key);
      if (!key || !keyRe.test(key)) continue;
      const fields = issue.fields ?? {};
      const assignee = str(
        fields["assignee"]?.["accountId"]
      );
      if (ctx.jiraAccountId && assignee && assignee !== ctx.jiraAccountId) continue;
      const status = fields["status"];
      const statusName = str(status?.["name"]) ?? "unknown";
      const category = status?.["statusCategory"]?.["key"];
      const resolvedAt = str(fields["resolutiondate"]);
      const done = category === "done" || resolvedAt !== null;
      const issueType = str(fields["issuetype"]?.["name"]);
      const parent = fields["parent"];
      const parentType = str(
        parent?.fields?.["issuetype"]?.["name"]
      );
      const parentIsEpic = (parentType ?? "").toLowerCase() === "epic";
      const epicKey = parentIsEpic ? str(parent?.key) : str(fields["customfield_10014"]);
      const epicName = parentIsEpic ? str((parent?.fields ?? {})["summary"]) : str(fields["customfield_10011"]);
      const base = str(issue.self)?.replace(/\/rest\/api\/.*$/, "");
      out.push({
        key,
        title: str(fields["summary"]) ?? key,
        points: points(fields, ctx),
        epic_key: epicKey,
        epic_name: epicName,
        sprint: sprintName(fields, ctx),
        status: statusName,
        done,
        resolved_at: resolvedAt,
        created_at: str(fields["created"]),
        updated_at: str(fields["updated"]),
        work_type: mapWorkType(issueType),
        url: base ? `${base}/browse/${key}` : null
      });
    }
    return sortItems(out);
  }
};

// src/adapters/github.ts
function str2(v) {
  return typeof v === "string" && v !== "" ? v : null;
}
function repoOf(pr) {
  const full = str2(pr.base?.repo?.full_name) ?? str2(pr.repository?.full_name);
  if (full) return full;
  const repoUrl = str2(pr.repository_url);
  if (repoUrl) {
    const m = /repos\/([^/]+\/[^/]+)$/.exec(repoUrl);
    if (m) return m[1];
  }
  const html = str2(pr.html_url);
  if (html) {
    const m = /github\.com\/([^/]+\/[^/]+)\/pull\//.exec(html);
    if (m) return m[1];
  }
  return null;
}
var githubAdapter = {
  kind: "github",
  normalizeChanges(raw, ctx) {
    const items = Array.isArray(raw) ? raw : raw?.items ?? [];
    const out = [];
    for (const pr of items) {
      const mergedAt = str2(pr.merged_at) ?? str2(pr.pull_request?.merged_at);
      const url = str2(pr.html_url);
      const repo = repoOf(pr);
      if (!mergedAt || !url || !repo) continue;
      const author = str2(pr.user?.login);
      if (ctx.githubLogin && author && author !== ctx.githubLogin) continue;
      const title = str2(pr.title) ?? url;
      const branch = str2(pr.head?.ref);
      out.push({
        url,
        title,
        repo,
        branch,
        merged_at: mergedAt,
        keys: extractKeys(`${title} ${branch ?? ""}`, ctx.keyPattern)
      });
    }
    return sortChanges(out);
  }
};

// src/adapters/gitlocal-adapter.ts
var gitLocalAdapter = {
  kind: "local",
  normalizeChanges(raw, ctx) {
    const { repo, log } = raw;
    if (typeof repo !== "string" || typeof log !== "string") return [];
    const emails = new Set(ctx.identityEmails.map((e) => e.toLowerCase()));
    const out = [];
    for (const c of parseGitLog(log)) {
      if (c.parents <= 1) continue;
      if (emails.size > 0 && !emails.has(c.author_email.toLowerCase())) continue;
      out.push({
        url: null,
        // local history has no web URL; the sha is the receipt
        title: `${c.subject} (${c.sha.slice(0, 10)})`,
        repo,
        branch: null,
        merged_at: c.author_date,
        keys: extractKeys(c.subject, ctx.keyPattern)
      });
    }
    return sortChanges(out);
  }
};

// src/sync/reconcile.ts
function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const m = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return Math.round(m * 10) / 10;
}
function deriveBaseline(items, windowLabel) {
  const done = items.filter((i) => i.done);
  const bySprint = /* @__PURE__ */ new Map();
  for (const i of done) {
    if (i.sprint !== null && i.points !== null) {
      bySprint.set(i.sprint, (bySprint.get(i.sprint) ?? 0) + i.points);
    }
  }
  const cycles = [];
  for (const i of done) {
    if (i.created_at !== null && i.resolved_at !== null) {
      const days = (Date.parse(i.resolved_at) - Date.parse(i.created_at)) / 864e5;
      if (days >= 0) cycles.push(days);
    }
  }
  return {
    velocity_points_per_sprint: median([...bySprint.values()]),
    median_cycle_time_days: median(cycles),
    window: windowLabel,
    derived_from: `tracker history: ${done.length} resolved item(s), ${bySprint.size} sprint(s)`
  };
}
function shippedBody(entry, item, changes, now) {
  const prUrls = changes.map((c) => c.url).filter((u) => u !== null).sort();
  const commitShas = changes.filter((c) => c.url === null).map((c) => /\(([0-9a-f]{7,40})\)$/.exec(c.title)?.[1]).filter((s) => s !== void 0).sort();
  const tsCandidates = [item.resolved_at ?? "", ...changes.map((c) => c.merged_at)].filter((t) => t !== "");
  const ts = tsCandidates.length > 0 ? tsCandidates.sort()[tsCandidates.length - 1] : now;
  return {
    ts,
    kind: "shipped",
    schema_version: 2,
    supersedes: entry.id,
    title: entry.title,
    tracker_key: item.key,
    epic_key: item.epic_key ?? entry.epic_key,
    epic_name: item.epic_name ?? entry.epic_name,
    sprint: item.sprint ?? entry.sprint,
    repo: changes[0]?.repo ?? entry.repo,
    work_type: entry.work_type,
    points: item.points ?? entry.points,
    artifacts: { prs: prUrls, commits: commitShas, deploy: null, docs: [] },
    estimate_without_claude_hours: entry.estimate_without_claude_hours,
    escrow: entry.escrow,
    actual_hours: entry.actual_hours,
    claude_role: entry.claude_role,
    sessions: entry.sessions,
    tokens: entry.tokens,
    budget_tokens: entry.budget_tokens,
    time_saved_hours: entry.time_saved_hours,
    notes: entry.notes
  };
}
function orphanBody(item, changes, now) {
  const base = shippedBody(
    {
      id: "",
      ts: now,
      kind: "opened",
      schema_version: 2,
      supersedes: null,
      title: item.title,
      tracker_key: item.key,
      epic_key: null,
      epic_name: null,
      sprint: null,
      repo: null,
      work_type: item.work_type,
      points: null,
      artifacts: { prs: [], commits: [], deploy: null, docs: [] },
      estimate_without_claude_hours: null,
      escrow: null,
      actual_hours: null,
      claude_role: "none",
      sessions: [],
      tokens: null,
      budget_tokens: null,
      time_saved_hours: null,
      notes: null
    },
    item,
    changes,
    now
  );
  base.supersedes = null;
  base.notes = "imported from tracker/git history; Claude involvement unrecorded";
  return base;
}
function reconcile(items, changes, ledgerEvents, now, options = {}) {
  const auth = authoritative(ledgerEvents).filter(
    (e) => e.kind !== "pin"
  );
  const latestByKey = /* @__PURE__ */ new Map();
  for (const e of auth) {
    if (e.tracker_key === null) continue;
    const prior = latestByKey.get(e.tracker_key);
    if (!prior || e.ts > prior.ts) latestByKey.set(e.tracker_key, e);
  }
  const changesByKey = /* @__PURE__ */ new Map();
  const unmatched = [];
  for (const c of changes) {
    if (c.keys.length === 0) {
      unmatched.push(c);
      continue;
    }
    for (const k of c.keys) {
      changesByKey.set(k, [...changesByKey.get(k) ?? [], c]);
    }
  }
  const shipped = [];
  const corrections = [];
  const orphans = [];
  for (const item of items) {
    const entry = latestByKey.get(item.key);
    const itemChanges = changesByKey.get(item.key) ?? [];
    if (!entry) {
      if (item.done) orphans.push(orphanBody(item, itemChanges, now));
      continue;
    }
    if ((entry.kind === "opened" || entry.kind === "progress") && item.done) {
      shipped.push(shippedBody(entry, item, itemChanges, now));
      continue;
    }
    if (entry.kind === "shipped" || entry.kind === "correction") {
      const drift = [];
      if (item.points !== null && entry.points !== item.points) {
        drift.push(`points ${entry.points ?? "null"} \u2192 ${item.points}`);
      }
      if (item.epic_key !== null && entry.epic_key !== item.epic_key) {
        drift.push(`epic ${entry.epic_key ?? "null"} \u2192 ${item.epic_key}`);
      }
      if (item.sprint !== null && entry.sprint !== item.sprint) {
        drift.push(`sprint ${entry.sprint ?? "null"} \u2192 ${item.sprint}`);
      }
      if (drift.length > 0) {
        const body = {
          ...(({ id: _id, ...rest }) => rest)(entry),
          ts: now,
          kind: "correction",
          supersedes: entry.id,
          points: item.points ?? entry.points,
          epic_key: item.epic_key ?? entry.epic_key,
          epic_name: item.epic_name ?? entry.epic_name,
          sprint: item.sprint ?? entry.sprint,
          notes: `sync: ${drift.join("; ")}`
        };
        corrections.push({ body, drift });
      }
    }
  }
  for (const [key, cs] of [...changesByKey.entries()].sort()) {
    if (!items.some((i) => i.key === key) && !latestByKey.has(key)) {
      for (const c of cs) if (!unmatched.includes(c)) unmatched.push(c);
    }
  }
  return {
    generated_at: now,
    shipped,
    corrections,
    orphans,
    unmatched_changes: unmatched,
    baseline: options.baselineWindow ? deriveBaseline(items, options.baselineWindow) : null,
    summary: {
      open_entries: auth.filter((e) => e.kind === "opened" || e.kind === "progress").length,
      done_items: items.filter((i) => i.done).length,
      merged_changes: changes.length
    }
  };
}

// src/cli/cmd-sync-plan.ts
var TRACKERS = { jira: jiraAdapter };
var GIT_HOSTS = { github: githubAdapter, local: gitLocalAdapter };
function runSyncPlan(home, args) {
  let tracker = null;
  let gitHost = null;
  let itemsPath = null;
  let changesPath = null;
  let applyPath = null;
  let baseline = false;
  let since = null;
  const localRepos = [];
  let now = (/* @__PURE__ */ new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--tracker") tracker = args[++i] ?? null;
    else if (a === "--git") gitHost = args[++i] ?? null;
    else if (a === "--items") itemsPath = args[++i] ?? null;
    else if (a === "--changes") changesPath = args[++i] ?? null;
    else if (a === "--local-repo") {
      const p = args[++i];
      if (p) localRepos.push(p);
    } else if (a === "--since") since = args[++i] ?? null;
    else if (a === "--apply") applyPath = args[++i] ?? null;
    else if (a === "--baseline") baseline = true;
    else if (a === "--now") now = args[++i] ?? now;
    else {
      process.stderr.write(`waybill sync-plan: unknown option ${a}
`);
      return 2;
    }
  }
  const config = loadConfig(home);
  if (applyPath) {
    const plan2 = JSON.parse(readFileSync10(applyPath, "utf8"));
    const bodies = [
      ...plan2.shipped,
      ...plan2.corrections.map((c) => c.body),
      ...plan2.orphans
    ];
    const existing = new Set(readEvents(home, "ledger").map((e) => e.id));
    const events = [];
    for (const body of bodies) {
      const event = finalizeEvent("ledger", body);
      if (!existing.has(event.id)) events.push(event);
    }
    appendEvents(home, "ledger", events);
    if (plan2.baseline) {
      config.baseline = {
        velocity_points_per_sprint: plan2.baseline.velocity_points_per_sprint,
        median_cycle_time_days: plan2.baseline.median_cycle_time_days,
        window: plan2.baseline.window,
        derived_from: plan2.baseline.derived_from
      };
    }
    config.last_sync = plan2.generated_at;
    saveConfig(home, config);
    try {
      execFileSync7("git", ["-C", home, "add", "-A"], { stdio: ["ignore", "ignore", "ignore"], timeout: 15e3 });
      execFileSync7("git", ["-C", home, "commit", "-m", `sync: ${events.length} entr${events.length === 1 ? "y" : "ies"} applied`], {
        stdio: ["ignore", "ignore", "ignore"],
        timeout: 15e3
      });
    } catch {
    }
    process.stdout.write(JSON.stringify({ applied: events.length, last_sync: plan2.generated_at }) + "\n");
    return 0;
  }
  const identity = loadIdentity(home);
  const ctx = defaultContext({
    keyPattern: config.metering.branch_key_pattern,
    identityEmails: identity?.git_emails ?? [],
    githubLogin: identity?.github_login ?? null,
    jiraAccountId: identity?.jira_account_id ?? null
  });
  let items = [];
  if (itemsPath) {
    if (!tracker || !(tracker in TRACKERS)) {
      process.stderr.write(`waybill sync-plan: --items needs --tracker <${Object.keys(TRACKERS).join("|")}>
`);
      return 2;
    }
    items = TRACKERS[tracker].normalizeItems(JSON.parse(readFileSync10(itemsPath, "utf8")), ctx);
  }
  let changes = [];
  if (changesPath) {
    if (!gitHost || !(gitHost in GIT_HOSTS)) {
      process.stderr.write(`waybill sync-plan: --changes needs --git <${Object.keys(GIT_HOSTS).join("|")}>
`);
      return 2;
    }
    changes = GIT_HOSTS[gitHost].normalizeChanges(JSON.parse(readFileSync10(changesPath, "utf8")), ctx);
  }
  if (localRepos.length > 0) {
    const sinceIso = since ?? config.last_sync ?? new Date(Date.parse(now) - 90 * 864e5).toISOString().slice(0, 19) + "Z";
    for (const path of localRepos) {
      if (!isGitRepo(path)) {
        process.stderr.write(`waybill sync-plan: not a git repo, skipping: ${path}
`);
        continue;
      }
      const name = repoFromCwd(path) ?? path;
      changes.push(
        ...gitLocalAdapter.normalizeChanges({ repo: name, log: gitLogRaw(path, sinceIso) }, ctx)
      );
    }
    changes = sortChanges(changes);
  }
  if (!itemsPath && !changesPath && localRepos.length === 0) {
    process.stderr.write(
      "waybill sync-plan: pass --items, --changes, or --local-repo (or --apply <plan.json>)\n"
    );
    return 2;
  }
  const ledgerEvents = readEvents(home, "ledger");
  const plan = reconcile(items, changes, ledgerEvents, now, {
    ...baseline ? { baselineWindow: `until ${now.slice(0, 10)}` } : {}
  });
  process.stdout.write(JSON.stringify(plan, null, 2) + "\n");
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
                [--force  re-meter even when checkpoints say current]
  append      Validate, seal, id, and append one event (the skills' write path)
                --stream <name> (--event '<json>' | --stdin) [--commit]
  resolve     File an attribution-inbox item and re-attribute its turns
                --ambiguity <id> --account <acct> [--pin | --repo-default <org/name>]
  sync-plan   Reconcile normalized tracker/git payloads into proposed entries
                --tracker jira --items <raw.json> --git github|local --changes <raw.json>
                [--local-repo <dir>]... [--since <iso>] [--baseline] | --apply <plan.json>
  query       Projections as JSON: spend | report | forecast | story <KEY> | inbox
                [--from <date|iso>] [--to <date|iso>] [--audience self|internal|external]
  pace        Budget pacing vs the allocation (spend, linear + work-weighted pace,
                per-epic envelopes) [--notice  one line, only on a fresh threshold]
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
    case "resolve":
      return runResolve(cli.home, cli.args, cli.json);
    case "sync-plan":
      return runSyncPlan(cli.home, cli.args);
    case "query":
      return runQuery(cli.home, cli.args);
    case "pace":
      return runPace(cli.home, cli.args, cli.json);
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
