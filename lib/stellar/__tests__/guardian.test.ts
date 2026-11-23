import { Account, Keypair, nativeToScVal, Operation, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import type { GuardianTx } from "@/lib/api/schemas";
import { CONTRACTS, NETWORK_PASSPHRASE } from "../config";
import { verifyGuardianTx, type GuardianChainState, type GuardianContext } from "../guardian";

const guardian = Keypair.random().publicKey();
const windowEndsAt = 1_000_000n;

function prepared(opts: { contract?: string; fn?: string; marketId?: bigint; reason?: string; source?: string; maxTime?: number } = {}): GuardianTx {
  const args = [nativeToScVal(opts.marketId ?? 7n, { type: "u64" })];
  if (opts.reason) args.push(xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(opts.reason)]));
  const tx = new TransactionBuilder(new Account(opts.source ?? guardian, "1"), { fee: "100", networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(Operation.invokeContractFunction({ contract: opts.contract ?? CONTRACTS.resolver, function: opts.fn ?? "cancel_proposal", args }))
    .setTimebounds(0, opts.maxTime ?? Number(windowEndsAt) - 60)
    .build();
  return {
    xdr: tx.toXDR(), networkPassphrase: NETWORK_PASSPHRASE, validUntil: "", guardian,
    kind: (opts.fn ?? "cancel_proposal") as GuardianTx["kind"], onChainMarketId: "7",
  };
}

const chain: GuardianChainState = { windowEndsAt, terminal: false, guardianOptions: ["DisputeUpheld"], resolverAdmin: guardian };
const ctx: GuardianContext = { connectedWallet: guardian, deployedArity: 1, ledgerNowSecs: windowEndsAt - 600n };

describe("verifyGuardianTx", () => {
  it("accepts the exact cancel the guardian meant to sign", () => {
    expect(verifyGuardianTx(prepared(), { onChainMarketId: "7" }, chain, ctx)).toEqual({ ok: true });
  });

  it.each([
    ["wrong contract", prepared({ contract: CONTRACTS.marketCore }), ctx],
    ["wrong market id", prepared({ marketId: 8n }), ctx],
    ["wrong source", prepared({ source: Keypair.random().publicKey() }), ctx],
    ["valid after window", prepared({ maxTime: Number(windowEndsAt) + 60 }), ctx],
    ["window closed", prepared(), { ...ctx, ledgerNowSecs: windowEndsAt }],
    ["arity skew", prepared(), { ...ctx, deployedArity: 2 as const }],
    ["non-admin wallet", prepared(), { ...ctx, connectedWallet: Keypair.random().publicKey() }],
  ])("refuses %s", (_label, tx, context) => {
    const verdict = verifyGuardianTx(tx, { onChainMarketId: "7" }, chain, context);
    expect(verdict.ok).toBe(false);
  });

  it("requires an allowed DisputeUpheld reason on the two-argument resolver", () => {
    const two = { ...ctx, deployedArity: 2 as const };
    expect(verifyGuardianTx(prepared({ reason: "DisputeUpheld" }), { onChainMarketId: "7" }, chain, two)).toEqual({ ok: true });
    expect(verifyGuardianTx(prepared({ reason: "SignersStalled" }), { onChainMarketId: "7" }, chain, two).ok).toBe(false);
  });
});
