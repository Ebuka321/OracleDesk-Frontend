/**
 * On-chain v2 trade (`buy_v2` / `sell_v2`) derivations, capability detection,
 * and contract-inequality helpers (Issue #241).
 *
 * Exact bigint arithmetic only — no floats ever enter transaction parameters.
 */

import { rpc, xdr } from "@stellar/stellar-sdk";
import { rpcServer } from "./clients";
import { CONTRACTS, FORCE_LEGACY_TRADES } from "./config";
import { contractInstanceLedgerKey, parseSpecFromWasm } from "./contract-check";
import { BPS, mulDivCeil, mulDivFloor } from "./units";

export const MAX_LIMIT_PRICE_BPS = 10_000;

export interface LimitPriceDerivation {
  /** Basis points in `[0, 10_000]` to pass as `limit_price_bps: u32`. */
  limitPriceBps: number;
  /** Unclamped integer bps before clamping to `MAX_LIMIT_PRICE_BPS`. */
  unclampedBps: bigint;
  /** True when `unclampedBps` exceeded 10_000 and was clamped to 10_000. */
  clamped: boolean;
}

/**
 * Derives `limit_price_bps` (maximum average price per share, including fee)
 * for `buy_v2` from `collateralIn` and `minSharesOut`.
 *
 * Contract check (`buy_within_limit`):
 *   `collateral_in * 10_000 <= shares_out * limit_price_bps`
 *
 * Rounding direction: **ceiling** (`mulDivCeil(collateralIn, 10_000n, minSharesOut)`).
 * This guarantees that any trade satisfying the user's slippage bound
 * (`shares_out >= min_shares_out`) also satisfies `buy_within_limit`.
 *
 * Both `collateralIn` and `minSharesOut` are 7-decimal base units; the ratio
 * applies directly to the outcome being traded (YES price for YES, NO price for NO).
 * Clamped to `10_000` (contract rejects `> 10_000` as `InvalidAmount`).
 */
export function deriveBuyLimitPriceBps(collateralIn: bigint, minSharesOut: bigint): LimitPriceDerivation {
  if (collateralIn <= 0n) {
    throw new RangeError("Cannot derive buy limit price: collateral_in must be greater than zero.");
  }
  if (minSharesOut <= 0n) {
    throw new RangeError("Cannot derive buy limit price: min_shares_out must be greater than zero.");
  }
  const unclampedBps = mulDivCeil(collateralIn, BPS, minSharesOut);
  const clamped = unclampedBps > BPS;
  const limitPriceBps = clamped ? MAX_LIMIT_PRICE_BPS : Number(unclampedBps);
  return { limitPriceBps, unclampedBps, clamped };
}

/**
 * Derives `limit_price_bps` (minimum average price per share, including fee)
 * for `sell_v2` from `collateralOut` and `maxSharesIn`.
 *
 * Contract check (`sell_within_limit`):
 *   `collateral_out * 10_000 >= shares_in * limit_price_bps`
 *
 * Rounding direction: **floor** (`mulDivFloor(collateralOut, 10_000n, maxSharesIn)`).
 * This guarantees that any trade satisfying the user's slippage bound
 * (`shares_in <= max_shares_in`) also satisfies `sell_within_limit`, and the
 * derived limit is never stricter (higher) than the bound the user accepted.
 */
export function deriveSellLimitPriceBps(collateralOut: bigint, maxSharesIn: bigint): LimitPriceDerivation {
  if (collateralOut <= 0n) {
    throw new RangeError("Cannot derive sell limit price: collateral_out must be greater than zero.");
  }
  if (maxSharesIn <= 0n) {
    throw new RangeError("Cannot derive sell limit price: max_shares_in must be greater than zero.");
  }
  const unclampedBps = mulDivFloor(collateralOut, BPS, maxSharesIn);
  const clamped = unclampedBps > BPS;
  const limitPriceBps = clamped ? MAX_LIMIT_PRICE_BPS : Number(unclampedBps);
  return { limitPriceBps, unclampedBps, clamped };
}

/** Independent reimplementation of the contract's `buy_within_limit` inequality. */
export function buyWithinLimit(collateralIn: bigint, sharesOut: bigint, limitPriceBps: number): boolean {
  if (limitPriceBps === 0) return true;
  if (limitPriceBps < 0 || limitPriceBps > MAX_LIMIT_PRICE_BPS) return false;
  return collateralIn * BPS <= sharesOut * BigInt(limitPriceBps);
}

/** Independent reimplementation of the contract's `sell_within_limit` inequality. */
export function sellWithinLimit(collateralOut: bigint, sharesIn: bigint, limitPriceBps: number): boolean {
  if (limitPriceBps < 0 || limitPriceBps > MAX_LIMIT_PRICE_BPS) return false;
  return collateralOut * BPS >= sharesIn * BigInt(limitPriceBps);
}

/**
 * Computes the on-chain `deadline: u64` consistent with the transaction's
 * `timeBounds.maxTime`, never exceeding `envelopeMaxTime` if present.
 */
export function clampOnChainDeadline(deadlineMaxTime: number, envelopeMaxTime?: number | string | null): bigint {
  let effective = Math.floor(deadlineMaxTime);
  if (envelopeMaxTime !== undefined && envelopeMaxTime !== null && envelopeMaxTime !== "") {
    const parsed = Number(envelopeMaxTime);
    if (Number.isFinite(parsed) && parsed > 0) {
      effective = Math.min(effective, Math.floor(parsed));
    }
  }
  if (!Number.isFinite(effective) || effective <= 0) {
    throw new RangeError("Invalid on-chain deadline.");
  }
  return BigInt(effective);
}

// ─── Read-only on-chain capability detection ────────────────────────────────

export interface TradeV2Capability {
  supported: boolean;
  buyV2: boolean;
  sellV2: boolean;
  wasmHash?: string;
  reason?: string;
}

const CAPABILITY_CACHE = new Map<string, TradeV2Capability>();

export function clearTradeV2CapabilityCache(): void {
  CAPABILITY_CACHE.clear();
}

export function setTradeV2CapabilityForTest(contractId: string, capability: TradeV2Capability): void {
  CAPABILITY_CACHE.set(contractId, capability);
}

/** Inspects parsed ScSpecEntry list for `buy_v2` and `sell_v2` function entries. */
export function specSupportsTradeV2(entries: readonly xdr.ScSpecEntry[]): { buyV2: boolean; sellV2: boolean } {
  let buyV2 = false;
  let sellV2 = false;
  for (const entry of entries) {
    const arm = typeof entry.arm === "function" ? entry.arm() : entry.switch().name;
    if (arm !== "functionV0" && arm !== "scSpecEntryFunctionV0") continue;
    const fn = entry.value() as xdr.ScSpecFunctionV0;
    const name = fn.name().toString();
    if (name === "buy_v2") buyV2 = true;
    if (name === "sell_v2") sellV2 = true;
  }
  return { buyV2, sellV2 };
}

/**
 * Read-only, cached capability probe against the deployed `market_core` contract's
 * on-chain WASM spec. Defaults to legacy (`supported: false`) whenever:
 *  - `NEXT_PUBLIC_FORCE_LEGACY_TRADES` is set,
 *  - the deployed contract does not expose both `buy_v2` and `sell_v2`, or
 *  - detection fails / is inconclusive (RPC error, archived contract, malformed WASM).
 */
export async function detectMarketCoreTradeV2(
  server: Pick<rpc.Server, "getLedgerEntries"> = rpcServer(),
  contractId: string = CONTRACTS.marketCore,
  forceLegacy: boolean = FORCE_LEGACY_TRADES,
): Promise<TradeV2Capability> {
  if (forceLegacy) {
    return { supported: false, buyV2: false, sellV2: false, reason: "forced-legacy" };
  }

  const cached = CAPABILITY_CACHE.get(contractId);
  if (cached) return cached;

  try {
    const instanceKey = contractInstanceLedgerKey(contractId);
    const instanceRes = await server.getLedgerEntries(instanceKey);
    const entry = instanceRes.entries?.[0];
    if (!entry) {
      return { supported: false, buyV2: false, sellV2: false, reason: "contract-not-found" };
    }
    const executable = entry.val.contractData().val().instance().executable();
    if (executable.switch().name !== "contractExecutableWasm") {
      return { supported: false, buyV2: false, sellV2: false, reason: "not-wasm" };
    }
    const wasmHashBuf = executable.wasmHash();
    const wasmHash = wasmHashBuf.toString("hex");

    const codeKey = xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: wasmHashBuf }));
    const codeRes = await server.getLedgerEntries(codeKey);
    const codeEntry = codeRes.entries?.[0];
    if (!codeEntry) {
      return { supported: false, buyV2: false, sellV2: false, wasmHash, reason: "wasm-not-found" };
    }

    const wasmBytes = codeEntry.val.contractCode().code();
    const specEntries = parseSpecFromWasm(wasmBytes);
    const { buyV2, sellV2 } = specSupportsTradeV2(specEntries);
    const result: TradeV2Capability = {
      supported: buyV2 && sellV2,
      buyV2,
      sellV2,
      wasmHash,
    };
    CAPABILITY_CACHE.set(contractId, result);
    return result;
  } catch (error) {
    // Inconclusive detection: default safely to legacy without poisoning the cache permanently.
    return {
      supported: false,
      buyV2: false,
      sellV2: false,
      reason: error instanceof Error ? error.message : "detection-failed",
    };
  }
}
