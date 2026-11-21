import { scValToNative, xdr } from "@stellar/stellar-sdk";
import { reasoningRegistry, resolver } from "./clients";
import { CONTRACTS } from "./config";
import type { RawContractEvent } from "./events";

export interface EventSpecLike {
  parseEvent(
    topics: xdr.ScVal[],
    value: xdr.ScVal,
  ): { name: string; data: Record<string, unknown> } | null;
}

export interface DecodedContractEvent {
  name: string;
  data: Record<string, unknown>;
}

/**
 * Spec-driven decoder for contract events. Rejects events from any other contract id.
 */
export function makeDecoder(
  spec: EventSpecLike,
  contractId: string,
): (raw: RawContractEvent) => DecodedContractEvent | null {
  return (raw: RawContractEvent) => {
    if (raw.contractId !== contractId) return null;
    try {
      const parsed = spec.parseEvent(raw.topics, raw.value);
      if (!parsed) return null;
      return { name: parsed.name, data: parsed.data };
    } catch {
      return null;
    }
  };
}

let cachedResolverDecoder: ((raw: RawContractEvent) => DecodedContractEvent | null) | undefined;
let cachedRegistryDecoder: ((raw: RawContractEvent) => DecodedContractEvent | null) | undefined;

export function decodeResolverEvent(raw: RawContractEvent): DecodedContractEvent | null {
  cachedResolverDecoder ??= makeDecoder(resolver().spec, CONTRACTS.resolver);
  return cachedResolverDecoder(raw);
}

export function decodeRegistryEvent(raw: RawContractEvent): DecodedContractEvent | null {
  cachedRegistryDecoder ??= makeDecoder(reasoningRegistry().spec, CONTRACTS.reasoningRegistry);
  return cachedRegistryDecoder(raw);
}

/** Decodes a CAP-46-6 SAC `transfer` event on `CONTRACTS.usdc`. */
export function decodeSacTransferEvent(
  raw: RawContractEvent,
): { from: string; to: string; amount: bigint } | null {
  if (raw.contractId !== CONTRACTS.usdc || raw.topics.length < 3) return null;
  try {
    const fn = scValToNative(raw.topics[0]);
    if (fn !== "transfer") return null;
    const from = scValToNative(raw.topics[1]);
    const to = scValToNative(raw.topics[2]);
    const amount = scValToNative(raw.value);
    if (typeof from !== "string" || typeof to !== "string" || typeof amount !== "bigint") {
      return null;
    }
    return { from, to, amount };
  } catch {
    return null;
  }
}
