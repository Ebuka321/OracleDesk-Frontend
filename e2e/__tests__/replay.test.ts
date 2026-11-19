import { afterEach, describe, expect, it } from "vitest";
import { computeRpcDigest, installReplay, type ReplayFixtures } from "../fixtures/replay";

describe("Hermetic Replay Transport", () => {
  let restore: (() => void) | null = null;

  afterEach(() => {
    if (restore) {
      restore();
      restore = null;
    }
  });

  const dummyFixtures: ReplayFixtures = {
    meta: {
      contractsCommit: "abc1234",
      network: "testnet",
      rpcUrl: "https://soroban-testnet.stellar.org",
      recordedAt: "2026-11-19T00:00:00.000Z",
      sdkVersion: "16.3.1",
      deployments: { marketCore: "CDUMMY" },
    },
    rpcCalls: [
      {
        method: "simulateTransaction",
        paramsDigest: computeRpcDigest("simulateTransaction", {
          transaction: "AAAA",
          sequence: 0,
        }),
        result: { minResourceFee: "100", results: [{ xdr: "AAAA" }] },
      },
    ],
    httpCalls: [
      {
        method: "GET",
        path: "/markets?status=RESOLVED&onChain=true",
        status: 200,
        body: { ok: true, data: [{ id: "m1", onChainMarketId: "1", contractCategory: "Crypto" }] },
      },
    ],
  };

  it("replays matching JSON-RPC request and rewrites response ID", async () => {
    restore = installReplay(dummyFixtures);

    const res = await fetch("https://soroban-testnet.stellar.org", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 999,
        method: "simulateTransaction",
        params: { transaction: "AAAA", sequence: 42 }, // sequence normalized to 0 in digest
      }),
    });

    const json = await res.json();
    expect(json.id).toBe(999);
    expect(json.result.minResourceFee).toBe("100");
  });

  it("replays matching HTTP GET request", async () => {
    restore = installReplay(dummyFixtures);

    const res = await fetch("http://localhost:8000/api/v1/markets?status=RESOLVED&onChain=true");
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.data[0].id).toBe("m1");
  });

  it("throws actionable error for unrecorded request", async () => {
    restore = installReplay(dummyFixtures);

    await expect(fetch("http://localhost:8000/api/v1/unknown-endpoint")).rejects.toThrow(
      /Unrecorded request: GET \/unknown-endpoint; run npm run fixtures:record/
    );
  });
});
