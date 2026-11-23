import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isCopyTradeConfirmedEvent,
  isPassExpiringEvent,
  isPaymentConfirmedEvent,
  redactPayloadForLog,
} from "../types";
import { routePrivateRealtimeEvent } from "../private-events";
import { UserScopeStore } from "@/lib/query/scope";
import { MultiTabHarness } from "@/lib/testing/multi-tab";
import { savePending } from "@/lib/payments/pending";
import { NETWORK_PASSPHRASE } from "@/lib/stellar/config";
import type { OutboxEntry } from "@/lib/copy-trade/outbox";

const WALLET_A = "GCM7WU3RADBCIKBLGPPAEYV5WHASWMEQX6BU524QR3QFWSE7BIWCXAIF";
const WALLET_B = "GB7TAYRUZGE6TVT7NHP5SMIZRNQA6PLM423EYISAOAP3MKYIQMVYP2JO";
const HASH_1 = "a".repeat(64);
const HASH_2 = "b".repeat(64);

describe("private realtime type guards", () => {
  it("validates COPY_TRADE_CONFIRMED and rejects malformed shapes", () => {
    expect(
      isCopyTradeConfirmedEvent({
        copyTradeId: "copy-1",
        txHash: HASH_1,
        status: "CONFIRMED",
        amountRaw: "10000000",
        confirmedAt: "2026-10-20T10:00:00Z",
      }),
    ).toBe(true);

    expect(isCopyTradeConfirmedEvent(null)).toBe(false);
    expect(isCopyTradeConfirmedEvent({ copyTradeId: 123, txHash: HASH_1, status: "CONFIRMED" })).toBe(false);
    expect(isCopyTradeConfirmedEvent({ copyTradeId: "", txHash: HASH_1, status: "CONFIRMED" })).toBe(false);
    expect(isCopyTradeConfirmedEvent({ copyTradeId: "c1", txHash: "short", status: "CONFIRMED" })).toBe(false);
    expect(isCopyTradeConfirmedEvent({ copyTradeId: "c1", txHash: HASH_1, status: "PENDING" })).toBe(false);
    expect(isCopyTradeConfirmedEvent({ copyTradeId: "c1", txHash: HASH_1, status: "CONFIRMED", amountRaw: "-5" })).toBe(false);
    expect(isCopyTradeConfirmedEvent({ copyTradeId: "c1", txHash: HASH_1, status: "CONFIRMED", confirmedAt: "1999-01-01T00:00:00Z" })).toBe(false);
    expect(isCopyTradeConfirmedEvent({ copyTradeId: "c1", txHash: HASH_1, status: "CONFIRMED", confirmedAt: "not-a-date" })).toBe(false);
  });

  it("validates PAYMENT_CONFIRMED and rejects malformed shapes", () => {
    expect(
      isPaymentConfirmedEvent({
        txHash: HASH_1,
        paymentId: "pay-1",
        status: "CONFIRMED",
        amountRaw: "5000000",
        confirmedAt: "2026-10-20T10:00:00Z",
      }),
    ).toBe(true);

    expect(isPaymentConfirmedEvent({})).toBe(false);
    expect(isPaymentConfirmedEvent({ txHash: HASH_1, status: "UNKNOWN", amountRaw: "5000000" })).toBe(false);
    expect(isPaymentConfirmedEvent({ txHash: HASH_1, status: "CONFIRMED", amountRaw: "5.5" })).toBe(false);
    expect(isPaymentConfirmedEvent({ txHash: HASH_1, status: "CONFIRMED", amountRaw: "5000000", paymentId: 42 })).toBe(false);
    expect(isPaymentConfirmedEvent({ txHash: HASH_1, status: "CONFIRMED", amountRaw: "5000000", expiresAt: "2999-01-01T00:00:00Z" })).toBe(false);
  });

  it("validates PASS_EXPIRING and rejects out-of-range dates and bad minutes", () => {
    expect(isPassExpiringEvent({ passId: "p1", expiresAt: "2026-10-21T10:00:00Z", remainingMinutes: 30 })).toBe(true);

    expect(isPassExpiringEvent(null)).toBe(false);
    expect(isPassExpiringEvent({ expiresAt: "not-a-date" })).toBe(false);
    expect(isPassExpiringEvent({ expiresAt: "1970-01-01T00:00:00Z" })).toBe(false);
    expect(isPassExpiringEvent({ expiresAt: "2026-10-21T10:00:00Z", remainingMinutes: -1 })).toBe(false);
    expect(isPassExpiringEvent({ expiresAt: "2026-10-21T10:00:00Z", remainingMinutes: Number.NaN })).toBe(false);
  });

  it("redacts payloads for logging without exposing values", () => {
    const redacted = redactPayloadForLog({ token: "secret-jwt", copyTradeId: 123 });
    expect(redacted).toEqual({ kind: "object", keys: ["token", "copyTradeId"] });
    expect(JSON.stringify(redacted)).not.toContain("secret-jwt");
  });
});

describe("private realtime hint routing", () => {
  let harness: MultiTabHarness | null = null;

  afterEach(() => {
    harness?.dispose();
    harness = null;
    vi.resetModules();
  });

  it("routes PAYMENT_CONFIRMED as a hint to verifyPendingPayment and ignores unknown hashes", async () => {
    harness = new MultiTabHarness();
    const tab = harness.createTab({ id: "t1" });
    const store = new UserScopeStore(new QueryClient());
    store.resetUserScope({ wallet: WALLET_A, sessionId: "sess-1" }, "signed-in");
    const scope = store.getSnapshot();
    const ticket = store.capture(scope);

    tab.runSync(() => {
      savePending({
        txHash: HASH_1,
        kind: "DAILY_PASS",
        amountRaw: "5000000",
        from: WALLET_A,
        recipient: WALLET_B,
        networkPassphrase: NETWORK_PASSPHRASE,
        createdAt: Date.now(),
        attempts: 0,
        state: "submitted",
      });
    });

    const verifyPayment = vi.fn().mockResolvedValue("verified");

    // Unknown hash is ignored
    const unknownOutcome = await tab.run(() =>
      routePrivateRealtimeEvent(
        { type: "PAYMENT_CONFIRMED", payload: { txHash: HASH_2, status: "CONFIRMED", amountRaw: "5000000" }, receivedAt: Date.now() },
        { scope, ticket, verifyPayment },
      ),
    );
    expect(unknownOutcome).toEqual({ status: "ignored", reason: "unknown-pending-payment" });
    expect(verifyPayment).not.toHaveBeenCalled();

    // Matching local pending payment triggers verification (never marks confirmed directly)
    const hitOutcome = await tab.run(() =>
      routePrivateRealtimeEvent(
        { type: "PAYMENT_CONFIRMED", payload: { txHash: HASH_1, status: "CONFIRMED", amountRaw: "5000000" }, receivedAt: Date.now() },
        { scope, ticket, verifyPayment },
      ),
    );
    expect(hitOutcome).toEqual({ status: "triggered", kind: "payment", result: "verified" });
    expect(verifyPayment).toHaveBeenCalledTimes(1);
  });

  it("drops late events when UserScopeStore epoch changed before application", async () => {
    harness = new MultiTabHarness();
    const tab = harness.createTab({ id: "t1" });
    const store = new UserScopeStore(new QueryClient());
    store.resetUserScope({ wallet: WALLET_A, sessionId: "sess-1" }, "signed-in");
    const oldScope = store.getSnapshot();
    const oldTicket = store.capture(oldScope);

    // Identity changes to WALLET_B
    store.resetUserScope({ wallet: WALLET_B, sessionId: "sess-2" }, "account-change");

    const onPassExpiring = vi.fn();
    const outcome = await tab.run(() =>
      routePrivateRealtimeEvent(
        { type: "PASS_EXPIRING", payload: { expiresAt: "2026-10-21T10:00:00Z" }, receivedAt: Date.now() },
        { scope: oldScope, ticket: oldTicket, onPassExpiring },
      ),
    );
    expect(outcome).toEqual({ status: "ignored", reason: "stale-scope" });
    expect(onPassExpiring).not.toHaveBeenCalled();
  });

  it("multi-tab (#240 harness): two tabs receiving the same COPY_TRADE_CONFIRMED hint produce exactly one confirmation", async () => {
    harness = new MultiTabHarness({ autoDeliver: false });
    const tabA = harness.createTab({ id: "tab-a", webLocks: true });
    const tabB = harness.createTab({ id: "tab-b", webLocks: true });

    const outboxA = await tabA.importModule(() => import("@/lib/copy-trade/outbox"));
    const routerA = await tabA.importModule(() => import("../private-events"));
    const routerB = await tabB.importModule(() => import("../private-events"));

    const entry: OutboxEntry = {
      copyTradeId: "copy-99",
      traceId: "trace-99",
      marketId: "m1",
      onChainMarketId: "7",
      outcome: "Yes",
      collateralInRaw: "10000000",
      state: "signed",
      txHash: HASH_1,
      attempts: 0,
      nextAttemptAt: Date.now() + 60_000, // backed off; hint should trigger immediate run
      createdAt: Date.now(),
    };
    tabA.runSync(() => outboxA.writeOutbox(WALLET_A, [entry]));

    const storeA = new UserScopeStore(new QueryClient());
    storeA.resetUserScope({ wallet: WALLET_A, sessionId: "sess-1" }, "signed-in");
    const storeB = new UserScopeStore(new QueryClient());
    storeB.resetUserScope({ wallet: WALLET_A, sessionId: "sess-1" }, "signed-in");

    let releaseConfirm!: () => void;
    const confirmGate = new Promise<void>((r) => (releaseConfirm = r));
    const confirmCopy = vi.fn(async () => {
      await confirmGate;
      return {};
    });

    // Fake checkTx that returns a matching copy-buy check
    const { buyCheck } = await import("@/lib/hooks/__tests__/copy-trade-fixture");
    const checkTx = vi.fn().mockResolvedValue(buyCheck({ trader: WALLET_A }));

    const event = {
      type: "COPY_TRADE_CONFIRMED" as const,
      payload: { copyTradeId: "copy-99", txHash: HASH_1, status: "CONFIRMED" as const },
      receivedAt: Date.now(),
    };

    const pA = tabA.run(() =>
      routerA.routePrivateRealtimeEvent(event, {
        scope: storeA.getSnapshot(),
        ticket: storeA.capture(),
        checkTx,
        confirmCopy,
      }),
    );

    const pB = tabB.run(() =>
      routerB.routePrivateRealtimeEvent(event, {
        scope: storeB.getSnapshot(),
        ticket: storeB.capture(),
        checkTx,
        confirmCopy,
      }),
    );

    await Promise.resolve();
    releaseConfirm();
    const [resA, resB] = await Promise.all([pA, pB]);

    expect(confirmCopy).toHaveBeenCalledTimes(1);
    const claimedCount = [resA, resB].filter((r) => r.status === "triggered" && r.kind === "copy-trade" && r.claimed).length;
    expect(claimedCount).toBe(1);
  });
});
