import { isTraceEvent, isTradeEvent, type TraceEvent, type TradeEvent } from "@/lib/realtime/types";

/**
 * Socket payload boundary (issue #120). Handlers must drop invalid events
 * instead of trusting a cast; a malformed `BigInt()` input must never throw.
 */
export function parseTradeExecuted(raw: unknown): TradeEvent | null {
  return isTradeEvent(raw) ? raw : null;
}

export function parseReasoningPublished(raw: unknown): TraceEvent | null {
  return isTraceEvent(raw) ? raw : null;
}
