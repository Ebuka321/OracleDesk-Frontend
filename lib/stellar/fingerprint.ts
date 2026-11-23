/**
 * Short, human-comparable fingerprints for Stellar addresses.
 *
 * Truncating an address ("CC4M…R2O7") is exactly what vanity-address
 * attackers grind for, so a fingerprint must not depend on only the visible
 * ends. This scheme hashes the decoded 32-byte StrKey payload with SHA-256
 * and maps the first 33 bits to three words from a fixed 2048-word list
 * (BIP-39 English): matching the first/last 4 StrKey characters is cheap,
 * matching three hash-derived words as well costs about 2^33 more attempts,
 * and three short words are far easier for a human to compare out loud or
 * side by side than 56 characters.
 *
 * This is a UX aid, not a cryptographic guarantee — see SECURITY.md. Always
 * compare the full grouped address against an independent source (e.g.
 * Stellar Expert) when the amount matters.
 */

import { StrKey } from "@stellar/stellar-sdk";
import { sha256HexOf } from "./sha256";
import { ADDRESS_FINGERPRINT_WORDS } from "./fingerprint-words";

export interface AddressFingerprint {
  /** Three words covering bits 0–32 of the digest (11 bits each). */
  words: [string, string, string];
  /** Lowercase hex of the full SHA-256 digest of the decoded payload. */
  hex: string;
}

/** Decodes a G… account or C… contract id to its raw 32-byte payload. */
export function decodeStrKeyPayload(address: string): Uint8Array {
  const value = address.trim();
  if (value.startsWith("G")) return StrKey.decodeEd25519PublicKey(value);
  if (value.startsWith("C")) return StrKey.decodeContract(value);
  throw new Error("Unsupported address: expected a G… account or C… contract id");
}

/** Splits an address into 4-character groups for display, e.g. "CC4M MHWZ 6ZRY". */
export function groupAddress(address: string): string[] {
  const groups: string[] = [];
  for (let i = 0; i < address.length; i += 4) groups.push(address.slice(i, i + 4));
  return groups;
}

/**
 * Three-word fingerprint of a G… or C… address. Throws (via StrKey) on an
 * invalid address; the same address always produces the same words, and any
 * one-character change to the address changes all three with overwhelming
 * probability.
 */
export function addressFingerprint(address: string): AddressFingerprint {
  const digestHex = sha256HexOf([decodeStrKeyPayload(address)]);
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = parseInt(digestHex.slice(i * 2, i * 2 + 2), 16);

  // First 33 bits: a 32-bit word plus the top bit of the next byte.
  const hi = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
  const bit33 = bytes[4] >> 7;
  const w0 = hi >>> 21; // bits 0–10
  const w1 = (hi >>> 10) & 0x7ff; // bits 11–21
  const w2 = ((hi & 0x3ff) << 1) | bit33; // bits 22–32

  return {
    words: [
      ADDRESS_FINGERPRINT_WORDS[w0],
      ADDRESS_FINGERPRINT_WORDS[w1],
      ADDRESS_FINGERPRINT_WORDS[w2],
    ],
    hex: digestHex,
  };
}
