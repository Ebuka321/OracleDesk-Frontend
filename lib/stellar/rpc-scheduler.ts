import { assertRpcNetwork, rpcNetworkEpoch } from "./rpc-network-guard";
import { percentile } from "./rpc-pool";

export type RpcPriority = "submit" | "interactive" | "normal" | "background";
export type MethodClass = "simulate" | "send" | "poll" | "entries" | "events" | "meta";

export interface ScheduleOpts {
  priority?: RpcPriority;
  tag?: string;
  signal?: AbortSignal;
  epoch?: number;
}

export interface BucketState {
  rate: number;
  burst: number;
  tokens: number;
  pausedUntil: number;
  last: number;
}

export interface BucketSnapshot {
  url: string;
  methodClass: MethodClass;
  rate: number;
  burst: number;
  tokens: number;
  pausedUntil: number;
}

export interface PriorityStats {
  depth: number;
  waitP95Ms: number | null;
}

export interface SchedulerStats {
  now: number;
  buckets: BucketSnapshot[];
  priorities: Record<RpcPriority, PriorityStats>;
  shedBackground: number;
}

export interface RpcSchedulerOptions {
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
  ceilings?: Partial<Record<MethodClass, number>>;
  getEpoch?: () => number;
  onEpochMismatch?: (expectedEpoch: number) => void;
}

const PRIORITIES: readonly RpcPriority[] = ["submit", "interactive", "normal", "background"];
const DEFAULT_CEILINGS: Record<MethodClass, number> = {
  simulate: 10,
  send: 10,
  poll: 10,
  entries: 10,
  events: 6,
  meta: 6,
};
const DEFAULT_BURST: Record<MethodClass, number> = {
  simulate: 8,
  send: 8,
  poll: 8,
  entries: 8,
  events: 4,
  meta: 4,
};
const MIN_RATE = 0.2;
const DEFAULT_PAUSE_MS = 5_000;
const SUBMIT_POLL_FLOOR_MS = 2_000;
const WAIT_RING_SIZE = 50;

/** Maps a Soroban RPC method name to its scheduler method class. */
export function methodClassFor(method: string): MethodClass {
  switch (method) {
    case "simulateTransaction":
      return "simulate";
    case "sendTransaction":
      return "send";
    case "getTransaction":
    case "getTransactions":
      return "poll";
    case "getLedgerEntries":
    case "getAccount":
    case "getAccountEntries":
      return "entries";
    case "getEvents":
      return "events";
    default:
      return "meta";
  }
}

/** Pure token-bucket refill up to `burst` based on elapsed time since `b.last`. */
export function refill(b: BucketState, now: number): BucketState {
  if (now <= b.last) return b;
  const elapsedSec = (now - b.last) / 1000;
  const tokens = Math.min(b.burst, b.tokens + elapsedSec * b.rate);
  return { ...b, tokens, last: now };
}

/** Pure AIMD multiplicative decrease on HTTP 429, honouring `Retry-After` when present. */
export function onRateLimited(b: BucketState, now: number, retryAfterMs?: number): BucketState {
  const rate = Math.max(MIN_RATE, b.rate * 0.5);
  const pauseMs = retryAfterMs !== undefined && retryAfterMs > 0 ? retryAfterMs : DEFAULT_PAUSE_MS;
  const pausedUntil = Math.max(b.pausedUntil, now + pauseMs);
  return {
    ...b,
    rate,
    tokens: 0,
    pausedUntil,
    last: Math.max(b.last, now),
  };
}

/** Pure AIMD additive increase on a successful RPC call up to `ceiling`. */
export function onSuccess(b: BucketState, ceiling = 10): BucketState {
  const rate = Math.min(ceiling, Math.round((b.rate + 0.1) * 1000) / 1000);
  return { ...b, rate };
}

/** Extracts `Retry-After` in milliseconds from an SDK / Axios / Fetch error if exposed. */
export function extractRetryAfterMs(err: unknown, now = Date.now()): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const e = err as {
    headers?: unknown;
    response?: { headers?: unknown };
    cause?: { headers?: unknown; response?: { headers?: unknown } };
  };
  const headerSources = [
    e.response?.headers,
    e.headers,
    e.cause?.response?.headers,
    e.cause?.headers,
  ];
  for (const headers of headerSources) {
    if (!headers || typeof headers !== "object") continue;
    let raw: unknown;
    const h = headers as { get?: (name: string) => string | null } & Record<string, unknown>;
    if (typeof h.get === "function") {
      raw = h.get("retry-after") ?? h.get("Retry-After");
    } else {
      raw = h["retry-after"] ?? h["Retry-After"];
    }
    if (typeof raw === "number" && Number.isFinite(raw)) {
      return Math.max(0, Math.round(raw * 1000));
    }
    if (typeof raw === "string" && raw.trim()) {
      const trimmed = raw.trim();
      if (/^\d+(\.\d+)?$/.test(trimmed)) {
        return Math.max(0, Math.round(Number(trimmed) * 1000));
      }
      const parsedDate = Date.parse(trimmed);
      if (Number.isFinite(parsedDate)) {
        return Math.max(0, parsedDate - now);
      }
    }
  }
  return undefined;
}

/** Returns true when an error represents an HTTP 429 / rate-limit response. */
export function isRateLimitError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return typeof err === "string" && /\b429\b|rate.?limit/i.test(err);
  }
  const e = err as {
    status?: unknown;
    message?: unknown;
    response?: { status?: unknown };
    cause?: { status?: unknown; response?: { status?: unknown } };
  };
  if (
    e.status === 429 ||
    e.response?.status === 429 ||
    e.cause?.status === 429 ||
    e.cause?.response?.status === 429
  ) {
    return true;
  }
  return typeof e.message === "string" && /\b429\b|rate.?limit/i.test(e.message);
}

interface QueuedCall<T = unknown> {
  url: string;
  method: string;
  methodClass: MethodClass;
  priority: RpcPriority;
  tag: string;
  enqueuedAt: number;
  epoch: number | undefined;
  signal?: AbortSignal;
  abortHandler?: () => void;
  call: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

interface PriorityQueue {
  byTag: Map<string, QueuedCall[]>;
  tagOrder: string[];
  rrIndex: number;
}

function emptyPriorityQueue(): PriorityQueue {
  return { byTag: new Map(), tagOrder: [], rrIndex: 0 };
}

/**
 * Per-endpoint, per-method token-bucket RPC scheduler with strict priority
 * classes, per-tag round-robin fairness, background capacity reserve,
 * AbortSignal cancellation, and network-epoch checks.
 */
export class RpcScheduler {
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (id: unknown) => void;
  private readonly ceilings: Record<MethodClass, number>;
  private readonly getEpoch?: () => number;
  private readonly onEpochMismatch?: (expectedEpoch: number) => void;

  private buckets = new Map<string, BucketState>();
  private queues = new Map<string, Record<RpcPriority, PriorityQueue>>();
  private waitSamples: Record<RpcPriority, number[]> = {
    submit: [],
    interactive: [],
    normal: [],
    background: [],
  };
  private lastSubmitPollAt = new Map<string, number>();
  private shedBackground = 0;
  private timerId: unknown = null;
  private listeners = new Set<() => void>();
  private snapshot: SchedulerStats | null = null;

  constructor(opts: RpcSchedulerOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
    this.ceilings = { ...DEFAULT_CEILINGS, ...opts.ceilings };
    this.getEpoch = opts.getEpoch;
    this.onEpochMismatch = opts.onEpochMismatch;
  }

  private bucketKey(url: string, cls: MethodClass): string {
    return `${url}|${cls}`;
  }

  private getBucket(url: string, cls: MethodClass): BucketState {
    const key = this.bucketKey(url, cls);
    let b = this.buckets.get(key);
    if (!b) {
      const rate = this.ceilings[cls];
      const burst = DEFAULT_BURST[cls];
      b = { rate, burst, tokens: burst, pausedUntil: 0, last: this.now() };
      this.buckets.set(key, b);
    }
    return b;
  }

  private getUrlQueues(url: string): Record<RpcPriority, PriorityQueue> {
    let q = this.queues.get(url);
    if (!q) {
      q = {
        submit: emptyPriorityQueue(),
        interactive: emptyPriorityQueue(),
        normal: emptyPriorityQueue(),
        background: emptyPriorityQueue(),
      };
      this.queues.set(url, q);
    }
    return q;
  }

  /** Returns true if the endpoint's bucket for `cls` is currently paused after a 429. */
  isPaused(url: string, cls: MethodClass = "meta"): boolean {
    const b = this.buckets.get(this.bucketKey(url, cls));
    if (!b) return false;
    return this.now() < b.pausedUntil;
  }

  /** Records a 429 rate-limit against `(url, method)` and pauses its bucket. */
  recordRateLimited(url: string, method: string, retryAfterMs?: number): void {
    const cls = methodClassFor(method);
    const key = this.bucketKey(url, cls);
    const now = this.now();
    const current = refill(this.getBucket(url, cls), now);
    this.buckets.set(key, onRateLimited(current, now, retryAfterMs));
    this.notify();
    this.scheduleNextTick();
  }

  /** Records a successful call against `(url, method)`, gently increasing rate. */
  recordSuccess(url: string, method: string): void {
    const cls = methodClassFor(method);
    const key = this.bucketKey(url, cls);
    const current = this.getBucket(url, cls);
    this.buckets.set(key, onSuccess(current, this.ceilings[cls]));
    this.notify();
  }

  /** Schedules `call` for `(url, method)`. `getNetwork` bypasses the scheduler. */
  run<T>(url: string, method: string, call: () => Promise<T>, opts: ScheduleOpts = {}): Promise<T> {
    if (method === "getNetwork") {
      return call();
    }
    if (opts.signal?.aborted) {
      return Promise.reject(new DOMException("Aborted", "AbortError"));
    }

    const priority: RpcPriority = opts.priority ?? "normal";
    const tag = opts.tag ?? "default";
    const cls = methodClassFor(method);
    const epoch = opts.epoch ?? this.getEpoch?.();

    return new Promise<T>((resolve, reject) => {
      const item: QueuedCall<T> = {
        url,
        method,
        methodClass: cls,
        priority,
        tag,
        enqueuedAt: this.now(),
        epoch,
        signal: opts.signal,
        call,
        resolve,
        reject,
      };

      const pq = this.getUrlQueues(url)[priority];
      let tagQueue = pq.byTag.get(tag);
      if (!tagQueue) {
        tagQueue = [];
        pq.byTag.set(tag, tagQueue);
        pq.tagOrder.push(tag);
      }
      tagQueue.push(item as QueuedCall);

      if (opts.signal) {
        const onAbort = () => {
          this.removeQueuedItem(item as QueuedCall);
          reject(new DOMException("Aborted", "AbortError"));
        };
        item.abortHandler = onAbort;
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }

      this.notify();
      this.drain();
    });
  }

  private removeQueuedItem(item: QueuedCall): void {
    const uq = this.queues.get(item.url);
    if (!uq) return;
    const pq = uq[item.priority];
    const list = pq.byTag.get(item.tag);
    if (!list) return;
    const idx = list.indexOf(item);
    if (idx !== -1) {
      list.splice(idx, 1);
      if (list.length === 0) {
        pq.byTag.delete(item.tag);
        pq.tagOrder = pq.tagOrder.filter((t) => t !== item.tag);
        if (pq.rrIndex >= pq.tagOrder.length) pq.rrIndex = 0;
      }
      this.notify();
    }
  }

  private canAdmit(item: QueuedCall, now: number): boolean {
    const key = this.bucketKey(item.url, item.methodClass);
    const b = refill(this.getBucket(item.url, item.methodClass), now);
    this.buckets.set(key, b);

    // Submit poll floor rate: 1 per 2s even when paused
    if (item.priority === "submit" && item.methodClass === "poll") {
      const lastPoll = this.lastSubmitPollAt.get(item.url) ?? -Infinity;
      if (now >= b.pausedUntil && b.tokens >= 1) return true;
      return now - lastPoll >= SUBMIT_POLL_FLOOR_MS;
    }

    if (now < b.pausedUntil) return false;
    if (b.tokens < 1) return false;

    if (item.priority === "background") {
      const reserve = Math.ceil(b.burst * 0.25);
      return b.tokens > reserve;
    }
    return true;
  }

  private consumeToken(item: QueuedCall, now: number): void {
    const key = this.bucketKey(item.url, item.methodClass);
    const b = refill(this.getBucket(item.url, item.methodClass), now);
    if (item.priority === "submit" && item.methodClass === "poll") {
      this.lastSubmitPollAt.set(item.url, now);
    }
    this.buckets.set(key, { ...b, tokens: Math.max(0, b.tokens - 1), last: now });
  }

  private popNextAdmissible(url: string, now: number): QueuedCall | null {
    const uq = this.queues.get(url);
    if (!uq) return null;

    for (const priority of PRIORITIES) {
      const pq = uq[priority];
      const count = pq.tagOrder.length;
      if (count === 0) continue;

      for (let offset = 0; offset < count; offset++) {
        const idx = (pq.rrIndex + offset) % count;
        const tag = pq.tagOrder[idx];
        const list = pq.byTag.get(tag);
        if (!list || list.length === 0) continue;
        const head = list[0];
        if (!this.canAdmit(head, now)) continue;

        list.shift();
        if (list.length === 0) {
          pq.byTag.delete(tag);
          pq.tagOrder.splice(idx, 1);
          pq.rrIndex = pq.tagOrder.length > 0 ? idx % pq.tagOrder.length : 0;
        } else {
          pq.rrIndex = (idx + 1) % pq.tagOrder.length;
        }
        return head;
      }
    }
    return null;
  }

  private drain(): void {
    let dispatched = false;
    const now = this.now();

    for (const url of this.queues.keys()) {
      while (true) {
        const item = this.popNextAdmissible(url, now);
        if (!item) break;
        dispatched = true;

        if (item.abortHandler && item.signal) {
          item.signal.removeEventListener("abort", item.abortHandler);
        }

        if (this.getEpoch && item.epoch !== undefined && this.getEpoch() !== item.epoch) {
          try {
            if (this.onEpochMismatch) {
              this.onEpochMismatch(item.epoch);
            } else {
              assertRpcNetwork(item.epoch);
            }
            item.reject(new Error("Network changed while queued"));
          } catch (err) {
            item.reject(err);
          }
          continue;
        }

        const waitMs = Math.max(0, now - item.enqueuedAt);
        const ring = this.waitSamples[item.priority];
        ring.push(waitMs);
        if (ring.length > WAIT_RING_SIZE) ring.shift();

        this.consumeToken(item, now);
        this.execute(item);
      }
    }

    if (dispatched) this.notify();
    this.scheduleNextTick();
  }

  private execute(item: QueuedCall): void {
    item
      .call()
      .then((res) => {
        this.recordSuccess(item.url, item.method);
        item.resolve(res);
      })
      .catch((err) => {
        if (isRateLimitError(err)) {
          this.recordRateLimited(item.url, item.method, extractRetryAfterMs(err, this.now()));
        }
        item.reject(err);
      });
  }

  private scheduleNextTick(): void {
    if (this.timerId !== null) {
      this.clearTimer(this.timerId);
      this.timerId = null;
    }

    const now = this.now();
    let earliestMs = Infinity;

    for (const [url, uq] of this.queues) {
      for (const priority of PRIORITIES) {
        const pq = uq[priority];
        for (const tag of pq.tagOrder) {
          const list = pq.byTag.get(tag);
          if (!list || list.length === 0) continue;
          const head = list[0];
          const b = refill(this.getBucket(url, head.methodClass), now);

          if (head.priority === "submit" && head.methodClass === "poll") {
            const lastPoll = this.lastSubmitPollAt.get(url) ?? -Infinity;
            const floorWait = Math.max(0, lastPoll + SUBMIT_POLL_FLOOR_MS - now);
            const normalWait =
              Math.max(0, b.pausedUntil - now) +
              (b.tokens >= 1 ? 0 : Math.ceil(((1 - b.tokens) / b.rate) * 1000));
            earliestMs = Math.min(earliestMs, Math.min(floorWait, normalWait));
            continue;
          }

          const pauseWait = Math.max(0, b.pausedUntil - now);
          const needed = head.priority === "background" ? Math.ceil(b.burst * 0.25) + 1 : 1;
          const tokenWait =
            b.tokens >= needed ? 0 : Math.ceil(((needed - b.tokens) / b.rate) * 1000);
          earliestMs = Math.min(earliestMs, Math.max(pauseWait, tokenWait));
        }
      }
    }

    if (Number.isFinite(earliestMs)) {
      const delay = Math.max(1, earliestMs);
      this.timerId = this.setTimer(() => {
        this.timerId = null;
        this.drain();
      }, delay);
    }
  }

  stats = (): SchedulerStats => {
    if (this.snapshot) return this.snapshot;
    const now = this.now();
    const buckets: BucketSnapshot[] = [];
    for (const [key, b] of this.buckets) {
      const sep = key.lastIndexOf("|");
      const url = key.slice(0, sep);
      const methodClass = key.slice(sep + 1) as MethodClass;
      const refreshed = refill(b, now);
      buckets.push({
        url,
        methodClass,
        rate: refreshed.rate,
        burst: refreshed.burst,
        tokens: refreshed.tokens,
        pausedUntil: refreshed.pausedUntil,
      });
    }

    const priorities = {} as Record<RpcPriority, PriorityStats>;
    for (const p of PRIORITIES) {
      let depth = 0;
      for (const uq of this.queues.values()) {
        for (const list of uq[p].byTag.values()) {
          depth += list.length;
        }
      }
      priorities[p] = {
        depth,
        waitP95Ms: percentile(this.waitSamples[p], 95),
      };
    }

    this.snapshot = { now, buckets, priorities, shedBackground: this.shedBackground };
    return this.snapshot;
  };

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  private notify(): void {
    this.snapshot = null;
    for (const fn of this.listeners) fn();
  }
}

// ─── Module-level priority stack & singleton ────────────────────────────────

const priorityStack: ScheduleOpts[] = [];

/**
 * Synchronously pushes `opts` onto the module-level priority stack for the
 * synchronous duration of `fn()` (read when the proxied `rpcServer` method is
 * invoked before any `await`).
 */
export function withRpcPriority<T>(opts: ScheduleOpts, fn: () => T): T {
  priorityStack.push(opts);
  try {
    return fn();
  } finally {
    priorityStack.pop();
  }
}

/** Reads the current synchronous schedule options (defaults to `normal`). */
export function currentScheduleOpts(): ScheduleOpts {
  return priorityStack.length > 0 ? priorityStack[priorityStack.length - 1] : { priority: "normal" };
}

let sharedScheduler: RpcScheduler | null = null;

/** Singleton browser RPC scheduler. */
export function scheduler(): RpcScheduler {
  if (!sharedScheduler) {
    sharedScheduler = new RpcScheduler({
      getEpoch: rpcNetworkEpoch,
      onEpochMismatch: (expected) => assertRpcNetwork(expected),
    });
  }
  return sharedScheduler;
}
