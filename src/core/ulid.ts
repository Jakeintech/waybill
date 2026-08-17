import { canonicalJson } from "./canonical.ts";
import { sha256Bytes } from "./sha.ts";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function encodeTime(ms: number): string {
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

export function encodeEntropy(bytes: Uint8Array): string {
  if (bytes.length < 10) throw new Error("ulid: need 10 entropy bytes");
  let out = "";
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < 10; i++) {
    acc = (acc << 8) | bytes[i]!;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(acc >> bits) & 31];
    }
  }
  return out; // 16 chars: 80 bits / 5
}

/**
 * Deterministic ULID: timestamp bits from the event ts, entropy bits from
 * SHA-256 over the stream name and the event's canonical content (without
 * id). Same content, same id — the whole fact stream is replayable.
 */
export function deterministicUlid(ts: string, stream: string, content: unknown): string {
  const ms = Date.parse(ts);
  if (Number.isNaN(ms)) throw new Error(`ulid: unparseable ts: ${ts}`);
  const digest = sha256Bytes(stream + "\n" + canonicalJson(content));
  return encodeTime(ms) + encodeEntropy(digest);
}

export function isUlid(s: string): boolean {
  return /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/.test(s);
}
