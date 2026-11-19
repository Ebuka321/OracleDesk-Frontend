import { describe, expect, it } from "vitest";
import { assertNoSecrets, normalizeLedgerFields } from "../record-fixtures.mjs";

describe("normalizeLedgerFields", () => {
  it("normalizes volatile ledger numbers and fee fields", () => {
    const raw = {
      latestLedger: 123456,
      oldestLedger: 100000,
      latestLedgerCloseTime: 1730000000,
      cost: { cpuInsns: "123456" },
      minResourceFee: "100",
      id: 42,
      entries: [
        {
          key: "AAAA",
          lastModifiedLedgerSeq: 98765,
        },
      ],
    };

    const normalized = normalizeLedgerFields(raw);
    expect(normalized.latestLedger).toBe(1000);
    expect(normalized.oldestLedger).toBe(1000);
    expect(normalized.latestLedgerCloseTime).toBe(1000);
    expect(normalized.id).toBe(1);
    expect(normalized.entries[0].lastModifiedLedgerSeq).toBe(0);
  });
});

describe("assertNoSecrets", () => {
  it("passes for public safe content", () => {
    expect(() =>
      assertNoSecrets({
        marketId: "1",
        account: "GCM7WU3RADBCIKBLGPPAEYV5WHASWMEQX6BU524QR3QFWSE7BIWCXAIF",
        hash: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      })
    ).not.toThrow();
  });

  it("rejects Stellar secret seed", () => {
    const secret = "SCZANGBA5YHTNYVVV4C3U252E2B6P6F5T3U64MMHYWCHJWBWDUUQG2Y7";
    expect(() => assertNoSecrets({ key: secret })).toThrow(/Stellar secret seed/);
  });

  it("rejects JWT token", () => {
    const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.signature";
    expect(() => assertNoSecrets({ token: jwt })).toThrow(/JWT/);
  });

  it("rejects Authorization Bearer header", () => {
    expect(() => assertNoSecrets("Authorization: Bearer secret_token_12345")).toThrow(
      /Authorization Bearer/
    );
  });
});
