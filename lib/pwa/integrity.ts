/**
 * Pure verification logic for service worker precache assets.
 * Compatible with both Service Worker SubtleCrypto and Node test environments.
 */

export interface AssetVerificationResult {
  valid: boolean;
  actualDigest: string;
  actualSize: number;
  expectedDigest: string;
  expectedSize?: number | null;
  reason?: string;
}

/**
 * Normalizes a digest string to standard 64-character lowercase hex.
 * Accepts "sha256:<hex>", "<hex>", or SRI format "sha256-<base64>".
 */
export function normalizeDigest(digest: string): string {
  const trimmed = digest.trim();
  if (trimmed.startsWith("sha256:")) {
    return trimmed.slice(7).toLowerCase();
  }
  if (/^[a-fA-F0-9]{64}$/.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  if (trimmed.startsWith("sha256-")) {
    try {
      const b64 = trimmed.slice(7);
      if (typeof Buffer !== "undefined") {
        return Buffer.from(b64, "base64").toString("hex").toLowerCase();
      }
      const binStr = atob(b64);
      const hex = Array.from(binStr, (c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
      return hex.toLowerCase();
    } catch {
      return trimmed.toLowerCase();
    }
  }
  return trimmed.toLowerCase();
}

/**
 * Computes SHA-256 digest of bytes as a lowercase 64-character hex string.
 */
export async function sha256Hex(bytes: Uint8Array | ArrayBuffer): Promise<string> {
  const buffer = bytes instanceof Uint8Array ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : bytes;
  if (typeof crypto !== "undefined" && crypto.subtle) {
    const hashBuf = await crypto.subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(hashBuf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  // Node.js fallback
  try {
    const { createHash } = await import("node:crypto");
    return createHash("sha256").update(Buffer.from(buffer)).digest("hex");
  } catch {
    throw new Error("No cryptographic hash implementation available");
  }
}

/**
 * Verifies that the provided bytes match expected digest and size.
 */
export async function verifyAssetBytes(
  bytes: Uint8Array | ArrayBuffer,
  expectedDigest: string,
  expectedSize?: number | null
): Promise<AssetVerificationResult> {
  const actualSize = bytes.byteLength;
  const normalizedExpected = normalizeDigest(expectedDigest);

  if (expectedSize !== undefined && expectedSize !== null && actualSize !== expectedSize) {
    const actualDigest = await sha256Hex(bytes);
    return {
      valid: false,
      actualDigest,
      actualSize,
      expectedDigest: normalizedExpected,
      expectedSize,
      reason: `Size mismatch: expected ${expectedSize} bytes, received ${actualSize} bytes`,
    };
  }

  const actualDigest = await sha256Hex(bytes);
  if (actualDigest !== normalizedExpected) {
    return {
      valid: false,
      actualDigest,
      actualSize,
      expectedDigest: normalizedExpected,
      expectedSize,
      reason: `Digest mismatch: expected ${normalizedExpected}, computed ${actualDigest}`,
    };
  }

  return {
    valid: true,
    actualDigest,
    actualSize,
    expectedDigest: normalizedExpected,
    expectedSize,
  };
}
