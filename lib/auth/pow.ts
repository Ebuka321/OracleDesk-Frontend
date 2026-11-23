import { Sha256 } from "@/lib/stellar/sha256";
import { StrKey } from "@stellar/stellar-sdk";

export const POW_PREFIX = "oracledesk-auth:";

export function baseAccountOf(address: string): string {
  if (address.startsWith("M")) {
    try {
      const decoded = StrKey.decodeMed25519PublicKey(address);
      return StrKey.encodeEd25519PublicKey(decoded.subarray(0, 32));
    } catch {
      return address;
    }
  }
  return address;
}

const textEncoder = new TextEncoder();

export function powPreimage(account: string, nonce: string, salt: string): Uint8Array {
  const baseAccount = baseAccountOf(account);
  return textEncoder.encode(`${POW_PREFIX}${baseAccount}:${nonce}:${salt}`);
}

export function leadingZeroBits(d: Uint8Array): number {
  let count = 0;
  for (let i = 0; i < d.length; i++) {
    const b = d[i];
    if (b === 0) {
      count += 8;
    } else {
      count += Math.clz32(b) - 24;
      break;
    }
  }
  return count;
}

export function verifyPow(account: string, nonce: string, salt: string, bits: number): boolean {
  const preimage = powPreimage(account, nonce, salt);
  const hasher = new Sha256();
  hasher.update(preimage);
  const digest = hasher.digest();
  return leadingZeroBits(digest) >= bits;
}

export interface SolveOptions {
  account: string;
  salt: string;
  bits: number;
  startNonce?: bigint;
  batch?: number;
  signal?: AbortSignal;
  onProgress?: (tried: number) => void;
}

/**
 * Pure generator yielding progress ({ tried }) and eventually the winning nonce ({ nonce }).
 * Uses Sha256 midstate cloning to avoid re-hashing the static prefix block.
 */
export function* solveSteps(o: SolveOptions): Generator<{ tried: number } | { nonce: string }> {
  const { account, salt, bits, signal } = o;
  const baseAccount = baseAccountOf(account);
  const batch = o.batch ?? 2000;

  // Random 48-bit initial offset when not specified so parallel tabs don't search the same space
  let nonce = o.startNonce ?? BigInt(Math.floor(Math.random() * 0xffffffffffff));

  const prefixBytes = textEncoder.encode(`${POW_PREFIX}${baseAccount}:`);
  const saltBytes = textEncoder.encode(`:${salt}`);

  const baseHasher = new Sha256();
  let remainingPrefix: Uint8Array;
  if (prefixBytes.length >= 64) {
    baseHasher.update(prefixBytes.subarray(0, 64));
    remainingPrefix = prefixBytes.subarray(64);
  } else {
    remainingPrefix = prefixBytes;
  }

  let tried = 0;

  while (!signal?.aborted) {
    for (let i = 0; i < batch; i++) {
      const nonceStr = nonce.toString();
      const nonceBytes = textEncoder.encode(nonceStr);

      const h = baseHasher.clone();
      if (remainingPrefix.length > 0) {
        h.update(remainingPrefix);
      }
      h.update(nonceBytes);
      h.update(saltBytes);

      const digest = h.digest();
      tried++;
      nonce++;

      if (leadingZeroBits(digest) >= bits) {
        yield { nonce: nonceStr };
        return;
      }
    }

    o.onProgress?.(tried);
    yield { tried };
  }
}
