import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { StrKey, xdr } from "@stellar/stellar-sdk";
import { CONTRACTS } from "../config";
import { describeError, type DescribedError } from "../errors";

const KINDS: DescribedError["kind"][] = [
  "stale-sequence",
  "low-reserve",
  "rejected",
  "insufficient-balance",
  "insufficient-xlm",
  "account-not-found",
  "no-trustline",
  "contract",
  "wrong-network",
  "disconnected",
  "network",
  "submission",
  "expired",
  "archived",
  "bad-auth",
  "unknown",
];

function event(contract: keyof typeof CONTRACTS, code: number): xdr.DiagnosticEvent {
  return new xdr.DiagnosticEvent({
    inSuccessfulContractCall: false,
    event: new xdr.ContractEvent({
      ext: new xdr.ExtensionPoint(0),
      contractId: StrKey.decodeContract(CONTRACTS[contract]) as unknown as xdr.Hash,
      type: xdr.ContractEventType.diagnostic(),
      body: new xdr.ContractEventBody(0, new xdr.ContractEventV0({
        topics: [xdr.ScVal.scvSymbol("error")],
        data: xdr.ScVal.scvError(xdr.ScError.sceContract(code)),
      })),
    }),
  });
}

describe("describeError fuzz", () => {
  it("is total: anything() never throws and always returns a known kind", () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        const described = describeError(value);
        expect(KINDS).toContain(described.kind);
        expect(typeof described.message).toBe("string");
        expect(described.message.length).toBeGreaterThan(0);
      }),
      { numRuns: 500 },
    );
  });

  it("is total for objects with hostile own properties", () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.anything()), (obj) => {
        expect(() => describeError(obj)).not.toThrow();
      }),
      { numRuns: 300 },
    );
  });

  it("does not change classification when ASCII noise without keywords is added", () => {
    const samples: Array<[string, DescribedError["kind"]]> = [
      ["HostError: Error(Contract, #9)", "contract"],
      ["HostError: Error(Contract, #12)", "contract"],
      ["tx_bad_seq", "stale-sequence"],
      ["tx_too_late", "expired"],
      ["op_underfunded", "insufficient-balance"],
      ["account not found", "account-not-found"],
    ];
    const noise = fc.stringMatching(/^[0-9 .:/_-]{0,40}$/);
    fc.assert(
      fc.property(fc.constantFrom(...samples), noise, noise, ([text, expected], before, after) => {
        const described = describeError(`${before} ${text} ${after}`);
        // Noise cannot add keywords, so the kind must not change.
        expect(described.kind).toBe(expected);
      }),
      { numRuns: 300 },
    );
  });

  it("never maps a SAC code through market-core's table", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 30 }), (code) => {
        const described = describeError("HostError: Error(Contract, #13)", {
          contract: "marketCore",
          simulation: { events: [event("usdc", code)] },
        });
        if (code === 10) expect(described.kind).toBe("insufficient-balance");
        else if (code === 13) expect(described.kind).toBe("no-trustline");
        else {
          expect(described.kind).toBe("contract");
          expect(described.contract).toBe("usdc");
          expect(described.code).not.toBe("InsufficientShares");
          expect(described.code).not.toBe("SlippageExceeded");
        }
      }),
      { numRuns: 50 },
    );
  });

  it("string overload equals context overload for text-only input", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const asString = describeError(text, "treasury");
        const asContext = describeError(text, { contract: "treasury" });
        expect(asContext).toEqual(asString);
      }),
      { numRuns: 300 },
    );
  });
});
