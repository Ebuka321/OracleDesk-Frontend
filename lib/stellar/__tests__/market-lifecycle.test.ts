import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import type { Market } from "../generated/market-core";
import { buildLifecycle, type TimelineEvent } from "../market-lifecycle";
import {
  DB_VERSION,
  LIFECYCLE_STORE,
  lifecycleCacheKey,
  readLifecycleCache,
  writeLifecycleCache,
} from "../price-history";

const baseMarket = (overrides: Partial<Market> = {}): Market =>
  ({
    id: 7n,
    creator: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    close_time: 1_760_790_000n,
    lp_claimed: false,
    status: { tag: "Open", values: undefined },
    reserve_yes: 100_000_000n,
    reserve_no: 100_000_000n,
    fee_bps: 100,
    sets_minted: 100_000_000n,
    resolution_hash: Buffer.alloc(32),
    ...overrides,
  }) as unknown as Market;

const win = { oldestLedger: 900, latestLedger: 1200, ledgerRetentionWindow: 300 };

describe("market-lifecycle", () => {
  it("orders entries across contracts by ledger then event id", () => {
    const events: TimelineEvent[] = [
      {
        kind: "ResolutionProposed",
        id: "0002",
        ledger: 1010,
        closedAt: "2026-10-18T12:05:00Z",
        txHash: "b".repeat(64),
        outcome: "Yes",
      },
      {
        kind: "MarketCreated",
        id: "0001",
        ledger: 1000,
        closedAt: "2026-10-18T12:00:00Z",
        txHash: "a".repeat(64),
        creator: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
        closeTime: 1_760_790_000n,
        seedAmount: 100_000_000n,
        initialYesBps: 5000,
      },
      {
        kind: "TracePublished",
        id: "0001",
        ledger: 1005,
        closedAt: "2026-10-18T12:02:00Z",
        txHash: "c".repeat(64),
        traceId: 1n,
        agent: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
        action: "BUY_YES",
        ipfsCid: "bafy123",
      },
    ];

    const out = buildLifecycle({
      events,
      market: baseMarket(),
      resolverState: "SignersPending",
      traces: [],
      window: win,
      partial: false,
    });
    expect(out.map((e) => e.kind)).toEqual(["created", "trace", "proposed"]);
  });

  it("void via MarketResolved None renders voided", () => {
    const out = buildLifecycle({
      events: [
        {
          kind: "MarketCreated",
          id: "1",
          ledger: 1000,
          closedAt: "2026-10-18T12:00:00Z",
          txHash: "a".repeat(64),
          creator: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
          closeTime: 1_760_790_000n,
          seedAmount: 100_000_000n,
          initialYesBps: 5000,
        },
        {
          kind: "MarketResolved",
          id: "2",
          ledger: 1050,
          closedAt: "2026-10-18T12:30:00Z",
          txHash: "b".repeat(64),
          outcome: null,
        },
      ],
      market: baseMarket(),
      resolverState: "Expired",
      traces: [],
      window: win,
      partial: false,
    });
    const voided = out.find((e) => e.kind === "voided");
    expect(voided).toBeTruthy();
    expect(voided?.detail.voidReason).toMatch(/Guardian void/i);
  });

  it("missing MarketCreated inside retention yields state-derived created plus retention-gap", () => {
    const out = buildLifecycle({
      events: [],
      market: baseMarket(),
      resolverState: "Unconfigured",
      traces: [],
      window: win,
      partial: false,
    });
    expect(out[0]).toMatchObject({ kind: "created", source: "state", ledger: null });
    expect(out[1]).toMatchObject({ kind: "retention-gap", ledger: 900 });
  });

  it("lp_claimed without a transfer event yields state-derived pool-claimed", () => {
    const out = buildLifecycle({
      events: [],
      market: baseMarket({ lp_claimed: true }),
      resolverState: "Finalized",
      traces: [],
      window: win,
      partial: false,
    });
    expect(out.some((e) => e.kind === "pool-claimed" && e.source === "state" && e.ledger === null)).toBe(
      true,
    );
  });

  it("trades are bucketed with bigint sums and before/after bps", () => {
    const out = buildLifecycle({
      events: [
        {
          kind: "MarketCreated",
          id: "0",
          ledger: 1000,
          closedAt: "2026-10-18T12:00:00Z",
          txHash: "a".repeat(64),
          creator: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
          closeTime: 1_760_790_000n,
          seedAmount: 100_000_000n,
          initialYesBps: 5000,
        },
        {
          kind: "Trade",
          id: "1",
          ledger: 1001,
          closedAt: "2026-10-18T12:10:00Z",
          txHash: "b".repeat(64),
          trader: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
          outcome: "Yes",
          isBuy: true,
          collateral: 10_000_000n,
          shares: 10_000_000n,
          fee: 100_000n,
          reserveYes: 90_000_000n,
          reserveNo: 110_000_000n,
        },
        {
          kind: "Trade",
          id: "2",
          ledger: 1002,
          closedAt: "2026-10-18T12:20:00Z",
          txHash: "c".repeat(64),
          trader: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
          outcome: "Yes",
          isBuy: false,
          collateral: 5_000_000n,
          shares: 5_000_000n,
          fee: 50_000n,
          reserveYes: 95_000_000n,
          reserveNo: 105_000_000n,
        },
      ],
      market: baseMarket(),
      resolverState: "Unconfigured",
      traces: [],
      window: win,
      partial: false,
    });
    const bucket = out.find((e) => e.kind === "trades");
    expect(bucket).toBeTruthy();
    expect(bucket?.detail.count).toBe("2");
    expect(bucket?.detail.buyCollateralRaw).toBe("10000000");
    expect(bucket?.detail.sellCollateralRaw).toBe("5000000");
    expect(bucket?.detail.yesBpsBefore).toBe("5500");
    expect(bucket?.detail.yesBpsAfter).toBe("5250");
  });

  it("price-resolution and market resolved in the same tx are grouped", () => {
    const sharedTx = "d".repeat(64);
    const out = buildLifecycle({
      events: [
        {
          kind: "PriceResolution",
          id: "1",
          ledger: 1100,
          closedAt: "2026-10-18T13:00:00Z",
          txHash: sharedTx,
          outcome: "Yes",
          price: 100n,
        },
        {
          kind: "MarketResolved",
          id: "2",
          ledger: 1100,
          closedAt: "2026-10-18T13:00:00Z",
          txHash: sharedTx,
          outcome: "Yes",
        },
      ],
      market: baseMarket(),
      resolverState: "Finalized",
      traces: [],
      window: win,
      partial: false,
    });
    const priceRes = out.find((e) => e.kind === "price-resolution");
    const resolved = out.find((e) => e.kind === "resolved");
    expect(priceRes?.detail.groupedWithTx).toBe(sharedTx);
    expect(resolved?.detail.groupedWithTx).toBe(sharedTx);
  });

  it("upgrades oracledesk-history DB to version 2 while keeping series entries", async () => {
    // Seed v1 database with a series entry
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open("oracledesk-history", 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("series")) db.createObjectStore("series");
      };
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction("series", "readwrite");
        tx.objectStore("series").put({ v: 1, points: [], cursor: null, toLedger: 50, coverage: { fromLedger: 1, toLedger: 50, complete: true } }, "k1");
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });

    expect(DB_VERSION).toBe(2);
    const key = lifecycleCacheKey("7");
    await writeLifecycleCache(key, {
      v: 1,
      events: [],
      toLedger: 100,
      cursors: {},
      coverage: { fromLedger: 1, toLedger: 100, complete: true },
    });
    const cached = await readLifecycleCache(key);
    expect(cached?.toLedger).toBe(100);

    // Verify series store survived v1 -> v2 upgrade
    const seriesVal = await new Promise<unknown>((resolve, reject) => {
      const req = indexedDB.open("oracledesk-history", 2);
      req.onsuccess = () => {
        const db = req.result;
        expect(db.objectStoreNames.contains(LIFECYCLE_STORE)).toBe(true);
        const getReq = db.transaction("series", "readonly").objectStore("series").get("k1");
        getReq.onsuccess = () => { db.close(); resolve(getReq.result); };
        getReq.onerror = () => reject(getReq.error);
      };
    });
    expect(seriesVal).toMatchObject({ v: 1, toLedger: 50 });
  });
});
