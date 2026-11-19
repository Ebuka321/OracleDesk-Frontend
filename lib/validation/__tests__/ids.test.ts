import { describe, expect, it } from "vitest";
import {
  ValidationError,
  assertValid,
  parseAccount,
  parseCid,
  parseContract,
  parseRecordId,
  parseTxHash,
  parseU64,
  parseUuid,
} from "../ids";

const UUID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
const G = "GD2NB2VUME7ECMHFHQN5M3KUZLLJF3R6Z4OFCBLE4SJNHIQHITRPQGHQ";
const C = "CA2WQQJ4OHQCLHQW6XN4BCLILGRV6V4YDYDT3GVIWXB53BTOO7EMREQH";
const CID = "bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e";

describe("uid parsers", () => {
  it("accepts canonical lowercase uuids and normalises case", () => {
    expect(parseUuid(UUID)).toBe(UUID);
    expect(parseUuid(UUID.toUpperCase())).toBe(UUID);
  });

  it("rejects traversal and encoded traversal in uuids", () => {
    for (const value of ["../auth/verify", "..%2F..%2Fauth", "%2e%2e%2fauth", "a/b", "a\\b", "．．"]) {
      expect(parseUuid(value)).toBeNull();
    }
  });

  it("accepts u64 boundaries and rejects ambiguous numbers", () => {
    expect(parseU64("0")).toBe("0");
    expect(parseU64("18446744073709551615")).toBe("18446744073709551615");
    for (const value of ["01", "-1", "18446744073709551616", "1e3", "1.0", " 1"]) {
      expect(parseU64(value)).toBeNull();
    }
  });

  it("accepts slugs used by seeded markets", () => {
    expect(parseRecordId("e2e-market-1")).toBe("e2e-market-1");
    expect(parseRecordId("../../etc/passwd")).toBeNull();
  });

  it("normalises transaction hashes", () => {
    const hash = "AB".repeat(32);
    expect(parseTxHash(hash)).toBe(hash.toLowerCase());
    expect(parseTxHash(`0x${hash}`)).toBe(hash.toLowerCase());
    expect(parseTxHash("a".repeat(63))).toBeNull();
  });

  it("accepts only well-formed CIDs", () => {
    expect(parseCid(CID)).toBe(CID);
    expect(parseCid(`ipfs://${CID}`)).toBe(CID);
    for (const value of ["demo-trace-placeholder", `${CID}/path`, `${CID}?x=1`, `${CID}#frag`, "ipfs://"]) {
      expect(parseCid(value)).toBeNull();
    }
  });

  it("accepts G accounts and C contracts, rejecting the other kind", () => {
    expect(parseAccount(G)).toBe(G);
    expect(parseAccount(C)).toBeNull();
    expect(parseContract(C)).toBe(C);
    expect(parseContract(G)).toBeNull();
    expect(parseAccount("GABC")).toBeNull();
  });

  it("rejects non-strings and overlong input", () => {
    for (const value of [null, undefined, 1, {}, [], "x".repeat(600)]) {
      expect(parseUuid(value)).toBeNull();
      expect(parseU64(value)).toBeNull();
      expect(parseTxHash(value)).toBeNull();
      expect(parseCid(value)).toBeNull();
      expect(parseAccount(value)).toBeNull();
    }
  });

  it("assertValid throws a ValidationError with the field name", () => {
    expect(assertValid(parseUuid(UUID), "trace id")).toBe(UUID);
    expect(() => assertValid(parseUuid("../x"), "trace id")).toThrow(ValidationError);
    expect(() => assertValid(parseUuid("../x"), "trace id")).toThrow("Invalid trace id");
  });
});
