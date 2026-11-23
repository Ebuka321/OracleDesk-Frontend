import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { normalizeDigest, sha256Hex, verifyAssetBytes } from "../integrity";

describe("lib/pwa/integrity", () => {
  const content = "console.log('hello world');\n";
  const bytes = new TextEncoder().encode(content);
  const expectedHash = createHash("sha256").update(bytes).digest("hex");

  describe("normalizeDigest", () => {
    it("handles raw hex, sha256: prefix, and uppercase", () => {
      expect(normalizeDigest(expectedHash)).toBe(expectedHash.toLowerCase());
      expect(normalizeDigest(`sha256:${expectedHash}`)).toBe(expectedHash.toLowerCase());
      expect(normalizeDigest(`SHA256:${expectedHash.toUpperCase()}`)).toBe(expectedHash.toLowerCase());
    });

    it("handles SRI format", () => {
      const b64 = Buffer.from(expectedHash, "hex").toString("base64");
      expect(normalizeDigest(`sha256-${b64}`)).toBe(expectedHash.toLowerCase());
    });
  });

  describe("sha256Hex", () => {
    it("computes matching SHA-256 hex string", async () => {
      const computed = await sha256Hex(bytes);
      expect(computed).toBe(expectedHash);
    });
  });

  describe("verifyAssetBytes", () => {
    it("succeeds for valid bytes and matching digest and size", async () => {
      const res = await verifyAssetBytes(bytes, expectedHash, bytes.byteLength);
      expect(res.valid).toBe(true);
      expect(res.actualDigest).toBe(expectedHash);
      expect(res.actualSize).toBe(bytes.byteLength);
      expect(res.reason).toBeUndefined();
    });

    it("succeeds when expected size is omitted", async () => {
      const res = await verifyAssetBytes(bytes, expectedHash);
      expect(res.valid).toBe(true);
    });

    it("fails for tampered bytes with mismatching digest", async () => {
      const tamperedBytes = new TextEncoder().encode("console.log('tampered content');\n");
      const res = await verifyAssetBytes(tamperedBytes, expectedHash, tamperedBytes.byteLength);
      expect(res.valid).toBe(false);
      expect(res.reason).toMatch(/Digest mismatch/i);
      expect(res.actualDigest).not.toBe(expectedHash);
    });

    it("fails for wrong-size bytes", async () => {
      const wrongSize = bytes.byteLength + 10;
      const res = await verifyAssetBytes(bytes, expectedHash, wrongSize);
      expect(res.valid).toBe(false);
      expect(res.reason).toMatch(/Size mismatch/i);
    });
  });
});
