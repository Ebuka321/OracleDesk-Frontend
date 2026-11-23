/**
 * Adversarial multi-tab coordination tests (Issue #240).
 *
 * Exercises the REAL modules (outbox, x402 recovery/client, tx-tracker-core,
 * submit-queue, cross-tab-sync, UserScopeStore) across N simulated tabs with
 * isolated module instances, shared localStorage, shared fake-indexeddb,
 * fake Web Locks (removable per tab), controlled BroadcastChannel/storage
 * event delivery, and fake timers.
 */

import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MultiTabHarness } from "../harness";
import { UserScopeStore, ScopeChangedError } from "@/lib/query/scope";
import { TRACE_CLAIM_TTL_MS, TraceLockUnavailableError, createJournal } from "@/lib/x402/recovery";
import { unlockTrace } from "@/lib/x402/client";
import { PAYER, fakeDeps } from "@/lib/x402/__tests__/fakes";
import type { OutboxEntry } from "@/lib/copy-trade/outbox";
import type { TrackedTx } from "@/lib/stellar/tx-tracker-core";

const TEST_PASSPHRASE = "Test SDF Network ; September 2015";
const WALLET_A = "GCM7WU3RADBCIKBLGPPAEYV5WHASWMEQX6BU524QR3QFWSE7BIWCXAIF";
const WALLET_B = "GB7TAYRUZGE6TVT7NHP5SMIZRNQA6PLM423EYISAOAP3MKYIQMVYP2JO";
const HASH_1 = "a".repeat(64);
const HASH_2 = "b".repeat(64);

function makeOutboxEntry(id: string, hash: string): OutboxEntry {
  return {
    copyTradeId: id,
    traceId: `trace-${id}`,
    marketId: "m1",
    onChainMarketId: "7",
    outcome: "Yes",
    collateralInRaw: "10000000",
    state: "signed",
    txHash: hash,
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: Date.now(),
  };
}

describe("Multi-tab coordination harness & primitives", () => {
  let harness: MultiTabHarness | null = null;

  afterEach(() => {
    harness?.dispose();
    harness = null;
    vi.resetModules();
  });

  it("supports Web Locks exclusive/shared queueing, AbortSignal, and tab-crash release", async () => {
    harness = new MultiTabHarness();
    const tab1 = harness.createTab({ id: "t1" });
    const tab2 = harness.createTab({ id: "t2" });
    const events: string[] = [];

    let releaseFirst!: () => void;
    const p1 = tab1.run(() =>
      navigator.locks.request("res", { mode: "exclusive" }, async () => {
        events.push("t1-acquired");
        await new Promise<void>((r) => (releaseFirst = r));
        events.push("t1-released");
      }),
    );

    const ac = new AbortController();
    const aborted = tab2.run(() =>
      navigator.locks.request("res", { mode: "exclusive", signal: ac.signal }, async () => {
        events.push("should-not-run");
      }),
    );
    ac.abort();
    await expect(aborted).rejects.toThrow(/aborted/i);

    const p2 = tab2.run(() =>
      navigator.locks.request("res", { mode: "exclusive" }, async () => {
        events.push("t2-acquired");
      }),
    );

    await Promise.resolve();
    expect(events).toEqual(["t1-acquired"]);
    releaseFirst();
    await Promise.all([p1, p2]);
    expect(events).toEqual(["t1-acquired", "t1-released", "t2-acquired"]);
  });

  it("controls BroadcastChannel delivery (delay, reorder, drop, targeted)", async () => {
    harness = new MultiTabHarness({ autoDeliver: false });
    const tab1 = harness.createTab({ id: "t1" });
    const tab2 = harness.createTab({ id: "t2" });
    const tab3 = harness.createTab({ id: "t3" });

    const seen2: unknown[] = [];
    const seen3: unknown[] = [];

    const ch1 = tab1.runSync(() => new BroadcastChannel("demo"));
    const ch2 = tab2.runSync(() => new BroadcastChannel("demo"));
    const ch3 = tab3.runSync(() => new BroadcastChannel("demo"));
    ch2.onmessage = (e) => seen2.push(e.data);
    ch3.onmessage = (e) => seen3.push(e.data);

    ch1.postMessage({ seq: 1 });
    ch1.postMessage({ seq: 2 });
    ch1.postMessage({ seq: 3 });

    // Reorder descending, drop seq 2, deliver only to tab2
    harness.broadcast.reorder((a, b) => (b.data as { seq: number }).seq - (a.data as { seq: number }).seq);
    harness.broadcast.drop((m) => (m.data as { seq: number }).seq === 2);
    harness.broadcast.deliverOnlyTo(["t2"]);

    expect(seen2).toEqual([{ seq: 3 }, { seq: 1 }]);
    expect(seen3).toEqual([]);
  });

  it("(1) copy-trade outbox: concurrent updates to different entries before storage event do not lose updates", async () => {
    harness = new MultiTabHarness({ autoDeliver: false });
    const tabA = harness.createTab({ id: "tab-a" });
    const tabB = harness.createTab({ id: "tab-b" });

    const outboxA = await tabA.importModule(() => import("@/lib/copy-trade/outbox"));
    const outboxB = await tabB.importModule(() => import("@/lib/copy-trade/outbox"));

    const e1 = makeOutboxEntry("copy-1", HASH_1);
    const e2 = makeOutboxEntry("copy-2", HASH_2);

    // Seed both tabs' in-memory caches with [e1, e2]
    tabA.runSync(() => outboxA.writeOutbox(WALLET_A, [e1, e2]));
    tabB.runSync(() => {
      expect(outboxB.readOutbox(WALLET_A)).toHaveLength(2);
    });

    // Tab A updates copy-1; storage event is NOT delivered yet to Tab B
    tabA.runSync(() => outboxA.updateOutbox(WALLET_A, "copy-1", { state: "confirmed" }));

    // Tab B (still holding stale memory cache) updates copy-2
    tabB.runSync(() => outboxB.updateOutbox(WALLET_A, "copy-2", { state: "abandoned", lastError: "failed" }));

    // Both updates must be preserved in localStorage
    const persisted = tabA.runSync(() => outboxA.readOutboxFromStorage(WALLET_A));
    expect(persisted?.find((e) => e.copyTradeId === "copy-1")?.state).toBe("confirmed");
    expect(persisted?.find((e) => e.copyTradeId === "copy-2")?.state).toBe("abandoned");
  });

  it("(2) copy-trade reconciler: only one tab claims reconciliation (with Web Locks and with lease fallback)", async () => {
    for (const webLocks of [true, false]) {
      harness = new MultiTabHarness({ autoDeliver: false });
      const tabA = harness.createTab({ id: "tab-a", webLocks });
      const tabB = harness.createTab({ id: "tab-b", webLocks });

      const outboxA = await tabA.importModule(() => import("@/lib/copy-trade/outbox"));
      const outboxB = await tabB.importModule(() => import("@/lib/copy-trade/outbox"));

      const entry = makeOutboxEntry("copy-1", HASH_1);
      tabA.runSync(() => outboxA.writeOutbox(WALLET_A, [entry]));

      let runs = 0;
      let releaseRun!: () => void;
      const runGate = new Promise<void>((r) => (releaseRun = r));

      const pA = tabA.run(() =>
        outboxA.withCopyTradeReconcileClaim(WALLET_A, "copy-1", async () => {
          runs++;
          await runGate;
          return "A";
        }),
      );

      // Advance past settle delay when testing lease fallback
      if (!webLocks) await harness.advance(50);

      const pB = tabB.run(() =>
        outboxB.withCopyTradeReconcileClaim(WALLET_A, "copy-1", async () => {
          runs++;
          return "B";
        }),
      );

      if (!webLocks) await harness.advance(50);
      releaseRun();

      const [resA, resB] = await Promise.all([pA, pB]);
      expect(runs).toBe(1);
      expect([resA.ran, resB.ran].filter(Boolean)).toHaveLength(1);

      harness.dispose();
      harness = null;
    }
  });

  it("(3) x402: without Web Locks, two tabs never double-sign and crashed-tab claims expire safely", async () => {
    harness = new MultiTabHarness({ autoDeliver: false });
    const tabA = harness.createTab({ id: "tab-a", webLocks: false });
    const tabB = harness.createTab({ id: "tab-b", webLocks: false });

    const journalA = createJournal(harness.indexedDB);
    const journalB = createJournal(harness.indexedDB);

    const shared = fakeDeps({ journal: journalA });
    const depsB = { ...shared.deps, journal: journalB };

    let releaseSign!: () => void;
    const signGate = new Promise<void>((r) => (releaseSign = r));
    const origSign = shared.deps.sign;
    let signCalls = 0;
    const gatedSign: typeof origSign = async (pr, req) => {
      signCalls++;
      if (signCalls === 1) await signGate;
      return origSign(pr, req);
    };

    const pA = tabA.run(() =>
      unlockTrace(
        { onChainTraceId: "7", wallet: PAYER, evaluate: () => ({ allow: true }) },
        { ...shared.deps, sign: gatedSign },
      ),
    );

    // Let Tab A acquire the IndexedDB claim and enter sign()
    await Promise.resolve();
    await Promise.resolve();

    const pB = tabB.run(() =>
      unlockTrace(
        { onChainTraceId: "7", wallet: PAYER, evaluate: () => ({ allow: true }) },
        { ...depsB, sign: gatedSign },
      ),
    );

    // Release Tab A's signing; Tab B retries the IDB claim, sees the delivered journal entry, and does not sign
    releaseSign();
    await harness.advance(200);

    const [resA, resB] = await Promise.all([pA, pB]);
    expect(resA.status).toBe("unlocked");
    expect(resB.status).toBe("unlocked");
    expect(signCalls).toBe(1);

    // Crashed tab claim expiry: acquire claim manually and never release, then advance past TRACE_CLAIM_TTL_MS
    const leakedRelease = await journalA.acquireClaim!("oracledesk-x402:stellar:testnet:G:99", TRACE_CLAIM_TTL_MS);
    expect(leakedRelease).not.toBeNull();
    // While unexpired, Tab B cannot acquire
    expect(await journalB.acquireClaim!("oracledesk-x402:stellar:testnet:G:99", TRACE_CLAIM_TTL_MS)).toBeNull();
    // Advance past TTL: Tab B recovers the expired claim
    await harness.advance(TRACE_CLAIM_TTL_MS + 10);
    const recovered = await journalB.acquireClaim!("oracledesk-x402:stellar:testnet:G:99", TRACE_CLAIM_TTL_MS);
    expect(recovered).not.toBeNull();
    await recovered!();
  });

  it("(3b) x402: fails closed with TraceLockUnavailableError when neither Web Locks nor IndexedDB exists", async () => {
    harness = new MultiTabHarness();
    const tab = harness.createTab({ id: "no-locks", webLocks: false });
    const recovery = await tab.importModule(() => import("@/lib/x402/recovery"));

    await expect(
      tab.run(async () => {
        const savedIdb = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
        Object.defineProperty(globalThis, "indexedDB", { value: undefined, configurable: true, writable: true });
        try {
          return await recovery.withTraceLock(PAYER, "stellar:testnet", "7", async () => "signed");
        } finally {
          if (savedIdb) Object.defineProperty(globalThis, "indexedDB", savedIdb);
        }
      }),
    ).rejects.toBeInstanceOf(TraceLockUnavailableError);
  });

  it("(4) tx-tracker: single poller per hash with handover, and owner-scoped localStorage visibility", async () => {
    harness = new MultiTabHarness({ autoDeliver: false });
    const tab1 = harness.createTab({ id: "t1", webLocks: true });
    const tab2 = harness.createTab({ id: "t2", webLocks: true });

    const core1 = await tab1.importModule(() => import("@/lib/stellar/tx-tracker-core"));
    const core2 = await tab2.importModule(() => import("@/lib/stellar/tx-tracker-core"));

    const record: TrackedTx = {
      hash: HASH_1,
      kind: "buy",
      holder: WALLET_A,
      marketId: "1",
      amounts: { collateralIn: "100" },
      networkPassphrase: TEST_PASSPHRASE,
      submittedAt: harness.now(),
      state: "pending",
    };

    // Tab 1 persists under owner-scoped localStorage; newly opened Tab 2 sees it for WALLET_A, not WALLET_B
    tab1.runSync(() => core1.saveRecords(window.localStorage, [record], WALLET_A));
    expect(tab2.runSync(() => core2.loadRecords(window.localStorage, TEST_PASSPHRASE, harness!.now(), WALLET_A))).toHaveLength(1);
    expect(tab2.runSync(() => core2.loadRecords(window.localStorage, TEST_PASSPHRASE, harness!.now(), WALLET_B))).toHaveLength(0);

    // Single-poller claim: Tab 1 holds the poll claim; Tab 2 gets claimed: false until Tab 1 releases (hides/closes)
    let releasePoller!: () => void;
    const ac1 = new AbortController();
    const ac2 = new AbortController();
    let pollOwners: string[] = [];

    const p1 = tab1.run(() =>
      core1.withTxPollClaim(HASH_1, ac1.signal, async () => {
        pollOwners.push("t1");
        await new Promise<void>((r) => (releasePoller = r));
      }),
    );
    await Promise.resolve();

    const attempt2WhileHeld = await tab2.run(() =>
      core2.withTxPollClaim(HASH_1, ac2.signal, async () => {
        pollOwners.push("t2-should-not-run");
      }),
    );
    expect(attempt2WhileHeld.claimed).toBe(false);

    // Tab 1 yields (e.g. becomes hidden or closes); Tab 2 takes over polling
    releasePoller();
    await p1;

    const takeover = await tab2.run(() =>
      core2.withTxPollClaim(HASH_1, ac2.signal, async () => {
        pollOwners.push("t2");
      }),
    );
    expect(takeover.claimed).toBe(true);
    expect(pollOwners).toEqual(["t1", "t2"]);
  });

  it("(5) submit-queue: hardened localStorage lease fallback serializes competing tabs", async () => {
    harness = new MultiTabHarness({ autoDeliver: false });
    const tab1 = harness.createTab({ id: "t1", webLocks: false });
    const tab2 = harness.createTab({ id: "t2", webLocks: false });

    const mod1 = await tab1.importModule(() => import("@/lib/stellar/submit-queue"));
    const mod2 = await tab2.importModule(() => import("@/lib/stellar/submit-queue"));

    const q1 = new mod1.SubmitQueue();
    const q2 = new mod2.SubmitQueue();

    let active = 0;
    let maxActive = 0;

    const p1 = tab1.run(() =>
      q1.enqueue({
        id: "j1",
        address: WALLET_A,
        label: "Buy 1",
        run: async () => {
          active++;
          maxActive = Math.max(maxActive, active);
          await new Promise<void>((r) => setTimeout(r, 100));
          active--;
          return "r1";
        },
      }),
    );

    const p2 = tab2.run(() =>
      q2.enqueue({
        id: "j2",
        address: WALLET_A,
        label: "Buy 2",
        run: async () => {
          active++;
          maxActive = Math.max(maxActive, active);
          await new Promise<void>((r) => setTimeout(r, 100));
          active--;
          return "r2";
        },
      }),
    );

    // Advance fake timers through settle window, job 1, retry, settle window, job 2
    await harness.advance(1_000);
    const results = await Promise.all([p1, p2]);
    expect(results).toEqual(["r1", "r2"]);
    expect(maxActive).toBe(1);
  });

  it("(6) wallet/session sync: wallet switch in Tab A invalidates Tab B's in-flight submit scope", async () => {
    harness = new MultiTabHarness({ autoDeliver: false });
    const tabA = harness.createTab({ id: "tab-a" });
    const tabB = harness.createTab({ id: "tab-b" });

    const syncA = await tabA.importModule(() => import("@/lib/api/cross-tab-sync"));
    const syncB = await tabB.importModule(() => import("@/lib/api/cross-tab-sync"));

    const scopeB = new UserScopeStore(new QueryClient());
    scopeB.resetUserScope({ wallet: WALLET_A, sessionId: "sess-a" }, "signed-in");

    const subB = tabB.runSync(() =>
      syncB.createCrossTabSync((msg) => {
        if (msg.type === "wallet_changed") {
          scopeB.resetUserScope({ wallet: msg.address ?? null, sessionId: null }, "account-change");
        }
      }),
    );

    // Tab B captures a scope ticket before starting an async submit
    const ticket = scopeB.capture();
    expect(ticket.signal.aborted).toBe(false);

    // Tab A broadcasts wallet switch to WALLET_B
    const chA = tabA.runSync(() => syncA.createCrossTabSync(() => {}));
    chA.broadcast({ type: "wallet_changed", address: WALLET_B, timestamp: harness.now() });

    // Deliver the cross-tab broadcast
    harness.broadcast.deliverAll();

    // Tab B's in-flight ticket must now be aborted and assertCurrent() must throw ScopeChangedError
    expect(ticket.signal.aborted).toBe(true);
    expect(() => ticket.assertCurrent()).toThrow(ScopeChangedError);

    chA.unsubscribe();
    subB.unsubscribe();
  });
});
