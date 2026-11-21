/**
 * Pure Stellar address similarity & policy engine for entry-time defense
 * against address poisoning and look-alike recipients.
 *
 * False-positive calibration (measured in `address-policy.test.ts` over 100k
 * random Ed25519 keypairs against a 50-entry address book): < 0.1% (expected ~0.0002%).
 */
import { StrKey } from "@stellar/stellar-sdk";

export type AddressKind = "account" | "contract";

export interface KnownAddress {
  address: string;
  label: string;
  source: "self" | "book" | "config" | "registry" | "deployment";
}

export type Finding =
  | { kind: "lookalike"; of: KnownAddress; prefix: number; suffix: number }
  | { kind: "first-time" }
  | { kind: "wrong-kind"; expected: AddressKind }
  | { kind: "self" }
  | { kind: "known"; match: KnownAddress };

declare const policyCheckedBrand: unique symbol;
export type PolicyCheckedAddress = string & { readonly [policyCheckedBrand]: true };

export function asPolicyCheckedAddress(address: string): PolicyCheckedAddress {
  return address as PolicyCheckedAddress;
}

export function addressKindOf(address: string): AddressKind | null {
  try {
    if (StrKey.isValidEd25519PublicKey(address)) return "account";
    if (StrKey.isValidContract(address)) return "contract";
  } catch {
    return null;
  }
  return null;
}

function commonPrefixLen(a: string, b: string): number {
  const len = Math.min(a.length, b.length);
  let i = 0;
  while (i < len && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

function commonSuffixLen(a: string, b: string): number {
  const len = Math.min(a.length, b.length);
  let i = 0;
  while (i < len && a.charCodeAt(a.length - 1 - i) === b.charCodeAt(b.length - 1 - i)) i++;
  return i;
}

/**
 * Classifies a valid (or candidate) Stellar address against a list of known
 * counterparties and an expected address kind.
 *
 * Compares the StrKey payload (without the leading version character `G`/`C`)
 * so that all accounts do not share a trivial 1-char prefix.
 */
export function classify(
  candidate: string,
  known: readonly KnownAddress[],
  opts: { expect: AddressKind | "any" },
): Finding[] {
  const findings: Finding[] = [];
  const kind = addressKindOf(candidate);
  if (opts.expect !== "any" && kind !== opts.expect) {
    findings.push({ kind: "wrong-kind", expected: opts.expect });
  }

  let exactMatch: KnownAddress | undefined;
  const lookalikes: Array<Extract<Finding, { kind: "lookalike" }>> = [];
  const candPayload = candidate.slice(1);

  for (const entry of known) {
    if (entry.address === candidate) {
      if (!exactMatch || entry.source === "self") {
        exactMatch = entry;
      }
      continue;
    }
    const entryPayload = entry.address.slice(1);
    const prefix = commonPrefixLen(candPayload, entryPayload);
    const suffix = commonSuffixLen(candPayload, entryPayload);
    if ((prefix + suffix >= 6 && prefix >= 2 && suffix >= 2) || prefix >= 5 || suffix >= 5) {
      lookalikes.push({ kind: "lookalike", of: entry, prefix, suffix });
    }
  }

  if (exactMatch) {
    if (exactMatch.source === "self") {
      findings.push({ kind: "self" });
    } else {
      findings.push({ kind: "known", match: exactMatch });
    }
  }

  if (lookalikes.length > 0) {
    lookalikes.sort((a, b) => {
      if (a.of.source === "self" && b.of.source !== "self") return -1;
      if (b.of.source === "self" && a.of.source !== "self") return 1;
      return b.prefix + b.suffix - (a.prefix + a.suffix);
    });
    findings.push(...lookalikes);
  }

  if (!exactMatch && lookalikes.length === 0) {
    findings.push({ kind: "first-time" });
  }

  return findings;
}
