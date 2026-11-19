import fc from "fast-check";
import {
  calcBuy,
  calcSell,
  MAX_SETS,
  MAX_PROB_BPS,
  MIN_PROB_BPS,
  seedReserves,
} from "../generated/fpmm";
import type { OutcomeTag, Reserves } from "../trade-plan";

export const MIN_SEED = 100n * 10_000_000n; // 100 USDC in 7 dp base units (mirrors market-core MIN_SEED)

export interface TradeRecord {
  kind: "buy" | "sell";
  outcome: OutcomeTag;
  amount: bigint;
}

export interface MarketState extends Reserves {
  seed: bigint;
  initialYesBps: bigint;
  trades: TradeRecord[];
}

/**
 * Fee basis points arbitrary: 0 to 1000 bps (0% to 10%).
 * Bounded by plausible market fee rates (default_fee_bps in market-core is 100 bps = 1%).
 */
export const feeBpsArb = fc.bigInt({ min: 0n, max: 1000n });

/**
 * Generates an initial seed and probability, initializes reserves via seedReserves,
 * and applies 0 to 20 random valid trades to reach realistic, skewed reserve states.
 */
export const reservesArb: fc.Arbitrary<MarketState> = fc
  .record({
    seed: fc.bigInt({ min: MIN_SEED, max: 10_000_000n * 10_000_000n }), // 100 to 10M USDC
    initialYesBps: fc.bigInt({ min: MIN_PROB_BPS, max: MAX_PROB_BPS }),
    feeBps: feeBpsArb,
    rawTrades: fc.array(
      fc.record({
        kind: fc.constantFrom<"buy" | "sell">("buy", "sell"),
        outcome: fc.constantFrom<OutcomeTag>("Yes", "No"),
        amountFraction: fc.integer({ min: 1, max: 200 }), // fraction of reserve to trade
      }),
      { minLength: 0, maxLength: 20 }
    ),
  })
  .map(({ seed, initialYesBps, feeBps, rawTrades }) => {
    const seeded = seedReserves(seed, initialYesBps);
    let rYes = seeded.reserveYes;
    let rNo = seeded.reserveNo;
    const appliedTrades: TradeRecord[] = [];

    for (const trade of rawTrades) {
      try {
        if (trade.kind === "buy") {
          const [rBought, rOther] = trade.outcome === "Yes" ? [rYes, rNo] : [rNo, rYes];
          // Keep collateralIn small enough so liquidity isn't depleted
          const collateralIn = (rOther * BigInt(trade.amountFraction)) / 1000n + 10_000n;
          if (collateralIn <= 0n) continue;
          const quote = calcBuy(rBought, rOther, collateralIn, feeBps);
          if (quote.newReserveBought > MAX_SETS || quote.newReserveOther > MAX_SETS) continue;
          if (trade.outcome === "Yes") {
            rYes = quote.newReserveBought;
            rNo = quote.newReserveOther;
          } else {
            rNo = quote.newReserveBought;
            rYes = quote.newReserveOther;
          }
          appliedTrades.push({ kind: "buy", outcome: trade.outcome, amount: collateralIn });
        } else {
          const [rSold, rOther] = trade.outcome === "Yes" ? [rYes, rNo] : [rNo, rYes];
          // collateralOut must be strictly < rOther
          const collateralOut = (rOther * BigInt(trade.amountFraction)) / 1000n + 1n;
          if (collateralOut <= 0n || collateralOut >= rOther) continue;
          const quote = calcSell(rSold, rOther, collateralOut, feeBps);
          if (quote.newReserveSold > MAX_SETS || quote.newReserveOther > MAX_SETS) continue;
          if (trade.outcome === "Yes") {
            rYes = quote.newReserveSold;
            rNo = quote.newReserveOther;
          } else {
            rNo = quote.newReserveSold;
            rYes = quote.newReserveOther;
          }
          appliedTrades.push({ kind: "sell", outcome: trade.outcome, amount: collateralOut });
        }
      } catch {
        // Skip trades that would violate invariant or liquidity
      }
    }

    return {
      seed,
      initialYesBps,
      feeBps,
      reserveYes: rYes,
      reserveNo: rNo,
      trades: appliedTrades,
    };
  });

/**
 * Generates amounts biased towards boundaries (1n, tiny amounts, near-max liquidity, and log-uniform).
 */
export function amountArb(min: bigint, max: bigint): fc.Arbitrary<bigint> {
  if (max <= min) return fc.constant(min);

  const tinyMax = min + 100n < max ? min + 100n : max;
  const nearMaxMin = max > 100n && max - 100n > min ? max - 100n : min;

  return fc.oneof(
    { arbitrary: fc.constant(min), weight: 2 },
    { arbitrary: fc.constant(min + 1n < max ? min + 1n : min), weight: 1 },
    { arbitrary: fc.bigInt({ min, max: tinyMax }), weight: 2 },
    { arbitrary: fc.constant(max), weight: 2 },
    { arbitrary: fc.constant(max > min ? max - 1n : min), weight: 1 },
    { arbitrary: fc.bigInt({ min: nearMaxMin, max }), weight: 2 },
    // General range
    { arbitrary: fc.bigInt({ min, max }), weight: 4 }
  );
}

/**
 * Slippage tolerance arbitrary: 0..5000 bps with edge values 0, 1, 9999.
 */
export const slippageArb: fc.Arbitrary<number> = fc.oneof(
  { arbitrary: fc.constantFrom(0, 1, 9999), weight: 2 },
  { arbitrary: fc.integer({ min: 0, max: 5000 }), weight: 5 }
);

/**
 * Decimal string arbitrary for parseUsdc testing.
 * Generates decimal strings with 0-7 fractional digits, leading zeros, and ".5" form.
 */
export const usdcStringArb: fc.Arbitrary<string> = fc.oneof(
  // Integer form with possible leading zeros
  fc
    .record({
      leadingZeros: fc.stringMatching(/^0*$/),
      digits: fc.stringMatching(/^[0-9]+$/),
    })
    .map(({ leadingZeros, digits }) => `${leadingZeros}${digits}`),
  // Standard decimal: whole.frac (frac up to 7 digits)
  fc
    .record({
      leadingZeros: fc.stringMatching(/^0*$/),
      whole: fc.stringMatching(/^[0-9]+$/),
      dot: fc.constant("."),
      frac: fc.stringMatching(/^[0-9]{0,7}$/),
    })
    .map(({ leadingZeros, whole, dot, frac }) => `${leadingZeros}${whole}${dot}${frac}`),
  // Lone leading dot form: .5, .0000001
  fc.stringMatching(/^[0-9]{1,7}$/).map((frac) => `.${frac}`)
);
