import { describe, expect, it } from "vitest";
import {
  ANALYTICS_SCHEMA_VERSION,
  describeEventSchema,
  EVENT_SPECS,
} from "../analytics-events";

/**
 * Issue #125: the event schema cannot drift silently.
 *
 * The expected object below is the published inventory (also mirrored in
 * docs/privacy.md). Adding, renaming or retyping an event fails this test —
 * and so does bumping ANALYTICS_SCHEMA_VERSION without updating this
 * literal (or vice versa), which is exactly the discipline the dashboards
 * rely on.
 */
const PUBLISHED_SCHEMA = {
  version: 1,
  events: {
    copy_trade_completed: { confirmRecorded: "boolean", outcome: "Outcome" },
    premium_payment_completed: { outcome: "Outcome", stage: '"transfer" | "unlock"' },
    premium_payment_started: {},
    quote_failed: { code: "string?", kind: "DescribedError.kind" },
    quote_requested: { amount: "AmountBucket", side: "TradeSide" },
    signin_completed: { outcome: "Outcome" },
    signin_started: {},
    trade_completed: {
      action: "TradeAction",
      code: "string?",
      durationBucket: "DurationBucket",
      outcome: "Outcome",
    },
    trade_submitted: {
      action: "TradeAction",
      amount: "AmountBucket?",
      side: "TradeSide?",
      slippageBps: "50 | 100 | 300?",
    },
    trade_wallet_prompted: { action: "TradeAction" },
    wallet_connect_failed: { kind: "DescribedError.kind" },
    wallet_connected: { fresh: "boolean", walletModule: "string" },
    wallet_modal_opened: {},
    wallet_network_checked: { status: '"match" | "mismatch" | "unknown"' },
  },
};

describe("analytics event schema (issue #125)", () => {
  it("matches the published inventory", () => {
    expect(JSON.parse(describeEventSchema())).toEqual(PUBLISHED_SCHEMA);
  });

  it("is pinned to the version in the inventory", () => {
    expect(ANALYTICS_SCHEMA_VERSION).toBe(PUBLISHED_SCHEMA.version);
  });

  it("serialises every event exactly once with sorted keys", () => {
    const parsed = JSON.parse(describeEventSchema()) as typeof PUBLISHED_SCHEMA;
    const names = Object.keys(parsed.events);
    expect(names).toEqual([...names].sort());
    expect(names).toHaveLength(Object.keys(EVENT_SPECS).length);
    expect(names).toHaveLength(14); // the issue's event list
    for (const props of Object.values(parsed.events)) {
      const keys = Object.keys(props);
      expect(keys).toEqual([...keys].sort());
    }
  });

  it("is stable across calls", () => {
    expect(describeEventSchema()).toBe(describeEventSchema());
  });

  it("never describes a property that is not a string type name", () => {
    const parsed = JSON.parse(describeEventSchema()) as typeof PUBLISHED_SCHEMA;
    for (const props of Object.values(parsed.events)) {
      for (const typeName of Object.values(props)) {
        expect(typeName).toMatch(/^[A-Za-z0-9_."| ?]+$/);
      }
    }
  });
});
