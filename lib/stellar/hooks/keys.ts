import type { OutcomeTag } from "@/lib/stellar/clients";

/** Query keys all start with "stellar" so a disconnect can drop them in one go. */
export const stellarKeys = {
  marketCount: ["stellar", "marketCount"] as const,
  traceCount: ["stellar", "traceCount"] as const,
  config: ["stellar", "config"] as const,
  ledgerNow: ["stellar", "ledgerNow"] as const,
  market: (id: string) => ["stellar", "market", id] as const,
  markets: (limit = 20) => ["stellar", "markets", limit] as const,
  position: (id: string, holder: string) => ["stellar", "position", id, holder] as const,
  myPositions: (holder: string, totalMarkets: string) =>
    ["stellar", "myPositions", holder, totalMarkets] as const,
  balance: (owner: string) => ["stellar", "usdcBalance", owner] as const,
  trustline: (owner: string) => ["stellar", "usdcTrustline", owner] as const,
  account: (addr: string) => ["stellar", "account", addr] as const,
  rpcNetwork: ["stellar", "rpcNetwork"] as const,
  quoteBuy: (id: string, outcome: OutcomeTag, amount: string) => ["stellar", "quoteBuy", id, outcome, amount] as const,
  exactBuy: (id: string, outcome: OutcomeTag, target: string) => ["stellar", "exactBuy", id, outcome, target] as const,
  trace: (id: string) => ["stellar", "trace", id] as const,
};
