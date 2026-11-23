/**
 * Quota-aware storage manager for OracleDesk.
 *
 * Stores are classified as:
 *   "evidence"    - payment journals; never evicted automatically
 *   "preference"  - small user settings; kept unless critical
 *   "disposable"  - caches; evicted LRU under storage pressure
 *
 * Issue #228
 */

export type StoreClass = "evidence" | "preference" | "disposable";

export interface ManagedStore {
  id: string;
  cls: StoreClass;
  estimateBytes(): Promise<number>;
  evict?(targetBytes: number, signal: AbortSignal): Promise<number>;
}

export interface StorageStatus {
  persisted: boolean;
  persistSupported: boolean;
  usage: number;
  quota: number;
  stores: { id: string; cls: StoreClass; bytes: number }[];
}

export interface PersistOutcome {
  granted: boolean;
  askedAt: number;
}

export interface HeadroomResult {
  freedBytes: number;
  headroom: number;
}

const PERSIST_KEY = "oracledesk_storage_persist_v1";
const EVICT_LOCK = "oracledesk-storage-evict";
const EVICT_CHANNEL = "oracledesk-storage";
const RERATE_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_HEADROOM = 5 * 1024 * 1024; // 5 MiB

const registry = new Map<string, ManagedStore>();

export function registerStore(store: ManagedStore): () => void {
  registry.set(store.id, store);
  return () => registry.delete(store.id);
}

export async function storageStatus(): Promise<StorageStatus> {
  const sm = navigator.storage;
  const persisted = sm?.persisted ? await sm.persisted() : false;
  const estimate = sm?.estimate ? await sm.estimate() : { usage: 0, quota: 0 };

  const storeEntries = await Promise.all(
    [...registry.values()].map(async (s) => ({
      id: s.id,
      cls: s.cls,
      bytes: await s.estimateBytes().catch(() => 0),
    })),
  );

  return {
    persisted,
    persistSupported: Boolean(sm?.persist),
    usage: estimate.usage ?? 0,
    quota: estimate.quota ?? 0,
    stores: storeEntries,
  };
}

function readPersistedRecord(): { askedAt: number; granted: boolean } | null {
  try {
    const raw = localStorage.getItem(PERSIST_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as { askedAt: number; granted: boolean };
  } catch {
    return null;
  }
}

export async function requestPersistence(reason: "payment" | "trade"): Promise<PersistOutcome> {
  const existing = readPersistedRecord();
  if (existing && Date.now() - existing.askedAt < RERATE_MS) {
    return existing;
  }
  if (!navigator.storage?.persist) {
    return { granted: false, askedAt: Date.now() };
  }
  const granted = await navigator.storage.persist();
  const outcome: PersistOutcome = { granted, askedAt: Date.now() };
  try {
    localStorage.setItem(PERSIST_KEY, JSON.stringify({ ...outcome, reason }));
  } catch {
    // best effort
  }
  return outcome;
}

async function evictDisposable(targetBytes: number, signal: AbortSignal): Promise<number> {
  const disposable = [...registry.values()].filter((s) => s.cls === "disposable" && s.evict);
  let freed = 0;
  for (const store of disposable) {
    if (signal.aborted || freed >= targetBytes) break;
    freed += await store.evict!(targetBytes - freed, signal).catch(() => 0);
  }
  return freed;
}

export async function ensureHeadroom(minFreeBytes = MIN_HEADROOM): Promise<HeadroomResult> {
  const estimate = await navigator.storage?.estimate?.().catch(() => null);
  const quota = estimate?.quota ?? 0;
  const usage = estimate?.usage ?? 0;
  const current = quota - usage;
  if (current >= minFreeBytes) return { freedBytes: 0, headroom: current };

  const needed = minFreeBytes - current;
  const controller = new AbortController();

  let freed = 0;
  if (navigator.locks?.request) {
    await navigator.locks.request(EVICT_LOCK, async () => {
      // Re-check under lock
      const fresh = await navigator.storage?.estimate?.().catch(() => null);
      const freshHeadroom = (fresh?.quota ?? 0) - (fresh?.usage ?? 0);
      if (freshHeadroom >= minFreeBytes) return;
      freed = await evictDisposable(needed, controller.signal);
    });
  } else {
    freed = await evictDisposable(needed, controller.signal);
  }

  try {
    new BroadcastChannel(EVICT_CHANNEL).postMessage({ type: "evicted" });
  } catch {
    // not supported everywhere
  }

  const after = await navigator.storage?.estimate?.().catch(() => null);
  return { freedBytes: freed, headroom: (after?.quota ?? 0) - (after?.usage ?? 0) };
}

export class StorageUnavailableError extends Error {
  constructor(kind: string, reason: string) {
    super(`Storage unavailable for ${kind}: ${reason}`);
    this.name = "StorageUnavailableError";
  }
}

export async function assertDurableStorage(kind: "x402" | "daily-pass" | "copy-trade"): Promise<void> {
  if (typeof indexedDB === "undefined") {
    throw new StorageUnavailableError(kind, "IndexedDB is unavailable (private mode or blocked site data). OracleDesk won't sign a payment it can't record.");
  }

  const { headroom } = await ensureHeadroom(MIN_HEADROOM);
  const { persisted } = await storageStatus();

  if (!persisted && headroom < MIN_HEADROOM) {
    throw new StorageUnavailableError(
      kind,
      "Storage is not persistent and free quota is too low to safely record this payment. Install the app as a PWA to enable persistent storage.",
    );
  }

  // Probe write
  const PROBE_KEY = `oracledesk_storage_probe_${kind}`;
  try {
    localStorage.setItem(PROBE_KEY, "1");
    localStorage.removeItem(PROBE_KEY);
  } catch (err) {
    if (err instanceof DOMException && err.name === "QuotaExceededError") {
      throw new StorageUnavailableError(kind, "Storage quota exceeded. Clear browser data or free up space to continue.");
    }
    throw new StorageUnavailableError(kind, "localStorage write failed — storage may be blocked.");
  }
}
