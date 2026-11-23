import { Address, FeeBumpTransaction, scValToNative, TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";
import type { GuardianTx } from "@/lib/api/schemas";
import { CONTRACTS, NETWORK_PASSPHRASE } from "./config";

/** On-chain resolver state for the disputed market, read independently of the backend. */
export interface GuardianChainState {
  /** Ledger-time end of the dispute window (proposed_at + dispute_window), in seconds. */
  windowEndsAt: bigint;
  /** True once the resolver state is final; a cancel can no longer apply. */
  terminal: boolean;
  /** `guardian_options(market_id)` on upgraded Wasm, null on the one-argument Wasm. */
  guardianOptions: readonly string[] | null;
  /** Resolver admin read from chain. Only this account may sign guardian calls. */
  resolverAdmin: string;
}

export interface GuardianContext {
  connectedWallet: string;
  /** Argument count of the deployed resolver function, from the on-chain Wasm spec. */
  deployedArity: 1 | 2;
  ledgerNowSecs: bigint;
  maxFeeStroops?: bigint;
}

export type GuardianVerdict = { ok: true } | { ok: false; problems: string[] };

const DEFAULT_MAX_FEE = 10_000_000n;

function enumTag(native: unknown): string | null {
  if (Array.isArray(native) && typeof native[0] === "string") return native[0];
  if (typeof native === "string") return native;
  return null;
}

/**
 * Decode a backend-prepared guardian transaction locally and refuse it unless
 * it is exactly the cancel or void the guardian meant to sign.
 */
export function verifyGuardianTx(
  g: GuardianTx,
  review: { onChainMarketId: string },
  chain: GuardianChainState,
  ctx: GuardianContext,
): GuardianVerdict {
  const problems: string[] = [];
  if (g.networkPassphrase !== NETWORK_PASSPHRASE) problems.push("Transaction is for a different network.");

  let tx: Transaction;
  try {
    const parsed = TransactionBuilder.fromXDR(g.xdr, NETWORK_PASSPHRASE);
    if (parsed instanceof FeeBumpTransaction) return { ok: false, problems: [...problems, "Fee-bump envelopes are not accepted."] };
    tx = parsed;
  } catch {
    return { ok: false, problems: [...problems, "Transaction XDR could not be decoded."] };
  }

  const op = tx.operations.length === 1 ? tx.operations[0] : null;
  if (!op || op.type !== "invokeHostFunction" || op.func.switch().name !== "hostFunctionTypeInvokeContract") {
    return { ok: false, problems: [...problems, "Expected exactly one contract invocation."] };
  }
  const invocation = op.func.invokeContract();
  if (Address.fromScAddress(invocation.contractAddress()).toString() !== CONTRACTS.resolver) {
    problems.push("Transaction does not target the resolver contract.");
  }
  if (invocation.functionName().toString() !== g.kind) problems.push(`Function is not ${g.kind}.`);

  const args = invocation.args();
  if (args.length !== ctx.deployedArity) {
    problems.push(`Deployed resolver expects ${ctx.deployedArity} argument(s); transaction has ${args.length}.`);
  }
  if (args.length >= 1) {
    let marketId: string | null = null;
    try { marketId = String(scValToNative(args[0])); } catch { /* reported below */ }
    if (marketId !== review.onChainMarketId || marketId !== g.onChainMarketId) {
      problems.push("Market id does not match the dispute record.");
    }
  }
  if (ctx.deployedArity === 2 && args.length === 2) {
    let reason: string | null = null;
    try { reason = enumTag(scValToNative(args[1])); } catch { /* reported below */ }
    if (!reason || !chain.guardianOptions?.includes(reason)) problems.push("Guardian reason is not currently allowed on chain.");
    if (g.kind === "cancel_proposal" && reason !== "DisputeUpheld") problems.push("A cancel must use the DisputeUpheld reason.");
  }

  if (tx.source !== g.guardian) problems.push("Transaction source is not the guardian.");
  if (g.guardian !== ctx.connectedWallet) problems.push("Connected wallet is not the guardian named by the backend.");
  if (ctx.connectedWallet !== chain.resolverAdmin) problems.push("Connected wallet is not the resolver admin on chain.");

  for (const entry of op.auth ?? []) {
    if (entry.credentials().switch().name !== "sorobanCredentialsSourceAccount") {
      problems.push("Transaction carries authorization for another account.");
      break;
    }
  }

  if (BigInt(tx.fee) > (ctx.maxFeeStroops ?? DEFAULT_MAX_FEE)) problems.push("Fee is above the allowed ceiling.");

  if (g.kind === "cancel_proposal") {
    const maxTime = BigInt(tx.timeBounds?.maxTime ?? "0");
    if (chain.terminal) problems.push("Resolver state is final; nothing to cancel.");
    if (ctx.ledgerNowSecs >= chain.windowEndsAt) problems.push("The dispute window has closed.");
    if (maxTime === 0n || maxTime > chain.windowEndsAt) problems.push("Transaction stays valid after the dispute window closes.");
  }

  return problems.length ? { ok: false, problems } : { ok: true };
}
