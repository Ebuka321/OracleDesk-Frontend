import { BPS, calcSell, isqrt, MathError } from "./generated/fpmm";

export interface ExactSell { path: "exact"; sharesIn: bigint; collateralOut: bigint; fee: bigint; gross: bigint }

/**
 * Closed-form inverse of calcSell, mirroring the contracts' calc_sell_shares:
 * burn exactly `shares`, take the smaller root x of
 * (rSold + shares - x)(rOther - x) = rSold * rOther, then step x down while the
 * invariant would drop (pool-favouring). No dust: sharesIn === shares.
 */
export function exactSellForShares(
  rSold: bigint,
  rOther: bigint,
  shares: bigint,
  feeBps: bigint,
): ExactSell | SellSolveError {
  if (rSold <= 0n || rOther <= 0n || feeBps < 0n || feeBps >= BPS) return { error: "insufficient-liquidity" };
  if (shares <= 0n) return { error: "too-small" };
  // Same root as grossForShares, computed inline so a zero root maps to
  // "too-small" rather than an insufficient-liquidity MathError.
  const b = shares + rSold + rOther;
  let gross = (b - isqrt(b * b - 4n * rOther * shares)) / 2n;
  const k = rSold * rOther;
  while (gross > 0n && (rSold + shares - gross) * (rOther - gross) < k) gross--;
  if (gross <= 0n) return { error: "too-small" };
  if (gross >= rOther) return { error: "insufficient-liquidity" };
  const collateralOut = (gross * (BPS - feeBps)) / BPS;
  if (collateralOut <= 0n) return { error: "too-small" };
  return { path: "exact", sharesIn: shares, collateralOut, fee: gross - collateralOut, gross };
}

function fits(rSold: bigint, rOther: bigint, collateralOut: bigint, feeBps: bigint, budget: bigint): boolean {
  try {
    return calcSell(rSold, rOther, collateralOut, feeBps).sharesIn <= budget;
  } catch (error) {
    if (!(error instanceof MathError)) throw error;
    return false;
  }
}

export interface SellSolution {
  collateralOut: bigint;
  sharesIn: bigint;
  dust: bigint;
  iterations: number;
}

export type SellSolveError = { error: "insufficient-liquidity" | "too-small" };

/**
 * calcSell's sharesIn is monotone: gross is non-decreasing in collateralOut;
 * as gross grows, rOther - gross shrinks and ceil(rSold*rOther/(rOther-gross))
 * cannot decrease. Their sum with gross therefore cannot decrease.
 */
export function solveSellForShares(
  rSold: bigint,
  rOther: bigint,
  shareBudget: bigint,
  feeBps: bigint,
): SellSolution | SellSolveError {
  if (rSold <= 0n || rOther <= 0n || feeBps < 0n || feeBps >= BPS) {
    return { error: "insufficient-liquidity" };
  }
  if (shareBudget <= 0n) return { error: "too-small" };

  // For calcSell to remain liquid, gross must be at most rOther - 1.
  const maxCollateralOut = ((rOther - 1n) * (BPS - feeBps)) / BPS;
  if (maxCollateralOut <= 0n) return { error: "insufficient-liquidity" };

  let low = 0n;
  let high = maxCollateralOut + 1n;
  let iterations = 0;

  // Warm start from the exact inverse: its collateral always fits the budget,
  // and the legacy optimum is only a few base units above it, so gallop up to
  // bracket the answer instead of searching the whole range.
  const exact = exactSellForShares(rSold, rOther, shareBudget, feeBps);
  if (!("error" in exact) && exact.collateralOut <= maxCollateralOut &&
      fits(rSold, rOther, exact.collateralOut, feeBps, shareBudget)) {
    low = exact.collateralOut;
    let step = 1n;
    for (;;) {
      const probe = low + step;
      iterations++;
      if (probe > maxCollateralOut) break;
      if (!fits(rSold, rOther, probe, feeBps, shareBudget)) { high = probe; break; }
      low = probe;
      step *= 2n;
    }
  }

  while (high - low > 1n) {
    const mid = (low + high) / 2n;
    iterations++;
    if (fits(rSold, rOther, mid, feeBps, shareBudget)) low = mid;
    else high = mid;
  }

  if (low === 0n) return { error: "too-small" };
  const sharesIn = calcSell(rSold, rOther, low, feeBps).sharesIn;
  return { collateralOut: low, sharesIn, dust: shareBudget - sharesIn, iterations };
}

/**
 * Confirm the local math against quote_sell. A caller can refetch reserves
 * and re-solve when the quoted share count differs.
 */
export async function reconcileWithQuote(
  local: SellSolution,
  quote: (collateralOut: bigint) => Promise<bigint>,
): Promise<SellSolution> {
  const sharesIn = await quote(local.collateralOut);
  if (sharesIn === local.sharesIn) return local;
  return {
    ...local,
    sharesIn,
    dust: local.dust + local.sharesIn - sharesIn,
  };
}
