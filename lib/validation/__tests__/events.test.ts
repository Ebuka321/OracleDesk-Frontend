import { describe, expect, it } from "vitest";
import { parseReasoningPublished, parseTradeExecuted } from "../events";

const validTrade = {
  eventId: "evt-1",
  onChainMarketId: "1",
  trader: "GD2NB2VUME7ECMHFHQN5M3KUZLLJF3R6Z4OFCBLE4SJNHIQHITRPQGHQ",
  direction: "YES",
  isBuy: true,
  collateralRaw: "10000000",
  sharesRaw: "9700000",
  feeRaw: "30000",
  priceYesBps: 5200,
  txHash: "ab".repeat(32),
  ledger: 100,
  marketQuestion: "Will it rain?",
  closedAt: new Date().toISOString(),
};

describe("socket payload validators", () => {
  it("accepts a valid TRADE_EXECUTED payload", () => {
    expect(parseTradeExecuted(validTrade)).toEqual(validTrade);
  });

  it("drops malformed collateralRaw instead of throwing", () => {
    expect(parseTradeExecuted({ ...validTrade, collateralRaw: "1e9" })).toBeNull();
    expect(parseTradeExecuted({ ...validTrade, collateralRaw: -1 })).toBeNull();
  });

  it("drops a transaction hash with a path", () => {
    expect(parseTradeExecuted({ ...validTrade, txHash: `${"ab".repeat(32)}/../x` })).toBeNull();
  });

  it("drops non-objects and invalid directions", () => {
    expect(parseTradeExecuted(null)).toBeNull();
    expect(parseTradeExecuted("TRADE_EXECUTED")).toBeNull();
    expect(parseTradeExecuted({ ...validTrade, direction: "MAYBE" })).toBeNull();
  });

  it("validates REASONING_PUBLISHED payloads", () => {
    const event = {
      onChainTraceId: "2",
      onChainMarketId: "1",
      traceId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
      agent: validTrade.trader,
      action: "publish",
      ledger: 101,
      txHash: "cd".repeat(32),
    };
    expect(parseReasoningPublished(event)).toEqual(event);
    expect(parseReasoningPublished({ ...event, onChainTraceId: "../1" })).toBeNull();
  });
});
