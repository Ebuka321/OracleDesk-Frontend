import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { StrKey, xdr } from "@stellar/stellar-sdk";
import { CONTRACTS } from "../config";
import {
  contractErrorFromEvents,
  contractNameFor,
  describeError,
  type ContractName,
  type DescribedError,
  type ErrorContext,
} from "../errors";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "errors");

interface ErrorFixture {
  id: string;
  source: "simulation" | "send" | "wallet" | "backend" | "sdk";
  capturedWith: { sdk: string; kit?: string; wallet?: string };
  error: { name: string; message: string; code?: string };
  context?: { contract?: ContractName };
  events?: Array<{ contract: keyof typeof CONTRACTS; code: number }>;
  errorResultCode?: string;
  expect: { kind: DescribedError["kind"]; code?: string; contract?: string };
}

function loadFixtures(): ErrorFixture[] {
  return readdirSync(DIR)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(DIR, name), "utf8")) as ErrorFixture);
}

function rehydrate(error: ErrorFixture["error"]): Error {
  const err = new Error(error.message);
  err.name = error.name;
  if (error.code) (err as Error & { code?: string }).code = error.code;
  return err;
}

/** Builds a real DiagnosticEvent, the shape RPC returns. */
function diagnosticEvent(contract: keyof typeof CONTRACTS, code: number): xdr.DiagnosticEvent {
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

function errorResult(code: string): xdr.TransactionResult {
  const arm = (xdr.TransactionResultResult as unknown as Record<string, () => xdr.TransactionResultResult>)[code];
  if (!arm) throw new Error(`unknown result code ${code}`);
  return new xdr.TransactionResult({
    feeCharged: xdr.Int64.fromString("100"),
    result: arm(),
    ext: new xdr.TransactionResultExt(0),
  });
}

function contextOf(fixture: ErrorFixture): ErrorContext {
  return {
    contract: fixture.context?.contract,
    simulation: fixture.events ? { events: fixture.events.map((e) => diagnosticEvent(e.contract, e.code)) } : undefined,
    errorResult: fixture.errorResultCode ? errorResult(fixture.errorResultCode) : undefined,
  };
}

const fixtures = loadFixtures();

describe("describeError fixtures", () => {
  it("loads a corpus covering every source", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(30);
    expect(new Set(fixtures.map((f) => f.source))).toEqual(new Set(["simulation", "send", "wallet", "backend", "sdk"]));
  });

  it.each(fixtures.map((fixture) => [fixture.id, fixture] as const))("%s", (_id, fixture) => {
    const described = describeError(rehydrate(fixture.error), contextOf(fixture));
    expect(described.kind, `kind for ${fixture.id}`).toBe(fixture.expect.kind);
    if (fixture.expect.code) expect(described.code, `code for ${fixture.id}`).toBe(fixture.expect.code);
    if (fixture.expect.contract) expect(described.contract, `contract for ${fixture.id}`).toBe(fixture.expect.contract);
  });

  it("does not contain seeds, signatures or JWTs", () => {
    const text = readdirSync(DIR)
      .filter((name) => name.endsWith(".json"))
      .map((name) => readFileSync(join(DIR, name), "utf8"))
      .join("\n");
    expect(text).not.toMatch(/\bS[A-Z2-7]{55}\b/);
    expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\./);
    expect(text).not.toMatch(/"signatures"\s*:/);
  });
});

describe("contractErrorFromEvents", () => {
  it("walks nested events and picks the innermost failure", () => {
    const events = [diagnosticEvent("marketCore", 12), diagnosticEvent("usdc", 10)];
    expect(contractErrorFromEvents(events)).toEqual({
      contractId: CONTRACTS.usdc,
      code: 10,
    });
  });

  it("ignores non-error events", () => {
    const event = new xdr.DiagnosticEvent({
      inSuccessfulContractCall: true,
      event: new xdr.ContractEvent({
        ext: new xdr.ExtensionPoint(0),
        contractId: StrKey.decodeContract(CONTRACTS.marketCore) as unknown as xdr.Hash,
        type: xdr.ContractEventType.diagnostic(),
        body: new xdr.ContractEventBody(0, new xdr.ContractEventV0({
          topics: [xdr.ScVal.scvSymbol("fn_call")],
          data: xdr.ScVal.scvVoid(),
        })),
      }),
    });
    expect(contractErrorFromEvents([event])).toBeNull();
  });

  it("maps contract ids to configured roles", () => {
    expect(contractNameFor(CONTRACTS.usdc)).toBe("usdc");
    expect(contractNameFor(CONTRACTS.marketCore)).toBe("marketCore");
    expect(contractNameFor(StrKey.encodeContract(Buffer.alloc(32, 9)))).toBeNull();
  });

  it("attributes a SAC failure even when the message names a market-core code", () => {
    // #13 in market-core is InsufficientShares; the same number in the SAC is a missing trustline.
    const described = describeError("HostError: Error(Contract, #13)", {
      contract: "marketCore",
      simulation: { events: [diagnosticEvent("usdc", 13)] },
    });
    expect(described).toMatchObject({ kind: "no-trustline", contract: "usdc" });
  });
});
