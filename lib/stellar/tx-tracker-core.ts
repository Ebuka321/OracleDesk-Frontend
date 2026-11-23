import type { rpc } from "@stellar/stellar-sdk";
import { describeError, type ContractName } from "./errors";

export type TrackedKind = "buy" | "sell" | "redeem" | "usdc-transfer";

export interface TrackedTx {
  /** Lowercase 64-char hex transaction hash */
  hash: string;
  kind: TrackedKind;
  /** G-address of the account that signed */
  holder: string;
  marketId?: string;
  outcome?: "Yes" | "No";
  /** Bigint amounts represented as base-10 decimal strings */
  amounts: Record<string, string>;
  networkPassphrase: string;
  /** Epoch milliseconds at submit time */
  submittedAt: number;
  state: "pending" | "confirmed" | "failed" | "expired";
  ledger?: number;
  maxTime?: number;
  mayNotHaveBeenSent?: boolean;
  error?: { kind: string; message: string; code?: string };
  followUp?: { type: "unlock-daily-pass"; traceId: string; amountRaw: string };
}

export const STORAGE_KEY = "oracledesk_pending_txs";
export const TX_POLL_INTERVAL_MS = 3_000;
export const TX_POLL_LEASE_MS = 8_000;
export const TX_POLL_SETTLE_MS = 30;
const TX_POLL_LOCK_PREFIX = "oracledesk-tx-poll:";
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

/** Storage key scoped to a single wallet address so pending records never leak across accounts. */
export function storageKeyForHolder(holder?: string | null): string {
  return holder ? `${STORAGE_KEY}:${holder}` : STORAGE_KEY;
}

/** Computes the query keys to invalidate when a trade confirms. */
export function tradeInvalidationKeys(marketId: string, holder: string) {
  return [
    ["stellar", "market", marketId] as const,
    ["stellar", "markets"] as const,
    ["stellar", "position", marketId, holder] as const,
    ["stellar", "usdcBalance", holder] as const,
    ["stellar", "equity", holder] as const,
  ];
}

/** Converts bigint values into decimal strings for serialization. */
export function toRecord(amounts: Record<string, bigint>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(amounts)) {
    result[key] = val.toString(10);
  }
  return result;
}

/** Converts serialized decimal strings back into bigints without precision loss. */
export function fromRecord(amounts: Record<string, string>): Record<string, bigint> {
  const result: Record<string, bigint> = {};
  for (const [key, val] of Object.entries(amounts)) {
    result[key] = BigInt(val);
  }
  return result;
}

/** Validates that a parsed item matches TrackedTx shape and is within the 24h validity window. */
export function isValidRecord(item: unknown, currentNetworkPassphrase: string, now = Date.now()): item is TrackedTx {
  if (!item || typeof item !== "object") return false;
  const o = item as Partial<TrackedTx>;

  if (typeof o.hash !== "string" || !/^[a-f0-9]{64}$/i.test(o.hash)) return false;
  if (!["buy", "sell", "redeem", "usdc-transfer"].includes(o.kind as string)) return false;
  if (typeof o.holder !== "string" || o.holder.length < 50) return false;
  if (!o.amounts || typeof o.amounts !== "object") return false;
  for (const val of Object.values(o.amounts)) {
    if (typeof val !== "string" || !/^-?\d+$/.test(val)) return false;
  }
  if (o.networkPassphrase !== currentNetworkPassphrase) return false;
  if (typeof o.submittedAt !== "number" || isNaN(o.submittedAt)) return false;
  if (now - o.submittedAt > TWENTY_FOUR_HOURS_MS || o.submittedAt - now > 60_000) return false;
  if (!["pending", "confirmed", "failed", "expired"].includes(o.state as string)) return false;

  return true;
}

/** Safely reads records from storage, filtering out stale/invalid entries and enforcing holder scope when given. */
export function loadRecords(
  storage: Storage | null,
  networkPassphrase: string,
  now = Date.now(),
  holder?: string | null,
): TrackedTx[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(storageKeyForHolder(holder));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is TrackedTx =>
        isValidRecord(item, networkPassphrase, now) && (!holder || item.holder === holder),
    );
  } catch {
    return [];
  }
}

/** Safely writes records to storage. */
export function saveRecords(storage: Storage | null, records: TrackedTx[], holder?: string | null): void {
  if (!storage) return;
  try {
    const scoped = holder ? records.filter((r) => r.holder === holder) : records;
    storage.setItem(storageKeyForHolder(holder), JSON.stringify(scoped));
  } catch {
    // Storage full or unavailable
  }
}

/** Removes all persisted pending transaction records for a holder (e.g. on explicit logout/cleanup). */
export function clearRecords(storage: Storage | null, holder?: string | null): void {
  if (!storage) return;
  try {
    storage.removeItem(storageKeyForHolder(holder));
  } catch {
    // ignore storage error
  }
}

interface TxPollLease {
  token: string;
  expiresAt: number;
}

let txPollTabId: string | undefined;
let txPollSeq = 0;
function nextPollToken(): string {
  txPollTabId ??= `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${txPollTabId}:${++txPollSeq}:${Math.random().toString(36).slice(2)}`;
}

/**
 * Coordinates single-poller ownership per transaction hash across tabs.
 * Uses `navigator.locks` (`ifAvailable: true`) when available, and a hardened
 * `localStorage` lease (unique token + settle re-read) otherwise.
 *
 * Returns `{ claimed: false }` immediately when another tab is already polling
 * `hash`, so followers rely on BroadcastChannel updates instead of hitting RPC.
 */
export async function withTxPollClaim<T>(
  hash: string,
  signal: AbortSignal,
  run: () => Promise<T>,
): Promise<{ claimed: true; value: T } | { claimed: false }> {
  if (signal.aborted) return { claimed: false };
  const normalizedHash = hash.toLowerCase();
  const lockName = `${TX_POLL_LOCK_PREFIX}${normalizedHash}`;
  const locks = (globalThis.navigator as Navigator | undefined)?.locks;
  if (locks) {
    return locks.request(lockName, { mode: "exclusive", ifAvailable: true }, async (lock) => {
      if (!lock || signal.aborted) return { claimed: false as const };
      const value = await run();
      return { claimed: true as const, value };
    });
  }

  const storage =
    typeof window !== "undefined"
      ? (() => {
          try {
            return window.localStorage;
          } catch {
            return null;
          }
        })()
      : null;

  if (!storage) {
    const value = await run();
    return { claimed: true, value };
  }

  const leaseKey = `oracledesk_tx_poll_lease:${normalizedHash}`;
  const readLease = (): TxPollLease | null => {
    try {
      const raw = storage.getItem(leaseKey);
      return raw ? (JSON.parse(raw) as TxPollLease) : null;
    } catch {
      return null;
    }
  };

  const existing = readLease();
  if (existing && existing.expiresAt > Date.now()) {
    return { claimed: false };
  }

  const token = nextPollToken();
  const writeLease = () => {
    storage.setItem(leaseKey, JSON.stringify({ token, expiresAt: Date.now() + TX_POLL_LEASE_MS }));
  };
  try {
    writeLease();
  } catch {
    return { claimed: false };
  }

  await new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const t = setTimeout(resolve, TX_POLL_SETTLE_MS);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });

  const confirmed = readLease();
  if (signal.aborted || !confirmed || confirmed.token !== token || confirmed.expiresAt <= Date.now()) {
    if (confirmed?.token === token) {
      try {
        storage.removeItem(leaseKey);
      } catch {
        // ignore
      }
    }
    return { claimed: false };
  }

  const heartbeat = setInterval(() => {
    if (readLease()?.token === token) {
      try {
        writeLease();
      } catch {
        // ignore
      }
    }
  }, Math.floor(TX_POLL_LEASE_MS / 2));

  try {
    const value = await run();
    return { claimed: true, value };
  } finally {
    clearInterval(heartbeat);
    if (readLease()?.token === token) {
      try {
        storage.removeItem(leaseKey);
      } catch {
        // ignore
      }
    }
  }
}

/** Merges records from multiple writers/tabs by transaction hash. */
export function mergeRecords(existing: TrackedTx[], incoming: TrackedTx[]): TrackedTx[] {
  const map = new Map<string, TrackedTx>();

  for (const r of existing) {
    map.set(r.hash.toLowerCase(), r);
  }

  for (const r of incoming) {
    const key = r.hash.toLowerCase();
    const prev = map.get(key);
    if (!prev) {
      map.set(key, r);
    } else {
      // Final states take precedence over pending
      const isFinal = (s: TrackedTx["state"]) => s === "confirmed" || s === "failed" || s === "expired";
      const state = isFinal(r.state) ? r.state : prev.state;
      map.set(key, {
        ...prev,
        ...r,
        state,
        ledger: r.ledger ?? prev.ledger,
        error: r.error ?? prev.error,
        followUp: r.followUp ?? prev.followUp,
        mayNotHaveBeenSent: r.mayNotHaveBeenSent ?? prev.mayNotHaveBeenSent,
      });
    }
  }

  return Array.from(map.values()).sort((a, b) => b.submittedAt - a.submittedAt);
}

/** Evaluates a single transaction's updated state from an RPC getTransaction response. */
export function evaluateTxStatus(
  record: TrackedTx,
  res: rpc.Api.GetTransactionResponse,
  contract: ContractName = "marketCore",
): TrackedTx {
  if (res.status === "SUCCESS") {
    return {
      ...record,
      state: "confirmed",
      ledger: res.ledger ?? res.latestLedger,
    };
  }

  if (res.status === "FAILED") {
    const fullErr = `${res.resultXdr ? String(res.resultXdr) : ""} ${res.resultMetaXdr ? String(res.resultMetaXdr) : ""}`;
    const described = describeError(fullErr || "Transaction failed", contract);
    return {
      ...record,
      state: "failed",
      error: { kind: described.kind, message: described.message, code: described.code },
    };
  }

  if (res.status === "NOT_FOUND") {
    // If transaction had a time bound and latest ledger close time is past it
    if (record.maxTime && res.latestLedgerCloseTime && res.latestLedgerCloseTime > record.maxTime) {
      return {
        ...record,
        state: "expired",
        mayNotHaveBeenSent: true,
        error: {
          kind: "expired",
          message: "Transaction expired without landing on-chain (may not have been sent).",
        },
      };
    }
  }

  return record;
}
