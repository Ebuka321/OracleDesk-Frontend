import type { AssembledTransaction } from "@stellar/stellar-sdk/contract";
import type { Client as MarketCoreClient } from "./generated/market-core";
import type { Client as TreasuryClient } from "./generated/treasury";
import type { Client as ResolverClient } from "./generated/resolver";
import type { Client as ReasoningRegistryClient } from "./generated/reasoning-registry";

export type Value<C, K extends keyof C> =
  C[K] extends (...args: never[]) => Promise<AssembledTransaction<infer T>>
    ? T extends { unwrap(): infer U }
      ? U
      : T
    : never;

export type MC = MarketCoreClient;
export type TC = TreasuryClient;
export type RC = ResolverClient;
export type RR = ReasoningRegistryClient;
