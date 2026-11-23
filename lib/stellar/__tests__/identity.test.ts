import { describe, expect, it } from "vitest";
import { identityKey, parseLoginIdentity } from "../identity";

describe("LoginIdentity", () => {
  it("keeps a plain G identity", () => {
    const parsed = parseLoginIdentity("GCM7WU3RADBCIKBLGPPAEYV5WHASWMEQX6BU524QR3QFWSE7BIWCXAIF");
    expect(parsed.ok).toBe(true);
  });

  it("rejects invalid memo values and memo with muxed", () => {
    expect(parseLoginIdentity("GCM7WU3RADBCIKBLGPPAEYV5WHASWMEQX6BU524QR3QFWSE7BIWCXAIF", "-1").ok).toBe(false);
    expect(parseLoginIdentity("GCM7WU3RADBCIKBLGPPAEYV5WHASWMEQX6BU524QR3QFWSE7BIWCXAIF", "18446744073709551616").ok).toBe(false);
    expect(parseLoginIdentity("M012345", "1").ok).toBe(false);
  });

  it("normalizes a memo identity key", () => {
    const account = "GCM7WU3RADBCIKBLGPPAEYV5WHASWMEQX6BU524QR3QFWSE7BIWCXAIF";
    const parsed = parseLoginIdentity(account, "42");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(identityKey(parsed.id)).toBe(`${account}#memo:42`);
  });
});
