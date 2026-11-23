import { createHash } from "node:crypto";

export interface RpcCallRecord {
  method: string;
  paramsDigest: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

export interface HttpCallRecord {
  method: string;
  path: string;
  status: number;
  body: unknown;
}

export interface ReplayFixtures {
  meta: {
    contractsCommit: string;
    network: string;
    rpcUrl: string;
    recordedAt: string;
    sdkVersion: string;
    deployments: Record<string, string>;
  };
  rpcCalls: RpcCallRecord[];
  httpCalls: HttpCallRecord[];
}

/**
 * Computes canonical digest for an RPC call ignoring sequence numbers and IDs.
 */
export function computeRpcDigest(method: string, params: unknown): string {
  const normalizedParams = normalizeForDigest(params);
  const canonicalStr = JSON.stringify({ method, params: normalizedParams }, Object.keys({ method, params: normalizedParams }).sort());
  return createHash("sha256").update(canonicalStr).digest("hex");
}

function normalizeForDigest(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(normalizeForDigest);

  const obj = value as Record<string, unknown>;
  const copy: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    // Zero out volatile fields for matching
    if (k === "id") continue;
    if (k === "sequence" || k === "minResourceFee" || k === "cost") {
      copy[k] = 0;
    } else {
      copy[k] = normalizeForDigest(v);
    }
  }
  return copy;
}

/**
 * Installs hermetic replay interceptor on globalThis.fetch.
 */
export function installReplay(fixtures: ReplayFixtures): () => void {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? (typeof input === "object" && "method" in input ? (input as Request).method : "GET");

    // Match HTTP GET
    if (method.toUpperCase() === "GET") {
      const parsedUrl = new URL(urlStr, "http://localhost");
      const pathWithQuery = parsedUrl.pathname + parsedUrl.search;
      const matched = fixtures.httpCalls.find(
        (h) => h.method.toUpperCase() === "GET" && (pathWithQuery.endsWith(h.path) || h.path.endsWith(pathWithQuery))
      );

      if (!matched) {
        throw new Error(
          `Unrecorded request: GET ${pathWithQuery}; run npm run fixtures:record`
        );
      }
      return new Response(JSON.stringify(matched.body), {
        status: matched.status,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Match JSON-RPC POST
    if (method.toUpperCase() === "POST") {
      let bodyText = "";
      if (typeof init?.body === "string") {
        bodyText = init.body;
      }

      let parsed: { id?: number | string; method?: string; params?: unknown } = {};
      try {
        parsed = JSON.parse(bodyText);
      } catch {
        // Not JSON
      }

      const rpcMethod = parsed.method ?? "unknown";
      const digest = computeRpcDigest(rpcMethod, parsed.params);

      const matched = fixtures.rpcCalls.find(
        (r) => r.method === rpcMethod && r.paramsDigest === digest
      );

      if (!matched) {
        throw new Error(
          `Unrecorded request: POST ${rpcMethod} (digest: ${digest}); run npm run fixtures:record`
        );
      }

      const responsePayload = {
        jsonrpc: "2.0",
        id: parsed.id ?? 1,
        ...(matched.result !== undefined ? { result: matched.result } : {}),
        ...(matched.error !== undefined ? { error: matched.error } : {}),
      };

      return new Response(JSON.stringify(responsePayload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    throw new Error(`Unrecorded request: ${method} ${urlStr}; run npm run fixtures:record`);
  }) as typeof fetch;

  return () => {
    globalThis.fetch = originalFetch;
  };
}
