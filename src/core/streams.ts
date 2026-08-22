import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Envelope, StreamName } from "./events.ts";
import { serializeEvent } from "./events.ts";

export function shardFor(ts: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(ts);
  if (!m) throw new Error(`streams: unshardable ts: ${ts}`);
  return `${m[1]}-${m[2]}`;
}

export function streamDir(home: string, stream: StreamName): string {
  return join(home, "streams", stream);
}

export function shardPath(home: string, stream: StreamName, shard: string): string {
  return join(streamDir(home, stream), `${shard}.jsonl`);
}

/** Append events grouped by shard; one write call per shard (line-atomic). */
export function appendEvents(home: string, stream: StreamName, events: Envelope[]): void {
  if (events.length === 0) return;
  const byShard = new Map<string, Envelope[]>();
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

export interface StreamLine<T extends Envelope = Envelope> {
  event: T;
  shard: string;
  lineNo: number;
}

export function listShards(home: string, stream: StreamName): string[] {
  const dir = streamDir(home, stream);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f))
    .sort()
    .map((f) => f.replace(/\.jsonl$/, ""));
}

export function readStream<T extends Envelope = Envelope>(
  home: string,
  stream: StreamName,
  onBadLine?: (shard: string, lineNo: number, line: string) => void,
): Array<StreamLine<T>> {
  const out: Array<StreamLine<T>> = [];
  for (const shard of listShards(home, stream)) {
    const raw = readFileSync(shardPath(home, stream, shard), "utf8");
    let lineNo = 0;
    for (const line of raw.split("\n")) {
      lineNo += 1;
      if (line.trim() === "") continue;
      // One torn line (a crash mid-append) must not make the whole stream
      // unreadable for every command: skip it, let verify report it.
      try {
        out.push({ event: JSON.parse(line) as T, shard, lineNo });
      } catch {
        onBadLine?.(shard, lineNo, line);
      }
    }
  }
  return out;
}

export function readEvents<T extends Envelope = Envelope>(
  home: string,
  stream: StreamName,
): T[] {
  return readStream<T>(home, stream).map((l) => l.event);
}

/** Latest non-superseded events. */
export function authoritative<T extends Envelope>(events: T[]): T[] {
  const superseded = new Set<string>();
  for (const e of events) if (e.supersedes) superseded.add(e.supersedes);
  return events.filter((e) => !superseded.has(e.id));
}
