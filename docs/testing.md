# Testing Guide

This document describes the testing suites, property tests, mutation testing, and contract testing in OracleDesk Frontend.

## Properties (FPMM & Units)

The suite in `lib/stellar/__tests__/fpmm-properties.test.ts` states and verifies core mathematical invariants over the FPMM and units conversion space using `fast-check`.

### Invariants

- **P1: Sell Never Needs More Than Padded Shares**: For valid `planSell(r, outcome, shares, slippageBps)`, `calcSell(rSold, rOther, collateralOut, fee).sharesIn <= maxSharesIn`. Tests verify whether the tighter `sharesIn <= shares` holds and measure how often `+1n` padding is required. (Discovered off-by-two edge case in `grossForShares` documented in `docs/contract-requests.md` #5).
- **P2: Sell Proceeds Are Non-Trivial**: `collateralOut > 0n` whenever `shares` is above the dust threshold, and `collateralOut <= shares` (a share is never worth more than 1 USDC base unit).
- **P3: MinOut Is a Lower Bound**: For any `quote = calcBuy(...).sharesOut`, `minOut(quote, s) <= quote` and `minOut(quote, 0) === quote`. Under adverse price moves within tolerance `s`, post-trade shares remain `>= minOut`.
- **P4: Buy Is Monotonic**: Larger `collateralIn` never yields fewer `sharesOut`, and `sharesOut >= net`.
- **P5: Pool-Favouring Rounding**: `calcSell(collateralOut).sharesIn >= exact rational shares` (rounding never favours the trader).
- **P6: Price Bounds & Direction**: `priceYesBps ∈ [0, 10_000]` and moves in the expected direction after YES / NO buys.
- **P7: Settlement Conservation**: For any valid sequence of trades from a seed, total `settleValue` across all token holders and the pool remainder equals `sets_minted` collateral, and void payouts round down.
- **P8: Units Round Trip**: `formatUsdc(parseUsdc(x)) === canonical(x)` for every valid decimal string; `parseUsdc(formatUsdc(n)) === n` for any $n \in [0, 10^{20}]$; slippage bounds and `shareOf(a, 10_000) === a`.

### Running Properties & Reproducing Counterexamples

- Run default property suite (500 iterations, fixed seed):
  ```bash
  npm test
  ```
- Run deep property exploration locally (20,000 iterations):
  ```bash
  npm run test:props
  ```
- Override seed and runs:
  ```bash
  FC_SEED=12345 FC_RUNS=1000 vitest run lib/stellar/__tests__/fpmm-properties.test.ts
  ```

When a property fails, `fast-check` shrinks the failure and outputs a JSON summary with market state and a replay command:
```bash
stellar contract invoke --id $MARKET_CORE --network localnet -- quote_sell --market_id <id> --outcome '"Yes"' --collateral_out <collateralOut>
```
