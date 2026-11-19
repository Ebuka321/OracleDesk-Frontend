import { describe, expect, it } from "vitest";
import { xdr, type rpc } from "@stellar/stellar-sdk";
import { classifySequenceError, describeError, describeSubmission } from "../errors";
import { NETWORK_LABEL } from "../config";

describe("describeError", () => {
  it("maps market-core contract errors by code", () => {
    const slip = describeError(new Error("HostError: Error(Contract, #12)\nEvent log: ..."));
    expect(slip).toMatchObject({
      kind: "contract",
      code: "SlippageExceeded",
      errorCode: "contract.marketCore.SlippageExceeded",
    });
    expect(slip.message).toMatch(/price moved/i);

    const closed = describeError("simulation failed: Error(Contract, #9)");
    expect(closed).toMatchObject({
      kind: "contract",
      code: "MarketClosed",
      errorCode: "contract.marketCore.MarketClosed",
    });
    expect(closed.message).toMatch(/closed/i);
  });

  it("uses the contract's own table", () => {
    const treasuryTrade = describeError("Error(Contract, #5)", "treasury");
    expect(treasuryTrade.code).toBe("TradeCapExceeded");
    expect(treasuryTrade.errorCode).toBe("contract.treasury.TradeCapExceeded");

    const marketProb = describeError("Error(Contract, #5)", "marketCore");
    expect(marketProb.code).toBe("InvalidProbability");
    expect(marketProb.errorCode).toBe("contract.marketCore.InvalidProbability");
  });

  it("resolves bare names in caller's contract first", () => {
    const treasuryPaused = describeError("Contract failed: Paused", "treasury");
    expect(treasuryPaused.errorCode).toBe("contract.treasury.Paused");
    expect(treasuryPaused.message).toBe("The treasury is paused.");

    const marketPaused = describeError("Contract failed: Paused", "marketCore");
    expect(marketPaused.errorCode).toBe("contract.marketCore.Paused");
    expect(marketPaused.message).toBe("Trading is paused right now. Try again later.");
  });

  it("wrong-network message uses NETWORK_LABEL", () => {
    const wrongNet = describeError("wrong network detected");
    expect(wrongNet.kind).toBe("wrong-network");
    expect(wrongNet.errorCode).toBe("kind.wrong-network");
    expect(wrongNet.message).toBe(`Switch your wallet to ${NETWORK_LABEL} and try again.`);
  });

  it("maps unknown code in known table to generic contract message with number", () => {
    const unknownCode = describeError("Error(Contract, #9999)", "marketCore");
    expect(unknownCode.kind).toBe("contract");
    expect(unknownCode.message).toMatch(/error 9999/);
    expect(unknownCode.code).toBeUndefined();
  });

  it("maps bare contract name through FRIENDLY", () => {
    const bare = describeError("Transaction failed: SlippageExceeded occurred in execution");
    expect(bare.kind).toBe("contract");
    expect(bare.code).toBe("SlippageExceeded");
    expect(bare.message).toMatch(/price moved/i);
  });

  it("recognises wrong network error", () => {
    const wrongNet = describeError(new Error("Wrong network selected: switch to testnet"));
    expect(wrongNet.kind).toBe("wrong-network");
    expect(wrongNet.message).toMatch(/Testnet/);
  });

  it("recognises wallet rejection", () => {
    expect(describeError({ code: -4, message: "The user rejected this request." }).kind).toBe("rejected");
    expect(describeError(new Error("User declined access")).kind).toBe("rejected");
  });

  it("rejection beats trustline and balance text (precedence in both directions)", () => {
    const rejAndTrust = describeError("User rejected request because trustline entry is missing");
    expect(rejAndTrust.kind).toBe("rejected");

    const trustAndRej = describeError("trustline entry is missing: request was rejected by user");
    expect(trustAndRej.kind).toBe("rejected");
  });

  it("recognises balance and trustline failures before contract codes", () => {
    // A SAC failure inside market_core.buy carries the token's own code.
    expect(describeError("Error(Contract, #10) ... balance is not sufficient to spend").kind).toBe("insufficient-balance");
    expect(describeError("Error(Contract, #13) ... trustline entry is missing for account").kind).toBe("no-trustline");
  });

  it("textOf reads nested error.message and cause", () => {
    const innerError = new Error("insufficient balance in account");
    const outerError = new Error("Transaction simulation failed", { cause: innerError });
    expect(describeError(outerError).kind).toBe("insufficient-balance");

    const objectWithNestedMessage = {
      error: { message: "Wrong network detected" },
    };
    expect(describeError(objectWithNestedMessage).kind).toBe("wrong-network");
  });

  it("null and undefined map to unknown", () => {
    expect(describeError(null).kind).toBe("unknown");
    expect(describeError(undefined).kind).toBe("unknown");
  });

  it("falls back to a readable message", () => {
    expect(describeError(new TypeError("Failed to fetch")).kind).toBe("network");
    expect(describeError(42).message).toMatch(/something went wrong/i);
  });
});

describe("describeSubmission", () => {
  it("maps TRY_AGAIN_LATER and DUPLICATE", () => {
    const tryAgain = describeSubmission({
      status: "TRY_AGAIN_LATER",
      hash: "1234",
      latestLedger: 10,
      latestLedgerCloseTime: 100,
    } as rpc.Api.SendTransactionResponse);
    expect(tryAgain.kind).toBe("submission");
    expect(tryAgain.submission).toBe("try-again-later");

    const dup = describeSubmission({
      status: "DUPLICATE",
      hash: "1234",
      latestLedger: 10,
      latestLedgerCloseTime: 100,
    } as rpc.Api.SendTransactionResponse);
    expect(dup.kind).toBe("submission");
    expect(dup.submission).toBe("duplicate");
  });

  it("maps multisig submission codes txBadAuth, txBadAuthExtra, txTooLate and txBadSeq", () => {
    const makeError = (resultArm: () => xdr.TransactionResultResult) =>
      ({
        status: "ERROR",
        hash: "1234",
        latestLedger: 10,
        latestLedgerCloseTime: 100,
        errorResult: new xdr.TransactionResult({
          feeCharged: xdr.Int64.fromString("100"),
          result: resultArm(),
          ext: new xdr.TransactionResultExt(0),
        }),
      }) as unknown as rpc.Api.SendTransactionResponse;

    const badAuth = describeSubmission(makeError(() => xdr.TransactionResultResult.txBadAuth()));
    expect(badAuth.resultCode).toBe("txBadAuth");
    expect(badAuth.kind).toBe("bad-auth");
    expect(badAuth.message).toMatch(/more signatures/i);

    const badExtra = describeSubmission(makeError(() => xdr.TransactionResultResult.txBadAuthExtra()));
    expect(badExtra.resultCode).toBe("txBadAuthExtra");
    expect(badExtra.kind).toBe("bad-auth");
    expect(badExtra.message).toMatch(/extra signatures/i);

    const tooLate = describeSubmission(makeError(() => xdr.TransactionResultResult.txTooLate()));
    expect(tooLate.resultCode).toBe("txTooLate");
    expect(tooLate.message).toBe("This transaction expired before it was submitted. Prepare it again with a fresh quote.");

    const badSeq = describeSubmission(makeError(() => xdr.TransactionResultResult.txBadSeq()));
    expect(badSeq.resultCode).toBe("txBadSeq");
    expect(badSeq.kind).toBe("stale-sequence");
    expect(badSeq.message).toMatch(/sequence/i);

    const lowFee = describeSubmission(makeError(() => xdr.TransactionResultResult.txInsufficientFee()));
    expect(lowFee.resultCode).toBe("txInsufficientFee");

    const noXlm = describeSubmission(makeError(() => xdr.TransactionResultResult.txInsufficientBalance()));
    expect(noXlm.kind).toBe("insufficient-xlm");
    expect(noXlm.resultCode).toBe("txInsufficientBalance");
  });

  it("maps tx_bad_auth, tx_bad_auth_extra, tx_too_late and tx_bad_seq text", () => {
    expect(describeError("tx_bad_auth")).toMatchObject({ kind: "bad-auth", code: "tx_bad_auth" });
    expect(describeError("Transaction failed: txBadAuth")).toMatchObject({ kind: "bad-auth" });
    expect(describeError("tx_bad_auth_extra")).toMatchObject({ kind: "bad-auth", code: "tx_bad_auth_extra" });
    expect(describeError("tx_too_late")).toMatchObject({
      kind: "expired",
      message: "This transaction expired before it was submitted. Prepare it again with a fresh quote.",
    });
    expect(describeError("tx_bad_seq")).toMatchObject({ kind: "stale-sequence" });
  });

  it("falls through to contract errors on txFailed", () => {
    const failedContract = {
      status: "ERROR",
      hash: "1234",
      latestLedger: 10,
      latestLedgerCloseTime: 100,
      errorResult: new xdr.TransactionResult({
        feeCharged: xdr.Int64.fromString("100"),
        result: xdr.TransactionResultResult.txFailed([]),
        ext: new xdr.TransactionResultExt(0),
      }),
      message: "HostError: Error(Contract, #12)",
    } as unknown as rpc.Api.SendTransactionResponse;

    const result = describeSubmission(failedContract, "marketCore");
    expect(result.code).toBe("SlippageExceeded");
    expect(result.resultCode).toBe("txFailed");
    expect(result.submission).toBe("rejected-by-network");
  });
});

describe("describeError rate limiting", () => {
  it("maps HTTP 429 to a busy-network message", () => {
    const d = describeError(new Error("Request failed with status code 429"));
    expect(d).toMatchObject({ kind: "network", code: "rate-limited" });
    expect(d.message).toMatch(/busy right now/i);
    expect(describeError("Too Many Requests").code).toBe("rate-limited");
  });
});
