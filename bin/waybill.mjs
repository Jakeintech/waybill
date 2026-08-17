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

// src/cli/main.ts
var USAGE = `waybill \u2014 token accounting for AI-assisted work. Bring receipts.

Usage: waybill <command> [options]

Commands:
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
