import { describe, expect, it } from "vitest";
import { Contract, StrKey, xdr, type rpc } from "@stellar/stellar-sdk";
import { CONTRACTS } from "../config";
import { decodeEvent, decodeMarketCoreEvent, decodeTrade, eventTopicFilter } from "../events";
import rawFixtures from "./fixtures/market-core-events.json";

interface RawFixture {
  name: string; ledger: number; index: number; ledgerClosedAt: string; txHash: string;
  topics: string[]; value: string; trader: string;
}
const fixtures = rawFixtures as RawFixture[];

// Expected decoder output per fixture, written from what each recorded call did.
const expected: Record<string, { name: string; kind: string }> = {
  "market-created": { name: "MarketCreated", kind: "MarketCreated" },
  "trade-buy": { name: "Trade", kind: "Trade" },
  "market-resolved-yes": { name: "MarketResolved", kind: "MarketResolved" },
  "market-resolved-void": { name: "MarketResolved", kind: "MarketResolved" },
  redeemed: { name: "Redeemed", kind: "Redeemed" },
};

function response(fixture: RawFixture, overrides: Partial<rpc.Api.EventResponse> = {}): rpc.Api.EventResponse {
  return {
    id: `${String(fixture.ledger).padStart(19, "0")}-${String(fixture.index).padStart(10, "0")}`,
    type: "contract", ledger: fixture.ledger, ledgerClosedAt: fixture.ledgerClosedAt,
    contractId: new Contract(CONTRACTS.marketCore), transactionIndex: 1, operationIndex: 0,
    inSuccessfulContractCall: true, txHash: fixture.txHash,
    topic: fixture.topics.map(topic => xdr.ScVal.fromXDR(topic, "base64")),
    value: xdr.ScVal.fromXDR(fixture.value, "base64"),
    ...overrides,
  };
}

const otherContract = new Contract(StrKey.encodeContract(Buffer.alloc(32, 9)));

describe("event decoder conformance", () => {
  it("has an expectation for every recorded fixture", () => {
    expect(fixtures.map(f => f.name).sort()).toEqual(Object.keys(expected).sort());
  });

  for (const fixture of fixtures) {
    describe(fixture.name, () => {
      const want = expected[fixture.name];

      it("matches the spec's topic prefix for its event name", () => {
        expect(eventTopicFilter(want.name)[0]).toBe(fixture.topics[0]);
      });

      it("decodes through every decoder consistently", () => {
        expect(decodeEvent(response(fixture))?.name).toBe(want.name);
        expect(decodeMarketCoreEvent(response(fixture))?.kind).toBe(want.kind);
        const trade = decodeTrade(response(fixture));
        expect(trade === null).toBe(want.kind !== "Trade");
      });

      it("rejects the same event from a failed call or a non-contract event", () => {
        expect(decodeMarketCoreEvent(response(fixture, { inSuccessfulContractCall: false }))).toBeNull();
        expect(decodeMarketCoreEvent(response(fixture, { type: "system" }))).toBeNull();
        expect(decodeTrade(response(fixture, { inSuccessfulContractCall: false }))).toBeNull();
      });

      it("rejects the same event from another contract", () => {
        expect(otherContract.contractId()).not.toBe(CONTRACTS.marketCore);
        expect(decodeMarketCoreEvent(response(fixture, { contractId: otherContract }))).toBeNull();
      });
    });
  }

  it("returns null when the payload is malformed", () => {
    expect(decodeMarketCoreEvent(response(fixtures[0], { value: xdr.ScVal.scvMap([]) }))).toBeNull();
  });
});
