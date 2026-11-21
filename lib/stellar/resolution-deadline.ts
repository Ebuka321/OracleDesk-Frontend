import { xdr, StrKey } from "@stellar/stellar-sdk";
import { marketCore, resolver, rpcServer, type Signer } from "./clients";
import { CONTRACTS } from "./config";
import { describeError } from "./errors";
import { ledgerClock } from "./ledger-clock";
import { contractDataKey } from "./ledger-keys";
import { read } from "./typed-call";
import type { HybridConfig, ResolutionState } from "./generated/resolver";

/** Contract constant `RESOLUTION_GRACE_SECS` (30 days) from `contracts/resolver/src/lib.rs`. */
export const RESOLUTION_GRACE_SECS = 30n * 86_400n;
export const DEFAULT_NEAR_WINDOW_SECS = 7n * 86_400n;
export const URGENT_NEAR_WINDOW_SECS = 86_400n;

export type ResolverStateTag = ResolutionState["tag"];

export interface DeadlineView {
  closeTime: bigint;
  resolutionDeadline: bigint;
  fallbackOpensAt: bigint | null;
  resolverState: ResolverStateTag;
  phase:
    | "open"
    | "awaiting-resolution"
    | "deadline-near"
    | "expirable"
    | "fallback-openable"
    | "terminal";
}

export type ExpiryEffect =
  | { kind: "void" }
  | { kind: "resolve"; outcome: "Yes" | "No" }
  | { kind: "fallback-opened" };

export type ExpiryPreview =
  | { ok: true; effect: ExpiryEffect; simulatedAtLedger: number; fee: bigint }
  | {
      ok: false;
      reason:
        | "DeadlineNotReached"
        | "ResolutionAvailable"
        | "AlreadyFinalized"
        | "DisputeActive"
        | "Other";
      detail: string;
    };

/** Gates UI on the deployed resolver spec declaring the liveness entrypoints. */
export function supportsExpiryAndFallback(): boolean {
  try {
    const spec = resolver().spec;
    const fns = (spec as { funcs?: () => Array<{ name?: () => string }> }).funcs?.() ?? [];
    if (fns.length === 0) return true;
    const names = new Set(fns.map((f) => (typeof f.name === "function" ? f.name() : "")));
    return (
      names.has("resolution_deadline") &&
      names.has("expire_market") &&
      names.has("open_fallback")
    );
  } catch {
    return false;
  }
}

/**
 * Pure phase computation from ledger time. Never treats a boundary as passed
 * while `uncertaintySecs` overlaps it.
 */
export function phaseAt(
  view: Omit<DeadlineView, "phase">,
  ledgerNow: bigint,
  nearWindowSecs: bigint = DEFAULT_NEAR_WINDOW_SECS,
  uncertaintySecs: bigint = 0n,
): DeadlineView["phase"] {
  if (view.resolverState === "Finalized" || view.resolverState === "Expired") {
    return "terminal";
  }
  const unc = uncertaintySecs < 0n ? 0n : uncertaintySecs;
  if (ledgerNow + unc < view.closeTime) {
    return "open";
  }
  const conservativeNow = ledgerNow - unc;
  if (conservativeNow >= view.resolutionDeadline) {
    return "expirable";
  }
  if (
    view.resolverState === "HybridPricePending" &&
    view.fallbackOpensAt !== null &&
    conservativeNow >= view.fallbackOpensAt
  ) {
    return "fallback-openable";
  }
  if (ledgerNow + unc >= view.resolutionDeadline - nearWindowSecs) {
    return "deadline-near";
  }
  return "awaiting-resolution";
}

function readHybridKeyScVal(marketId: bigint): xdr.ScVal {
  const spec = resolver().spec;
  if (typeof (spec as { nativeToScVal?: unknown }).nativeToScVal === "function") {
    return spec.nativeToScVal(
      { tag: "Hybrid", values: [marketId] },
      xdr.ScSpecTypeDef.scSpecTypeUdt(new xdr.ScSpecTypeUdt({ name: "DataKey" })),
    );
  }
  return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Hybrid"), xdr.nativeToScVal(marketId, { type: "u64" })]);
}

async function readHybridFallbackAfter(marketId: bigint): Promise<bigint | null> {
  try {
    const key = contractDataKey(CONTRACTS.resolver, readHybridKeyScVal(marketId));
    const resp = await rpcServer().getLedgerEntries(key);
    const entry = resp.entries?.[0];
    if (!entry) return null;
    const val = entry.val.contractData().val();
    const spec = resolver().spec;
    const decoded = spec.scValToNative(val) as HybridConfig | undefined;
    if (decoded && decoded.fallback_after !== undefined) {
      return BigInt(decoded.fallback_after);
    }
    return null;
  } catch {
    return null;
  }
}

export async function readDeadline(marketId: bigint): Promise<DeadlineView> {
  const [marketTx, deadlineTx, stateTx] = await Promise.all([
    marketCore().get_market({ market_id: marketId }),
    resolver().resolution_deadline({ market_id: marketId }),
    resolver().state({ market_id: marketId }),
  ]);

  const market = read(marketTx);
  const closeTime = BigInt(market.close_time);
  const resolutionDeadline = read(deadlineTx, "resolver");
  const state = read(stateTx, "resolver");
  const resolverState = state.tag;

  let fallbackOpensAt: bigint | null = null;
  if (resolverState === "HybridPricePending" || resolverState === "HybridFallbackOpen") {
    const fallbackAfter = await readHybridFallbackAfter(marketId);
    if (fallbackAfter !== null) {
      fallbackOpensAt = closeTime + fallbackAfter;
    }
  }

  const nowSec = ledgerClock.now() ?? ledgerClock.estimateNow().time;
  const ledgerNow = BigInt(Math.floor(nowSec));
  const unc = BigInt(Math.ceil(ledgerClock.uncertainty()));

  const base: Omit<DeadlineView, "phase"> = {
    closeTime,
    resolutionDeadline,
    fallbackOpensAt,
    resolverState,
  };
  return {
    ...base,
    phase: phaseAt(base, ledgerNow, DEFAULT_NEAR_WINDOW_SECS, unc),
  };
}

function outcomeFromParsed(data: Record<string, unknown>): "Yes" | "No" | null {
  const o = data.outcome as { tag?: unknown } | string | null | undefined;
  if (o === "Yes" || o === "No") return o;
  if (o && typeof o === "object" && (o.tag === "Yes" || o.tag === "No")) return o.tag;
  return null;
}

/**
 * Decodes simulation events (XDR DiagnosticEvents or pre-parsed `{ name, data }`)
 * to determine what `expire_market` or `open_fallback` will actually do.
 * Returns null if the effect cannot be proven from events.
 */
export function decodeExpirySimulationEvents(events: readonly unknown[] | undefined): ExpiryEffect | null {
  if (!events?.length) return null;

  let resolverSpec: ReturnType<typeof resolver>["spec"] | undefined;
  let mcSpec: ReturnType<typeof marketCore>["spec"] | undefined;

  for (const ev of events) {
    // Support pre-parsed test fixtures `{ name, data }`
    const direct = ev as { name?: unknown; data?: Record<string, unknown> };
    if (typeof direct?.name === "string" && direct.data && typeof direct.data === "object") {
      if (direct.name === "MarketExpired") return { kind: "void" };
      if (direct.name === "FallbackOpened") return { kind: "fallback-opened" };
      if (
        direct.name === "PriceResolution" ||
        direct.name === "PriceResolutionScaled" ||
        direct.name === "TwapResolution" ||
        direct.name === "MarketResolved"
      ) {
        const outcome = outcomeFromParsed(direct.data);
        if (outcome) return { kind: "resolve", outcome };
      }
      continue;
    }

    try {
      const diag = ev as { event?: () => xdr.ContractEvent };
      const ce = typeof diag?.event === "function" ? diag.event() : (ev as xdr.ContractEvent);
      if (!ce?.body) continue;
      const body = ce.body();
      const v0 = body.v0();
      const topics = v0.topics();
      const value = v0.data();
      const cidBuf = ce.contractId();
      const cid = cidBuf ? StrKey.encodeContract(cidBuf as unknown as Buffer) : null;

      if (cid === CONTRACTS.resolver) {
        resolverSpec ??= resolver().spec;
        const parsed = resolverSpec.parseEvent(topics, value);
        if (!parsed) continue;
        if (parsed.name === "MarketExpired") return { kind: "void" };
        if (parsed.name === "FallbackOpened") return { kind: "fallback-opened" };
        if (
          parsed.name === "PriceResolution" ||
          parsed.name === "PriceResolutionScaled" ||
          parsed.name === "TwapResolution"
        ) {
          const outcome = outcomeFromParsed(parsed.data);
          if (outcome) return { kind: "resolve", outcome };
        }
      } else if (cid === CONTRACTS.marketCore) {
        mcSpec ??= marketCore().spec;
        const parsed = mcSpec.parseEvent(topics, value);
        if (parsed?.name === "MarketResolved") {
          const outcome = outcomeFromParsed(parsed.data);
          if (outcome) return { kind: "resolve", outcome };
        }
      }
    } catch {
      // Ignore malformed/non-contract diagnostic events
    }
  }
  return null;
}

function mapRefusalReason(
  code: string | undefined,
): Extract<ExpiryPreview, { ok: false }>["reason"] {
  if (code === "DeadlineNotReached") return "DeadlineNotReached";
  if (code === "ResolutionAvailable") return "ResolutionAvailable";
  if (code === "AlreadyFinalized") return "AlreadyFinalized";
  if (code === "DisputeActive") return "DisputeActive";
  return "Other";
}

function dummySigner(source: string): Signer {
  return {
    publicKey: source,
    signTransaction: async (xdrStr) => ({ signedTxXdr: xdrStr }),
  };
}

export async function previewExpire(marketId: bigint, source: string): Promise<ExpiryPreview> {
  try {
    const tx = await resolver(dummySigner(source)).expire_market({ market_id: marketId });
    const sim = tx.simulation;
    if (!sim || ("error" in sim && sim.error)) {
      const desc = describeError(sim?.error ?? "Simulation failed", {
        contract: "resolver",
        simulation: sim as { error?: string; events?: readonly unknown[] },
      });
      return { ok: false, reason: mapRefusalReason(desc.code), detail: desc.message };
    }
    const effect = decodeExpirySimulationEvents(sim.events);
    if (!effect) {
      return {
        ok: false,
        reason: "Other",
        detail: "Could not determine expiry outcome from simulation events.",
      };
    }
    const feeStr = (sim as { minResourceFee?: string }).minResourceFee ?? "0";
    return {
      ok: true,
      effect,
      simulatedAtLedger: sim.latestLedger,
      fee: BigInt(feeStr),
    };
  } catch (err) {
    const desc = describeError(err, "resolver");
    return { ok: false, reason: mapRefusalReason(desc.code), detail: desc.message };
  }
}

export async function previewOpenFallback(marketId: bigint, source: string): Promise<ExpiryPreview> {
  try {
    const tx = await resolver(dummySigner(source)).open_fallback({ market_id: marketId });
    const sim = tx.simulation;
    if (!sim || ("error" in sim && sim.error)) {
      const desc = describeError(sim?.error ?? "Simulation failed", {
        contract: "resolver",
        simulation: sim as { error?: string; events?: readonly unknown[] },
      });
      return { ok: false, reason: mapRefusalReason(desc.code), detail: desc.message };
    }
    const effect = decodeExpirySimulationEvents(sim.events);
    if (!effect) {
      return {
        ok: false,
        reason: "Other",
        detail: "Could not determine fallback outcome from simulation events.",
      };
    }
    const feeStr = (sim as { minResourceFee?: string }).minResourceFee ?? "0";
    return {
      ok: true,
      effect,
      simulatedAtLedger: sim.latestLedger,
      fee: BigInt(feeStr),
    };
  } catch (err) {
    const desc = describeError(err, "resolver");
    return { ok: false, reason: mapRefusalReason(desc.code), detail: desc.message };
  }
}
