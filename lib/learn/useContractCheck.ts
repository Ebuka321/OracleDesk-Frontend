"use client";

import { useEffect, useState } from "react";
import { marketCore } from "@/lib/stellar/clients";
import { read, toId, Outcomes, type OutcomeTag } from "@/lib/hooks/useStellar";

export type CheckStatus = "idle" | "checking" | "matches" | "differs" | "market-changed" | "unavailable";

export interface ContractCheckResult {
  status: CheckStatus;
  simulatedValue?: bigint;
  walkthroughValue?: bigint;
  differenceStroops?: bigint;
  ledger?: number;
  message?: string;
}

export function useContractCheck(params: {
  marketId?: string | null;
  side: "Yes" | "No";
  isBuy: boolean;
  amount: bigint;
  expectedSharesOrCollateral: bigint;
  currentLedger?: number;
}): ContractCheckResult {
  const { marketId, side, isBuy, amount, expectedSharesOrCollateral, currentLedger } = params;
  const [result, setResult] = useState<ContractCheckResult>({ status: "idle" });

  useEffect(() => {
    if (!marketId || amount <= 0n) {
      setResult({ status: "idle" });
      return;
    }

    let active = true;
    setResult((prev) => ({ ...prev, status: "checking" }));

    const timer = setTimeout(async () => {
      try {
        const id = toId(marketId);
        const outcome = Outcomes[side];

        let simResult: bigint;
        if (isBuy) {
          const sim = await marketCore().quote_buy({
            market_id: id,
            outcome,
            collateral_in: amount,
          });
          simResult = read<bigint>(sim);
        } else {
          const sim = await marketCore().quote_sell({
            market_id: id,
            outcome,
            collateral_out: amount,
          });
          simResult = read<bigint>(sim);
        }

        if (!active) return;

        const diff = simResult > expectedSharesOrCollateral
          ? simResult - expectedSharesOrCollateral
          : expectedSharesOrCollateral - simResult;

        if (diff === 0n) {
          setResult({
            status: "matches",
            simulatedValue: simResult,
            walkthroughValue: expectedSharesOrCollateral,
            differenceStroops: 0n,
            ledger: currentLedger,
            message: "Exact match with contract simulation",
          });
        } else if (diff <= 2n) {
          // Sub-stroop rounding difference acceptable
          setResult({
            status: "matches",
            simulatedValue: simResult,
            walkthroughValue: expectedSharesOrCollateral,
            differenceStroops: diff,
            ledger: currentLedger,
            message: `Matches within ${diff} stroop rounding tolerance`,
          });
        } else {
          setResult({
            status: "differs",
            simulatedValue: simResult,
            walkthroughValue: expectedSharesOrCollateral,
            differenceStroops: diff,
            ledger: currentLedger,
            message: `Differs by ${diff} stroops`,
          });
        }
      } catch (err) {
        if (!active) return;
        setResult({
          status: "unavailable",
          walkthroughValue: expectedSharesOrCollateral,
          message: "Simulation unavailable or market closed/paused",
        });
      }
    }, 400);

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [marketId, side, isBuy, amount, expectedSharesOrCollateral, currentLedger]);

  return result;
}
