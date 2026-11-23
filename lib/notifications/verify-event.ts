import type { DecodedEvent } from "@/lib/stellar/events";
import type { InboxItem } from "./store";

/**
 * Socket trade events are provisional (#266): a fill reported over the
 * realtime socket is only trusted once an on-chain `Trade` event with the same
 * RPC event id and identical fields is found.
 */

export type FillVerification = "provisional" | "verified" | "unverifiable";
export type VerifyResult =
  | { id: string; status: "verified"; ledger: number; feeRaw: string }
  | { id: string; status: "mismatch" | "not-found" | "unverifiable"; reason: string };

const eventIdOf = (item: InboxItem) => item.id.replace(/^fill:/, "");

/** Compare a socket-derived fill with a decoded chain event. */
export function matchTrade(item: InboxItem, event: DecodedEvent): "match" | "mismatch" {
  if (event.kind !== "Trade" || event.meta.id !== eventIdOf(item)) return "mismatch";
  const d = item.data;
  const ok =
    event.marketId.toString() === item.marketId &&
    event.trader === item.owner &&
    (event.outcome === "Yes" ? "YES" : "NO") === d.direction &&
    (event.isBuy ? "Bought" : "Sold") === d.action &&
    event.collateral.toString() === d.collateralRaw &&
    event.shares.toString() === d.sharesRaw;
  return ok ? "match" : "mismatch";
}

export interface VerifyContext {
  events: readonly DecodedEvent[];
  window: { oldestLedger: number; latestLedger: number };
  now: number;
  firstSeen: number;
  deadlineMs?: number;
}

/** Decide the verification outcome of one provisional fill against chain events. */
export function verifyFill(item: InboxItem, ctx: VerifyContext): VerifyResult | null {
  const ledger = item.ledger ?? 0;
  if (ledger > 0 && ledger < ctx.window.oldestLedger) return { id: item.id, status: "unverifiable", reason: "older than RPC event retention" };
  const id = eventIdOf(item);
  const event = ctx.events.find((e) => e.meta.id === id);
  if (event) {
    if (matchTrade(item, event) === "mismatch") return { id: item.id, status: "mismatch", reason: "fields differ from the on-chain Trade event" };
    return { id: item.id, status: "verified", ledger: event.meta.ledger, feeRaw: event.kind === "Trade" ? event.fee.toString() : "0" };
  }
  const deadline = ctx.deadlineMs ?? 60_000;
  if (ctx.window.latestLedger >= ledger + 10 && ctx.now - ctx.firstSeen >= deadline) {
    return { id: item.id, status: "not-found", reason: "no on-chain Trade event with this id" };
  }
  return null;
}
