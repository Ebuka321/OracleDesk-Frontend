import {
  Address,
  scValToNative,
  Transaction,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { CONTRACTS, NETWORK_PASSPHRASE, isAdminAddress } from "./config";
import { isExpiredByWallClock } from "./multisig";
import { contractDisplay } from "./tx-decode";

export type TreasuryOpKind =
  | "treasury.set_paused"
  | "treasury.withdraw"
  | "treasury.deposit"
  | "treasury.collect_market_fees"
  | "market_core.set_paused";

export interface TreasurySetPausedIntent {
  kind: "treasury.set_paused";
  paused: boolean;
  adminAddress: string;
}

export interface TreasuryWithdrawIntent {
  kind: "treasury.withdraw";
  recipient: string;
  amountRaw: bigint;
  adminAddress: string;
}

export interface TreasuryDepositIntent {
  kind: "treasury.deposit";
  from: string;
  amountRaw: bigint;
}

export interface TreasuryCollectFeesIntent {
  kind: "treasury.collect_market_fees";
  marketIds: bigint[];
  adminAddress: string;
}

export interface MarketCoreSetPausedIntent {
  kind: "market_core.set_paused";
  paused: boolean;
  adminAddress: string;
}

export type TreasuryOperationIntent =
  | TreasurySetPausedIntent
  | TreasuryWithdrawIntent
  | TreasuryDepositIntent
  | TreasuryCollectFeesIntent
  | MarketCoreSetPausedIntent;

export interface DecodedTreasuryOp {
  kind: TreasuryOpKind;
  contractId: string;
  contractName: string;
  functionName: string;
  sourceAccount: string;
  fee: string;
  feeStroops: bigint;
  validFrom: number | null;
  validUntil: number | null;
  hash: string;
  decodedArgs: Record<string, unknown>;
  authCount: number;
}

export interface VerificationResult {
  valid: boolean;
  reason?: string;
  decoded?: DecodedTreasuryOp;
}

/** Maximum acceptable fee for a treasury admin transaction (1 XLM = 10,000,000 stroops). */
export const MAX_SANE_FEE_STROOPS = 10_000_000n;

/**
 * Expected contract address for each treasury operation kind from app configuration.
 * Never taken from backend responses.
 */
export function expectedContractForKind(kind: TreasuryOpKind): string {
  switch (kind) {
    case "treasury.set_paused":
    case "treasury.withdraw":
    case "treasury.deposit":
    case "treasury.collect_market_fees":
      return CONTRACTS.treasury;
    case "market_core.set_paused":
      return CONTRACTS.marketCore;
  }
}

/**
 * Expected function name for each operation kind.
 */
export function expectedFunctionForKind(kind: TreasuryOpKind): string {
  switch (kind) {
    case "treasury.set_paused":
    case "market_core.set_paused":
      return "set_paused";
    case "treasury.withdraw":
      return "withdraw";
    case "treasury.deposit":
      return "deposit";
    case "treasury.collect_market_fees":
      return "collect_market_fees";
  }
}

/**
 * Decodes and thoroughly verifies a backend-prepared transaction XDR before signing.
 *
 * Checks:
 * 1. Network passphrase matches app configuration.
 * 2. Computed transaction hash matches expected backend hash.
 * 3. Exactly one operation, and it is invokeHostFunction.
 * 4. Target contract matches the configured contract ID from app config.
 * 5. Function name matches operation kind.
 * 6. Decoded arguments match operator input.
 * 7. Source account matches expected admin address (or from address for deposit).
 * 8. Time bounds are present and unexpired.
 * 9. Fee is within safe bounds.
 * 10. Soroban auth entries contain no extra sub-invocations.
 */
export function verifyTreasuryOperation(
  xdrString: string,
  intent: TreasuryOperationIntent,
  expectedHash: string,
  networkPassphrase = NETWORK_PASSPHRASE
): VerificationResult {
  let tx: Transaction;
  try {
    const parsed = TransactionBuilder.fromXDR(xdrString, networkPassphrase);
    if (!("operations" in parsed)) {
      return { valid: false, reason: "Fee-bump transactions are not supported for treasury operations." };
    }
    tx = parsed as Transaction;
  } catch (err) {
    return { valid: false, reason: `Failed to parse XDR: ${err instanceof Error ? err.message : String(err)}` };
  }

  // 1. Network passphrase check
  if (tx.networkPassphrase !== networkPassphrase) {
    return {
      valid: false,
      reason: `Network passphrase mismatch: transaction has ${tx.networkPassphrase}, expected ${networkPassphrase}`,
    };
  }

  // 2. Transaction hash check
  const localHash = tx.hash().toString("hex").toLowerCase();
  if (localHash !== expectedHash.toLowerCase()) {
    return {
      valid: false,
      reason: `Transaction hash mismatch: local hash ${localHash} differs from backend ${expectedHash}`,
    };
  }

  // 3. Exactly one operation, and it is invokeHostFunction
  if (tx.operations.length !== 1) {
    return {
      valid: false,
      reason: `Expected exactly 1 operation, found ${tx.operations.length}`,
    };
  }
  const op = tx.operations[0];
  if (op.type !== "invokeHostFunction") {
    return {
      valid: false,
      reason: `Expected invokeHostFunction operation, found ${op.type}`,
    };
  }

  // Contract invocation check
  const hostFunc = (op as unknown as { func: xdr.HostFunction }).func;
  if (!hostFunc || hostFunc.switch().name !== "hostFunctionTypeInvokeContract") {
    return {
      valid: false,
      reason: "Host function is not a contract invocation.",
    };
  }
  const invocation = hostFunc.invokeContract();
  const targetContractId = Address.fromScAddress(invocation.contractAddress()).toString();
  const functionName = invocation.functionName().toString("utf8");
  const args = invocation.args();

  // 4. Target contract matches app config
  const expectedContract = expectedContractForKind(intent.kind);
  if (targetContractId !== expectedContract) {
    return {
      valid: false,
      reason: `Target contract ${targetContractId} does not match expected contract ${expectedContract} for ${intent.kind}`,
    };
  }

  // 5. Function name matches
  const expectedFn = expectedFunctionForKind(intent.kind);
  if (functionName !== expectedFn) {
    return {
      valid: false,
      reason: `Function name "${functionName}" does not match expected "${expectedFn}" for ${intent.kind}`,
    };
  }

  // 6. Decode and compare arguments
  const decodedArgs: Record<string, unknown> = {};
  switch (intent.kind) {
    case "treasury.set_paused":
    case "market_core.set_paused": {
      if (args.length !== 1) return { valid: false, reason: `Expected 1 argument, found ${args.length}` };
      const pausedVal = args[0].switch().name === "scvBool" ? args[0].b() : Boolean(scValToNative(args[0]));
      decodedArgs.paused = pausedVal;
      if (pausedVal !== intent.paused) {
        return {
          valid: false,
          reason: `Argument 'paused' (${pausedVal}) does not match requested action (${intent.paused})`,
        };
      }
      break;
    }
    case "treasury.withdraw": {
      if (args.length !== 2) return { valid: false, reason: `Expected 2 arguments, found ${args.length}` };
      const recipient = Address.fromScVal(args[0]).toString();
      const amount = BigInt(scValToNative(args[1]));
      decodedArgs.recipient = recipient;
      decodedArgs.amount = amount;
      if (recipient !== intent.recipient) {
        return {
          valid: false,
          reason: `Argument 'recipient' (${recipient}) does not match requested destination (${intent.recipient})`,
        };
      }
      if (amount !== intent.amountRaw) {
        return {
          valid: false,
          reason: `Argument 'amount' (${amount}) does not match requested amount (${intent.amountRaw})`,
        };
      }
      break;
    }
    case "treasury.deposit": {
      if (args.length !== 2) return { valid: false, reason: `Expected 2 arguments, found ${args.length}` };
      const from = Address.fromScVal(args[0]).toString();
      const amount = BigInt(scValToNative(args[1]));
      decodedArgs.from = from;
      decodedArgs.amount = amount;
      if (from !== intent.from) {
        return {
          valid: false,
          reason: `Argument 'from' (${from}) does not match depositor address (${intent.from})`,
        };
      }
      if (amount !== intent.amountRaw) {
        return {
          valid: false,
          reason: `Argument 'amount' (${amount}) does not match requested amount (${intent.amountRaw})`,
        };
      }
      break;
    }
    case "treasury.collect_market_fees": {
      if (args.length !== 1) return { valid: false, reason: `Expected 1 argument, found ${args.length}` };
      const rawNative = scValToNative(args[0]);
      const marketIds = Array.isArray(rawNative) ? rawNative.map((id) => BigInt(id)) : [];
      decodedArgs.marketIds = marketIds;
      if (marketIds.length !== intent.marketIds.length) {
        return {
          valid: false,
          reason: `Market IDs count (${marketIds.length}) does not match requested (${intent.marketIds.length})`,
        };
      }
      for (let i = 0; i < marketIds.length; i++) {
        if (marketIds[i] !== intent.marketIds[i]) {
          return {
            valid: false,
            reason: `Market ID mismatch at index ${i}: decoded #${marketIds[i]}, expected #${intent.marketIds[i]}`,
          };
        }
      }
      break;
    }
  }

  // 7. Source account check
  if (intent.kind === "treasury.deposit") {
    if (tx.source !== intent.from) {
      return {
        valid: false,
        reason: `Transaction source account (${tx.source}) must match depositor address (${intent.from})`,
      };
    }
  } else {
    if (tx.source !== intent.adminAddress) {
      return {
        valid: false,
        reason: `Transaction source account (${tx.source}) does not match admin address (${intent.adminAddress})`,
      };
    }
    if (!isAdminAddress(tx.source)) {
      return {
        valid: false,
        reason: `Transaction source account (${tx.source}) is not an authorized admin address`,
      };
    }
  }

  // 8. Time bounds check
  const bounds = tx.timeBounds;
  if (!bounds || !bounds.maxTime || Number(bounds.maxTime) <= 0) {
    return {
      valid: false,
      reason: "Time bounds are required and missing from transaction",
    };
  }
  const maxTimeSeconds = Number(bounds.maxTime);
  if (isExpiredByWallClock(maxTimeSeconds)) {
    return {
      valid: false,
      reason: `Transaction time bounds expired at ${new Date(maxTimeSeconds * 1000).toISOString()}`,
    };
  }

  // 9. Fee bound check
  const feeStroops = BigInt(tx.fee);
  if (feeStroops > MAX_SANE_FEE_STROOPS) {
    return {
      valid: false,
      reason: `Fee of ${feeStroops} stroops exceeds maximum sane threshold of ${MAX_SANE_FEE_STROOPS} stroops`,
    };
  }

  // 10. Soroban authorization entries check
  const authEntries = (op as unknown as { auth?: xdr.SorobanAuthorizationEntry[] }).auth ?? [];
  for (const entry of authEntries) {
    const rootInv = entry.rootInvocation();
    if (rootInv.subInvocations().length > 0) {
      return {
        valid: false,
        reason: "Soroban authorization entry contains unauthorized extra sub-invocations",
      };
    }
  }

  const decoded: DecodedTreasuryOp = {
    kind: intent.kind,
    contractId: targetContractId,
    contractName: contractDisplay(targetContractId),
    functionName,
    sourceAccount: tx.source,
    fee: tx.fee,
    feeStroops,
    validFrom: bounds.minTime ? Number(bounds.minTime) : null,
    validUntil: maxTimeSeconds,
    hash: localHash,
    decodedArgs,
    authCount: authEntries.length,
  };

  return { valid: true, decoded };
}

/**
 * Verifies that the signed transaction returned from the wallet has the EXACT SAME body
 * and hash as the prepared transaction before it is uploaded to the backend.
 */
export function verifySignedEnvelopeMatches(
  originalXdr: string,
  signedXdr: string,
  networkPassphrase = NETWORK_PASSPHRASE
): { valid: boolean; reason?: string } {
  try {
    const orig = TransactionBuilder.fromXDR(originalXdr, networkPassphrase) as Transaction;
    const signed = TransactionBuilder.fromXDR(signedXdr, networkPassphrase) as Transaction;

    const origHash = orig.hash().toString("hex").toLowerCase();
    const signedHash = signed.hash().toString("hex").toLowerCase();

    if (origHash !== signedHash) {
      return {
        valid: false,
        reason: `Wallet returned a modified transaction: signed hash ${signedHash} does not match prepared hash ${origHash}`,
      };
    }

    if (signed.signatures.length <= orig.signatures.length) {
      return {
        valid: false,
        reason: "Wallet returned no new signatures on the transaction envelope.",
      };
    }

    return { valid: true };
  } catch (err) {
    return {
      valid: false,
      reason: `Failed to verify signed transaction: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
