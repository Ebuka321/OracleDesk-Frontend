import {
  BPS,
  calcBuy,
  calcSell,
  collateralOutForShares,
  grossForShares,
  MathError,
  priceYesBps,
  settleValue,
} from "../stellar/generated/fpmm";
import { minOut, maxIn } from "../stellar/units";

export interface PoolState {
  reserveYes: bigint;
  reserveNo: bigint;
  feeBps: bigint;
}

export interface BuyStep {
  label: string;
  formula: string;
  values: Record<string, bigint>;
  result: bigint;
  rounding?: "ceil" | "floor";
}

export interface BuyWalkthrough {
  before: { priceYesBps: bigint; k: bigint };
  steps: BuyStep[];
  after: PoolState & { priceYesBps: bigint; k: bigint };
  avgPriceBps: bigint;
  marginalBeforeBps: bigint;
  marginalAfterBps: bigint;
  impactBps: bigint;
  minSharesOut: bigint;
  settlement: { yes: bigint; no: bigint; void: bigint };
}

export interface SellStep {
  label: string;
  formula: string;
  values: Record<string, bigint>;
  result: bigint;
  rounding?: "ceil" | "floor";
}

export interface SellWalkthrough {
  before: { priceYesBps: bigint; k: bigint };
  steps: SellStep[];
  after: PoolState & { priceYesBps: bigint; k: bigint };
  avgPriceBps: bigint;
  marginalBeforeBps: bigint;
  marginalAfterBps: bigint;
  impactBps: bigint;
  sharesIn: bigint;
  collateralOut: bigint;
  minCollateralOut?: bigint;
  maxSharesIn?: bigint;
  settlement: { yes: bigint; no: bigint; void: bigint };
}

/**
 * Generates an exact bigint step-by-step walkthrough for a BUY trade on the FPMM.
 * intermediate values are verified at runtime against calcBuy.
 */
export function buyWalkthrough(
  pool: PoolState,
  side: "Yes" | "No",
  collateralIn: bigint,
  slippageBps: bigint,
): BuyWalkthrough {
  if (pool.reserveYes <= 0n || pool.reserveNo <= 0n) {
    throw new MathError("Reserves must be positive");
  }
  if (collateralIn <= 0n) {
    throw new MathError("Collateral in must be positive");
  }
  if (pool.feeBps < 0n || pool.feeBps >= BPS) {
    throw new MathError("Fee must be in [0, 10000) bps");
  }

  const rBought = side === "Yes" ? pool.reserveYes : pool.reserveNo;
  const rOther = side === "Yes" ? pool.reserveNo : pool.reserveYes;

  const quote = calcBuy(rBought, rOther, collateralIn, pool.feeBps);

  const priceBefore = priceYesBps(pool.reserveYes, pool.reserveNo);
  const kBefore = pool.reserveYes * pool.reserveNo;

  // Recompute display step values and verify they match calcBuy exactly
  const fee = (collateralIn * pool.feeBps + BPS - 1n) / BPS;
  if (fee !== quote.fee) throw new Error("Step divergence: fee mismatch");

  const net = collateralIn - fee;
  if (net !== quote.net) throw new Error("Step divergence: net mismatch");

  const newOther = rOther + net;
  if (newOther !== quote.newReserveOther) throw new Error("Step divergence: newOther mismatch");

  const newBought = (rBought * rOther + newOther - 1n) / newOther;
  if (newBought !== quote.newReserveBought) throw new Error("Step divergence: newBought mismatch");

  const sharesOut = rBought + net - newBought;
  if (sharesOut !== quote.sharesOut) throw new Error("Step divergence: sharesOut mismatch");

  const afterYes = side === "Yes" ? newBought : newOther;
  const afterNo = side === "Yes" ? newOther : newBought;
  const priceAfter = priceYesBps(afterYes, afterNo);
  const kAfter = afterYes * afterNo;

  const marginalBeforeBps = side === "Yes" ? priceBefore : BPS - priceBefore;
  const marginalAfterBps = side === "Yes" ? priceAfter : BPS - priceAfter;
  const impactBps = marginalAfterBps > marginalBeforeBps ? marginalAfterBps - marginalBeforeBps : marginalBeforeBps - marginalAfterBps;

  const avgPriceBps = sharesOut > 0n ? (collateralIn * BPS) / sharesOut : 0n;
  const minSharesOut = minOut(sharesOut, slippageBps);

  const boughtYes = side === "Yes" ? sharesOut : 0n;
  const boughtNo = side === "Yes" ? 0n : sharesOut;
  const settlement = {
    yes: settleValue("yes", boughtYes, boughtNo),
    no: settleValue("no", boughtYes, boughtNo),
    void: settleValue("void", boughtYes, boughtNo),
  };

  const steps: BuyStep[] = [
    {
      label: "Protocol Fee",
      formula: "ceil(collateralIn * feeBps / 10000)",
      values: { collateralIn, feeBps: pool.feeBps },
      result: fee,
      rounding: "ceil",
    },
    {
      label: "Net Collateral to Pool",
      formula: "collateralIn - fee",
      values: { collateralIn, fee },
      result: net,
    },
    {
      label: `Updated Counter Reserve (${side === "Yes" ? "NO" : "YES"})`,
      formula: "reserveOther + net",
      values: { reserveOther: rOther, net },
      result: newOther,
    },
    {
      label: `Updated Target Reserve (${side === "Yes" ? "YES" : "NO"})`,
      formula: "ceil(reserveBought * reserveOther / newOther)",
      values: { reserveBought: rBought, reserveOther: rOther, newOther },
      result: newBought,
      rounding: "ceil",
    },
    {
      label: "Shares Minted & Swapped",
      formula: "reserveBought + net - newBought",
      values: { reserveBought: rBought, net, newBought },
      result: sharesOut,
    },
  ];

  return {
    before: { priceYesBps: priceBefore, k: kBefore },
    steps,
    after: {
      reserveYes: afterYes,
      reserveNo: afterNo,
      feeBps: pool.feeBps,
      priceYesBps: priceAfter,
      k: kAfter,
    },
    avgPriceBps,
    marginalBeforeBps,
    marginalAfterBps,
    impactBps,
    minSharesOut,
    settlement,
  };
}

/**
 * Generates an exact bigint step-by-step walkthrough for a SELL trade on the FPMM.
 */
export function sellWalkthrough(
  pool: PoolState,
  side: "Yes" | "No",
  mode: { collateralOut: bigint } | { shares: bigint },
  slippageBps: bigint,
): SellWalkthrough {
  if (pool.reserveYes <= 0n || pool.reserveNo <= 0n) {
    throw new MathError("Reserves must be positive");
  }

  const rSold = side === "Yes" ? pool.reserveYes : pool.reserveNo;
  const rOther = side === "Yes" ? pool.reserveNo : pool.reserveYes;

  const priceBefore = priceYesBps(pool.reserveYes, pool.reserveNo);
  const kBefore = pool.reserveYes * pool.reserveNo;

  let sharesIn: bigint;
  let collateralOut: bigint;
  let gross: bigint;
  let fee: bigint;
  let newOther: bigint;
  let newSold: bigint;

  if ("collateralOut" in mode) {
    collateralOut = mode.collateralOut;
    const quote = calcSell(rSold, rOther, collateralOut, pool.feeBps);
    sharesIn = quote.sharesIn;
    gross = quote.gross;
    fee = quote.fee;
    newOther = quote.newReserveOther;
    newSold = quote.newReserveSold;
  } else {
    sharesIn = mode.shares;
    collateralOut = collateralOutForShares(rSold, rOther, sharesIn, pool.feeBps);
    gross = grossForShares(rSold, rOther, sharesIn);
    fee = gross - collateralOut;
    newOther = rOther - gross;
    newSold = (rSold * rOther + newOther - 1n) / newOther;
  }

  const afterYes = side === "Yes" ? newSold : newOther;
  const afterNo = side === "Yes" ? newOther : newSold;
  const priceAfter = priceYesBps(afterYes, afterNo);
  const kAfter = afterYes * afterNo;

  const marginalBeforeBps = side === "Yes" ? priceBefore : BPS - priceBefore;
  const marginalAfterBps = side === "Yes" ? priceAfter : BPS - priceAfter;
  const impactBps = marginalBeforeBps > marginalAfterBps ? marginalBeforeBps - marginalAfterBps : marginalAfterBps - marginalBeforeBps;

  const avgPriceBps = sharesIn > 0n ? (collateralOut * BPS) / sharesIn : 0n;

  const steps: SellStep[] = [
    {
      label: "Gross Complete Sets Burned",
      formula: "collateralOut / (1 - feeRate) [ceil] or quadratic root for shares",
      values: { collateralOut, sharesIn, feeBps: pool.feeBps },
      result: gross,
      rounding: "ceil",
    },
    {
      label: "Protocol Fee Retained",
      formula: "gross - collateralOut",
      values: { gross, collateralOut },
      result: fee,
    },
    {
      label: `Updated Counter Reserve (${side === "Yes" ? "NO" : "YES"})`,
      formula: "reserveOther - gross",
      values: { reserveOther: rOther, gross },
      result: newOther,
    },
    {
      label: `Updated Target Reserve (${side === "Yes" ? "YES" : "NO"})`,
      formula: "ceil(reserveSold * reserveOther / newOther)",
      values: { reserveSold: rSold, reserveOther: rOther, newOther },
      result: newSold,
      rounding: "ceil",
    },
    {
      label: "Required Shares In",
      formula: "newSold + gross - reserveSold",
      values: { newSold, gross, reserveSold: rSold },
      result: sharesIn,
    },
  ];

  const minCollateralOut = "shares" in mode ? minOut(collateralOut, slippageBps) : undefined;
  const maxSharesIn = "collateralOut" in mode ? maxIn(sharesIn, slippageBps) : undefined;

  const soldYes = side === "Yes" ? sharesIn : 0n;
  const soldNo = side === "Yes" ? 0n : sharesIn;
  const settlement = {
    yes: settleValue("yes", soldYes, soldNo),
    no: settleValue("no", soldYes, soldNo),
    void: settleValue("void", soldYes, soldNo),
  };

  return {
    before: { priceYesBps: priceBefore, k: kBefore },
    steps,
    after: {
      reserveYes: afterYes,
      reserveNo: afterNo,
      feeBps: pool.feeBps,
      priceYesBps: priceAfter,
      k: kAfter,
    },
    avgPriceBps,
    marginalBeforeBps,
    marginalAfterBps,
    impactBps,
    sharesIn,
    collateralOut,
    minCollateralOut,
    maxSharesIn,
    settlement,
  };
}
