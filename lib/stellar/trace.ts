import { IPFS_GATEWAY } from "./config";
import { openTraceCache } from "./trace-cache";

/**
 * Browser port of x402/trace-verification.ts from the contracts repo:
 * hash the exact bytes received and compare with the on-chain trace_hash.
 * Uses WebCrypto, so the checks are async.
 */

const toHex = (buf: ArrayBuffer) =>
  Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");

export async function sha256Hex(content: Uint8Array): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", content as BufferSource));
}

export function normalizeHash(hash: string): string {
  return hash.toLowerCase().replace(/^0x/, "");
}

export async function verifyTraceHash(content: Uint8Array, expectedHash: string): Promise<boolean> {
  const normalized = normalizeHash(expectedHash);
  return /^[0-9a-f]{64}$/.test(normalized) && (await sha256Hex(content)) === normalized;
}

/** Gateway URL for a CID; accepts bare CIDs and ipfs:// URIs. */
export function ipfsUrl(cid: string, gateway: string = IPFS_GATEWAY): string {
  const bare = cid.replace(/^ipfs:\/\//, "");
  const base = gateway.endsWith("/") ? gateway.slice(0, -1) : gateway;
  return `${base}/${encodeURIComponent(bare)}`;
}

export type TraceCheck =
  | { status: "verified"; content: unknown; computedHash: string; source: "network" | "cache" }
  | { status: "mismatch"; computedHash: string }
  | { status: "unavailable"; reason: string };

const inflight = new Map<string, Promise<TraceCheck>>();
let traceCache: ReturnType<typeof openTraceCache> | null = null;

function getTraceCache() {
  if (!traceCache) {
    traceCache = openTraceCache({
      budgetBytes: 25 * 1024 * 1024,
      maxEntryBytes: 8 * 1024 * 1024,
      enabled: () => {
        if (typeof window === "undefined") return false;
        return window.localStorage.getItem("oracledesk:trace-cache:enabled") !== "false";
      },
    });
  }
  return traceCache;
}

/**
 * Fetches trace content and checks it against the on-chain hash. Content is
 * only returned when it is verified; callers must never render anything
 * else as the trace.
 */
export async function fetchAndVerifyTrace(
  cid: string,
  onChainHash: string,
  fetchImpl: typeof fetch = fetch,
  options: { cacheEnabled?: boolean } = {},
): Promise<TraceCheck> {
  const key = normalizeHash(onChainHash);
  if (options.cacheEnabled !== false) {
    const hit = await getTraceCache().get(key);
    if (hit) {
      const text = new TextDecoder().decode(hit.bytes);
      let content: unknown = text;
      try { content = JSON.parse(text); } catch {}
      return { status: "verified", content, computedHash: key, source: "cache" };
    }
  }
  const existing = inflight.get(key);
  if (existing) return existing;

  const race = (async () => {
    let bytes: Uint8Array;
    try {
      const res = await fetchImpl(ipfsUrl(cid));
      if (!res.ok) return { status: "unavailable", reason: `IPFS gateway returned HTTP ${res.status}` } as TraceCheck;
      bytes = new Uint8Array(await res.arrayBuffer());
    } catch {
      return { status: "unavailable", reason: "Couldn't reach the IPFS gateway" } as TraceCheck;
    }
    const computedHash = await sha256Hex(bytes);
    if (computedHash !== normalizeHash(onChainHash)) return { status: "mismatch", computedHash } as TraceCheck;
    if (options.cacheEnabled !== false) {
      void getTraceCache().put(normalizedHash(onChainHash), bytes, {
        cid,
        contentKind: looksLikeJson(bytes) ? "json" : "text",
      }).catch(() => {});
    }
    try {
      return { status: "verified", content: JSON.parse(new TextDecoder().decode(bytes)), computedHash, source: "network" } as TraceCheck;
    } catch {
      return { status: "verified", content: new TextDecoder().decode(bytes), computedHash, source: "network" } as TraceCheck;
    }
  })();
  inflight.set(key, race);
  try {
    return await race;
  } finally {
    inflight.delete(key);
  }
}

function normalizedHash(hash: string) {
  return normalizeHash(hash);
}

function looksLikeJson(bytes: Uint8Array) {
  const text = new TextDecoder().decode(bytes).trim();
  return text.startsWith("{") || text.startsWith("[");
}
