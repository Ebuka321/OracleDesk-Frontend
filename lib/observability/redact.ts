/**
 * Redaction for anything that leaves the browser in an error report
 * (issue #123). Pure and synchronous: no imports of the reporter, no
 * network, no randomness beyond a per-install salt that callers pass in
 * (see getRedactionSalt() in report.ts for the storage-backed one).
 *
 * What must never leave: JWTs, secret seeds, signatures/XDR blobs, wallet
 * addresses (hashed instead — they link a person to their full on-chain
 * history), Authorization material, query strings. Contract ids from
 * CONTRACTS are public and stay intact so reports remain debuggable.
 */

import { Sha256, sha256HexOf } from "@/lib/stellar/sha256";

export const SENSITIVE_KEY_RE = /token|authorization|signature|signed|secret|xdr|envelope|password/i;
export const JWT_RE = /\beyJ[\w-]+\.[\w-]+\.[\w-]+/g;
export const SECRET_SEED_RE = /\bS[A-Z2-7]{55}\b/g;
export const STRKEY_RE = /\b[GCM][A-Z2-7]{55}\b/g;
export const LONG_BASE64_RE = /\b[A-Za-z0-9+/]{80,}={0,2}\b/g;
export const HEX64_RE = /\b[0-9a-f]{64}\b/gi;
export const NEAR_SECRET_HEX_RE =
  /\b(?:[0-9a-f]{64}[^\s]{0,24}(?:secret|priv|seed)|(?:secret|priv|seed)[^\s]{0,24}[0-9a-f]{64})\b/gi;

/** Public ids that do not need hashing: contract addresses shipped to every browser anyway. */
export function makeAllowlist(values: Iterable<string>): Set<string> {
  return new Set(values);
}

const encoder = new TextEncoder();

const SALT_KEY = "oracledesk_redact_salt";
let moduleSalt: string | null = null;

function randomHex(bytes: number): string {
  const values = new Uint8Array(bytes);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) crypto.getRandomValues(values);
  else for (let i = 0; i < bytes; i++) values[i] = Math.floor(Math.random() * 256);
  return Array.from(values, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Per-install random salt for address hashing, persisted in localStorage so
 * a user's own reports correlate across sessions. Falls back to an
 * in-memory value when storage is unavailable (SSR, private mode).
 */
export function getRedactionSalt(): string {
  if (moduleSalt) return moduleSalt;
  try {
    if (typeof window !== "undefined") {
      const stored = window.localStorage.getItem(SALT_KEY);
      if (stored) {
        moduleSalt = stored;
        return moduleSalt;
      }
      const fresh = randomHex(16);
      window.localStorage.setItem(SALT_KEY, fresh);
      moduleSalt = fresh;
      return moduleSalt;
    }
  } catch {
    // Storage unavailable: fall through to the in-memory salt.
  }
  moduleSalt = randomHex(16);
  return moduleSalt;
}

function hmacSha256Hex(keyMaterial: string, message: string): string {
  let key = encoder.encode(keyMaterial);
  if (key.length > 64) key = new Uint8Array(sha256HexOf([key]).match(/.{2}/g)!.map((b) => parseInt(b, 16)));
  const block = new Uint8Array(64);
  block.set(key);
  const innerPad = new Uint8Array(64);
  const outerPad = new Uint8Array(64);
  for (let i = 0; i < 64; i++) {
    innerPad[i] = block[i] ^ 0x36;
    outerPad[i] = block[i] ^ 0x5c;
  }
  const inner = new Sha256().update(innerPad).update(encoder.encode(message)).digest();
  return Array.from(new Sha256().update(outerPad).update(inner).digest(), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Salts a per-install random value into a stable, non-reversible handle for
 * an address: `G:1a2b3c4d` (first 8 hex of HMAC-SHA256(salt, address),
 * prefixed by the StrKey class). The same address correlates within one
 * installation; nothing links across installs and the value cannot be
 * reversed without the salt.
 */
export function hashAddress(address: string, salt: string): string {
  return `${address[0]}:${hmacSha256Hex(salt, address).slice(0, 8)}`;
}

/** Drops query strings and fragments: `https://host/path?token=…` → `https://host/path`. */
export function stripUrlDetails(input: string): string {
  return input.replace(/https?:\/\/[^\s"'<>]+/g, (url) => url.replace(/[?#][^\s"'<>]*$/, ""));
}

export interface RedactOptions {
  /** Per-install salt for address hashing (see report.ts getRedactionSalt). */
  salt?: string;
  /** Values to leave intact (public contract ids). */
  allowlist?: ReadonlySet<string>;
}

/** Result of redacting one string: the text plus whether a secret seed was found. */
export interface RedactedString {
  text: string;
  containedSecret: boolean;
}

export function redactStringDetailed(input: string, options: RedactOptions = {}): RedactedString {
  const salt = options.salt ?? "";
  const allowlist = options.allowlist;

  let text = stripUrlDetails(input);
  text = text.replace(JWT_RE, "[jwt]");

  let containedSecret = false;
  text = text.replace(SECRET_SEED_RE, () => {
    containedSecret = true;
    return "[secret]";
  });

  // 64-hex is normally a public transaction hash and stays; next to
  // secret/priv/seed wording it is not public, so drop it too.
  text = text.replace(NEAR_SECRET_HEX_RE, "[secret]");

  text = text.replace(LONG_BASE64_RE, (match) => `[xdr:${match.length}]`);

  if (salt) {
    text = text.replace(STRKEY_RE, (match) => (allowlist?.has(match) ? match : hashAddress(match, salt)));
  }

  return { text, containedSecret };
}

export function redactString(input: string, options: RedactOptions = {}): string {
  return redactStringDetailed(input, options).text;
}

const MAX_DEPTH = 5;
const MAX_STRING = 1000;
const MAX_ARRAY = 20;

/**
 * Deep-walks a value: drops sensitive keys at any depth, redacts every
 * string, caps strings at 1 kB and arrays at 20 items, and breaks cycles.
 */
export function redactValue(value: unknown, options: RedactOptions = {}, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "function") return undefined;
  if (typeof value === "string") return redactString(value.length > MAX_STRING ? value.slice(0, MAX_STRING) : value, options);
  if (typeof value !== "object") return String(value);
  if (depth >= MAX_DEPTH) return "[depth]";
  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY).map((item) => redactValue(item, options, depth + 1, seen));
    if (value.length > MAX_ARRAY) items.push(`[+${value.length - MAX_ARRAY} more]`);
    return items;
  }

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY_RE.test(key)) continue;
    const redacted = redactValue(entry, options, depth + 1, seen);
    if (redacted !== undefined) out[key] = redacted;
  }
  return out;
}

/** Anything that must never survive into a sent event. */
const SURVIVORS_RE = /\beyJ[\w-]+\.[\w-]+\.[\w-]+|\bS[A-Z2-7]{55}\b/;

/**
 * Second pass over the fully built event ("belt and braces"): redacts the
 * serialized form and drops the event entirely if a JWT or secret seed
 * pattern still survives. Returns null when the event must not be sent.
 */
export function redactEvent<T>(event: T, options: RedactOptions = {}): { event: string; containedSecret: boolean } | null {
  const walked = redactValue(event, options) as Record<string, unknown> | null;
  if (walked === null || typeof walked !== "object") return null;

  let serialized: string;
  try {
    serialized = JSON.stringify(walked);
  } catch {
    return null;
  }
  if (serialized === undefined) return null;

  const final = redactStringDetailed(serialized, options);
  if (SURVIVORS_RE.test(final.text)) return null;
  return { event: final.text, containedSecret: final.containedSecret || Boolean(walked.tags && (walked.tags as Record<string, unknown>).contained_secret) };
}
