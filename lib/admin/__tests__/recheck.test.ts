import { describe, expect, it } from "vitest";
import { classifyDrift, findingKey, type DriftFinding } from "../drift";
import { recheckFindings, type RecheckDeps } from "../recheck";
import type { Market as ChainMarket, MarketStatus } from "@/lib/stellar/generated/market-core";
import type { BatchedMarket } from "@/lib/stellar/market-batch";
import type { Market as BackendMarket } from "@/lib/api/markets";

const NOW = new Date("2026-10-18T12:00:00Z");
const CLOSE = Math.floor(NOW.getTime() / 1_000) - 3_600;
const open: MarketStatus = { tag: "Open", values: undefined };
const resolvedYes: MarketStatus = { tag: "Resolved", values: [{ tag: "Yes", values: undefined }] };

function chainMarket(status: MarketStatus = open): ChainMarket {
  return {
    close_time: BigInt(CLOSE),
    reserve_yes: 500n,
    reserve_no: 500n,
    question_hash: Buffer.alloc(32, 1),
    resolution_hash: Buffer.alloc(32, 2),
    meta_uri: "ipfs://q",
    status,
  } as unknown as ChainMarket;
}

function backendMarket(prob = 0.6): BackendMarket {
  return {
    id: "m1",
    status: "RESOLVING",
    currentYesProb: prob,
    expiryTimestamp: new Date(CLOSE * 1_000).toISOString(),
    questionHash: Buffer.alloc(32, 1).toString("hex"),
    resolutionHash: Buffer.alloc(32, 2).toString("hex"),
    metaUri: "ipfs://q",
  } as BackendMarket;
}

function finding(over: Partial<DriftFinding> = {}): DriftFinding {
  return {
    id: "f1",
    runId: "run-1",
    marketId: "m1",
    onChainMarketId: "1",
    driftClass: "PRICE_STALE",
    dbValue: { currentYesProb: 0.6 },
    chainValue: { currentYesProb: 0.5 },
    action: "REPORTED",
    observedLedger: 100,
    ...over,
  };
}

function batched(market = chainMarket(), ledger = 100): Map<string, BatchedMarket> {
  const view = { id: "1", market, yesBps: 5_000, ledger };
  return new Map([["1", { view, ledger, liveUntil: null, via: "ledger-entry" as const }]]);
}

function deps(over: Partial<RecheckDeps> = {}): RecheckDeps {
  return {
    batcher: {
      loadMany: async (ids) => new Map(ids.map((id) => {
        const view = { id: String(id), market: chainMarket(), yesBps: 5_000, ledger: 100 };
        return [String(id), { view, ledger: 100, liveUntil: null, via: "ledger-entry" as const }];
      })),
    },
    backendMarket: async () => backendMarket(),
    ledgerTime: async () => NOW.getTime(),
    ...over,
  };
}

describe("recheckFindings", () => {
  it("reports still-holds, resolved and changed from a fresh ledger read", async () => {
    const stale = finding();
    const [classification] = classifyDrift(
      {
        status: "RESOLVING",
        currentYesProb: 0.6,
        expiryTimestamp: new Date(CLOSE * 1_000).toISOString(),
        questionHash: Buffer.alloc(32, 1).toString("hex"),
        resolutionHash: Buffer.alloc(32, 2).toString("hex"),
        metaUri: "ipfs://q",
      },
      chainMarket(),
      NOW.getTime(),
    );
    expect(classification.driftClass).toBe("PRICE_STALE");

    const results = await recheckFindings(
      [stale, finding({ id: "f2", marketId: "m2" })],
      deps({
        backendMarket: async (id) => (id === "m2" ? backendMarket(0.5) : backendMarket(0.6)),
      }),
    );
    expect(results.get(findingKey(stale))?.status).toBe("still-holds");
    expect(results.get("f2")?.status).toBe("resolved");

    const changed = await recheckFindings(
      [stale],
      deps({
        batcher: { loadMany: async () => batched(chainMarket(resolvedYes), 101) },
      }),
    );
    expect(changed.get("f1")?.status).toBe("changed");
  });

  it("treats MarketNotFound and archived read failures distinctly", async () => {
    const notFound = finding({ driftClass: "NOT_FOUND_ON_CHAIN", onChainMarketId: "9", chainValue: null });
    const notFoundResults = await recheckFindings(
      [notFound],
      deps({ batcher: { loadMany: async () => new Map([["9", new Error("get_market failed: MarketNotFound")]]) } }),
    );
    expect(notFoundResults.get("f1")?.status).toBe("still-holds");

    const archived = await recheckFindings(
      [finding()],
      deps({ batcher: { loadMany: async () => new Map([["1", new Error("market archived")]]) } }),
    );
    expect(archived.get("f1")).toMatchObject({ status: "unverifiable", reason: "archived; restore needed" });
  });

  it("keeps at most three backend reads in flight", async () => {
    const findings = Array.from({ length: 12 }, (_, index) =>
      finding({ id: `f${index}`, marketId: `m${index}`, onChainMarketId: String(index + 1) }),
    );
    let active = 0;
    let max = 0;
    const results = await recheckFindings(
      findings,
      deps({
        backendMarket: async () => {
          active += 1;
          max = Math.max(max, active);
          await new Promise((resolve) => setTimeout(resolve, 2));
          active -= 1;
          return backendMarket();
        },
      }),
    );
    expect(max).toBeLessThanOrEqual(3);
    expect(results.size).toBe(12);
  });

  it("batches chain ids in groups of at most 200", async () => {
    const sizes: number[] = [];
    const findings = Array.from({ length: 201 }, (_, index) =>
      finding({ id: `f${index}`, marketId: "m1", onChainMarketId: String(index + 1) }),
    );
    const results = await recheckFindings(
      findings,
      deps({
        batcher: {
          loadMany: async (ids) => {
            sizes.push(ids.length);
            const entries = new Map<string, BatchedMarket>();
            for (const id of ids) {
              const view = { id: String(id), market: chainMarket(), yesBps: 5_000, ledger: 100 };
              entries.set(String(id), { view, ledger: 100, liveUntil: null, via: "ledger-entry" });
            }
            return entries;
          },
        },
      }),
    );
    expect(sizes).toEqual([200, 1]);
    expect(results.size).toBe(201);
  });
});
