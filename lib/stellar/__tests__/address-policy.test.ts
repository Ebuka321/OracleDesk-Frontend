import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { StrKey } from "@stellar/stellar-sdk";
import { classify, type KnownAddress } from "../address-policy";

function makeAccount(seed: number): string {
  const bytes = new Uint8Array(32).fill(seed & 0xff);
  bytes[0] = (seed >> 8) & 0xff;
  bytes[1] = seed & 0xff;
  return StrKey.encodeEd25519PublicKey(Buffer.from(bytes));
}

function makeLookalike(base: string, prefixMatch: number, suffixMatch: number): string {
  // Construct a syntactically valid G... string matching prefix/suffix of payload for classify()
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const basePayload = base.slice(1).split("");
  const mid = basePayload.map((ch, idx) => {
    if (idx < prefixMatch) return ch;
    if (idx >= basePayload.length - suffixMatch) return ch;
    const alt = chars[(chars.indexOf(ch) + 7) % chars.length];
    return alt;
  });
  return "G" + mid.join("");
}

describe("address-policy classify", () => {
  const selfAddr = makeAccount(1);
  const friendAddr = makeAccount(2);
  const contractAddr = StrKey.encodeContract(Buffer.alloc(32, 9));

  const known: KnownAddress[] = [
    { address: selfAddr, label: "My Wallet", source: "self" },
    { address: friendAddr, label: "Treasury", source: "book" },
    { address: contractAddr, label: "Market Core", source: "config" },
  ];

  it("identifies self without flagging as a lookalike of itself", () => {
    const findings = classify(selfAddr, known, { expect: "account" });
    expect(findings).toEqual([{ kind: "self" }]);
  });

  it("identifies exact known counterparty", () => {
    const findings = classify(friendAddr, known, { expect: "account" });
    expect(findings).toEqual([{ kind: "known", match: known[1] }]);
  });

  it("flags wrong-kind when expecting account and given contract", () => {
    const findings = classify(contractAddr, known, { expect: "account" });
    expect(findings.some((f) => f.kind === "wrong-kind" && f.expected === "account")).toBe(true);
  });

  it("flags prefix-only (>=5), suffix-only (>=5), and combined (p>=2, s>=2, p+s>=6) look-alikes", () => {
    const prefix5 = makeLookalike(friendAddr, 5, 0);
    const suffix5 = makeLookalike(friendAddr, 0, 5);
    const combined = makeLookalike(friendAddr, 3, 3);

    expect(classify(prefix5, known, { expect: "any" }).some((f) => f.kind === "lookalike")).toBe(true);
    expect(classify(suffix5, known, { expect: "any" }).some((f) => f.kind === "lookalike")).toBe(true);
    expect(classify(combined, known, { expect: "any" }).some((f) => f.kind === "lookalike")).toBe(true);
  });

  it("prioritizes own-address look-alikes first", () => {
    const selfLookalike = makeLookalike(selfAddr, 4, 4);
    const findings = classify(selfLookalike, known, { expect: "any" });
    expect(findings[0]).toMatchObject({ kind: "lookalike", of: { source: "self" } });
  });

  it("returns first-time for an unrelated address", () => {
    const fresh = makeAccount(999);
    const findings = classify(fresh, known, { expect: "account" });
    expect(findings).toEqual([{ kind: "first-time" }]);
  });

  it("has false-positive rate below 0.1% across 100k random keys against a 50-entry book", () => {
    const book: KnownAddress[] = Array.from({ length: 50 }, () => ({
      address: StrKey.encodeEd25519PublicKey(randomBytes(32)),
      label: "Entry",
      source: "book" as const,
    }));

    let falsePositives = 0;
    const total = 100_000;
    for (let i = 0; i < total; i++) {
      const candidate = StrKey.encodeEd25519PublicKey(randomBytes(32));
      const findings = classify(candidate, book, { expect: "account" });
      if (findings.some((f) => f.kind === "lookalike")) {
        falsePositives++;
      }
    }
    const rate = falsePositives / total;
    expect(rate).toBeLessThan(0.001);
  }, 30_000);
});
