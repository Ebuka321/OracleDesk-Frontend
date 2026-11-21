import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  isMarketPricePayload,
  getDroppedMarketPriceCount,
  resetDroppedMarketPriceCount,
  type MarketPricePayload,
} from "../types";
import {
  MarketPriceStore,
  reconcileDisplayPrice,
  SOCKET_PRICE_TICK_MS,
  HEALTHY_STREAM_TIMEOUT_MS,
  MAX_DEFERRAL_LEDGERS,
} from "../market-price-store";
import { LedgerInvalidator } from "@/lib/stellar/ledger-invalidation";

describe("MARKET_PRICE Stream & Provisional Overlay", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetDroppedMarketPriceCount();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("Payload Guard (isMarketPricePayload)", () => {
    const valid: MarketPricePayload = {
      onChainMarketId: "42",
      marketId: "market-uuid-1",
      priceYesBps: 6500,
      ledger: 1000,
      eventId: "evt-001",
      ts: Date.now(),
    };

    it("accepts strictly valid payloads", () => {
      expect(isMarketPricePayload(valid)).toBe(true);
      expect(getDroppedMarketPriceCount()).toBe(0);
    });

    it("drops and counts malformed priceYesBps (<0, >10000, float, NaN)", () => {
      expect(isMarketPricePayload({ ...valid, priceYesBps: -1 })).toBe(false);
      expect(isMarketPricePayload({ ...valid, priceYesBps: 10001 })).toBe(false);
      expect(isMarketPricePayload({ ...valid, priceYesBps: 50.5 })).toBe(false);
      expect(isMarketPricePayload({ ...valid, priceYesBps: NaN })).toBe(false);
      expect(getDroppedMarketPriceCount()).toBe(4);
    });

    it("drops and counts malformed ledger (<=0, float, not safe integer)", () => {
      expect(isMarketPricePayload({ ...valid, ledger: 0 })).toBe(false);
      expect(isMarketPricePayload({ ...valid, ledger: -5 })).toBe(false);
      expect(isMarketPricePayload({ ...valid, ledger: 10.5 })).toBe(false);
      expect(getDroppedMarketPriceCount()).toBe(3);
    });

    it("drops and counts invalid IDs or eventId", () => {
      expect(isMarketPricePayload({ ...valid, onChainMarketId: "" })).toBe(false);
      expect(isMarketPricePayload({ ...valid, onChainMarketId: "not-a-number" })).toBe(false);
      expect(isMarketPricePayload({ ...valid, eventId: "" })).toBe(false);
      expect(isMarketPricePayload({ ...valid, eventId: "x".repeat(200) })).toBe(false);
      expect(getDroppedMarketPriceCount()).toBe(4);
    });
  });

  describe("MarketPriceStore (Latest-Wins & Ordering)", () => {
    it("drops ticks from an older ledger", () => {
      const store = new MarketPriceStore();
      const tick1: MarketPricePayload = {
        onChainMarketId: "1",
        marketId: "m1",
        priceYesBps: 5000,
        ledger: 100,
        eventId: "evt-1",
        ts: 1000,
      };
      const olderTick: MarketPricePayload = {
        onChainMarketId: "1",
        marketId: "m1",
        priceYesBps: 6000,
        ledger: 99,
        eventId: "evt-2",
        ts: 1001,
      };

      expect(store.applyTick(tick1)).toBe(true);
      expect(store.applyTick(olderTick)).toBe(false);
      expect(store.getProvisionalPrice("1")?.priceYesBps).toBe(5000);
      store.dispose();
    });

    it("drops equal-ledger ticks with older or equal eventId", () => {
      const store = new MarketPriceStore();
      const tick1: MarketPricePayload = {
        onChainMarketId: "1",
        marketId: "m1",
        priceYesBps: 5000,
        ledger: 100,
        eventId: "b-event",
        ts: 1000,
      };
      const olderEventTick: MarketPricePayload = {
        onChainMarketId: "1",
        marketId: "m1",
        priceYesBps: 5500,
        ledger: 100,
        eventId: "a-event", // older lexicographically
        ts: 1001,
      };
      const newerEventTick: MarketPricePayload = {
        onChainMarketId: "1",
        marketId: "m1",
        priceYesBps: 6000,
        ledger: 100,
        eventId: "c-event", // newer lexicographically
        ts: 1002,
      };

      expect(store.applyTick(tick1)).toBe(true);
      expect(store.applyTick(olderEventTick)).toBe(false); // dropped
      expect(store.applyTick(tick1)).toBe(false); // duplicate dropped
      expect(store.applyTick(newerEventTick)).toBe(true); // accepted
      expect(store.getProvisionalPrice("1")?.priceYesBps).toBe(6000);
      store.dispose();
    });
  });

  describe("reconcileDisplayPrice (Overlay NEVER Beats Chain Read)", () => {
    it("never overrides a chain read at an equal or newer ledger", () => {
      const provisional = {
        _brand: "PROVISIONAL_DISPLAY_ONLY" as const,
        onChainMarketId: "1",
        marketId: "m1",
        priceYesBps: 7000,
        ledger: 105,
        eventId: "e1",
        ts: 1000,
        receivedAt: 1000,
      };

      // Case 1: Chain read is newer (106 > 105) -> chain wins
      const resNewerChain = reconcileDisplayPrice(4500, 106, provisional);
      expect(resNewerChain.isProvisional).toBe(false);
      expect(resNewerChain.priceYesBps).toBe(4500);
      expect(resNewerChain.ledger).toBe(106);

      // Case 2: Chain read is equal ledger (105 == 105) -> chain wins
      const resEqualChain = reconcileDisplayPrice(4500, 105, provisional);
      expect(resEqualChain.isProvisional).toBe(false);
      expect(resEqualChain.priceYesBps).toBe(4500);
      expect(resEqualChain.ledger).toBe(105);

      // Case 3: Provisional is strictly newer (105 > 104) -> provisional overlay applies
      const resOlderChain = reconcileDisplayPrice(4500, 104, provisional);
      expect(resOlderChain.isProvisional).toBe(true);
      expect(resOlderChain.priceYesBps).toBe(7000);
      expect(resOlderChain.ledger).toBe(105);
    });
  });

  describe("Stream Health & Invalidation Deferral", () => {
    it("considers stream healthy on tick and stalls after timeout", () => {
      const store = new MarketPriceStore();
      const stallCallback = vi.fn();
      store.subscribeStall(stallCallback);

      store.applyTick({
        onChainMarketId: "1",
        marketId: "m1",
        priceYesBps: 5000,
        ledger: 100,
        eventId: "e1",
        ts: Date.now(),
      });

      expect(store.isStreamHealthy("1")).toBe(true);
      expect(stallCallback).toHaveBeenCalledWith("1", true);

      // Advance time past HEALTHY_STREAM_TIMEOUT_MS
      vi.advanceTimersByTime(HEALTHY_STREAM_TIMEOUT_MS + 10);

      expect(store.isStreamHealthy("1")).toBe(false);
      expect(stallCallback).toHaveBeenCalledWith("1", false);
      store.dispose();
    });

    it("defers invalidation while healthy up to MAX_DEFERRAL_LEDGERS, then forces invalidation", () => {
      const store = new MarketPriceStore();
      store.applyTick({
        onChainMarketId: "1",
        marketId: "m1",
        priceYesBps: 5000,
        ledger: 100,
        eventId: "e1",
        ts: Date.now(),
      });

      for (let i = 0; i < MAX_DEFERRAL_LEDGERS; i++) {
        expect(store.shouldDeferInvalidation("1")).toBe(true);
      }

      // Hard upper bound reached: must not defer
      expect(store.shouldDeferInvalidation("1")).toBe(false);
      store.dispose();
    });

    it("never defers invalidation after user local write", () => {
      const store = new MarketPriceStore();
      store.applyTick({
        onChainMarketId: "1",
        marketId: "m1",
        priceYesBps: 5000,
        ledger: 100,
        eventId: "e1",
        ts: Date.now(),
      });

      expect(store.isStreamHealthy("1")).toBe(true);

      // User performs local write
      store.recordLocalWrite("1");

      // Immediate invalidation required: shouldDeferInvalidation MUST return false
      expect(store.shouldDeferInvalidation("1")).toBe(false);
      store.dispose();
    });

    it("LedgerInvalidator resumes and flushes deferred keys when stream stalls", () => {
      const queryClient = {
        invalidateQueries: vi.fn(),
      };
      const store = new MarketPriceStore();
      const invalidator = new LedgerInvalidator({
        queryClient: queryClient as any,
        priceStore: store,
      });

      invalidator.start();

      // Make stream healthy
      store.applyTick({
        onChainMarketId: "5",
        marketId: "m5",
        priceYesBps: 5200,
        ledger: 100,
        eventId: "e5",
        ts: Date.now(),
      });

      // Simulate Trade event processed while healthy
      invalidator.invalidateForEvents(
        [
          {
            type: "contract",
            contractId: "marketCore",
            topic: ["Trade"],
            value: "",
          } as any,
        ],
        null
      );

      // Now let stream stall
      vi.advanceTimersByTime(HEALTHY_STREAM_TIMEOUT_MS + 20);

      expect(store.isStreamHealthy("5")).toBe(false);

      invalidator.stop();
      store.dispose();
    });
  });
});
