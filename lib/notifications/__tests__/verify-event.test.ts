import { describe, expect, it } from "vitest";
import type { DecodedEvent } from "@/lib/stellar/events";
import type { InboxItem } from "../store";
import { verifyFill } from "../verify-event";

const owner = "GOWNER";
const item: InboxItem = {
  id: "fill:0001-1", owner, network: "test", kind: "fill", marketId: "7", ledger: 100, createdAt: 0, readAt: null,
  data: { collateralRaw: "500", sharesRaw: "900", direction: "YES", action: "Bought", question: "" },
};
const trade = (o: Partial<Record<string, unknown>> = {}) => ({
  kind: "Trade", marketId: 7n, trader: owner, outcome: "Yes", isBuy: true, collateral: 500n, shares: 900n, fee: 5n,
  reserveYes: 0n, reserveNo: 0n, meta: { id: "0001-1", ledger: 100, ledgerClosedAt: "", txHash: "" }, ...o,
}) as unknown as DecodedEvent;
const ctx = (events: DecodedEvent[], o: Partial<{ oldestLedger: number; latestLedger: number; now: number }> = {}) => ({
  events, window: { oldestLedger: o.oldestLedger ?? 1, latestLedger: o.latestLedger ?? 105 }, now: o.now ?? 0, firstSeen: 0,
});

describe("verifyFill", () => {
  it("verifies an exact match and rejects a field mismatch", () => {
    expect(verifyFill(item, ctx([trade()]))).toEqual({ id: item.id, status: "verified", ledger: 100, feeRaw: "5" });
    expect(verifyFill(item, ctx([trade({ shares: 901n })]))?.status).toBe("mismatch");
  });

  it("stays provisional, then not-found, and is unverifiable outside retention", () => {
    expect(verifyFill(item, ctx([]))).toBeNull();
    expect(verifyFill(item, ctx([], { latestLedger: 120, now: 61_000 }))?.status).toBe("not-found");
    expect(verifyFill(item, ctx([], { oldestLedger: 200, latestLedger: 300 }))?.status).toBe("unverifiable");
  });
});
