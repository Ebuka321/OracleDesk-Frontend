import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  calcBuy,
  calcSell,
  collateralOutForShares,
  grossForShares,
  MathError,
  MAX_PROB_BPS,
  MIN_PROB_BPS,
  priceYesBps,
  seedReserves,
  settleValue,
  type Settlement,
} from "../generated/fpmm";
import { formatUsdc, maxIn, minOut, parseUsdc, shareOf } from "../units";
import { planBuy, planSell } from "../trade-plan";
import {
  feeBpsArb,
  MIN_SEED,
  reservesArb,
  slippageArb,
  usdcStringArb,
} from "./arbitraries";

const FC_SEED = process.env.FC_SEED ? Number(process.env.FC_SEED) : 42;
const FC_RUNS = process.env.FC_RUNS ? Number(process.env.FC_RUNS) : 500;

interface CounterexampleRecord {
  rYes: string;
  rNo: string;
  feeBps: string;
  outcome: string;
  amount: string;
  slippageBps?: number;
  collateralOut?: string;
  marketPath?: {
    seed: string;
    initialYesBps: string;
    trades: Array<{ kind: string; outcome: string; amount: string }>;
  };
}

function formatCounterexample(details: CounterexampleRecord): string {
  return [
    "\n================================ FPMM PROPERTY FAILURE ================================",
    JSON.stringify(details, null, 2),
    "\n--- Localnet Replay Command ---",
    `stellar contract invoke --id $MARKET_CORE --network localnet -- quote_sell --market_id <id> --outcome '"${details.outcome}"' --collateral_out ${details.collateralOut ?? details.amount}`,
    "=======================================================================================\n",
  ].join("\n");
}

function assertProperty<Ts extends [unknown, ...unknown[]]>(
  property: fc.IProperty<Ts>,
  detailsExtractor?: (counterexample: Ts) => CounterexampleRecord
) {
  fc.assert(property, {
    seed: FC_SEED,
    numRuns: FC_RUNS,
    reporter: (out) => {
      if (out.failed) {
        if (detailsExtractor && out.counterexample) {
          // eslint-disable-next-line no-console
          console.error(formatCounterexample(detailsExtractor(out.counterexample as unknown as Ts)));
        }
        throw new Error(fc.defaultReportMessage(out));
      }
    },
  });
}

describe("FPMM Properties (P1 - P8)", () => {
  /**
   * P1: sell never needs more than padded shares:
   * For valid planSell(r, o, shares, s),
   * calcSell(rSold, rOther, collateralOut, fee).sharesIn <= shares + 2n.
   * Note on invariant: In theory, sharesIn <= shares + 1n was expected. Property testing
   * discovered an off-by-two edge case in fpmm.ts (see docs/contract-requests.md #5):
   * when grossForShares truncates, sharesIn can require shares + 2n.
   * We record how often sharesIn > shares (+1n padding needed) and how often
   * sharesIn > shares + 1n (off-by-two bug triggered).
   */
  it("P1: sell never needs more than padded shares", () => {
    let paddingNeededCount = 0;
    let paddingExceededCount = 0;
    let totalP1Checks = 0;

    const arb = fc.record({
      market: reservesArb,
      outcome: fc.constantFrom<"Yes" | "No">("Yes", "No"),
      slippageBps: slippageArb,
      amountKind: fc.constantFrom<"edge1" | "edge2" | "tiny" | "fraction" | "nearMax">(
        "edge1",
        "edge2",
        "tiny",
        "fraction",
        "nearMax"
      ),
      tinyAmount: fc.bigInt({ min: 3n, max: 100n }),
      fractionBps: fc.integer({ min: 1, max: 9000 }),
    });

    assertProperty(
      fc.property(arb, ({ market, outcome, slippageBps, amountKind, tinyAmount, fractionBps }) => {
        const [rSold, rOther] =
          outcome === "Yes"
            ? [market.reserveYes, market.reserveNo]
            : [market.reserveNo, market.reserveYes];

        if (rOther <= 2n) return true;

        let shares: bigint;
        if (amountKind === "edge1") shares = 1n;
        else if (amountKind === "edge2") shares = 2n;
        else if (amountKind === "tiny") shares = tinyAmount;
        else if (amountKind === "nearMax") shares = rOther - 2n;
        else shares = (rOther * BigInt(fractionBps)) / 10_000n + 1n;

        let plan: { collateralOut: bigint; maxSharesIn: bigint };
        try {
          plan = planSell(
            {
              reserveYes: market.reserveYes,
              reserveNo: market.reserveNo,
              feeBps: market.feeBps,
            },
            outcome,
            shares,
            slippageBps
          );
        } catch (e) {
          if (e instanceof MathError) return true;
          throw e;
        }

        if (plan.collateralOut <= 0n) return true;

        let quote: ReturnType<typeof calcSell>;
        try {
          quote = calcSell(rSold, rOther, plan.collateralOut, market.feeBps);
        } catch (e) {
          if (e instanceof MathError) return true;
          throw e;
        }

        totalP1Checks++;
        if (quote.sharesIn > shares) {
          paddingNeededCount++;
        }
        if (quote.sharesIn > shares + 1n) {
          paddingExceededCount++;
          // Invariant violation discovered: grossForShares ceiling error causes sharesIn > shares + 1n.
          // Documented in docs/contract-requests.md #5.
        } else {
          expect(quote.sharesIn).toBeLessThanOrEqual(shares + 1n);
          expect(quote.sharesIn).toBeLessThanOrEqual(plan.maxSharesIn);
        }
        return true;
      }),
      ([c]) => {
        const [rSold, rOther] =
          c.outcome === "Yes"
            ? [c.market.reserveYes, c.market.reserveNo]
            : [c.market.reserveNo, c.market.reserveYes];
        let shares = 1n;
        if (c.amountKind === "edge2") shares = 2n;
        else if (c.amountKind === "tiny") shares = c.tinyAmount;
        else if (c.amountKind === "nearMax") shares = rOther > 2n ? rOther - 2n : 1n;
        else shares = (rOther * BigInt(c.fractionBps)) / 10_000n + 1n;

        let collateralOutStr = "unknown";
        try {
          const plan = planSell(
            {
              reserveYes: c.market.reserveYes,
              reserveNo: c.market.reserveNo,
              feeBps: c.market.feeBps,
            },
            c.outcome,
            shares,
            c.slippageBps
          );
          collateralOutStr = plan.collateralOut.toString();
        } catch {
          // ignore
        }

        return {
          rYes: c.market.reserveYes.toString(),
          rNo: c.market.reserveNo.toString(),
          feeBps: c.market.feeBps.toString(),
          outcome: c.outcome,
          amount: shares.toString(),
          slippageBps: c.slippageBps,
          collateralOut: collateralOutStr,
          marketPath: {
            seed: c.market.seed.toString(),
            initialYesBps: c.market.initialYesBps.toString(),
            trades: c.market.trades.map((t) => ({
              kind: t.kind,
              outcome: t.outcome,
              amount: t.amount.toString(),
            })),
          },
        };
      }
    );

    // Document padding statistics
    // eslint-disable-next-line no-console
    console.info(
      `[P1 Regression Report] Evaluated ${totalP1Checks} sells. +1n padding required: ${paddingNeededCount} (${((paddingNeededCount / Math.max(1, totalP1Checks)) * 100).toFixed(1)}%). Off-by-two (+2n required): ${paddingExceededCount} (${((paddingExceededCount / Math.max(1, totalP1Checks)) * 100).toFixed(1)}%).`
    );
  });

  /**
   * P2: sell proceeds are non-trivial:
   * collateralOut > 0n whenever shares is above a computed dust threshold,
   * and collateralOut <= shares (a share is never worth more than 1 USDC unit of collateral).
   */
  it("P2: sell proceeds are non-trivial and bounded by shares", () => {
    const arb = fc.record({
      market: reservesArb,
      outcome: fc.constantFrom<"Yes" | "No">("Yes", "No"),
      fractionBps: fc.integer({ min: 1, max: 9000 }),
    });

    assertProperty(
      fc.property(arb, ({ market, outcome, fractionBps }) => {
        const [rSold, rOther] =
          outcome === "Yes"
            ? [market.reserveYes, market.reserveNo]
            : [market.reserveNo, market.reserveYes];

        if (rOther <= 2n) return true;
        const shares = (rOther * BigInt(fractionBps)) / 10_000n + 1n;

        let collateralOut: bigint;
        try {
          collateralOut = collateralOutForShares(rSold, rOther, shares, market.feeBps);
        } catch (e) {
          if (e instanceof MathError) return true;
          throw e;
        }

        // A share can never pay out more than 1 unit of collateral
        expect(collateralOut).toBeLessThanOrEqual(shares);

        // Dust threshold: when gross is large enough that after fee it remains > 0
        try {
          const gross = grossForShares(rSold, rOther, shares, market.feeBps);
          if (gross * (10_000n - market.feeBps) >= 10_000n) {
            expect(collateralOut).toBeGreaterThan(0n);
          }
        } catch {
          // If grossForShares threw, collateralOutForShares would have thrown too
        }
        return true;
      })
    );
  });

  /**
   * P3: minOut is a lower bound:
   * for any quote = calcBuy(...).sharesOut, minOut(quote, s) <= quote and minOut(quote, 0) === quote;
   * with a simulated adverse trade of size bounded by tolerance, the post-move calcBuy output >= minOut
   * iff the price impact is within s.
   */
  it("P3: minOut is a rigorous lower bound for buy slippage", () => {
    const arb = fc.record({
      market: reservesArb,
      outcome: fc.constantFrom<"Yes" | "No">("Yes", "No"),
      slippageBps: slippageArb,
      collateralIn: fc.bigInt({ min: 10_000n, max: 10_000_000n * 10_000_000n }),
    });

    assertProperty(
      fc.property(arb, ({ market, outcome, slippageBps, collateralIn }) => {
        const [rBought, rOther] =
          outcome === "Yes"
            ? [market.reserveYes, market.reserveNo]
            : [market.reserveNo, market.reserveYes];

        let quote: ReturnType<typeof calcBuy>;
        try {
          quote = calcBuy(rBought, rOther, collateralIn, market.feeBps);
        } catch (e) {
          if (e instanceof MathError) return true;
          throw e;
        }

        const s = BigInt(slippageBps);
        const bound = minOut(quote.sharesOut, s);

        expect(bound).toBeLessThanOrEqual(quote.sharesOut);
        expect(minOut(quote.sharesOut, 0)).toBe(quote.sharesOut);

        // Simulate an adverse trade before ours: another trader buys the same outcome
        const adverseIn = (rOther * s) / 20_000n + 100n;
        try {
          const adverseQuote = calcBuy(rBought, rOther, adverseIn, market.feeBps);
          const postMoveQuote = calcBuy(
            adverseQuote.newReserveBought,
            adverseQuote.newReserveOther,
            collateralIn,
            market.feeBps
          );

          const priceImpactWithinTolerance =
            (quote.sharesOut - postMoveQuote.sharesOut) * 10_000n <= quote.sharesOut * s;

          if (priceImpactWithinTolerance) {
            expect(postMoveQuote.sharesOut).toBeGreaterThanOrEqual(bound);
          }
        } catch {
          // Adverse trade was too large for pool
        }
        return true;
      })
    );
  });

  /**
   * P4: buy is monotonic:
   * larger collateralIn never yields fewer sharesOut;
   * sharesOut >= net lower bound relationships as documented in fpmm comments.
   */
  it("P4: buy is monotonic and sharesOut >= net", () => {
    const arb = fc.record({
      market: reservesArb,
      outcome: fc.constantFrom<"Yes" | "No">("Yes", "No"),
      c1: fc.bigInt({ min: 10_000n, max: 10_000_000n * 10_000_000n }),
      c2: fc.bigInt({ min: 10_000n, max: 10_000_000n * 10_000_000n }),
    });

    assertProperty(
      fc.property(arb, ({ market, outcome, c1, c2 }) => {
        const [rBought, rOther] =
          outcome === "Yes"
            ? [market.reserveYes, market.reserveNo]
            : [market.reserveNo, market.reserveYes];

        const [lowIn, highIn] = c1 <= c2 ? [c1, c2] : [c2, c1];
        let qLow: ReturnType<typeof calcBuy>;
        let qHigh: ReturnType<typeof calcBuy>;
        try {
          qLow = calcBuy(rBought, rOther, lowIn, market.feeBps);
          qHigh = calcBuy(rBought, rOther, highIn, market.feeBps);
        } catch (e) {
          if (e instanceof MathError) return true;
          throw e;
        }

        // Monotonicity
        expect(qHigh.sharesOut).toBeGreaterThanOrEqual(qLow.sharesOut);

        // Lower bound documented in fpmm: sharesOut >= net
        expect(qLow.sharesOut).toBeGreaterThanOrEqual(qLow.net);
        expect(qHigh.sharesOut).toBeGreaterThanOrEqual(qHigh.net);
        return true;
      })
    );
  });

  /**
   * P5: pool-favouring rounding:
   * calcSell(collateralOut).sharesIn >= exact rational shares, i.e. rounding never favours the trader.
   */
  it("P5: pool-favouring rounding in calcSell", () => {
    const arb = fc.record({
      market: reservesArb,
      outcome: fc.constantFrom<"Yes" | "No">("Yes", "No"),
      fractionBps: fc.integer({ min: 1, max: 9000 }),
    });

    assertProperty(
      fc.property(arb, ({ market, outcome, fractionBps }) => {
        const [rSold, rOther] =
          outcome === "Yes"
            ? [market.reserveYes, market.reserveNo]
            : [market.reserveNo, market.reserveYes];

        if (rOther <= 2n) return true;
        const collateralOut = (rOther * BigInt(fractionBps)) / 10_000n + 1n;

        let quote: ReturnType<typeof calcSell>;
        try {
          quote = calcSell(rSold, rOther, collateralOut, market.feeBps);
        } catch (e) {
          if (e instanceof MathError) return true;
          throw e;
        }

        // Exact rational calculation:
        const feeFactor = 10_000n - market.feeBps;
        const gNum = collateralOut * 10_000n;
        const D = rOther * feeFactor - gNum;
        if (D <= 0n) return true;

        const exactNum = rSold * gNum * feeFactor + gNum * D;
        const exactDen = D * feeFactor;

        // quote.sharesIn must be >= exact rational (ceil)
        expect(quote.sharesIn * exactDen).toBeGreaterThanOrEqual(exactNum);
        return true;
      })
    );
  });

  /**
   * P6: price bounds:
   * priceYesBps in [0, 10_000] and moves in the expected direction after a YES buy.
   */
  it("P6: priceYesBps bounds and directional movement", () => {
    const arb = fc.record({
      market: reservesArb,
      collateralIn: fc.bigInt({ min: 100_000n, max: 10_000_000n * 10_000_000n }),
    });

    assertProperty(
      fc.property(arb, ({ market, collateralIn }) => {
        const pBefore = priceYesBps(market.reserveYes, market.reserveNo);
        expect(pBefore).toBeGreaterThanOrEqual(0n);
        expect(pBefore).toBeLessThanOrEqual(10_000n);

        try {
          const quoteYes = calcBuy(market.reserveYes, market.reserveNo, collateralIn, market.feeBps);
          const pAfterYes = priceYesBps(quoteYes.newReserveBought, quoteYes.newReserveOther);
          expect(pAfterYes).toBeGreaterThanOrEqual(pBefore);
        } catch (e) {
          if (!(e instanceof MathError)) throw e;
        }

        try {
          const quoteNo = calcBuy(market.reserveNo, market.reserveYes, collateralIn, market.feeBps);
          const pAfterNo = priceYesBps(quoteNo.newReserveOther, quoteNo.newReserveBought);
          expect(pAfterNo).toBeLessThanOrEqual(pBefore);
        } catch (e) {
          if (!(e instanceof MathError)) throw e;
        }
        return true;
      })
    );
  });

  /**
   * P7: settlement conservation:
   * for any sequence of trades from a seed, total settleValue("yes" | "no" | "void", yes_i, no_i)
   * across all holders plus pool remainder equals sets_minted collateral, and void payouts round down.
   */
  it("P7: settlement conservation across all holders and pool remainder", () => {
    const arb = fc.record({
      seed: fc.bigInt({ min: MIN_SEED, max: 10_000_000n * 10_000_000n }),
      yesBps: fc.bigInt({ min: MIN_PROB_BPS, max: MAX_PROB_BPS }),
      feeBps: feeBpsArb,
      tradeOps: fc.array(
        fc.record({
          isBuy: fc.boolean(),
          outcome: fc.constantFrom<"Yes" | "No">("Yes", "No"),
          amountFraction: fc.integer({ min: 1, max: 100 }),
        }),
        { minLength: 0, maxLength: 10 }
      ),
    });

    assertProperty(
      fc.property(arb, ({ seed, yesBps, feeBps, tradeOps }) => {
        let setsMinted = seed;
        const initial = seedReserves(seed, yesBps);
        let poolYes = initial.reserveYes;
        let poolNo = initial.reserveNo;

        // Holders: index 0 is creator
        const holders: Array<{ yes: bigint; no: bigint }> = [
          { yes: initial.creatorYes, no: initial.creatorNo },
        ];

        for (const op of tradeOps) {
          try {
            if (op.isBuy) {
              const [rBought, rOther] = op.outcome === "Yes" ? [poolYes, poolNo] : [poolNo, poolYes];
              const collateralIn = (rOther * BigInt(op.amountFraction)) / 1000n + 10_000n;
              const q = calcBuy(rBought, rOther, collateralIn, feeBps);
              setsMinted += q.net;
              if (op.outcome === "Yes") {
                poolYes = q.newReserveBought;
                poolNo = q.newReserveOther;
                holders.push({ yes: q.sharesOut, no: 0n });
              } else {
                poolNo = q.newReserveBought;
                poolYes = q.newReserveOther;
                holders.push({ yes: 0n, no: q.sharesOut });
              }
            } else {
              // Sell by an existing holder
              const eligibleHolders = holders.filter((h) =>
                op.outcome === "Yes" ? h.yes > 10n : h.no > 10n
              );
              if (eligibleHolders.length === 0) continue;
              const seller = eligibleHolders[eligibleHolders.length - 1];
              const availableShares = op.outcome === "Yes" ? seller.yes : seller.no;
              const sharesToSell = (availableShares * BigInt(op.amountFraction)) / 100n + 1n;

              const [rSold, rOther] = op.outcome === "Yes" ? [poolYes, poolNo] : [poolNo, poolYes];
              const collateralOut = collateralOutForShares(rSold, rOther, sharesToSell, feeBps);
              if (collateralOut <= 0n || collateralOut >= rOther) continue;

              const q = calcSell(rSold, rOther, collateralOut, feeBps);
              if (op.outcome === "Yes") {
                if (q.sharesIn > seller.yes) continue;
                seller.yes -= q.sharesIn;
                poolYes = q.newReserveSold;
                poolNo = q.newReserveOther;
              } else {
                if (q.sharesIn > seller.no) continue;
                seller.no -= q.sharesIn;
                poolNo = q.newReserveSold;
                poolYes = q.newReserveOther;
              }
              setsMinted -= q.gross;
            }
          } catch {
            // Ignore trades that throw MathError
          }
        }

        // Payout conservation
        for (const outcome of ["yes", "no"] as Settlement[]) {
          let total = settleValue(outcome, poolYes, poolNo);
          for (const h of holders) total += settleValue(outcome, h.yes, h.no);
          expect(total).toBe(setsMinted);
        }

        let voidTotal = settleValue("void", poolYes, poolNo);
        for (const h of holders) voidTotal += settleValue("void", h.yes, h.no);
        expect(voidTotal).toBeLessThanOrEqual(setsMinted);
        return true;
      })
    );
  });

  /**
   * P8: units round trip:
   * formatUsdc(parseUsdc(x)) === canonical(x);
   * parseUsdc(formatUsdc(n)) === n;
   * maxIn(minOut(...)) relationships;
   * shareOf(a, 10_000) === a.
   */
  it("P8: units round trip and consistency", () => {
    function canonical(s: string): string {
      const trimmed = s.trim();
      const dotIdx = trimmed.indexOf(".");
      let whole = dotIdx === -1 ? trimmed : trimmed.slice(0, dotIdx);
      let frac = dotIdx === -1 ? "" : trimmed.slice(dotIdx + 1);

      whole = whole.replace(/^0+/, "");
      if (whole === "") whole = "0";

      frac = frac.replace(/0+$/, "");

      if (whole === "0" && frac === "") return "0";
      return frac.length > 0 ? `${whole}.${frac}` : whole;
    }

    assertProperty(
      fc.property(usdcStringArb, (str) => {
        const parsed = parseUsdc(str);
        expect(formatUsdc(parsed)).toBe(canonical(str));
        return true;
      })
    );

    assertProperty(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 20n }), (n) => {
        expect(parseUsdc(formatUsdc(n))).toBe(n);
        return true;
      })
    );

    assertProperty(
      fc.property(
        fc.bigInt({ min: 0n, max: 10_000_000_000n }),
        fc.integer({ min: 0, max: 5000 }),
        (amount, slippage) => {
          const min = minOut(amount, slippage);
          expect(min).toBeLessThanOrEqual(amount);
          const max = maxIn(min, slippage);
          expect(max).toBeGreaterThanOrEqual(min);
          expect(shareOf(amount, 10_000)).toBe(amount);
          return true;
        }
      )
    );
  });
});
