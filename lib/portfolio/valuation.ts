import {
  BPS,
  calcSell,
  collateralOutForShares,
  MathError,
  MIN_PROB_BPS,
  priceYesBps,
  settleValue,
} from "../stellar/generated/fpmm";
import { mulDivFloor } from "../stellar/units";

/**
 * Mark-to-market and executable liquidation valuation for market-core holdings.
 *
 * All share counts and values are bigints in 7-decimal USDC base units.
 * Floating-point conversions are never used anywhere in this module.
 *
 * Why liquidation value differs from mid value:
 * - Mid value prices each share at the exact marginal FPMM spot probability
 *   derived directly from reserves: floor(yes·rNo/(rYes+rNo)) + floor(no·rYes/(rYes+rNo)).
 * - Selling moves the constant-product curve against the seller and deducts
 *   `feeBps` from the gross complete sets burned (`collateralOutForShares` /
 *   `calcSell`). On thin pools or large positions, sales driving the post-sale
 *   spot probability below `exitFloorBps` (default MIN_PROB_BPS = 1%) are capped,
 *   reporting executable proceeds and residual tail value.
 * - For two-sided holdings (both YES and NO > 0), selling one side first
 *   shifts the reserves before the second side is sold. Because protocol fees
 *   stay in the pool and grow the invariant product, selling both sides
 *   sequentially recovers at most `min(yes, no)` sets' worth (minus fees) plus
 *   the residual side's curve value. A native on-chain `merge` entrypoint would
 *   redeem `min(yes, no)` complete sets 1:1 without curve slippage (see
 *   `docs/contract-requests.md`).
 */

export interface MarketState {
  reserveYes: bigint;
  reserveNo: bigint;
  feeBps: bigint;
  status: "Open" | "Yes" | "No" | "Void";
  closeTime: bigint;
  paused?: boolean;
}

export interface Holding {
  yes: bigint;
  no: bigint;
}

export type ValuationBasis = "liquidation" | "resolution" | "mid-only";

export interface ValuationOptions {
  exitFloorBps?: bigint; // default MIN_PROB_BPS (100 = 1%)
}

export type Valuation = {
  mid: bigint;
  liquidation: {
    value: bigint;
    tailValue: bigint;
    sold: Holding;
    unsold: Holding;
    capped: boolean;
    tradable: boolean;
  };
  /** Set when `status` is final (`Yes`, `No`, or `Void`). */
  resolution: bigint | null;
  basis: ValuationBasis;
};

export interface MaxSellableResult {
  shares: bigint;
  collateral: bigint;
  tailValue: bigint;
  newReserveSold: bigint;
  newReserveOther: bigint;
  adjustmentSteps: number;
}

const MAX_ROUNDING_ADJUSTMENT_STEPS = 8;

function tryCollateralOut(
  rSold: bigint,
  rOther: bigint,
  sharesIn: bigint,
  feeBps: bigint,
): bigint | null {
  try {
    return collateralOutForShares(rSold, rOther, sharesIn, feeBps);
  } catch (error) {
    if (error instanceof MathError) return null;
    throw error;
  }
}

/**
 * True when `sharesIn` is large enough that the FPMM quadratic root `gross` is
 * at least 1 base unit: `(sharesIn + rSold - 1) * (rOther - 1) >= rSold * rOther`.
 * When false, `grossForShares` throws because `gross === 0n` (dust), not
 * because `sharesIn` exceeded pool capacity (`gross >= rOther`).
 */
function hasAtLeastOneGrossUnit(
  rSold: bigint,
  rOther: bigint,
  sharesIn: bigint,
): boolean {
  if (sharesIn <= 0n || rOther <= 1n) return false;
  return (sharesIn + rSold - 1n) * (rOther - 1n) >= rSold * rOther;
}

/**
 * Validates that `collateral` can be exited on-chain with at most `maxShares`
 * via `calcSell`. Decrements `collateral` by at most a few base units if
 * ceiling rounding in `calcSell` would require more than `maxShares`.
 */
function ensureExecutableCollateral(
  rSold: bigint,
  rOther: bigint,
  feeBps: bigint,
  maxShares: bigint,
  initialCollateral: bigint,
): {
  collateral: bigint;
  newReserveSold: bigint;
  newReserveOther: bigint;
  adjustmentSteps: number;
} {
  let collateral = initialCollateral;
  let steps = 0;

  while (collateral > 0n && steps <= MAX_ROUNDING_ADJUSTMENT_STEPS) {
    try {
      const quote = calcSell(rSold, rOther, collateral, feeBps);
      if (quote.sharesIn <= maxShares) {
        return {
          collateral,
          newReserveSold: quote.newReserveSold,
          newReserveOther: quote.newReserveOther,
          adjustmentSteps: steps,
        };
      }
    } catch (error) {
      if (!(error instanceof MathError)) throw error;
    }
    collateral -= 1n;
    steps += 1;
  }

  return {
    collateral: 0n,
    newReserveSold: rSold,
    newReserveOther: rOther,
    adjustmentSteps: steps,
  };
}

/**
 * Finds the largest share count `s` in `[0, want]` for which
 * `collateralOutForShares` succeeds, and validates the resulting `collateral`
 * against `calcSell` so `calcSell(rSold, rOther, collateral, feeBps).sharesIn <= s`.
 */
export function maxSellable(
  rSold: bigint,
  rOther: bigint,
  feeBps: bigint,
  want: bigint,
  exitFloorBps: bigint = MIN_PROB_BPS,
): MaxSellableResult {
  if (want <= 0n || rSold <= 0n || rOther <= 0n || feeBps < 0n || feeBps >= BPS) {
    return {
      shares: 0n,
      collateral: 0n,
      tailValue: 0n,
      newReserveSold: rSold > 0n ? rSold : 0n,
      newReserveOther: rOther > 0n ? rOther : 0n,
      adjustmentSteps: 0,
    };
  }

  const checkFloor = (newResSold: bigint, newResOther: bigint) => {
    if (exitFloorBps <= 0n) return true;
    const tot = newResSold + newResOther;
    return tot > 0n && newResOther * BPS >= exitFloorBps * tot;
  };

  const direct = tryCollateralOut(rSold, rOther, want, feeBps);
  if (direct !== null) {
    const validated = ensureExecutableCollateral(rSold, rOther, feeBps, want, direct);
    if (checkFloor(validated.newReserveSold, validated.newReserveOther)) {
      return {
        shares: want,
        collateral: validated.collateral,
        tailValue: 0n,
        newReserveSold: validated.newReserveSold,
        newReserveOther: validated.newReserveOther,
        adjustmentSteps: validated.adjustmentSteps,
      };
    }
  }

  // If `want` failed only because it is too small to produce 1 unit of gross
  // collateral (and rOther > 1), then it is dust, not over pool capacity.
  if (rOther > 1n && !hasAtLeastOneGrossUnit(rSold, rOther, want)) {
    return {
      shares: want,
      collateral: 0n,
      tailValue: 0n,
      newReserveSold: rSold,
      newReserveOther: rOther,
      adjustmentSteps: 0,
    };
  }

  if (rOther <= 1n) {
    return {
      shares: 0n,
      collateral: 0n,
      tailValue: 0n,
      newReserveSold: rSold,
      newReserveOther: rOther,
      adjustmentSteps: 0,
    };
  }

  // Binary-search the largest `s` in [0, want] that does not exceed pool capacity
  // and stays at or above exitFloorBps.
  let low = 0n;
  let high = want;
  let bestShares = 0n;
  let bestEstimate = 0n;

  while (high - low > 1n) {
    const mid = (low + high) / 2n;
    const est = tryCollateralOut(rSold, rOther, mid, feeBps);
    if (est !== null) {
      const validated = ensureExecutableCollateral(rSold, rOther, feeBps, mid, est);
      if (checkFloor(validated.newReserveSold, validated.newReserveOther)) {
        bestShares = mid;
        bestEstimate = est;
        low = mid;
      } else {
        high = mid;
      }
    } else if (!hasAtLeastOneGrossUnit(rSold, rOther, mid)) {
      low = mid;
    } else {
      high = mid;
    }
  }

  let collateral = 0n;
  let newReserveSold = rSold;
  let newReserveOther = rOther;
  let steps = 0;

  if (bestShares > 0n && bestEstimate > 0n) {
    const validated = ensureExecutableCollateral(
      rSold,
      rOther,
      feeBps,
      bestShares,
      bestEstimate,
    );
    collateral = validated.collateral;
    newReserveSold = validated.newReserveSold;
    newReserveOther = validated.newReserveOther;
    steps = validated.adjustmentSteps;
  }

  let tailValue = 0n;
  if (bestShares < want) {
    const remaining = want - bestShares;
    const tailEst = tryCollateralOut(newReserveSold, newReserveOther, remaining, feeBps);
    if (tailEst !== null && tailEst > 0n) {
      const tailVal = ensureExecutableCollateral(
        newReserveSold,
        newReserveOther,
        feeBps,
        remaining,
        tailEst,
      );
      tailValue = tailVal.collateral;
    }
  }

  return {
    shares: bestShares,
    collateral,
    tailValue,
    newReserveSold,
    newReserveOther,
    adjustmentSteps: steps,
  };
}

/** floor(yes·rNo/(rYes+rNo)) + floor(no·rYes/(rYes+rNo)); exact spot value, one floor per leg. */
export function midValue(
  reserveYes: bigint,
  reserveNo: bigint,
  yes: bigint,
  no: bigint,
): bigint {
  if (reserveYes <= 0n || reserveNo <= 0n) return 0n;
  const total = reserveYes + reserveNo;
  if (total <= 0n) return 0n;
  const hYes = yes > 0n ? yes : 0n;
  const hNo = no > 0n ? no : 0n;
  return (hYes * reserveNo) / total + (hNo * reserveYes) / total;
}

/**
 * Values a holding across mid, executable liquidation, and resolution bases.
 */
export function valueHolding(
  m: MarketState,
  h: Holding,
  nowSec: bigint,
  opts?: ValuationOptions,
): Valuation {
  const floor = opts?.exitFloorBps ?? MIN_PROB_BPS;
  const yes = h.yes > 0n ? h.yes : 0n;
  const no = h.no > 0n ? h.no : 0n;
  const mid = midValue(m.reserveYes, m.reserveNo, yes, no);

  if (m.status === "Yes" || m.status === "No" || m.status === "Void") {
    const kind =
      m.status === "Yes" ? "yes" : m.status === "No" ? "no" : "void";
    const resolution = settleValue(kind, yes, no);
    return {
      mid,
      liquidation: {
        value: 0n,
        tailValue: 0n,
        sold: { yes: 0n, no: 0n },
        unsold: { yes, no },
        capped: false,
        tradable: false,
      },
      resolution,
      basis: "resolution",
    };
  }

  const tradable =
    m.status === "Open" &&
    !m.paused &&
    nowSec < m.closeTime &&
    m.reserveYes > 0n &&
    m.reserveNo > 0n &&
    m.feeBps >= 0n &&
    m.feeBps < BPS;

  if (!tradable) {
    return {
      mid,
      liquidation: {
        value: 0n,
        tailValue: 0n,
        sold: { yes: 0n, no: 0n },
        unsold: { yes, no },
        capped: false,
        tradable: false,
      },
      resolution: null,
      basis: "mid-only",
    };
  }

  if (yes === 0n && no === 0n) {
    return {
      mid: 0n,
      liquidation: {
        value: 0n,
        tailValue: 0n,
        sold: { yes: 0n, no: 0n },
        unsold: { yes: 0n, no: 0n },
        capped: false,
        tradable: true,
      },
      resolution: null,
      basis: "liquidation",
    };
  }

  if (no === 0n) {
    const yesSell = maxSellable(m.reserveYes, m.reserveNo, m.feeBps, yes, floor);
    return {
      mid,
      liquidation: {
        value: yesSell.collateral,
        tailValue: yesSell.tailValue,
        sold: { yes: yesSell.shares, no: 0n },
        unsold: { yes: yes - yesSell.shares, no: 0n },
        capped: yesSell.shares < yes,
        tradable: true,
      },
      resolution: null,
      basis: "liquidation",
    };
  }

  if (yes === 0n) {
    const noSell = maxSellable(m.reserveNo, m.reserveYes, m.feeBps, no, floor);
    return {
      mid,
      liquidation: {
        value: noSell.collateral,
        tailValue: noSell.tailValue,
        sold: { yes: 0n, no: noSell.shares },
        unsold: { yes: 0n, no: no - noSell.shares },
        capped: noSell.shares < no,
        tradable: true,
      },
      resolution: null,
      basis: "liquidation",
    };
  }

  // Two-sided holding: evaluate both execution orders using post-trade reserves
  // from calcSell for the second leg, and pick the order with the larger payout.
  const yesFirst1 = maxSellable(m.reserveYes, m.reserveNo, m.feeBps, yes, floor);
  const yesFirst2 = maxSellable(
    yesFirst1.newReserveOther,
    yesFirst1.newReserveSold,
    m.feeBps,
    no,
    floor,
  );
  const yesFirstTotal = yesFirst1.collateral + yesFirst2.collateral;
  const yesFirstTail = yesFirst1.tailValue + yesFirst2.tailValue;

  const noFirst1 = maxSellable(m.reserveNo, m.reserveYes, m.feeBps, no, floor);
  const noFirst2 = maxSellable(
    noFirst1.newReserveOther,
    noFirst1.newReserveSold,
    m.feeBps,
    yes,
    floor,
  );
  const noFirstTotal = noFirst1.collateral + noFirst2.collateral;
  const noFirstTail = noFirst1.tailValue + noFirst2.tailValue;

  const useYesFirst =
    yesFirstTotal > noFirstTotal ||
    (yesFirstTotal === noFirstTotal &&
      yesFirst1.shares + yesFirst2.shares >= noFirst1.shares + noFirst2.shares);

  const soldYes = useYesFirst ? yesFirst1.shares : noFirst2.shares;
  const soldNo = useYesFirst ? yesFirst2.shares : noFirst1.shares;
  const totalValue = useYesFirst ? yesFirstTotal : noFirstTotal;
  const totalTail = useYesFirst ? yesFirstTail : noFirstTail;

  return {
    mid,
    liquidation: {
      value: totalValue,
      tailValue: totalTail,
      sold: { yes: soldYes, no: soldNo },
      unsold: { yes: yes - soldYes, no: no - soldNo },
      capped: soldYes < yes || soldNo < no,
      tradable: true,
    },
    resolution: null,
    basis: "liquidation",
  };
}
