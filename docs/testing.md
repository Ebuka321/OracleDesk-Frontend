# Testing Guide

This document describes the testing suites, property tests, mutation testing, and contract testing in OracleDesk Frontend.

## Properties (FPMM & Units)

The suite in `lib/stellar/__tests__/fpmm-properties.test.ts` states and verifies core mathematical invariants over the FPMM and units conversion space using `fast-check`.

### Invariants

- **P1: Sell Never Needs More Than Padded Shares**: For valid `planSell(r, outcome, shares, slippageBps)`, `calcSell(rSold, rOther, collateralOut, fee).sharesIn <= maxSharesIn`. Tests verify whether the tighter `sharesIn <= shares` holds and measure how often `+1n` padding is required. (Discovered off-by-two edge case in `grossForShares` documented in `docs/contract-requests.md` #5).
- **P2: Sell Proceeds Are Non-Trivial**: `collateralOut > 0n` whenever `shares` is above the dust threshold, and `collateralOut <= shares` (a share is never worth more than 1 USDC base unit).
- **P3: MinOut Is a Lower Bound**: For any `quote = calcBuy(...).sharesOut`, `minOut(quote, s) <= quote` and `minOut(quote, 0) === quote`. Under adverse price moves within tolerance `s`, post-trade shares remain `>= minOut`.
- **P4: Buy Is Monotonic**: Larger `collateralIn` never yields fewer `sharesOut`, and `sharesOut >= net`.
- **P5: Pool-Favouring Rounding**: `calcSell(collateralOut).sharesIn >= exact rational shares` (rounding never favours the trader).
- **P6: Price Bounds & Direction**: `priceYesBps ∈ [0, 10_000]` and moves in the expected direction after YES / NO buys.
- **P7: Settlement Conservation**: For any valid sequence of trades from a seed, total `settleValue` across all token holders and the pool remainder equals `sets_minted` collateral, and void payouts round down.
- **P8: Units Round Trip**: `formatUsdc(parseUsdc(x)) === canonical(x)` for every valid decimal string; `parseUsdc(formatUsdc(n)) === n` for any $n \in [0, 10^{20}]$; slippage bounds and `shareOf(a, 10_000) === a`.

### Running Properties & Reproducing Counterexamples

- Run default property suite (500 iterations, fixed seed):
  ```bash
  npm test
  ```
- Run deep property exploration locally (20,000 iterations):
  ```bash
  npm run test:props
  ```
- Override seed and runs:
  ```bash
  FC_SEED=12345 FC_RUNS=1000 vitest run lib/stellar/__tests__/fpmm-properties.test.ts
  ```

When a property fails, `fast-check` shrinks the failure and outputs a JSON summary with market state and a replay command:
```bash
stellar contract invoke --id $MARKET_CORE --network localnet -- quote_sell --market_id <id> --outcome '"Yes"' --collateral_out <collateralOut>
```

## Multi-Tab Coordination Harness (`lib/testing/multi-tab/`)

`lib/testing/multi-tab/` simulates N browser tabs in a single Vitest process to deterministically reproduce cross-tab races without real sleeping:

- **Per-tab isolation**: each `SimulatedTab` has its own `sessionStorage`, `document.visibilityState`, `window` listeners, and isolated module instances (`tab.importModule(...)` via `vi.resetModules()`).
- **Shared browser state**: all tabs share one `localStorage`, one `fake-indexeddb` `IDBFactory`, one hand-written `FakeLockManager` (Web Locks with `exclusive`/`shared` modes, FIFO queueing, `AbortSignal`, `ifAvailable`, and per-tab disable/crash), and controllable `FakeBroadcastBus` + `FakeStorageBus` (delay, reorder, drop, targeted delivery).
- **Fake clocks**: uses `vi.useFakeTimers()` so lease expiry, settle windows, and backoff are deterministic.

### Cross-Tab Coordination Rules

1. **Copy-trade outbox (`lib/copy-trade/outbox.ts`)**: every write re-reads fresh from `localStorage` (`mutateOutbox` / `updateOutbox` / `appendOutboxEntry`); the in-memory `Map` is strictly a read optimisation for `useSyncExternalStore`. Reconciliation acquires a single-tab claim (`withCopyTradeReconcileClaim`: Web Locks `ifAvailable`, or hardened `localStorage` lease fallback) and `confirmCopyTrade` uses a deterministic `Idempotency-Key`. Residual race: across separate OS browser processes without Web Locks, synchronous `localStorage` get/set is not atomic at the OS level.
2. **x402 trace lock (`lib/x402/recovery.ts`)**: `withTraceLock` uses Web Locks when available, otherwise acquires an atomic claim record in IndexedDB (`claims` store, single `readwrite` transaction, `TRACE_CLAIM_TTL_MS = 30s` crashed-tab expiry). If neither Web Locks nor IndexedDB is available, it fails closed (`TraceLockUnavailableError`) and never signs unprotected.
3. **Transaction tracker (`lib/stellar/tx-tracker.tsx` & `tx-tracker-core.ts`)**: pending records are stored in owner-scoped `localStorage` (`oracledesk_pending_txs:<holder>`) so newly opened tabs see pending transactions even after the submitting tab closes, while preventing cross-account leaks. Polling uses `withTxPollClaim` (one poller per hash; followers receive `BroadcastChannel` updates; hiding/closing the poller hands over immediately).
4. **Submit queue (`lib/stellar/submit-queue.ts`)**: prefers Web Locks (`oracledesk-submit:<address>`). The `localStorage` lease fallback uses a unique per-attempt token and a `LEASE_SETTLE_MS` (50 ms) confirm re-read. Residual race: without Web Locks, a tab frozen longer than `LEASE_SETTLE_MS` can still overlap; Web Locks is required for strict mutual exclusion.
