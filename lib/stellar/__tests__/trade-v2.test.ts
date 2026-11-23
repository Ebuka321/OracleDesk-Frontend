import { describe, expect, it, vi, beforeEach } from "vitest";
import { xdr } from "@stellar/stellar-sdk";
import {
  MAX_LIMIT_PRICE_BPS,
  buyWithinLimit,
  clampOnChainDeadline,
  clearTradeV2CapabilityCache,
  deriveBuyLimitPriceBps,
  deriveSellLimitPriceBps,
  detectMarketCoreTradeV2,
  sellWithinLimit,
  specSupportsTradeV2,
} from "../trade-v2";
import { assertSigningDeadline, deadlineFor } from "../deadline";
import { MULTISIG_DEFAULT_TIMEOUT_S } from "../multisig";
import { assertIntentMatches, type ReviewModel } from "../tx-decode";
import { describeError } from "../errors";

function makeFuncSpecEntry(name: string): xdr.ScSpecEntry {
  return xdr.ScSpecEntry.scSpecEntryFunctionV0(
    new xdr.ScSpecFunctionV0({
      doc: "",
      name,
      inputs: [],
      outputs: [],
    }),
  );
}

describe("trade-v2 limit price derivations (Issue #241)", () => {
  it("buy_v2: rounds UP (ceil) so any trade meeting min_shares_out satisfies buy_within_limit", () => {
    const cases: Array<[bigint, bigint]> = [
      [10_000_000n, 20_000_000n], // exact 5000 bps
      [10_000_000n, 19_999_999n], // fractional -> rounds up to 5001
      [1n, 3n], // 3333.33 -> 3334
      [99_999_999_999_999n, 100_000_000_000_000n], // large values near 10_000
      [100_000_000_000_000n, 300_000_000_000_001n], // large values
    ];
    for (const [collateralIn, minSharesOut] of cases) {
      const derived = deriveBuyLimitPriceBps(collateralIn, minSharesOut);
      expect(derived.clamped).toBe(false);
      // Must satisfy buy_within_limit at the worst acceptable sharesOut == minSharesOut
      expect(buyWithinLimit(collateralIn, minSharesOut, derived.limitPriceBps)).toBe(true);
      // And any better outcome (more shares) also passes
      expect(buyWithinLimit(collateralIn, minSharesOut + 1n, derived.limitPriceBps)).toBe(true);
      // Tightness: 1 bps lower would fail at exact boundary (when not exact)
      if ((collateralIn * 10_000n) % minSharesOut !== 0n && derived.limitPriceBps > 1) {
        expect(buyWithinLimit(collateralIn, minSharesOut, derived.limitPriceBps - 1)).toBe(false);
      }
    }
  });

  it("buy_v2: clamps > 10_000 bps to 10_000 and reports clamped=true", () => {
    const derived = deriveBuyLimitPriceBps(10_000_000n, 9_500_000n);
    expect(derived.limitPriceBps).toBe(MAX_LIMIT_PRICE_BPS);
    expect(derived.clamped).toBe(true);
    expect(derived.unclampedBps).toBeGreaterThan(10_000n);
  });

  it("sell_v2: rounds DOWN (floor) so any trade meeting max_shares_in satisfies sell_within_limit", () => {
    const cases: Array<[bigint, bigint]> = [
      [10_000_000n, 20_000_000n], // exact 5000 bps
      [10_000_000n, 20_000_001n], // fractional -> rounds down to 4999
      [1n, 3n], // 3333.33 -> 3333
      [99_999_999_999_999n, 100_000_000_000_000n], // large values
      [100_000_000_000_000n, 300_000_000_000_001n], // large values
    ];
    for (const [collateralOut, maxSharesIn] of cases) {
      const derived = deriveSellLimitPriceBps(collateralOut, maxSharesIn);
      expect(derived.clamped).toBe(false);
      // Must satisfy sell_within_limit at worst acceptable sharesIn == maxSharesIn
      expect(sellWithinLimit(collateralOut, maxSharesIn, derived.limitPriceBps)).toBe(true);
      // And any better outcome (fewer shares sold) also passes
      if (maxSharesIn > 1n) {
        expect(sellWithinLimit(collateralOut, maxSharesIn - 1n, derived.limitPriceBps)).toBe(true);
      }
      // Tightness: 1 bps higher would fail at exact boundary
      if ((collateralOut * 10_000n) % maxSharesIn !== 0n) {
        expect(sellWithinLimit(collateralOut, maxSharesIn, derived.limitPriceBps + 1)).toBe(false);
      }
    }
  });

  it("rejects zero or negative min_shares_out / max_shares_in rather than dividing by zero", () => {
    expect(() => deriveBuyLimitPriceBps(10_000_000n, 0n)).toThrow(/greater than zero/i);
    expect(() => deriveBuyLimitPriceBps(0n, 10_000_000n)).toThrow(/greater than zero/i);
    expect(() => deriveSellLimitPriceBps(10_000_000n, 0n)).toThrow(/greater than zero/i);
    expect(() => deriveSellLimitPriceBps(0n, 10_000_000n)).toThrow(/greater than zero/i);
  });
});

describe("trade-v2 deadlines (normal & multisig)", () => {
  it("caps normal and 1-hour multisig deadlines against close_time minus safety margin", () => {
    // Far from close: normal gets 60s, multisig gets 3600s
    expect(deadlineFor("buy", 1_000, 10_000n)).toEqual({ timeoutInSeconds: 60, maxTime: 1_060 });
    expect(deadlineFor("buy", 1_000, 10_000n, MULTISIG_DEFAULT_TIMEOUT_S)).toEqual({
      timeoutInSeconds: 3_600,
      maxTime: 4_600,
    });

    // Near close (1000s left): multisig is capped at close_time - 10s
    expect(deadlineFor("sell", 1_000, 2_000n, MULTISIG_DEFAULT_TIMEOUT_S)).toEqual({
      timeoutInSeconds: 990,
      maxTime: 1_990,
    });

    // After close or within 25s: refused
    expect(() => deadlineFor("buy", 2_000, 2_000n)).toThrow(/under 25 seconds/i);
    expect(() => deadlineFor("sell", 2_010, 2_000n)).toThrow(/under 25 seconds/i);

    // On-chain deadline never exceeds envelope timeBounds.maxTime
    expect(clampOnChainDeadline(1_500, "1400")).toBe(1_400n);
    expect(clampOnChainDeadline(1_500, "1600")).toBe(1_500n);

    // Signing deadline check
    const dl = deadlineFor("buy", 1_000, 5_000n);
    expect(() => assertSigningDeadline(dl, dl.maxTime - 6)).not.toThrow();
    expect(() => assertSigningDeadline(dl, dl.maxTime - 5)).toThrow(/signing took too long/i);
  });
});

describe("trade-v2 capability detection & legacy fallback", () => {
  beforeEach(() => {
    clearTradeV2CapabilityCache();
  });

  it("detects buy_v2 and sell_v2 in contract spec entries", () => {
    expect(specSupportsTradeV2([makeFuncSpecEntry("buy"), makeFuncSpecEntry("sell")])).toEqual({
      buyV2: false,
      sellV2: false,
    });
    expect(specSupportsTradeV2([makeFuncSpecEntry("buy_v2"), makeFuncSpecEntry("sell_v2")])).toEqual({
      buyV2: true,
      sellV2: true,
    });
  });

  it("falls back safely to legacy when forced or when RPC detection fails", async () => {
    const failingServer = {
      getLedgerEntries: vi.fn().mockRejectedValue(new Error("RPC offline")),
    };
    const forced = await detectMarketCoreTradeV2(failingServer, "CC4MMHWZ6ZRYAOQRR42KIIWNEZNFM4CWQ5Y4NNWTWNRUYH2O7E3SRK2O", true);
    expect(forced).toMatchObject({ supported: false, reason: "forced-legacy" });
    expect(failingServer.getLedgerEntries).not.toHaveBeenCalled();

    const failed = await detectMarketCoreTradeV2(failingServer, "CC4MMHWZ6ZRYAOQRR42KIIWNEZNFM4CWQ5Y4NNWTWNRUYH2O7E3SRK2O", false);
    expect(failed.supported).toBe(false);
    expect(failed.reason).toContain("RPC offline");
  });
});

describe("trade-v2 intent verification & contract error mapping", () => {
  it("blocks signing when decoded limit_price_bps or deadline mismatches intent", () => {
    const model: ReviewModel = {
      network: "Stellar Testnet",
      source: "GTRADER",
      sequence: "1",
      fee: "0.0000100 XLM",
      validFrom: "0",
      validUntil: "1060",
      contractId: "CMARKET",
      contractName: "Market core",
      fn: "buy_v2",
      hash: "a".repeat(64),
      args: [
        { label: "Source account", type: "Address", display: "GTRADER", raw: "GTRADER" },
        { label: "Market id", type: "u64", display: "#7", raw: "7" },
        { label: "Outcome", type: "Outcome", display: "No", raw: "No" },
        { label: "Collateral in (USDC)", type: "i128", display: "10.0000000 USDC", raw: "100000000" },
        { label: "Minimum shares out", type: "i128", display: "18.0000000 USDC", raw: "180000000" },
        { label: "Limit price", type: "u32", display: "55.56% (5556 bps)", raw: "5556" },
        { label: "On-chain deadline", type: "u64", display: "1060", raw: "1060" },
      ],
    };

    const validIntent = {
      trader: "GTRADER",
      market_id: "7",
      outcome: "No",
      collateral_in: "100000000",
      min_shares_out: "180000000",
      limit_price_bps: "5556",
      deadline: "1060",
    };

    expect(() => assertIntentMatches(model, validIntent)).not.toThrow();
    expect(() => assertIntentMatches(model, { ...validIntent, limit_price_bps: "5555" })).toThrow(/limit_price_bps/i);
    expect(() => assertIntentMatches(model, { ...validIntent, deadline: "1059" })).toThrow(/deadline/i);
  });

  it("maps DeadlineExpired (19) and LimitPriceExceeded (20) to distinct user-facing messages", () => {
    const expired = describeError("Error(Contract, #19)", "marketCore");
    const limit = describeError("Error(Contract, #20)", "marketCore");
    expect(expired.code).toBe("DeadlineExpired");
    expect(limit.code).toBe("LimitPriceExceeded");
    expect(expired.message).not.toBe(limit.message);
    expect(expired.message.toLowerCase()).toContain("deadline");
    expect(limit.message.toLowerCase()).toContain("limit");
  });
});
