/**
 * Typed, versioned analytics event catalog (issue #125).
 *
 * `EVENT_SPECS` is the single source of truth that `AnalyticsEvents` is
 * checked against with `satisfies`: every property of every event must be
 * listed here with its type name, and nothing extra may be added. That makes
 * `lib/observability/__tests__/analytics-schema.test.ts` able to snapshot a
 * JSON description of the whole catalog — any event change fails the snapshot
 * unless `ANALYTICS_SCHEMA_VERSION` is bumped in the same commit, which is
 * also what keeps dashboards from breaking silently.
 *
 * Rules for what may appear here:
 * - no wallet addresses, transaction hashes, JWTs, market/trace ids;
 * - amounts only as `AmountBucket`, durations only as duration buckets;
 * - `code` is a contract error name from the binding tables (public, e.g.
 *   "SlippageExceeded"), never free text.
 *
 * Changing an event: edit the type + EVENT_SPECS together, bump
 * ANALYTICS_SCHEMA_VERSION, update the snapshot in analytics-schema.test.ts
 * and note it in docs/privacy.md's changelog (see CONTRIBUTING.md).
 */

import type { DescribedError } from "@/lib/stellar/errors";

/** Bump whenever an event name or any of its properties changes. */
export const ANALYTICS_SCHEMA_VERSION = 1;

/** Coarse USDC amount buckets. Never send an exact amount. */
export type AmountBucket = "<1" | "1-10" | "10-100" | "100-1k" | ">1k";

/** Coarse wall-clock buckets for a trade attempt. */
export type DurationBucket = "<5s" | "5-15s" | "15-60s" | ">60s";

/** "success", or how the attempt was classified when it failed. */
export type Outcome = "success" | DescribedError["kind"];

export type TradeAction = "buy" | "sell" | "redeem";
export type TradeSide = "Yes" | "No";

export interface AnalyticsEvents {
  wallet_modal_opened: {};
  /** `fresh: false` is a silent session restore, not a user action. */
  wallet_connected: { walletModule: string; fresh: boolean };
  wallet_connect_failed: { kind: DescribedError["kind"] };
  wallet_network_checked: { status: "match" | "mismatch" | "unknown" };
  signin_started: {};
  signin_completed: { outcome: Outcome };
  quote_requested: { side: TradeSide; amount: AmountBucket };
  quote_failed: { kind: DescribedError["kind"]; code?: string };
  trade_submitted: {
    action: TradeAction;
    side?: TradeSide;
    amount?: AmountBucket;
    slippageBps?: 50 | 100 | 300;
  };
  trade_wallet_prompted: { action: TradeAction };
  trade_completed: {
    action: TradeAction;
    outcome: Outcome;
    code?: string;
    durationBucket: DurationBucket;
  };
  premium_payment_started: {};
  premium_payment_completed: { outcome: Outcome; stage: "transfer" | "unlock" };
  /** One event per copy trade: emitted when it fails, or when the backend confirms the recording. */
  copy_trade_completed: { outcome: Outcome; confirmRecorded: boolean };
}

export type EventName = keyof AnalyticsEvents;

/**
 * Event → property → TypeScript type name. Every property of every event in
 * `AnalyticsEvents` must appear (the `satisfies` below fails otherwise), and
 * no property that does not exist may appear. The schema snapshot test
 * serialises exactly this object.
 */
export const EVENT_SPECS: Record<EventName, Record<string, string>> = {
  wallet_modal_opened: {},
  wallet_connected: { walletModule: "string", fresh: "boolean" },
  wallet_connect_failed: { kind: "DescribedError.kind" },
  wallet_network_checked: { status: '"match" | "mismatch" | "unknown"' },
  signin_started: {},
  signin_completed: { outcome: "Outcome" },
  quote_requested: { side: "TradeSide", amount: "AmountBucket" },
  quote_failed: { kind: "DescribedError.kind", code: "string?" },
  trade_submitted: {
    action: "TradeAction",
    side: "TradeSide?",
    amount: "AmountBucket?",
    slippageBps: "50 | 100 | 300?",
  },
  trade_wallet_prompted: { action: "TradeAction" },
  trade_completed: {
    action: "TradeAction",
    outcome: "Outcome",
    code: "string?",
    durationBucket: "DurationBucket",
  },
  premium_payment_started: {},
  premium_payment_completed: { outcome: "Outcome", stage: '"transfer" | "unlock"' },
  copy_trade_completed: { outcome: "Outcome", confirmRecorded: "boolean" },
} as const satisfies { [E in EventName]: Record<keyof AnalyticsEvents[E] & string, string> };

/** Canonical, order-stable JSON of the catalog (used by the schema snapshot). */
export function describeEventSchema(): string {
  const events: Record<string, Record<string, string>> = {};
  for (const name of (Object.keys(EVENT_SPECS) as EventName[]).sort()) {
    const spec = EVENT_SPECS[name];
    const props: Record<string, string> = {};
    for (const key of Object.keys(spec).sort()) props[key] = spec[key];
    events[name] = props;
  }
  return JSON.stringify({ version: ANALYTICS_SCHEMA_VERSION, events });
}
