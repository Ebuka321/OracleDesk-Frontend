# Interactive FPMM Explainer (`/learn/fpmm`)

The `/learn/fpmm` page explains the mathematics behind the Constant Product Market Maker (FPMM) implemented in `lib/stellar/generated/fpmm.ts`. All interactive walkthrough calculations execute in pure `bigint` stroop precision (7 decimal places) and cross-check live against contract simulations.

---

## Verified Claims & Algorithmic Rules

### 1. Invariant Product Monotonicity ($k_{after} \ge k_{before}$)
- **Claim:** Every trade increases or strictly maintains the invariant product $k = r_{Yes} \cdot r_{No}$ due to ceiling rounding and retained protocol fees. The pool can never lose invariant mass.
- **Verification:** Tested in `lib/learn/__tests__/fpmm-walkthrough.test.ts` across a grid of reserves and fee tiers.

### 2. Rounding Favours the Pool
- **Claim:** All intermediate divisions in `calcBuy` and `calcSell` round against the trader:
  - Protocol fees are ceil-rounded (`(collateralIn * feeBps + BPS - 1n) / BPS`).
  - Target reserves updated after swaps are ceil-rounded.
  - Complete sets burned in sells are ceil-rounded.
  - Shares received and collateral paid out are floor-rounded.
- **Verification:** Unit tested in `lib/learn/__tests__/fpmm-walkthrough.test.ts` asserting exact equality with `calcBuy` and `calcSell`.

### 3. Marginal vs Average Price
- **Claim:** On a constant-product AMM, the average execution price $\frac{\text{collateralIn}}{\text{sharesOut}}$ is strictly worse (higher for buys, lower for sells) than the pre-trade marginal spot price $\frac{r_{Other}}{r_{Bought} + r_{Other}}$, reflecting slippage along the curve.
- **Verification:** Tested in `lib/learn/__tests__/fpmm-walkthrough.test.ts`.

### 4. Slippage Bounds & Contract Reverts
- **Claim:** Every buy orders with a strict minimum shares threshold `minOut(sharesOut, slippageBps)`. If prior transactions execute in the same ledger and move the price past this bound, the contract throws host error 12 (`SlippageExceeded`) and reverts the transaction atomically.
- **Verification:** Handled in `buyWalkthrough` and tested against contract error specs.

### 5. Settlement Value Invariant
- **Claim:** Complete sets settle 1:1 on the winning outcome, while a voided market settles exactly $\lfloor\frac{yes + no}{2}\rfloor$ to preserve complete-set balance without creating unbacked tokens.
- **Verification:** Unit tested in `lib/learn/__tests__/fpmm-walkthrough.test.ts`.
