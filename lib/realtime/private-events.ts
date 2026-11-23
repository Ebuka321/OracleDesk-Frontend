/**
 * Private realtime event hint router (Issue #242).
 *
 * Security invariants:
 *  - Private events carry no user or wallet id: they are attributed strictly by
 *    the authenticated connection's captured UserScope ticket, verified at BOTH
 *    receive time and application time (`ticket.assertCurrent()`).
 *  - `PAYMENT_CONFIRMED` and `COPY_TRADE_CONFIRMED` are treated strictly as HINTS:
 *    they trigger an immediate run of `verifyPendingPayment` or the single-claim
 *    copy-trade reconciler (`reconcileOutboxEntryCrossTab`), never marking
 *    anything confirmed locally on their own and never skipping verification.
 *  - Events for unknown local ids/hashes are ignored.
 */

import { NETWORK_PASSPHRASE } from "@/lib/stellar/config";
import { checkTransaction } from "@/lib/stellar/tx-lifecycle";
import { confirmCopyTrade } from "@/lib/api/trade";
import { listPending } from "@/lib/payments/pending";
import { verifyPendingPayment, type VerifyResult } from "@/lib/payments/verify";
import {
  isTerminal,
  readOutbox,
  readOutboxFromStorage,
  reconcileOutboxEntryCrossTab,
  type ReconcileDeps,
} from "@/lib/copy-trade/outbox";
import type { UserScope } from "@/lib/query/scope";
import type { CopyTradeConfirmedEvent, PaymentConfirmedEvent, PrivateRealtimeEvent } from "./types";

export interface ScopeTicket {
  readonly signal: AbortSignal;
  assertCurrent(): void;
}

export interface PrivateHintDeps {
  scope: UserScope;
  ticket: ScopeTicket;
  networkPassphrase?: string;
  verifyPayment?: typeof verifyPendingPayment;
  reconcileCopyTrade?: (
    address: string,
    copyTradeId: string,
    deps: ReconcileDeps,
    opts?: { forceImmediate?: boolean },
  ) => Promise<{ claimed: boolean }>;
  checkTx?: ReconcileDeps["check"];
  confirmCopy?: ReconcileDeps["confirm"];
  onPassExpiring?: (event: Extract<PrivateRealtimeEvent, { type: "PASS_EXPIRING" }>) => void;
}

export type HintRouteOutcome =
  | { status: "ignored"; reason: string }
  | { status: "triggered"; kind: "payment"; result: VerifyResult }
  | { status: "triggered"; kind: "copy-trade"; claimed: boolean }
  | { status: "triggered"; kind: "pass-expiring" };

/**
 * Routes a validated private realtime event as a hint for the captured scope.
 * Never throws on stale scope; drops cleanly when `ticket.assertCurrent()` fails.
 */
export async function routePrivateRealtimeEvent(
  event: PrivateRealtimeEvent,
  deps: PrivateHintDeps,
): Promise<HintRouteOutcome> {
  const { scope, ticket } = deps;
  const wallet = scope.wallet;
  if (!wallet || !scope.sessionId) {
    return { status: "ignored", reason: "unauthenticated-scope" };
  }

  try {
    ticket.assertCurrent();
  } catch {
    return { status: "ignored", reason: "stale-scope" };
  }

  if (event.type === "PAYMENT_CONFIRMED") {
    return handlePaymentConfirmedHint(event.payload, wallet, deps);
  }

  if (event.type === "COPY_TRADE_CONFIRMED") {
    return handleCopyTradeConfirmedHint(event.payload, wallet, deps);
  }

  // PASS_EXPIRING: informational item scoped to current identity.
  try {
    ticket.assertCurrent();
  } catch {
    return { status: "ignored", reason: "stale-scope" };
  }
  deps.onPassExpiring?.(event);
  return { status: "triggered", kind: "pass-expiring" };
}

async function handlePaymentConfirmedHint(
  payload: PaymentConfirmedEvent,
  wallet: string,
  deps: PrivateHintDeps,
): Promise<HintRouteOutcome> {
  const network = deps.networkPassphrase ?? NETWORK_PASSPHRASE;
  const normalizedHash = payload.txHash.toLowerCase();
  const pending = listPending(wallet, network).find((p) => p.txHash.toLowerCase() === normalizedHash);
  if (!pending) {
    return { status: "ignored", reason: "unknown-pending-payment" };
  }
  if (pending.state === "verified" || pending.state === "failed-terminal") {
    return { status: "ignored", reason: "already-terminal" };
  }

  try {
    deps.ticket.assertCurrent();
  } catch {
    return { status: "ignored", reason: "stale-scope" };
  }

  const verify = deps.verifyPayment ?? verifyPendingPayment;
  const result = await verify(pending);
  return { status: "triggered", kind: "payment", result };
}

async function handleCopyTradeConfirmedHint(
  payload: CopyTradeConfirmedEvent,
  wallet: string,
  deps: PrivateHintDeps,
): Promise<HintRouteOutcome> {
  const entries = readOutboxFromStorage(wallet) ?? [...readOutbox(wallet)];
  const entry = entries.find((e) => e.copyTradeId === payload.copyTradeId);
  if (!entry) {
    return { status: "ignored", reason: "unknown-copy-trade" };
  }
  if (isTerminal(entry) || entry.dismissed) {
    return { status: "ignored", reason: "already-terminal" };
  }
  if (entry.txHash && entry.txHash.toLowerCase() !== payload.txHash.toLowerCase()) {
    return { status: "ignored", reason: "hash-mismatch" };
  }

  try {
    deps.ticket.assertCurrent();
  } catch {
    return { status: "ignored", reason: "stale-scope" };
  }

  const reconcile = deps.reconcileCopyTrade ?? reconcileOutboxEntryCrossTab;
  const outcome = await reconcile(
    wallet,
    entry.copyTradeId,
    {
      now: Date.now,
      sessionId: deps.scope.sessionId,
      check: deps.checkTx ?? checkTransaction,
      confirm:
        deps.confirmCopy ??
        ((id, hash) => confirmCopyTrade(id, hash, { expectScope: deps.scope, signal: deps.ticket.signal })),
      assertCurrent: () => deps.ticket.assertCurrent(),
    },
    { forceImmediate: true },
  );

  return { status: "triggered", kind: "copy-trade", claimed: outcome.claimed };
}
