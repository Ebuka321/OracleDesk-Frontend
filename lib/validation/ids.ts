import { StrKey } from "@stellar/stellar-sdk";
import { parseCid as parseCidBytes } from "../stellar/cid";

/**
 * Strict parsers for every identifier the app accepts from links, the backend,
 * socket payloads or the chain (issue #120). Parsers return `null` for invalid
 * input and never throw; `assertValid` turns that into a ValidationError at an
 * API boundary.
 */

export type Brand<T, B extends string> = T & { readonly __brand: B };
export type Uuid = Brand<string, "Uuid">;
export type U64String = Brand<string, "U64">;
export type Hex32 = Brand<string, "Hex32">;
export type Cid = Brand<string, "Cid">;
export type GAddress = Brand<string, "G">;
export type CAddress = Brand<string, "C">;
export type SlugId = Brand<string, "Slug">;

export class ValidationError extends Error {
  constructor(public readonly what: string) {
    super(`Invalid ${what}`);
    this.name = "ValidationError";
  }
}

const MAX_INPUT = 512;
const asString = (value: unknown): string | null => {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_INPUT) return null;
  if (!/^[\x20-\x7e]+$/.test(value)) return null;
  return value;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseUuid(value: unknown): Uuid | null {
  const text = asString(value);
  if (!text || !UUID_RE.test(text)) return null;
  return text.toLowerCase() as Uuid;
}

const U64_RE = /^(0|[1-9]\d{0,19})$/;

export function parseU64(value: unknown): U64String | null {
  const text = asString(value);
  if (!text || !U64_RE.test(text)) return null;
  return BigInt(text) <= 2n ** 64n - 1n ? (text as U64String) : null;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Markets seeded by tests use readable ids (`e2e-market-1`) instead of UUIDs. */
export function parseSlugId(value: unknown): SlugId | null {
  const text = asString(value);
  return text && SLUG_RE.test(text) ? (text as SlugId) : null;
}

const HEX32_RE = /^(?:0x)?([0-9a-f]{64})$/i;

export function parseTxHash(value: unknown): Hex32 | null {
  const text = asString(value);
  const match = text ? HEX32_RE.exec(text) : null;
  return match ? (match[1].toLowerCase() as Hex32) : null;
}

/** Backend record ids: canonical UUIDs, or the readable ids used by seeded tests. */
export function parseRecordId(value: unknown): Uuid | SlugId | null {
  return parseUuid(value) ?? parseSlugId(value);
}

export function parseCid(value: unknown): Cid | null {
  const text = asString(value);
  if (!text) return null;
  const bare = text.startsWith("ipfs://") ? text.slice("ipfs://".length) : text;
  if (!bare || /[/\\?#\s]/.test(bare)) return null;
  return parseCidBytes(bare) ? (bare as Cid) : null;
}

export function parseAccount(value: unknown): GAddress | null {
  const text = asString(value);
  if (!text || !text.startsWith("G")) return null;
  try {
    return StrKey.isValidEd25519PublicKey(text) ? (text as GAddress) : null;
  } catch {
    return null;
  }
}

export function parseContract(value: unknown): CAddress | null {
  const text = asString(value);
  if (!text || !text.startsWith("C")) return null;
  try {
    return StrKey.isValidContract(text) ? (text as CAddress) : null;
  } catch {
    return null;
  }
}

export function assertValid<T>(parsed: T | null, what: string): T {
  if (parsed === null) throw new ValidationError(what);
  return parsed;
}
