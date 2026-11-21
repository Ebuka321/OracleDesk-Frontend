import type { xdr } from "@stellar/stellar-sdk";
import type { ContractKey } from "./contract-check";
import { fnCompatible, indexSpec, type Compat } from "./capabilities";
import { Errors as MarketCoreErrors } from "./generated/market-core";
import { Errors as TreasuryErrors } from "./generated/treasury";
import { Errors as ResolverErrors } from "./generated/resolver";
import { Errors as ReasoningRegistryErrors } from "./generated/reasoning-registry";

export interface CapabilityDef {
  contract: ContractKey;
  fns: readonly string[];
  core?: boolean;
}

export const CAPABILITIES = {
  "marketCore.core": {
    contract: "marketCore",
    fns: [
      "buy",
      "sell",
      "redeem",
      "get_market",
      "get_position",
      "quote_buy",
      "quote_sell",
      "get_config",
      "market_count",
      "claim_pool_remainder",
    ],
    core: true,
  },
  "marketCore.buyV2": { contract: "marketCore", fns: ["buy_v2", "sell_v2"] },
  "marketCore.sellShares": { contract: "marketCore", fns: ["sell_shares", "quote_sell_shares"] },
  "marketCore.splitMerge": { contract: "marketCore", fns: ["split", "merge"] },
  "marketCore.breaker": { contract: "marketCore", fns: ["breaker_state", "would_trip"] },
  "registry.core": { contract: "reasoningRegistry", fns: ["get_trace", "trace_count"], core: true },
  "registry.chainedTraces": {
    contract: "reasoningRegistry",
    fns: ["publish_chained_trace", "get_trace_link", "agent_chain_head"],
  },
  "registry.flags": { contract: "reasoningRegistry", fns: ["trace_flags", "get_trace_flag"] },
  "resolver.disputes": {
    contract: "resolver",
    fns: ["dispute", "settle_dispute", "expire_dispute", "claim_dispute_bond"],
  },
  "treasury.core": {
    contract: "treasury",
    fns: ["get_config", "daily_usage", "available_capital"],
    core: true,
  },
  "treasury.vault": {
    contract: "treasury",
    fns: ["nav", "shares_of", "request_withdraw", "claim_withdraw"],
  },
} as const satisfies Record<string, CapabilityDef>;

export type Capability = keyof typeof CAPABILITIES;

function mappedErrorsFor(contract: ContractKey): Map<number, string> {
  const table =
    contract === "marketCore"
      ? MarketCoreErrors
      : contract === "treasury"
        ? TreasuryErrors
        : contract === "resolver"
          ? ResolverErrors
          : ReasoningRegistryErrors;
  const map = new Map<number, string>();
  for (const [codeStr, entry] of Object.entries(table)) {
    map.set(Number(codeStr), entry.message);
  }
  return map;
}

/**
 * Resolves all capabilities for `contractKey` by comparing `onChainEntries`
 * structurally against `bundledEntries`.
 */
export function resolveCapabilities(
  contractKey: ContractKey,
  onChainEntries: readonly xdr.ScSpecEntry[],
  bundledEntries: readonly xdr.ScSpecEntry[],
): Partial<Record<Capability, Compat>> {
  const onChainIdx = indexSpec(onChainEntries);
  const bundledIdx = indexSpec(bundledEntries);
  const mappedErrors = mappedErrorsFor(contractKey);
  const out: Partial<Record<Capability, Compat>> = {};

  for (const [cap, def] of Object.entries(CAPABILITIES) as [Capability, CapabilityDef][]) {
    if (def.contract !== contractKey) continue;

    let result: Compat = { ok: true };
    for (const fnName of def.fns) {
      const requiredFn = bundledIdx.fns.get(fnName);
      if (!requiredFn) {
        result = { ok: false, reason: "not in bundled bindings" };
        break;
      }
      const compat = fnCompatible(requiredFn, onChainIdx, bundledIdx, mappedErrors);
      if (!compat.ok) {
        result = compat;
        break;
      }
    }
    out[cap] = result;
  }

  return out;
}

/** Picks `buy_v2` when `marketCore.buyV2` is available, otherwise legacy `buy`. */
export function pickBuyEntrypoint(caps: { has(c: Capability): boolean }): "buy_v2" | "buy" {
  return caps.has("marketCore.buyV2") ? "buy_v2" : "buy";
}
