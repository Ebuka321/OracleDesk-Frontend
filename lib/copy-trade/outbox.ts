import { scValToNative } from "@stellar/stellar-sdk";
import { ApiError, isAuthError } from "@/lib/api/client";
import { CONTRACTS } from "@/lib/stellar/config";
import { decodeInvoke, type TxCheck } from "@/lib/stellar/tx-lifecycle";

export interface CopyBuyExpectation {
  trader: string; onChainMarketId: string; outcome: "Yes" | "No"; collateralInRaw: string;
}
export function verifyCopyBuy(check: TxCheck, expect: CopyBuyExpectation): "match" | "mismatch" | "pending" | "failed" {
  if (check.kind === "not-found") return "pending";
  if (check.kind === "failed") return "failed";
  const invoke = decodeInvoke(check.envelope);
  if (!invoke || invoke.contractId !== CONTRACTS.marketCore || invoke.fn !== "buy" || invoke.args.length !== 5) return "mismatch";
  try {
    const [trader, market, outcome, amount] = invoke.args.map((arg) => scValToNative(arg));
    return trader === expect.trader && BigInt(market) === BigInt(expect.onChainMarketId) &&
      Array.isArray(outcome) && outcome.length === 1 && outcome[0] === expect.outcome &&
      BigInt(amount) === BigInt(expect.collateralInRaw) ? "match" : "mismatch";
  } catch { return "mismatch"; }
}

export interface OutboxEntry {
  copyTradeId: string; traceId: string; marketId: string; onChainMarketId: string;
  outcome: "Yes" | "No"; collateralInRaw: string;
  state: "initiated" | "signed" | "confirming" | "confirmed" | "abandoned" | "mismatch";
  txHash: string | null; attempts: number; nextAttemptAt: number; lastError?: string; createdAt: number;
  /** Session id that paused auth. A new sign-in resumes it without a prompt loop. */
  pausedSessionId?: string | null;
  needsSession?: boolean;
  dismissed?: boolean;
}
export const RETENTION_MS = 26 * 60 * 60 * 1000;
export const MAX_OUTBOX_ENTRIES = 50;
export const retryDelay = (attempts: number) => Math.min(2 ** Math.min(attempts, 16) * 5_000, 600_000);
export const isTerminal = (entry: OutboxEntry) => ["confirmed", "abandoned", "mismatch"].includes(entry.state);

function validEntry(raw: unknown): raw is OutboxEntry {
  if (!raw || typeof raw !== "object") return false;
  const r = raw as OutboxEntry;
  return [r.copyTradeId, r.traceId, r.marketId, r.onChainMarketId].every((v) => typeof v === "string" && v.length > 0) &&
    /^\d+$/.test(r.onChainMarketId) && typeof r.collateralInRaw === "string" && /^\d+$/.test(r.collateralInRaw) &&
    (r.outcome === "Yes" || r.outcome === "No") &&
    ["initiated", "signed", "confirming", "confirmed", "abandoned", "mismatch"].includes(r.state) &&
    (r.txHash === null || (typeof r.txHash === "string" && /^[a-f\d]{64}$/i.test(r.txHash))) &&
    Number.isFinite(r.createdAt) && Number.isFinite(r.nextAttemptAt) && Number.isInteger(r.attempts) && r.attempts >= 0;
}
const EMPTY: readonly OutboxEntry[] = [];
const memory = new Map<string, readonly OutboxEntry[]>();
const listeners = new Set<() => void>();
const key = (address: string) => `oracledesk_copy_outbox:${address}`;
const changed = () => listeners.forEach((fn) => fn());
export const subscribeOutbox = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const emptyOutbox = () => EMPTY;

export const RECONCILE_LEASE_MS = 30_000;
export const RECONCILE_LEASE_SETTLE_MS = 30;
const RECONCILE_LOCK_PREFIX = "oracledesk-copy-reconcile:";

let reconcileTabId: string | undefined;
let reconcileSeq = 0;
function nextReconcileToken(): string {
  reconcileTabId ??= `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${reconcileTabId}:${++reconcileSeq}:${Math.random().toString(36).slice(2)}`;
}

/** Reads directly from localStorage, bypassing the in-memory read cache. Returns null if storage is unavailable. */
export function readOutboxFromStorage(address: string): OutboxEntry[] | null {
  if (!address || typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key(address));
    const parsed: unknown = JSON.parse(raw ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(validEntry)
      .slice(-MAX_OUTBOX_ENTRIES)
      .map((entry) => ({ ...entry, txHash: entry.txHash?.toLowerCase() ?? null }));
  } catch {
    return null;
  }
}

/** Returns a stable snapshot for useSyncExternalStore; storage is always optional. */
export function readOutbox(address: string | null): readonly OutboxEntry[] {
  if (!address || typeof window === "undefined") return EMPTY;
  const cached = memory.get(address); if (cached) return cached;
  const entries = readOutboxFromStorage(address) ?? [];
  memory.set(address, entries);
  return entries;
}
export function writeOutbox(address: string, entries: readonly OutboxEntry[]): boolean {
  const next = [...entries];
  while (next.length > MAX_OUTBOX_ENTRIES) {
    const oldest = next.findIndex((entry) => isTerminal(entry) || entry.dismissed);
    if (oldest < 0) return false;
    next.splice(oldest, 1);
  }
  memory.set(address, next);
  let persisted = true;
  try { window.localStorage.setItem(key(address), JSON.stringify(next)); } catch { persisted = false; }
  changed();
  return persisted;
}

/**
 * Performs a fresh read-modify-write against localStorage so concurrent tabs
 * updating different entries never clobber each other with a stale memory cache.
 * Falls back to the in-memory snapshot only when localStorage is unavailable.
 */
export function mutateOutbox(address: string, mutator: (current: OutboxEntry[]) => OutboxEntry[]): boolean {
  const fresh = readOutboxFromStorage(address);
  const base = fresh ?? [...(memory.get(address) ?? [])];
  return writeOutbox(address, mutator(base));
}

export function appendOutboxEntry(address: string, entry: OutboxEntry): boolean {
  return mutateOutbox(address, (entries) => {
    if (entries.some((e) => e.copyTradeId === entry.copyTradeId)) return entries;
    return [...entries, { ...entry, txHash: entry.txHash?.toLowerCase() ?? null }];
  });
}

export function updateOutbox(address: string, id: string, patch: Partial<OutboxEntry>) {
  return mutateOutbox(address, (entries) => entries.map((entry) => {
    if (entry.copyTradeId !== id) return entry;
    if (isTerminal(entry) && patch.state && patch.state !== entry.state) return entry;
    // A backend confirm overwrites the hash. Once chosen, never substitute a
    // different hash for this intent, even on a manual retry.
    if (entry.txHash && patch.txHash && entry.txHash.toLowerCase() !== patch.txHash.toLowerCase()) return entry;
    return { ...entry, ...patch, txHash: (patch.txHash ?? entry.txHash)?.toLowerCase() ?? null };
  }));
}
/** Refresh local snapshots when another tab writes; same-hash confirms are idempotent. */
export function refreshOutbox(address: string) { memory.delete(address); changed(); }

interface ReconcileLease {
  token: string;
  expiresAt: number;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Acquires a non-blocking cross-tab claim for reconciling one copy-trade entry.
 * Uses Web Locks (`ifAvailable: true`) when present, and a hardened localStorage
 * lease (unique token + settle re-read) otherwise. Returns `{ ran: false }` when
 * another tab already holds the claim.
 */
export async function withCopyTradeReconcileClaim<T>(
  address: string,
  copyTradeId: string,
  fn: () => Promise<T>,
): Promise<{ ran: true; value: T } | { ran: false }> {
  const lockName = `${RECONCILE_LOCK_PREFIX}${address}:${copyTradeId}`;
  const locks = (globalThis.navigator as Navigator | undefined)?.locks;
  if (locks) {
    return locks.request(lockName, { mode: "exclusive", ifAvailable: true }, async (lock) => {
      if (!lock) return { ran: false as const };
      const value = await fn();
      return { ran: true as const, value };
    });
  }

  // Fallback: hardened localStorage lease with unique token + settle verification.
  const storage = typeof window !== "undefined" ? (() => { try { return window.localStorage; } catch { return null; } })() : null;
  if (!storage) {
    const value = await fn();
    return { ran: true, value };
  }

  const leaseKey = `oracledesk_copy_reconcile_lease:${address}:${copyTradeId}`;
  const readLease = (): ReconcileLease | null => {
    try {
      const raw = storage.getItem(leaseKey);
      return raw ? (JSON.parse(raw) as ReconcileLease) : null;
    } catch {
      return null;
    }
  };

  const existing = readLease();
  if (existing && existing.expiresAt > Date.now()) {
    return { ran: false };
  }

  const token = nextReconcileToken();
  const lease: ReconcileLease = { token, expiresAt: Date.now() + RECONCILE_LEASE_MS };
  try {
    storage.setItem(leaseKey, JSON.stringify(lease));
  } catch {
    return { ran: false };
  }

  await sleepMs(RECONCILE_LEASE_SETTLE_MS);
  const confirmed = readLease();
  if (!confirmed || confirmed.token !== token || confirmed.expiresAt <= Date.now()) {
    return { ran: false };
  }

  try {
    const value = await fn();
    return { ran: true, value };
  } finally {
    if (readLease()?.token === token) {
      try { storage.removeItem(leaseKey); } catch { /* ignore */ }
    }
  }
}

/**
 * Reconciles a single outbox entry under the cross-tab claim, re-reading fresh
 * state from localStorage inside the claim so a tab never duplicates a confirm
 * completed by a peer.
 */
export async function reconcileOutboxEntryCrossTab(
  address: string,
  copyTradeId: string,
  deps: ReconcileDeps,
  opts?: { forceImmediate?: boolean },
): Promise<{ claimed: boolean; entry?: OutboxEntry }> {
  const result = await withCopyTradeReconcileClaim(address, copyTradeId, async () => {
    const freshList = readOutboxFromStorage(address) ?? [...readOutbox(address)];
    const current = freshList.find((e) => e.copyTradeId === copyTradeId);
    if (!current || isTerminal(current) || current.dismissed) return current;

    const resume = current.needsSession && deps.sessionId && current.pausedSessionId !== deps.sessionId;
    const candidate = resume || opts?.forceImmediate ? { ...current, nextAttemptAt: 0 } : current;
    if (candidate.txHash && !candidate.needsSession && candidate.nextAttemptAt <= deps.now()) {
      updateOutbox(address, copyTradeId, { state: "confirming" });
    }
    const next = await reconcileEntry(candidate, address, deps);
    if (next !== candidate) {
      const latest = (readOutboxFromStorage(address) ?? [...readOutbox(address)]).find((e) => e.copyTradeId === copyTradeId);
      if (latest && !latest.dismissed && latest.txHash === current.txHash) {
        updateOutbox(address, copyTradeId, next);
      }
    }
    return next;
  });

  return result.ran ? { claimed: true, entry: result.value } : { claimed: false };
}

export interface ReconcileDeps {
  now: () => number;
  sessionId: string | null;
  check: (hash: string) => Promise<TxCheck>;
  confirm: (id: string, hash: string) => Promise<unknown>;
  assertCurrent: () => void;
}

/** One deterministic step. The provider owns scheduling and persistence. */
export async function reconcileEntry(entry: OutboxEntry, trader: string, deps: ReconcileDeps): Promise<OutboxEntry> {
  if (isTerminal(entry) || entry.dismissed) return entry;
  const now = deps.now();
  if (now - entry.createdAt >= RETENTION_MS) return { ...entry, state: "abandoned", lastError: "This trade can't be verified any more: the RPC retention window has passed." };
  if (entry.state === "initiated" || !entry.txHash || entry.nextAttemptAt > now) return entry;
  if (entry.needsSession && (!deps.sessionId || entry.pausedSessionId === deps.sessionId)) return entry;
  const next: OutboxEntry = { ...entry, needsSession: false, state: "confirming", attempts: entry.attempts + 1, nextAttemptAt: now + retryDelay(entry.attempts) };
  try {
    deps.assertCurrent();
    const checked = await deps.check(entry.txHash);
    deps.assertCurrent();
    const verdict = verifyCopyBuy(checked, { trader, ...entry });
    if (verdict === "pending") return { ...next, state: "signed", lastError: "Waiting for the transaction to appear on-chain." };
    if (verdict === "failed") return { ...next, state: "abandoned", lastError: `Transaction failed on-chain: ${checked.kind === "failed" ? checked.resultCode : "failed"}.` };
    if (verdict === "mismatch") return { ...next, state: "mismatch", lastError: "The transaction does not match this copy buy. It was not recorded." };
    if (!deps.sessionId) return { ...next, state: "signed", needsSession: true, pausedSessionId: null, lastError: "Sign in to finish recording this copy trade." };
    await deps.confirm(entry.copyTradeId, entry.txHash);
    deps.assertCurrent();
    return { ...next, state: "confirmed", lastError: undefined };
  } catch (error) {
    if (isAuthError(error)) return { ...next, state: "signed", needsSession: true, pausedSessionId: deps.sessionId, lastError: "Sign in to finish recording this copy trade." };
    if (error instanceof ApiError && error.code === "COPY_TRADE_NOT_FOUND") return { ...next, state: "abandoned", lastError: "The copy-trade record no longer exists for this wallet." };
    if ((error as { code?: string })?.code === "SCOPE_CHANGED") return entry;
    return { ...next, state: "signed", lastError: error instanceof Error ? error.message : "Recording failed; retrying automatically." };
  }
}
