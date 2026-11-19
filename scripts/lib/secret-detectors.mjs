/**
 * Pure secret detectors for scripts/scan-build-secrets.mjs (issue #118).
 * Findings never include the matched value; callers print a hash prefix.
 */

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function decodeBase32(input) {
  const bytes = [];
  let buffer = 0;
  let bits = 0;
  for (const char of input) {
    const value = BASE32.indexOf(char);
    if (value < 0) return null;
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

export function crc16Xmodem(bytes) {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

const SEED_VERSION = 18 << 3;

export function findStellarSeeds(text) {
  const results = [];
  for (const match of text.matchAll(/\bS[A-Z2-7]{55}\b/g)) {
    const bytes = decodeBase32(match[0]);
    if (!bytes || bytes.length !== 35) continue;
    if (bytes[0] !== SEED_VERSION) continue;
    const expected = crc16Xmodem(bytes.subarray(0, 33));
    const actual = bytes[33] | (bytes[34] << 8);
    if (expected !== actual) continue;
    results.push({ index: match.index ?? 0, length: match[0].length, kind: "stellar-secret-seed" });
  }
  return results;
}

const KEY_WORD = /(?:priv|secret|key|mnemonic)/i;

export function findEvmKeys(text) {
  const results = [];
  for (const match of text.matchAll(/\b0x[0-9a-fA-F]{64}\b/g)) {
    const index = match.index ?? 0;
    const context = text.slice(Math.max(0, index - 80), index + 80);
    if (!KEY_WORD.test(context) && !/NEXT_PUBLIC_[A-Z0-9_]+\s*[:=]/i.test(context)) continue;
    results.push({ index, length: match[0].length, kind: "evm-private-key" });
  }
  return results;
}

export function findJwts(text) {
  const results = [];
  for (const match of text.matchAll(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g)) {
    const header = match[0].split(".")[0];
    try {
      const json = JSON.parse(Buffer.from(header, "base64url").toString("utf8"));
      if (json && typeof json === "object" && "alg" in json) {
        results.push({ index: match.index ?? 0, length: match[0].length, kind: "jwt" });
      }
    } catch {
      // Not a JWT header.
    }
  }
  return results;
}

export function shannonEntropy(value) {
  const counts = new Map();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

const VENDOR_PATTERNS = [
  { kind: "circle-api-key", pattern: /\b(?:TEST|LIVE)_API_KEY:[A-Za-z0-9_-]{16,}\b/g },
  { kind: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g },
  { kind: "pinata-jwt", pattern: /\beyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g },
];

export function findVendorKeys(text) {
  const results = [];
  for (const { kind, pattern } of VENDOR_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      results.push({ index: match.index ?? 0, length: match[0].length, kind });
    }
  }
  return results;
}

/**
 * High-entropy tokens. `allowed` holds sha256 hashes of reviewed public values;
 * a token whose hash is listed is skipped.
 */
export function findHighEntropy(text, { minLen = 32, threshold = 4.5, allowed = new Set(), createHash } = {}) {
  const results = [];
  for (const match of text.matchAll(/[A-Za-z0-9+/_=-]{32,}/g)) {
    const token = match[0];
    if (token.length < minLen) continue;
    if (shannonEntropy(token) < threshold) continue;
    if (allowed.has(createHash ? createHash(token) : token)) continue;
    results.push({ index: match.index ?? 0, length: token.length, kind: "high-entropy", token });
  }
  return results;
}

export function findPublicEnvNames(text) {
  return new Set([...text.matchAll(/\bNEXT_PUBLIC_[A-Z0-9_]+/g)].map((match) => match[0]));
}

/** Every detector finding for a text, with the value kept only for hashing. */
export function findSecrets(text, options = {}) {
  return [
    ...findStellarSeeds(text),
    ...findEvmKeys(text),
    ...findJwts(text),
    ...findVendorKeys(text),
    ...findHighEntropy(text, options).map((finding) => finding),
  ];
}
