import { describe, expect, it } from "vitest";
import { xdr } from "@stellar/stellar-sdk";
import { makeDecoder, type EventSpecLike } from "../contract-events";
import type { RawContractEvent } from "../events";
import resolverFixtures from "./fixtures/resolver-events.json";
import registryFixtures from "./fixtures/registry-events.json";

describe("contract-events makeDecoder", () => {
  const resolverSpec: EventSpecLike = {
    parseEvent(topics) {
      const idx = Number(topics[0]?.u32?.() ?? -1);
      const fix = resolverFixtures[idx];
      return fix ? { name: fix.name, data: fix.data } : null;
    },
  };

  const registrySpec: EventSpecLike = {
    parseEvent(topics) {
      const idx = Number(topics[0]?.u32?.() ?? -1);
      const fix = registryFixtures[idx];
      return fix ? { name: fix.name, data: fix.data } : null;
    },
  };

  it("rejects events from other contract ids", () => {
    const decode = makeDecoder(resolverSpec, "CRESOLVER");
    const raw: RawContractEvent = {
      id: "1",
      ledger: 100,
      ledgerClosedAt: "2026-10-18T12:00:00Z",
      txHash: "a".repeat(64),
      contractId: "COTHER",
      topics: [xdr.ScVal.scvU32(0)],
      value: xdr.ScVal.scvVoid(),
    };
    expect(decode(raw)).toBeNull();
  });

  it("decodes resolver and registry events from fixtures", () => {
    const decodeRes = makeDecoder(resolverSpec, "CRESOLVER");
    const decodeReg = makeDecoder(registrySpec, "CREGISTRY");

    const resOut = decodeRes({
      id: resolverFixtures[0]!.id,
      ledger: resolverFixtures[0]!.ledger,
      ledgerClosedAt: resolverFixtures[0]!.ledgerClosedAt,
      txHash: resolverFixtures[0]!.txHash,
      contractId: "CRESOLVER",
      topics: [xdr.ScVal.scvU32(0)],
      value: xdr.ScVal.scvVoid(),
    });
    expect(resOut).toEqual({ name: "PriceResolution", data: resolverFixtures[0]!.data });

    const regOut = decodeReg({
      id: registryFixtures[0]!.id,
      ledger: registryFixtures[0]!.ledger,
      ledgerClosedAt: registryFixtures[0]!.ledgerClosedAt,
      txHash: registryFixtures[0]!.txHash,
      contractId: "CREGISTRY",
      topics: [xdr.ScVal.scvU32(0)],
      value: xdr.ScVal.scvVoid(),
    });
    expect(regOut).toEqual({ name: "TracePublished", data: registryFixtures[0]!.data });
  });
});
