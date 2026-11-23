import {
  calcBuy,
  collateralOutForShares,
  type BuyQuote,
} from "./generated/fpmm";
import { maxIn, minOut } from "./units";

export type OutcomeTag = "Yes" | "No";

export interface Reserves {
  reserveYes: bigint;
  reserveNo: bigint;
  feeBps: bigint;
}

/**
 * Pure planning computation for a buy: computes the quote via FPMM calcBuy
 * and applies the minOut slippage bound.
 * Used for tests, offline pricing, and previews.
 */
export function planBuy(
  r: Reserves,
  outcome: OutcomeTag,
  collateralIn: bigint,
  slippageBps: number | bigint
): { quote: BuyQuote; minSharesOut: bigint } {
  const [rBought, rOther] =
    outcome === "Yes" ? [r.reserveYes, r.reserveNo] : [r.reserveNo, r.reserveYes];
  const quote = calcBuy(rBought, rOther, collateralIn, r.feeBps);
  const minSharesOut = minOut(quote.sharesOut, slippageBps);
  return { quote, minSharesOut };
}

/**
 * Pure planning computation for an exact-share sell.
 * Converts a share count into collateralOut with collateralOutForShares
 * and pads maxSharesIn with maxIn(shares, slippageBps) + 1n.
 * Throws MathError if liquidity is insufficient or input is invalid.
 */
export function planSell(
  r: Reserves,
  outcome: OutcomeTag,
  shares: bigint,
  slippageBps: number | bigint
): { collateralOut: bigint; maxSharesIn: bigint } {
  const [rSold, rOther] =
    outcome === "Yes" ? [r.reserveYes, r.reserveNo] : [r.reserveNo, r.reserveYes];
  const collateralOut = collateralOutForShares(rSold, rOther, shares, r.feeBps);
  const maxSharesIn = maxIn(shares, slippageBps) + 1n;
  return { collateralOut, maxSharesIn };
}
