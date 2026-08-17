/**
 * Tracker-key plausibility. The key pattern ([A-Z][A-Z0-9]+-[0-9]+) is
 * deliberately liberal, which lets everyday technical tokens masquerade as
 * story keys — SHA-256, UTF-8, ISO-8601, HTTP-404 — and a commit message
 * like "use SHA-256 for escrow" must never mint a story:SHA-256 account.
 *
 * Two deterministic gates:
 *  1. A stoplist of prefixes that are overwhelmingly technical, never
 *     tracker projects.
 *  2. When the user has configured tracker.project_keys, the prefix must be
 *     one of them (exact match) — the strongest signal available.
 */
const PREFIX_STOPLIST = new Set([
  "SHA", "MD", "CRC", "AES", "RSA", "HMAC", "TLS", "SSL",
  "UTF", "ISO", "IEEE", "RFC", "ANSI", "IETF", "ECMA", "CVE",
  "HTTP", "HTTPS", "TCP", "UDP", "IP", "IPV", "DNS", "FTP", "SSH",
  "UTC", "GMT", "BASE", "OAUTH", "SAML", "X", "ERR", "E", "P", "S",
  "HTML", "CSS", "ES", "GPT", "CPU", "GPU", "RAM", "IOS", "OSX",
]);

export function keyPrefix(key: string): string {
  const dash = key.indexOf("-");
  return dash === -1 ? key : key.slice(0, dash);
}

/**
 * Is this pattern-matched string plausibly a tracker key?
 * `projectKeys` is `config.tracker.project_keys` — when non-empty it is
 * authoritative (allowlist); when empty, only the stoplist filters.
 */
export function isPlausibleTrackerKey(key: string, projectKeys: string[]): boolean {
  const prefix = keyPrefix(key);
  if (projectKeys.length > 0) return projectKeys.includes(prefix);
  return !PREFIX_STOPLIST.has(prefix);
}

export function filterTrackerKeys(keys: string[], projectKeys: string[]): string[] {
  return keys.filter((k) => isPlausibleTrackerKey(k, projectKeys));
}
