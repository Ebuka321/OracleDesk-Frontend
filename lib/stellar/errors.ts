import { Errors as MarketCoreErrors } from "./generated/market-core";
import { Errors as TreasuryErrors } from "./generated/treasury";
import { Errors as ResolverErrors } from "./generated/resolver";
import { Errors as ReasoningRegistryErrors } from "./generated/reasoning-registry";
import { StrKey } from "@stellar/stellar-sdk";
import type { rpc } from "@stellar/stellar-sdk";
import { CONTRACTS, NETWORK_LABEL } from "./config";
import type { ErrorCode, DescribedErrorKind, ContractCode } from "@/lib/errors/codes";
import { messageFor } from "@/lib/errors/messages";

export type ContractName = "marketCore" | "treasury" | "resolver" | "reasoningRegistry";
export type ErrorContract = ContractName | "usdc";

const TABLES: Record<ContractName, Record<number, { message: string }>> = {
  marketCore: MarketCoreErrors,
  treasury: TreasuryErrors,
  resolver: ResolverErrors,
  reasoningRegistry: ReasoningRegistryErrors,
};

export interface ErrorContext {
  /** Contract the call targeted; used when diagnostic events cannot attribute the error. */
  contract?: ContractName;
  simulation?: { error?: string; events?: readonly unknown[] };
  errorResult?: unknown;
}

export interface DescribedError {
  kind: DescribedErrorKind;
  errorCode?: ErrorCode;
  params?: Record<string, string | number>;
  message: string;
  action?: "enable-usdc";
  /** Contract error name, e.g. "SlippageExceeded", or tx result code when known. */
  code?: string;
  /** Contract the error was attributed to, when known. */
  contract?: ErrorContract;
}

export interface TxDescribedError extends DescribedError {
  submission?: "try-again-later" | "duplicate" | "rejected-by-network" | "failed-on-chain" | "not-found-after-timeout";
  resultCode?: string; // e.g. "txBadSeq", "txInsufficientFee", "txFailed"
}

function textOf(err: unknown): string {
  if (err == null) return "";
  if (typeof err === "string") return err;
  if (err instanceof Error) return `${err.message} ${(err as Error & { cause?: unknown }).cause ?? ""}`;
  if (typeof err === "object") {
    const o = err as Record<string, unknown>;
    // Stellar Wallets Kit errors are { code, message }; SDK Err is { error: { message } }.
    return [o.message, (o.error as { message?: string } | undefined)?.message, safeJson(err)].filter(Boolean).join(" ");
  }
  return String(err);
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return "";
  }
}

const USDC_KINDS: Record<number, "insufficient-balance" | "no-trustline"> = {
  10: "insufficient-balance",
  13: "no-trustline",
};

/** `name` of an SDK/wallet error, without relying on `instanceof` across bundles. */
function errorName(err: unknown): string {
  if (!err || typeof err !== "object") return "";
  const named = (err as { name?: unknown }).name;
  if (typeof named === "string" && named) return named;
  const ctor = (err as { constructor?: { name?: unknown } }).constructor;
  return typeof ctor?.name === "string" ? ctor.name : "";
}

function scSymbol(value: unknown): string | null {
  try {
    const val = value as { switch?: () => { name: string }; sym?: () => unknown };
    if (val.switch?.().name !== "scvSymbol") return null;
    const sym = val.sym?.();
    if (typeof sym === "string") return sym;
    if (sym && typeof sym === "object") {
      const bytes = sym as { toString?: (encoding?: string) => string };
      const decoded = bytes.toString?.("utf8");
      if (typeof decoded === "string") return decoded;
    }
  } catch {
    // not a symbol
  }
  return null;
}

export interface ContractErrorLocation {
  contractId: string;
  code: number;
}

/**
 * Reads the innermost contract error out of a diagnostic event: the last event
 * whose first topic is the `error` symbol and whose data is an `ScError` of
 * type `sceContract`. Nested calls (a SAC transfer inside market_core) emit
 * their own event, so the last one wins.
 */
export function contractErrorFromEvents(events: readonly unknown[] | undefined): ContractErrorLocation | null {
  if (!events?.length) return null;
  let found: ContractErrorLocation | null = null;
  for (const event of events) {
    const direct = event as { contractId?: unknown; code?: unknown };
    if (typeof direct?.contractId === "string" && typeof direct?.code === "number") {
      found = { contractId: direct.contractId, code: direct.code };
      continue;
    }
    try {
      const diagnostic = event as { event?: () => unknown };
      const contractEvent = (typeof diagnostic?.event === "function" ? diagnostic.event() : event) as {
        contractId?: () => unknown;
        body?: () => { v0?: () => unknown; value?: () => unknown };
      };
      if (!contractEvent?.body) continue;
      const body = contractEvent.body();
      const v0 = (body?.v0 ? body.v0() : body?.value?.()) as {
        topics?: () => unknown[];
        data?: () => unknown;
      } | undefined;
      const topics = v0?.topics?.() ?? [];
      if (!topics.some((topic) => scSymbol(topic) === "error")) continue;
      const data = v0?.data?.() as { switch?: () => { name: string }; error?: () => unknown };
      if (data?.switch?.().name !== "scvError") continue;
      const scError = data.error?.() as { switch?: () => { name: string }; contractCode?: () => number };
      if (scError?.switch?.().name !== "sceContract") continue;
      const id = contractEvent.contractId?.();
      if (!id) continue;
      const contractId = StrKey.encodeContract(id as unknown as Buffer);
      found = { contractId, code: Number(scError.contractCode?.() ?? 0) };
    } catch {
      // A malformed or non-diagnostic event must not break classification.
    }
  }
  return found;
}

/** Maps a contract id to its configured role. */
export function contractNameFor(contractId: string): ErrorContract | null {
  for (const [name, id] of Object.entries(CONTRACTS)) {
    if (id === contractId) return name as ErrorContract;
  }
  return null;
}

function resultCodeOf(errorResult: unknown): string | undefined {
  try {
    const result = (errorResult as { result?: () => { switch?: () => { name: string } } })?.result?.();
    return result?.switch?.().name;
  } catch {
    return undefined;
  }
}

function describeContractCode(name: string | undefined, code: number, contract: ErrorContract): DescribedError {
  if (contract === "usdc") {
    const kind = USDC_KINDS[code];
    if (kind === "insufficient-balance") {
      return {
        kind,
        errorCode: "kind.insufficient-balance",
        code: "USDCInsufficientBalance",
        message: messageFor("kind.insufficient-balance"),
        contract,
      };
    }
    if (kind === "no-trustline") {
      return {
        kind,
        errorCode: "kind.no-trustline",
        code: "USDCNoTrustline",
        message: messageFor("kind.no-trustline"),
        action: "enable-usdc",
        contract,
      };
    }
    return {
      kind: "contract",
      errorCode: "kind.contract",
      code: `USDCError${code}`,
      message: `The USDC token contract rejected this (error ${code}).`,
      contract,
    };
  }
  if (name) {
    const errorCode: ContractCode = `contract.${contract as ContractName}.${name}`;
    const message = messageFor(errorCode);
    return { kind: "contract", errorCode, code: name, message, contract };
  }
  return {
    kind: "contract",
    errorCode: "kind.contract",
    code: `ContractError${code}`,
    message: `The contract rejected this (error ${code}).`,
    contract,
  };
}

/** Structured SDK classes, checked by name so bundling does not matter. */
function describeSdkClass(err: unknown): DescribedError | null {
  const name = errorName(err);
  const apiCode = err && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
  if (apiCode === "BACKEND_UNREACHABLE") {
    return {
      kind: "network",
      errorCode: "kind.network",
      message: messageFor("kind.network"),
    };
  }
  if (!name) return null;
  if (/UserRejected|UserDeclined/i.test(name)) {
    return {
      kind: "rejected",
      errorCode: "kind.rejected",
      message: messageFor("kind.rejected"),
    };
  }
  if (/NoSigner/i.test(name)) {
    return {
      kind: "disconnected",
      errorCode: "kind.disconnected",
      message: messageFor("kind.disconnected"),
    };
  }
  if (/ExpiredState|RestoreFailure|RestoreError|RestorationFailure/i.test(name)) {
    return {
      kind: "archived",
      errorCode: "kind.archived",
      code: "archived-entry",
      message: messageFor("kind.archived"),
    };
  }
  if (/ExternalService/i.test(name)) {
    return {
      kind: "network",
      errorCode: "kind.network",
      message: messageFor("kind.network"),
    };
  }
  return null;
}

/** Turns anything thrown by the SDK, a binding or a wallet into a message for the user. */
export function describeError(err: unknown, ctxOrContract: ContractName | ErrorContext = "marketCore"): DescribedError {
  if (err instanceof UserFacingError) return err.described;
  const ctx: ErrorContext = typeof ctxOrContract === "string" ? { contract: ctxOrContract } : ctxOrContract;
  const contract: ContractName = ctx.contract ?? "marketCore";
  const text = [textOf(err), ctx.simulation?.error ?? ""].filter(Boolean).join(" ").trim();

  const resultCode = resultCodeOf(ctx.errorResult);
  if (resultCode === "txBadSeq") {
    return {
      kind: "stale-sequence",
      errorCode: "kind.stale-sequence",
      code: "txBadSeq",
      message: messageFor("kind.stale-sequence"),
    };
  }
  if (resultCode === "txTooLate") {
    return {
      kind: "expired",
      errorCode: "kind.expired",
      code: "tx_too_late",
      message: messageFor("kind.expired"),
    };
  }
  if (resultCode === "txInsufficientFee") {
    return {
      kind: "submission",
      errorCode: "kind.submission",
      code: "txInsufficientFee",
      message: "The network fee bid was too low. Please try again with a higher fee.",
    };
  }
  if (resultCode === "txInsufficientBalance") {
    return {
      kind: "insufficient-xlm",
      errorCode: "kind.insufficient-xlm",
      code: "txInsufficientBalance",
      message: messageFor("kind.insufficient-xlm"),
    };
  }
  if (resultCode === "txBadAuth" || resultCode === "txBadAuthExtra") {
    return {
      kind: "bad-auth",
      errorCode: "kind.bad-auth",
      code: resultCode === "txBadAuthExtra" ? "tx_bad_auth_extra" : "tx_bad_auth",
      message: resultCode === "txBadAuthExtra"
        ? "This transaction has extra signatures the network doesn't expect. Remove unknown signatures and try again."
        : messageFor("kind.bad-auth"),
    };
  }

  if (classifySequenceError(err)) {
    return {
      kind: "stale-sequence",
      errorCode: "kind.stale-sequence",
      code: "txBadSeq",
      message: messageFor("kind.stale-sequence"),
    };
  }
  // Multisig: threshold not met at submission. Check the longer `_extra`
  // variant first so it isn't swallowed by the `_auth` branch.
  if (/tx_bad_auth_extra|txBadAuthExtra/i.test(text)) {
    return {
      kind: "bad-auth",
      errorCode: "kind.bad-auth",
      code: "tx_bad_auth_extra",
      message: "This transaction has extra signatures the network doesn't expect. Remove unknown signatures and try again.",
    };
  }
  if (/tx_bad_auth|txBadAuth/i.test(text)) {
    return {
      kind: "bad-auth",
      errorCode: "kind.bad-auth",
      code: "tx_bad_auth",
      message: messageFor("kind.bad-auth"),
    };
  }
  if (/tx_too_late|txTooLate/i.test(text)) {
    return {
      kind: "expired",
      errorCode: "kind.expired",
      code: "tx_too_late",
      message: messageFor("kind.expired"),
    };
  }
  const sdk = describeSdkClass(err);
  if (sdk) return sdk;

  // Attribute contract errors by the contract id in the diagnostic events
  // before falling back to text matching (SAC codes collide with market-core's).
  const attributed = contractErrorFromEvents(ctx.simulation?.events);
  if (attributed) {
    const role: ErrorContract = contractNameFor(attributed.contractId) ?? contract;
    const name = role === "usdc" ? undefined : TABLES[role as ContractName]?.[attributed.code]?.message;
    return describeContractCode(name, attributed.code, role);
  }

  if (/archived|restore|expired.*footprint|footprint.*expired/i.test(text)) {
    return {
      kind: "archived",
      errorCode: "kind.archived",
      code: "archived-entry",
      message: messageFor("kind.archived"),
    };
  }
  if (/user (rejected|declined|denied)|rejected by (the )?user|request (was )?rejected|declined|cancell?ed by user|user closed/i.test(text)) {
    return {
      kind: "rejected",
      errorCode: "kind.rejected",
      message: messageFor("kind.rejected"),
    };
  }
  // The kit throws this after a reload when the phone's WalletConnect session has ended.
  if (/No WalletConnect session found/i.test(text)) {
    return {
      kind: "disconnected",
      errorCode: "kind.disconnected",
      message: "Your mobile wallet session ended. Connect your mobile wallet again.",
    };
  }
  // The SDK throws this when the source account has no ledger entry (never funded).
  if (/Account not found|op_no_source_account|tx_no_source_account|txNoAccount/i.test(text)) {
    return {
      kind: "account-not-found",
      errorCode: "kind.account-not-found",
      message: messageFor("kind.account-not-found"),
    };
  }
  if (/trustline entry is missing|TrustlineMissing|trustline.*(missing|not found)|op_no_trust/i.test(text)) {
    return {
      kind: "no-trustline",
      errorCode: "kind.no-trustline",
      message: messageFor("kind.no-trustline"),
      action: "enable-usdc",
    };
  }
  if (/op_low_reserve|opLowReserve/i.test(text)) {
    return {
      kind: "insufficient-xlm",
      errorCode: "kind.insufficient-xlm",
      message: "Your account needs more spendable XLM to add the USDC trustline.",
    };
  }
  if (/balance is not sufficient|resulting balance is not within the allowed range|insufficient (balance|funds)|BalanceError|op_underfunded/i.test(text)) {
    return {
      kind: "insufficient-balance",
      errorCode: "kind.insufficient-balance",
      message: messageFor("kind.insufficient-balance"),
    };
  }
  if (/txInsufficientBalance|tx_insufficient_balance/i.test(text)) {
    return {
      kind: "insufficient-xlm",
      errorCode: "kind.insufficient-xlm",
      message: messageFor("kind.insufficient-xlm"),
    };
  }
  if (err instanceof Error && err.name === "NetworkMismatchError") {
    return {
      kind: "wrong-network",
      errorCode: "kind.wrong-network",
      params: { network: NETWORK_LABEL },
      message: err.message,
    };
  }
  if (/wrong network|network mismatch/i.test(text)) {
    return {
      kind: "wrong-network",
      errorCode: "kind.wrong-network",
      params: { network: NETWORK_LABEL },
      message: messageFor("kind.wrong-network", { network: NETWORK_LABEL }),
    };
  }
  // Admin-gated contract calls (e.g. market-core's require_admin) fail auth
  // for any non-admin signer; name this distinctly from a wallet rejection.
  if (/Error\(Auth, InvalidAction\)|HostError: Error\(Auth/i.test(text)) {
    return {
      kind: "contract",
      errorCode: "kind.contract",
      code: "NotAdmin",
      message: "Only the contract admin can do this. Your wallet isn't the admin.",
    };
  }

  const code = /Error\(Contract, #(\d+)\)/.exec(text);
  if (code) {
    const name = TABLES[contract][Number(code[1])]?.message;
    return describeContractCode(name, Number(code[1]), contract);
  }

  // Bare-name matches: search caller's contract table first, then others, to avoid collisions.
  const callerNames = Object.values(TABLES[contract]).map((e) => e.message);
  const callerFound = callerNames.find((n) => new RegExp(`\\b${n}\\b`).test(text));
  if (callerFound) {
    return describeContractCode(callerFound, 0, contract);
  }
  const otherContracts = (["marketCore", "treasury", "resolver", "reasoningRegistry"] as const).filter(
    (c) => c !== contract,
  );
  for (const other of otherContracts) {
    const names = Object.values(TABLES[other]).map((e) => e.message);
    const found = names.find((n) => new RegExp(`\\b${n}\\b`).test(text));
    if (found) {
      return describeContractCode(found, 0, other);
    }
  }

  if (/\b429\b|too many requests|rate.?limit/i.test(text)) {
    return {
      kind: "network",
      errorCode: "kind.network",
      code: "rate-limited",
      message: "The Stellar network is busy right now. Try again in a moment.",
    };
  }
  if (/Failed to fetch|NetworkError|ECONNREFUSED|timed? ?out|ETIMEDOUT/i.test(text)) {
    return {
      kind: "network",
      errorCode: "kind.network",
      message: messageFor("kind.network"),
    };
  }
  return {
    kind: "unknown",
    errorCode: "kind.unknown",
    message: messageFor("kind.unknown"),
  };
}

/**
 * Maps an rpc.Api.SendTransactionResponse to a TxDescribedError.
 */
export function describeSubmission(
  response: rpc.Api.SendTransactionResponse,
  contract: ContractName = "marketCore",
): TxDescribedError {
  if (response.status === "TRY_AGAIN_LATER") {
    return {
      kind: "submission",
      errorCode: "kind.submission",
      submission: "try-again-later",
      message: "The network is busy. Please try again in a moment.",
    };
  }
  if (response.status === "DUPLICATE") {
    return {
      kind: "submission",
      errorCode: "kind.submission",
      submission: "duplicate",
      message: "This transaction is already in flight.",
    };
  }

  // ERROR case
  let resultCode: string | undefined;
  try {
    resultCode = response.errorResult?.result().switch().name;
  } catch {
    // ignore
  }

  if (resultCode === "txBadSeq") {
    return {
      kind: "stale-sequence",
      errorCode: "kind.stale-sequence",
      code: "txBadSeq",
      submission: "rejected-by-network",
      resultCode,
      message: messageFor("kind.stale-sequence"),
    };
  }
  if (resultCode === "txBadAuth") {
    return {
      kind: "bad-auth",
      errorCode: "kind.bad-auth",
      code: "tx_bad_auth",
      submission: "rejected-by-network",
      resultCode,
      message: messageFor("kind.bad-auth"),
    };
  }
  if (resultCode === "txBadAuthExtra") {
    return {
      kind: "bad-auth",
      errorCode: "kind.bad-auth",
      code: "tx_bad_auth_extra",
      submission: "rejected-by-network",
      resultCode,
      message: "This transaction has extra signatures the network doesn't expect. Remove unknown signatures and try again.",
    };
  }
  if (resultCode === "txInsufficientFee") {
    return {
      kind: "submission",
      errorCode: "kind.submission",
      submission: "rejected-by-network",
      resultCode,
      message: "The network fee bid was too low. Please try again with a higher fee.",
    };
  }
  if (resultCode === "txTooLate") {
    return {
      kind: "expired",
      errorCode: "kind.expired",
      code: "tx_too_late",
      submission: "rejected-by-network",
      resultCode,
      message: messageFor("kind.expired"),
    };
  }
  if (resultCode === "txInsufficientBalance") {
    return {
      kind: "insufficient-xlm",
      errorCode: "kind.insufficient-xlm",
      submission: "rejected-by-network",
      resultCode,
      message: messageFor("kind.insufficient-xlm"),
    };
  }

  // For txFailed on an InvokeHostFunction, fall through to describeError with the contract name
  // so Error(Contract, #N) still maps via TABLES.
  const diagText = response.diagnosticEvents
    ? response.diagnosticEvents
        .map((e) => {
          try {
            return typeof (e as unknown as { toXDR?: (f: string) => string }).toXDR === "function"
              ? (e as unknown as { toXDR: (format: string) => string }).toXDR("base64")
              : String(e);
          } catch {
            return String(e);
          }
        })
        .join(" ")
    : "";
  const fullText = `${textOf(response)} ${diagText}`;
  const described = describeError(fullText, {
    contract,
    simulation: { error: textOf(response), events: response.diagnosticEvents as unknown[] | undefined },
    errorResult: response.errorResult,
  });
  if (described.kind !== "unknown") {
    return {
      ...described,
      submission: "rejected-by-network",
      resultCode: resultCode ?? "txFailed",
    };
  }

  return {
    kind: "submission",
    errorCode: "kind.submission",
    submission: "rejected-by-network",
    resultCode: resultCode ?? "txFailed",
    message: resultCode
      ? `Transaction was rejected by the network (${resultCode}).`
      : "Transaction was rejected by the network. Please try again.",
  };
}

/** Thrown by write hooks so callers get a readable message in `error.message`. */
export class UserFacingError extends Error {
  /**
   * Short trace/request reference (issue #124) shown after the message so a
   * user can quote it and a maintainer can grep backend logs.
   */
  reference?: string;

  constructor(public readonly described: DescribedError, public readonly original?: unknown) {
    super(described.message);
    this.name = "UserFacingError";
  }

  /** Returns this error with a reference appended to the message, if not already present. */
  withReference(reference: string): this {
    if (this.reference) return this;
    this.reference = reference;
    this.message = `${this.message} Reference: ${reference}`;
    return this;
  }
}

/**
 * Structured reporting fields for an error (issue #123), extracted without
 * importing anything from lib/observability so this module stays pure.
 * ApiError is matched by its `name` rather than by instanceof to avoid a
 * dependency on the API client.
 */
export interface ReportFields {
  kind?: string;
  code?: string;
  contract?: ContractName;
  apiCode?: string;
  httpStatus?: number;
  /** Trace/request reference (issue #124) for grepping backend logs. */
  requestId?: string;
}

export function toReportFields(err: unknown): ReportFields {
  if (err instanceof UserFacingError) {
    return { kind: err.described.kind, code: err.described.code, requestId: err.reference };
  }
  if (err && typeof err === "object") {
    const candidate = err as { name?: string; code?: unknown; status?: unknown; requestId?: unknown };
    if (candidate.name === "ApiError") {
      return {
        apiCode: typeof candidate.code === "string" ? candidate.code : undefined,
        httpStatus: typeof candidate.status === "number" ? candidate.status : undefined,
        requestId: typeof candidate.requestId === "string" ? candidate.requestId : undefined,
      };
    }
  }
  return {};
}

export function classifySequenceError(error: unknown): boolean {
  if (/tx_bad_seq|txBadSeq|bad sequence/i.test(textOf(error))) return true;
  if (!error || typeof error !== "object") return false;
  const response = error as { errorResult?: { result(): { switch(): { name: string } } }; sendTransactionResponse?: unknown };
  if (response.sendTransactionResponse) return classifySequenceError(response.sendTransactionResponse);
  try { return response.errorResult?.result().switch().name === "txBadSeq"; } catch { return false; }
}
