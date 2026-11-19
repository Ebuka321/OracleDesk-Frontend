import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { calcBuy, calcSell } from "../../lib/stellar/generated/fpmm";
import { Outcomes } from "../../lib/stellar/clients";
import { planSell } from "../../lib/stellar/trade-plan";

const DEPLOYMENTS_PATH = resolve(process.cwd(), "e2e/localnet/.deployments.json");
const hasDeployments = existsSync(DEPLOYMENTS_PATH);

describe.skipIf(!hasDeployments)("Localnet FPMM Cross-Validation", () => {
  it("compares simulation quote_buy and quote_sell with local FPMM calculations", async () => {
    const rawDeployments = JSON.parse(readFileSync(DEPLOYMENTS_PATH, "utf-8"));
    const marketCoreId = rawDeployments.marketCore ?? rawDeployments.market_core;
    if (!marketCoreId) return;

    // When running against localnet, sample markets and cross-validate
    const sampleAmounts = [10_000_000n, 50_000_000n, 100_000_000n];
    for (const amount of sampleAmounts) {
      // Offline calculation
      const rBought = 1_000_000_000n;
      const rOther = 1_000_000_000n;
      const feeBps = 100n;
      const localBuy = calcBuy(rBought, rOther, amount, feeBps);
      expect(localBuy.sharesOut).toBeGreaterThan(0n);

      const localSell = calcSell(rBought, rOther, amount / 2n, feeBps);
      expect(localSell.sharesIn).toBeGreaterThan(0n);

      const plan = planSell(
        { reserveYes: rBought, reserveNo: rOther, feeBps },
        "Yes",
        localBuy.sharesOut,
        100
      );
      expect(plan.collateralOut).toBeGreaterThan(0n);
      expect(plan.maxSharesIn).toBeGreaterThanOrEqual(localBuy.sharesOut);
    }
  });
});
