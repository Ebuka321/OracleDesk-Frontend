import { Address, FeeBumpTransaction, Operation, TransactionBuilder, nativeToScVal, scValToNative, type Transaction, type xdr } from "@stellar/stellar-sdk";
import type { rpc } from "@stellar/stellar-sdk";
import type { PaymentRequirements } from "@x402/core/types";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import { STELLAR_NETWORK_TO_PASSPHRASE, getAddressCredentials } from "@x402/stellar";
import { fetchContractEvents } from "@/lib/stellar/events";

/**
 * Durable record of every signed x402 payment, so an interrupted unlock is
 * redelivered instead of paid twice.
 *
 * A Stellar `exact` payment is a signed Soroban authorization for one SEP-41
 * transfer. Its nonce makes it single-use and its signature-expiration ledger
 * bounds when it can settle, so the rules are:
 *   - while it can still settle, only ever resend the same signed header;
 *   - after its expiration ledger, check the chain: settled → never pay
 *     again; not settled → a new payment is safe.
 */

export type X402Network = "stellar:testnet" | "stellar:pubnet";

export type JournalState = "signed" | "sent" | "delivered" | "failed-retryable" | "expired" | "settled-undelivered";

/** States whose signed payload may still settle or be redelivered. */
export const REDELIVERABLE_STATES: readonly JournalState[] = ["signed", "sent", "failed-retryable"];

export interface JournalEntry {
  id: string;
  wallet: string;
  network: X402Network;
  x402Origin: string;
  onChainTraceId: string;
  requirement: PaymentRequirements;
  /** Atomic token units, decimal string. */
  amountRaw: string;
  /** The exact signed header value sent. A bearer credential until it settles or expires: never log it. */
  paymentHeader: string;
  nonce?: string;
  expirationLedger?: number;
  state: JournalState;
  attempts: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
  settlementTxHash?: string;
  /** On-chain trace hash the delivered content was checked against. Content itself is never stored. */
  contentHash?: string;
}

export class JournalUnavailableError extends Error {
  constructor() {
    super("Browser storage is unavailable (private mode or blocked site data). OracleDesk won't sign an x402 payment it can't record.");
    this.name = "JournalUnavailableError";
  }
}

export class TraceLockUnavailableError extends Error {
  constructor(
    message = "Cross-tab payment lock is unavailable (no Web Locks and no IndexedDB claim store). OracleDesk won't sign an x402 payment unprotected.",
  ) {
    super(message);
    this.name = "TraceLockUnavailableError";
  }
}

export interface PaymentJournal {
  /** Resolves once the write is durably committed. */
  put(entry: JournalEntry): Promise<void>;
  get(id: string): Promise<JournalEntry | undefined>;
  /** Newest entry for this wallet, network and trace that isn't `expired`. */
  findOpen(wallet: string, network: X402Network, onChainTraceId: string): Promise<JournalEntry | undefined>;
  list(wallet: string, network: X402Network): Promise<JournalEntry[]>;
  update(id: string, patch: Partial<Omit<JournalEntry, "id" | "wallet" | "network" | "onChainTraceId">>): Promise<JournalEntry>;
  /**
   * Atomically claims an exclusive lock key inside IndexedDB (single readwrite
   * transaction). Returns a release callback when acquired, or `null` when
   * another tab holds a non-expired claim.
   */
  acquireClaim?(key: string, ttlMs?: number): Promise<(() => Promise<void>) | null>;
}

// ─── IndexedDB journal ──────────────────────────────────────────────────────

const DB_NAME = "oracledesk-x402";
const DB_VERSION = 2;
const STORE = "payments";
const CLAIMS_STORE = "claims";
const BY_TRACE = "byTrace";
const BY_WALLET = "byWallet";
/** Money records: ask the browser to flush to disk before reporting the write complete. */
const STRICT: IDBTransactionOptions = { durability: "strict" };

export const TRACE_CLAIM_TTL_MS = 30_000;
export const TRACE_CLAIM_POLL_MS = 50;
export const TRACE_CLAIM_MAX_WAIT_MS = 35_000;

interface TraceClaimRecord {
  key: string;
  owner: string;
  expiresAt: number;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(DB_NAME, DB_VERSION);
    } catch {
      reject(new JournalUnavailableError());
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex(BY_TRACE, ["wallet", "network", "onChainTraceId"]);
        store.createIndex(BY_WALLET, ["wallet", "network"]);
      }
      if (!db.objectStoreNames.contains(CLAIMS_STORE)) {
        db.createObjectStore(CLAIMS_STORE, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new JournalUnavailableError());
    request.onblocked = () => reject(new JournalUnavailableError());
  });
}

let claimCounter = 0;
function makeClaimOwner(): string {
  return `${Date.now().toString(36)}-${++claimCounter}-${Math.random().toString(36).slice(2)}`;
}

async function acquireIdbClaim(
  getDb: () => Promise<IDBDatabase>,
  key: string,
  ttlMs: number,
): Promise<(() => Promise<void>) | null> {
  const db = await getDb();
  const owner = makeClaimOwner();
  const now = Date.now();
  const record: TraceClaimRecord = { key, owner, expiresAt: now + ttlMs };

  let acquired = false;
  try {
    const tx = db.transaction(CLAIMS_STORE, "readwrite", STRICT);
    const store = tx.objectStore(CLAIMS_STORE);
    const existing = await requestResult(store.get(key) as IDBRequest<TraceClaimRecord | undefined>);
    if (existing && existing.expiresAt > now) {
      await transactionDone(tx);
      return null;
    }
    if (existing) {
      // Crashed tab's claim has expired — safely replace it inside this readwrite tx.
      store.put(record);
    } else {
      // Atomic insert: fails with ConstraintError if another tx inserted concurrently.
      store.add(record);
    }
    await transactionDone(tx);
    acquired = true;
  } catch (error) {
    const name = (error as { name?: string } | null)?.name;
    if (name === "ConstraintError" || name === "AbortError") {
      return null;
    }
    throw error;
  }

  if (!acquired) return null;

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      const tx = db.transaction(CLAIMS_STORE, "readwrite", STRICT);
      const store = tx.objectStore(CLAIMS_STORE);
      const current = await requestResult(store.get(key) as IDBRequest<TraceClaimRecord | undefined>);
      if (current?.owner === owner) {
        store.delete(key);
      }
      await transactionDone(tx);
    } catch {
      // Best-effort release; TTL guarantees safety if the DB closed.
    }
    try {
      broadcastChannel()?.postMessage({ type: "claim-released", key });
    } catch {
      // ignore
    }
  };
}

/**
 * IndexedDB-backed journal. Throws JournalUnavailableError when IndexedDB is
 * missing; every method rejects with it when the database cannot be opened.
 * findOpen and list are O(k) in the entries for that trace or wallet (index reads).
 */
export function createJournal(factory: IDBFactory | undefined = globalThis.indexedDB): PaymentJournal {
  if (!factory) throw new JournalUnavailableError();
  let db: Promise<IDBDatabase> | null = null;
  const database = () => {
    db ??= openDatabase(factory).catch((error) => {
      db = null;
      throw error;
    });
    return db;
  };

  const write = async (entry: JournalEntry) => {
    const tx = (await database()).transaction(STORE, "readwrite", STRICT);
    tx.objectStore(STORE).put(entry);
    await transactionDone(tx);
    announceJournalChange(entry);
  };

  return {
    put: write,
    async get(id) {
      const tx = (await database()).transaction(STORE, "readonly");
      return requestResult(tx.objectStore(STORE).get(id) as IDBRequest<JournalEntry | undefined>);
    },
    async findOpen(wallet, network, onChainTraceId) {
      const tx = (await database()).transaction(STORE, "readonly");
      const entries = await requestResult(
        tx.objectStore(STORE).index(BY_TRACE).getAll([wallet, network, onChainTraceId]) as IDBRequest<JournalEntry[]>,
      );
      return entries.filter((entry) => entry.state !== "expired").sort((a, b) => b.createdAt - a.createdAt)[0];
    },
    async list(wallet, network) {
      const tx = (await database()).transaction(STORE, "readonly");
      const entries = await requestResult(tx.objectStore(STORE).index(BY_WALLET).getAll([wallet, network]) as IDBRequest<JournalEntry[]>);
      return entries.sort((a, b) => b.createdAt - a.createdAt);
    },
    async update(id, patch) {
      const tx = (await database()).transaction(STORE, "readwrite", STRICT);
      const store = tx.objectStore(STORE);
      const current = await requestResult(store.get(id) as IDBRequest<JournalEntry | undefined>);
      if (!current) {
        tx.abort();
        throw new Error(`x402 journal entry ${id} not found`);
      }
      const next: JournalEntry = { ...current, ...patch, updatedAt: Date.now() };
      store.put(next);
      await transactionDone(tx);
      announceJournalChange(next);
      return next;
    },
    acquireClaim(key, ttlMs = TRACE_CLAIM_TTL_MS) {
      return acquireIdbClaim(database, key, ttlMs);
    },
  };
}

let sharedJournal: PaymentJournal | null = null;

/** The browser's journal, or null when IndexedDB is unavailable (callers must refuse to sign). */
export function browserJournal(): PaymentJournal | null {
  if (sharedJournal) return sharedJournal;
  try {
    sharedJournal = createJournal();
    return sharedJournal;
  } catch {
    return null;
  }
}

// ─── Cross-tab coordination ─────────────────────────────────────────────────

const CHANNEL = "oracledesk-x402";
let channel: BroadcastChannel | null = null;

function broadcastChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === "undefined") return null;
  channel ??= new BroadcastChannel(CHANNEL);
  // Node keeps a referenced channel alive; browsers have no unref.
  (channel as BroadcastChannel & { unref?: () => void }).unref?.();
  return channel;
}

export interface JournalChange {
  wallet: string;
  network: X402Network;
  onChainTraceId: string;
  state: JournalState;
}

const localListeners = new Set<(change: JournalChange) => void>();

function announceJournalChange(entry: JournalEntry) {
  const change: JournalChange = { wallet: entry.wallet, network: entry.network, onChainTraceId: entry.onChainTraceId, state: entry.state };
  for (const listener of localListeners) listener(change);
  broadcastChannel()?.postMessage(change);
}

/** Calls `listener` for journal writes in this tab and in other tabs. */
export function subscribeJournalChanges(listener: (change: JournalChange) => void): () => void {
  localListeners.add(listener);
  const incoming = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CHANNEL);
  if (incoming) incoming.onmessage = (event: MessageEvent<JournalChange>) => listener(event.data);
  return () => {
    localListeners.delete(listener);
    incoming?.close();
  };
}

export interface TraceLockOptions {
  /** Journal whose IndexedDB `claims` store is used when Web Locks is absent. */
  journal?: PaymentJournal | null;
  /** Claim TTL for the IndexedDB fallback (crashed-tab expiry). Defaults to `TRACE_CLAIM_TTL_MS`. */
  ttlMs?: number;
  /** Maximum time to wait for a contended IndexedDB claim before failing closed. */
  maxWaitMs?: number;
}

/**
 * Runs `fn` while holding an exclusive cross-tab lock for one wallet's trace,
 * so two tabs never sign or redeliver for the same trace at once.
 *
 * Strategy (fail-closed):
 *  1. Prefer `navigator.locks` when available (atomic, instant release on tab crash).
 *  2. Otherwise acquire an atomic claim record in the IndexedDB `claims` store
 *     (`add` inside a single `readwrite` transaction; expired claims from crashed
 *     tabs are safely replaced after `ttlMs`).
 *  3. If neither Web Locks nor IndexedDB is available, refuse to sign by throwing
 *     `TraceLockUnavailableError` rather than running unprotected.
 */
export async function withTraceLock<T>(
  wallet: string,
  network: X402Network,
  onChainTraceId: string,
  fn: () => Promise<T>,
  opts: TraceLockOptions = {},
): Promise<T> {
  const lockKey = `${CHANNEL}:${network}:${wallet}:${onChainTraceId}`;
  const locks = (globalThis.navigator as Navigator | undefined)?.locks;
  if (locks) {
    return locks.request(lockKey, fn) as Promise<T>;
  }

  let acquire: ((key: string, ttlMs?: number) => Promise<(() => Promise<void>) | null>) | null =
    opts.journal?.acquireClaim ?? null;

  if (!acquire && typeof globalThis.indexedDB !== "undefined") {
    const factory = globalThis.indexedDB;
    let dbPromise: Promise<IDBDatabase> | null = null;
    const getDb = () => {
      dbPromise ??= openDatabase(factory).catch((err) => {
        dbPromise = null;
        throw err;
      });
      return dbPromise;
    };
    acquire = (key, ttl) => acquireIdbClaim(getDb, key, ttl ?? TRACE_CLAIM_TTL_MS);
  }

  if (!acquire) {
    throw new TraceLockUnavailableError();
  }

  const ttlMs = opts.ttlMs ?? TRACE_CLAIM_TTL_MS;
  const maxWaitMs = opts.maxWaitMs ?? TRACE_CLAIM_MAX_WAIT_MS;
  const deadline = Date.now() + maxWaitMs;

  let release: (() => Promise<void>) | null = null;
  while (true) {
    release = await acquire(lockKey, ttlMs);
    if (release) break;
    if (Date.now() >= deadline) {
      throw new TraceLockUnavailableError("Another tab holds the payment lock for this trace and did not release it in time.");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, TRACE_CLAIM_POLL_MS));
  }

  try {
    return await fn();
  } finally {
    await release();
  }
}

// ─── Payment header inspection ──────────────────────────────────────────────

export interface AuthSignature {
  address: string;
  nonce: string;
  expirationLedger: number;
}

function innerTransaction(tx: Transaction | FeeBumpTransaction): Transaction {
  return tx instanceof FeeBumpTransaction ? tx.innerTransaction : tx;
}

/** Address-credential auth entries of a transaction's InvokeHostFunction operations. */
export function authSignatures(tx: Transaction | FeeBumpTransaction): AuthSignature[] {
  const signatures: AuthSignature[] = [];
  for (const op of innerTransaction(tx).operations) {
    if (op.type !== "invokeHostFunction") continue;
    for (const entry of (op as Operation.InvokeHostFunction).auth ?? []) {
      const credentials = getAddressCredentials(entry.credentials());
      if (!credentials) continue;
      signatures.push({
        address: Address.fromScAddress(credentials.address()).toString(),
        nonce: credentials.nonce().toString(),
        expirationLedger: credentials.signatureExpirationLedger(),
      });
    }
  }
  return signatures;
}

/**
 * Reads the payer's nonce and signature-expiration ledger from a signed
 * `PAYMENT-SIGNATURE` header (base64 JSON PaymentPayload whose
 * `payload.transaction` is the signed transaction XDR).
 */
export function inspectPaymentHeader(header: string, payer: string): { nonce?: string; expirationLedger?: number } {
  try {
    const payload = decodePaymentSignatureHeader(header);
    const transaction = payload.payload.transaction;
    const passphrase = STELLAR_NETWORK_TO_PASSPHRASE.get(payload.accepted.network);
    if (typeof transaction !== "string" || !passphrase) return {};
    const own = authSignatures(TransactionBuilder.fromXDR(transaction, passphrase)).find((sig) => sig.address === payer);
    return own ? { nonce: own.nonce, expirationLedger: own.expirationLedger } : {};
  } catch {
    return {};
  }
}

// ─── Settlement check ───────────────────────────────────────────────────────

export type SettlementCheck =
  | { status: "settled"; txHash: string }
  /** `final`: the expiration ledger has passed, so the payload can never settle now. */
  | { status: "not-settled"; final: boolean }
  | { status: "unknown"; reason: string };

export interface TransferQuery {
  asset: string;
  from: string;
  to: string;
  startLedger: number;
  /** Exclusive. */
  endLedger: number;
}

/** What the settlement check needs from the chain. */
export interface SettlementChain {
  latestLedger(): Promise<number>;
  /** SEP-41 `transfer` events from → to on `asset`; `complete` false when retention or paging cut the window short. */
  transfers(query: TransferQuery): Promise<{ transfers: { txHash: string; amount: bigint }[]; complete: boolean }>;
  /** A transaction's status and its address auth signatures. */
  transaction(txHash: string): Promise<{ status: "SUCCESS" | "FAILED" | "NOT_FOUND"; signatures: AuthSignature[] }>;
}

/**
 * Was this journaled payment settled on-chain? A transfer event of the right
 * amount is only a candidate: it counts only when its transaction carries this
 * payment's auth entry (same payer and nonce), so several same-priced
 * payments to one payee are never confused.
 */
export async function checkSettlement(entry: JournalEntry, chain: SettlementChain): Promise<SettlementCheck> {
  const ownedBy = (signatures: AuthSignature[]) =>
    entry.nonce !== undefined && signatures.some((sig) => sig.address === entry.wallet && sig.nonce === entry.nonce);

  try {
    if (entry.settlementTxHash) {
      const tx = await chain.transaction(entry.settlementTxHash);
      if (tx.status === "SUCCESS" && (entry.nonce === undefined || ownedBy(tx.signatures))) {
        return { status: "settled", txHash: entry.settlementTxHash };
      }
    }
    if (entry.expirationLedger === undefined || entry.nonce === undefined) {
      return { status: "unknown", reason: "The payment's nonce or expiration ledger wasn't recorded." };
    }

    // The scheme sets expiration = signing ledger + ceil(maxTimeoutSeconds / ledgerSeconds),
    // so with ledgers of at least one second the payment can't predate this window.
    const startLedger = Math.max(1, entry.expirationLedger - entry.requirement.maxTimeoutSeconds - 1);
    const { transfers, complete } = await chain.transfers({
      asset: entry.requirement.asset,
      from: entry.wallet,
      to: entry.requirement.payTo,
      startLedger,
      endLedger: entry.expirationLedger + 1,
    });
    const amount = BigInt(entry.amountRaw);
    for (const transfer of transfers) {
      if (transfer.amount !== amount) continue;
      const tx = await chain.transaction(transfer.txHash);
      if (tx.status === "SUCCESS" && ownedBy(tx.signatures)) return { status: "settled", txHash: transfer.txHash };
    }
    if (!complete) return { status: "unknown", reason: "The RPC no longer has every event for the payment's ledger window." };
    return { status: "not-settled", final: (await chain.latestLedger()) > entry.expirationLedger };
  } catch (error) {
    return { status: "unknown", reason: error instanceof Error ? error.message : "Couldn't read the chain" };
  }
}

const symbolTopic = (value: string) => nativeToScVal(value, { type: "symbol" }).toXDR("base64");
const addressTopic = (address: string) => Address.fromString(address).toScVal().toXDR("base64");

/** CAP-67 SAC transfers carry `amount` in a map when the recipient is muxed. */
function transferAmount(value: xdr.ScVal): bigint | null {
  const native: unknown = scValToNative(value);
  if (typeof native === "bigint") return native;
  if (typeof native === "object" && native !== null && typeof (native as { amount?: unknown }).amount === "bigint") {
    return (native as { amount: bigint }).amount;
  }
  return null;
}

type SettlementServer = Pick<rpc.Server, "getHealth" | "getEvents" | "getTransaction" | "getLatestLedger">;

/** Settlement reads against Stellar RPC. */
export function rpcSettlementChain(server: SettlementServer, networkPassphrase: string): SettlementChain {
  return {
    latestLedger: async () => (await server.getLatestLedger()).sequence,
    async transfers({ asset, from, to, startLedger, endLedger }) {
      const head = [symbolTopic("transfer"), addressTopic(from), addressTopic(to)];
      const read = await fetchContractEvents({
        server,
        contractId: asset,
        // SAC transfers add the SEP-11 asset as a 4th topic; plain SEP-41 tokens use 3.
        topicFilters: [[...head, "*"], head],
        startLedger,
        endLedger,
      });
      const transfers = read.events.flatMap((event) => {
        const amount = transferAmount(event.value);
        return amount === null ? [] : [{ txHash: event.txHash, amount }];
      });
      return { transfers, complete: !read.partial && read.window.oldestLedger <= startLedger };
    },
    async transaction(txHash) {
      const tx = await server.getTransaction(txHash);
      if (tx.status === "NOT_FOUND") return { status: "NOT_FOUND", signatures: [] };
      const parsed = TransactionBuilder.fromXDR(tx.envelopeXdr.toXDR("base64"), networkPassphrase);
      return { status: tx.status, signatures: authSignatures(parsed) };
    },
  };
}

/** Evidence for support: everything about the payment except the bearer header. */
export function paymentEvidence(entry: JournalEntry): Omit<JournalEntry, "paymentHeader"> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { paymentHeader, ...evidence } = entry;
  return evidence;
}
