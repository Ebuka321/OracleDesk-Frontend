import type { MarketPricePayload } from "./types";

/**
 * Expected interval in milliseconds between backend MARKET_PRICE socket ticks for an active market.
 */
export const SOCKET_PRICE_TICK_MS = 1000;

/**
 * Configurable multiplier to define a healthy price stream.
 * If no tick arrives within HEALTHY_STREAM_MULTIPLIER * SOCKET_PRICE_TICK_MS, the stream is considered stalled.
 */
export const HEALTHY_STREAM_MULTIPLIER = 3;
export const HEALTHY_STREAM_TIMEOUT_MS = SOCKET_PRICE_TICK_MS * HEALTHY_STREAM_MULTIPLIER; // 3000ms

/**
 * Hard upper bound on how many ledgers an invalidation can be deferred before forcing a chain read.
 */
export const MAX_DEFERRAL_LEDGERS = 5;

/**
 * Local user-write cooldown window in milliseconds during which invalidations are NEVER deferred.
 */
export const USER_WRITE_PROTECTION_MS = 30000;

export interface ProvisionalPrice {
  readonly _brand: "PROVISIONAL_DISPLAY_ONLY";
  onChainMarketId: string;
  marketId: string;
  priceYesBps: number;
  ledger: number;
  eventId: string;
  ts: number;
  receivedAt: number;
}

export type PriceStoreListener = (price: ProvisionalPrice) => void;
export type StallListener = (onChainMarketId: string, isHealthy: boolean) => void;

/**
 * Bounded, per-market latest-wins store for the MARKET_PRICE stream.
 * Strictly ordered by (ledger, then eventId) to reject out-of-order ticks.
 */
export class MarketPriceStore {
  private static readonly MAX_MARKETS = 500;

  private readonly prices = new Map<string, ProvisionalPrice>();
  private readonly stallTimers = new Map<string, NodeJS.Timeout | number>();
  private readonly healthyMarkets = new Set<string>();
  private readonly localWrites = new Map<string, number>();
  private readonly deferredLedgerCounts = new Map<string, number>();

  private readonly priceListeners = new Set<PriceStoreListener>();
  private readonly stallListeners = new Set<StallListener>();

  /**
   * Applies an incoming MARKET_PRICE payload.
   * Returns true if applied, false if dropped (e.g. out-of-order or duplicate).
   */
  applyTick(payload: MarketPricePayload, now = Date.now()): boolean {
    const id = payload.onChainMarketId;
    const existing = this.prices.get(id);

    if (existing) {
      if (payload.ledger < existing.ledger) {
        // Dropped: tick is from an older ledger
        return false;
      }
      if (payload.ledger === existing.ledger && payload.eventId.localeCompare(existing.eventId) <= 0) {
        // Dropped: tick is same ledger but equal or earlier eventId
        return false;
      }
    }

    // Capacity bound
    if (!this.prices.has(id) && this.prices.size >= MarketPriceStore.MAX_MARKETS) {
      const oldestKey = this.prices.keys().next().value;
      if (oldestKey) {
        this.clearMarket(oldestKey);
      }
    }

    const provisional: ProvisionalPrice = {
      _brand: "PROVISIONAL_DISPLAY_ONLY",
      onChainMarketId: payload.onChainMarketId,
      marketId: payload.marketId,
      priceYesBps: payload.priceYesBps,
      ledger: payload.ledger,
      eventId: payload.eventId,
      ts: payload.ts,
      receivedAt: now,
    };

    this.prices.set(id, provisional);
    this.markHealthy(id);

    for (const listener of this.priceListeners) {
      listener(provisional);
    }
    return true;
  }

  getProvisionalPrice(onChainMarketId: string): ProvisionalPrice | undefined {
    return this.prices.get(onChainMarketId);
  }

  isStreamHealthy(onChainMarketId: string): boolean {
    return this.healthyMarkets.has(onChainMarketId);
  }

  recordLocalWrite(onChainMarketId: string, now = Date.now()): void {
    this.localWrites.set(onChainMarketId, now);
    // User write resets deferral count so immediate invalidation happens
    this.deferredLedgerCounts.set(onChainMarketId, 0);
  }

  hasRecentLocalWrite(onChainMarketId: string, now = Date.now()): boolean {
    const at = this.localWrites.get(onChainMarketId);
    if (!at) return false;
    if (now - at > USER_WRITE_PROTECTION_MS) {
      this.localWrites.delete(onChainMarketId);
      return false;
    }
    return true;
  }

  /**
   * Decides whether LedgerInvalidator may defer refetching this market.
   * Never defers if:
   * 1. User has performed a local write on this market recently
   * 2. The stream is stalled/unhealthy for this market
   * 3. Deferrals have reached MAX_DEFERRAL_LEDGERS
   */
  shouldDeferInvalidation(onChainMarketId: string, now = Date.now()): boolean {
    if (this.hasRecentLocalWrite(onChainMarketId, now)) {
      return false;
    }
    if (!this.isStreamHealthy(onChainMarketId)) {
      return false;
    }

    const currentCount = this.deferredLedgerCounts.get(onChainMarketId) ?? 0;
    if (currentCount >= MAX_DEFERRAL_LEDGERS) {
      this.deferredLedgerCounts.set(onChainMarketId, 0);
      return false;
    }

    this.deferredLedgerCounts.set(onChainMarketId, currentCount + 1);
    return true;
  }

  resetDeferral(onChainMarketId: string): void {
    this.deferredLedgerCounts.delete(onChainMarketId);
  }

  private markHealthy(id: string): void {
    const wasHealthy = this.healthyMarkets.has(id);
    this.healthyMarkets.add(id);

    const oldTimer = this.stallTimers.get(id);
    if (oldTimer) clearTimeout(oldTimer);

    const timer = setTimeout(() => {
      this.healthyMarkets.delete(id);
      this.stallTimers.delete(id);
      this.deferredLedgerCounts.set(id, 0);
      for (const listener of this.stallListeners) {
        listener(id, false);
      }
    }, HEALTHY_STREAM_TIMEOUT_MS);

    this.stallTimers.set(id, timer);

    if (!wasHealthy) {
      for (const listener of this.stallListeners) {
        listener(id, true);
      }
    }
  }

  subscribePrice(listener: PriceStoreListener): () => void {
    this.priceListeners.add(listener);
    return () => this.priceListeners.delete(listener);
  }

  subscribeStall(listener: StallListener): () => void {
    this.stallListeners.add(listener);
    return () => this.stallListeners.delete(listener);
  }

  private clearMarket(id: string): void {
    this.prices.delete(id);
    this.healthyMarkets.delete(id);
    this.localWrites.delete(id);
    this.deferredLedgerCounts.delete(id);
    const timer = this.stallTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.stallTimers.delete(id);
    }
  }

  dispose(): void {
    for (const timer of this.stallTimers.values()) {
      clearTimeout(timer);
    }
    this.stallTimers.clear();
    this.prices.clear();
    this.healthyMarkets.clear();
    this.localWrites.clear();
    this.deferredLedgerCounts.clear();
    this.priceListeners.clear();
    this.stallListeners.clear();
  }
}

/** Global singleton store for the client session */
export const marketPriceStore = new MarketPriceStore();

/**
 * DISPLAY ONLY overlay reconciliation.
 *
 * Rules:
 * 1. An equal or newer chain read ALWAYS wins over the overlay.
 * 2. Only a provisional price from a strictly newer ledger than the chain read is applied.
 * 3. Never to be used in trade math or transaction construction.
 */
export function reconcileDisplayPrice(
  chainPriceYesBps: number,
  chainLedger: number | null | undefined,
  provisional: ProvisionalPrice | null | undefined
): { priceYesBps: number; isProvisional: boolean; ledger: number | null } {
  if (chainLedger !== null && chainLedger !== undefined && chainLedger > 0) {
    if (provisional && provisional.ledger > chainLedger) {
      return {
        priceYesBps: provisional.priceYesBps,
        isProvisional: true,
        ledger: provisional.ledger,
      };
    }
    return {
      priceYesBps: chainPriceYesBps,
      isProvisional: false,
      ledger: chainLedger,
    };
  }

  // No on-chain ledger known
  if (provisional) {
    return {
      priceYesBps: provisional.priceYesBps,
      isProvisional: true,
      ledger: provisional.ledger,
    };
  }

  return {
    priceYesBps: chainPriceYesBps,
    isProvisional: false,
    ledger: null,
  };
}
