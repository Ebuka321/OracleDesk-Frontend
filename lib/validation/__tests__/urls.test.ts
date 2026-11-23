import { describe, expect, it } from "vitest";
import { hostsFrom, safeExternalUrl } from "../urls";

const allowed = ["stellar.expert", "*.pinata.cloud"];

describe("safeExternalUrl", () => {
  it("accepts https URLs on an allowed host", () => {
    expect(safeExternalUrl("https://stellar.expert/explorer/testnet/tx/abc", allowed)).toBe(
      "https://stellar.expert/explorer/testnet/tx/abc",
    );
    expect(safeExternalUrl("https://gateway.pinata.cloud/ipfs/bafy", allowed)).toBe(
      "https://gateway.pinata.cloud/ipfs/bafy",
    );
  });

  it("rejects javascript, data and http URLs", () => {
    expect(safeExternalUrl("javascript:alert(1)", allowed)).toBeNull();
    expect(safeExternalUrl("data:text/html,hi", allowed)).toBeNull();
    expect(safeExternalUrl("http://stellar.expert/tx/abc", allowed)).toBeNull();
  });

  it("rejects credentials and unknown hosts", () => {
    expect(safeExternalUrl("https://user:pass@stellar.expert/x", allowed)).toBeNull();
    expect(safeExternalUrl("https://evil.example/x", allowed)).toBeNull();
  });

  it("rejects non-strings and overlong input", () => {
    expect(safeExternalUrl(null, allowed)).toBeNull();
    expect(safeExternalUrl({ url: "https://stellar.expert" }, allowed)).toBeNull();
    expect(safeExternalUrl(`https://stellar.expert/${"a".repeat(3000)}`, allowed)).toBeNull();
  });

  it("derives hostnames from configured endpoints", () => {
    expect(hostsFrom(["https://api.example.com/api/v1", null, "not a url"])).toEqual(["api.example.com"]);
  });
});
