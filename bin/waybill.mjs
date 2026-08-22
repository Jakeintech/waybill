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

// src/core/time.ts
var ISO_BOUND_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
function isIsoBound(v) {
  return ISO_BOUND_RE.test(v) && !Number.isNaN(Date.parse(v));
}
function isIsoTimestamp(v) {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v) && !Number.isNaN(Date.parse(v));
}
function compareInstants(a, b) {
  const pa = Date.parse(a);
  const pb = Date.parse(b);
  if (!Number.isNaN(pa) && !Number.isNaN(pb) && pa !== pb) return pa - pb;
  return a < b ? -1 : a > b ? 1 : 0;
}
function inWindow(ts, from, to) {
  const t = Date.parse(ts);
  const f = from !== null ? Date.parse(from) : null;
  const o = to !== null ? Date.parse(to) : null;
  if (!Number.isNaN(t) && (f === null || !Number.isNaN(f)) && (o === null || !Number.isNaN(o))) {
    if (f !== null && t < f) return false;
    if (o !== null && t > o) return false;
    return true;
  }
  if (from !== null && ts < from) return false;
  if (to !== null && ts > to) return false;
  return true;
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
function readStream(home, stream, onBadLine) {
  const out = [];
  for (const shard of listShards(home, stream)) {
    const raw = readFileSync(shardPath(home, stream, shard), "utf8");
    let lineNo = 0;
    for (const line of raw.split("\n")) {
      lineNo += 1;
      if (line.trim() === "") continue;
      try {
        out.push({ event: JSON.parse(line), shard, lineNo });
      } catch {
        onBadLine?.(shard, lineNo, line);
      }
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
var isIsoUtc = isIsoTimestamp;
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
      lines = readStream(home, stream, (shard, lineNo) => {
        findings.push({
          check: "envelope",
          stream,
          shard,
          id: null,
          message: `${stream}/${shard}.jsonl:${lineNo}: unparseable line (torn write?)`
        });
      });
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
    const supersededBy = /* @__PURE__ */ new Map();
    for (const e of events) {
      if (e.supersedes === null) continue;
      if (!ids.has(e.supersedes)) {
        findings.push({
          check: "supersedes",
          stream,
          shard: shardFor(e.ts),
          id: e.id,
          message: `supersedes ${e.supersedes}, which does not exist in stream "${stream}"`
        });
      }
      const prior = supersededBy.get(e.supersedes);
      if (prior !== void 0) {
        findings.push({
          check: "supersedes",
          stream,
          shard: shardFor(e.ts),
          id: e.id,
          message: `supersedes ${e.supersedes}, already superseded by ${prior} \u2014 forked chain`
        });
      } else {
        supersededBy.set(e.supersedes, e.id);
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
    if (est && est.pre_registered && Number.isNaN(Date.parse(est.logged_at))) {
      findings.push({
        check: "pre_registration",
        stream: "ledger",
        shard: shardFor(e.ts),
        id: e.id,
        message: `pre_registered estimate has no parseable logged_at (${String(est.logged_at)})`
      });
    } else if (est && est.pre_registered && Date.parse(est.logged_at) > Date.parse(e.ts)) {
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
    if (est && est.pre_registered === true && Number.isNaN(Date.parse(est.logged_at))) {
      process.stderr.write("waybill append: a pre_registered estimate needs an ISO logged_at\n");
      return 1;
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
      branch_key_pattern: "[A-Z][A-Z0-9]+-[0-9]+",
      repo_defaults: {}
    },
    pricing: { version: null, unknown_model_policy: "tokens_only", models: {} },
    budgets: { allocation: "inherit", epics: {}, renewal_reminder_days: 14, demurrage_days: 14 },
    notices: { level: "normal" },
    audience_default: "self",
    detail_default: "standard",
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
    budgets: { ...base.budgets, ...raw.budgets },
    notices: { ...base.notices, ...raw.notices }
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

// src/core/keys.ts
var PREFIX_STOPLIST = /* @__PURE__ */ new Set([
  "SHA",
  "MD",
  "CRC",
  "AES",
  "RSA",
  "HMAC",
  "TLS",
  "SSL",
  "UTF",
  "ISO",
  "IEEE",
  "RFC",
  "ANSI",
  "IETF",
  "ECMA",
  "CVE",
  "HTTP",
  "HTTPS",
  "TCP",
  "UDP",
  "IP",
  "IPV",
  "DNS",
  "FTP",
  "SSH",
  "UTC",
  "GMT",
  "BASE",
  "OAUTH",
  "SAML",
  "X",
  "ERR",
  "E",
  "P",
  "S",
  "HTML",
  "CSS",
  "ES",
  "GPT",
  "CPU",
  "GPU",
  "RAM",
  "IOS",
  "OSX"
]);
function keyPrefix(key) {
  const dash = key.indexOf("-");
  return dash === -1 ? key : key.slice(0, dash);
}
function isPlausibleTrackerKey(key, projectKeys) {
  const prefix = keyPrefix(key);
  if (projectKeys.length > 0) return projectKeys.includes(prefix);
  return !PREFIX_STOPLIST.has(prefix);
}

// src/gitlocal/gitlocal.ts
import { existsSync as existsSync3 } from "node:fs";
var FIELD_SEP = "";
var RECORD_SEP = "";
function gitLogRaw(path, sinceIso, untilIso) {
  return execFileSync2(
    "git",
    [
      "-C",
      path,
      "log",
      `--since=${sinceIso}`,
      ...untilIso !== void 0 ? [`--until=${untilIso}`] : [],
      "--date=iso-strict",
      "--pretty=format:%H%x1f%ae%x1f%ad%x1f%cd%x1f%P%x1f%D%x1f%s%x1f%b%x1e"
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
    const hasCommitterDate = /^\d{4}-\d{2}-\d{2}T/.test(parts[3] ?? "");
    const [sha, email, adate] = parts;
    const cdate = hasCommitterDate ? parts[3] : "";
    const rest = hasCommitterDate ? parts.slice(4) : parts.slice(3);
    const [parents, refs, subject, ...body] = rest;
    if (parents === void 0 || refs === void 0 || subject === void 0) continue;
    out.push({
      sha,
      author_email: email,
      author_date: adate,
      committer_date: cdate,
      parents: parents.trim() === "" ? 0 : parents.trim().split(" ").length,
      refs: refs.split(",").map((r) => r.trim()).filter((r) => r !== ""),
      subject,
      body: body.join(FIELD_SEP)
      // "" for pre-body-format logs
    });
  }
  return out;
}
function summarizeRepo(repo, path, commits, identityEmails, keyPattern, projectKeys = []) {
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
      if (!isPlausibleTrackerKey(k, projectKeys)) continue;
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
var RULES_VERSION = "2";
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
  if (branchKey && isPlausibleTrackerKey(branchKey, ctx.projectKeys ?? [])) {
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

// src/core/pricing-resolve.ts
function normalizeModelId(id) {
  return id.replace(/-\d{8}$/, "");
}
function resolveRate(pricing, model) {
  if (Object.hasOwn(pricing.models, model)) {
    return { rate_model: model, rates: pricing.models[model] };
  }
  const wanted = normalizeModelId(model);
  let best = null;
  for (const key of Object.keys(pricing.models)) {
    if (normalizeModelId(key) !== wanted) continue;
    if (key === wanted) {
      best = key;
      break;
    }
    if (best === null || key > best) best = key;
  }
  return best === null ? null : { rate_model: best, rates: pricing.models[best] };
}
function unpricedModels(pricing, models) {
  const missing = /* @__PURE__ */ new Set();
  for (const m of models) {
    if (m === "unknown") continue;
    if (resolveRate(pricing, m) === null) missing.add(m);
  }
  return [...missing].sort();
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
    let hasContent = false;
    for (const item of content) {
      const t = item.type;
      if (t === "tool_result") return false;
      if (t === "text" || t === "image" || t === "document") hasContent = true;
    }
    return hasContent;
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
function toolBlocks(content) {
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const item of content) {
    const block = item;
    if (block.type !== "tool_use" || typeof block.id !== "string") continue;
    out.push({
      id: block.id,
      name: typeof block.name === "string" ? block.name : "",
      command: typeof block.input?.command === "string" ? block.input.command : null,
      file_path: typeof block.input?.file_path === "string" ? block.input.file_path : null
    });
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
  const seenToolIds = /* @__PURE__ */ new Set();
  const commandTallies = /* @__PURE__ */ new Map();
  const readTallies = /* @__PURE__ */ new Map();
  const overheadTurns = /* @__PURE__ */ new Set();
  const ensureTurn = () => {
    if (!currentTurn) {
      currentTurn = {
        index: turnIndex,
        promptId: null,
        branchAtStart: currentBranch,
        firstMessageId: null,
        lastMessageId: null,
        models: [],
        waste: { retried_commands: 0, repeated_reads: 0 },
        overhead: false
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
        models: [],
        waste: { retried_commands: 0, repeated_reads: 0 },
        overhead: false
      };
      turns.push(currentTurn);
      continue;
    }
    if (line.type === "assistant" && line.message) {
      const msg = line.message;
      for (const block of toolBlocks(msg.content)) {
        if (seenToolIds.has(block.id)) continue;
        seenToolIds.add(block.id);
        const tIdx = currentTurn?.index ?? turnIndex;
        if (block.command !== null) {
          for (const ev of evidenceFromCommand(block.command, keyPattern)) {
            if (!isPlausibleTrackerKey(ev.key, options.projectKeys ?? [])) continue;
            evidence.push({ ...ev, turnIndex: tIdx });
          }
          const tally = commandTallies.get(tIdx) ?? /* @__PURE__ */ new Map();
          tally.set(block.command, (tally.get(block.command) ?? 0) + 1);
          commandTallies.set(tIdx, tally);
          if (block.command.includes("bin/waybill") || block.command.includes("waybill.mjs")) {
            overheadTurns.add(tIdx);
          }
        }
        if (block.name === "Read" && block.file_path !== null) {
          const tally = readTallies.get(tIdx) ?? /* @__PURE__ */ new Map();
          tally.set(block.file_path, (tally.get(block.file_path) ?? 0) + 1);
          readTallies.set(tIdx, tally);
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
var METER_LOGIC_VERSION = "3";
function priceTokens(config, model, tokens) {
  const version = config.pricing.version;
  const rates = resolveRate(config.pricing, model)?.rates;
  if (!version || !rates) return null;
  const cc5m = tokens.cache_creation_5m === 0 && tokens.cache_creation_1h === 0 ? tokens.cache_creation : Math.max(tokens.cache_creation - tokens.cache_creation_1h, 0);
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
    branchKeyPattern: input.config.metering.branch_key_pattern,
    projectKeys: input.config.tracker.project_keys
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
    projectKeys: input.config.tracker.project_keys,
    ...input.turnOverrides ? { turnOverrides: input.turnOverrides } : {}
  };
  const existingUsageAuth = authoritative(input.existingUsage).filter(
    (u) => u.kind === "usage" && u.session_id === sessionId
  );
  const usageByGrain = /* @__PURE__ */ new Map();
  for (const u of existingUsageAuth) {
    if (u.source === "otel") continue;
    usageByGrain.set(`${u.turn.index}|${u.model}`, u);
  }
  const existingIds = new Set(input.existingUsage.map((u) => u.id));
  for (const stale of existingUsageAuth) {
    if (stale.source !== "otel") continue;
    const retire = finalizeEvent("usage", {
      ts: transcript.lastTs,
      kind: "correction",
      schema_version: SCHEMA_VERSION,
      supersedes: stale.id,
      session_id: sessionId,
      detail: "superseded by transcript metering (transcript wins over otel)"
    });
    if (!existingIds.has(retire.id)) newUsage.push(retire);
  }
  const emitted = zeroTotals();
  for (const turn of transcript.turns) {
    const { attribution: attribution2, ambiguity } = resolveTurn(turn, ctx);
    const settled = attribution2.resolver === "pin" || attribution2.resolver === "active_entry" || attribution2.resolver === "transcript_evidence";
    if (ambiguity && !settled) {
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
    const sortedModels = [...turn.models].sort((a, b) => a.model < b.model ? -1 : 1);
    for (const agg of sortedModels) {
      addTotals(emitted, agg.tokens);
      const ts = agg.lastTs !== "" ? agg.lastTs : transcript.lastTs;
      const prior = usageByGrain.get(`${turn.index}|${agg.model}`);
      const extras = Object.keys(agg.extras).length > 0 ? sortRecord(agg.extras) : null;
      const waste = agg === sortedModels[0] && (turn.waste.retried_commands > 0 || turn.waste.repeated_reads > 0) ? turn.waste : null;
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
        raw_extra: extras,
        waste,
        // Present only when true: non-overhead events keep their pre-1.6
        // content addresses.
        ...turn.overhead ? { overhead: true } : {}
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
import { existsSync as existsSync4, readFileSync as readFileSync4, renameSync, writeFileSync as writeFileSync2 } from "node:fs";
import { join as join4 } from "node:path";
function statePath(home) {
  return join4(home, "meter_state.json");
}
function loadState(home) {
  const p = statePath(home);
  if (!existsSync4(p)) {
    return { schema_version: 2, sessions: {} };
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync4(p, "utf8"));
  } catch {
    return { schema_version: 2, sessions: {} };
  }
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
      // Absent on pre-1.5 checkpoints: stale, forcing one clean re-meter
      // (which re-prices dated model ids under the resolution rules).
      meter_version: legacy.meter_version ?? "",
      pricing_digest: legacy.pricing_digest ?? "",
      pricing_version: legacy.pricing_version ?? null,
      attribution_inputs: legacy.attribution_inputs ?? null
    };
  }
  return { schema_version: 2, sessions };
}
function saveState(home, state) {
  const p = statePath(home);
  writeFileSync2(`${p}.tmp`, JSON.stringify(state, null, 2) + "\n", "utf8");
  renameSync(`${p}.tmp`, p);
}
function isCurrent(state, sessionId, fileBytes, pricingDigest, attributionInputs) {
  const cp = Object.hasOwn(state.sessions, sessionId) ? state.sessions[sessionId] : void 0;
  if (cp === void 0) return false;
  return cp.file_bytes === fileBytes && cp.rules_version === RULES_VERSION && cp.meter_version === METER_LOGIC_VERSION && cp.pricing_digest === pricingDigest && cp.attribution_inputs === attributionInputs;
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
      project_keys: config.tracker.project_keys,
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
  let start = 0;
  for (let i = 0; i < 8 && start < raw.length; i++) {
    const nl = raw.indexOf("\n", start);
    const line = nl === -1 ? raw.slice(start) : raw.slice(start, nl);
    start = nl === -1 ? raw.length : nl + 1;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed.sessionId === "string") return parsed.sessionId;
    } catch {
    }
  }
  return null;
}
function meterFile(home, transcriptPath, repoHint, force = false) {
  const config = loadConfig(home);
  const state = loadState(home);
  const fileBytes = statSync(transcriptPath).size;
  const raw = readFileSync5(transcriptPath, "utf8");
  const pricingDigest = sha256Hex(canonicalJson(config.pricing));
  const ledgerEvents = readEvents(home, "ledger");
  const existingExceptions = readEvents(home, "exceptions");
  const fingerprint = attributionFingerprint(ledgerEvents, existingExceptions, config);
  const duplicateOf = (sid) => {
    const cp = Object.hasOwn(state.sessions, sid) ? state.sessions[sid] : void 0;
    if (!cp || cp.transcript_path === transcriptPath) return false;
    if (!existsSync5(cp.transcript_path)) return false;
    try {
      return statSync(cp.transcript_path).size >= fileBytes;
    } catch {
      return false;
    }
  };
  const probedId = probeSessionId(raw);
  if (!force && probedId !== null) {
    if (isCurrent(state, probedId, fileBytes, pricingDigest, fingerprint) || duplicateOf(probedId)) {
      return { session_id: probedId, transcript_path: transcriptPath, skipped: true, remetered: false, usage: 0, sessions: 0, exceptions: 0 };
    }
  }
  const probe = parseTranscript(raw, {
    branchKeyPattern: config.metering.branch_key_pattern,
    projectKeys: config.tracker.project_keys
  });
  const sessionId = probe.sessionId;
  if (!force && sessionId !== null && sessionId !== probedId) {
    if (isCurrent(state, sessionId, fileBytes, pricingDigest, fingerprint) || duplicateOf(sessionId)) {
      return { session_id: sessionId, transcript_path: transcriptPath, skipped: true, remetered: false, usage: 0, sessions: 0, exceptions: 0 };
    }
  }
  const hadCheckpoint = sessionId !== null && Object.hasOwn(state.sessions, sessionId);
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
      meter_version: METER_LOGIC_VERSION,
      pricing_digest: pricingDigest,
      pricing_version: config.pricing.version,
      attribution_inputs: fingerprint
    };
    saveState(home, state);
  }
  return {
    session_id: out.sessionId,
    transcript_path: transcriptPath,
    skipped: false,
    remetered: hadCheckpoint,
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
function collectTokens(home, sinceIso, untilIso) {
  const usage = authoritative(readEvents(home, "usage")).filter(
    (u) => u.kind === "usage" && u.ts >= sinceIso && (untilIso === void 0 || u.ts <= untilIso)
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
  let fromIso = null;
  let toIso = null;
  const repoPaths = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--days") days = Number(args[++i] ?? "90");
    else if (a === "--from") fromIso = args[++i] ?? null;
    else if (a === "--to") toIso = args[++i] ?? null;
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
  if (fromIso && Number.isNaN(Date.parse(fromIso)) || toIso && Number.isNaN(Date.parse(toIso))) {
    process.stderr.write("waybill bootstrap: --from/--to must be dates\n");
    return 2;
  }
  const toInflated = toIso && /^\d{4}-\d{2}-\d{2}$/.test(toIso) ? `${toIso}T23:59:59.999Z` : toIso;
  const now = toInflated ? new Date(toInflated) : nowIso2 ? new Date(nowIso2) : /* @__PURE__ */ new Date();
  const since = fromIso ? new Date(fromIso) : new Date(now.getTime() - days * 864e5);
  if (fromIso) days = Math.max(1, Math.round((now.getTime() - since.getTime()) / 864e5));
  const sinceIso = since.toISOString().slice(0, 19) + "Z";
  const untilIso = toInflated ? new Date(toInflated).toISOString() : void 0;
  if (repoPaths.length === 0 && isGitRepo(process.cwd())) repoPaths.push(process.cwd());
  const repos = [];
  for (const path of repoPaths) {
    if (!isGitRepo(path)) {
      process.stderr.write(`waybill bootstrap: not a git repo, skipping: ${path}
`);
      continue;
    }
    const name = repoFromCwd(path) ?? path;
    const commits = parseGitLog(gitLogRaw(path, sinceIso, untilIso));
    repos.push(summarizeRepo(name, path, commits, emails, config.metering.branch_key_pattern, config.tracker.project_keys));
  }
  const data = {
    window_days: days,
    since: sinceIso.slice(0, 10),
    until: now.toISOString().slice(0, 10),
    emails,
    repos,
    tokens: collectTokens(home, sinceIso, untilIso)
  };
  if (json) {
    process.stdout.write(JSON.stringify(data, null, 2) + "\n");
  } else {
    process.stdout.write(renderReceipt(data) + "\n");
  }
  return 0;
}

// src/cli/cmd-conventions.ts
function runConventions(home, args, json) {
  for (const a of args) {
    process.stderr.write(`waybill conventions: unknown option ${a}
`);
    return 2;
  }
  const config = loadConfig(home);
  const pattern = config.metering.branch_key_pattern;
  const keys = config.tracker.project_keys;
  const example = keys.length > 0 ? `${keys[0]}-123` : "PLAT-123";
  const claudeMd = `## Commit & PR conventions (waybill receipts)

Work in this repo is metered and attributed by the waybill plugin. Keep
the receipts clean:

- Branch names carry the story key: \`feat/${example}-short-slug\`.
- Commit subjects lead with the key: \`${example}: what changed\`.
- PR bodies carry a closing keyword where one applies: \`Fixes #12\`.
- One story per session where practical; say "log it" when starting
  sizeable work so the estimate is pre-registered, and "pin this session
  to ${example}" when a session's account is ambiguous.
`;
  const hook = `#!/bin/sh
# waybill commit-msg hook: prefix the story key from the branch when the
# message doesn't already carry one. Install:
#   save as .git/hooks/commit-msg && chmod +x .git/hooks/commit-msg
branch=$(git symbolic-ref --short HEAD 2>/dev/null || git rev-parse --abbrev-ref HEAD 2>/dev/null) || exit 0
key=$(printf '%s' "$branch" | grep -oE '${pattern}' | head -n 1)
[ -n "$key" ] || exit 0
grep -qE '${pattern}' "$1" || {
  tmp="$1.waybill" && printf '%s: ' "$key" | cat - "$1" > "$tmp" && mv "$tmp" "$1"
}
exit 0
`;
  if (json) {
    process.stdout.write(JSON.stringify({ data: { claude_md: claudeMd, commit_msg_hook: hook } }, null, 2) + "\n");
    return 0;
  }
  process.stdout.write(
    "Receipt-friendly conventions \u2014 attribution improves because the inputs improve.\n\n\u2500\u2500\u2500 CLAUDE.md block (append to the repo's CLAUDE.md) " + "\u2500".repeat(10) + "\n\n" + claudeMd + "\n\u2500\u2500\u2500 commit-msg hook (optional; save as .git/hooks/commit-msg, chmod +x) \u2500\u2500\u2500\n\n" + hook + "\nEvery convention adopted raises resolver confidence and shrinks the inbox.\n"
  );
  return 0;
}

// src/cli/cmd-dashboard.ts
import { existsSync as existsSync7, mkdirSync as mkdirSync2, readFileSync as readFileSync6, writeFileSync as writeFileSync3 } from "node:fs";
import { join as join7 } from "node:path";

// src/core/references.ts
import { existsSync as existsSync6 } from "node:fs";
import { dirname, join as join6 } from "node:path";
import { fileURLToPath } from "node:url";
function findReferenceFile(filename) {
  const pluginRoot = process.env["CLAUDE_PLUGIN_ROOT"];
  if (pluginRoot) {
    const p = join6(pluginRoot, "references", filename);
    if (existsSync6(p)) return p;
  }
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const p = join6(dir, "references", filename);
    if (existsSync6(p)) return p;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`bundled reference file not found: ${filename}`);
}

// src/projections/queries.ts
function normalizeWindow(from, to) {
  const check = (v, name) => {
    if (v === null) return null;
    if (!isIsoBound(v)) {
      throw new Error(`--${name} must be an ISO date (YYYY-MM-DD or full ISO timestamp): ${v}`);
    }
    return v;
  };
  const f = check(from, "from");
  let t = check(to, "to");
  if (t !== null && /^\d{4}-\d{2}-\d{2}$/.test(t)) t = `${t}T23:59:59.999Z`;
  return { from: f, to: t };
}
function inWindow2(ts, w) {
  return inWindow(ts, w.from, w.to);
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
    (u) => u.kind === "usage" && inWindow2(u.ts, window) && totalTokens(u) > 0
  );
  const accounts = /* @__PURE__ */ new Map();
  const models = /* @__PURE__ */ new Map();
  const weeks = /* @__PURE__ */ new Map();
  const accountSessions = /* @__PURE__ */ new Map();
  let total = 0;
  let pricedTokens = 0;
  let overheadTokens = 0;
  let cacheReadTokens = 0;
  let cacheSavedUsd = 0;
  let cacheCoveredTokens = 0;
  const unpricedByModel = /* @__PURE__ */ new Set();
  for (const u of usage) {
    const t = totalTokens(u);
    total += t;
    if (u.overhead === true) overheadTokens += t;
    if (u.tokens.cache_read > 0) {
      cacheReadTokens += u.tokens.cache_read;
      const rate = resolveRate(config.pricing, u.model);
      if (rate !== null) {
        cacheCoveredTokens += u.tokens.cache_read;
        cacheSavedUsd += u.tokens.cache_read * (rate.rates.input_per_mtok - rate.rates.cache_read_per_mtok) / 1e6;
      }
    }
    if (u.cost_usd) pricedTokens += t;
    else if (u.model !== "unknown") unpricedByModel.add(u.model);
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
      sessions: 0,
      waste: { retried_commands: 0, repeated_reads: 0 }
    };
    acc.tokens += t;
    acc.input += u.tokens.input;
    acc.output += u.tokens.output;
    acc.cache_read += u.tokens.cache_read;
    acc.cache_creation += u.tokens.cache_creation;
    if (u.cost_usd) acc.cost_usd = Math.round(((acc.cost_usd ?? 0) + u.cost_usd.value) * 1e4) / 1e4;
    if (u.attribution.confidence < acc.min_confidence) acc.min_confidence = u.attribution.confidence;
    if (!acc.resolvers.includes(u.attribution.resolver)) acc.resolvers.push(u.attribution.resolver);
    if (u.waste) {
      acc.waste.retried_commands += u.waste.retried_commands;
      acc.waste.repeated_reads += u.waste.repeated_reads;
    }
    accounts.set(u.attribution.account, acc);
    const sess = accountSessions.get(u.attribution.account) ?? /* @__PURE__ */ new Set();
    sess.add(u.session_id);
    accountSessions.set(u.attribution.account, sess);
    const m = models.get(u.model) ?? { tokens: 0, cost: 0, priced: false, unpriced: 0 };
    m.tokens += t;
    if (u.cost_usd) {
      m.cost = Math.round((m.cost + u.cost_usd.value) * 1e4) / 1e4;
      m.priced = true;
    } else {
      m.unpriced += t;
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
    by_model: [...models.entries()].map(([model, m]) => ({ model, tokens: m.tokens, cost_usd: m.priced ? m.cost : null, unpriced_tokens: m.unpriced })).sort((a, b) => b.tokens - a.tokens || (a.model < b.model ? -1 : 1)),
    by_week: [...weeks.entries()].map(([week, tokens]) => ({ week, tokens })).sort((a, b) => a.week < b.week ? -1 : 1),
    total_tokens: total,
    unattributed_tokens: unattributed,
    unattributed_pct: total > 0 ? Math.round(unattributed / total * 1e3) / 10 : 0,
    open_spend: openSpend,
    attribution_health: {
      attributed_pct_conf_060: total > 0 ? Math.round(attributed / total * 1e3) / 10 : 0,
      inbox_open: openAmbiguities
    },
    pricing_version: config.pricing.version,
    pricing_coverage: {
      priced_tokens: pricedTokens,
      unpriced_tokens: total - pricedTokens,
      priced_pct: total > 0 ? Math.round(pricedTokens / total * 1e3) / 10 : 0,
      unpriced_event_models: [...unpricedByModel].sort()
    },
    overhead: {
      tokens: overheadTokens,
      pct: total > 0 ? Math.round(overheadTokens / total * 1e3) / 10 : 0
    },
    cache_savings: {
      cache_read_tokens: cacheReadTokens,
      cache_read_pct: total > 0 ? Math.round(cacheReadTokens / total * 1e3) / 10 : 0,
      saved_usd: cacheCoveredTokens > 0 ? Math.round(cacheSavedUsd * 1e4) / 1e4 : null,
      covered_pct: cacheReadTokens > 0 ? Math.round(cacheCoveredTokens / cacheReadTokens * 1e3) / 10 : 0,
      basis: "list_price_equivalent_derived"
    }
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
  const views = effectiveShipped(ledgerEvents).filter((s) => inWindow2(s.shipped_ts, window));
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
  const storyModelTokens = /* @__PURE__ */ new Map();
  for (const u of authoritative(usageEvents)) {
    if (u.kind !== "usage" || !inWindow2(u.ts, window) || totalTokens(u) === 0) continue;
    if (!u.attribution.account.startsWith("story:")) continue;
    const key = u.attribution.account.slice(6);
    const split = storyModelTokens.get(key) ?? /* @__PURE__ */ new Map();
    split.set(u.model, (split.get(u.model) ?? 0) + totalTokens(u));
    storyModelTokens.set(key, split);
  }
  const byModel = /* @__PURE__ */ new Map();
  const mixed = { stories: 0, points: 0, tokens: 0 };
  for (const s of shipped) {
    if (s.tracker_key === null || s.points === null || s.points <= 0) continue;
    const split = storyModelTokens.get(s.tracker_key);
    if (!split) continue;
    let storyTotal = 0;
    let topModel = "";
    let topTokens = -1;
    for (const [model, tokens] of [...split.entries()].sort()) {
      storyTotal += tokens;
      if (tokens > topTokens) {
        topModel = model;
        topTokens = tokens;
      }
    }
    if (topTokens * 2 > storyTotal) {
      const row = byModel.get(topModel) ?? { stories: 0, points: 0, tokens: 0 };
      row.stories += 1;
      row.points += s.points;
      row.tokens += storyTotal;
      byModel.set(topModel, row);
    } else {
      mixed.stories += 1;
      mixed.points += s.points;
      mixed.tokens += storyTotal;
    }
  }
  const calEntries = [];
  let preRegistered = 0;
  for (const { entry } of views) {
    const est = entry.estimate_without_claude_hours;
    if (!est || !est.pre_registered) continue;
    preRegistered += 1;
    if (entry.actual_hours === null) continue;
    const a = entry.actual_hours;
    calEntries.push({
      tracker_key: entry.tracker_key,
      low: est.low,
      high: est.high,
      actual_hours: a,
      position: a < est.low ? "below" : a > est.high ? "above" : "within"
    });
  }
  calEntries.sort((a, b) => (a.tracker_key ?? "") < (b.tracker_key ?? "") ? -1 : 1);
  return {
    window,
    shipped,
    totals: { points: points2, merged_prs: mergedPrs, deploys, shipped_metered_tokens: meteredTokens },
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
      unattributed_pct: spend.unattributed_pct,
      reopened_count: views.filter((v) => v.entry.reopened === true).length,
      waste: spend.accounts.reduce(
        (w, a) => ({
          retried_commands: w.retried_commands + a.waste.retried_commands,
          repeated_reads: w.repeated_reads + a.waste.repeated_reads
        }),
        { retried_commands: 0, repeated_reads: 0 }
      )
    },
    spend_ledger: spend,
    baseline: config.baseline.velocity_points_per_sprint !== null || config.baseline.median_cycle_time_days !== null ? config.baseline : null,
    model_mix: {
      by_model: [...byModel.entries()].map(([model, r]) => ({
        model,
        stories: r.stories,
        points: r.points,
        tokens: r.tokens,
        tokens_per_point: r.points > 0 ? Math.round(r.tokens / r.points) : null
      })).sort((a, b) => b.tokens - a.tokens || (a.model < b.model ? -1 : 1)),
      mixed
    },
    calibration: {
      shipped: views.length,
      pre_registered: preRegistered,
      coverage_pct: views.length > 0 ? Math.round(preRegistered / views.length * 1e3) / 10 : 0,
      with_actuals: calEntries.length,
      actual_below_range: calEntries.filter((e) => e.position === "below").length,
      actual_within_range: calEntries.filter((e) => e.position === "within").length,
      actual_above_range: calEntries.filter((e) => e.position === "above").length,
      entries: calEntries
    }
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

// src/projections/manifest.ts
function totalTokens2(t) {
  return t.input + t.output + t.cache_read + t.cache_creation;
}
function wholeDays(fromTs, toTs) {
  const d = (Date.parse(toTs) - Date.parse(fromTs)) / 864e5;
  return Number.isFinite(d) ? Math.max(0, Math.floor(d)) : 0;
}
function manifestData(ledgerEvents, usageEvents, config, nowIso2) {
  const shipChained = new Set(effectiveShipped(ledgerEvents).map((v) => v.entry.id));
  const byId = new Map(ledgerEvents.map((e) => [e.id, e]));
  const spendByKey = /* @__PURE__ */ new Map();
  for (const u of authoritative(usageEvents)) {
    if (u.kind !== "usage") continue;
    const account = u.attribution.account;
    if (!account.startsWith("story:")) continue;
    const key = account.slice(6);
    const cur = spendByKey.get(key) ?? { tokens: 0, last: u.ts };
    cur.tokens += totalTokens2(u.tokens);
    if (u.ts > cur.last) cur.last = u.ts;
    spendByKey.set(key, cur);
  }
  const demurrageDays = config.budgets.demurrage_days;
  const openItems = [];
  for (const head of authoritative(ledgerEvents)) {
    if (head.kind === "pin" || shipChained.has(head.id)) continue;
    const entry = head;
    let cur = entry;
    const seen = /* @__PURE__ */ new Set();
    let openedTs = entry.ts;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      openedTs = cur.ts;
      cur = cur.supersedes !== null ? byId.get(cur.supersedes) : void 0;
    }
    const spend = entry.tracker_key !== null ? spendByKey.get(entry.tracker_key) : void 0;
    const lastActivity = spend?.last ?? null;
    const idleDays = lastActivity !== null ? wholeDays(lastActivity, nowIso2) : null;
    openItems.push({
      tracker_key: entry.tracker_key,
      title: entry.title,
      work_type: entry.work_type,
      opened_ts: openedTs,
      age_days: wholeDays(openedTs, nowIso2),
      tokens: spend?.tokens ?? 0,
      last_activity: lastActivity,
      idle_days: idleDays,
      sitting: (spend?.tokens ?? 0) > 0 && idleDays !== null && idleDays >= demurrageDays
    });
  }
  openItems.sort((a, b) => b.tokens - a.tokens || (a.opened_ts < b.opened_ts ? -1 : 1));
  return {
    now: nowIso2,
    demurrage_days: demurrageDays,
    open_items: openItems,
    open_tokens: openItems.reduce((n, i) => n + i.tokens, 0),
    sitting: openItems.filter((i) => i.sitting).length
  };
}

// src/projections/standup.ts
function inWindow3(ts, w) {
  return inWindow(ts, w.from, w.to);
}
function totalTokens3(t) {
  return t.input + t.output + t.cache_read + t.cache_creation;
}
function standupData(ledgerEvents, usageEvents, sessionEvents, exceptionEvents, config, window, label = null) {
  const usage = authoritative(usageEvents).filter(
    (u) => u.kind === "usage" && inWindow3(u.ts, window) && totalTokens3(u.tokens) > 0
  );
  const shippedViews = effectiveShipped(ledgerEvents).filter((s) => inWindow3(s.shipped_ts, window));
  const shipped = shippedViews.map(({ entry: e, shipped_ts }) => ({
    tracker_key: e.tracker_key,
    title: e.title,
    points: e.points,
    prs: e.artifacts.prs,
    deploy: e.artifacts.deploy,
    ts: shipped_ts,
    claude_role: e.claude_role,
    escrowed: e.escrow !== null
  })).sort((a, b) => a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0);
  const shippedKeys = new Set(shipped.map((s) => s.tracker_key).filter((k) => k !== null));
  const authEntries = authoritative(ledgerEvents).filter(
    (e) => e.kind !== "pin"
  );
  const titleByKey = /* @__PURE__ */ new Map();
  for (const e of authEntries) {
    if (e.tracker_key !== null) titleByKey.set(e.tracker_key, e.title);
  }
  const byAccount = /* @__PURE__ */ new Map();
  const totals = { input: 0, output: 0, cache_read: 0, cache_creation: 0 };
  let cost = null;
  const unpriced = /* @__PURE__ */ new Map();
  const waste = { retried_commands: 0, repeated_reads: 0 };
  for (const u of usage) {
    totals.input += u.tokens.input;
    totals.output += u.tokens.output;
    totals.cache_read += u.tokens.cache_read;
    totals.cache_creation += u.tokens.cache_creation;
    if (u.cost_usd) cost = Math.round(((cost ?? 0) + u.cost_usd.value) * 1e4) / 1e4;
    else unpriced.set(u.model, (unpriced.get(u.model) ?? 0) + totalTokens3(u.tokens));
    if (u.waste) {
      waste.retried_commands += u.waste.retried_commands;
      waste.repeated_reads += u.waste.repeated_reads;
    }
    const acc = byAccount.get(u.attribution.account) ?? {
      tokens: 0,
      sessions: /* @__PURE__ */ new Set(),
      last_ts: u.ts
    };
    acc.tokens += totalTokens3(u.tokens);
    acc.sessions.add(u.session_id);
    if (u.ts > acc.last_ts) acc.last_ts = u.ts;
    byAccount.set(u.attribution.account, acc);
  }
  const allShippedKeys = new Set(
    effectiveShipped(ledgerEvents).map((s) => s.entry.tracker_key).filter((k) => k !== null)
  );
  const progressed = [...byAccount.entries()].filter(([account]) => {
    if (account === "unattributed") return false;
    const key = account.startsWith("story:") ? account.slice(6) : null;
    return key === null || !shippedKeys.has(key);
  }).map(([account, a]) => {
    const key = account.startsWith("story:") ? account.slice(6) : null;
    return {
      account,
      title: key !== null ? titleByKey.get(key) ?? null : null,
      tokens: a.tokens,
      sessions: a.sessions.size,
      last_ts: a.last_ts,
      shipped_earlier: key !== null && allShippedKeys.has(key)
    };
  }).sort((a, b) => b.tokens - a.tokens || (a.account < b.account ? -1 : 1));
  const byId = new Map(ledgerEvents.map((e) => [e.id, e]));
  const opened = authoritative(ledgerEvents).filter((e) => e.kind !== "pin").map((head) => {
    let cur = head;
    const seen = /* @__PURE__ */ new Set();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      if (cur.kind === "opened") return { head, opened_ts: cur.ts };
      cur = cur.supersedes !== null ? byId.get(cur.supersedes) : void 0;
    }
    return null;
  }).filter((v) => v !== null && inWindow3(v.opened_ts, window)).map(({ head, opened_ts }) => ({
    tracker_key: head.tracker_key,
    title: head.title,
    ts: opened_ts,
    pre_registered: head.estimate_without_claude_hours?.pre_registered === true
  })).sort((a, b) => a.ts < b.ts ? -1 : 1);
  const receipts = authoritative(sessionEvents).filter((s) => {
    if (s.kind !== "session") return false;
    return (window.from === null || inWindow3(s.last_ts, { from: window.from, to: null })) && (window.to === null || inWindow3(s.first_ts, { from: null, to: window.to }));
  });
  const repos = [];
  const branches = [];
  let turns = 0;
  for (const s of receipts) {
    if (s.repo !== null && !repos.includes(s.repo)) repos.push(s.repo);
    for (const b of s.branches) if (!branches.includes(b)) branches.push(b);
    turns += s.turns;
  }
  repos.sort();
  branches.sort();
  const total = totalTokens3(totals);
  const unattributed = byAccount.get("unattributed")?.tokens ?? 0;
  const unpricedTokens = [...unpriced.values()].reduce((n, t) => n + t, 0);
  return {
    window: { from: window.from ?? "", to: window.to ?? "", label },
    shipped,
    progressed,
    opened,
    session_summary: { count: receipts.length, repos, branches, turns },
    tokens: {
      total,
      totals,
      cost_usd: cost,
      pricing_version: config.pricing.version,
      unpriced_models: [...unpriced.keys()].filter((m) => m !== "unknown").sort(),
      unpriced_tokens: unpricedTokens
    },
    waste,
    attention: {
      inbox_open: countOpenAmbiguities(exceptionEvents),
      unattributed_tokens: unattributed,
      unattributed_pct: total > 0 ? Math.round(unattributed / total * 1e3) / 10 : 0
    }
  };
}
function localDayWindow(base, offsetDays) {
  const start = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offsetDays, 0, 0, 0, 0);
  const end = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offsetDays + 1, 0, 0, 0, 0);
  return {
    from: start.toISOString(),
    to: new Date(end.getTime() - 1).toISOString()
  };
}
function resolveStandupWindow(args, now) {
  if (args.from !== null || args.to !== null) {
    return { window: normalizeWindow(args.from, args.to), label: null };
  }
  if (args.days !== null) {
    if (!Number.isFinite(args.days) || args.days <= 0 || !Number.isInteger(args.days)) {
      throw new Error("--days must be a positive integer");
    }
    const first = localDayWindow(now, -(args.days - 1));
    const last = localDayWindow(now, 0);
    return {
      window: { from: first.from, to: last.to },
      label: `last ${args.days} day(s)`
    };
  }
  const date = args.date ?? "yesterday";
  if (date === "yesterday" || date === "today") {
    const w2 = localDayWindow(now, date === "yesterday" ? -1 : 0);
    return { window: w2, label: date };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`--date must be yesterday, today, or YYYY-MM-DD (got: ${date})`);
  }
  const [y, m, d] = date.split("-").map(Number);
  const base = new Date(y, m - 1, d);
  if (base.getFullYear() !== y || base.getMonth() !== m - 1 || base.getDate() !== d) {
    throw new Error(`--date is not a real calendar date: ${date}`);
  }
  const w = localDayWindow(base, 0);
  return { window: w, label: date };
}

// src/cli/cmd-dashboard.ts
function generateDashboard(home, nowIso2) {
  const config = loadConfig(home);
  const ledger = readEvents(home, "ledger");
  const usage = readEvents(home, "usage");
  const sessions = readEvents(home, "sessions");
  const exceptions = readEvents(home, "exceptions");
  const now = new Date(nowIso2);
  const iso = (d) => d.toISOString();
  const daysAgo = (n) => iso(new Date(now.getTime() - n * 864e5));
  const spend30 = spendData(usage, exceptions, ledger, config, { from: daysAgo(30), to: nowIso2 });
  const spend12w = spendData(usage, exceptions, ledger, config, { from: daysAgo(84), to: nowIso2 });
  const week = { from: localDayWindow(now, -6).from, to: localDayWindow(now, 0).to };
  const standup = standupData(ledger, usage, sessions, exceptions, config, week, "last 7 day(s)");
  const manifest = manifestData(ledger, usage, config, nowIso2);
  const data = {
    generated_at: nowIso2,
    engine: ENGINE_VERSION,
    spend30,
    weeks: spend12w.by_week.slice(-12),
    standup,
    manifest
  };
  const template = readFileSync6(findReferenceFile("dashboard-template.html"), "utf8");
  const payload = JSON.stringify(data).replace(/</g, "\\u003c");
  const html = template.replace("__WAYBILL_DATA__", payload);
  const dir = join7(home, "rollups");
  mkdirSync2(dir, { recursive: true });
  const out = join7(dir, "dashboard.html");
  writeFileSync3(out, html, "utf8");
  return out;
}
function refreshDashboardIfPresent(home) {
  try {
    if (existsSync7(join7(home, "rollups", "dashboard.html"))) {
      generateDashboard(home, (/* @__PURE__ */ new Date()).toISOString().replace(/\.\d{3}Z$/, "Z"));
    }
  } catch {
  }
}
function runDashboard(home, args, json) {
  let nowIso2 = (/* @__PURE__ */ new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--now") {
      const v = args[++i];
      if (!v || Number.isNaN(Date.parse(v))) {
        process.stderr.write("waybill dashboard: --now needs an ISO timestamp\n");
        return 2;
      }
      nowIso2 = v;
    } else {
      process.stderr.write(`waybill dashboard: unknown option ${a}
`);
      return 2;
    }
  }
  let out;
  try {
    out = generateDashboard(home, nowIso2);
  } catch (err) {
    process.stderr.write(`waybill dashboard: ${err.message}
`);
    return 1;
  }
  if (json) {
    process.stdout.write(JSON.stringify({ data: { path: out, generated_at: nowIso2 } }) + "\n");
  } else {
    process.stdout.write(
      `wrote ${out}
Open it in a browser \u2014 reading your numbers costs zero tokens. The miner refreshes it after each session; regenerate any time with: waybill dashboard
`
    );
  }
  return 0;
}

// src/cli/cmd-init.ts
import { execFileSync as execFileSync4 } from "node:child_process";
import { existsSync as existsSync8, mkdirSync as mkdirSync3, readFileSync as readFileSync8, writeFileSync as writeFileSync4 } from "node:fs";
import { homedir as homedir3 } from "node:os";
import { join as join8 } from "node:path";

// src/core/pricing-bundle.ts
import { readFileSync as readFileSync7 } from "node:fs";
var cached = null;
function loadPricingBundle() {
  if (cached) return cached;
  const path = findReferenceFile("anthropic-pricing.json");
  cached = JSON.parse(readFileSync7(path, "utf8"));
  return cached;
}
function resolveBundledModel(bundle, nameOrAlias) {
  if (Object.hasOwn(bundle.models, nameOrAlias)) return nameOrAlias;
  const aliased = Object.hasOwn(bundle.aliases, nameOrAlias) ? bundle.aliases[nameOrAlias] : void 0;
  if (aliased && Object.hasOwn(bundle.models, aliased)) return aliased;
  return null;
}

// src/cli/cmd-pricing.ts
function runPricing(home, args, json) {
  const [verb, ...rest] = args;
  const config = loadConfig(home);
  if (verb === "import") {
    return runPricingImport(home, config, rest, json);
  }
  if (verb === "show" || verb === void 0) {
    const seenModels = [
      ...new Set(
        authoritative(readEvents(home, "usage")).filter((u) => u.kind === "usage").map((u) => u.model)
      )
    ];
    const missing = unpricedModels(config.pricing, seenModels);
    if (json) {
      process.stdout.write(
        JSON.stringify({ data: { ...config.pricing, unpriced_models: missing } }, null, 2) + "\n"
      );
    } else if (config.pricing.version === null || Object.keys(config.pricing.models).length === 0) {
      process.stdout.write(
        "No pricing configured \u2014 tokens stay the native unit (by design).\nFastest path: waybill pricing import  (bundled Anthropic list rates)\nTo label a different USD basis:\n  waybill pricing set <model-id> --version <YYYY-MM-DD> \\\n    --input <usd/mtok> --output <usd/mtok> --cache-read <usd/mtok> \\\n    --cache-5m <usd/mtok> --cache-1h <usd/mtok>\nRates come from your provider's price list; cite the date as the version.\n"
      );
    } else {
      process.stdout.write(`pricing_version: ${config.pricing.version}
`);
      for (const [model2, r] of Object.entries(config.pricing.models).sort()) {
        process.stdout.write(
          `  ${model2}: in ${r.input_per_mtok} \xB7 out ${r.output_per_mtok} \xB7 cache-read ${r.cache_read_per_mtok} \xB7 5m ${r.cache_write_5m_per_mtok} \xB7 1h ${r.cache_write_1h_per_mtok}  (USD/mtok)
`
        );
      }
      process.stdout.write(
        "Dated model ids (\u2026-YYYYMMDD) resolve to their family rate automatically.\n"
      );
      if (missing.length > 0) {
        process.stdout.write(
          `Metered but UNPRICED (no resolvable rate): ${missing.join(", ")}
  Fix: waybill pricing set <model-id> ...  (or pricing import), then: waybill meter --all
`
        );
      }
      process.stdout.write("Re-meter to price existing events: waybill meter --all\n");
    }
    return 0;
  }
  if (verb !== "set") {
    process.stderr.write("waybill pricing: pass `show`, `import`, or `set <model-id> [rates]`\n");
    return 2;
  }
  const model = rest[0];
  if (!model || model.startsWith("--")) {
    process.stderr.write("waybill pricing set: pass the model id first\n");
    return 2;
  }
  const rates = {};
  let version = null;
  const FLAGS = {
    "--input": "input_per_mtok",
    "--output": "output_per_mtok",
    "--cache-read": "cache_read_per_mtok",
    "--cache-5m": "cache_write_5m_per_mtok",
    "--cache-1h": "cache_write_1h_per_mtok"
  };
  for (let i = 1; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--version") {
      version = rest[++i] ?? null;
      continue;
    }
    const field = FLAGS[a];
    if (!field) {
      process.stderr.write(`waybill pricing set: unknown option ${a}
`);
      return 2;
    }
    const v = Number(rest[++i]);
    if (!Number.isFinite(v) || v < 0) {
      process.stderr.write(`waybill pricing set: ${a} needs a non-negative number (USD per million tokens)
`);
      return 2;
    }
    rates[field] = v;
  }
  for (const field of Object.values(FLAGS)) {
    if (!(field in rates)) {
      process.stderr.write(
        "waybill pricing set: all five rates are required (--input --output --cache-read --cache-5m --cache-1h) \u2014 no rate is ever guessed\n"
      );
      return 2;
    }
  }
  const effectiveVersion = version ?? config.pricing.version;
  if (!effectiveVersion) {
    process.stderr.write(
      "waybill pricing set: pass --version <YYYY-MM-DD> (the price-list date \u2014 it labels every derived USD figure)\n"
    );
    return 2;
  }
  config.pricing.version = effectiveVersion;
  config.pricing.models[model] = {
    input_per_mtok: rates["input_per_mtok"],
    output_per_mtok: rates["output_per_mtok"],
    cache_read_per_mtok: rates["cache_read_per_mtok"],
    cache_write_5m_per_mtok: rates["cache_write_5m_per_mtok"],
    cache_write_1h_per_mtok: rates["cache_write_1h_per_mtok"]
  };
  saveConfig(home, config);
  if (json) {
    process.stdout.write(JSON.stringify({ data: config.pricing }, null, 2) + "\n");
  } else {
    process.stdout.write(
      `priced ${model} (version ${effectiveVersion}). Existing events re-price on the next meter run: waybill meter --all
`
    );
  }
  return 0;
}
function applyBundledPricing(config, requested) {
  const bundle = loadPricingBundle();
  const targets = requested && requested.length > 0 ? requested : Object.keys(bundle.models);
  const imported = [];
  const unknown = [];
  for (const t of targets) {
    const resolved = resolveBundledModel(bundle, t);
    if (!resolved) {
      unknown.push(t);
      continue;
    }
    config.pricing.models[resolved] = bundle.models[resolved];
    imported.push(resolved);
  }
  if (imported.length > 0) config.pricing.version = bundle.last_updated;
  return { imported, unknown, version: bundle.last_updated };
}
function runPricingImport(home, config, rest, json) {
  const requested = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--model") {
      const m = rest[++i];
      if (!m) {
        process.stderr.write("waybill pricing import: --model needs a value\n");
        return 2;
      }
      requested.push(m);
    } else {
      process.stderr.write(`waybill pricing import: unknown option ${a}
`);
      return 2;
    }
  }
  const result = applyBundledPricing(config, requested);
  if (result.imported.length === 0) {
    process.stderr.write(
      `waybill pricing import: no matching bundled model(s)${result.unknown.length > 0 ? `: ${result.unknown.join(", ")}` : ""}
`
    );
    return 2;
  }
  saveConfig(home, config);
  if (json) {
    process.stdout.write(JSON.stringify({ data: { ...result, pricing: config.pricing } }, null, 2) + "\n");
  } else {
    process.stdout.write(
      `imported ${result.imported.length} bundled model(s) (version ${result.version}): ${result.imported.join(", ")}
`
    );
    if (result.unknown.length > 0) {
      process.stderr.write(`not in the bundle, skipped: ${result.unknown.join(", ")}
`);
    }
    process.stdout.write(
      "Override any model's rate with: waybill pricing set <model-id> ...\nRe-meter to price existing events: waybill meter --all\n"
    );
  }
  return 0;
}

// src/cli/cmd-init.ts
var GITHUB_PAT_MESSAGE = "Export GITHUB_MCP_PAT in your shell profile. Create at https://github.com/settings/tokens with repo scope.";
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
  const readDays = (path) => {
    if (!existsSync8(path)) return null;
    try {
      const settings = JSON.parse(readFileSync8(path, "utf8"));
      return typeof settings["cleanupPeriodDays"] === "number" ? settings["cleanupPeriodDays"] : null;
    } catch {
      return null;
    }
  };
  days = readDays(claudeSettingsPath);
  if (claudeSettingsPath.endsWith("settings.json")) {
    const local = readDays(claudeSettingsPath.replace(/settings\.json$/, "settings.local.json"));
    if (local !== null) days = local;
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
  let claudeSettings = join8(homedir3(), ".claude", "settings.json");
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--claude-settings") claudeSettings = args[++i] ?? claudeSettings;
    else {
      process.stderr.write(`waybill init: unknown option ${a}
`);
      return 2;
    }
  }
  mkdirSync3(join8(home, "pending-sessions"), { recursive: true });
  mkdirSync3(join8(home, "rollups"), { recursive: true });
  const freshConfig = !existsSync8(join8(home, "config.json"));
  const config = freshConfig ? defaultConfig() : loadConfig(home);
  const cwdRepo = repoFromCwd(process.cwd());
  if (cwdRepo && !config.git.repos.includes(cwdRepo)) config.git.repos.push(cwdRepo);
  let pricing = null;
  if (Object.keys(config.pricing.models).length === 0) {
    try {
      pricing = applyBundledPricing(config);
    } catch {
    }
  }
  saveConfig(home, config);
  const identity = buildIdentity();
  saveIdentity(home, identity);
  if (!existsSync8(join8(home, ".git"))) {
    git(home, ["init", "-b", "main"]);
  }
  writeFileSync4(join8(home, ".gitignore"), "rollups/\npending-sessions/\nmeter_state.json\n", "utf8");
  writeFileSync4(join8(home, ".gitattributes"), "streams/**/*.jsonl merge=union\n", "utf8");
  try {
    git(home, ["add", "-A"]);
    git(home, ["commit", "-m", freshConfig ? "ledger: initialized" : "ledger: init refreshed"]);
  } catch {
  }
  const retention = checkRetention(claudeSettings);
  const githubPatSet = (process.env["GITHUB_MCP_PAT"] ?? "") !== "";
  let bundledPricingVersion = null;
  try {
    bundledPricingVersion = loadPricingBundle().last_updated;
  } catch {
  }
  const configured = [
    "ledger (git-backed, append-only)",
    identity.git_emails.length > 0 ? `identity (${identity.git_emails.join(", ")})` : null,
    config.git.repos.length > 0 ? `repo scope (${config.git.repos.join(", ")})` : null,
    pricing && pricing.imported.length > 0 ? `pricing (${pricing.imported.length} bundled Anthropic model(s), version ${pricing.version})` : config.pricing.version !== null ? `pricing (${config.pricing.version === bundledPricingVersion ? "bundled Anthropic rates" : "custom"}, version ${config.pricing.version}, ${Object.keys(config.pricing.models).length} model(s))` : null,
    retention.warning === null && retention.recommendation === null ? `transcript retention (${retention.effective})` : null,
    githubPatSet ? "GitHub MCP (GITHUB_MCP_PAT set)" : null
  ].filter((line) => line !== null);
  const needsAction = [
    identity.git_emails.length === 0 ? "no git user.email found \u2014 set one so sessions attribute to you" : null,
    retention.warning,
    retention.recommendation,
    // Never claim costs work when no rate can price anything.
    config.pricing.version === null || Object.keys(config.pricing.models).length === 0 ? "no pricing configured \u2014 costs stay tokens-only; run: waybill pricing import" : null,
    !githubPatSet ? GITHUB_PAT_MESSAGE : null
  ].filter((line) => line !== null);
  const result = {
    home,
    fresh: freshConfig,
    repos: config.git.repos,
    identity: { git_emails: identity.git_emails, github_login: identity.github_login },
    retention,
    pricing: pricing ?? { imported: [], unknown: [], version: config.pricing.version },
    github_mcp_pat_set: githubPatSet,
    configured,
    needs_action: needsAction
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
    if (pricing && pricing.imported.length > 0) {
      process.stdout.write(
        `Pricing: imported ${pricing.imported.length} bundled Anthropic model(s) (version ${pricing.version}). Override any rate with: waybill pricing set <model-id> ...
`
      );
      if (!freshConfig) {
        process.stdout.write(
          "Existing events re-price on the next meter run: waybill meter --all\n"
        );
      }
    }
    process.stdout.write("\nConfigured:\n");
    for (const line of configured) process.stdout.write(`  - ${line}
`);
    if (needsAction.length > 0) {
      process.stdout.write("Needs action:\n");
      for (const line of needsAction) process.stdout.write(`  - ${line}
`);
    }
  }
  return 0;
}

// src/cli/cmd-meter.ts
import { readFileSync as readFileSync10 } from "node:fs";

// src/meter/lock.ts
import { mkdirSync as mkdirSync4, readFileSync as readFileSync9, renameSync as renameSync2, rmSync, unlinkSync, writeFileSync as writeFileSync5 } from "node:fs";
import { join as join9 } from "node:path";
function lockPath(home) {
  return join9(home, "pending-sessions", ".miner.lock");
}
function acquireLock(home) {
  mkdirSync4(join9(home, "pending-sessions"), { recursive: true });
  const p = lockPath(home);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync5(p, String(process.pid), { flag: "wx" });
      return true;
    } catch {
      try {
        const pid = Number(readFileSync9(p, "utf8").trim());
        if (Number.isInteger(pid) && pid > 0) {
          process.kill(pid, 0);
          return false;
        }
      } catch (err) {
        if (err.code === "ENOENT") continue;
      }
      const claim = `${p}.reap.${process.pid}`;
      try {
        renameSync2(p, claim);
        unlinkSync(claim);
      } catch {
        return false;
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

// src/meter/otel.ts
var TYPE_MAP = {
  input: "input",
  output: "output",
  cacheRead: "cache_read",
  cacheCreation: "cache_creation"
};
function attr(point, key) {
  for (const a of point.attributes ?? []) {
    if (a.key === key) {
      const v = a.value?.stringValue ?? a.value?.intValue;
      if (v !== void 0) return String(v);
    }
  }
  return null;
}
function safeNano(v) {
  try {
    return BigInt(v ?? 0);
  } catch {
    return 0n;
  }
}
function parseOtelExport(raw) {
  const sessions = /* @__PURE__ */ new Map();
  const cumulative = /* @__PURE__ */ new Map();
  for (const lineText of raw.split("\n")) {
    if (lineText.trim() === "") continue;
    let line;
    try {
      line = JSON.parse(lineText);
    } catch {
      continue;
    }
    const resourceMetrics = line.resourceMetrics ?? [];
    for (const rm of resourceMetrics) {
      for (const sm of rm.scopeMetrics ?? []) {
        for (const metric of sm.metrics ?? []) {
          if (metric.name !== "claude_code.token.usage") continue;
          const isDelta = metric.sum?.aggregationTemporality === 1;
          for (const point of metric.sum?.dataPoints ?? []) {
            const sessionId = attr(point, "session.id");
            const model = attr(point, "model") ?? "unknown";
            const type = attr(point, "type");
            if (!sessionId || !type || !(type in TYPE_MAP)) continue;
            const count = Math.trunc(Number(point.asDouble ?? point.asInt ?? 0));
            if (!Number.isFinite(count) || count <= 0) continue;
            const agg = sessions.get(sessionId) ?? { models: /* @__PURE__ */ new Map(), lastNano: 0n };
            const tokens = agg.models.get(model) ?? { input: 0, output: 0, cache_read: 0, cache_creation: 0 };
            const nano = safeNano(point.timeUnixNano);
            if (isDelta) {
              tokens[TYPE_MAP[type]] += count;
            } else {
              const key = `${sessionId}|${model}|${type}`;
              const prior = cumulative.get(key);
              if (!prior || nano >= prior.nano) {
                cumulative.set(key, { value: count, nano });
                tokens[TYPE_MAP[type]] = count;
              }
            }
            agg.models.set(model, tokens);
            if (nano > agg.lastNano) agg.lastNano = nano;
            sessions.set(sessionId, agg);
          }
        }
      }
    }
  }
  return sessions;
}
function nanoToIso(nano) {
  const ms = Number(nano / 1000000n);
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}
function meterOtel(input) {
  const parsed = parseOtelExport(input.raw);
  const newUsage = [];
  const newSessions = [];
  const skipped = [];
  const transcriptSessions = new Set(
    authoritative(input.existingSessions).filter((s) => s.kind === "session" && s.source === "transcript").map((s) => s.session_id)
  );
  const existingIds = /* @__PURE__ */ new Set([
    ...input.existingUsage.map((e) => e.id),
    ...input.existingSessions.map((e) => e.id)
  ]);
  const priorOtelUsage = /* @__PURE__ */ new Map();
  for (const u of authoritative(input.existingUsage)) {
    if (u.kind === "usage" && u.source === "otel") {
      priorOtelUsage.set(`${u.session_id}|${u.model}`, u);
    }
  }
  const priorOtelReceipts = /* @__PURE__ */ new Map();
  for (const s of authoritative(input.existingSessions)) {
    if (s.kind === "session" && s.source === "otel") priorOtelReceipts.set(s.session_id, s);
  }
  const pins = authoritative(input.ledgerEvents).filter((e) => e.kind === "pin");
  const openEntries = selectOpenEntries(input.ledgerEvents);
  for (const [sessionId, agg] of [...parsed.entries()].sort()) {
    if (transcriptSessions.has(sessionId)) {
      skipped.push(sessionId);
      continue;
    }
    const ts = agg.lastNano > 0n ? nanoToIso(agg.lastNano) : "1970-01-01T00:00:00Z";
    const totals = { input: 0, output: 0, cache_read: 0, cache_creation: 0 };
    const models = [...agg.models.keys()].sort();
    const ctx = {
      sessionId,
      repo: null,
      branchKeyPattern: input.config.metering.branch_key_pattern,
      pins,
      openEntries,
      repoDefaults: input.config.metering.repo_defaults,
      evidence: [],
      projectKeys: input.config.tracker.project_keys
    };
    for (const model of models) {
      const t = agg.models.get(model);
      totals.input += t.input;
      totals.output += t.output;
      totals.cache_read += t.cache_read;
      totals.cache_creation += t.cache_creation;
      const syntheticTurn = {
        index: 0,
        promptId: null,
        branchAtStart: null,
        firstMessageId: null,
        lastMessageId: null,
        models: [],
        overhead: false,
        waste: { retried_commands: 0, repeated_reads: 0 }
      };
      const { attribution: attribution2 } = resolveTurn(syntheticTurn, ctx);
      const body = {
        ts,
        kind: "usage",
        schema_version: SCHEMA_VERSION,
        supersedes: null,
        session_id: sessionId,
        turn: { index: 0, first_message_id: "", last_message_id: "", prompt_id: null },
        repo: null,
        model,
        tokens: {
          ...t,
          cache_creation_5m: 0,
          cache_creation_1h: 0
        },
        cost_usd: priceTokens(input.config, model, {
          ...t,
          cache_creation_5m: 0,
          cache_creation_1h: 0
        }),
        attribution: attribution2,
        source: "otel",
        transcript_version: null,
        raw_extra: null
      };
      const prior = priorOtelUsage.get(`${sessionId}|${model}`);
      if (prior) {
        const asPrior = finalizeEvent("usage", { ...body, supersedes: prior.supersedes });
        if (asPrior.id === prior.id) continue;
        const event = finalizeEvent("usage", { ...body, supersedes: prior.id });
        if (!existingIds.has(event.id)) newUsage.push(event);
      } else {
        const event = finalizeEvent("usage", body);
        if (!existingIds.has(event.id)) newUsage.push(event);
      }
    }
    const receiptBody = {
      ts,
      kind: "session",
      schema_version: SCHEMA_VERSION,
      supersedes: null,
      session_id: sessionId,
      transcript_path: "",
      transcript_version: null,
      cwd: null,
      repo: null,
      branches: [],
      models,
      first_ts: ts,
      last_ts: ts,
      turns: 1,
      messages: 0,
      totals,
      source: "otel"
    };
    const priorReceipt = priorOtelReceipts.get(sessionId);
    if (priorReceipt) {
      const asPrior = finalizeEvent("sessions", {
        ...receiptBody,
        supersedes: priorReceipt.supersedes
      });
      if (asPrior.id !== priorReceipt.id) {
        const receipt = finalizeEvent("sessions", {
          ...receiptBody,
          supersedes: priorReceipt.id
        });
        if (!existingIds.has(receipt.id)) newSessions.push(receipt);
      }
    } else {
      const receipt = finalizeEvent("sessions", receiptBody);
      if (!existingIds.has(receipt.id)) newSessions.push(receipt);
    }
  }
  return { newUsage, newSessions, skipped_transcript_sessions: skipped };
}

// src/cli/cmd-meter.ts
async function runMeter(home, args, json) {
  let transcript = null;
  let otel = null;
  let repo = null;
  let all = false;
  let force = false;
  let projectsDir = defaultProjectsDir();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--transcript") transcript = args[++i] ?? null;
    else if (a === "--otel") otel = args[++i] ?? null;
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
  if (!all && !transcript && !otel) {
    process.stderr.write("waybill meter: pass --transcript <path>, --otel <export.jsonl>, or --all\n");
    return 2;
  }
  if (loadConfig(home).metering.enabled === false) {
    process.stdout.write(
      json ? JSON.stringify({ paused: true, results: [], failures: 0 }) + "\n" : "metering: PAUSED (config.metering.enabled = false) \u2014 nothing metered\n"
    );
    return 0;
  }
  if (otel) {
    if (!await acquireLockWait(home)) {
      process.stderr.write("waybill meter: another metering process is running; try again shortly\n");
      return 1;
    }
    try {
      const out = meterOtel({
        raw: readFileSync10(otel, "utf8"),
        config: loadConfig(home),
        ledgerEvents: readEvents(home, "ledger"),
        existingUsage: readEvents(home, "usage"),
        existingSessions: readEvents(home, "sessions"),
        existingExceptions: readEvents(home, "exceptions")
      });
      appendEvents(home, "usage", out.newUsage);
      appendEvents(home, "sessions", out.newSessions);
      if (json) {
        process.stdout.write(
          JSON.stringify(
            {
              usage: out.newUsage.length,
              sessions: out.newSessions.length,
              skipped_transcript_sessions: out.skipped_transcript_sessions
            },
            null,
            2
          ) + "\n"
        );
      } else {
        process.stdout.write(
          `otel: +${out.newUsage.length} usage event(s) across ${out.newSessions.length} session(s)` + (out.skipped_transcript_sessions.length > 0 ? ` (${out.skipped_transcript_sessions.length} session(s) skipped \u2014 transcript is the source of truth)` : "") + "\n"
        );
      }
      return 0;
    } finally {
      releaseLock(home);
    }
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
import { existsSync as existsSync9, mkdirSync as mkdirSync5, readFileSync as readFileSync11, readdirSync as readdirSync3, writeFileSync as writeFileSync6 } from "node:fs";
import { join as join10 } from "node:path";
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
function runMine(home, args, json) {
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
  if (loadConfig(home).metering.enabled === false) {
    process.stdout.write(
      json ? JSON.stringify({ paused: true, mined_new: 0, remetered: 0, gaps: 0, already_current: 0 }) + "\n" : "metering: PAUSED (config.metering.enabled = false) \u2014 nothing metered\n"
    );
    return 0;
  }
  const queueDir = join10(home, "pending-sessions");
  mkdirSync5(queueDir, { recursive: true });
  if (!acquireLock(home)) {
    process.stdout.write(
      json ? JSON.stringify({ locked: true, mined_new: 0, remetered: 0, gaps: 0, already_current: 0 }) + "\n" : "mined: 0 new (another metering process is running \u2014 queue intact)\n"
    );
    return 0;
  }
  let minedNew = 0;
  let remetered = 0;
  let gaps = 0;
  let alreadyCurrent = 0;
  try {
    const files = readdirSync3(queueDir).filter((f) => f.endsWith(".json")).sort();
    for (const f of files) {
      const path = join10(queueDir, f);
      let capture;
      try {
        capture = JSON.parse(readFileSync11(path, "utf8"));
      } catch {
        continue;
      }
      if (capture.mined === true || typeof capture.mined === "string") continue;
      const transcript = capture.transcript_path;
      if (typeof transcript !== "string" || !existsSync9(transcript)) {
        if (typeof capture.session_id === "string") {
          recordGap(home, capture.session_id, gapTs(capture), "transcript_pruned");
        }
        gaps += 1;
        capture.mined = "gap";
        writeFileSync6(path, JSON.stringify(capture) + "\n", "utf8");
        continue;
      }
      try {
        const result = meterFile(home, transcript, typeof capture.repo === "string" ? capture.repo : null);
        capture.mined = true;
        capture["mined_session_id"] = result.session_id;
        capture["mined_usage_events"] = result.usage;
        writeFileSync6(path, JSON.stringify(capture) + "\n", "utf8");
        if (result.skipped) alreadyCurrent += 1;
        else if (result.remetered) remetered += 1;
        else minedNew += 1;
      } catch (err) {
        process.stderr.write(`waybill mine: ${transcript}: ${err.message}
`);
      }
    }
    if (all) {
      for (const t of listTranscripts(projectsDir)) {
        try {
          const r = meterFile(home, t, null);
          if (r.skipped) alreadyCurrent += 1;
          else if (r.remetered) remetered += 1;
          else minedNew += 1;
        } catch (err) {
          process.stderr.write(`waybill mine: ${t}: ${err.message}
`);
        }
      }
    }
  } finally {
    releaseLock(home);
  }
  if (minedNew + remetered > 0) {
    commitLedger(home);
    refreshDashboardIfPresent(home);
  }
  if (json) {
    process.stdout.write(
      JSON.stringify({
        mined_new: minedNew,
        remetered,
        gaps,
        already_current: alreadyCurrent
      }) + "\n"
    );
    return 0;
  }
  process.stdout.write(
    `mined: ${minedNew} new \xB7 ${remetered} re-metered (inputs changed) \xB7 ${gaps} gap(s) \xB7 ${alreadyCurrent} already current
`
  );
  return 0;
}

// src/cli/cmd-export.ts
import { join as join12 } from "node:path";

// src/report/redaction.ts
var SESSION_KEYS = /* @__PURE__ */ new Set(["session_id", "transcript_path", "cwd", "sessions"]);
var EXTERNAL_DROP = /* @__PURE__ */ new Set(["title", "prs", "url", "urls", "deploy", "notes", "branches"]);
function collectStrings(value, field, into) {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, field, into);
    return;
  }
  for (const [k, v] of Object.entries(value)) {
    if (k === field && typeof v === "string") into.add(v);
    else if (k === `${field}s` && Array.isArray(v)) {
      for (const item of v) if (typeof item === "string") into.add(item);
    } else collectStrings(v, field, into);
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

// src/cli/cmd-pack.ts
import { copyFileSync, existsSync as existsSync10, mkdirSync as mkdirSync6, readFileSync as readFileSync12, readdirSync as readdirSync4, writeFileSync as writeFileSync7 } from "node:fs";
import { join as join11 } from "node:path";
function readRawLines(home, stream) {
  const out = [];
  for (const shard of listShards(home, stream)) {
    for (const raw of readFileSync12(shardPath(home, stream, shard), "utf8").split("\n")) {
      if (raw.trim() === "") continue;
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
      out.push({ raw, parsed, shard });
    }
  }
  return out;
}
function engineBundlePath() {
  const argv1 = process.argv[1] ?? "";
  if (argv1.endsWith("waybill.mjs") && existsSync10(argv1)) return argv1;
  let dir = import.meta.dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = join11(dir, "bin", "waybill.mjs");
    if (existsSync10(candidate)) return candidate;
    dir = join11(dir, "..");
  }
  return null;
}
function buildPack(home, outDir, window, nowIso2) {
  const empty = {
    out_dir: outDir,
    sessions: 0,
    events: { ledger: 0, usage: 0, sessions: 0, exceptions: 0 },
    total_tokens: 0,
    engine_included: false,
    config_included: false
  };
  const findings = verifyHome(home);
  if (findings.length > 0) {
    return {
      result: empty,
      error: `refusing to pack an unverified ledger: ${findings.length} finding(s) \u2014 run: waybill verify`
    };
  }
  if (existsSync10(outDir) && readdirSync4(outDir).length > 0) {
    return { result: empty, error: `output directory is not empty: ${outDir} \u2014 pass --out <dir>` };
  }
  const usageLines = readRawLines(home, "usage");
  const included = /* @__PURE__ */ new Set();
  for (const l of usageLines) {
    const ts = l.parsed?.["ts"];
    const sid = l.parsed?.["session_id"];
    if (typeof ts === "string" && typeof sid === "string" && inWindow(ts, window.from, window.to)) {
      included.add(sid);
    }
  }
  const keep = {
    ledger: readRawLines(home, "ledger"),
    usage: usageLines.filter((l) => included.has(String(l.parsed?.["session_id"]))),
    sessions: readRawLines(home, "sessions").filter((l) => included.has(String(l.parsed?.["session_id"]))),
    exceptions: []
  };
  const exceptionLines = readRawLines(home, "exceptions");
  const includedAmbiguities = /* @__PURE__ */ new Set();
  for (const l of exceptionLines) {
    if (l.parsed?.["kind"] === "ambiguity" && included.has(String(l.parsed?.["session_id"]))) {
      includedAmbiguities.add(String(l.parsed?.["id"]));
    }
  }
  keep.exceptions = exceptionLines.filter((l) => {
    if (l.parsed?.["kind"] === "resolution") return includedAmbiguities.has(String(l.parsed?.["resolves"]));
    return included.has(String(l.parsed?.["session_id"]));
  });
  const packUsage = keep.usage.map((l) => l.parsed).filter((u) => u !== null);
  const totalTokens5 = authoritative(packUsage).filter((u) => u.kind === "usage").reduce((n, u) => n + u.tokens.input + u.tokens.output + u.tokens.cache_read + u.tokens.cache_creation, 0);
  mkdirSync6(outDir, { recursive: true });
  const files = {};
  const writePackFile = (rel, content) => {
    const p = join11(outDir, rel);
    mkdirSync6(join11(p, ".."), { recursive: true });
    writeFileSync7(p, content, "utf8");
    files[rel] = sha256Hex(content);
  };
  for (const stream of ["ledger", "usage", "sessions", "exceptions"]) {
    const byShard = /* @__PURE__ */ new Map();
    for (const l of keep[stream]) {
      const bucket = byShard.get(l.shard) ?? [];
      bucket.push(l.raw);
      byShard.set(l.shard, bucket);
    }
    for (const [shard, lines] of [...byShard.entries()].sort()) {
      writePackFile(join11("streams", stream, `${shard}.jsonl`), lines.join("\n") + "\n");
    }
  }
  let configIncluded = false;
  const configPath2 = join11(home, "config.json");
  if (existsSync10(configPath2)) {
    writePackFile("config.json", readFileSync12(configPath2, "utf8"));
    configIncluded = true;
  }
  let engineIncluded = false;
  const engine = engineBundlePath();
  if (engine !== null) {
    copyFileSync(engine, join11(outDir, "waybill.mjs"));
    files["waybill.mjs"] = sha256Hex(readFileSync12(join11(outDir, "waybill.mjs"), "utf8"));
    engineIncluded = true;
  }
  const result = {
    out_dir: outDir,
    sessions: included.size,
    events: {
      ledger: keep.ledger.length,
      usage: keep.usage.length,
      sessions: keep.sessions.length,
      exceptions: keep.exceptions.length
    },
    total_tokens: totalTokens5,
    engine_included: engineIncluded,
    config_included: configIncluded
  };
  writePackFile("README.md", packReadme(result, window, nowIso2));
  writeFileSync7(
    join11(outDir, "pack.json"),
    JSON.stringify(
      {
        kind: "waybill-verification-pack",
        pack_version: 1,
        engine_version: ENGINE_VERSION,
        generated_at: nowIso2,
        window,
        sessions: result.sessions,
        events: result.events,
        total_tokens: result.total_tokens,
        engine_included: engineIncluded,
        config_included: configIncluded,
        verify_at_pack_time: "green",
        files
      },
      null,
      2
    ) + "\n",
    "utf8"
  );
  return { result, error: null };
}
function packReadme(result, window, nowIso2) {
  const windowLine = window.from === null && window.to === null ? "all recorded history" : `${window.from ?? "(start)"} \u2192 ${window.to ?? "(now)"}`;
  const verifyCmd = result.engine_included ? "node waybill.mjs verify --home ." : "node <path-to-waybill.mjs> verify --home .  (engine: github.com/jakeintech/waybill, bin/waybill.mjs)";
  return `# Waybill verification pack

Generated ${nowIso2} \xB7 window: ${windowLine} \xB7 ${result.sessions} session(s), ${result.total_tokens.toLocaleString("en-US")} tokens.

This directory accompanies a report or token pitch. It contains the actual
event lines behind the numbers \u2014 not a rendering of them \u2014 so you can check
the claims yourself, offline, with one command:

\`\`\`
${verifyCmd}
\`\`\`

That re-runs, against the included events (Node 20+, no network, no install):

- **Id determinism** \u2014 every event id recomputes from its content
  (SHA-256); an edited line no longer matches its id.
- **Escrow seals** \u2014 pre-registered estimates are hash-sealed at logging
  time; a backdated or altered estimate fails the seal.
- **Conservation** \u2014 per session, the sum of per-turn usage events equals
  the session receipt's totals. Sessions are included whole (every usage
  event, even outside the window) so this check is meaningful.
- **Supersession integrity** \u2014 corrections form unforked chains; nothing
  is silently edited or double-counted.

Then read the numbers the same way the sender did:

\`\`\`
${result.engine_included ? "node waybill.mjs" : "node <path-to-waybill.mjs>"} query spend --home .
${result.engine_included ? "node waybill.mjs" : "node <path-to-waybill.mjs>"} query report --home .
\`\`\`

Contents: \`streams/\` (verbatim ledger, usage, session-receipt, and
exception events)${result.config_included ? ", `config.json` (the sender's rate table, so cost figures reproduce)" : ""}${result.engine_included ? ", `waybill.mjs` (the engine \u2014 a single dependency-free bundle)" : ""},
and \`pack.json\` (metadata + SHA-256 of every file here).

Note: pack contents are **verbatim and unredacted** (tracker keys, titles,
repos) \u2014 redaction would break the id checks above. Treat the pack at the
same sensitivity as the internal report it accompanies.
`;
}

// src/cli/cmd-export.ts
function csvCell(v) {
  const s = v === null || v === void 0 ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}
function runExport(home, args, json) {
  let format = json ? "json" : "csv";
  let from = null;
  let to = null;
  let audience = null;
  let pack = false;
  let out = null;
  let now = null;
  let formatSet = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--pack") {
      pack = true;
    } else if (a === "--out" || a === "--now") {
      const v = args[++i];
      if (v === void 0) {
        process.stderr.write(`waybill export: ${a} needs a value
`);
        return 2;
      }
      if (a === "--out") out = v;
      else now = v;
    } else if (a === "--format") {
      const v = args[++i];
      if (v !== "csv" && v !== "json") {
        process.stderr.write("waybill export: --format must be csv or json\n");
        return 2;
      }
      if (json && v === "csv") {
        process.stderr.write("waybill export: --json conflicts with --format csv \u2014 pick one\n");
        return 2;
      }
      format = v;
      formatSet = true;
    } else if (a === "--from" || a === "--to") {
      const v = args[++i];
      if (v === void 0) {
        process.stderr.write(`waybill export: ${a} needs a value
`);
        return 2;
      }
      if (a === "--from") from = v;
      else to = v;
    } else if (a === "--audience") {
      const v = args[++i];
      if (v !== "self" && v !== "internal" && v !== "external") {
        process.stderr.write("waybill export: --audience must be self, internal, or external\n");
        return 2;
      }
      audience = v;
    } else {
      process.stderr.write(`waybill export: unknown option ${a}
`);
      return 2;
    }
  }
  const config = loadConfig(home);
  let window;
  try {
    window = normalizeWindow(from, to);
  } catch (err) {
    process.stderr.write(`waybill export: ${err.message}
`);
    return 2;
  }
  if (pack) {
    if (formatSet) {
      process.stderr.write("waybill export: --pack writes a directory \u2014 --format applies to csv/json exports only\n");
      return 2;
    }
    if (audience !== null) {
      process.stderr.write(
        "waybill export: --pack cannot be redacted (--audience) \u2014 verbatim events are what the recipient verifies; share the redacted report instead\n"
      );
      return 2;
    }
    if (now !== null && Number.isNaN(Date.parse(now))) {
      process.stderr.write(`waybill export: --now is not a date: ${now}
`);
      return 2;
    }
    const nowIso2 = now ?? (/* @__PURE__ */ new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
    const outDir = out ?? join12(home, "rollups", "verification-pack");
    const { result, error } = buildPack(home, outDir, window, nowIso2);
    if (error !== null) {
      process.stderr.write(`waybill export: ${error}
`);
      return 1;
    }
    if (json) {
      process.stdout.write(JSON.stringify({ data: result }, null, 2) + "\n");
    } else {
      const events = result.events.ledger + result.events.usage + result.events.sessions + result.events.exceptions;
      process.stdout.write(
        `verification pack: ${result.out_dir}
${result.sessions} session(s), ${events} event lines, ${result.total_tokens.toLocaleString("en-US")} tokens \u2014 verified green at pack time.
Recipient check: node waybill.mjs verify --home .
`
      );
    }
    return 0;
  }
  if (out !== null || now !== null) {
    process.stderr.write("waybill export: --out/--now apply to --pack only\n");
    return 2;
  }
  const spend = spendData(
    readEvents(home, "usage"),
    readEvents(home, "exceptions"),
    readEvents(home, "ledger"),
    config,
    window
  );
  const aud = audience ?? config.audience_default;
  const { data } = redact(spend, aud);
  const redacted = data;
  if (format === "json") {
    process.stdout.write(JSON.stringify({ audience: aud, data: redacted }, null, 2) + "\n");
    return 0;
  }
  const header = [
    "account",
    "tokens",
    "input",
    "output",
    "cache_read",
    "cache_creation",
    "cost_usd",
    "min_confidence",
    "resolvers",
    "sessions",
    "waste_retried_commands",
    "waste_repeated_reads"
  ];
  const lines = [header.join(",")];
  for (const a of redacted.accounts) {
    lines.push(
      [
        a.account,
        a.tokens,
        a.input,
        a.output,
        a.cache_read,
        a.cache_creation,
        a.cost_usd ?? "",
        a.min_confidence,
        a.resolvers.join("|"),
        a.sessions,
        a.waste.retried_commands,
        a.waste.repeated_reads
      ].map(csvCell).join(",")
    );
  }
  process.stdout.write(lines.join("\n") + "\n");
  return 0;
}

// src/cli/cmd-pace.ts
import { existsSync as existsSync11, mkdirSync as mkdirSync7, readFileSync as readFileSync13, writeFileSync as writeFileSync8 } from "node:fs";
import { join as join13 } from "node:path";

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
  if (Number.isNaN(from)) {
    return { from: "1970-01-01T00:00:00Z", to: "1970-04-01T00:00:00Z" };
  }
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
      biggest_open_spend: null,
      days_to_renewal: null
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
  const byId = new Map(ledgerEvents.map((e) => [e.id, e]));
  const originTs = (e) => {
    let cur = e;
    const seen = /* @__PURE__ */ new Set();
    let ts = e.ts;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      ts = cur.ts;
      cur = cur.supersedes !== null ? byId.get(cur.supersedes) : void 0;
    }
    return ts;
  };
  const committed = auth.filter((e) => {
    if (e.points === null) return false;
    const origin = originTs(e);
    return origin >= window.from && origin <= window.to;
  }).reduce((n, e) => n + (e.points ?? 0), 0);
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
    biggest_open_spend: spend.open_spend[0] ?? null,
    days_to_renewal: Math.floor((Date.parse(window.to) - Date.parse(nowIso2)) / 864e5)
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
  return join13(home, "rollups", "pace-state.json");
}
function loadPaceState(home) {
  const p = stateFile(home);
  if (!existsSync11(p)) return null;
  try {
    return JSON.parse(readFileSync13(p, "utf8"));
  } catch {
    return null;
  }
}
function firstRunFile(home) {
  return join13(home, "rollups", "first-run.json");
}
function loadFirstRun(home) {
  const p = firstRunFile(home);
  if (!existsSync11(p)) return {};
  try {
    return JSON.parse(readFileSync13(p, "utf8"));
  } catch {
    return {};
  }
}
function saveFirstRun(home, state) {
  mkdirSync7(join13(home, "rollups"), { recursive: true });
  writeFileSync8(firstRunFile(home), JSON.stringify(state) + "\n", "utf8");
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
  if (Number.isNaN(Date.parse(nowIso2))) {
    process.stderr.write(`waybill pace: --now is not a date: ${nowIso2}
`);
    return 2;
  }
  const config = loadConfig(home);
  const ledger = readEvents(home, "ledger");
  const usage = readEvents(home, "usage");
  const exceptions = readEvents(home, "exceptions");
  const pace = paceData(ledger, usage, exceptions, config, nowIso2);
  if (notice) {
    const level = config.notices.level;
    if (level === "off") return 0;
    if (pace.allocation) {
      const prior = loadPaceState(home);
      const samePeriod = prior !== null && prior.period === pace.allocation.period;
      const already = samePeriod ? prior.notified_thresholds : [];
      const fresh = pace.thresholds_crossed.filter((t) => !already.includes(t));
      const reminderDays = config.budgets.renewal_reminder_days;
      const renewalDue = level === "normal" && pace.days_to_renewal !== null && pace.days_to_renewal >= 0 && pace.days_to_renewal <= reminderDays && !(samePeriod && prior.renewal_notified === true);
      const lines = [];
      if (fresh.length > 0) {
        const top = Math.max(...fresh);
        lines.push(
          `waybill: ${top}% of the ${pace.allocation.period} token grant is spent` + (pace.shipped_pct_of_committed !== null ? ` with ${pace.shipped_pct_of_committed}% of committed points shipped` : "") + (pace.biggest_open_spend ? `; biggest open spend: ${pace.biggest_open_spend.account}` : "") + ". Worth a look, not an alarm."
        );
      }
      if (renewalDue) {
        lines.push(
          `waybill: the ${pace.allocation.period} grant renews in ${pace.days_to_renewal} day(s) \u2014 a good moment to build the token pitch while the receipts are fresh.`
        );
      }
      if (lines.length > 0) {
        process.stdout.write(lines.join("\n") + "\n");
        mkdirSync7(join13(home, "rollups"), { recursive: true });
        writeFileSync8(
          stateFile(home),
          JSON.stringify({
            period: pace.allocation.period,
            notified_thresholds: [.../* @__PURE__ */ new Set([...already, ...fresh])].sort((a, b) => a - b),
            renewal_notified: samePeriod && prior.renewal_notified === true || renewalDue
          }) + "\n",
          "utf8"
        );
        return 0;
      }
    }
    if (level !== "normal") return 0;
    const firstRun = loadFirstRun(home);
    if (!existsSync11(configPath(home))) {
      if (firstRun.uninitialized_announced !== true) {
        process.stdout.write(
          'waybill: not initialized. Say "initialize my waybill ledger" \u2014 60s, no auth.\n'
        );
        saveFirstRun(home, { ...firstRun, uninitialized_announced: true });
      }
      return 0;
    }
    const sessionsMetered = Object.keys(loadState(home).sessions).length;
    const entriesLogged = ledger.filter((e) => e.kind !== "pin").length;
    if (sessionsMetered > 0 && entriesLogged === 0 && firstRun.unlogged_announced !== true) {
      process.stdout.write(
        `waybill: ${sessionsMetered} session(s) metered, nothing logged yet. Say "sync my ledger" for a receipt from your git history.
`
      );
      saveFirstRun(home, { ...firstRun, unlogged_announced: true });
    }
    return 0;
  }
  if (json) {
    process.stdout.write(JSON.stringify({ data: pace }, null, 2) + "\n");
  } else {
    process.stdout.write(renderPace(pace) + "\n");
  }
  return 0;
}

// src/cli/cmd-status.ts
import { existsSync as existsSync12, readFileSync as readFileSync14, readdirSync as readdirSync5, statSync as statSync2 } from "node:fs";
import { homedir as homedir4 } from "node:os";
import { join as join14 } from "node:path";
import { execFileSync as execFileSync6 } from "node:child_process";
function fmtInt2(n) {
  return n.toLocaleString("en-US");
}
function runStatus(home, args, json) {
  let claudeSettings = join14(homedir4(), ".claude", "settings.json");
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--claude-settings") claudeSettings = args[++i] ?? claudeSettings;
    else {
      process.stderr.write(`waybill status: unknown option ${a}
`);
      return 2;
    }
  }
  const initialized = existsSync12(join14(home, "config.json"));
  const config = loadConfig(home);
  const retention = checkRetention(claudeSettings);
  let pendingUnmined = 0;
  const queueDir = join14(home, "pending-sessions");
  if (existsSync12(queueDir)) {
    for (const f of readdirSync5(queueDir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const capture = JSON.parse(readFileSync14(join14(queueDir, f), "utf8"));
        if (capture.mined !== true && typeof capture.mined !== "string") pendingUnmined += 1;
      } catch {
        pendingUnmined += 1;
      }
    }
  }
  const ledger = readEvents(home, "ledger");
  const usage = readEvents(home, "usage");
  const exceptions = readEvents(home, "exceptions");
  const spend = spendData(usage, exceptions, ledger, config, { from: null, to: null });
  const manifest = manifestData(ledger, usage, config, (/* @__PURE__ */ new Date()).toISOString().replace(/\.\d{3}Z$/, "Z"));
  const state = loadState(home);
  const lastMine = Object.values(state.sessions).map((s) => s.metered_through_ts ?? "").filter((t) => t !== "").sort().pop() ?? null;
  const gaps = exceptions.filter((e) => e.kind === "meter_gap").length;
  const findings = verifyHome(home);
  const authUsage = authoritative(usage).filter((u) => u.kind === "usage");
  const seenModels = [...new Set(authUsage.map((u) => u.model))];
  const unpriced = unpricedModels(config.pricing, seenModels);
  const unpricedEvents = authUsage.filter((u) => u.cost_usd === null).length;
  const gapSessions = new Set(
    exceptions.filter((e) => e.kind === "meter_gap").map((e) => e.session_id)
  );
  const repriceable = authUsage.filter(
    (u) => u.cost_usd === null && u.model !== "unknown" && !gapSessions.has(u.session_id) && resolveRate(config.pricing, u.model) !== null
  ).length;
  const githubPatSet = (process.env["GITHUB_MCP_PAT"] ?? "") !== "";
  let ghCliAvailable = false;
  try {
    execFileSync6("gh", ["auth", "status"], { stdio: ["ignore", "ignore", "ignore"], timeout: 5e3 });
    ghCliAvailable = true;
  } catch {
  }
  let acliAuthenticated = null;
  if (config.tracker.kind === "jira") {
    acliAuthenticated = false;
    try {
      execFileSync6("acli", ["jira", "auth", "status"], { stdio: ["ignore", "ignore", "ignore"], timeout: 5e3 });
      acliAuthenticated = true;
    } catch {
    }
  }
  const git2 = (cwdArgs) => {
    try {
      return execFileSync6("git", ["-C", home, ...cwdArgs], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5e3
      }).trim();
    } catch {
      return null;
    }
  };
  const gitBacked = git2(["rev-parse", "--is-inside-work-tree"]) === "true";
  const upstream = gitBacked ? git2(["rev-parse", "--abbrev-ref", "@{upstream}"]) : null;
  let ahead = null;
  let behind = null;
  let fetchedAt = null;
  if (upstream !== null) {
    const counts = git2(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]);
    const m = counts !== null ? /^(\d+)\s+(\d+)$/.exec(counts) : null;
    if (m) {
      ahead = Number(m[1]);
      behind = Number(m[2]);
    }
    try {
      const gitDir = git2(["rev-parse", "--absolute-git-dir"]) ?? join14(home, ".git");
      fetchedAt = statSync2(join14(gitDir, "FETCH_HEAD")).mtime.toISOString().replace(/\.\d{3}Z$/, "Z");
    } catch {
      fetchedAt = null;
    }
  }
  const remote = { git_backed: gitBacked, upstream, ahead, behind, fetched_at: fetchedAt };
  const entriesLogged = ledger.filter((e) => e.kind !== "pin").length;
  const next = [];
  if (!initialized) {
    next.push('"initialize my waybill ledger" \u2014 60s, no auth');
  } else {
    if (spend.attribution_health.inbox_open > 0)
      next.push(`"resolve my attribution inbox" (${spend.attribution_health.inbox_open} open)`);
    if (pendingUnmined > 0) next.push(`"process my pending sessions" (${pendingUnmined} waiting)`);
    next.push(
      entriesLogged === 0 ? '"sync my ledger" \u2014 a receipt from your git history' : '"build my token pitch"'
    );
  }
  const data = {
    home,
    initialized,
    retention,
    mcp: {
      github_pat_set: githubPatSet,
      gh_cli_authenticated: ghCliAvailable,
      acli_jira_authenticated: acliAuthenticated
    },
    pricing: {
      version: config.pricing.version,
      models_priced: Object.keys(config.pricing.models).length,
      unpriced_models: unpriced,
      unpriced_events: unpricedEvents,
      repriceable_events: repriceable
    },
    metering: {
      enabled: config.metering.enabled,
      sessions_metered: Object.keys(state.sessions).length,
      last_metered_through: lastMine,
      pending_unmined: pendingUnmined,
      meter_gaps: gaps
    },
    spend: {
      total_tokens: spend.total_tokens,
      unattributed_pct: spend.unattributed_pct,
      attributed_pct_conf_060: spend.attribution_health.attributed_pct_conf_060,
      inbox_open: spend.attribution_health.inbox_open
    },
    manifest: {
      open_items: manifest.open_items.length,
      open_tokens: manifest.open_tokens,
      sitting: manifest.sitting,
      demurrage_days: manifest.demurrage_days
    },
    verify: { findings: findings.length, ok: findings.length === 0 },
    remote,
    next: next.slice(0, 2)
  };
  if (json) {
    process.stdout.write(JSON.stringify({ data }, null, 2) + "\n");
    return findings.length === 0 ? 0 : 1;
  }
  const lines = [];
  lines.push(`waybill status \u2014 ${home} (engine ${ENGINE_VERSION})`);
  lines.push(initialized ? "initialized: yes (git-backed, append-only)" : "initialized: NO \u2014 run: waybill init");
  lines.push(
    `retention: ${retention.effective}` + (retention.recommendation ? ` \u2014 recommend: ${retention.recommendation}` : "")
  );
  if (retention.warning) lines.push(`  WARNING: ${retention.warning}`);
  lines.push(
    (config.metering.enabled ? `metering: ${fmtInt2(data.metering.sessions_metered)} session(s) metered` : `metering: PAUSED (config.metering.enabled = false) \u2014 ${fmtInt2(data.metering.sessions_metered)} session(s) metered before the pause`) + (lastMine ? `, through ${lastMine}` : "") + (pendingUnmined > 0 ? `; ${pendingUnmined} capture(s) waiting \u2014 run: waybill mine --queue` : "") + (gaps > 0 ? `; ${gaps} gap(s) (transcripts pruned before mining)` : "")
  );
  lines.push(
    `spend: ${fmtInt2(spend.total_tokens)} tokens, ${spend.unattributed_pct}% unattributed (${spend.attribution_health.attributed_pct_conf_060}% attributed at conf \u2265 0.6)` + (spend.attribution_health.inbox_open > 0 ? `; ${spend.attribution_health.inbox_open} in the attribution inbox \u2014 see: waybill query inbox` : "")
  );
  if (manifest.sitting > 0) {
    lines.push(
      `manifest: ${manifest.open_items.length} open item(s), ${fmtInt2(manifest.open_tokens)} tokens open; ${manifest.sitting} sitting idle \u2265 ${manifest.demurrage_days}d \u2014 see: waybill query manifest`
    );
  }
  if (config.pricing.version === null || Object.keys(config.pricing.models).length === 0) {
    lines.push(
      "pricing: NOT CONFIGURED \u2014 costs stay tokens-only. Fix: waybill pricing import"
    );
  } else {
    lines.push(
      `pricing: version ${config.pricing.version}, ${Object.keys(config.pricing.models).length} model(s)` + (unpriced.length > 0 ? `; NO RATE for metered model(s): ${unpriced.join(", ")} \u2014 costs shown tokens-only. Fix: waybill pricing set <model-id> ... (then: waybill meter --all)` : "") + (repriceable > 0 ? `; ${fmtInt2(repriceable)} event(s) metered before their rate existed \u2014 re-price: waybill meter --all` : "")
    );
  }
  lines.push(
    findings.length === 0 ? "verify: all checks pass" : `verify: ${findings.length} finding(s) \u2014 run: waybill verify`
  );
  if (remote.upstream !== null) {
    lines.push(
      `remote: ${remote.upstream} \u2014 ` + (remote.ahead !== null && remote.behind !== null ? `${remote.ahead} ahead, ${remote.behind} behind` + (remote.fetched_at !== null ? ` (as of last fetch ${remote.fetched_at})` : " (never fetched here \u2014 counts are vs the last push)") : "counts unavailable") + (remote.behind !== null && remote.behind > 0 ? '. Pull before logging: git -C "$WAYBILL_HOME" pull' : "")
    );
  } else if (remote.git_backed) {
    lines.push(
      "remote: none \u2014 this ledger lives on this machine only. Multi-machine setup: docs/multi-machine.md"
    );
  }
  if (!githubPatSet) {
    lines.push(
      "mcp: GITHUB_MCP_PAT not set \u2014 the GitHub sync upgrade is inactive (everything else works)."
    );
    lines.push(
      ghCliAvailable ? '  You have an authenticated gh CLI \u2014 generate it from that:  export GITHUB_MCP_PAT="$(gh auth token)"' : "  Generate a fine-grained read-only PAT at https://github.com/settings/personal-access-tokens and:  export GITHUB_MCP_PAT=github_pat_\u2026"
    );
    lines.push("  (Atlassian needs no token \u2014 run /mcp in Claude Code and complete its OAuth.)");
  }
  if (config.tracker.kind === "jira") {
    lines.push(
      acliAuthenticated ? "tracker: acli (Atlassian CLI) authenticated \u2014 Jira syncs fetch through it (light payloads; the Atlassian MCP is not needed)." : "tracker: acli (Atlassian CLI) not detected \u2014 Jira syncs use the Atlassian MCP. Lighter: install acli (developer.atlassian.com/cloud/acli) and run: acli jira auth login --web"
    );
  }
  if (data.next.length > 0) lines.push(`next: ${data.next.join(" \xB7 ")}`);
  process.stdout.write(lines.join("\n") + "\n");
  return findings.length === 0 ? 0 : 1;
}

// src/projections/untracked.ts
function totalTokens4(t) {
  return t.input + t.output + t.cache_read + t.cache_creation;
}
function untrackedData(ledgerEvents, usageEvents, sessionEvents, config, window) {
  const ledgerKeys = new Set(
    authoritative(ledgerEvents).filter((e) => e.kind !== "pin").map((e) => e.tracker_key).filter((k) => k !== null)
  );
  const receiptBySession = /* @__PURE__ */ new Map();
  for (const s of authoritative(sessionEvents)) {
    if (s.kind === "session") receiptBySession.set(s.session_id, s);
  }
  const usage = authoritative(usageEvents).filter(
    (u) => u.kind === "usage" && inWindow(u.ts, window.from, window.to) && totalTokens4(u.tokens) > 0
  );
  const keyRe = new RegExp(config.metering.branch_key_pattern, "g");
  const clusters = /* @__PURE__ */ new Map();
  let windowTokens = 0;
  let untrackedTokens = 0;
  const add = (kind, label, repo, u, receipt) => {
    const id = `${kind}:${label}${repo !== null ? `@${repo}` : ""}`;
    const cluster = clusters.get(id) ?? {
      id,
      kind,
      label,
      repo,
      branches: [],
      keys_seen: [],
      sessions: [],
      tokens: 0,
      totals: { input: 0, output: 0, cache_read: 0, cache_creation: 0 },
      first_ts: u.ts,
      last_ts: u.ts
    };
    cluster.tokens += totalTokens4(u.tokens);
    cluster.totals.input += u.tokens.input;
    cluster.totals.output += u.tokens.output;
    cluster.totals.cache_read += u.tokens.cache_read;
    cluster.totals.cache_creation += u.tokens.cache_creation;
    if (u.ts < cluster.first_ts) cluster.first_ts = u.ts;
    if (u.ts > cluster.last_ts) cluster.last_ts = u.ts;
    if (receipt) {
      if (!cluster.sessions.some((s) => s.session_id === receipt.session_id)) {
        cluster.sessions.push({
          session_id: receipt.session_id,
          first_ts: receipt.first_ts,
          last_ts: receipt.last_ts,
          turns: receipt.turns
        });
      }
      for (const b of receipt.branches) {
        if (!cluster.branches.includes(b)) cluster.branches.push(b);
        for (const k of b.match(keyRe) ?? []) {
          if (isPlausibleTrackerKey(k, config.tracker.project_keys) && !cluster.keys_seen.includes(k)) {
            cluster.keys_seen.push(k);
          }
        }
      }
    } else if (!cluster.sessions.some((s) => s.session_id === u.session_id)) {
      cluster.sessions.push({ session_id: u.session_id, first_ts: u.ts, last_ts: u.ts, turns: 0 });
    }
    clusters.set(id, cluster);
  };
  for (const u of usage) {
    windowTokens += totalTokens4(u.tokens);
    const receipt = receiptBySession.get(u.session_id);
    const account = u.attribution.account;
    if (account.startsWith("story:")) {
      const key = account.slice(6);
      if (ledgerKeys.has(key)) continue;
      untrackedTokens += totalTokens4(u.tokens);
      add("story_key", key, u.repo ?? receipt?.repo ?? null, u, receipt);
      continue;
    }
    if (account.startsWith("adhoc:")) {
      untrackedTokens += totalTokens4(u.tokens);
      add("adhoc", account.slice(6), u.repo ?? receipt?.repo ?? null, u, receipt);
      continue;
    }
    untrackedTokens += totalTokens4(u.tokens);
    const repo = u.repo ?? receipt?.repo ?? null;
    const branch = receipt?.branches[0] ?? null;
    if (branch !== null) add("branch", branch, repo, u, receipt);
    else add("unattributed", repo ?? "(no repo)", repo, u, receipt);
  }
  const sorted = [...clusters.values()].map((c) => ({
    ...c,
    branches: [...c.branches].sort(),
    keys_seen: [...c.keys_seen].sort(),
    sessions: [...c.sessions].sort((a, b) => a.first_ts < b.first_ts ? -1 : 1)
  })).sort((a, b) => b.tokens - a.tokens || (a.id < b.id ? -1 : 1));
  return {
    window,
    clusters: sorted,
    untracked_tokens: untrackedTokens,
    window_tokens: windowTokens,
    untracked_pct: windowTokens > 0 ? Math.round(untrackedTokens / windowTokens * 1e3) / 10 : 0
  };
}

// src/cli/cmd-query.ts
var AUDIENCES = ["self", "internal", "external"];
var DETAILS = ["terse", "standard", "full"];
function runQuery(home, args) {
  const [what, ...rest] = args;
  let from = null;
  let to = null;
  let date = null;
  let days = null;
  let now = null;
  let audience = null;
  let detail = null;
  const positional = [];
  const need = (i, flag) => {
    const v = rest[i];
    if (v === void 0) {
      process.stderr.write(`waybill query: ${flag} needs a value
`);
      return null;
    }
    return v;
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--from") {
      if ((from = need(++i, a)) === null) return 2;
    } else if (a === "--to") {
      if ((to = need(++i, a)) === null) return 2;
    } else if (a === "--date") {
      if ((date = need(++i, a)) === null) return 2;
    } else if (a === "--days") {
      if ((days = need(++i, a)) === null) return 2;
    } else if (a === "--now") {
      if ((now = need(++i, a)) === null) return 2;
    } else if (a === "--audience") {
      const v = rest[++i];
      if (!v || !AUDIENCES.includes(v)) {
        process.stderr.write(`waybill query: --audience must be one of ${AUDIENCES.join(", ")}
`);
        return 2;
      }
      audience = v;
    } else if (a === "--detail") {
      const v = rest[++i];
      if (!v || !DETAILS.includes(v)) {
        process.stderr.write(`waybill query: --detail must be one of ${DETAILS.join(", ")}
`);
        return 2;
      }
      detail = v;
    } else if (a.startsWith("--")) {
      process.stderr.write(`waybill query: unknown option ${a}
`);
      return 2;
    } else positional.push(a);
  }
  if (what !== "standup" && (date !== null || days !== null)) {
    process.stderr.write("waybill query: --date/--days apply to `query standup` only\n");
    return 2;
  }
  if (now !== null && what !== "standup" && what !== "manifest") {
    process.stderr.write("waybill query: --now applies to `query standup` and `query manifest`\n");
    return 2;
  }
  if (now !== null && Number.isNaN(Date.parse(now))) {
    process.stderr.write(`waybill query: --now is not a date: ${now}
`);
    return 2;
  }
  const config = loadConfig(home);
  const aud = audience ?? config.audience_default;
  const det = detail ?? config.detail_default;
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
    case "manifest": {
      const nowIso2 = now ?? (/* @__PURE__ */ new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
      payload = manifestData(ledger, usage, config, nowIso2);
      break;
    }
    case "untracked": {
      const sessions = readEvents(home, "sessions");
      payload = untrackedData(ledger, usage, sessions, config, window);
      break;
    }
    case "standup": {
      let resolved;
      try {
        resolved = resolveStandupWindow(
          { date, days: days !== null ? Number(days) : null, from, to },
          now !== null ? new Date(now) : /* @__PURE__ */ new Date()
        );
      } catch (err) {
        process.stderr.write(`waybill query standup: ${err.message}
`);
        return 2;
      }
      const sessions = readEvents(home, "sessions");
      payload = standupData(ledger, usage, sessions, exceptions, config, resolved.window, resolved.label);
      break;
    }
    default:
      process.stderr.write(
        "waybill query: pass one of spend | report | forecast | story <KEY> | inbox | standup | untracked | manifest\n"
      );
      return 2;
  }
  const { data, mapping } = redact(payload, aud);
  const out = aud === "external" ? { audience: aud, detail: det, data, redaction_note: "identifiers pseudonymized; internal version available on request", mapping_size: Object.keys(mapping).length } : { audience: aud, detail: det, data };
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  return 0;
}

// src/cli/cmd-resolve.ts
import { execFileSync as execFileSync7 } from "node:child_process";
import { existsSync as existsSync13 } from "node:fs";
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
}
function commitLedger2(home, message) {
  try {
    execFileSync7("git", ["-C", home, "add", "-A"], { stdio: ["ignore", "ignore", "ignore"], timeout: 15e3 });
    execFileSync7("git", ["-C", home, "commit", "-m", message], {
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
  if (durablePin && repoDefault) {
    process.stderr.write(
      "waybill resolve: --pin and --repo-default are different durable choices \u2014 pass one, not both\n"
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
    const priorPins = authoritative(readEvents(home, "ledger")).filter(
      (e) => e.kind === "pin" && e.session_id === ambiguity.session_id && e.range === null
    ).sort((a, b) => a.ts < b.ts ? -1 : 1);
    const pinBody = {
      ts,
      kind: "pin",
      schema_version: SCHEMA_VERSION,
      supersedes: null,
      session_id: ambiguity.session_id,
      account,
      tracker_key: account.startsWith("story:") ? account.slice(6) : null,
      range: null,
      notes: `resolve: from inbox item ${ambiguityId}`
    };
    const pins = priorPins.length === 0 ? [finalizeEvent("ledger", pinBody)] : priorPins.map((prior) => finalizeEvent("ledger", { ...pinBody, supersedes: prior.id }));
    appendEvents(home, "ledger", pins);
  }
  if (repoDefault) {
    const config = loadConfig(home);
    config.metering.repo_defaults[repoDefault] = account;
    saveConfig(home, config);
  }
  let remetered = false;
  let corrected = 0;
  if (loadConfig(home).metering.enabled === false) {
    process.stderr.write(
      "waybill resolve: metering is paused \u2014 the resolution is recorded and applies automatically when metering is re-enabled and the session is next metered\n"
    );
    commitLedger2(home, `resolve: inbox item filed to ${account}`);
    const openNow = countOpenAmbiguities(readEvents(home, "exceptions"));
    if (json) {
      process.stdout.write(
        JSON.stringify({ resolved: ambiguityId, account, durable, remetered: false, corrected_events: 0, inbox_open: openNow, paused: true }) + "\n"
      );
    } else {
      process.stdout.write(`filed to ${account} (metering paused \u2014 applies on re-enable); ${openNow} left in the inbox
`);
    }
    return 0;
  }
  const checkpoint = loadState(home).sessions[ambiguity.session_id];
  const transcriptPath = checkpoint?.transcript_path ?? authoritative(readEvents(home, "sessions")).find((s) => s.kind === "session" && s.session_id === ambiguity.session_id)?.transcript_path ?? null;
  if (transcriptPath && existsSync13(transcriptPath)) {
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
        "waybill resolve: a miner is running \u2014 the resolution is recorded and will apply the next time this session is metered (run `waybill meter --all` shortly, or it applies automatically when the transcript next grows)\n"
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
import { execFileSync as execFileSync8 } from "node:child_process";
import { readFileSync as readFileSync15 } from "node:fs";

// src/adapters/contract.ts
function defaultContext(partial = {}) {
  return {
    keyPattern: "[A-Z][A-Z0-9]+-[0-9]+",
    identityEmails: [],
    githubLogin: null,
    jiraAccountId: null,
    gitlabUsername: null,
    linearUserId: null,
    projectKeys: [],
    pointsFields: ["customfield_10016", "customfield_10026", "customfield_10002"],
    sprintFields: ["customfield_10020", "customfield_10010"],
    ...partial
  };
}
var CLOSING_RE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+((?:[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+)?#[0-9]+)/gi;
function extractCloses(text, repo) {
  const out = [];
  for (const m of text.matchAll(CLOSING_RE)) {
    const ref = m[1];
    const full = ref.startsWith("#") ? `${repo}${ref}` : ref;
    if (!out.includes(full)) out.push(full);
  }
  return out;
}
function extractKeys(text, keyPattern, projectKeys = []) {
  const out = [];
  for (const k of text.match(new RegExp(keyPattern, "g")) ?? []) {
    if (!isPlausibleTrackerKey(k, projectKeys)) continue;
    if (!out.includes(k)) out.push(k);
  }
  return out;
}
function sortItems(items) {
  return [...items].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}
function sortChanges(changes) {
  return [...changes].sort(
    (a, b) => (a.merged_at < b.merged_at ? -1 : a.merged_at > b.merged_at ? 1 : 0) || ((a.url ?? "") < (b.url ?? "") ? -1 : (a.url ?? "") > (b.url ?? "") ? 1 : 0)
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

// src/adapters/linear.ts
function str2(v) {
  return typeof v === "string" && v !== "" ? v : null;
}
function workTypeFromLabels(issue) {
  const labels = (issue.labels?.nodes ?? []).map((l) => (l.name ?? "").toLowerCase()).filter((n) => n !== "");
  if (labels.includes("bug")) return "bug";
  if (labels.includes("refactor")) return "refactor";
  if (labels.includes("docs") || labels.includes("documentation")) return "docs";
  if (labels.includes("research") || labels.includes("spike")) return "research";
  if (labels.includes("incident")) return "incident";
  return "feature";
}
var linearAdapter = {
  kind: "linear",
  normalizeItems(raw, ctx) {
    const root = raw;
    const nodes = Array.isArray(raw) ? raw : root.data?.issues?.nodes ?? root.issues?.nodes ?? root.nodes ?? [];
    const keyRe = new RegExp(`^(?:${ctx.keyPattern})$`);
    const out = [];
    for (const issue of nodes) {
      const key = str2(issue.identifier);
      if (!key || !keyRe.test(key)) continue;
      const assignee = str2(issue.assignee?.id);
      if (ctx.linearUserId && assignee && assignee !== ctx.linearUserId) continue;
      const stateType = str2(issue.state?.type);
      if (stateType === "canceled") continue;
      const completedAt = str2(issue.completedAt);
      const done = stateType === "completed" || completedAt !== null;
      const cycle = issue.cycle ?? null;
      const sprint = str2(cycle?.name) ?? (typeof cycle?.number === "number" ? `cycle-${cycle.number}` : null);
      out.push({
        key,
        title: str2(issue.title) ?? key,
        points: typeof issue.estimate === "number" && Number.isFinite(issue.estimate) ? issue.estimate : null,
        epic_key: null,
        epic_name: str2(issue.project?.name),
        sprint,
        status: str2(issue.state?.name) ?? "unknown",
        done,
        resolved_at: completedAt,
        created_at: str2(issue.createdAt),
        updated_at: str2(issue.updatedAt),
        work_type: workTypeFromLabels(issue),
        url: str2(issue.url)
      });
    }
    return sortItems(out);
  }
};

// src/adapters/github.ts
function str3(v) {
  return typeof v === "string" && v !== "" ? v : null;
}
function repoOf(pr) {
  const full = str3(pr.base?.repo?.full_name) ?? str3(pr.repository?.full_name);
  if (full) return full;
  const repoUrl = str3(pr.repository_url);
  if (repoUrl) {
    const m = /repos\/([^/]+\/[^/]+)$/.exec(repoUrl);
    if (m) return m[1];
  }
  const html = str3(pr.html_url) ?? str3(pr.url);
  if (html) {
    const m = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/\d+/.exec(html);
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
      const mergedAt = str3(pr.merged_at) ?? str3(pr.pull_request?.merged_at) ?? str3(pr.mergedAt);
      const url = str3(pr.html_url) ?? str3(pr.url);
      const repo = repoOf(pr);
      if (!mergedAt || !url || !repo) continue;
      if (!/\/pull\/\d+$/.test(url)) continue;
      const author = str3(pr.user?.login) ?? str3(pr.author?.login);
      if (ctx.githubLogin && author && author !== ctx.githubLogin) continue;
      const title = str3(pr.title) ?? url;
      const branch = str3(pr.head?.ref) ?? str3(pr.headRefName);
      out.push({
        url,
        title,
        repo,
        branch,
        merged_at: mergedAt,
        keys: extractKeys(`${title} ${branch ?? ""}`, ctx.keyPattern, ctx.projectKeys),
        // GitHub's real issue linkage: closing keywords in the title/body.
        closes: extractCloses(`${title}
${str3(pr.body) ?? ""}`, repo)
      });
    }
    return sortChanges(out);
  }
};

// src/adapters/github-issues.ts
function str4(v) {
  return typeof v === "string" && v !== "" ? v : null;
}
function workTypeFromLabels2(issue) {
  const labels = (issue.labels ?? []).map((l) => (typeof l === "string" ? l : l.name ?? "").toLowerCase()).filter((n) => n !== "");
  if (labels.includes("bug")) return "bug";
  if (labels.includes("refactor")) return "refactor";
  if (labels.includes("docs") || labels.includes("documentation")) return "docs";
  if (labels.includes("research") || labels.includes("spike")) return "research";
  if (labels.includes("incident")) return "incident";
  return "feature";
}
var ISSUE_URL = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/issues\/([0-9]+)$/;
var githubIssuesAdapter = {
  kind: "github-issues",
  keyPattern: "[A-Za-z0-9][A-Za-z0-9-]*\\/[A-Za-z0-9._-]+#[0-9]+",
  deriveKey(url) {
    const m = ISSUE_URL.exec(url);
    return m ? `${m[1]}/${m[2]}#${m[3]}` : null;
  },
  normalizeItems(raw, ctx) {
    const root = raw;
    const nodes = Array.isArray(raw) ? raw : root.items ?? root.issues ?? [];
    const out = [];
    for (const issue of nodes) {
      if (issue.pull_request !== void 0) continue;
      const url = str4(issue.url) ?? str4(issue.html_url);
      if (!url) continue;
      const key = githubIssuesAdapter.deriveKey(url);
      if (!key) continue;
      const state = (str4(issue.state) ?? "").toLowerCase();
      const reason = (str4(issue.stateReason) ?? str4(issue.state_reason) ?? "").toLowerCase();
      if (reason === "not_planned") continue;
      const assignees = [
        ...(issue.assignees ?? []).map((a) => str4(a.login)),
        str4(issue.assignee?.login)
      ].filter((l) => l !== null);
      if (ctx.githubLogin !== null && assignees.length > 0 && !assignees.some((l) => l.toLowerCase() === ctx.githubLogin.toLowerCase())) {
        continue;
      }
      const done = state === "closed";
      out.push({
        key,
        title: str4(issue.title) ?? key,
        points: null,
        // GitHub has no estimates; a point scale is never invented
        epic_key: null,
        epic_name: null,
        sprint: str4(issue.milestone?.title),
        status: state === "" ? "unknown" : state,
        done,
        resolved_at: done ? str4(issue.closedAt) ?? str4(issue.closed_at) : null,
        created_at: str4(issue.createdAt) ?? str4(issue.created_at),
        updated_at: str4(issue.updatedAt) ?? str4(issue.updated_at),
        work_type: workTypeFromLabels2(issue),
        url
      });
    }
    return sortItems(out);
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
      if (emails.size > 0 && !emails.has(c.author_email.toLowerCase())) continue;
      const closes = extractCloses(`${c.subject}
${c.body}`, repo);
      if (c.parents <= 1 && closes.length === 0) continue;
      out.push({
        url: null,
        // local history has no web URL; the sha is the receipt
        title: `${c.subject} (${c.sha.slice(0, 10)})`,
        repo,
        branch: null,
        // Merge semantics want the committer date: a squash-merged branch
        // keeps an author date days older than the merge itself. Older
        // captured logs without %cd fall back to the author date.
        merged_at: c.committer_date !== "" ? c.committer_date : c.author_date,
        keys: extractKeys(c.subject, ctx.keyPattern, ctx.projectKeys),
        closes
      });
    }
    return sortChanges(out);
  }
};

// src/adapters/gitlab.ts
function str5(v) {
  return typeof v === "string" && v !== "" ? v : null;
}
function repoOf2(mr) {
  const full = str5(mr.references?.full);
  if (full) {
    const m = /^(.+)!\d+$/.exec(full);
    if (m) return m[1];
  }
  const url = str5(mr.web_url);
  if (url) {
    const m = /^https?:\/\/[^/]+\/(.+?)\/-\/merge_requests\//.exec(url);
    if (m) return m[1];
  }
  return null;
}
var gitlabAdapter = {
  kind: "gitlab",
  normalizeChanges(raw, ctx) {
    const items = Array.isArray(raw) ? raw : raw?.merge_requests ?? [];
    const out = [];
    for (const mr of items) {
      const mergedAt = str5(mr.merged_at);
      const url = str5(mr.web_url);
      const repo = repoOf2(mr);
      if (!mergedAt || !url || !repo) continue;
      const author = str5(mr.author?.username);
      if (ctx.gitlabUsername && author && author !== ctx.gitlabUsername) continue;
      const title = str5(mr.title) ?? url;
      const branch = str5(mr.source_branch);
      out.push({
        url,
        title,
        repo,
        branch,
        merged_at: mergedAt,
        keys: extractKeys(`${title} ${branch ?? ""}`, ctx.keyPattern, ctx.projectKeys),
        // GitLab MR descriptions use the same closing-keyword grammar.
        closes: extractCloses(`${title}
${str5(mr.description) ?? ""}`, repo)
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
  const ts = tsCandidates.length > 0 ? tsCandidates.sort(compareInstants)[tsCandidates.length - 1] : now;
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
    const refs = [.../* @__PURE__ */ new Set([...c.keys, ...c.closes ?? []])];
    if (refs.length === 0) {
      unmatched.push(c);
      continue;
    }
    for (const k of refs) {
      changesByKey.set(k, [...changesByKey.get(k) ?? [], c]);
    }
  }
  const shipped = [];
  const corrections = [];
  const orphans = [];
  const shipChained = new Set(effectiveShipped(ledgerEvents).map((v) => v.entry.id));
  for (const item of items) {
    const entry = latestByKey.get(item.key);
    const itemChanges = changesByKey.get(item.key) ?? [];
    if (!entry) {
      if (item.done) orphans.push(orphanBody(item, itemChanges, now));
      continue;
    }
    if (!shipChained.has(entry.id) && item.done) {
      shipped.push(shippedBody(entry, item, itemChanges, now));
      continue;
    }
    if (shipChained.has(entry.id)) {
      if (item.done && entry.reopened === true) {
        const body = {
          ...(({ id: _id, ...rest }) => rest)(entry),
          ts: now,
          kind: "correction",
          supersedes: entry.id,
          points: item.points ?? entry.points,
          epic_key: item.epic_key ?? entry.epic_key,
          epic_name: item.epic_name ?? entry.epic_name,
          sprint: item.sprint ?? entry.sprint,
          reopened: false,
          notes: `sync: re-resolved in tracker (status "${item.status}") after reopen`
        };
        corrections.push({ body, drift: [`re-resolved (status "${item.status}")`] });
        continue;
      }
      if (!item.done && entry.reopened !== true) {
        const body = {
          ...(({ id: _id, ...rest }) => rest)(entry),
          ts: now,
          kind: "correction",
          supersedes: entry.id,
          points: item.points ?? entry.points,
          epic_key: item.epic_key ?? entry.epic_key,
          epic_name: item.epic_name ?? entry.epic_name,
          sprint: item.sprint ?? entry.sprint,
          reopened: true,
          notes: `sync: reopened in tracker (status "${item.status}")`
        };
        corrections.push({ body, drift: [`reopened (status "${item.status}")`] });
        continue;
      }
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
var TRACKERS = {
  jira: jiraAdapter,
  linear: linearAdapter,
  "github-issues": githubIssuesAdapter
};
var GIT_HOSTS = { github: githubAdapter, gitlab: gitlabAdapter, local: gitLocalAdapter };
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
    const plan2 = JSON.parse(readFileSync15(applyPath, "utf8"));
    const bodies = [
      ...plan2.shipped,
      ...plan2.corrections.map((c) => c.body),
      ...plan2.orphans
    ];
    const existing = new Set(readEvents(home, "ledger").map((e) => e.id));
    const events = [];
    for (const body of bodies) {
      const event = finalizeEvent("ledger", body);
      if (existing.has(event.id)) continue;
      existing.add(event.id);
      events.push(event);
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
      execFileSync8("git", ["-C", home, "add", "-A"], { stdio: ["ignore", "ignore", "ignore"], timeout: 15e3 });
      execFileSync8("git", ["-C", home, "commit", "-m", `sync: ${events.length} entr${events.length === 1 ? "y" : "ies"} applied`], {
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
    jiraAccountId: identity?.jira_account_id ?? null,
    gitlabUsername: identity?.gitlab_username ?? null,
    linearUserId: identity?.linear_user_id ?? null,
    projectKeys: config.tracker.project_keys
  });
  let items = [];
  if (itemsPath) {
    if (!tracker || !(tracker in TRACKERS)) {
      process.stderr.write(`waybill sync-plan: --items needs --tracker <${Object.keys(TRACKERS).join("|")}>
`);
      return 2;
    }
    items = TRACKERS[tracker].normalizeItems(JSON.parse(readFileSync15(itemsPath, "utf8")), ctx);
  }
  let changes = [];
  if (changesPath) {
    if (!gitHost || !(gitHost in GIT_HOSTS)) {
      process.stderr.write(`waybill sync-plan: --changes needs --git <${Object.keys(GIT_HOSTS).join("|")}>
`);
      return 2;
    }
    changes = GIT_HOSTS[gitHost].normalizeChanges(JSON.parse(readFileSync15(changesPath, "utf8")), ctx);
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
var ENGINE_VERSION = true ? "1.7.0" : "dev";
var USAGE = `waybill \u2014 token accounting for AI-assisted work. Bring receipts.

Usage: waybill <command> [options]

Commands:
  init        Initialize $WAYBILL_HOME: git repo, config, identity map, retention check
  bootstrap   Render a bootstrap receipt from local git history (zero auth)
                [--days 90 | --from <date> [--to <date>]] [--repo-path <dir>]...
  mine        Process pending session captures (spawned by the SessionEnd hook)
                [--queue | --all]
  meter       Meter transcripts into usage events (deterministic, incremental)
                --transcript <path> [--repo org/name] | --all [--projects-dir <dir>]
                | --otel <export.jsonl>  (fills transcript-less sessions only)
                [--force  re-meter even when checkpoints say current]
  append      Validate, seal, id, and append one event (the skills' write path)
                --stream <name> (--event '<json>' | --stdin) [--commit]
  resolve     File an attribution-inbox item and re-attribute its turns
                --ambiguity <id> --account <acct> [--pin | --repo-default <org/name>]
  sync-plan   Reconcile normalized tracker/git payloads into proposed entries
                --tracker jira|linear|github-issues --items <raw.json>
                --git github|gitlab|local --changes <raw.json>
                [--local-repo <dir>]... [--since <iso>] [--baseline] | --apply <plan.json>
  query       Projections as JSON: spend | report | forecast | story <KEY> | inbox
                | standup ("what did I do" digest \u2014 default window: yesterday;
                --date yesterday|today|YYYY-MM-DD or --days <n>, local-calendar)
                | untracked (salvage clustering: spend with no receipt behind it)
                | manifest (open work, open spend, age; --now injectable)
                [--from <date|iso>] [--to <date|iso>] [--audience self|internal|external]
                [--detail terse|standard|full  echoed for the rendering layer]
  pace        Budget pacing vs the allocation (spend, linear + work-weighted pace,
                per-epic envelopes) [--notice  one line, only on a fresh threshold]
  status      One screen of ledger health: init, retention, mining, inbox, verify,
                remote ahead/behind (multi-machine, local refs only \u2014 no network)
  export      Spend ledger as csv|json [--format csv|json] [--from/--to] [--audience]
                | --pack [--out <dir>] [--from/--to]: verification pack \u2014 verbatim
                events + the engine, so the recipient runs verify themselves
  pricing     show | import [--model <id-or-alias>]... | set <model-id> --version <date>
                --input/--output/--cache-read/--cache-5m/--cache-1h <usd per mtok>
                (import loads bundled Anthropic rates; set overrides any model)
  conventions Print the receipt-friendly CLAUDE.md block and commit-msg hook
                (key-prefixed branches/commits raise attribution confidence)
  dashboard   Write rollups/dashboard.html \u2014 the zero-token view of your ledger
                [--now <iso>] (refreshed by mine when the file exists)
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
  if (cmd === "--version" || cmd === "version") {
    process.stdout.write(
      `waybill ${ENGINE_VERSION}
Update: claude plugin update waybill@waybill  (then restart Claude Code)
`
    );
    return 0;
  }
  const cli = parseGlobal(rest);
  switch (cmd) {
    case "init":
      return runInit(cli.home, cli.args, cli.json);
    case "bootstrap":
      return runBootstrap(cli.home, cli.args, cli.json);
    case "mine":
      return runMine(cli.home, cli.args, cli.json);
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
    case "status":
      return runStatus(cli.home, cli.args, cli.json);
    case "export":
      return runExport(cli.home, cli.args, cli.json);
    case "pricing":
      return runPricing(cli.home, cli.args, cli.json);
    case "conventions":
      return runConventions(cli.home, cli.args, cli.json);
    case "dashboard":
      return runDashboard(cli.home, cli.args, cli.json);
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
  ENGINE_VERSION,
  main,
  parseGlobal
};
