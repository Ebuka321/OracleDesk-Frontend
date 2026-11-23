"use client";

import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useWalletAddress } from "@/lib/contexts/WalletContext";
import { NETWORK_PASSPHRASE } from "./config";
import { rpcServer } from "./clients";
import {
  TX_POLL_INTERVAL_MS,
  evaluateTxStatus,
  loadRecords,
  mergeRecords,
  saveRecords,
  storageKeyForHolder,
  tradeInvalidationKeys,
  isValidRecord,
  withTxPollClaim,
  type TrackedKind,
  type TrackedTx,
} from "./tx-tracker-core";
import { TxToastContainer } from "@/components/ui/tx-toast";

export type { TrackedKind, TrackedTx };

export interface TrackerApi {
  track: (tx: Omit<TrackedTx, "state" | "submittedAt">) => void;
  list: TrackedTx[];
  dismiss: (hash: string) => void;
}

const TxTrackerContext = createContext<TrackerApi | null>(null);

export function useTxTracker(): TrackerApi {
  const ctx = useContext(TxTrackerContext);
  if (!ctx) {
    throw new Error("useTxTracker must be used within TransactionTrackerProvider");
  }
  return ctx;
}

export function TransactionTrackerProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const { address } = useWalletAddress();

  const [records, setRecords] = useState<TrackedTx[]>(() => {
    if (typeof window === "undefined" || !address) return [];
    try {
      return loadRecords(window.localStorage, NETWORK_PASSPHRASE, Date.now(), address);
    } catch {
      return [];
    }
  });

  const recordsRef = useRef<TrackedTx[]>(records);
  useEffect(() => {
    recordsRef.current = records;
  }, [records]);

  const addressRef = useRef<string | null>(address);
  useEffect(() => {
    addressRef.current = address;
    if (typeof window === "undefined") return;
    if (!address) {
      setRecords([]);
      return;
    }
    try {
      setRecords(loadRecords(window.localStorage, NETWORK_PASSPHRASE, Date.now(), address));
    } catch {
      setRecords([]);
    }
  }, [address]);

  const channelRef = useRef<BroadcastChannel | null>(null);
  const pollWakeRef = useRef<(() => void) | null>(null);

  // Invalidate queries when a transaction finalises
  const invalidateFor = useCallback(
    (record: TrackedTx) => {
      if (record.kind === "usdc-transfer") {
        queryClient.invalidateQueries({ queryKey: ["stellar", "usdcBalance", record.holder] });
      } else if (record.marketId) {
        for (const key of tradeInvalidationKeys(record.marketId, record.holder)) {
          queryClient.invalidateQueries({ queryKey: key });
        }
      }
    },
    [queryClient],
  );

  // Sync to owner-scoped localStorage (re-reading before writing so peer tabs never lose updates)
  const updateRecords = useCallback((updater: (prev: TrackedTx[]) => TrackedTx[], targetHolder?: string | null) => {
    const holder = targetHolder ?? addressRef.current;
    setRecords((prev) => {
      let base = prev;
      if (typeof window !== "undefined" && holder) {
        try {
          const fromStorage = loadRecords(window.localStorage, NETWORK_PASSPHRASE, Date.now(), holder);
          base = mergeRecords(fromStorage, prev);
        } catch {
          // ignore storage error
        }
      }
      const next = updater(base);
      if (typeof window !== "undefined" && holder) {
        try {
          saveRecords(window.localStorage, next, holder);
        } catch {
          // ignore storage error
        }
      }
      return holder === addressRef.current ? next : prev;
    });
  }, []);

  // BroadcastChannel + storage event setup for cross-tab sync and poller handoff
  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleStorage = (event: StorageEvent) => {
      const holder = addressRef.current;
      if (!holder || event.key !== storageKeyForHolder(holder)) return;
      try {
        const fresh = loadRecords(window.localStorage, NETWORK_PASSPHRASE, Date.now(), holder);
        setRecords(fresh);
      } catch {
        // ignore storage error
      }
    };
    window.addEventListener("storage", handleStorage);

    let channel: BroadcastChannel | null = null;
    if (typeof BroadcastChannel !== "undefined") {
      try {
        channel = new BroadcastChannel("oracledesk-tx");
        channelRef.current = channel;

        channel.onmessage = (event: MessageEvent) => {
          const data = event.data;
          if (!data || typeof data !== "object") return;

          if (data.type === "record_update" && isValidRecord(data.record, NETWORK_PASSPHRASE)) {
            if (data.record.holder !== addressRef.current) return;
            updateRecords((prev) => mergeRecords(prev, [data.record]), data.record.holder);
            if (data.record.state === "confirmed") {
              invalidateFor(data.record);
            }
          } else if (data.type === "record_dismiss" && data.hash) {
            if (data.holder && data.holder !== addressRef.current) return;
            updateRecords((prev) => prev.filter((r) => r.hash.toLowerCase() !== String(data.hash).toLowerCase()));
          } else if (data.type === "poller_released") {
            pollWakeRef.current?.();
          }
        };
      } catch {
        // BroadcastChannel unavailable
      }
    }

    return () => {
      window.removeEventListener("storage", handleStorage);
      channel?.close();
      channelRef.current = null;
    };
  }, [updateRecords, invalidateFor]);

  // Single-poller coordination loop for pending records (one poller per hash across tabs)
  useEffect(() => {
    let active = true;
    const activePollers = new Map<string, AbortController>();

    const abortAllPollers = () => {
      for (const [hash, controller] of activePollers.entries()) {
        controller.abort();
        activePollers.delete(hash);
        channelRef.current?.postMessage({ type: "poller_released", hash });
      }
    };

    const startPollerFor = (record: TrackedTx) => {
      const hash = record.hash.toLowerCase();
      if (!active || activePollers.has(hash)) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;

      const controller = new AbortController();
      activePollers.set(hash, controller);

      void withTxPollClaim(hash, controller.signal, async () => {
        const server = rpcServer();
        while (active && !controller.signal.aborted) {
          if (typeof document !== "undefined" && document.visibilityState === "hidden") {
            break;
          }
          const current = recordsRef.current.find((r) => r.hash.toLowerCase() === hash);
          if (!current || current.state !== "pending") break;

          try {
            const res = await server.getTransaction(current.hash);
            const updated = evaluateTxStatus(current, res);
            if (updated.state !== current.state || updated.ledger !== current.ledger) {
              updateRecords((prev) => mergeRecords(prev, [updated]), updated.holder);
              if (updated.state === "confirmed") {
                invalidateFor(updated);
              }
              channelRef.current?.postMessage({ type: "record_update", record: updated });
              if (updated.state !== "pending") break;
            }
          } catch {
            // RPC hiccup, retry on next interval
          }

          await new Promise<void>((resolve) => {
            if (controller.signal.aborted) {
              resolve();
              return;
            }
            const timer = setTimeout(resolve, TX_POLL_INTERVAL_MS);
            controller.signal.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                resolve();
              },
              { once: true },
            );
          });
        }
      }).finally(() => {
        if (activePollers.get(hash) === controller) {
          activePollers.delete(hash);
        }
        const stillPending = recordsRef.current.some(
          (r) => r.hash.toLowerCase() === hash && r.state === "pending",
        );
        if (stillPending) {
          channelRef.current?.postMessage({ type: "poller_released", hash });
        }
      });
    };

    const syncPollers = () => {
      if (!active) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        abortAllPollers();
        return;
      }
      const pending = recordsRef.current.filter((r) => r.state === "pending");
      const pendingHashes = new Set(pending.map((r) => r.hash.toLowerCase()));
      for (const [hash, controller] of activePollers.entries()) {
        if (!pendingHashes.has(hash)) {
          controller.abort();
          activePollers.delete(hash);
        }
      }
      for (const record of pending) {
        startPollerFor(record);
      }
    };

    pollWakeRef.current = syncPollers;

    const handleVisibilityChange = () => {
      syncPollers();
    };

    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleVisibilityChange);
    }

    // Periodic fallback check in case a poller tab crashed without broadcasting release
    const watchdog = setInterval(syncPollers, TX_POLL_INTERVAL_MS);
    syncPollers();

    return () => {
      active = false;
      pollWakeRef.current = null;
      clearInterval(watchdog);
      abortAllPollers();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", handleVisibilityChange);
      }
    };
  }, [records, updateRecords, invalidateFor]);

  const track = useCallback(
    (tx: Omit<TrackedTx, "state" | "submittedAt">) => {
      const newRecord: TrackedTx = {
        ...tx,
        hash: tx.hash.toLowerCase(),
        state: "pending",
        submittedAt: Date.now(),
      };
      updateRecords((prev) => mergeRecords(prev, [newRecord]), newRecord.holder);
      channelRef.current?.postMessage({ type: "record_update", record: newRecord });
    },
    [updateRecords],
  );

  const dismiss = useCallback(
    (hash: string) => {
      const lower = hash.toLowerCase();
      updateRecords((prev) => prev.filter((r) => r.hash.toLowerCase() !== lower));
      channelRef.current?.postMessage({ type: "record_dismiss", hash: lower, holder: addressRef.current });
    },
    [updateRecords],
  );

  const value: TrackerApi = {
    track,
    list: records,
    dismiss,
  };

  return (
    <TxTrackerContext.Provider value={value}>
      {children}
      <TxToastContainer />
    </TxTrackerContext.Provider>
  );
}
